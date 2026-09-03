// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa open [target] [focus]` (A6 §F26, issue #46). Thin wrapper over the shared
// open-presentation module so CLI and MCP `glosa_present` cannot drift.
import { existsSync, lstatSync } from "node:fs";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import type { GlosaApiClient } from "./api-client.ts";
import { type CommandEnvelope, printJsonEnvelope } from "./envelope.ts";
import type { InitResult } from "./scoped-init.ts";
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
      const env = { ...Bun.env };
      delete env.ANTHROPIC_API_KEY;
      Bun.spawn({ cmd: ["open", url], env, stdout: "ignore", stderr: "ignore" });
    },
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

export interface OfferInitOptions {
  /** `--init`: run init without prompting (CI-safe). */
  initFlag?: boolean;
  /** `--no-init`: never prompt, never run. */
  noInitFlag?: boolean;
  /** `--json` active — never prompt (A6: non-TTY never auto-enables --json; the inverse holds
   * too: a machine-readable invocation gets no interactive side channel). */
  json: boolean;
  /** Defaults to `process.stdin.isTTY` (the readStdin precedent in index.ts). */
  isTTY?: () => boolean;
  /** Defaults to confirm.ts's `confirmOnTty`. */
  confirm?: (question: string) => Promise<boolean>;
  /** Defaults to scoped-init.ts's `runScopedInit` (programmatic, idempotent-by-content) with the
   * providers detected in the workspace — the SAME entry point `glosa init` itself runs. It used
   * to default to init.ts's legacy v1 `runInit`, which writes the superseded
   * `.claude/.glosa-init.json` ownership layout that neither `doctor` nor the daemon's wiring
   * probe treats as authoritative any more (issue #96). */
  runInit?: (opts: { dir: string }) => Promise<InitResult>;
  /** Defaults to `process.stderr.write`. */
  stderr?: (text: string) => void;
}

/**
 * Post-`open` consented wiring offer (issue #78). Fires only when the open succeeded with a
 * `not-initialized` warning: on a TTY without `--json` it asks once; `--init` skips the question;
 * `--no-init` (or non-TTY, or `--json`) does nothing. Drifted workspaces are deliberately
 * excluded — re-init over drift can require `--force`, which `open` never runs on the user's
 * behalf. A `loose-file` registration is excluded too (issue #96): its `path` is the file's
 * containing directory — possibly `/private/tmp` or a parent full of unrelated repos — and A1
 * §5.19 already refuses to init one through the daemon route. Init failure is reported but never
 * alters `open`'s own exit code.
 */
export async function maybeOfferInit(
  result: CommandEnvelope<OpenPresentationData>,
  options: OfferInitOptions,
): Promise<void> {
  if (!result.ok || !result.data.path) return;
  if (result.data.kind === "loose-file") return;
  if (!result.warnings.some((w) => w.code === "not-initialized")) return;
  if (options.noInitFlag) return;

  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let consented = Boolean(options.initFlag);
  if (!consented) {
    const isTTY = options.isTTY ?? (() => Boolean(process.stdin.isTTY));
    if (options.json || !isTTY()) return;
    const confirm =
      options.confirm ?? (async (q: string) => (await import("./confirm.ts")).confirmOnTty(q));
    consented = await confirm("Wire this workspace for agent feedback? (runs `glosa init`)");
  }
  if (!consented) return;

  const runInit =
    options.runInit ??
    (async (o: { dir: string }) => {
      const scoped = await import("./scoped-init.ts");
      const detected = scoped.detectInstallProviders(o.dir);
      // Nothing detected -> install the deep, required integration rather than erroring on an
      // empty provider set; `glosa init` itself prompts here, and `open` must never prompt twice.
      const agents = detected.length > 0 ? detected : (["claude-code"] as const);
      return scoped.runScopedInit({ dir: o.dir, scope: "workspace", agents: [...agents] });
    });
  try {
    const initResult = await runInit({ dir: result.data.path });
    if (initResult.ok) {
      stderr("glosa open: wired — hooks + MCP entry installed.\n");
      stderr(
        "glosa open: restart or /resume your Claude Code session so it loads glosa; until then annotations are queued, not delivered.\n",
      );
    } else {
      stderr(`glosa open: init failed: ${initResult.error?.message ?? "unknown error"}\n`);
      if (initResult.error?.hint) stderr(`  hint: ${initResult.error.hint}\n`);
    }
  } catch (err) {
    stderr(`glosa open: init failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
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
