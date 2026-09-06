// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — client-side helper for probing `GET /api/handshake` (A5 §F13). This is the
// lifecycle-level handshake (readiness + proto compat), not the SPA-facing auth/contract
// handshake — that's wired in P1.3.
import { connect, createServer } from "node:net";

export interface HandshakeResponse {
  protocol_version: string;
  /** Absent only for compatibility with a pre-build-id daemon. */
  build_id?: string;
  /** Which install started this daemon (A5 §F13). Absent means UNKNOWN, never "mine". */
  install_id?: string;
  instance_id: string;
  pid: number;
  started_at: string;
}

function isHandshakeShape(value: unknown): value is HandshakeResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.protocol_version === "string" &&
    (v.build_id === undefined || typeof v.build_id === "string") &&
    // Same reason as lock.ts: a non-string identity that parses is worse than one that doesn't.
    (v.install_id === undefined || typeof v.install_id === "string") &&
    typeof v.instance_id === "string" &&
    typeof v.pid === "number" &&
    typeof v.started_at === "string"
  );
}

export function parseHandshakeResponse(value: unknown): HandshakeResponse | null {
  return isHandshakeShape(value) ? value : null;
}

/** One attempt, bounded by `timeoutMs`. Never throws — a dead/foreign/slow peer just yields null. */
export async function fetchHandshake(port: number, timeoutMs: number): Promise<HandshakeResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/handshake`, { signal: controller.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseHandshakeResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls until `deadlineMs` elapses, a valid handshake answers, or `shouldStop` returns true.
 * `shouldStop` is how spawn-wait bails when the child has already exited (EADDRINUSE / crash)
 * instead of burning the rest of the deadline against a port that will never answer. */
export async function pollHandshake(
  port: number,
  deadlineMs: number,
  intervalMs = 100,
  shouldStop?: () => boolean,
): Promise<HandshakeResponse | null> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    if (shouldStop?.()) return null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const hs = await fetchHandshake(port, Math.min(500, remaining));
    if (hs) return hs;
    if (shouldStop?.()) return null;
    const afterAttempt = deadline - performance.now();
    if (afterAttempt <= 0) return null;
    await Bun.sleep(Math.min(intervalMs, afterAttempt));
  }
}

/** Ceiling on the bind probe. Generous: a loopback bind is immediate, so this is a stall guard,
 * never a budget. */
const BIND_PROBE_TIMEOUT_MS = 1000;

/**
 * Can THIS process bind 127.0.0.1:port right now? The only test that distinguishes "nothing is
 * listening" from "something is listening but cannot answer", because a refused connection does
 * not mean the port is free.
 *
 * A daemon whose event loop has stopped keeps its listening socket, but stops accepting: the
 * kernel accept queue fills with the connections glosa's own discovery keeps opening, and macOS
 * then answers further connects with RST — a clean `ECONNREFUSED` from a socket that is still
 * LISTENing (issue #139). `bind(2)` has no such failure mode: the kernel refuses it with
 * EADDRINUSE for as long as any process holds the address, accepting or not.
 *
 * Fail closed like `probePortBound`: only a bind that actually succeeds resolves `true`. Every
 * error — EADDRINUSE, EACCES, anything else — resolves `false`, so an ambiguous probe can never
 * be the thing that authorizes removing an ownership record or spawning a contender.
 */
export function probePortBindable(port: number, timeoutMs = BIND_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (bindable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.listening) server.close();
      resolve(bindable);
    };
    // A loopback bind does not hang, but this probe gates ownership decisions and every other
    // outcome here is fail-closed; a promise that never settles would be the one way to stall a
    // caller past its own deadline.
    const timer = setTimeout(() => finish(false), timeoutMs);
    server.once("error", () => finish(false));
    // `exclusive: true` so this never quietly shares a port under SO_REUSEPORT — sharing would
    // report "bindable" for a port another process is serving, the exact false negative this
    // function exists to remove.
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      // Held for microseconds and closed before anyone is told the port is free, so the window in
      // which this probe could itself be the EADDRINUSE a booting daemon sees stays vanishing.
      server.close(() => finish(true));
    });
  });
}

/**
 * Is something listening on 127.0.0.1:port at all — regardless of whether it answers the glosa
 * handshake? Used to tell "genuinely stale lock (nothing there — PID reuse)" apart from "a
 * process is bound but not answering (hung daemon or foreign squatter)"; the latter must never
 * be treated as free (A5 §F13 singleton invariant). Never throws: a clean `ECONNREFUSED` is the
 * only case that resolves `false` — a timeout or any other error resolves `true` (fail closed,
 * so an ambiguous probe never causes a duplicate daemon to spawn).
 *
 * `false` here is NOT proof the port is free, and no caller may treat it as such: a listening
 * socket whose owner has stopped accepting refuses connections once its accept queue fills
 * (issue #139). Pair it with `probePortBindable`, which cannot produce that false negative.
 */
export function probePortBound(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (bound: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code !== "ECONNREFUSED"));
  });
}
