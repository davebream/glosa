// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — shared open-target classification + presentation URL construction for `glosa open`
// and MCP `glosa_present` (issue #46). Keeps registration, focus validation, binding warnings,
// redirected-state reporting, and fragment behavior in one place so CLI and MCP cannot drift.
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { GlosaApiClient, OpenWorkspaceResult } from "./api-client.ts";
import { isApiError } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, daemonUnreachableEnvelope } from "./envelope.ts";
import { type ManifestDriftResult, checkScopedManifestDrift } from "./scoped-init.ts";

export type OpenSurface = "document" | "workspace";
export type PresentationMode = "read" | "review" | "edit";
export type OpenSurfaceOverride = OpenSurface | "auto";

export interface ClassifiedOpenTarget {
  /** Absolute path sent to `POST /api/workspaces/open`. */
  openPath: string;
  /** Absolute focus path for two-arg `<dir> <file>` opens; omitted for single-target opens. */
  focusPath?: string;
  surface: OpenSurface;
  /** Usage-level failure before any daemon call. */
  error?: { code: string; message: string };
}

export interface PresentFragmentOptions {
  slug: string;
  focus?: string;
  surface: OpenSurface;
  mode: PresentationMode;
  /** When true, emit `lock=preview` (CLI `--preview` / MCP `mode:"read"`). */
  readLock: boolean;
  /** Durable pairing token (`t=`) or ephemeral presentation token (`p=`). Exactly one. */
  pairing: { kind: "durable"; token: string } | { kind: "presentation"; token: string };
}

export interface OpenPresentationData {
  slug?: string;
  path?: string;
  url?: string;
  focus?: string;
  /** The registration kind the daemon resolved. `loose-file` means `path` is the file's containing
   * directory, not a project root — callers must not offer to write agent config there (#96). */
  kind?: "directory" | "loose-file";
  surface?: OpenSurface;
  mode?: PresentationMode;
  preview?: boolean;
  bound_session?: string;
  state_dir?: string;
}

export interface OpenPresentationOptions {
  launchBrowser?: boolean;
  externalState?: boolean;
  readLock?: boolean;
  mode?: PresentationMode;
  bindSessionId?: string;
  /** When true, mint a short-TTL presentation token and put `p=` in the URL (MCP). */
  usePresentationToken?: boolean;
}

export interface OpenPresentationDeps {
  createClient: () => Promise<GlosaApiClient>;
  ensureToken: (home: string) => string;
  glosaHome: () => string;
  openBrowser: (url: string) => void;
  platform: () => NodeJS.Platform;
  /** The CLIENT's working directory, used to resolve relative open targets before the daemon
   * call. The daemon is a persistent singleton whose own cwd is arbitrary, so a relative target
   * must be absolutized here, not there. Defaults to `process.cwd`; injectable for tests. */
  cwd?: () => string;
  dirExists: (dir: string) => boolean;
  fileExists: (path: string) => boolean;
  /** True when the path exists as a regular non-symlink file. Defaults to `fileExists`. */
  isRegularFile?: (path: string) => boolean;
  /** Read-only init-manifest probe used for the `not-initialized`/`init-drifted` warnings.
   * Defaults to scoped-init.ts's `checkScopedManifestDrift` — the SAME function `glosa doctor`'s
   * `hooks`/`mcp` checks call, so open's verdict can never disagree with doctor's. The removed
   * legacy probe only looked at `.claude/.glosa-init.json`;
   * since `runScopedInit` writes `.glosa/init-manifest.json` and DELETES the legacy file after
   * migrating it, every correctly-wired workspace reported `not-initialized` (issue #96).
   * Injectable for tests. */
  checkManifestDrift?: (dir: string) => ManifestDriftResult;
}

/**
 * Classify CLI/MCP open arguments into a daemon open path + presentation surface.
 * Trailing slash expresses directory intent; nonexistent targets still fail (R1).
 */
export function classifyOpenTarget(
  target: string,
  focus: string | undefined,
  override: OpenSurfaceOverride,
  deps: Pick<OpenPresentationDeps, "dirExists" | "fileExists" | "isRegularFile" | "cwd">,
): ClassifiedOpenTarget {
  const isRegularFile = deps.isRegularFile ?? deps.fileExists;
  const wantsDirectory = target.endsWith("/") || target.endsWith("\\");
  const stripped = wantsDirectory ? target.replace(/[/\\]+$/, "") || target : target;
  // Absolutize relative targets against the CLIENT's cwd — the raw string is sent to the daemon,
  // whose own cwd is arbitrary, so a bare relative target (e.g. `.`) would otherwise register
  // whatever directory the daemon started in. This makes `openPath` genuinely absolute (its
  // documented contract). Trailing-slash intent is already captured in `wantsDirectory` above.
  const normalizedTarget = isAbsolute(stripped) ? stripped : resolvePath((deps.cwd ?? process.cwd)(), stripped);

  if (focus !== undefined) {
    if (override === "document") {
      return {
        openPath: normalizedTarget,
        surface: "document",
        error: {
          code: "usage",
          message: "--document cannot be combined with a second positional focus path",
        },
      };
    }
    if (!deps.dirExists(normalizedTarget)) {
      return {
        openPath: normalizedTarget,
        surface: "workspace",
        error: { code: "no-such-directory", message: `${normalizedTarget}: no such directory` },
      };
    }
    const focusAbs = isAbsolute(focus) ? focus : resolvePath(normalizedTarget, focus);
    if (!isRegularFile(focusAbs)) {
      return {
        openPath: normalizedTarget,
        focusPath: focusAbs,
        surface: "workspace",
        error: { code: "no-such-file", message: `${focusAbs}: no such file` },
      };
    }
    return { openPath: normalizedTarget, focusPath: focusAbs, surface: "workspace" };
  }

  if (override === "document") {
    if (isRegularFile(normalizedTarget) || deps.dirExists(normalizedTarget)) {
      return { openPath: normalizedTarget, surface: "document" };
    }
    return {
      openPath: normalizedTarget,
      surface: "document",
      error: {
        code: "not-a-file",
        message: `${normalizedTarget}: --document requires an existing directory or regular non-symlink file`,
      },
    };
  }

  if (override === "workspace") {
    if (!deps.dirExists(normalizedTarget) && !isRegularFile(normalizedTarget)) {
      return {
        openPath: normalizedTarget,
        surface: "workspace",
        error: { code: "no-such-path", message: `${normalizedTarget}: no such file or directory` },
      };
    }
    return {
      openPath: normalizedTarget,
      surface: "workspace",
    };
  }

  // Auto: trailing slash → directory intent; otherwise stat.
  if (wantsDirectory) {
    if (!deps.dirExists(normalizedTarget)) {
      return {
        openPath: normalizedTarget,
        surface: "workspace",
        error: { code: "no-such-directory", message: `${normalizedTarget}: no such directory` },
      };
    }
    return { openPath: normalizedTarget, surface: "workspace" };
  }

  if (deps.dirExists(normalizedTarget)) {
    return { openPath: normalizedTarget, surface: "workspace" };
  }
  if (isRegularFile(normalizedTarget)) {
    return { openPath: normalizedTarget, surface: "document" };
  }
  return {
    openPath: normalizedTarget,
    surface: "workspace",
    error: { code: "no-such-path", message: `${normalizedTarget}: no such file or directory` },
  };
}

/** Build the SPA deep-link fragment: pairing secret + non-secret route state. */
export function buildPresentationUrl(port: number, opts: PresentFragmentOptions): string {
  const params = new URLSearchParams();
  if (opts.pairing.kind === "durable") params.set("t", opts.pairing.token);
  else params.set("p", opts.pairing.token);
  params.set("w", opts.slug);
  if (opts.focus) params.set("a", opts.focus);
  params.set("surface", opts.surface);
  params.set("mode", opts.mode);
  if (opts.readLock) params.set("lock", "read");
  return `http://127.0.0.1:${port}/#${params.toString()}`;
}

export async function runOpenPresentation(
  target: string,
  focus: string | undefined,
  override: OpenSurfaceOverride,
  deps: OpenPresentationDeps,
  options: OpenPresentationOptions = {},
): Promise<CommandEnvelope<OpenPresentationData>> {
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

  const classified = classifyOpenTarget(target, focus, override, deps);
  if (classified.error) {
    return {
      ok: false,
      command: "open",
      exitCode: EXIT_CODES.USAGE,
      data: {},
      warnings: [],
      error: { code: classified.error.code, kind: "usage", message: classified.error.message },
    };
  }

  const mode: PresentationMode = options.mode ?? "read";
  const readLock = Boolean(options.readLock);
  const warnings: { code: string; message: string }[] = [];

  if (readLock && options.bindSessionId) {
    warnings.push({
      code: "preview-bind-conflict",
      message: "--preview hides annotate/edit controls while --bind wires feedback routing to a session",
    });
  }

  // Mint/reuse the pairing token BEFORE ensuring the daemon — see open.ts historical comment.
  const home = deps.glosaHome();
  const durableToken = deps.ensureToken(home);

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("open", (err as Error).message), data: {} };
  }

  let opened: OpenWorkspaceResult;
  try {
    const focusFirst = !classified.focusPath && deps.dirExists(classified.openPath);
    const openOpts = {
      ...(options.externalState === undefined ? {} : { externalState: options.externalState }),
      ...(classified.focusPath ? { focus: classified.focusPath } : {}),
      ...(focusFirst ? { focusFirst: true } : {}),
      ...(focusFirst && classified.surface === "document" ? { requireFocus: true } : {}),
    };
    opened =
      Object.keys(openOpts).length === 0
        ? await client.openWorkspace(classified.openPath)
        : await client.openWorkspace(classified.openPath, openOpts);
  } catch (err) {
    if (isApiError(err)) {
      const type =
        typeof err.problem === "object" && err.problem && "type" in err.problem
          ? String((err.problem as { type?: string }).type ?? "")
          : "";
      const code = type.split("/").pop() || "open-failed";
      return {
        ok: false,
        command: "open",
        exitCode: err.status === 422 || err.status === 400 ? EXIT_CODES.USAGE : EXIT_CODES.ENTRY_ERROR,
        data: {},
        warnings: [],
        error: {
          code,
          kind: err.status === 422 || err.status === 400 ? "usage" : "entry_error",
          message: err.message,
        },
      };
    }
    return { ...daemonUnreachableEnvelope("open", (err as Error).message), data: {} };
  }

  // Un-wired/drifted visibility (issue #78): a workspace can be opened+annotated WITHOUT init
  // (A6 — SPA-only, no agent delivery), but that state must never be silent — annotations queue
  // in the bus and are only delivered through init-installed hooks. Advisory only: exit stays 0,
  // and an internal probe failure never breaks `open`.
  try {
    const probe = deps.checkManifestDrift ?? ((dir: string) => checkScopedManifestDrift(dir, { glosaHomeDir: home }));
    const drift = probe(opened.path);
    if (drift.manifest === null) {
      // A loose-file registration's worktree is the file's CONTAINING directory, which can be
      // `/private/tmp` or a parent holding several unrelated repos. A1 §5.19 already refuses to
      // run init there through the daemon route ("writing `.claude/` config there would be a
      // surprising mutation"); telling the user to run the same thing by hand contradicted that
      // refusal (issue #96). Name the file's own status instead, and never a directory to wire.
      warnings.push(
        opened.kind === "loose-file"
          ? {
              code: "not-initialized",
              message:
                "this file is not inside a project glosa can wire — annotations are saved locally but will never be delivered to a session.\n" +
                "  fix: move it into a git repository, then run `glosa open` on it again.",
            }
          : {
              code: "not-initialized",
              message:
                "this workspace is not wired for agent feedback — annotations are saved locally but will never be delivered to a session.\n" +
                `  fix: run \`glosa init ${opened.path}\`\n` +
                "  then: restart or /resume your Claude Code session so it loads glosa.",
            },
      );
    } else if (drift.drifted.length > 0) {
      warnings.push({
        code: "init-drifted",
        message:
          `glosa's agent integration has drifted since \`glosa init\` (${drift.drifted.length} node(s) changed) — delivery may be broken.\n` +
          `  fix: re-run \`glosa init ${opened.path}\`\n` +
          "  then: restart or /resume your Claude Code session.",
      });
    }
  } catch {
    // Visibility must never make `open` fragile — skip the warning on probe failure.
  }

  let boundSession: string | undefined;
  if (options.bindSessionId) {
    try {
      if (!client.bindSession) throw new Error("session binding is unavailable");
      const bound = await client.bindSession(classified.openPath, options.bindSessionId);
      boundSession = bound.session_id;
    } catch (err) {
      const message = isApiError(err) ? err.message : err instanceof Error ? err.message : "session bind failed";
      warnings.push({
        code: "bind-failed",
        message: `could not bind session ${options.bindSessionId}: ${message}`,
      });
    }
  }

  let pairing: PresentFragmentOptions["pairing"] = { kind: "durable", token: durableToken };
  if (options.usePresentationToken) {
    try {
      if (!client.mintPresentationToken) throw new Error("presentation tokens are unavailable");
      const minted = await client.mintPresentationToken();
      pairing = { kind: "presentation", token: minted.token };
    } catch (err) {
      return {
        ok: false,
        command: "open",
        exitCode: EXIT_CODES.ENTRY_ERROR,
        data: {},
        warnings,
        error: {
          code: "presentation-token-failed",
          kind: "entry_error",
          message: err instanceof Error ? err.message : "failed to mint presentation token",
        },
      };
    }
  }

  const focusRel = opened.focus;
  const url = buildPresentationUrl(client.port, {
    slug: opened.slug,
    focus: focusRel,
    surface: classified.surface,
    mode,
    readLock,
    pairing,
  });

  if (options.launchBrowser !== false) deps.openBrowser(url);

  return {
    ok: true,
    command: "open",
    exitCode: EXIT_CODES.OK,
    data: {
      slug: opened.slug,
      path: opened.path,
      url,
      ...(focusRel ? { focus: focusRel } : {}),
      ...(opened.kind ? { kind: opened.kind } : {}),
      surface: classified.surface,
      mode,
      preview: readLock,
      ...(boundSession ? { bound_session: boundSession } : {}),
      ...(opened.state_dir ? { state_dir: opened.state_dir } : {}),
    },
    warnings,
  };
}
