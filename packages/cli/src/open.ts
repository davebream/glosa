// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa open [target] [focus]` (A6 §F26, issue #46). Thin wrapper over the shared
// open-presentation module so CLI and MCP `glosa_present` cannot drift.
import { browserLauncher } from "./platform.ts";
import { existsSync, lstatSync } from "node:fs";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import type { GlosaApiClient } from "./api-client.ts";
import { type CommandEnvelope, printJsonEnvelope } from "./envelope.ts";
import {
  type OpenPresentationData,
  type OpenPresentationDeps,
  type OpenPresentationOptions,
  type OpenSurfaceOverride,
  runOpenPresentation,
} from "./open-presentation.ts";

export type { OpenPresentationData as OpenData, OpenPresentationOptions as OpenOptions };
export type OpenDeps = OpenPresentationDeps;

/** The launcher may remain alive with its browser. Bound confirmation without killing either. */
export async function launchBrowser(url: string): Promise<void> {
  const env = { ...Bun.env };
  delete env.ANTHROPIC_API_KEY;
  const child = Bun.spawn({
    cmd: [browserLauncher(process.platform), url],
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser launcher timed out")), 5_000);
      }),
    ]);
    if (code !== 0) throw new Error("Browser launcher failed");
  } finally {
    clearTimeout(timer);
  }
}

export function realOpenDeps(createClient: () => Promise<GlosaApiClient>): OpenDeps {
  return {
    createClient,
    ensureToken,
    glosaHome,
    openBrowser: launchBrowser,
    platform: () => process.platform,
    cwd: () => process.cwd(),
    dirExists: (dir) => {
      try {
        return existsSync(dir) && lstatSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (path) => {
      try {
        return existsSync(path) && lstatSync(path).isFile();
      } catch {
        return false;
      }
    },
    isRegularFile: (path) => {
      try {
        const st = lstatSync(path);
        return st.isFile() && !st.isSymbolicLink();
      } catch {
        return false;
      }
    },
  };
}

export async function runOpen(
  target: string,
  deps: OpenDeps,
  options: OpenPresentationOptions & {
    focus?: string;
    surface?: OpenSurfaceOverride;
  } = {},
): Promise<CommandEnvelope<OpenPresentationData>> {
  const { focus, surface = "auto", ...rest } = options;
  return runOpenPresentation(target, focus, surface, deps, rest);
}

export function printOpenResult(result: CommandEnvelope<OpenPresentationData>, json: boolean, quiet = false): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa open: ${result.error?.message ?? "failed"}\n`);
    if (result.error?.hint) process.stderr.write(`  hint: ${result.error.hint}\n`);
    return;
  }
  for (const warning of result.warnings) {
    process.stderr.write(`glosa open: warning: ${warning.message}\n`);
  }
  if (!quiet) process.stdout.write(`glosa open: workspace ${result.data.path} (slug ${result.data.slug})\n`);
  process.stdout.write(`${result.data.url}\n`);
}
