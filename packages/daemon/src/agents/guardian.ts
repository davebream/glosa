// SPDX-License-Identifier: Apache-2.0
// Short-lived process owner. No network listener, provider credentials or daemon discovery.
import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";

const startSchema = z
  .object({
    op: z.literal("start"),
    id: z.string(),
    nonce: z.uuid(),
    receiptDir: z.string(),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    terminal: z.boolean(),
  })
  .strict();
const commandSchema = z.discriminatedUnion("op", [
  startSchema,
  z.object({ op: z.literal("write"), id: z.string(), data: z.string().max(2 * 1024 * 1024) }).strict(),
  z.object({ op: z.literal("fence"), id: z.string() }).strict(),
  z.object({ op: z.literal("stop"), id: z.string() }).strict(),
  z.object({ op: z.literal("heartbeat") }).strict(),
  z
    .object({
      op: z.literal("resize"),
      cols: z.number().int().min(10).max(500),
      rows: z.number().int().min(3).max(200),
    })
    .strict(),
]);
type Child = ReturnType<typeof Bun.spawn>;
let child: Child | undefined;
let specification: z.infer<typeof startSchema> | undefined;
let fenced = false;
let stopping: Promise<void> | undefined;
let group: number | undefined;
let lastHeartbeat = Date.now();
let outputBytes = 0;
const emit = (frame: unknown) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

function groupAlive(): boolean {
  if (!group) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function signalGroup(signal: NodeJS.Signals): void {
  if (!group) return;
  try {
    process.kill(-group, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
async function waitForGroup(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (groupAlive() && Date.now() < deadline) await wait(20);
}
async function stop(): Promise<void> {
  if (stopping) return stopping;
  fenced = true;
  stopping = (async () => {
    if (!child) return;
    signalGroup("SIGTERM");
    await waitForGroup(1000);
    if (groupAlive()) signalGroup("SIGKILL");
    await waitForGroup(1000);
  })();
  return stopping;
}
async function pump(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  channel: "stdout" | "stderr",
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  for await (const bytes of stream) {
    outputBytes += bytes.byteLength;
    if (outputBytes > 8 * 1024 * 1024) {
      await stop();
      throw new Error("native output exceeded buffer");
    }
    for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
      emit({ op: "data", channel, data: Buffer.from(bytes.subarray(offset, offset + 24 * 1024)).toString("base64") });
    }
    // stdout's stream backpressure bounds queued control frames independently of native input.
    if (process.stdout.writableNeedDrain) await new Promise<void>((done) => process.stdout.once("drain", done));
    outputBytes -= bytes.byteLength;
  }
}
function receipt(code: number | null, signal: string | null): void {
  if (!specification) return;
  const value = {
    schema: 1,
    nonce: specification.nonce,
    pid: child?.pid,
    pgid: group,
    code,
    signal,
    groupEmpty: !groupAlive(),
    at: new Date().toISOString(),
  };
  const temp = join(specification.receiptDir, "exit.pending");
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify(value)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(specification.receiptDir, "exit.json"));
  fsyncContainingDir(temp);
  emit({ op: "exit", ...value });
}
async function start(spec: z.infer<typeof startSchema>): Promise<void> {
  if (child || fenced) throw new Error("guardian already used");
  specification = spec;
  // Native auth runs in an original executable, not an interpolated login-shell command.
  const options = { cwd: spec.cwd, env: spec.env, detached: true, ipc() {}, serialization: "json" as const };
  const host = [process.execPath, fileURLToPath(new URL("./execution-host.ts", import.meta.url))];
  child = spec.terminal
    ? Bun.spawn(host, {
        ...options,
        terminal: {
          cols: 100,
          rows: 24,
          data(_term, bytes) {
            if (process.stdout.writableLength + bytes.byteLength > 8 * 1024 * 1024) {
              void stop();
              return;
            }
            for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
              emit({
                op: "data",
                channel: "terminal",
                data: Buffer.from(bytes.subarray(offset, offset + 24 * 1024)).toString("base64"),
              });
            }
          },
        },
      })
    : Bun.spawn(host, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Verify the actual process group before ever signalling it (including the PTY case).
  const probe = Bun.spawn(["/bin/ps", "-o", "pgid=", "-p", String(child.pid)], {
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const observed = Number((await new Response(probe.stdout).text()).trim());
  await probe.exited;
  if (observed !== child.pid) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("native process group ownership could not be established");
  }
  group = child.pid;
  const pumps = [pump(child.stdout, "stdout"), pump(child.stderr, "stderr")];
  for (const pumping of pumps) void pumping.catch(() => stop());
  emit({ op: "started", id: spec.id, pid: child.pid, pgid: group, nonce: spec.nonce });
  child.send({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env });
  void child.exited.then(async (code) => {
    fenced = true;
    // A normally exiting agent must not leave ordinary children in its owned group either.
    if (groupAlive()) await stop();
    await Promise.allSettled(pumps);
    receipt(code, child?.signalCode ?? null);
    child?.terminal?.close();
    process.exit(0);
  });
}
async function handle(raw: unknown): Promise<void> {
  const command = commandSchema.parse(raw);
  if (command.op === "heartbeat") {
    lastHeartbeat = Date.now();
    return;
  }
  if (command.op === "start") {
    await start(command);
    return;
  }
  if (command.op === "resize") {
    child?.terminal?.resize(command.cols, command.rows);
    return;
  }
  if (command.op === "fence") {
    fenced = true;
    emit({ op: "ack", id: command.id });
    return;
  }
  if (command.op === "stop") {
    await stop();
    emit({ op: "ack", id: command.id });
    return;
  }
  if (fenced || !child) {
    emit({ op: "error", id: command.id, code: "runtime-fenced" });
    return;
  }
  const bytes = Buffer.from(command.data, "base64");
  // The synchronous handoff is the admission boundary. Already handed-off bytes are in flight.
  if (child.terminal) child.terminal.write(bytes);
  else if (child.stdin && typeof child.stdin !== "number") child.stdin.write(bytes);
  else throw new Error("native input unavailable");
  emit({ op: "ack", id: command.id });
}

const watchdog = setInterval(() => {
  if (Date.now() - lastHeartbeat > 20_000) void stop();
}, 1000);
let pending = "";
const inputDecoder = new TextDecoder();
try {
  for await (const bytes of Bun.stdin.stream()) {
    pending += inputDecoder.decode(bytes, { stream: true });
    if (pending.length > 3 * 1024 * 1024) throw new Error("guardian frame too large");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      await handle(JSON.parse(line));
    }
  }
} catch {
  emit({ op: "fatal", code: "guardian-failed" });
} finally {
  clearInterval(watchdog);
  await stop();
  if (!child) {
    // A failed host spawn cannot leave native children: launch happens only after `started`.
    if (specification) receipt(null, null);
    process.exit(0);
  }
}
