// SPDX-License-Identifier: Apache-2.0
// The shell's pure decisions. No Electron, no I/O: every rule the main process enforces is a
// function here so it can be tested without a window, and so the main process stays a thin
// wiring layer. Contracts: docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md
// (R-O1…R-O6, R-P1…R-P5) and docs/research/2026-09-25-desktop-shell-readiness.md §3.
import { join } from "node:path";

/** The SPA contract major this shell was built against (A1: major mismatch → reload, never a fix). */
export const SHELL_CONTRACT_MAJOR = "1";

/** Loopback is the only place the shell's renderer may talk to (invariant 5; readiness note §3). */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") return true;
  return hostname.endsWith(".localhost");
}

/**
 * The egress gate is a browser-process decision, not a CSP: `session.webRequest.onBeforeRequest`
 * cancels everything the renderer tries to reach off loopback. `data:` and `blob:` never leave the
 * process; `devtools:` is Electron's own UI. Everything else, including `file:`, is cancelled.
 */
export function egressDecision(url: string): "allow" | "cancel" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "cancel";
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "devtools:") return "allow";
  if (parsed.protocol !== "http:") return "cancel";
  return isLoopbackHost(parsed.hostname) ? "allow" : "cancel";
}

/**
 * The top frame may only ever be the SPA origin. The class-F origin is deliberately not allowed
 * here: a class-F document loaded top level is unsandboxed by the iframe attribute it lost, and
 * the spike showed it navigating itself off loopback (readiness note §1b). Origins are compared as
 * parsed origins, never with `startsWith`.
 */
export function navigationDecision(target: string, spaOrigin: string): "allow" | "deny" {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return "deny";
  }
  return parsed.origin === spaOrigin ? "allow" : "deny";
}

/** R-P3: the preload is a per-origin capability. Exact origin equality, nothing looser. */
export function preloadShouldExpose(pageOrigin: string, spaOrigin: string): boolean {
  return pageOrigin === spaOrigin;
}

/**
 * R-P1: the shell hands the presentation token to the page over IPC, never in the URL the window
 * loads, so a crash reporter, a `did-navigate` listener or Chromium's own URL logging never sees
 * it. The CLI mints into the fragment (`#p=…`); this splits that fragment into the URL the window
 * loads and the token the page will ask for once.
 */
export function splitPresentationToken(url: string): { tokenlessUrl: string; token: string | null } {
  const parsed = new URL(url);
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hash);
  const token = params.get("p");
  if (token === null) return { tokenlessUrl: url, token: null };
  params.delete("p");
  const rest = params.toString();
  parsed.hash = rest ? `#${rest}` : "";
  return { tokenlessUrl: parsed.toString(), token };
}

/** What the shell keeps from `glosa open --url --json`: the link, the workspace's slug, and its
 * folder. `path` is the daemon's absolute `worktree_path`, a directory even when the target was a
 * single file, never the argument the shell was given (#160). */
export interface OpenedWorkspace {
  url: string;
  slug: string;
  path: string;
}

/** The A6 JSON envelope `glosa open --url --json` prints. Anything else is a refusal, not a guess. */
export function parseOpenEnvelope(text: string): OpenedWorkspace {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("glosa open did not print a JSON envelope");
  }
  const env = body as {
    glosa_json?: unknown;
    ok?: unknown;
    data?: { url?: unknown; slug?: unknown; path?: unknown };
    error?: unknown;
  };
  if (env.glosa_json !== 1) throw new Error("glosa open printed something that is not the A6 envelope");
  if (env.ok !== true) {
    const err = env.error as { code?: unknown; message?: unknown } | null | undefined;
    throw new Error(`glosa open refused: ${String(err?.code ?? "unknown")} ${String(err?.message ?? "")}`.trim());
  }
  if (typeof env.data?.url !== "string" || typeof env.data?.slug !== "string") {
    throw new Error("glosa open envelope has no url");
  }
  if (typeof env.data.path !== "string" || !env.data.path.startsWith("/")) {
    throw new Error("glosa open envelope has no absolute path");
  }
  return { url: env.data.url, slug: env.data.slug, path: env.data.path };
}

/** The surface kind a link opens (`kind=` in its fragment). A link without one opens a companion
 * surface, the SPA's own default (bootstrap.js), so the shell reads it the same way. */
export function surfaceKind(url: string): "desk" | "companion" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "companion";
  }
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  return new URLSearchParams(hash).get("kind") === "desk" ? "desk" : "companion";
}

/** `0.1.0-alpha.31` style ordering: numeric parts, then a release outranks any prerelease, then
 * the prerelease number. Enough for "is the daemon at least the version this shell was built for". */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const preNum = pre ? Number.parseInt(pre.replace(/^[^0-9]*/, ""), 10) || 0 : Number.POSITIVE_INFINITY;
    return { nums, preNum };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.preNum === y.preNum) return 0;
  return x.preNum > y.preNum ? 1 : -1;
}

export type Handshake = { contract_version?: unknown; daemon_version?: unknown };

export type Compatibility =
  | { state: "ok" }
  | { state: "down"; command: string }
  | { state: "too-old"; command: string }
  | { state: "incompatible"; command: string };

/**
 * R-O5: compatibility is checked, not repaired. The shell carries the minimum daemon version it was
 * built for and its contract major; a daemon below or beside that gets a blocking screen with the
 * one CLI command that fixes it. The shell never mutates the install.
 */
export function compatibility(handshake: Handshake | null, minimumDaemon: string): Compatibility {
  if (!handshake) return { state: "down", command: "glosa open <folder>" };
  const contract = String(handshake.contract_version ?? "");
  if (contract.split(".")[0] !== SHELL_CONTRACT_MAJOR) {
    return { state: "incompatible", command: "glosa update" };
  }
  const version = typeof handshake.daemon_version === "string" ? handshake.daemon_version : "0.0.0";
  if (compareVersions(version, minimumDaemon) < 0) return { state: "too-old", command: "glosa update" };
  return { state: "ok" };
}

/**
 * R-O4: the daemon outlives the shell. The shell delegates every spawn to `glosa open`, so it
 * never owns a daemon and this always says "leave"; the rule is kept as a function so the day the
 * shell spawns directly, the guard already exists and is tested.
 */
export function quitDecision(status: {
  spawnedByShell: boolean;
  boundSessions: number;
  heldClaims: number;
}): "stop" | "leave" {
  if (!status.spawnedByShell) return "leave";
  if (status.boundSessions > 0 || status.heldClaims > 0) return "leave";
  return "stop";
}

/** Invariant 5: nothing the shell spawns may carry an API key. */
export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY") continue;
    out[k] = v;
  }
  return out;
}

/**
 * The main process talks to the daemon over the loopback IP, never the `glosa.localhost` name.
 * Chromium resolves `*.localhost` internally (RFC 6761) so the window can load that origin, but
 * the main process uses Node's resolver, and on a macOS 14 GitHub runner that name did not
 * resolve at all: the compatibility check reported the daemon down while it was serving. The Host
 * `127.0.0.1:<port>` is on the daemon's allowlist (A3 §4), so nothing is lost.
 */
export function loopbackApiOrigin(spaOrigin: string): string {
  const parsed = new URL(spaOrigin);
  return `http://127.0.0.1:${parsed.port}`;
}

/**
 * The file the window represents, for macOS's proxy icon, the title-bar path popover and Reveal in
 * Finder, the way an editor's window does. Derived from the route the SPA is showing (`a=` in the
 * fragment) under the folder the shell opened; a route with no document represents the folder
 * itself. It represents nothing when the route names another workspace than the one this window
 * opened (`w=`: the SPA can switch workspace inside a window), or when the relative path is not a
 * plain one: absolute, `..` or `.` segments, empty segments, or backslashes.
 */
export function representedFile(url: string, folder: string, slug?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hash);
  const workspace = params.get("w");
  if (slug !== undefined && workspace !== null && workspace !== slug) return null;
  const artifact = params.get("a");
  if (!artifact) return folder;
  if (artifact.startsWith("/") || artifact.includes("\\")) return null;
  const segments = artifact.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return `${folder.replace(/\/+$/, "")}/${artifact}`;
}

/** What Reveal in Finder needs from the filesystem, injected so the rule is testable. */
export interface RevealIo {
  /** The real path, symlinks resolved, or null when it cannot be resolved. */
  realpath: (path: string) => string | null;
  exists: (path: string) => boolean;
}

/**
 * The path Reveal in Finder shows (#160). The page never sends one (A3 "Desktop shell"): the main
 * process derives it from the window's own URL and the folder it opened. The file must resolve
 * inside the folder after symlinks, so a link inside the workspace cannot reveal a file outside
 * it; a file that no longer exists falls back to the folder. Null means reveal nothing.
 */
export function revealTarget(url: string, window: { folder: string; slug: string }, io: RevealIo): string | null {
  const file = representedFile(url, window.folder, window.slug);
  if (file === null) return null;
  const root = io.realpath(window.folder);
  if (root === null) return null;
  if (!io.exists(file)) return root;
  const real = io.realpath(file);
  if (real === null) return root;
  return real === root || real.startsWith(`${root.replace(/\/+$/, "")}/`) ? real : null;
}

/** What the shell needs to know to find a glosa CLI. The main process fills it; nothing here reads. */
export interface CliLookup {
  /** GLOSA_SHELL_CLI: the test harness's injection point. When set it is the only candidate. */
  override?: string;
  /** GLOSA_HOME, when set; otherwise the recorded executable lives under `<homeDir>/.glosa`. */
  glosaHome?: string;
  homeDir: string;
  /** Electron's `process.resourcesPath` when the app is packaged, else null. */
  resourcesPath: string | null;
}

/**
 * The CLIs the shell tries, in order (R-O1, #371). The recorded executable is the install of
 * truth, so it comes first: on a machine with a terminal install, the app runs that install. The
 * CLI a packaged app carries comes second, which is what makes a downloaded app complete on a
 * machine with nothing recorded; running it records it. The well-known bin directories cover a
 * Dock launch with a bare PATH, and the bare name is last. The caller keeps the first candidate
 * that exists; a dangling recorded link does not, so it falls through to the next one.
 */
export function cliCandidates(lookup: CliLookup): string[] {
  if (lookup.override) return [lookup.override];
  const candidates = [join(lookup.glosaHome ?? join(lookup.homeDir, ".glosa"), "bin", "glosa")];
  if (lookup.resourcesPath !== null) candidates.push(join(lookup.resourcesPath, "bin", "glosa"));
  candidates.push(
    join(lookup.homeDir, ".bun", "bin", "glosa"),
    "/opt/homebrew/bin/glosa",
    "/usr/local/bin/glosa",
    "glosa",
  );
  return candidates;
}

// ---------- glosa:// links (#392) ----------

/** What a `glosa://open?...` link asks for. Never a token: the shell mints its own by running
 *  `glosa open` (R-P1), so a link carries only route state. */
export interface GlosaLink {
  /** Absolute folder or file. */
  path: string;
  /** Workspace-relative document to focus. */
  focus: string | null;
  kind: "desk" | "companion";
  surface: "document" | "workspace" | null;
  mode: "read" | "review" | "edit" | null;
  readLock: boolean;
}

/** True when `path` is made only of plain segments: no `.`, `..` or empty segment, no backslash,
 *  no NUL. `absolute` decides whether it must start with `/` or must not. */
export function plainPath(path: string, absolute: boolean): boolean {
  if (path.length === 0 || path.length > 4096 || path.includes("\\") || path.includes("\0")) return false;
  if (absolute !== path.startsWith("/")) return false;
  const segments = (absolute ? path.slice(1) : path).split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null | undefined {
  if (value === null) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Parses `glosa://open?path=<abs>[&focus=<rel>][&kind=desk|companion][&surface=document|workspace]
 * [&mode=read|review|edit][&lock=read]`. Anything else answers null: a wrong scheme or action, a
 * path that is not absolute and plain, a focus that is not relative and plain, an unknown value, a
 * repeated or unknown parameter, and so any token (`p`, `t`). A missing kind is a companion, the
 * SPA's own default.
 */
export function parseGlosaUrl(url: string): GlosaLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "glosa:" || parsed.hostname !== "open") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (parsed.hash !== "" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  const known = new Set(["path", "focus", "kind", "surface", "mode", "lock"]);
  const keys = [...parsed.searchParams.keys()];
  if (keys.some((key) => !known.has(key)) || new Set(keys).size !== keys.length) return null;
  const params = parsed.searchParams;
  const path = params.get("path");
  if (path === null || !plainPath(path, true)) return null;
  const focus = params.get("focus");
  if (focus !== null && !plainPath(focus, false)) return null;
  const kind = oneOf(params.get("kind"), ["desk", "companion"] as const);
  const surface = oneOf(params.get("surface"), ["document", "workspace"] as const);
  const mode = oneOf(params.get("mode"), ["read", "review", "edit"] as const);
  const lock = oneOf(params.get("lock"), ["read"] as const);
  if (kind === undefined || surface === undefined || mode === undefined || lock === undefined) return null;
  return { path, focus, kind: kind ?? "companion", surface, mode, readLock: lock === "read" };
}

/**
 * The `glosa open` arguments that reproduce a link, before `--url --json`. A document surface with a
 * focus opens the file itself, since the CLI refuses `--document` beside a second positional.
 * `lock=read` is `--read`; kind and mode have no flag and are set on the answered URL (`withRoute`).
 */
export function openArgsFor(link: GlosaLink): string[] {
  const read = link.readLock ? ["--read"] : [];
  if (link.surface === "document") {
    const target = link.focus ? `${link.path.replace(/\/+$/, "")}/${link.focus}` : link.path;
    return [target, "--document", ...read];
  }
  return [
    link.path,
    ...(link.focus ? [link.focus] : []),
    ...(link.surface === "workspace" ? ["--workspace"] : []),
    ...read,
  ];
}

/** Sets `kind=` and, when given, `mode=` in an SPA URL's fragment; every other entry keeps its
 *  place. A URL that does not parse is returned unchanged. */
export function withRoute(
  httpUrl: string,
  route: { kind: "desk" | "companion"; mode?: "read" | "review" | "edit" | null },
): string {
  let parsed: URL;
  try {
    parsed = new URL(httpUrl);
  } catch {
    return httpUrl;
  }
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hash);
  params.set("kind", route.kind);
  if (route.mode) params.set("mode", route.mode);
  parsed.hash = params.toString();
  return parsed.toString();
}

/** A window as link routing sees it. */
export interface RoutedWindow {
  id: number;
  origin: string;
  folder: string | null;
  kind: "desk" | "companion" | null;
}

/**
 * The window a link reuses: one with the same origin, folder AND kind. Anything else opens a new
 * window, so a companion link beside a desk window on the same folder gets its own window and each
 * window keeps one kind (feature map decision 5).
 */
export function windowFor(
  opened: { origin: string; folder: string; kind: "desk" | "companion" },
  windows: readonly RoutedWindow[],
): number | null {
  const match = windows.find((w) => w.origin === opened.origin && w.folder === opened.folder && w.kind === opened.kind);
  return match ? match.id : null;
}

/**
 * True when no window shows `path`, as its folder or inside it. Any web page can fire a `glosa://`
 * link, so a link to a folder the person has not opened asks first.
 */
export function needsConfirmation(path: string, windows: readonly RoutedWindow[]): boolean {
  const target = path.replace(/\/+$/, "");
  return !windows.some((w) => {
    if (!w.folder) return false;
    const folder = w.folder.replace(/\/+$/, "");
    return target === folder || target.startsWith(`${folder}/`);
  });
}

/** The first `glosa://` link in an argument list: how a cold launch and a second instance hand one
 *  over, and what the tests drive. */
export function linkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("glosa://")) ?? null;
}

/** Ids of notifications already shown, bounded so a long session cannot grow it (#391). Several
 * windows report the same attention, so the first report shows and the rest are dropped. */
export class RecentIds {
  private readonly ids = new Set<string>();
  private readonly limit: number;
  constructor(limit = 500) {
    this.limit = limit;
  }
  /** Records `id`. True when it was new; the oldest id is forgotten past the limit. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}

export interface NotifyDecision {
  /** The Dock badge to set: the latest count, never summed across windows. 0 clears it. */
  badge?: number;
  /** A notification to show, once per id. */
  show?: { title: string; body: string };
}

/**
 * What one `notify({ id, title, body, badge })` from the SPA does (#391). A badge must be a
 * whole number from 0 up; anything else is ignored rather than shown. A notification needs a
 * title or a body, and one whose id was already shown is dropped. Title and body are clamped as
 * before (120 and 400 characters). The message never carries a path (A3 "Desktop shell").
 */
export function notifyDecision(payload: unknown, seen: RecentIds): NotifyDecision {
  const p = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const decision: NotifyDecision = {};
  if (typeof p.badge === "number" && Number.isInteger(p.badge) && p.badge >= 0) decision.badge = p.badge;
  const hasText =
    (typeof p.title === "string" && p.title.length > 0) || (typeof p.body === "string" && p.body.length > 0);
  if (!hasText) return decision;
  if (typeof p.id === "string" && p.id.length > 0 && !seen.add(p.id)) return decision;
  decision.show = {
    title: typeof p.title === "string" && p.title.length > 0 ? p.title.slice(0, 120) : "glosa",
    body: typeof p.body === "string" ? p.body.slice(0, 400) : "",
  };
  return decision;
}

// ---------- the window follows glosa's appearance (#405) ----------

/**
 * glosa's own paper, light and dark (`bg` in packages/spa/src/themes/light.json and dark.json,
 * `oklch(0.99 0.007 85)` and `oklch(0.205 0.008 60)`, as sRGB; High contrast keeps the same
 * paper). A window's first frame before any page has reported: the shell cannot read a theme,
 * so it paints the paper of the operating system's scheme.
 */
export const PAPER = Object.freeze({ light: "#fefbf7", dark: "#1a1614" });

/** What one `reportAppearance` from the SPA sets: the process's `nativeTheme.themeSource`, and the
 * reporting window's background (and every later window's first frame). */
export interface AppearanceDecision {
  themeSource: "system" | "light" | "dark";
  scheme: "light" | "dark";
  background: string;
}

const APPEARANCE_KEYS = new Set(["source", "scheme", "background"]);

/**
 * Validates `reportAppearance({ source, scheme, background })` from the SPA (#405, A3 §4b). Exactly
 * those three keys, nothing else, so no path or other field can ride along: `source` is whether
 * the page follows the operating system or fixed a scheme ("system", "light" or "dark"), `scheme`
 * the one it paints with ("light" or "dark", and equal to `source` unless that is "system"), and
 * `background` its paper as `#rrggbb`. Anything else answers null and changes nothing.
 */
export function appearanceDecision(payload: unknown): AppearanceDecision | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== APPEARANCE_KEYS.size || !keys.every((key) => APPEARANCE_KEYS.has(key))) return null;
  const { source, scheme, background } = payload as Record<string, unknown>;
  if (scheme !== "light" && scheme !== "dark") return null;
  const themeSource = source === "system" ? "system" : source === scheme ? scheme : null;
  if (themeSource === null) return null;
  if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) return null;
  return { themeSource, scheme, background: background.toLowerCase() };
}

/** A new window's first frame: the paper the last report named, else the operating system's. */
export function firstFrameColor(lastReported: string | null, osIsDark: boolean): string {
  return lastReported ?? (osIsDark ? PAPER.dark : PAPER.light);
}

// ---------- the page follows macOS Increase contrast (#425) ----------

/**
 * The answer to the page's synchronous "does the system ask for more contrast?" read (A3 §4b).
 * Electron passes no contrast preference to pages, so the preload asks once per document, before
 * the page's first script. `reading` is `nativeTheme.shouldUseHighContrastColors` at that moment.
 * A frame that is not the window's SPA origin is refused with null, which the preload reads as no
 * more contrast; only an exact `true` is more contrast.
 */
export function contrastReply(fromSpa: boolean, reading: unknown): boolean | null {
  return fromSpa ? reading === true : null;
}

/**
 * What one `nativeTheme` `updated` pushes to the SPA windows: the new value when it differs from
 * the last one pushed, else null. `updated` fires for any theme change, the page's own
 * `themeSource` included, so an unchanged value pushes nothing.
 */
export function contrastPush(lastPushed: boolean, reading: unknown): boolean | null {
  const value = reading === true;
  return value === lastPushed ? null : value;
}

/**
 * Whether a push reaches a window: only while its top frame has committed the SPA origin the shell
 * recorded for it. A window keeps its recorded origin when the shell loads a blocking screen into it
 * (a `data:` page, whose origin is opaque) after a failed compatibility check, and that screen is not
 * the SPA (A3 §4b).
 */
export function contrastPushReaches(recordedOrigin: string | null | undefined, frameOrigin: unknown): boolean {
  return typeof recordedOrigin === "string" && recordedOrigin !== "" && frameOrigin === recordedOrigin;
}
