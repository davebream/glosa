// SPDX-License-Identifier: Apache-2.0
// Wait inside a fresh process group until the guardian has verified ownership.
// This also makes ownership observable for executables that exit immediately.
let launched = false;
process.on("message", (message: unknown) => {
  if (launched || !message || typeof message !== "object") return;
  const spec = message as { command: string; args: string[]; cwd: string; env: Record<string, string> };
  if (typeof spec.command !== "string" || !Array.isArray(spec.args)) process.exit(1);
  launched = true;
  try {
    const native = Bun.spawn([spec.command, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.send?.({ op: "launched" });
    void native.exited.then((code) => process.exit(code));
  } catch {
    process.exit(1);
  }
});
process.on("disconnect", () => {
  if (!launched) process.exit(1);
});
