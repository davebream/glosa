// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — P3.2: `GET /w/:slug/stream` (A1 §5.5, full protocol A1 §8). Builds the SSE
// Response — first-connect snapshot, reconnect resume from a journal-line cursor, live push via
// `WorkspaceBus`'s in-process notifier, best-effort artifact-change push via a chokidar watcher,
// and a 15s heartbeat with the response's own idle-timeout disabled (A1 §8.3). Deliberately does
// NOT import http.ts (which imports THIS module for the route wiring) — http.ts owns slug ->
// workspace resolution and hands this module an already-reconciled `WorkspaceBus`.
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { encodeSseFrame } from "./sse.ts";
import { readJournalEventsSince } from "./bus/tail.ts";
import { resolveTrackedFiles } from "./matcher.ts";
import { classifyArtifactPath, sourceSha256 } from "./artifact-render.ts";
import { isTerminal } from "./bus/lifecycle.ts";
import { workspaceWorktree, type WorkspaceTarget } from "./workspace.ts";
import type { WorkspaceBus } from "./bus/bus.ts";

const HEARTBEAT_MS = 15_000;

type BunServer = ReturnType<typeof Bun.serve>;

/** The A1 §8.2 first-connect snapshot payload: the artifact list (+ per-artifact
 * `source_sha256`) and the derived inbox/attention state — everything the SPA needs to paint the
 * workspace from scratch. Reads straight off `bus.state` (not a fresh journal parse) so the
 * payload is guaranteed consistent with whatever cursor this snapshot is stamped with — both are
 * captured in the same synchronous tick as the `subscribe()` call in
 * `createJournalStreamResponse` below. */
function buildSnapshotData(root: WorkspaceTarget, bus: WorkspaceBus): unknown {
  const { tracked } = resolveTrackedFiles(root);
  const artifacts = tracked.map((f) => ({
    path: f.path,
    class: classifyArtifactPath(f.path),
    source_sha256: sourceSha256(readFileSync(f.rawPath)),
  }));
  const attention = Object.entries(bus.state.entries)
    .filter(([, e]) => e.kind === "attention" && !isTerminal("attention", e.status))
    .map(([id, e]) => ({ id, status: e.status }));
  return { artifacts, inbox: { pending_count: attention.length, attention } };
}

function toRelPosixPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/").normalize("NFC");
}

/** A minimal, best-effort artifact-change watcher (P3.2 — the journal cursor/reconnect mechanics
 * above are the correctness bar this task owns; this half is advisory). chokidar v4 dropped glob
 * support (matcher.ts's own docstring), so it watches the raw workspace root and every raw fs
 * event is re-checked against `resolveMatchedFiles` — the ONE canonical matcher — before deciding
 * whether it's a tracked artifact worth pushing. `.glosa/**` is pruned at the chokidar level
 * (never even watched): this daemon's own shadow-git checkpoints (A4 §F21) live under there, and
 * without this exclude every checkpoint would re-trigger the watcher it's feeding, a self-loop
 * with no artifact behind it. */
function startArtifactWatcher(workspace: WorkspaceTarget, onChange: (relPath: string) => void): FSWatcher {
  const root = workspaceWorktree(workspace);
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path: string) => relative(root, path).split(sep)[0] === ".glosa",
  });
  const handle = (absPath: string) => onChange(toRelPosixPath(root, absPath));
  watcher.on("add", handle).on("change", handle).on("unlink", handle);
  return watcher;
}

export interface StreamOptions {
  /** Test-only override — production always uses the real 15s (A1 §8.3). */
  heartbeatMs?: number;
  /** Test-only escape hatch to skip standing up a chokidar watcher per connection when a test
   * only cares about journal/cursor mechanics. Defaults to on. */
  watchArtifacts?: boolean;
  shutdownSignal?: AbortSignal;
  subscribeMetadata?: (listener: () => void) => () => void;
}

/** Builds the `GET /w/:slug/stream` response. `server` is used only to disable Bun's idle
 * timeout for THIS response (A1 §8.3, `server.timeout(req, 0)`) — optional so route-schema-level
 * tests that call the fetch pipeline directly (no real bound `Bun.serve`) don't have to fabricate
 * one; production always has a real server, in which case the idle-timeout override always runs. */
export function createJournalStreamResponse(
  root: WorkspaceTarget,
  bus: WorkspaceBus,
  req: Request,
  server: BunServer | undefined,
  opts: StreamOptions = {},
): Response {
  const url = new URL(req.url);
  const cursorRaw = req.headers.get("Last-Event-ID") ?? url.searchParams.get("since");
  // A malformed/non-numeric cursor, OR one outside the only legal range (`-1` is the sole
  // sentinel — "empty journal, nothing consumed yet"; anything <= -2 is never issued by this
  // module), is treated as "absent" (first connect) rather than rejected — robuster than failing
  // a reconnect outright for a client sending garbage, and harmless since first-connect is always
  // a safe fallback (it just repaints from a fresh snapshot). Review fix: an out-of-range value
  // like `-999` used to reach `readJournalEventsSince` as a negative array index, throwing
  // synchronously out of `start()` (500 + a leaked bus listener) instead of falling back here.
  const parsedCursor = cursorRaw !== null && /^-?\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;
  const sinceSeq = parsedCursor !== null && parsedCursor >= -1 ? parsedCursor : null;

  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let watcher: FSWatcher | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let shutdownListener: (() => void) | null = null;
  let unsubscribeMetadata: (() => void) | null = null;

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribeMetadata?.();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watcher) void watcher.close();
    if (shutdownListener) opts.shutdownSignal?.removeEventListener("abort", shutdownListener);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Controller already closed/errored — the client went away right as we tried to write.
          // Real teardown happens via cancel()/the abort listener below; a lost enqueue here is
          // harmless (no frame is silently "half sent" — SSE frames are written whole).
        }
      };

      shutdownListener = () => {
        send(encodeSseFrame({ event: "bye" }));
        teardown();
        try {
          controller.close();
        } catch {
          // already closed by the peer
        }
      };
      opts.shutdownSignal?.addEventListener("abort", shutdownListener, { once: true });
      if (opts.shutdownSignal?.aborted) shutdownListener();
      if (closed) return;

      // LOAD-BEARING ORDERING: subscribe to live events BEFORE reading `currentCursor()` (first
      // connect) or replaying the tail (reconnect) — and with NO `await` anywhere in this
      // synchronous block. WorkspaceBus.subscribe()'s own docstring is the other half of this
      // invariant: because JS is single-threaded, a write already "in flight" (awaiting its own
      // checkpoint/mutex turn) cannot have its append+notify continuation run in the middle of
      // this block, so there is no gap in which an event could land uncounted by either the
      // snapshot/replay below OR the live subscription — every physical journal line is seen by
      // exactly one of the two paths, never zero, never both.
      unsubscribe = bus.subscribe(({ cursor, event }) => {
        send(encodeSseFrame({ id: cursor, event: "journal", data: event }));
      });
      unsubscribeMetadata =
        opts.subscribeMetadata?.(() => {
          send(encodeSseFrame({ event: "metadata", data: { changed: true } }));
        }) ?? null;

      // Defense-in-depth (review item #3): everything from here on is pure setup (no I/O that's
      // expected to fail under normal operation) but a future change — or an edge case neither
      // review caught — throwing here, AFTER `subscribe()` already registered a listener, must
      // never leak that listener/the heartbeat timer/the watcher. `sinceSeq`'s own range is
      // guarded above so this catch is belt-and-suspenders, not the primary defense against #1.
      try {
        let replayedAny = false;
        if (sinceSeq === null) {
          // First connect (A1 §8.2 case 1): one snapshot at the current cursor, then live from
          // the subscription above.
          const cursor = bus.currentCursor();
          send(encodeSseFrame({ id: cursor, event: "snapshot", data: buildSnapshotData(root, bus) }));
          replayedAny = true;
        } else {
          // Reconnect (A1 §8.2 case 2/3): the journal never rotates in v1, so every cursor ever
          // issued is always "retained" — a strict resume, replaying every event with sequence >
          // sinceSeq straight from the journal file, no snapshot. (The `resync_required` escape
          // hatch for a rotated journal is encodable via sse.ts but has no v1 trigger — see A1
          // §8.2 case 3's own note that this is reserved for a mechanism v1 doesn't have.)
          for (const { sequence, event } of readJournalEventsSince(root, sinceSeq)) {
            send(encodeSseFrame({ id: sequence, event: "journal", data: event }));
            replayedAny = true;
          }
        }

        // Heartbeat (A1 §8.3) — belt-and-suspenders alongside the idle-timeout override below:
        // covers any intermediary that isn't Bun's own idle timer. `.unref()` so a forgotten/
        // never explicitly-cancelled stream (e.g. a test that only reads the first frame) never
        // keeps the process alive on this timer alone — the real daemon stays up via its bound
        // server socket regardless.
        //
        // A reconnect that had NOTHING to replay (client is already caught up, no live event has
        // fired yet either) would otherwise send its first byte only at the FIRST periodic
        // heartbeat, up to `heartbeatMs` away — Bun's own `fetch()` doesn't resolve its response
        // promise until the first body byte arrives (headers alone aren't enough), so a silent
        // response leaves every caller's `fetch()` hanging for that whole interval, not just this
        // stream sitting quiet. Firing one heartbeat frame immediately (then the normal interval
        // for every tick after) guarantees a byte is always in flight within moments of
        // connecting, regardless of branch — also good SSE practice independent of the
        // Bun-specific trigger (confirms liveness to the client/any intermediary immediately
        // rather than after a wait).
        if (!replayedAny) send(encodeSseFrame({ event: "heartbeat" }));
        heartbeatTimer = setInterval(() => send(encodeSseFrame({ event: "heartbeat" })), heartbeatMs);
        heartbeatTimer.unref?.();

        if (opts.watchArtifacts !== false) {
          watcher = startArtifactWatcher(root, (relPath) => {
            const { tracked } = resolveTrackedFiles(root);
            const match = tracked.find((f) => f.path === relPath);
            if (!match) return; // deleted, excluded, or grew past the oversize threshold — nothing to push
            send(
              encodeSseFrame({
                event: "artifact",
                // No `id` — best-effort/live-only, no durable log to replay from on reconnect
                // (unlike journal events); same "advisory, doesn't advance the cursor" posture as
                // heartbeat (sse.ts's SseFrame docstring).
                data: {
                  path: match.path,
                  class: classifyArtifactPath(match.path),
                  source_sha256: sourceSha256(readFileSync(match.rawPath)),
                },
              }),
            );
          });
        }
      } catch (err) {
        teardown(); // unsubscribe + clear heartbeat + close watcher — nothing leaks past this throw
        controller.error(err);
      }
    },
    cancel() {
      teardown();
    },
  });

  req.signal?.addEventListener("abort", teardown);
  server?.timeout(req, 0); // A1 §8.3 — disable Bun's idle timeout for THIS response only

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
