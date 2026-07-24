// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa update` (A6 §F26). The ONE documented exception to invariant 5's "zero
// external runtime calls": explicitly invoked only, never a background or passive check, and it
// sends no identifying data (static User-Agent, no version beacon, no cache file that could become
// a heartbeat).
//
// HARD RULE: static imports only. The package directory is replaced underneath this process while
// the installer runs, so a lazy `await import(...)` on the post-spawn path can hit a file that no
// longer exists. Do not copy index.ts's mid-handler `await import` pattern here.
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonLock, glosaHome, isPidAlive, lockPath, readLock } from "../../daemon/src/index.ts";
import {
  type CommandEnvelope,
  type CommandError,
  type CommandWarning,
  EXIT_CODES,
  printJsonEnvelope,
} from "./envelope.ts";
import { isEphemeralPackageRunnerPath } from "./init.ts";
import { CLI_VERSION } from "./version.ts";

const PKG = "@davebream/glosa";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// Install classification
// ---------------------------------------------------------------------------------------------

export type InstallKind =
  | "bun-global"
  | "npm-global"
  | "ephemeral"
  | "source-checkout"
  | "project-local"
  | "volta"
  | "pnpm"
  | "yarn"
  | "unknown";

export interface InstallClassification {
  kind: InstallKind;
  /** True only for kinds we can actually upgrade. */
  managed: boolean;
  /** bun-global: the `install/global` dir to pin via BUN_INSTALL_GLOBAL_DIR.
   *  npm-global: the `--prefix` value (NOT the lib dir). Null for refused kinds. */
  installDir: string | null;
  /** Exact copy-pasteable command for a refused kind; null when managed. */
  manualCommand: string | null;
  /** Appended to the output when the install lives behind a version-manager shim. */
  reshimHint: string | null;
}

function norm(p: string): string {
  return p.replaceAll("\\", "/");
}

/** Pure over its arguments — zero filesystem access, so every branch is a table test.
 *  `hasGitMarker` is passed in (the caller does the `pathExists` check) for the same reason.
 *
 *  Takes ONE path, not two. Bun's `import.meta.url` is already symlink-resolved — measured through
 *  a module symlink AND a symlinked ancestor — so a `logical` vs `realpath` comparison could never
 *  differ and would be dead code. A `bun link`ed dev copy therefore arrives here as the checkout
 *  root itself, which carries no package-path suffix and falls through to `unknown`; the caller's
 *  `.git` probe is what promotes it to `source-checkout`. */
export function classifyInstall(packagePath: string, hasGitMarker = false): InstallClassification {
  const p = norm(packagePath);

  const refuse = (kind: InstallKind, manualCommand: string): InstallClassification => ({
    kind,
    managed: false,
    installDir: null,
    manualCommand,
    reshimHint: null,
  });

  // ORDER IS LOAD-BEARING.
  // 1. A .git marker beats everything: whatever the path looks like, we are inside a developer's
  //    own tree and must never write over it.
  if (hasGitMarker) return refuse("source-checkout", "git pull && bun install");
  // 2. Ephemeral — a package-runner cache is never upgradeable, whatever else the path resembles.
  if (isEphemeralPackageRunnerPath(p)) return refuse("ephemeral", `bun add --global ${PKG}@alpha`);
  // 3. Volta BEFORE the /lib/node_modules/ marker. Volta's layout matches it, but writing there
  //    bypasses the shim, so a naive classify would report success while `glosa --version` still
  //    printed the old version.
  if (p.includes("/.volta/")) return refuse("volta", `volta install ${PKG}`);
  // 4. pnpm / yarn — refused. Yarn Berry removed `yarn global add` entirely, and pnpm's
  //    content-addressed store is where path-pinned verification is least reliable. These run
  //    before the marker tests because import.meta.url resolves pnpm's symlink farm into the
  //    store, whose path still carries `/pnpm/`.
  if (p.includes("/pnpm/") || p.includes("/.pnpm/")) return refuse("pnpm", `pnpm add --global ${PKG}@alpha`);
  if (p.includes("/.yarn/") || p.includes("/yarn/")) return refuse("yarn", `yarn global add ${PKG}@alpha`);

  const bunSuffix = `/install/global/node_modules/${PKG}`;
  if (p.endsWith(bunSuffix)) {
    return {
      kind: "bun-global",
      managed: true,
      installDir: p.slice(0, p.length - `/node_modules/${PKG}`.length),
      manualCommand: null,
      reshimHint: null,
    };
  }

  const npmSuffix = `/lib/node_modules/${PKG}`;
  if (p.endsWith(npmSuffix)) {
    return {
      kind: "npm-global",
      managed: true,
      installDir: p.slice(0, p.length - npmSuffix.length),
      manualCommand: null,
      reshimHint: p.includes("/.asdf/") ? "asdf reshim nodejs" : p.includes("/mise/installs/") ? "mise reshim" : null,
    };
  }

  if (p.includes(`/node_modules/${PKG}`)) return refuse("project-local", `bun add --global ${PKG}@alpha`);
  return refuse("unknown", `bun add --global ${PKG}@alpha`);
}

// ---------------------------------------------------------------------------------------------
// URL trust boundary
// ---------------------------------------------------------------------------------------------

/** Generic "checked X, here's why not" result. Named for the shape, not for URLs, because
 *  `verifyIntegrity` reuses it. `reason` is prose for a human — the caller wraps it into a
 *  `CommandError` with a code, a kind, and a hint; `reason` alone is never a complete envelope. */
export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** WHATWG `hostname` already lowercases and punycode-encodes; a single trailing dot is
 *  DNS-equivalent and is the only normalization applied on top. */
function canonicalHost(u: URL): string {
  return u.hostname.endsWith(".") ? u.hostname.slice(0, -1) : u.hostname;
}

function effectivePort(u: URL): string {
  return u.port === "" ? (u.protocol === "https:" ? "443" : "80") : u.port;
}

/** https-only, no exceptions — not even loopback. Tests drive the injected `fetchPackument` seam
 *  rather than a real listener, so a plaintext carve-out would buy nothing and would be reachable
 *  from the user-facing `--registry` flag and `GLOSA_UPDATE_REGISTRY`. */
export function parseRegistryUrl(raw: string): Checked<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid URL` };
  }
  if (u.protocol !== "https:") {
    return {
      ok: false,
      reason: `registry must be https: (got '${u.protocol}//'); glosa installs and executes what this URL serves`,
    };
  }
  if (u.username !== "" || u.password !== "") {
    return { ok: false, reason: "registry URL must not embed credentials" };
  }
  return { ok: true, value: u };
}

const TARBALL_PATH = /^(?:.*\/)?@davebream\/glosa\/-\/glosa-(.+)\.tgz$/;

/** Origin-pins to the CONFIGURED registry — never `res.url`, so a cross-origin redirect on the
 *  packument request cannot move the target. Also asserts the path names this exact package and
 *  version, so a tampered packument on the correct host cannot point somewhere unexpected.
 *  Comparison is always via the URL parser, never string containment: `includes`/`startsWith` are
 *  bypassable with a suffix domain (`registry.npmjs.org.evil.com`) or userinfo
 *  (`registry.npmjs.org@evil.com`, where the host is actually `evil.com`). */
export function validateTarballUrl(
  raw: string,
  registry: string,
  expectedVersion: string,
  allowOffsite: boolean,
): Checked<URL> {
  let u: URL;
  let reg: URL;
  try {
    u = new URL(raw);
    reg = new URL(registry);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid tarball URL` };
  }
  // https is required even under --allow-offsite-tarball. The override widens WHERE, never HOW.
  if (u.protocol !== "https:") return { ok: false, reason: `tarball must be https: (got '${u.protocol}//')` };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "tarball URL must not embed credentials" };

  const sameOrigin = canonicalHost(u) === canonicalHost(reg) && effectivePort(u) === effectivePort(reg);
  if (!sameOrigin && !allowOffsite) {
    return { ok: false, reason: `tarball origin ${u.origin} does not match the configured registry ${reg.origin}` };
  }
  // `new URL` has already resolved `..` out of the path, so a traversal attempt fails this shape test.
  const m = TARBALL_PATH.exec(u.pathname);
  if (!m) return { ok: false, reason: `tarball path '${u.pathname}' is not a ${PKG} tarball` };
  if (m[1] !== expectedVersion) {
    return { ok: false, reason: `tarball path names version ${m[1]}, but the registry resolved ${expectedVersion}` };
  }
  return { ok: true, value: u };
}

// ---------------------------------------------------------------------------------------------
// Redaction (A3 §61 — this is the first implementation of that convention in the repo)
// ---------------------------------------------------------------------------------------------

// Ordering matters: the specific key= and header forms run before the generic token-shaped
// catch-all so the output still names what was scrubbed.
const REDACTIONS: Array<readonly [RegExp, string]> = [
  [/(\/\/)[^/\s:@]*:[^@/\s]*@/g, "$1[redacted]@"], // URL userinfo
  [/((?:_authToken|_auth|_password|token|password)\s*[=:]\s*)\S+/gi, "$1[redacted]"], // npmrc keys
  [/^(\s*authorization\s*:\s*).*$/gim, "$1[redacted]"], // header echo
  [/[A-Za-z0-9_-]{32,}/g, "[redacted]"], // A3 §61 token-shaped catch-all
];

export function redact(text: string): string {
  return REDACTIONS.reduce((s, [re, to]) => s.replace(re, to), text);
}

/** Chunk-boundary-safe: holds a partial trailing line until the next chunk or `flush()`, so a
 *  credential split across two spawn chunks can never slip past `redact`. A plain regex over each
 *  raw chunk would let `"...:_authTok" + "en=secret\n"` through untouched. */
export function createLineRedactor(sink: (s: string) => void): { push(chunk: string): void; flush(): void } {
  const MAX_PENDING = 8192;
  const KEEP_TAIL = 256; // longer than any credential we redact, so a forced flush can't split one
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
        sink(`${redact(pending.slice(0, nl))}\n`);
        pending = pending.slice(nl + 1);
      }
      if (pending.length > MAX_PENDING) {
        sink(redact(pending.slice(0, -KEEP_TAIL)));
        pending = pending.slice(-KEEP_TAIL);
      }
    },
    flush() {
      if (pending === "") return;
      sink(redact(pending));
      pending = "";
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Release resolution and the comparison decision
// ---------------------------------------------------------------------------------------------

/** The running version's prerelease identifier (`alpha` for `0.1.0-alpha.2`), else `latest`. */
export function deriveChannel(currentVersion: string): string {
  const dash = currentVersion.indexOf("-");
  if (dash === -1) return "latest";
  const id = currentVersion.slice(dash + 1).split(".")[0];
  return id && id.length > 0 ? id : "latest";
}

export type TargetResolution =
  | { ok: true; version: string; tarball: string; integrity: string | null; latest: string | null }
  | {
      ok: false;
      code: "update-unknown-channel" | "update-unknown-version" | "registry-inconsistent";
      message: string;
      availableTags?: string[];
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function resolveTarget(packument: unknown, want: { channel: string } | { version: string }): TargetResolution {
  if (!isRecord(packument)) {
    return { ok: false, code: "registry-inconsistent", message: "registry response is not a package document" };
  }
  const tags = isRecord(packument["dist-tags"]) ? (packument["dist-tags"] as Record<string, unknown>) : {};
  const versions = isRecord(packument.versions) ? (packument.versions as Record<string, unknown>) : {};
  const latestRaw = tags.latest;
  const latest = typeof latestRaw === "string" ? latestRaw : null;

  let version: string;
  if ("version" in want) {
    if (!(want.version in versions)) {
      return {
        ok: false,
        code: "update-unknown-version",
        message: `version ${want.version} is not published`,
        availableTags: Object.keys(tags).sort(),
      };
    }
    version = want.version;
  } else {
    const tagged = tags[want.channel];
    if (typeof tagged !== "string") {
      return {
        ok: false,
        code: "update-unknown-channel",
        message: `unknown release channel '${want.channel}'`,
        availableTags: Object.keys(tags).sort(),
      };
    }
    version = tagged;
    if (!(version in versions)) {
      // A real post-`npm unpublish` state: the tag survives, the version does not.
      return {
        ok: false,
        code: "registry-inconsistent",
        message: `channel '${want.channel}' points at ${version}, which the registry does not serve`,
      };
    }
  }

  // Validate before this string can reach a comparator or an argv — the build-id.ts:56 idiom.
  if (!Bun.semver.satisfies(version, version)) {
    return { ok: false, code: "registry-inconsistent", message: `registry published an invalid version: ${version}` };
  }

  const entry = versions[version];
  const dist = isRecord(entry) && isRecord(entry.dist) ? (entry.dist as Record<string, unknown>) : null;
  const tarball = dist && typeof dist.tarball === "string" ? dist.tarball : null;
  if (!tarball) {
    return { ok: false, code: "registry-inconsistent", message: `version ${version} has no dist.tarball` };
  }
  return {
    ok: true,
    version,
    tarball,
    integrity: dist && typeof dist.integrity === "string" ? dist.integrity : null,
    latest,
  };
}

export interface ActionDecision {
  action: "updated" | "already-current" | "checked" | "downgrade-refused";
  comparison: "newer" | "same" | "older";
  shouldInstall: boolean;
  wouldInstall: boolean;
  updateAvailable: boolean;
  exitCode: number;
  warnings: CommandWarning[];
}

/** `Bun.semver.order` is the repo's existing comparator, already load-bearing for the identical
 *  "is the client newer" decision at lifecycle.ts:409 — `order(a, b) > 0` means a is newer. */
export function decideAction(
  currentVersion: string,
  targetVersion: string,
  opts: { force: boolean; dryRun: boolean; latest?: string | null },
): ActionDecision {
  const order = Bun.semver.order(targetVersion, currentVersion);
  const comparison = order > 0 ? "newer" : order === 0 ? "same" : "older";
  const warnings: CommandWarning[] = [];

  // Always read dist-tags.latest too (already in hand, zero extra requests). Without this a user
  // on a retired alpha line sits at a permanent, confident "up to date" after 0.1.0 ships.
  if (opts.latest && Bun.semver.order(opts.latest, targetVersion) > 0) {
    warnings.push({
      code: "newer-stable-available",
      message: `${opts.latest} is available on the latest channel; run \`glosa update --channel latest\` to move to it`,
    });
  }

  // --force installs the resolved target regardless of comparison: older, equal, OR newer. Equal
  // matters because BUILD_ID is version + content hash, so the same version can carry different
  // bytes and a republished build needs an escape hatch.
  const wouldInstall = opts.force || comparison === "newer";

  if (opts.dryRun) {
    return {
      action: "checked",
      comparison,
      shouldInstall: false,
      wouldInstall,
      updateAvailable: comparison === "newer",
      exitCode: 0,
      warnings,
    };
  }
  if (wouldInstall) {
    return {
      action: "updated",
      comparison,
      shouldInstall: true,
      wouldInstall,
      updateAvailable: comparison === "newer",
      exitCode: 0,
      warnings,
    };
  }
  if (comparison === "older") {
    warnings.push({
      code: "downgrade-refused",
      message: `${targetVersion} is older than the installed ${currentVersion}; re-run with --force to install it anyway`,
    });
    return {
      action: "downgrade-refused",
      comparison,
      shouldInstall: false,
      wouldInstall,
      updateAvailable: false,
      exitCode: 0,
      warnings,
    };
  }
  return {
    action: "already-current",
    comparison,
    shouldInstall: false,
    wouldInstall,
    updateAvailable: false,
    exitCode: 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// The injected seam
// ---------------------------------------------------------------------------------------------

/** Every flag the command accepts, in one place. `json` lives here, not only in the printer,
 *  because `runUpdate` branches on it to choose inherit-vs-piped installer stdio and to suppress
 *  the pre-spawn block. Omitting it from the gunshi handler would make the whole --json path
 *  unreachable in the shipped command while every test of it still passed. */
export interface UpdateOptions {
  json?: boolean;
  quiet?: boolean;
  check?: boolean;
  force?: boolean;
  channel?: string;
  to?: string;
  registry?: string;
  allowOffsiteTarball?: boolean;
}

export type FetchResult =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      kind: "timeout" | "network" | "http" | "malformed" | "too-large";
      status?: number;
      message: string;
    };

export type DownloadResult =
  | {
      ok: true;
      /** ABSOLUTE path. `bun add --global ./rel.tgz` fails with `ENOENT extracting tarball` —
       *  measured. Only an absolute path works. */
      path: string;
      bytes: number;
      /** Base64 sha512 of the bytes actually received, for comparison against dist.integrity. */
      sha512: string;
    }
  | { ok: false; kind: "timeout" | "network" | "http" | "too-large" | "io"; message: string };

export interface UpdateDeps {
  platform: () => NodeJS.Platform;
  /** From `import.meta.url` — already symlink-resolved by Bun. There is deliberately NO `realpath`
   *  dep: it would provably return its own argument. */
  packageRoot: () => string;
  pathExists: (p: string) => boolean;
  /** EACCES preflight. */
  isWritable: (p: string) => boolean;
  env: (name: string) => string | undefined;
  /** The full environment handed to the installer, minus what `buildInstallerEnv` scrubs. */
  envAll: () => Record<string, string | undefined>;
  /** CLI_VERSION, injectable. */
  currentVersion: () => string;
  which: (cmd: string) => string | null;
  /** doctor.ts:38's signature — trimmed stdout, or null if it could not be spawned / exited non-zero. */
  runVersionProbe: (cmd: string[]) => string | null;
  readDaemonLock: () => DaemonLock | null;
  /** Discriminated result, never a raw Response — this is what makes the failure taxonomy testable
   *  without standing up a server. */
  fetchPackument: (url: string, timeoutMs: number) => Promise<FetchResult>;
  downloadTarball: (url: string, timeoutMs: number) => Promise<DownloadResult>;
  cleanupDownload: (path: string) => void;
  /** Full argv + env so a test asserts the exact command line and the ANTHROPIC_API_KEY scrub. */
  spawnInstaller: (
    argv: string[],
    env: Record<string, string | undefined>,
    onOutput: ((chunk: string) => void) | null,
  ) => Promise<{ exitCode: number }>;
  /** The pre-spawn recovery block is emitted mid-run by `runUpdate`, so it needs a stdout writer on
   *  the seam — `printUpdateResult` only runs after `runUpdate` has already returned. */
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  /** Awaited before the spawn so the pre-spawn block survives a terminal killed mid-install. */
  flushStdout: () => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Registry fetch
// ---------------------------------------------------------------------------------------------

const MAX_PACKUMENT_BYTES = 4 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

function isTimeout(err: unknown): boolean {
  const name = (err as Error)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Split out from the `fetch` call so a test can hand it a `Response` directly — in particular to
 *  prove the size cap fires mid-stream instead of after the whole body is buffered. */
export async function readPackumentResponse(res: Response): Promise<FetchResult> {
  if (!res.ok) return { ok: false, kind: "http", status: res.status, message: res.statusText };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, kind: "malformed", message: "registry response had no body" };
  // Stream-and-cap. `await res.text()` would buffer the WHOLE body first and only then check the
  // size, so an unbounded body would OOM the process before the `too-large` branch could run —
  // making that branch unreachable for exactly the input it exists to defend against.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength; // BYTES, not UTF-16 code units
      if (total > MAX_PACKUMENT_BYTES) {
        await reader.cancel();
        return { ok: false, kind: "too-large", message: `registry response exceeded ${MAX_PACKUMENT_BYTES} bytes` };
      }
      chunks.push(value);
    }
  } catch (err) {
    return { ok: false, kind: isTimeout(err) ? "timeout" : "network", message: (err as Error).message };
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  try {
    return { ok: true, status: res.status, body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { ok: false, kind: "malformed", message: "registry response is not JSON" };
  }
}

async function realFetchPackument(url: string, timeoutMs: number): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // Abbreviated packument — a few KB instead of the full multi-MB document.
        accept: "application/vnd.npm.install-v1+json",
        // STATIC user-agent. Never include CLI_VERSION: that would make every update check a
        // version beacon, which the invariant-5 carve-out explicitly forbids.
        "user-agent": "glosa-update",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: isTimeout(err) ? "timeout" : "network", message: (err as Error).message };
  }
  return readPackumentResponse(res);
}

/** Each failure kind gets its own `error.code` — none collapse into a generic "network error".
 *  Exit 70 does NOT imply `kind: "internal"`: a disconnected laptop is a network problem, and
 *  reporting it as an internal glosa error is how a non-bug gets filed as one. */
export function fetchFailureToError(
  f: Extract<FetchResult, { ok: false }>,
  registry: string,
): { exitCode: number; error: CommandError } {
  if (f.kind === "timeout" || f.kind === "network") {
    return {
      exitCode: 70,
      error: {
        code: "registry-unreachable",
        kind: "network",
        message:
          f.kind === "timeout"
            ? `${registry} did not respond within ${REGISTRY_TIMEOUT_MS}ms`
            : `could not reach ${registry}: ${f.message}`,
        hint: "Check your network connection or proxy, then retry. Use --registry to point at a different registry.",
      },
    };
  }
  if (f.kind === "http") {
    const authed = f.status === 401 || f.status === 403;
    return {
      exitCode: 70,
      error: {
        code: "registry-http-error",
        kind: "registry",
        message: authed
          ? `${registry} requires authentication (HTTP ${f.status})`
          : `${registry} returned HTTP ${f.status ?? "?"} ${f.message}`,
        hint: authed
          ? "glosa resolves releases over a plain HTTPS request that deliberately sends no .npmrc credentials. Point --registry at an unauthenticated mirror, or install manually."
          : "Check the --registry value, then retry.",
      },
    };
  }
  return {
    exitCode: 70,
    error: {
      code: "registry-malformed-response",
      kind: "registry",
      message:
        f.kind === "too-large"
          ? `${registry} returned an implausibly large response: ${f.message}`
          : `${registry} did not return a package document: ${f.message}`,
      hint: "A captive portal or proxy error page usually causes this. Confirm you can reach the registry in a browser.",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tarball download + integrity
// ---------------------------------------------------------------------------------------------

/** `dist.integrity` is `sha512-<base64>`. A missing or non-sha512 value is a REFUSAL, never a
 *  pass — the whole point is that the bytes we install are the bytes the registry published.
 *
 *  Not a constant-time comparison, and it does not claim to be: the digest is public, so timing is
 *  not a threat here. */
export function verifyIntegrity(expected: string | null, actualSha512Base64: string): Checked<true> {
  if (!expected) {
    return { ok: false, reason: "registry did not publish a dist.integrity digest for this version" };
  }
  const dash = expected.indexOf("-");
  const algo = dash === -1 ? expected : expected.slice(0, dash);
  const digest = dash === -1 ? "" : expected.slice(dash + 1);
  if (algo !== "sha512") {
    return { ok: false, reason: `dist.integrity uses ${algo}, which glosa does not verify` };
  }
  if (digest.length !== actualSha512Base64.length || digest !== actualSha512Base64) {
    return { ok: false, reason: "downloaded tarball does not match the registry's published sha512" };
  }
  return { ok: true, value: true };
}

async function realDownloadTarball(url: string, timeoutMs: number): Promise<DownloadResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "glosa-update" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: isTimeout(err) ? "timeout" : "network", message: (err as Error).message };
  }
  if (!res.ok) return { ok: false, kind: "http", message: `HTTP ${res.status} ${res.statusText}` };

  // mkdtempSync creates the directory 0700. A fixed path under a world-writable /tmp would let
  // another local user swap the tarball between verification and install (TOCTOU).
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "glosa-update-"));
  } catch (err) {
    return { ok: false, kind: "io", message: (err as Error).message };
  }
  const path = join(dir, `glosa-${Date.now()}.tgz`);
  const hasher = new Bun.CryptoHasher("sha512");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, kind: "network", message: "tarball response had no body" };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TARBALL_BYTES) {
        await reader.cancel();
        rmSync(dir, { recursive: true, force: true });
        return { ok: false, kind: "too-large", message: `tarball exceeded ${MAX_TARBALL_BYTES} bytes` };
      }
      hasher.update(value);
      chunks.push(value);
    }
    await Bun.write(path, new Blob(chunks as BlobPart[]));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, kind: isTimeout(err) ? "timeout" : "network", message: (err as Error).message };
  }
  return { ok: true, path, bytes: total, sha512: hasher.digest("base64") };
}

// ---------------------------------------------------------------------------------------------
// Installer command line
// ---------------------------------------------------------------------------------------------

export function resolvePackageManager(
  c: InstallClassification,
  which: (cmd: string) => string | null,
): { ok: true; path: string } | { ok: false; cmd: string } {
  const cmd = c.kind === "bun-global" ? "bun" : "npm";
  const path = which(cmd);
  return path ? { ok: true, path } : { ok: false, cmd };
}

/** `--prefix=<p>` uses the equals form deliberately: a prefix path beginning with `-` would
 *  otherwise be read by npm's own argv parser as a flag. `--` closes the remaining gap before the
 *  positional. Bun.spawn's array form already prevents shell splitting. */
export function buildInstallerArgv(c: InstallClassification, pmPath: string, tarballPath: string): string[] {
  if (c.kind === "bun-global") return [pmPath, "add", "--global", "--", tarballPath];
  return [pmPath, "install", "--global", `--prefix=${c.installDir}`, "--", tarballPath];
}

/** Process env minus ANTHROPIC_API_KEY (invariant 5; lifecycle.ts:568's buildChildEnv is the
 *  precedent) plus only the prefix pin. Deliberately NOT scrubbing npm_config_registry /
 *  BUN_CONFIG_REGISTRY: a corporate mirror is usually intentional, and installing from a verified
 *  local file already bypasses registry redirection for glosa itself. */
export function buildInstallerEnv(
  base: Record<string, string | undefined>,
  c: InstallClassification,
): Record<string, string | undefined> {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  // BUN_INSTALL_GLOBAL_DIR, not BUN_INSTALL: bun honors the former in preference to
  // BUN_INSTALL-derived defaults, so pinning it survives a user who already sets either. Note it
  // pins the PACKAGE dir only — the bin symlink still follows BUN_INSTALL, which is what we want
  // for a real upgrade and is why `binPathFor` derives the two differently.
  if (c.kind === "bun-global" && c.installDir) env.BUN_INSTALL_GLOBAL_DIR = c.installDir;
  return env;
}

async function realSpawnInstaller(
  argv: string[],
  env: Record<string, string | undefined>,
  onOutput: ((chunk: string) => void) | null,
): Promise<{ exitCode: number }> {
  if (!onOutput) {
    // Human mode: the installer owns the TTY so its progress bars show.
    const proc = Bun.spawn({ cmd: argv, env, stdio: ["inherit", "inherit", "inherit"] });
    return { exitCode: await proc.exited };
  }
  const proc = Bun.spawn({ cmd: argv, env, stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  // Read BOTH streams: npm writes progress to stdout, so forwarding only stderr would lose the
  // progress the forwarding exists to provide.
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    for await (const chunk of stream) onOutput(decoder.decode(chunk, { stream: true }));
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  return { exitCode: await proc.exited };
}

// ---------------------------------------------------------------------------------------------
// Verification: probe the installed binary
// ---------------------------------------------------------------------------------------------

/** NOT `join(installDir, "bin", "glosa")` for both kinds — that is wrong for bun and would make
 *  the fallback probe always fail. bun's PACKAGE dir is BUN_INSTALL_GLOBAL_DIR
 *  (`~/.bun/install/global`) while its BIN dir follows BUN_INSTALL (`~/.bun/bin`). Verified. */
export function binPathFor(c: InstallClassification): string | null {
  if (!c.installDir) return null;
  if (c.kind === "bun-global") {
    const suffix = "/install/global";
    const root = c.installDir.endsWith(suffix) ? c.installDir.slice(0, -suffix.length) : c.installDir;
    return join(root, "bin", "glosa");
  }
  return join(c.installDir, "bin", "glosa");
}

export interface ProbeInterpretation {
  matched: boolean | null;
  reportedVersion: string | null;
  path: string;
  exitCode: number;
  code?: "update-unverified" | "update-unverified-probe-failed";
  message?: string;
  hint?: string;
}

/** `runVersionProbe` returns null both when the binary is missing AND when it exits non-zero, so
 *  "probe returned null" must NOT be reported as a version mismatch we never observed. Two codes,
 *  same exit 9. Output is parsed, not string-compared: index.ts:810 renders `glosa <version>`. */
export function interpretProbe(output: string | null, target: string, path: string): ProbeInterpretation {
  const m = output === null ? null : /^glosa\s+(\S+)$/m.exec(output.trim());
  if (!m || !Bun.semver.satisfies(m[1] as string, m[1] as string)) {
    return {
      matched: null,
      reportedVersion: null,
      path,
      exitCode: 9,
      code: "update-unverified-probe-failed",
      message: `the installer reported success, but \`${path} --version\` produced no usable version`,
      hint: `The install directory may not be on your PATH. Run \`${path} --version\` yourself to check.`,
    };
  }
  const reported = m[1] as string;
  if (reported === target) return { matched: true, reportedVersion: reported, path, exitCode: 0 };
  return {
    matched: false,
    reportedVersion: reported,
    path,
    exitCode: 9,
    code: "update-unverified",
    message: `installed ${target}, but ${path} still reports ${reported}`,
    hint: "Another glosa earlier on your PATH is shadowing the upgraded one. Note that a shell alias or function cannot be detected here — check with `type glosa`.",
  };
}

/** A lock file is not liveness: `readLock` returns any parseable file, and a crashed daemon leaves
 *  one behind. Without the `isPidAlive` gate, `daemon_running` is true for a dead daemon and — far
 *  worse — the forced-downgrade path prints `kill <pid>` for a pid the OS may have recycled. */
export function readDaemonLockWith(read: () => DaemonLock | null, alive: (pid: number) => boolean): DaemonLock | null {
  const lock = read();
  if (!lock) return null;
  return alive(lock.pid) ? lock : null;
}

export function realUpdateDeps(): UpdateDeps {
  return {
    platform: () => process.platform,
    packageRoot: () => join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    pathExists: (p) => {
      try {
        accessSync(p, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    isWritable: (p) => {
      try {
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    env: (name) => Bun.env[name],
    envAll: () => ({ ...Bun.env }),
    currentVersion: () => CLI_VERSION,
    which: (cmd) => Bun.which(cmd, { PATH: Bun.env.PATH ?? "" }),
    runVersionProbe: (cmd) => {
      try {
        const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
        if (!proc.success) return null;
        return proc.stdout.toString("utf8").trim();
      } catch {
        return null;
      }
    },
    // NEVER ensureDaemon() — that would start a daemon as a side effect of asking whether one runs.
    readDaemonLock: () => readDaemonLockWith(() => readLock(lockPath(glosaHome())), isPidAlive),
    fetchPackument: realFetchPackument,
    downloadTarball: realDownloadTarball,
    cleanupDownload: (p) => {
      try {
        rmSync(dirname(p), { recursive: true, force: true });
      } catch {
        /* best effort — a leftover temp dir is not worth failing an otherwise-successful update */
      }
    },
    spawnInstaller: realSpawnInstaller,
    writeStdout: (s) => {
      process.stdout.write(s);
    },
    writeStderr: (s) => {
      process.stderr.write(s);
    },
    flushStdout: () => new Promise((resolve) => process.stdout.write("", () => resolve())),
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface UpdateData {
  action: "updated" | "already-current" | "checked" | "downgrade-refused" | "refused";
  update_available: boolean;
  current_version: string;
  target_version: string | null;
  latest_version: string | null;
  comparison: "newer" | "same" | "older" | null;
  channel: string | null;
  channel_source: "flag" | "env" | "derived" | "default" | null;
  /** Nullable: the platform and argv gates run BEFORE classification, so those envelopes have no
   *  honest kind to report. Never fabricate "unknown" there — "unknown" is a real classification
   *  result meaning "we looked and did not recognize this layout". */
  install_kind: InstallKind | null;
  install_dir: string | null;
  registry: string | null;
  tarball_url: string | null;
  integrity_verified: boolean;
  dry_run: boolean;
  would_install: boolean;
  daemon_running: boolean;
  daemon_pid: number | null;
  installer_exit_code: number | null;
  probe: { path: string; reported_version: string | null; matched: boolean | null } | null;
  manual_command: string | null;
}

function emptyData(currentVersion: string, dryRun: boolean): UpdateData {
  return {
    action: "refused",
    update_available: false,
    current_version: currentVersion,
    target_version: null,
    latest_version: null,
    comparison: null,
    channel: null,
    channel_source: null,
    install_kind: null,
    install_dir: null,
    registry: null,
    tarball_url: null,
    integrity_verified: false,
    dry_run: dryRun,
    would_install: false,
    daemon_running: false,
    daemon_pid: null,
    installer_exit_code: null,
    probe: null,
    manual_command: null,
  };
}

function fail(
  data: UpdateData,
  warnings: CommandWarning[],
  exitCode: number,
  error: CommandError,
): CommandEnvelope<UpdateData> {
  return { ok: false, command: "update", exitCode, data, warnings, error };
}

/** The pre-spawn block: printed and flushed BEFORE the installer runs, because a failed install
 *  partway through 115 transitive dependencies can leave the user with no working `glosa` AND no
 *  working `glosa update`. It has to survive a terminal that scrolls and a process killed mid-swap. */
export function formatPreSpawnBlock(data: UpdateData, recoveryCommand: string): string {
  const lines = [
    `glosa update: ${data.current_version} → ${data.target_version} (${data.install_kind})`,
    `  install dir: ${data.install_dir}`,
    `  tarball:     ${data.tarball_url}`,
    `  verified:    sha512 matches the registry's published digest`,
    "",
    "If this install fails partway through, recover with:",
    `  ${recoveryCommand}`,
  ];
  if (data.daemon_running && data.daemon_pid !== null) {
    lines.push("", `A glosa daemon is running (pid ${data.daemon_pid}). Run \`glosa open\` afterwards to restart it.`);
    if (data.comparison === "older") {
      // A newer daemon is never downgraded by design (lifecycle.ts:414, A6:52 -> exit 10), and
      // there is no `glosa stop`, so after a forced downgrade the daemon is un-restartable and the
      // user's only recovery is a pid they were never shown.
      lines.push(
        "You are installing an OLDER version. The running daemon will refuse to be replaced by it;",
        `stop it first with:  kill ${data.daemon_pid}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps): Promise<CommandEnvelope<UpdateData>> {
  const currentVersion = deps.currentVersion();
  const dryRun = Boolean(opts.check);
  const data = emptyData(currentVersion, dryRun);
  const warnings: CommandWarning[] = [];

  // ---- 1. platform (exit 5), before anything can touch the network -------------------------
  if (deps.platform() !== "darwin") {
    return fail(data, warnings, EXIT_CODES.PLATFORM_UNSUPPORTED, {
      code: "platform-unsupported",
      kind: "platform",
      message: `${deps.platform()} is not supported — glosa v1 is macOS-only`,
      hint: "See A6 §F30. Linux and Windows are out of scope for v1.",
    });
  }

  // ---- 2. argv validation (exit 2), still before the network --------------------------------
  if (opts.to !== undefined && opts.channel !== undefined) {
    return fail(data, warnings, EXIT_CODES.USAGE, {
      code: "usage",
      kind: "usage",
      message: "--to and --channel are mutually exclusive",
      hint: "Use --to to pin an exact version, or --channel to follow a release tag.",
    });
  }
  const registryFromFlag = opts.registry;
  const registryFromEnv = deps.env("GLOSA_UPDATE_REGISTRY");
  const registryRaw = registryFromFlag ?? registryFromEnv ?? DEFAULT_REGISTRY;
  const usingDefaultRegistry = registryFromFlag === undefined && registryFromEnv === undefined;
  // --allow-offsite-tarball is a security downgrade, so it must never be reachable from the
  // environment, and it must not be usable while still pointed at the default registry: that
  // combination cannot distinguish "expected corporate mirror rewrite" from "the default
  // registry's response was tampered with".
  if (opts.allowOffsiteTarball && usingDefaultRegistry) {
    return fail(data, warnings, EXIT_CODES.USAGE, {
      code: "update-suspicious-flag-combo",
      kind: "usage",
      message: "--allow-offsite-tarball has no legitimate use against the default registry",
      hint: "Pair it with an explicit --registry (or GLOSA_UPDATE_REGISTRY) naming the mirror you expect to serve the tarball.",
    });
  }
  const parsedRegistry = parseRegistryUrl(registryRaw);
  if (!parsedRegistry.ok) {
    return fail(data, warnings, EXIT_CODES.USAGE, {
      code: "update-invalid-registry",
      kind: "usage",
      message: parsedRegistry.reason,
      hint: "glosa installs and executes whatever this URL serves, so only https: is accepted.",
    });
  }
  data.registry = parsedRegistry.value.origin;

  // ---- 3. install classification (exit 2), still before the network -------------------------
  const root = deps.packageRoot();
  const classification = classifyInstall(root, deps.pathExists(join(root, ".git")));
  data.install_kind = classification.kind;
  data.install_dir = classification.installDir;
  data.manual_command = classification.manualCommand;
  if (!classification.managed) {
    return fail(data, warnings, EXIT_CODES.USAGE, {
      code: "update-unmanaged-install",
      kind: "usage",
      message: `this glosa install (${classification.kind}) cannot upgrade itself`,
      hint: `Upgrade it manually: ${classification.manualCommand}`,
    });
  }
  if (classification.reshimHint) {
    warnings.push({
      code: "reshim-required",
      message: `This install sits behind a version-manager shim — run \`${classification.reshimHint}\` after the update.`,
    });
  }

  // ---- 4. resolve the release over the network (exit 70) ------------------------------------
  const channelSource: UpdateData["channel_source"] =
    opts.to !== undefined ? null : opts.channel !== undefined ? "flag" : "derived";
  const channel = opts.to !== undefined ? null : (opts.channel ?? deriveChannel(currentVersion));
  data.channel = channel;
  data.channel_source = channelSource;

  const packumentUrl = `${parsedRegistry.value.origin}${parsedRegistry.value.pathname.replace(/\/$/, "")}/${PKG}`;
  const fetched = await deps.fetchPackument(packumentUrl, REGISTRY_TIMEOUT_MS);
  if (!fetched.ok) {
    const { exitCode, error } = fetchFailureToError(fetched, data.registry);
    return fail(data, warnings, exitCode, error);
  }

  const resolved = resolveTarget(fetched.body, opts.to !== undefined ? { version: opts.to } : { channel: channel as string });
  if (!resolved.ok) {
    const isUsage = resolved.code === "update-unknown-channel" || resolved.code === "update-unknown-version";
    const tagList = resolved.availableTags?.length ? ` Available channels: ${resolved.availableTags.join(", ")}.` : "";
    return fail(data, warnings, isUsage ? EXIT_CODES.USAGE : EXIT_CODES.INTERNAL, {
      code: resolved.code,
      kind: isUsage ? "usage" : "registry",
      message: resolved.message,
      hint: isUsage
        ? `Pick a published target.${tagList}`
        : "The registry's dist-tags and published versions disagree — this usually follows an `npm unpublish`. Retry later or pin an exact version with --to.",
    });
  }
  data.target_version = resolved.version;
  data.latest_version = resolved.latest;

  const tarball = validateTarballUrl(resolved.tarball, data.registry, resolved.version, Boolean(opts.allowOffsiteTarball));
  if (!tarball.ok) {
    return fail(data, warnings, EXIT_CODES.INTERNAL, {
      code: "update-offsite-tarball-refused",
      kind: "integrity",
      message: tarball.reason,
      hint: "If this registry is a mirror that legitimately rewrites tarball URLs, re-run with --allow-offsite-tarball.",
    });
  }
  data.tarball_url = tarball.value.toString();

  // ---- 5. decide (exit 0 for every outcome) -------------------------------------------------
  const decision = decideAction(currentVersion, resolved.version, {
    force: Boolean(opts.force),
    dryRun,
    latest: resolved.latest,
  });
  data.comparison = decision.comparison;
  data.update_available = decision.updateAvailable;
  data.would_install = decision.wouldInstall;
  warnings.push(...decision.warnings);

  const daemonLock = deps.readDaemonLock();
  data.daemon_running = daemonLock !== null;
  data.daemon_pid = daemonLock?.pid ?? null;

  if (!decision.shouldInstall) {
    data.action = decision.action;
    return { ok: true, command: "update", exitCode: EXIT_CODES.OK, data, warnings };
  }

  // ---- 6. resolve the package manager (exit 70) ---------------------------------------------
  const pm = resolvePackageManager(classification, deps.which);
  if (!pm.ok) {
    return fail(data, warnings, EXIT_CODES.INTERNAL, {
      code: "installer-not-found",
      kind: "environment",
      message: `this is a ${classification.kind} install, but \`${pm.cmd}\` is not on PATH`,
      hint: `Install ${pm.cmd}, or upgrade manually with: ${classification.manualCommand ?? `bun add --global ${PKG}@alpha`}`,
    });
  }

  // ---- 7. EACCES preflight — the most likely npm failure on macOS ---------------------------
  if (classification.kind === "npm-global" && classification.installDir) {
    const libDir = join(classification.installDir, "lib", "node_modules");
    if (!deps.isWritable(libDir)) {
      return fail(data, warnings, EXIT_CODES.INTERNAL, {
        code: "installer-permission-denied",
        kind: "permission",
        message: `${libDir} is not writable`,
        hint: `Either re-run with sudo, or move your npm prefix somewhere you own: npm config set prefix ~/.npm-global`,
      });
    }
  }

  if (daemonLock) {
    warnings.push({
      code: "daemon-restart-required",
      message: `A glosa daemon (pid ${daemonLock.pid}) is running the old build — run \`glosa open\` to restart it.`,
    });
  }

  // ---- 8. pre-spawn block, flushed before anything can replace this process's own files ------
  const recoveryCommand =
    classification.kind === "bun-global"
      ? `bun add --global ${data.tarball_url}`
      : `npm install --global --prefix=${classification.installDir} ${data.tarball_url}`;
  if (!opts.json) {
    deps.writeStdout(formatPreSpawnBlock(data, recoveryCommand));
    await deps.flushStdout();
  }

  // ---- 9. download + verify (exit 70) -------------------------------------------------------
  const downloaded = await deps.downloadTarball(data.tarball_url, DOWNLOAD_TIMEOUT_MS);
  if (!downloaded.ok) {
    return fail(data, warnings, EXIT_CODES.INTERNAL, {
      code: "tarball-download-failed",
      kind: downloaded.kind === "io" ? "internal" : "network",
      message: `could not download ${data.tarball_url}: ${downloaded.message}`,
      hint: "Check your network connection, then retry.",
    });
  }
  try {
    const integrity = verifyIntegrity(resolved.integrity, downloaded.sha512);
    if (!integrity.ok) {
      return fail(data, warnings, EXIT_CODES.INTERNAL, {
        code: "tarball-integrity-mismatch",
        kind: "integrity",
        message: integrity.reason,
        hint: "glosa refused to install these bytes. Retry; if it persists, the registry or the path to it may be compromised.",
      });
    }
    data.integrity_verified = true;

    // ---- 10. spawn the installer (exit 70) --------------------------------------------------
    const env = buildInstallerEnv(deps.envAll(), classification);
    const argv = buildInstallerArgv(classification, pm.path, downloaded.path);
    // In --json mode A6 §F26 allows exactly one JSON object on stdout, but a silent multi-minute
    // wait is unacceptable — so installer output is forwarded to stderr, REDACTED and line-buffered
    // as it arrives (npm echoes the effective registry URL, which frequently carries credentials).
    const redactor = opts.json ? createLineRedactor((s) => deps.writeStderr(s)) : null;
    const { exitCode: installerExit } = await deps.spawnInstaller(argv, env, redactor ? (c) => redactor.push(c) : null);
    redactor?.flush();
    data.installer_exit_code = installerExit;
    if (installerExit !== 0) {
      return fail(data, warnings, EXIT_CODES.INTERNAL, {
        code: "installer-failed",
        kind: "installer",
        message: `${pm.path} exited ${installerExit}`,
        hint: `Recover with: ${recoveryCommand}`,
      });
    }
  } finally {
    deps.cleanupDownload(downloaded.path);
  }

  // ---- 11. verify by probing the installed binary (exit 9) ----------------------------------
  // Execute the truth. Reading <packageRoot>/package.json would prove A DIRECTORY changed, not
  // that the user's `glosa` changed.
  const probePath = deps.which("glosa") ?? binPathFor(classification) ?? "glosa";
  const probe = interpretProbe(deps.runVersionProbe([probePath, "--version"]), resolved.version, probePath);
  data.probe = { path: probe.path, reported_version: probe.reportedVersion, matched: probe.matched };
  if (probe.exitCode !== 0) {
    return fail(data, warnings, EXIT_CODES.DEGRADED, {
      code: probe.code as string,
      kind: "verification",
      message: probe.message as string,
      hint: probe.hint as string,
    });
  }

  data.action = "updated";
  return { ok: true, command: "update", exitCode: EXIT_CODES.OK, data, warnings };
}

export function printUpdateResult(
  result: CommandEnvelope<UpdateData>,
  json: boolean,
  opts: { quiet?: boolean } = {},
): void {
  // --quiet never suppresses the one JSON object.
  if (json) {
    printJsonEnvelope(result);
    return;
  }

  const d = result.data;
  // `--check --quiet` prints ONLY the target version — the no-jq scripting hook, reusing the
  // convention `glosa open --url` already sets (A6:85-87).
  if (opts.quiet && d.dry_run) {
    if (d.update_available && d.target_version) process.stdout.write(`${d.target_version}\n`);
    return;
  }

  if (!result.ok) {
    process.stderr.write(`glosa update: ${result.error?.message ?? "failed"}\n`);
    if (result.error?.hint) process.stderr.write(`${result.error.hint}\n`);
    return;
  }

  if (!opts.quiet) {
    switch (d.action) {
      case "updated":
        process.stdout.write(`glosa update: updated ${d.current_version} → ${d.target_version}\n`);
        break;
      case "already-current":
        process.stdout.write(`glosa update: already on ${d.current_version}\n`);
        break;
      case "checked":
        process.stdout.write(
          d.update_available
            ? `glosa update: ${d.target_version} is available (installed ${d.current_version})\n`
            : `glosa update: already on ${d.current_version}; nothing to install\n`,
        );
        break;
      case "downgrade-refused":
        process.stdout.write(
          `glosa update: refused to downgrade ${d.current_version} → ${d.target_version}; re-run with --force\n`,
        );
        break;
      default:
        break;
    }
    for (const w of result.warnings) process.stdout.write(`glosa update: ${w.message}\n`);
  }
}
