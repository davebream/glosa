// SPDX-License-Identifier: Apache-2.0
import type { ProcessLauncher, ProfileLaunchSpec } from "./interface.ts";
import { ManagedAgentError } from "./interface.ts";

/** Foreground, bounded non-inference native status/version operation. No raw stderr escapes. */
export async function nativeProbe(spec: ProfileLaunchSpec, launcher: ProcessLauncher, args: string[]): Promise<string> {
  let output = "",
    overflow = false;
  const child = await launcher.spawn({
    command: spec.manifest.executable,
    args,
    cwd: spec.cwd,
    env: spec.env,
    onData(channel, bytes) {
      if (channel !== "stdout") return;
      if (output.length + bytes.length > 64 * 1024) {
        overflow = true;
        return;
      }
      output += Buffer.from(bytes).toString("utf8");
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ManagedAgentError("probe-timeout", "The account check timed out.", 504)),
          30_000,
        );
      }),
    ]);
    if (!exit.groupEmpty || overflow || exit.code !== 0)
      throw new ManagedAgentError("probe-failed", "The account check did not complete.", 502);
    return output;
  } finally {
    if (timer) clearTimeout(timer);
    await child.stop();
  }
}
