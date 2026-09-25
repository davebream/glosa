// SPDX-License-Identifier: Apache-2.0
// The shell's pure decisions. No Electron, no I/O: every rule the main process enforces is a
// function here so it can be tested without a window, and so the main process stays a thin
// wiring layer. Contracts: docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md
// (R-O1…R-O6, R-P1…R-P5) and docs/research/2026-09-25-desktop-shell-readiness.md §3.

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

/** The A6 JSON envelope `glosa open --url --json` prints. Anything else is a refusal, not a guess. */
export function parseOpenEnvelope(text: string): { url: string; slug: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("glosa open did not print a JSON envelope");
  }
  const env = body as { glosa_json?: unknown; ok?: unknown; data?: { url?: unknown; slug?: unknown }; error?: unknown };
  if (env.glosa_json !== 1) throw new Error("glosa open printed something that is not the A6 envelope");
  if (env.ok !== true) {
    const err = env.error as { code?: unknown; message?: unknown } | null | undefined;
    throw new Error(`glosa open refused: ${String(err?.code ?? "unknown")} ${String(err?.message ?? "")}`.trim());
  }
  if (typeof env.data?.url !== "string" || typeof env.data?.slug !== "string") {
    throw new Error("glosa open envelope has no url");
  }
  return { url: env.data.url, slug: env.data.slug };
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
