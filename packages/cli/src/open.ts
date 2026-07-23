// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa open [target] [focus]` (A6 §F26, issue #46). Thin wrapper over the shared
// open-presentation module so CLI and MCP `glosa_present` cannot drift.
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

export function realOpenDeps(createClient: () => Promise<GlosaApiClient>): OpenDeps {
  return {
    createClient,
    ensureToken,
    glosaHome,
    // macOS-only v1 (A6 §F30) — bare `open <url>` via the platform launcher is all that's needed,
    // no cross-platform detection. Fire-and-forget: `open` itself forks and hands off to the
    // browser almost immediately, so this CLI process doesn't need to await its exit.
    openBrowser: (url) => {
      Bun.spawn({ cmd: ["open", url], stdout: "ignore", stderr: "ignore" });
    },
    platform: () => process.platform,
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
