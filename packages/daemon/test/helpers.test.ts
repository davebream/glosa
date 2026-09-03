// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupHome, lockOf, randomPort } from "./helpers.ts";

const childHelperPath = join(import.meta.dir, "helpers.ts");
const childScript = `
  import { existsSync, writeFileSync } from "node:fs";
  import { randomPort } from ${JSON.stringify(childHelperPath)};
  writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, String(randomPort()));
  while (!existsSync(process.env.GLOSA_TEST_PORT_RELEASE)) await Bun.sleep(10);
`;

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.length = 0;
});

async function waitUntil(predicate: () => boolean, deadlineMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

async function finishChildren(children: Bun.Subprocess[], deadlineMs = 10_000): Promise<void> {
  const allExited = Promise.all(children.map((child) => child.exited));
  const finished = await Promise.race([allExited.then(() => true), Bun.sleep(deadlineMs).then(() => false)]);
  if (!finished) {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  await allExited;
}

test("randomPort reserves non-overlapping blocks across isolated test processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-helper-"));
  cleanupDirs.push(root);
  const releasePath = join(root, "release");
  const outputs = Array.from({ length: 8 }, (_, index) => join(root, `port-${index}`));
  const children: Bun.Subprocess[] = [];

  try {
    // Start sequentially and give every process a different TMPDIR. The old directory reservations
    // were only shared by processes whose tmpdir() happened to match, so concurrent Conductor
    // workspaces could each claim port 20000. A machine-global reservation must remain disjoint here.
    for (const [index, outputPath] of outputs.entries()) {
      const privateTmp = join(root, `tmp-${index}`);
      mkdirSync(privateTmp);
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", childScript],
        env: {
          ...Bun.env,
          TMPDIR: privateTmp,
          GLOSA_TEST_PORT_OUTPUT: outputPath,
          GLOSA_TEST_PORT_RELEASE: releasePath,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      children.push(child);
      expect(await waitUntil(() => existsSync(outputPath))).toBe(true);
    }

    const ports = outputs.map((output) => Number(readFileSync(output, "utf8")));
    const reservedPorts = ports.flatMap((port) => Array.from({ length: 4 }, (_, offset) => port + offset));
    expect(new Set(reservedPorts).size).toBe(reservedPorts.length);
  } finally {
    writeFileSync(releasePath, "release");
    await finishChildren(children);
  }
});

test("distinct-TMPDIR processes can run ensureDaemon concurrently without crossing homes", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-daemons-"));
  cleanupDirs.push(root);
  const startPath = join(root, "start");
  const releasePath = join(root, "release");
  const workerScript = `
    import { existsSync, writeFileSync } from "node:fs";
    import { cleanupHome, freshHome, lockOf, randomPort, waitUntil } from ${JSON.stringify(childHelperPath)};
    import { ensureTestDaemon as ensureDaemon } from ${JSON.stringify(childHelperPath)};
    const home = freshHome();
    const port = randomPort();
    process.env.GLOSA_HOME = home;
    process.env.GLOSA_PORT = String(port);
    writeFileSync(process.env.GLOSA_TEST_PORT_ALLOCATED, JSON.stringify({ home, port }));
    while (!existsSync(process.env.GLOSA_TEST_PORT_START)) await Bun.sleep(10);
    const result = await ensureDaemon();
    writeFileSync(process.env.GLOSA_TEST_PORT_RESULT, JSON.stringify(result));
    while (!existsSync(process.env.GLOSA_TEST_PORT_RELEASE)) await Bun.sleep(10);
    if (result.ok) {
      try { process.kill(result.pid, "SIGTERM"); } catch {}
      await waitUntil(() => lockOf(home) === null, 5000);
    }
    cleanupHome(home);
  `;
  const outputs = Array.from({ length: 4 }, (_, index) => ({
    allocated: join(root, `allocated-${index}`),
    result: join(root, `result-${index}`),
  }));
  const children: Bun.Subprocess[] = [];

  try {
    // Sequential allocation makes the old TMPDIR-scoped implementation deterministically choose
    // the same base port four times. Starting ensureDaemon together then reproduces the reported
    // cross-suite failure: one home wins the bind and the other homes see a foreign handshake.
    for (const [index, output] of outputs.entries()) {
      const privateTmp = join(root, `daemon-tmp-${index}`);
      mkdirSync(privateTmp);
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", workerScript],
        env: {
          ...Bun.env,
          TMPDIR: privateTmp,
          GLOSA_TEST_PORT_ALLOCATED: output.allocated,
          GLOSA_TEST_PORT_RESULT: output.result,
          GLOSA_TEST_PORT_START: startPath,
          GLOSA_TEST_PORT_RELEASE: releasePath,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      children.push(child);
      expect(await waitUntil(() => existsSync(output.allocated))).toBe(true);
    }

    const allocations = outputs.map((output) => JSON.parse(readFileSync(output.allocated, "utf8")));
    writeFileSync(startPath, "start");
    expect(await waitUntil(() => outputs.every(({ result }) => existsSync(result)), 20_000)).toBe(true);
    const results = outputs.map((output) => JSON.parse(readFileSync(output.result, "utf8")));

    expect(new Set(allocations.map(({ port }) => port)).size).toBe(allocations.length);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(new Set(results.map(({ pid }) => pid)).size).toBe(results.length);
  } finally {
    writeFileSync(releasePath, "release");
    await finishChildren(children, 20_000);

    // If a worker itself had to be SIGKILLed, its detached daemon is not its child anymore. Reap
    // from the independently written home/lock evidence so a failed stress test cannot poison the
    // next run it was meant to protect.
    for (const { allocated } of outputs) {
      if (!existsSync(allocated)) continue;
      const { home } = JSON.parse(readFileSync(allocated, "utf8"));
      const lock = lockOf(home);
      if (lock) {
        try {
          process.kill(lock.pid, "SIGTERM");
        } catch {
          // already stopped
        }
        await waitUntil(() => lockOf(home) === null, 5_000);
      }
      cleanupHome(home);
    }
  }
}, 30_000);

test("a daemon spawned by a test helper exits when its test runner is terminated", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-daemon-runner-exit-"));
  cleanupDirs.push(root);
  const outputPath = join(root, "daemon.json");
  const runnerScript = `
    import { writeFileSync } from "node:fs";
    import { ensureTestDaemon, freshHome, randomPort } from ${JSON.stringify(childHelperPath)};
    const home = freshHome();
    const port = randomPort();
    process.env.GLOSA_HOME = home;
    process.env.GLOSA_PORT = String(port);
    const daemon = await ensureTestDaemon();
    if (!daemon.ok) throw new Error(daemon.reason);
    writeFileSync(process.env.GLOSA_TEST_DAEMON_OUTPUT, JSON.stringify({
      home,
      pid: daemon.pid,
      port: daemon.port,
      instanceId: daemon.instanceId,
    }));
    setInterval(() => {}, 1000);
  `;
  const runner = Bun.spawn({
    cmd: [process.execPath, "-e", runnerScript],
    env: { ...Bun.env, GLOSA_TEST_DAEMON_OUTPUT: outputPath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let daemon: { home: string; pid: number; port: number; instanceId: string } | null = null;
  const daemonIsAlive = () => {
    if (!daemon) return false;
    try {
      process.kill(daemon.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    expect(await waitUntil(() => existsSync(outputPath), 20_000)).toBe(true);
    daemon = JSON.parse(readFileSync(outputPath, "utf8"));
    runner.kill("SIGKILL");
    expect(await runner.exited).toBe(137);
    expect(await waitUntil(() => !daemonIsAlive(), 10_000)).toBe(true);
  } finally {
    if (runner.exitCode === null) runner.kill("SIGKILL");
    await runner.exited;
    if (daemonIsAlive()) {
      const lock = lockOf(daemon!.home);
      let handshake: { pid?: unknown; instance_id?: unknown } | null = null;
      try {
        const response = await fetch(`http://127.0.0.1:${daemon!.port}/api/handshake`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) handshake = await response.json();
      } catch {
        // Ownership is not independently provable; do not signal a stale PID.
      }
      if (
        lock?.pid === daemon!.pid &&
        lock.instance_id === daemon!.instanceId &&
        handshake?.pid === daemon!.pid &&
        handshake.instance_id === daemon!.instanceId
      ) {
        process.kill(daemon!.pid, "SIGKILL");
        await waitUntil(() => !daemonIsAlive(), 5_000);
      }
    }
    if (daemon) cleanupHome(daemon.home);
  }
}, 30_000);

test("randomPort keeps locally allocated main and Class-F blocks disjoint", () => {
  const first = randomPort();
  const second = randomPort();
  const firstBlock = Array.from({ length: 4 }, (_, offset) => first + offset);
  const secondBlock = Array.from({ length: 4 }, (_, offset) => second + offset);
  expect(secondBlock.some((port) => firstBlock.includes(port))).toBe(false);

  // The sentinel is out-of-band: the entire returned block must be bindable immediately. This
  // also pins the synchronous probe teardown; Bun.serve.stop() would leave a release race here.
  const listeners = firstBlock.map((port) =>
    Bun.listen({
      hostname: "127.0.0.1",
      port,
      exclusive: true,
      socket: { data: () => {} },
    }),
  );
  for (const listener of listeners) listener.stop(true);
});

const PORT_MIN = 20_000;
const PORT_BLOCK_SIZE = 4;

function exactBlockEnv(port: number): Record<string, string> {
  return {
    GLOSA_TEST_PORT_BLOCK_OFFSET: String((port - PORT_MIN) / PORT_BLOCK_SIZE),
    GLOSA_TEST_PORT_BLOCKS: "1",
  };
}

// --- ownership and reclamation ---------------------------------------------------------------

/** A child that reserves one block, survives a forced GC, reports it, and then stays alive until
 * killed. `setInterval` is what keeps the loop alive — the unref'd reservation must not do that. */
const squatterScript = `
  import { writeFileSync } from "node:fs";
  import { randomPort } from ${JSON.stringify(childHelperPath)};
  const port = randomPort();
  Bun.gc(true);
  await Bun.sleep(25);
  writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, String(port));
  setInterval(() => {}, 1000);
`;

async function startSquatter(
  outputPath: string,
  env: Record<string, string> = {},
): Promise<{ child: Bun.Subprocess; port: number } | null> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", squatterScript],
    env: { ...Bun.env, GLOSA_TEST_PORT_OUTPUT: outputPath, ...env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const settled = await waitUntil(() => existsSync(outputPath) || child.exitCode !== null);
  if (!settled) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("timed out waiting for port-reservation owner");
  }
  if (!existsSync(outputPath)) {
    await child.exited;
    return null;
  }
  return { child, port: Number(readFileSync(outputPath, "utf8")) };
}

test("a live owner holds its sentinel strongly through GC", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-live-"));
  cleanupDirs.push(root);
  const ownerOutput = join(root, "owner");
  const contenderOutput = join(root, "contender");
  const owner = await startSquatter(ownerOutput);
  if (!owner) throw new Error("could not reserve a block for the live-owner test");

  try {
    const contenderScript = `
      import { writeFileSync } from "node:fs";
      import { randomPort } from ${JSON.stringify(childHelperPath)};
      let outcome = "acquired";
      try { randomPort(); } catch (error) { outcome = error.message; }
      writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, outcome);
    `;
    const contender = Bun.spawn({
      cmd: [process.execPath, "-e", contenderScript],
      env: {
        ...Bun.env,
        ...exactBlockEnv(owner.port),
        GLOSA_TEST_PORT_OUTPUT: contenderOutput,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await contender.exited).toBe(0);
    expect(readFileSync(contenderOutput, "utf8")).toContain("no free glosa test port block");
  } finally {
    owner.child.kill("SIGKILL");
    await owner.child.exited;
  }
});

test("a SIGKILLed owner is reclaimed exactly, leaves no disk state, and does not keep a process alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-reclaim-"));
  cleanupDirs.push(root);
  const successorScript = `
    import { writeFileSync } from "node:fs";
    import { randomPort } from ${JSON.stringify(childHelperPath)};
    let result;
    try { result = { ok: true, port: randomPort() }; }
    catch (error) { result = { ok: false, message: error.message }; }
    writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, JSON.stringify(result));
  `;

  // Ordinary lifecycle suites scan from the start of the range. Use a bounded tail window and
  // retry adjacent blocks: after SIGKILL another legitimate helper may win the released sentinel
  // before our successor does. That is proof of working exclusion, not a leak or a test failure.
  let reclaimed = false;
  for (let attempt = 0; attempt < 32 && !reclaimed; attempt += 1) {
    const offset = 6_000 + ((process.pid + attempt) % 1_000);
    const port = PORT_MIN + offset * PORT_BLOCK_SIZE;
    const privateTmp = join(root, `tmp-${attempt}`);
    const ownerOutput = join(root, `owner-${attempt}`);
    const successorOutput = join(root, `successor-${attempt}`);
    mkdirSync(privateTmp);

    const owner = await startSquatter(ownerOutput, {
      TMPDIR: privateTmp,
      ...exactBlockEnv(port),
    });
    if (!owner) continue;
    expect(owner.port).toBe(port);
    owner.child.kill("SIGKILL"); // no exit handler can release or clean anything
    await owner.child.exited;

    // The old implementation leaves its directory here deterministically, before any successor
    // race. Kernel socket ownership leaves no state for a later run to sweep.
    expect(readdirSync(privateTmp)).toEqual([]);

    const successor = Bun.spawn({
      cmd: [process.execPath, "-e", successorScript],
      env: {
        ...Bun.env,
        TMPDIR: privateTmp,
        ...exactBlockEnv(port),
        GLOSA_TEST_PORT_OUTPUT: successorOutput,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const exited = await Promise.race([successor.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
    if (!exited) successor.kill("SIGKILL");
    const exitCode = await successor.exited;
    expect(exited).toBe(true);
    expect(exitCode).toBe(0);

    const result = JSON.parse(readFileSync(successorOutput, "utf8"));
    if (!result.ok) {
      expect(result.message).toContain("no free glosa test port block");
      continue;
    }
    expect(result.port).toBe(port);
    reclaimed = true;
  }
  expect(reclaimed).toBe(true);
});

test("exhausting the block range fails with a message that says what to do", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-exhaust-"));
  cleanupDirs.push(root);
  const outputPath = join(root, "message");
  const script = `
    import { writeFileSync } from "node:fs";
    import { randomPort } from ${JSON.stringify(childHelperPath)};
    let message = "no error";
    let first = null;
    try { first = randomPort(); randomPort(); } catch (error) { message = error.message; }
    writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, JSON.stringify({ first, message }));
    if (first === null) process.exitCode = 75;
  `;
  // Start near the end of the range so ordinary suites scanning upward do not make this test
  // contend with them. Retry adjacent blocks if another copy of this test already has one.
  let exitCode = 1;
  for (let attempt = 0; attempt < 20 && exitCode !== 0; attempt += 1) {
    const offset = 7_999 - attempt;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      env: {
        ...Bun.env,
        GLOSA_TEST_PORT_OUTPUT: outputPath,
        GLOSA_TEST_PORT_BLOCK_OFFSET: String(offset),
        GLOSA_TEST_PORT_BLOCKS: "1",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    exitCode = await child.exited;
  }

  expect(exitCode).toBe(0);
  const { first, message } = JSON.parse(readFileSync(outputPath, "utf8"));
  expect(message).not.toBe("no error");
  expect(message).toContain(`${first}-${first + PORT_BLOCK_SIZE - 1}`); // names the exact range it searched
  expect(message).toContain("lsof"); // hands the reader a command that shows who is holding it
});
