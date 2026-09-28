// SPDX-License-Identifier: Apache-2.0
// Shared test-only helpers for the P5.1 command surface's test files.
/** Only for launcher PIDs written by the current test's own exec-only fixture. */
export async function stopFixtureLauncher(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture launcher PID");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    // An orphaned Linux zombie has exited but may await init's reap; it is not a live launcher.
    const probe = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    const state = probe.stdout.toString().trim();
    if ((probe.exitCode === 1 && !state) || (probe.exitCode === 0 && state.startsWith("Z"))) return;
    if (probe.exitCode !== 0) throw new Error(`Cannot observe fixture launcher ${pid}: ${probe.stderr}`);
    await Bun.sleep(25);
  }
  throw new Error(`Fixture launcher ${pid} did not exit after SIGTERM`);
}

export function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

export function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  // biome-ignore lint: test-only stderr capture
  (process.stderr.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

export async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}
