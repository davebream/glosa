// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../../src/agents/supervisor.ts";

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
