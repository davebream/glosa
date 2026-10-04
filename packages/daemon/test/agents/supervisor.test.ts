// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedAgentError } from "../../src/agents/interface.ts";
import { RuntimeSupervisor } from "../../src/agents/supervisor.ts";
import { activateInstallGuard, captureInstallSnapshot, InstallGuard } from "../../src/lifecycle/install-guard.ts";
import { prepareOwnership } from "../../src/agents/ownership.ts";

test("guardian stays alive until its pending exit receipt is written after control EOF", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-guardian-finalization-")));
  const release = join(dir, "release-finalizer");
  const nonce = randomUUID();
  const receiptDir = prepareOwnership(dir, nonce);
  const source = readFileSync(new URL("../../src/agents/guardian.ts", import.meta.url), "utf8");
  const anchor = "finalizing = child.exited.then(async (code) => {";
  expect(source.split(anchor)).toHaveLength(2);
  // Execute the real guardian with imports rebased to their actual modules. This one injected
  // barrier simulates an asynchronous output/receipt drain whose own handles are unreferenced.
  // It contacts no provider and changes no ownership predicate or receipt-writing code.
  const injected = `${anchor}
    child?.terminal?.unref();
    await new Promise<void>((resolve) => {
      const waiting = setInterval(() => {
        if (require("node:fs").existsSync(${JSON.stringify(release)})) {
          clearInterval(waiting);
          resolve();
        }
      }, 10);
      waiting.unref();
      emit({op:"finalizer-ready"});
    });`;
  const program = source
    .replace('"zod"', JSON.stringify(require.resolve("zod")))
    .replace('"../bus/io.ts"', JSON.stringify(fileURLToPath(new URL("../../src/bus/io.ts", import.meta.url))))
    .replace(
      'new URL("./execution-host.ts", import.meta.url)',
      `new URL(${JSON.stringify(new URL("../../src/agents/execution-host.ts", import.meta.url).href)})`,
    )
    .replace(anchor, injected);
  const executable = join(dir, "guardian.ts");
  writeFileSync(executable, program);
  const guardian = Bun.spawn([process.execPath, executable], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let ready!: () => void;
  const pending = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const draining = (async () => {
    let output = "";
    for await (const bytes of guardian.stdout) {
      output += Buffer.from(bytes).toString();
      if (output.includes('"op":"finalizer-ready"')) ready();
    }
  })();
  const stderr = new Response(guardian.stderr).text();
  try {
    guardian.stdin.write(
      `${JSON.stringify({
        op: "start",
        id: randomUUID(),
        nonce,
        receiptDir,
        command: "/usr/bin/true",
        args: [],
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", HOME: dir },
        terminal: true,
      })}\n`,
    );
    guardian.stdin.end();
    const reached = await Promise.race([pending.then(() => true), guardian.exited.then(() => false)]);
    if (!reached) throw new Error(`guardian did not reach finalization: ${await stderr}`);
    expect(reached).toBe(true);
    // One real lifetime witness: outlast stop()'s two one-second group waits while deliberately
    // withholding the finalizer's release. An unreferenced barrier cannot keep this process alive.
    expect(await Promise.race([guardian.exited.then(() => "early-exit"), Bun.sleep(2200).then(() => "pending")])).toBe(
      "pending",
    );
    writeFileSync(release, "complete");
    expect(await guardian.exited).toBe(0);
    const receipt = JSON.parse(readFileSync(join(receiptDir, "exit.json"), "utf8"));
    expect(receipt.nonce).toBe(nonce);
    expect(receipt.groupEmpty).toBe(true);
  } finally {
    writeFileSync(release, "complete");
    if (guardian.exitCode === null) guardian.kill("SIGKILL");
    await guardian.exited;
    await draining;
    await stderr;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("an acknowledged guardian fence rejects subsequent native input and stop confirms ownership", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-")));
  const supervisor = new RuntimeSupervisor(dir);
  let output = "";
  let echo!: () => void;
  const received = new Promise<void>((resolve) => {
    echo = resolve;
  });
  try {
    const child = await supervisor.spawn({
      command: "/bin/sh",
      args: ["-c", 'while read line; do printf "seen:%s\\n" "$line"; done'],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      onData(_channel, bytes) {
        output += new TextDecoder().decode(bytes);
        if (output.includes("seen:first")) echo();
      },
    });
    await child.write("first\n");
    await received;
    await child.fence();
    await expect(child.write("second\n")).rejects.toThrow("no longer accepts input");
    await child.stop();
    expect((await child.exited).groupEmpty).toBe(true);
    expect(output).not.toContain("seen:second");
    expect(supervisor.activeCount).toBe(0);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("a changed install starts no managed run: refused with install-changed, no guardian, no ownership (#432)", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-install-")));
  const tree = join(dir, "install");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "guardian.ts"), "// boot bytes\n");
  const runtimeRoot = join(dir, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const guard = new InstallGuard({
    snapshot: captureInstallSnapshot({ root: tree, files: [join(tree, "guardian.ts")], execPath: process.execPath }),
    canRetire: () => false,
    retire: () => {},
    log: () => {},
  });
  activateInstallGuard(guard);
  const supervisor = new RuntimeSupervisor(runtimeRoot, 1);
  const options = { command: "/bin/sleep", args: ["30"], cwd: dir, env: { PATH: "/usr/bin:/bin" }, onData() {} };
  try {
    rmSync(join(tree, "guardian.ts"));
    const refused = await supervisor.spawn(options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ManagedAgentError);
    expect((refused as ManagedAgentError).code).toBe("install-changed");
    expect((refused as ManagedAgentError).status).toBe(503);
    expect(readdirSync(runtimeRoot)).toEqual([]);
  } finally {
    activateInstallGuard(null);
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("runtime capacity counts reservations before another asynchronous launch can start", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-capacity-")));
  const supervisor = new RuntimeSupervisor(dir, 1);
  const options = { command: "/bin/sleep", args: ["30"], cwd: dir, env: { PATH: "/usr/bin:/bin" }, onData() {} };
  try {
    const starting = supervisor.spawn(options);
    await expect(supervisor.spawn(options)).rejects.toThrow("slots are in use");
    const child = await starting;
    await child.stop();
    expect((await child.exited).groupEmpty).toBe(true);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("stopping a Bun process with a live descendant produces a durable empty-group receipt", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-tree-")));
  const supervisor = new RuntimeSupervisor(dir);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const child = await supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        "Bun.spawn(['/bin/sleep','30'], {stdin:'ignore',stdout:'inherit',stderr:'inherit'}); console.log('ready'); setInterval(()=>{},1000)",
      ],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      onData(_channel, bytes) {
        if (new TextDecoder().decode(bytes).includes("ready")) ready();
      },
    });
    await started;
    await child.stop();
    expect((await child.exited).groupEmpty).toBe(true);
    expect(supervisor.recoveryRequired).toBe(false);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("termination gives native descendants their grace period after the execution host exits", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-grace-")));
  const supervisor = new RuntimeSupervisor(dir);
  let output = "",
    ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const child = await supervisor.spawn({
      command: "/bin/sh",
      args: ["-c", "trap 'echo TERM; sleep 0.3; echo CLEAN; exit 0' TERM; echo READY; while :; do sleep 0.1; done"],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      onData(_channel, bytes) {
        output += new TextDecoder().decode(bytes);
        if (output.includes("READY")) ready();
      },
    });
    await started;
    await child.stop();
    expect((await child.exited).groupEmpty).toBe(true);
    expect(output).toContain("CLEAN");
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("large native frames are chunked without interleaving or poisoning the process owner", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-large-")));
  const supervisor = new RuntimeSupervisor(dir);
  let output = "";
  try {
    const child = await supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        "let all=''; for await(const b of Bun.stdin.stream()){all+=new TextDecoder().decode(b); if(all.endsWith('END')){ console.log(all.length); break; }}",
      ],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      onData(_channel, bytes) {
        output += new TextDecoder().decode(bytes);
      },
    });
    await Promise.all([child.write("x".repeat(1_600_000)), child.write("END")]);
    expect((await child.exited).groupEmpty).toBe(true);
    expect(output.trim()).toBe("1600003");
    expect(supervisor.recoveryRequired).toBe(false);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("a host spawn failure records no-child ownership so a later launch can proceed", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-prelaunch-")));
  const supervisor = new RuntimeSupervisor(dir);
  try {
    const options = {
      command: "/usr/bin/true",
      args: [],
      cwd: join(dir, "absent"),
      env: { PATH: "/usr/bin:/bin" },
      onData() {},
    };
    await expect(supervisor.spawn(options)).rejects.toThrow();
    supervisor.recover();
    const child = await supervisor.spawn({ ...options, cwd: dir });
    expect((await child.exited).groupEmpty).toBe(true);
    expect(supervisor.recoveryRequired).toBe(false);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("revocation between chunks closes partial native input before a cancellation frame can be appended", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "glosa-supervisor-revoke-")));
  const supervisor = new RuntimeSupervisor(dir);
  try {
    const child = await supervisor.spawn({
      command: "/bin/cat",
      args: [],
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      onData() {},
    });
    let admissions = 0;
    await expect(
      child.write("x".repeat(160_000), () => {
        if (++admissions === 2) throw new Error("access revoked");
      }),
    ).rejects.toThrow("access revoked");
    expect(admissions).toBe(2);
    await expect(child.write("interrupt\n")).rejects.toThrow("no longer accepts input");
    await child.stop();
    expect((await child.exited).groupEmpty).toBe(true);
  } finally {
    await supervisor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("only confirmed exit or two valid different boot identities release persisted uncertainty", async () => {
  const { bootIdentity, unresolvedOwnership } = await import("../../src/agents/ownership.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-boot-ownership-")));
  const nonce = crypto.randomUUID();
  const dir = join(root, "runs", nonce);
  const current = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  mkdirSync(dir, { recursive: true });
  try {
    expect(bootIdentity()).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    for (const saved of [undefined, "corrupt", "-".repeat(36), current, current.toUpperCase()]) {
      writeFileSync(
        join(dir, "prepared.json"),
        JSON.stringify({ schema: 1, nonce, at: new Date().toISOString(), bootId: saved }),
      );
      expect(unresolvedOwnership(root, current).has(nonce), String(saved)).toBe(true);
    }
    writeFileSync(
      join(dir, "prepared.json"),
      JSON.stringify({ schema: 1, nonce, at: new Date().toISOString(), bootId: crypto.randomUUID() }),
    );
    expect(unresolvedOwnership(root, current).has(nonce)).toBe(false);
    for (const unknown of ["", "invalid"]) expect(unresolvedOwnership(root, unknown).has(nonce)).toBe(true);
    writeFileSync(join(dir, "prepared.json"), "corrupt");
    expect(unresolvedOwnership(root, current).has(nonce)).toBe(true);
    writeFileSync(
      join(dir, "exit.json"),
      JSON.stringify({ schema: 1, nonce, code: 0, signal: null, groupEmpty: true, at: new Date().toISOString() }),
    );
    expect(unresolvedOwnership(root, "").has(nonce)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
