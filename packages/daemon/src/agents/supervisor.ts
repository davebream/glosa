// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { managedEnvironment } from "./environment.ts";
import { ManagedAgentError, type OwnedProcess, type ProcessLauncher } from "./interface.ts";
import { confirmedExit, prepareOwnership, unresolvedOwnership, writeOwnership } from "./ownership.ts";

type SpawnOptions = Parameters<ProcessLauncher["spawn"]>[0];
type Exit = Awaited<OwnedProcess["exited"]>;
export class RuntimeSupervisor implements ProcessLauncher {
  private readonly children = new Set<OwnedProcess>();
  private readonly unresolved: Set<string>;
  private closed = false;
  constructor(
    private readonly root: string,
    private readonly maxProcesses = 6,
  ) {
    this.unresolved = unresolvedOwnership(root);
  }
  get activeCount(): number {
    return this.children.size + this.unresolved.size;
  }
  get recoveryRequired(): boolean {
    return this.unresolved.size > 0;
  }
  recover(): void {
    for (const nonce of this.unresolved) if (confirmedExit(this.root, nonce)) this.unresolved.delete(nonce);
  }
  async spawn(options: SpawnOptions): Promise<OwnedProcess> {
    if (this.closed) throw new ManagedAgentError("runtime-closed", "Managed execution has stopped.");
    this.recover();
    if (this.recoveryRequired)
      throw new ManagedAgentError(
        "ownership-unknown",
        "A previous run needs recovery before execution can restart.",
        503,
      );
    if (this.activeCount >= this.maxProcesses)
      throw new ManagedAgentError("runtime-capacity", "All managed runtime slots are in use.");
    const nonce = randomUUID();
    const dir = prepareOwnership(this.root, nonce);
    let guardian: ReturnType<typeof spawnGuardian>;
    const spawnGuardian = () =>
      Bun.spawn([process.execPath, fileURLToPath(new URL("./guardian.ts", import.meta.url))], {
        cwd: dir,
        env: managedEnvironment(process.env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    try {
      guardian = spawnGuardian();
    } catch (error) {
      // Bun.spawn threw synchronously: no guardian exists and no native launch was sent.
      writeOwnership(join(dir, "exit.json"), {
        schema: 1,
        nonce,
        code: null,
        signal: null,
        groupEmpty: true,
        at: new Date().toISOString(),
      });
      throw error;
    }
    let resolveExit!: (value: Exit) => void;
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const exited = new Promise<Exit>((resolve) => {
      resolveExit = resolve;
    });
    const started = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const pending = new Map<
      string,
      { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    let pid: number | undefined;
    let fenced = false;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let writing = Promise.resolve();
    const finish = (value: Exit) => {
      if (settled) return;
      settled = true;
      fenced = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("runtime exited"));
      }
      pending.clear();
      // Unknown ownership consumes its reservation until explicit recovery, not another spawn.
      this.children.delete(owned);
      if (!value.groupEmpty) this.unresolved.add(nonce);
      resolveExit(value);
    };
    const send = (frame: object): void => {
      guardian.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const request = (op: string, fields: object = {}): Promise<void> =>
      new Promise((resolve, reject) => {
        if (settled) {
          reject(new Error("runtime exited"));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("guardian request timed out"));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ op, id, ...fields });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    const owned: OwnedProcess = {
      get pid() {
        return pid;
      },
      exited,
      write: (data, admit) => {
        const job = writing.then(async () => {
          const bytes = Buffer.from(data);
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            try {
              admit?.();
            } catch (error) {
              // A partial JSON frame cannot be followed safely by an interrupt frame.
              // Close the native input lane; the owner escalates directly to group stop.
              if (offset > 0) fenced = true;
              throw error;
            }
            if (fenced) throw new ManagedAgentError("runtime-fenced", "This run no longer accepts input.");
            await request("write", { data: bytes.subarray(offset, offset + 64 * 1024).toString("base64") });
          }
        });
        writing = job.catch(() => {});
        return job;
      },
      fence: async () => {
        fenced = true;
        if (!settled) await request("fence");
      },
      stop: async () => {
        fenced = true;
        if (!settled) {
          // Closing the private control pipe is also a cancellation signal, even if the daemon dies.
          try {
            send({ op: "stop", id: randomUUID() });
          } catch {
            /* EOF still reaches the guardian */
          }
          guardian.stdin.end();
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          exited,
          new Promise<Exit>((resolve) => {
            deadline = setTimeout(() => resolve({ code: null, signal: null, groupEmpty: false }), 4000);
          }),
        ]);
        if (deadline) clearTimeout(deadline);
        if (!result.groupEmpty)
          throw new ManagedAgentError(
            "ownership-unknown",
            "The agent's exit could not be confirmed. Recovery is required.",
            503,
          );
      },
      resize: (cols, rows) => {
        if (!settled) send({ op: "resize", cols, rows });
      },
    };
    this.children.add(owned);
    const decode = async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const bytes of guardian.stdout) {
        buffer += decoder.decode(bytes, { stream: true });
        if (buffer.length > 3 * 1024 * 1024) throw new Error("guardian output too large");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (frame.op === "started" && frame.nonce === nonce && frame.pid === frame.pgid) {
            pid = frame.pid;
            resolveStart();
          } else if (frame.op === "data") options.onData(frame.channel, Buffer.from(frame.data, "base64"));
          else if (frame.op === "exit" && frame.nonce === nonce && frame.pid === pid)
            finish({ code: frame.code, signal: frame.signal, groupEmpty: frame.groupEmpty === true });
          else if (frame.op === "fatal") throw new Error("guardian failed");
          else if (frame.id && pending.has(frame.id)) {
            const item = pending.get(frame.id)!;
            pending.delete(frame.id);
            clearTimeout(item.timer);
            if (frame.op === "ack") item.resolve();
            else item.reject(new Error("guardian refused input"));
          }
        }
      }
    };
    void decode().catch(() => {
      rejectStart(new Error("Agent process could not be supervised."));
      guardian.stdin.end();
    });
    // Never publish raw guardian/native stderr. Drain it so the child cannot block.
    void (async () => {
      for await (const _bytes of guardian.stderr) {
        /* deliberately discarded */
      }
    })();
    void guardian.exited.then(() => {
      rejectStart(new Error("Agent process did not start."));
      const receipt = confirmedExit(this.root, nonce);
      finish(receipt ?? { code: null, signal: null, groupEmpty: false });
    });
    heartbeat = setInterval(() => {
      if (!settled) {
        try {
          send({ op: "heartbeat" });
        } catch {
          guardian.stdin.end();
        }
      }
    }, 5000);
    const startTimeout = setTimeout(() => {
      rejectStart(new Error("Agent startup timed out."));
      guardian.stdin.end();
    }, 30_000);
    send({
      op: "start",
      id: randomUUID(),
      nonce,
      receiptDir: dir,
      ...options,
      onData: undefined,
      terminal: options.terminal ?? false,
    });
    try {
      await started;
      return owned;
    } catch (error) {
      try {
        await owned.stop();
      } catch {
        /* slot remains reserved when ownership is uncertain */
      }
      throw error;
    } finally {
      clearTimeout(startTimeout);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.children].map((child) => child.stop()));
  }
}
