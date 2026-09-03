// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — client-side helper for probing `GET /api/handshake` (A5 §F13). This is the
// lifecycle-level handshake (readiness + proto compat), not the SPA-facing auth/contract
// handshake — that's wired in P1.3.
import { connect } from "node:net";

export interface HandshakeResponse {
  protocol_version: string;
  /** Absent only for compatibility with a pre-build-id daemon. */
  build_id?: string;
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

/** Polls until `deadlineMs` elapses or a valid handshake answers. */
export async function pollHandshake(
  port: number,
  deadlineMs: number,
  intervalMs = 100,
): Promise<HandshakeResponse | null> {
  const start = Date.now();
  for (;;) {
    const remaining = deadlineMs - (Date.now() - start);
    if (remaining <= 0) return null;
    const hs = await fetchHandshake(port, Math.min(500, remaining));
    if (hs) return hs;
    await Bun.sleep(Math.min(intervalMs, remaining));
  }
}

/**
 * Is something listening on 127.0.0.1:port at all — regardless of whether it answers the glosa
 * handshake? Used to tell "genuinely stale lock (nothing there — PID reuse)" apart from "a
 * process is bound but not answering (hung daemon or foreign squatter)"; the latter must never
 * be treated as free (A5 §F13 singleton invariant). Never throws: a clean `ECONNREFUSED` is the
 * only case that resolves `false` — a timeout or any other error resolves `true` (fail closed,
 * so an ambiguous probe never causes a duplicate daemon to spawn).
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
