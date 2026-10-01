// SPDX-License-Identifier: Apache-2.0
// The shell's pure decisions. No Electron, no I/O: every rule the main process enforces is a
// function here so it can be tested without a window, and so the main process stays a thin
// wiring layer. Contracts: docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md
// (R-O1…R-O6, R-P1…R-P5) and docs/research/2026-09-25-desktop-shell-readiness.md §3.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** One foreground Linux dictation lease, never a session-wide media or network exception. */
export function dictationPermissionAllowed(input: {
  platform: string;
  active: boolean;
  mainFrame: boolean;
  origin?: string;
  expectedOrigin?: string;
  permission: string;
  mediaTypes: readonly string[];
}): boolean {
  return (
    input.platform === "linux" &&
    input.active &&
    input.mainFrame &&
    Boolean(input.expectedOrigin) &&
    (input.origin === input.expectedOrigin || input.origin === `${input.expectedOrigin}/`) &&
    input.permission === "media" &&
    input.mediaTypes.length === 1 &&
    input.mediaTypes[0] === "audio"
  );
}

export function dictationEgressAllowed(input: {
  platform: string;
  active: boolean;
  mainFrame: boolean;
  origin?: string;
  expectedOrigin?: string;
  url: string;
  resourceType: string;
}): boolean {
  return (
    dictationPermissionAllowed({ ...input, permission: "media", mediaTypes: ["audio"] }) &&
    input.resourceType === "webSocket" &&
    input.url === "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws"
  );
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

/** A SemVer 2.0 version: the three core numbers and the prerelease identifiers, all as the digits
 * or text they were written with. Build metadata is dropped: it never affects precedence. */
export interface Version {
  core: [string, string, string];
  pre: string[];
}

// semver.org's own pattern, less the capture of build metadata. No leading zeros in numbers.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Parses a SemVer 2.0 version strictly; anything else, including a leading `v`, is null. SemVer
 * sets no length limit, so neither does this: a bound on text from the network is the caller's. */
export function parseVersion(text: string): Version | null {
  const m = SEMVER.exec(text);
  if (!m) return null;
  return { core: [m[1] ?? "0", m[2] ?? "0", m[3] ?? "0"], pre: m[4] ? m[4].split(".") : [] };
}

/** Two digit strings with no leading zeros, compared as numbers of any size. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * SemVer 2.0 §11 precedence: core numbers numerically; a release above any of its prereleases;
 * prerelease identifiers left to right, numeric ones numerically, alphanumeric ones in ASCII order,
 * numeric below alphanumeric, and a longer list above a shorter one it starts with. Build metadata
 * is ignored. A version that does not parse ranks below every one that does, so a malformed daemon
 * version reads as too old.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = compareDigits(x.core[i] as string, y.core[i] as string);
    if (d !== 0) return d;
  }
  // A release (no identifiers) is above any of its prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] as string;
    const q = y.pre[i] as string;
    const pNumeric = /^\d+$/.test(p);
    const qNumeric = /^\d+$/.test(q);
    if (pNumeric && qNumeric) {
      const d = compareDigits(p, q);
      if (d !== 0) return d;
    } else if (pNumeric !== qNumeric) {
      return pNumeric ? -1 : 1;
    } else if (p !== q) {
      return p > q ? 1 : -1;
    }
  }
  return Math.sign(x.pre.length - y.pre.length);
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
  /** `process.platform`. Decides the well-known bin directories; macOS when omitted (#432). */
  platform?: NodeJS.Platform;
  homeDir: string;
  /** Electron's `process.resourcesPath` when the app is packaged, else null. */
  resourcesPath: string | null;
  /** The CLI in the source checkout, used by an unpackaged shell only. */
  checkoutCli?: string;
}

/** A different Chromium profile and singleton lock for each source checkout. */
export function devProfilePath(appData: string, checkoutRoot: string): string {
  const id = createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 16);
  return join(appData, "glosa-dev", id);
}

/** Packaged shells use the recorded install first (R-O1). An unpackaged shell uses only its
 * checkout CLI so testing it cannot silently select a published daemon. */
export function cliCandidates(lookup: CliLookup): string[] {
  if (lookup.override) return [lookup.override];
  if (lookup.resourcesPath === null) return lookup.checkoutCli ? [lookup.checkoutCli] : [];
  const candidates = [join(lookup.glosaHome ?? join(lookup.homeDir, ".glosa"), "bin", "glosa")];
  candidates.push(join(lookup.resourcesPath, "bin", "glosa"));
  // Linux has no Homebrew prefix to look in; the pacman package links /usr/bin/glosa (#432).
  const wellKnown =
    lookup.platform === "linux"
      ? ["/usr/local/bin/glosa", "/usr/bin/glosa"]
      : ["/opt/homebrew/bin/glosa", "/usr/local/bin/glosa"];
  candidates.push(join(lookup.homeDir, ".bun", "bin", "glosa"), ...wellKnown, "glosa");
  return candidates;
}

/**
 * R-L8 (#432): whether a shell may look for a CLI at all. A packaged app whose own bundled CLI is gone
 * was removed or replaced underneath it (`pacman -R`, an upgrade in progress); running another
 * install's CLI then would silently select that install, so it runs none and says so. An unpackaged
 * run, or a packaged app with its CLI in place, looks up candidates as usual.
 */
export function cliChoice(state: { packaged: boolean; ownCliExists: boolean }): "lookup" | "removed" {
  return state.packaged && !state.ownCliExists ? "removed" : "lookup";
}

/** What asking the shell to bring a window's daemon back came to (R-L8). */
export type ReconnectResult = { ok: true } | { ok: false; reason: "removed" | "foreign" | "failed"; message?: string };

/** R-L8: after `glosa open` ran for the window's folder, is the daemon answering the one this window
 * paired with? `paired` is the install id recorded when the window opened (null when the daemon
 * published none); `answered` the one the handshake reports now. */
export function reconnectOutcome(paired: string | null, answered: string | null): ReconnectResult {
  if (answered === null) return { ok: false, reason: "failed", message: "The glosa daemon is not answering." };
  if (paired !== null && answered !== paired) return { ok: false, reason: "foreign" };
  return { ok: true };
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

// ---------- Check for Updates…, on click only (#424) ----------

/** Every glosa release, newest created first. The Releases API, not `/releases/latest`: every
 * glosa release so far is a prerelease, and `/releases/latest` skips those. */
export const RELEASES_API = "https://api.github.com/repos/davebream/glosa/releases";

/** The same static User-Agent as `glosa update` (A6 §F33): no version, nothing about the machine,
 * so a check is never a version beacon. */
export const UPDATE_USER_AGENT = "glosa-update";

/** Every header the check sends. Constant, so no request says anything about who sent it. */
export const UPDATE_HEADERS = Object.freeze({
  accept: "application/vnd.github+json",
  "user-agent": UPDATE_USER_AGENT,
  "x-github-api-version": "2022-11-28",
});

/** The command the dialog copies on macOS. The app never installs itself: Homebrew owns the bundle. */
export const UPGRADE_COMMAND = "brew upgrade --cask glosa";

/** What the running app is: its `package.json` version, `process.arch` and `process.platform`
 * (macOS when omitted). */
export interface RunningApp {
  current: string;
  arch: string;
  platform?: NodeJS.Platform;
}

/** The release assets that make a version installable on this platform: the DMG or ZIP on macOS
 * (#371), the pacman package on Linux (#432), all named `glosa-<version>-<arch>.<ext>`. */
export function releaseAssetNames(platform: NodeJS.Platform, version: string, arch: string): string[] {
  if (platform === "linux") return [`glosa-${version}-${arch}.pacman`];
  return [`glosa-${version}-${arch}.dmg`, `glosa-${version}-${arch}.zip`];
}

/** How this copy of the app was installed, which decides what the update dialog offers. */
export type UpdateChannel = "homebrew-cask" | "pacman" | "download";

/** The channel for a platform and the package manager the Linux package names in its
 * `resources/package-type` marker. A Linux app without the marker was not installed by pacman,
 * so it only gets the release page, and a Linux app is never told to use Homebrew. */
export function updateChannelFor(platform: NodeJS.Platform, packageType: string | null): UpdateChannel {
  if (platform === "darwin") return "homebrew-cask";
  if (platform === "linux" && packageType === "pacman") return "pacman";
  return "download";
}

/** The package-type marker's content, or null when it is not one short lowercase word. */
export function parsePackageType(text: string | null): string | null {
  if (text === null || text.length > 64) return null;
  const value = text.trim();
  return /^[a-z0-9-]{1,32}$/.test(value) ? value : null;
}

/** A launcher argument as a path the CLI understands. A desktop entry's `%U` hands a folder over as
 * `file:///…` (#432); a local file URL becomes its path, and anything else is returned unchanged,
 * including a `file:` URL naming another host, which is not ours to open. */
export function targetFromArg(arg: string): string {
  // Only a URL with an authority part (`file://…`): a bare `file:` would otherwise parse as the root.
  if (!arg.startsWith("file://")) return arg;
  try {
    const url = new URL(arg);
    if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return arg;
    return fileURLToPath(url);
  } catch {
    return arg;
  }
}

/** A release the running app could move to, with the tag it was published under. */
export interface FoundRelease {
  version: string;
  tag: string;
}

/** The longest tag selection reads. glosa's are about 16 characters; the bound keeps text from the
 * network away from the version parser and out of an asset name, a dialog and a URL. */
export const MAX_TAG_LENGTH = 64;

/**
 * The newest release this app could upgrade to, or null. A release counts when its `draft` is
 * exactly `false`, its tag is `v` plus a SemVer version (or the bare version) no longer than
 * `MAX_TAG_LENGTH`, that version is above the running one, and it has one of `releaseAssetNames`
 * fully uploaded for the running platform and architecture: a published release with no app on it (as
 * `v0.1.0-alpha.32` and `33` are) is not one. The API lists releases by creation, so this takes the
 * maximum by version, never the first. Entries that do not have that shape are skipped, including
 * one whose `draft` is missing or not a boolean.
 */
export function newestRelease(releases: readonly unknown[], running: RunningApp): FoundRelease | null {
  let best: FoundRelease | null = null;
  for (const entry of releases) {
    if (typeof entry !== "object" || entry === null) continue;
    const release = entry as { draft?: unknown; tag_name?: unknown; assets?: unknown };
    if (release.draft !== false || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) continue;
    const tag = release.tag_name;
    if (tag.length > MAX_TAG_LENGTH) continue;
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (parseVersion(version) === null || compareVersions(version, running.current) <= 0) continue;
    const names = releaseAssetNames(running.platform ?? "darwin", version, running.arch);
    const installable = release.assets.some((asset: unknown) => {
      if (typeof asset !== "object" || asset === null) return false;
      const { name, state } = asset as { name?: unknown; state?: unknown };
      return typeof name === "string" && names.includes(name) && state === "uploaded";
    });
    if (installable && (best === null || compareVersions(version, best.version) > 0)) best = { version, tag };
  }
  return best;
}

export type UpdateOutcome =
  | { kind: "newer"; version: string; tag: string }
  | { kind: "current" }
  | { kind: "failed"; reason: string };

/** What the main process got back: GitHub's status and body, or no usable answer at all. */
export type UpdateResponse = { status: number; text: string } | { error: "timeout" | "network" | "too-large" };

/** The most of GitHub's answer the check reads: 2 MiB. The real list of 30 releases is about 117 KB. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Reads a fetched answer into an `UpdateResponse`, holding at most `cap` bytes. A non-2xx answer's
 * body is not read. A declared `Content-Length` over the cap is refused before reading, and a body
 * that grows past it is cancelled there, so a hostile answer ends as a failed check rather than
 * filling the main process's memory. Takes any WHATWG `Response` and does no I/O of its own: a
 * read that fails (a timeout's abort) rejects, for the caller to report.
 */
export async function readUpdateResponse(res: Response, cap = MAX_RESPONSE_BYTES): Promise<UpdateResponse> {
  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, text: "" };
  }
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return { error: "too-large" };
  }
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { error: "too-large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: res.status, text: new TextDecoder().decode(bytes) };
}

/** How long one check may take, the answer's headers and its whole body together. */
export const UPDATE_TIMEOUT_MS = 10_000;

/** The `fetch` a check uses, injected the way RevealIo is: the main process passes Node's global
 * `fetch` (never Electron's `net`, which the renderer's egress gate cancels). */
export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The one request a click makes, read into an `UpdateResponse`. Constant headers, no HTTP cache, no
 * redirect followed (a 3xx comes back as itself, and `updateOutcome` fails it), and one timeout
 * that bounds the headers and the capped body read together, so an answer that never finishes ends
 * as `timeout` rather than a check that never returns. Never throws.
 */
export async function requestReleases(
  url: string,
  fetchFn: UpdateFetch,
  timeoutMs = UPDATE_TIMEOUT_MS,
): Promise<UpdateResponse> {
  try {
    const res = await fetchFn(url, {
      headers: { ...UPDATE_HEADERS },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await readUpdateResponse(res);
  } catch (e) {
    return { error: (e as Error).name === "TimeoutError" ? "timeout" : "network" };
  }
}

/** Reads the answer to one check. A non-2xx status, or a body that is not a JSON array, fails. */
export function updateOutcome(response: UpdateResponse, running: RunningApp): UpdateOutcome {
  if ("error" in response) {
    const reasons = {
      timeout: "GitHub did not answer in time",
      network: "GitHub could not be reached",
      "too-large": "GitHub's answer was larger than 2 MiB, too large to be a list of releases",
    };
    return { kind: "failed", reason: reasons[response.error] };
  }
  // The main process fetches with `redirect: "manual"`, so a redirect arrives here, unfollowed.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return {
      kind: "failed",
      reason: `GitHub redirected the request (HTTP ${response.status}), and the check follows no redirect`,
    };
  }
  if (response.status === 403 || response.status === 429) {
    return { kind: "failed", reason: "GitHub is limiting requests from this network for now" };
  }
  if (response.status < 200 || response.status > 299) {
    return { kind: "failed", reason: `GitHub answered with HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = null;
  }
  if (!Array.isArray(body)) return { kind: "failed", reason: "GitHub's answer was not a list of releases" };
  const found = newestRelease(body, running);
  return found ? { kind: "newer", ...found } : { kind: "current" };
}

/** What one dialog button does: open a URL in the browser, copy text, or nothing. */
export type UpdateAction = { open: string } | { copy: string } | null;

/** A native message box's options, and what each of its buttons does, by index. */
export interface UpdateDialog {
  type: "info" | "warning";
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  actions: UpdateAction[];
}

/**
 * The dialog for a check's outcome. Open Release Page never opens a URL from GitHub's answer: for a
 * release found it is `<releasesPage>/tag/<tag>`, the tag already validated as a version, and
 * otherwise the releases page itself.
 */
export function updateDialog(
  outcome: UpdateOutcome,
  context: { current: string; releasesPage: string; channel?: UpdateChannel; arch?: string },
): UpdateDialog {
  const releases = context.releasesPage.replace(/\/+$/, "");
  const channel = context.channel ?? "homebrew-cask";
  if (outcome.kind === "newer" && channel === "pacman") {
    // pacman owns every file this app installed (#432): the app names the package and the command,
    // built from the validated version and the running architecture, never from GitHub's answer.
    const file = `glosa-${outcome.version}-${context.arch ?? "x64"}.pacman`;
    return {
      type: "info",
      message: `glosa ${outcome.version} is available. You have ${context.current}.`,
      detail: `pacman installed this copy of glosa, so pacman updates it. Download ${file} from the release page, then run the command Copy Install Command copies, from the folder you saved it to.`,
      buttons: ["Open Release Page", "Copy Install Command", "Later"],
      defaultId: 0,
      cancelId: 2,
      actions: [
        { open: `${releases}/tag/${encodeURIComponent(outcome.tag)}` },
        { copy: `sudo pacman -U ./${file}` },
        null,
      ],
    };
  }
  if (outcome.kind === "newer" && channel === "download") {
    return {
      type: "info",
      message: `glosa ${outcome.version} is available. You have ${context.current}.`,
      detail: "Download it from the release page.",
      buttons: ["Open Release Page", "Later"],
      defaultId: 0,
      cancelId: 1,
      actions: [{ open: `${releases}/tag/${encodeURIComponent(outcome.tag)}` }, null],
    };
  }
  if (outcome.kind === "newer") {
    return {
      type: "info",
      message: `glosa ${outcome.version} is available. You have ${context.current}.`,
      detail: `Installed with Homebrew? Copy Upgrade Command copies ${UPGRADE_COMMAND} for a terminal. Otherwise, download it from the release page.`,
      buttons: ["Open Release Page", "Copy Upgrade Command", "Later"],
      defaultId: 0,
      cancelId: 2,
      actions: [{ open: `${releases}/tag/${encodeURIComponent(outcome.tag)}` }, { copy: UPGRADE_COMMAND }, null],
    };
  }
  if (outcome.kind === "current") {
    return {
      type: "info",
      message: `glosa ${context.current} is the newest version.`,
      detail: "",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      actions: [null],
    };
  }
  return {
    type: "warning",
    message: "The update check could not complete.",
    detail: `${outcome.reason}. The release page lists every version.`,
    buttons: ["Open Release Page", "Close"],
    defaultId: 0,
    cancelId: 1,
    actions: [{ open: releases }, null],
  };
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

// ---------- desk browser tabs (#440) ----------
//
// A desk window hosts web pages as `<webview>` guests inside its dock (docs/research/2026-09-29-
// browser-tab-rendering.md). Every guest runs in one persistent partition of its own, with its own
// request policy; the SPA's session, its egress gate and its CSP are untouched (A3 §4b).

/** The one saved cookie and storage store every desk browser tab shares, across workspaces and
 * relaunches (maintainer decision 2026-09-28). Never the SPA's default session: that one holds the
 * pairing credential in the SPA origin's storage. */
export const BROWSER_PARTITION = "persist:glosa-browser";

/** What a page in a browser tab may request: the web (http, https and their sockets) and what never
 * leaves the process. Never a file, a custom scheme, or a daemon port on this machine: `glosaPorts`
 * holds each open window's SPA port and the class-F port beside it, on every loopback name. */
export function browserRequestDecision(url: string, glosaPorts: readonly number[]): "allow" | "cancel" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "cancel";
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return "allow";
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return "cancel";
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const loopback = isLoopbackHost(parsed.hostname) || hostname === "::1" || /^127\./.test(hostname);
  const port = Number(parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80));
  return loopback && glosaPorts.includes(port) ? "cancel" : "allow";
}

/** Where a page in a browser tab may take its tab: a web address or a blank page, nothing else. */
export function browserNavigationDecision(url: string): "allow" | "deny" {
  if (url === "about:blank") return "allow";
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? "allow" : "deny";
  } catch {
    return "deny";
  }
}

/** Whether a window may attach a browser tab: a desk window, from its SPA frame, for a web address
 * or a blank page. A companion window never gets one (maintainer decision 2026-09-28). */
export function webviewAttachDecision(input: {
  kind: "desk" | "companion" | null | undefined;
  frameOrigin: unknown;
  spaOrigin: string | null | undefined;
  src: string;
}): "allow" | "deny" {
  if (input.kind !== "desk") return "deny";
  if (typeof input.spaOrigin !== "string" || input.spaOrigin === "" || input.frameOrigin !== input.spaOrigin) {
    return "deny";
  }
  return browserNavigationDecision(input.src) === "allow" ? "allow" : "deny";
}

/** Rewrites a guest's preferences before it attaches, whatever the page asked for: the browser
 * partition, no preload, sandboxed, isolated, no Node, web security on. Mutates, because Electron
 * reads the object it passed to `will-attach-webview`. */
export function lockGuestPreferences(prefs: Record<string, unknown>): void {
  for (const key of ["preload", "preloadURL", "enableBlinkFeatures", "additionalArguments"]) delete prefs[key];
  Object.assign(prefs, {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  });
}

/** The user agent a browser tab sends: the Chromium one without Electron's or glosa's product
 * tokens, so no site learns that glosa, or which version of it, is asking (invariant 5 keeps glosa
 * from beaconing its version). */
export function browserUserAgent(fallback: string): string {
  return fallback
    .replace(/\s(?:glosadev|glosa|Electron)\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** What a key pressed inside a browser tab does. The page gets it unless it is one of glosa's own
 * chords: reload, back and forward act on the page from here; the rest go to the SPA ("app"), so
 * ⌘W, ⌘K, ⌘T, ⌘L and tab cycling work the same with a page focused. `mod` is ⌘ on macOS, Ctrl
 * elsewhere. */
export function browserKeyAction(
  input: { type: string; key: string; meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean },
  platform: NodeJS.Platform = process.platform,
): "reload" | "back" | "forward" | "app" | null {
  if (input.type !== "keyDown") return null;
  const mod = platform === "darwin" ? Boolean(input.meta) : Boolean(input.control);
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (input.control && !input.meta && !input.alt && key === "Tab") return "app";
  if (!mod) return null;
  if (input.alt) return key === "ArrowLeft" || key === "ArrowRight" ? "app" : null;
  if (key === "r") return "reload";
  if (key === "[" && !input.shift) return "back";
  if (key === "]" && !input.shift) return "forward";
  if (key === "\\") return "app";
  if (!input.shift && ["w", "k", "t", "l"].includes(key)) return "app";
  return null;
}

/** Whether "Open in your browser" (and a link that belongs outside glosa) may leave for the
 * system's handler: web addresses and mail links only, never a file or an app's own scheme. */
export function externalLinkDecision(url: unknown): "open" | "refuse" {
  if (typeof url !== "string" || url.length > 8192) return "refuse";
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? "open" : "refuse";
  } catch {
    return "refuse";
  }
}

/** The permissions a page is refused out loud, as words for the notice under the address row. Every
 * other permission is refused quietly: pages ask for some of them all the time, and a notice for
 * each would be noise. */
export function permissionNotice(permission: string): string | null {
  const words: Record<string, string> = {
    media: "your camera or microphone",
    geolocation: "your location",
    notifications: "to show notifications",
    "clipboard-read": "to read your clipboard",
    midi: "your MIDI devices",
    midiSysex: "your MIDI devices",
    openExternal: "to open another app",
    hid: "a connected device",
    serial: "a connected device",
    usb: "a connected device",
    "display-capture": "to record your screen",
  };
  return words[permission] ?? null;
}

/** A download a page started, as the SPA's notice names it: the file's own name, cut to a length a
 * notice can hold, never a path. */
export function downloadName(name: unknown): string {
  const base = typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  // Control characters out, so a name cannot break the notice's line.
  const clean = Array.from(base)
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (!clean) return "a file";
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}

/** One row of a page's right-click menu, before Electron builds it. `action` names what the main
 * process does; `role` is Electron's own edit role. */
export type BrowserMenuItem =
  | { label: string; action: "open-link-in-tab" | "open-link-outside" | "copy-link" | "back" | "forward" | "reload" }
  | { role: "cut" | "copy" | "paste" | "selectAll" }
  | { type: "separator" };

/** The right-click menu of a page in a browser tab: link actions over a link, editing over a field
 * or a selection, and the page's own back, forward and reload. */
export function browserContextMenu(params: {
  linkURL?: string;
  selectionText?: string;
  isEditable?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}): BrowserMenuItem[] {
  const items: BrowserMenuItem[] = [];
  if (params.linkURL && browserNavigationDecision(params.linkURL) === "allow" && params.linkURL !== "about:blank") {
    items.push(
      { label: "Open Link in New Browser Tab", action: "open-link-in-tab" },
      { label: "Open Link in Your Browser", action: "open-link-outside" },
      { label: "Copy Link Address", action: "copy-link" },
      { type: "separator" },
    );
  }
  if (params.isEditable) {
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { type: "separator" });
  } else if (params.selectionText) {
    items.push({ role: "copy" }, { type: "separator" });
  }
  if (params.canGoBack) items.push({ label: "Back", action: "back" });
  if (params.canGoForward) items.push({ label: "Forward", action: "forward" });
  items.push({ label: "Reload", action: "reload" });
  return items;
}

/** The most an agent's read of a browser tab returns, in characters (#440, brief: 100 KB of text). */
export const BROWSER_READ_MAX = 100_000;

/** Run in an isolated world of the page (Electron `executeJavaScriptInIsolatedWorld`), which shares
 * the page's DOM but none of its JavaScript, so the page's own scripts cannot change what is read. */
export const BROWSER_READ_SCRIPT =
  "(() => ({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' }))()";

/** What an agent's read of a browser tab returns: the page's address, title and visible text, cut at
 * `maxChars` (at least 1,000, at most `BROWSER_READ_MAX`) with a line saying so. Null when what came
 * back from the page is not that shape. */
export function browserReadResult(
  raw: unknown,
  maxChars: unknown,
): { url: string; title: string; text: string; truncated: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const { url, title, text } = raw as Record<string, unknown>;
  if (typeof url !== "string" || typeof title !== "string" || typeof text !== "string") return null;
  const asked = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.floor(maxChars) : BROWSER_READ_MAX;
  const cap = Math.max(1000, Math.min(BROWSER_READ_MAX, asked));
  const truncated = text.length > cap;
  return {
    url: url.slice(0, 8192),
    title: title.slice(0, 1024),
    text: truncated ? `${text.slice(0, cap)}\n\n[glosa cut the page's text at ${cap} characters.]` : text,
    truncated,
  };
}

/** The real-Electron suite may run without native UI, but a packaged app always shows its windows. */
export function hiddenMode(state: { packaged: boolean; value: string | undefined }): boolean {
  return !state.packaged && state.value === "yes";
}
