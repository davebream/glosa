// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — THE one place a glosa client puts the pairing credential on the wire (A3 §3.2).
//
// Before this module there were four: `packages/cli/src/api-client.ts`,
// `packages/cli/src/daemon-client.ts` twice, and `packages/providers/claude-code/src/monitor.ts`.
// Each resolved a TCP port once and then sent `Authorization: Bearer <token>` to that captured
// port for the rest of the client's life — up to fifteen minutes for a held `glosa_watch`, a
// whole attachment for Codex, a whole stream for the monitor. Once the daemon exited, any local
// process could take the port, and the lock it left behind is world-readable while the token
// beside it is not, so a process at a DIFFERENT uid could read the identity the daemon published,
// echo it back, and be handed a credential it could never have read from disk (issue #207).
//
// Re-checking that identity before each request does not fix it, which is why this module does
// not do that. Every value a client could compare is published by the lock and republished by the
// tokenless handshake, so an impostor satisfies all of them; and the one fact that is not
// published — whether the process the lock NAMES is still alive — is a fact about the wrong
// process. `drainDaemonServers` closes the listeners up to eight seconds before
// `removeLockIfOwned` runs, so on every ordinary shutdown there is a window where the port is
// free, the PID is alive, `ps` still shows `__daemon`, and the lock is untouched. A squatter that
// binds the freed port in that window passes every check a client could make.
//
// So the destination is not chosen by comparison at all. It is `<GLOSA_HOME>/run/api.sock`,
// derived from this process's own home and never from anything a peer said, in a directory the
// kernel will not let another uid traverse. There is no port to squat and nothing to impersonate:
// `connect(2)` fails with EACCES before a byte is written.
import type { DaemonConnection } from "../lifecycle/daemon.ts";
import { glosaHome } from "../lifecycle/home.ts";
import { loadToken } from "./token.ts";

/** Everything a caller may vary. Deliberately not a `RequestInit`: the headers this module owns —
 * `Authorization` above all — are not a field callers get to supply or override. */
export interface AuthedRequestSpec {
  /** Absolute, already-encoded API path, e.g. `/api/sessions/s-1/heartbeat`. */
  path: string;
  method?: string;
  body?: string;
  /** `null` (the default) sends no `Content-Type`, which is what every GET wants. */
  contentType?: string | null;
  /** For headers that are genuinely the caller's, like the monitor's `X-Contract-Version`. */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DaemonUnreachableError extends Error {
  code: "DAEMON_UNREACHABLE";
}

export function daemonUnreachable(reason: string): DaemonUnreachableError {
  const err = new Error(`glosa daemon unreachable: ${reason}`) as DaemonUnreachableError;
  err.code = "DAEMON_UNREACHABLE";
  return err;
}

/**
 * The URL's authority is inert: a Unix socket has no host to resolve and no port to connect to,
 * and the socket listener does not apply the `Host` allowlist (that allowlist exists to defeat
 * DNS rebinding, which needs a browser and a resolver — neither is present here). It is spelled
 * out rather than left to chance so a reader does not go looking for which name is allowlisted.
 */
const SOCKET_AUTHORITY = "http://localhost";

/**
 * Issues one authenticated request over the daemon's Unix socket.
 *
 * The token is read HERE, per call, never captured when a client was built: the daemon accepts
 * only the current credential with no grace period (A3 §3), and every one of these clients can
 * outlive a `glosa token rotate`. An ABSENT token sends no `Authorization` header at all rather
 * than the string `Bearer null` the previous call sites interpolated — both are refused, but only
 * one of them is honest to the daemon's rejection log, which distinguishes "this daemon holds no
 * credential" from "the caller's credential is not this daemon's".
 */
export async function authedRequest(
  conn: Pick<DaemonConnection, "socketPath">,
  spec: AuthedRequestSpec,
  home: string = glosaHome(),
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  const token = loadToken(home);
  const headers: Record<string, string> = { ...spec.extraHeaders };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (spec.contentType) headers["Content-Type"] = spec.contentType;
  try {
    return await doFetch(`${SOCKET_AUTHORITY}${spec.path}`, {
      unix: conn.socketPath,
      method: spec.method ?? "POST",
      headers,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
  } catch (error) {
    // An aborted request is the caller's own cancellation, not an unreachable daemon; passing it
    // through as DAEMON_UNREACHABLE would turn every shutdown and every cancelled tool call into
    // a spurious connectivity report.
    if ((error as Error).name === "AbortError") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: no daemon has ever bound this socket, or one exited cleanly and removed it.
    // ECONNREFUSED: the file survives a killed daemon, and nothing is listening.
    // EACCES: the run directory or the socket is not ours — deliberately NOT retried over TCP.
    throw daemonUnreachable(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? `no daemon is serving ${conn.socketPath}`
        : `${conn.socketPath}: ${(error as Error).message}`,
    );
  }
}
