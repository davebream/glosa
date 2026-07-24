// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa update` (A6 §F26). The ONE documented exception to invariant 5's "zero
// external runtime calls": explicitly invoked only, never a background or passive check, and it
// sends no identifying data (static User-Agent, no version beacon, no cache file that could become
// a heartbeat).
//
// HARD RULE: static imports only. The package directory is replaced underneath this process while
// the installer runs, so a lazy `await import(...)` on the post-spawn path can hit a file that no
// longer exists. Do not copy index.ts's mid-handler `await import` pattern here.
import { isEphemeralPackageRunnerPath } from "./init.ts";
import type { CommandWarning } from "./envelope.ts";

const PKG = "@davebream/glosa";

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
