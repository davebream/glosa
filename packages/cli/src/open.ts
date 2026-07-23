// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa open [dir]` (A6 §F26). Ensures the daemon is running (lazy spawn via
// `ensureDaemon`, inside `createClient`), ensures `dir`'s `.glosa/` baseline scaffold exists via
// the daemon's own `POST /api/workspaces/open` (http.ts's P5.1 addition — this file never
// duplicates the scaffold logic itself, per this task's brief), mints/reuses the daemon's pairing
// token, and opens the SPA in the default browser at the literal `#t=<token>` fragment that A1 §2
// defines and bootstrap.js's `scrubToken` parses.
import { existsSync, statSync } from "node:fs";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import type { GlosaApiClient } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, daemonUnreachableEnvelope, printJsonEnvelope } from "./envelope.ts";

export interface OpenDeps {
  createClient: () => Promise<GlosaApiClient>;
  ensureToken: (home: string) => string;
  glosaHome: () => string;
  openBrowser: (url: string) => void;
  platform: () => NodeJS.Platform;
  dirExists: (dir: string) => boolean;
  fileExists: (path: string) => boolean;
}

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
    dirExists: (dir) => existsSync(dir) && statSync(dir).isDirectory(),
    fileExists: (path) => existsSync(path) && statSync(path).isFile(),
  };
}

export interface OpenData {
  slug?: string;
  path?: string;
  url?: string;
  /** Relative artifact path the SPA deep-links to when `glosa open` was given a FILE. */
  focus?: string;
}

export interface OpenOptions {
  /** Launch the URL through macOS after preparing the workspace. Defaults to true. */
  launchBrowser?: boolean;
  /** Keep directory state under GLOSA_HOME. Loose files always use external state. */
  externalState?: boolean;
}

export async function runOpen(
  target: string,
  deps: OpenDeps,
  options: OpenOptions = {},
): Promise<CommandEnvelope<OpenData>> {
  if (deps.platform() !== "darwin") {
    return {
      ok: false,
      command: "open",
      exitCode: EXIT_CODES.PLATFORM_UNSUPPORTED,
      data: {},
      warnings: [],
      error: { code: "platform-unsupported", kind: "platform_unsupported", message: "glosa v1 is macOS-only" },
    };
  }
  if (!deps.dirExists(target) && !deps.fileExists(target)) {
    return {
      ok: false,
      command: "open",
      exitCode: EXIT_CODES.USAGE,
      data: {},
      warnings: [],
      error: { code: "no-such-directory", kind: "usage", message: `${target}: no such file or directory` },
    };
  }

  // Mint/reuse the pairing token BEFORE ever ensuring the daemon — `bootDaemon` reads
  // `<home>/token` exactly ONCE, at its own boot, and never reloads it afterward (by design: a
  // daemon legitimately serves the SPA's `unpaired` screen until something pairs it, per A1 §2/
  // bootstrap.js's `selectScreen`). If THIS call is what causes the daemon's first-ever spawn for
  // this `GLOSA_HOME` (the common case — `glosa open` is normally the very first command run), the
  // token file must already exist on disk before that spawn, or the freshly-spawned daemon would
  // read `token: null` and stay unpaired for its entire process lifetime regardless of anything
  // minted afterward.
  const home = deps.glosaHome();
  const token = deps.ensureToken(home);

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("open", (err as Error).message), data: {} };
  }

  let opened: { slug: string; path: string; focus?: string };
  try {
    opened =
      options.externalState === undefined
        ? await client.openWorkspace(target)
        : await client.openWorkspace(target, { externalState: options.externalState });
  } catch (err) {
    return { ...daemonUnreachableEnvelope("open", (err as Error).message), data: {} };
  }

  // The fragment carries the deep-link beside the token (`w`=slug, `a`=artifact): bootstrap.js
  // reads both BEFORE scrubbing the fragment from the address bar.
  const focusParams = opened.focus ? `&w=${encodeURIComponent(opened.slug)}&a=${encodeURIComponent(opened.focus)}` : "";
  const url = `http://127.0.0.1:${client.port}/#t=${token}${focusParams}`;
  if (options.launchBrowser !== false) deps.openBrowser(url);

  return {
    ok: true,
    command: "open",
    exitCode: EXIT_CODES.OK,
    data: { slug: opened.slug, path: opened.path, url, ...(opened.focus ? { focus: opened.focus } : {}) },
    warnings: [],
  };
}

export function printOpenResult(result: CommandEnvelope<OpenData>, json: boolean, quiet = false): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa open: ${result.error?.message ?? "failed"}\n`);
    if (result.error?.hint) process.stderr.write(`  hint: ${result.error.hint}\n`);
    return;
  }
  if (!quiet) process.stdout.write(`glosa open: workspace ${result.data.path} (slug ${result.data.slug})\n`);
  process.stdout.write(`${result.data.url}\n`);
}
