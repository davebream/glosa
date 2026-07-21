// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — P4.2: `GET /w/:slug/transcript/stream` (A1 §5.8, full protocol A1 §8; A2 §F16).
// The conversation-mirror tailer + SSE response builder — the daemon-side half of the "read-only
// transcript view" (R6/F32). Mirrors stream.ts's (journal) shape deliberately (heartbeat, idle-
// timeout override, teardown-on-abort) but is its own module, per the task brief, because its
// cursor space and failure semantics are genuinely different:
//   - the journal never rotates in v1, so its `resync_required` path is documented but unreachable;
//     a live transcript file DOES rotate/truncate (A2 §F16's resume/clear table), so this module's
//     resync path is real and exercised.
//   - ANY failure here — the transcript path doesn't confine, the file vanished, a read blew up —
//     degrades to `event: mirror_unavailable` and keeps the connection alive; it must never take
//     the artifact/annotation half of the app down with it (A2 §F16 "Failure Recovery").
// Raw JSONL bytes are NEVER inspected here — every byte read off disk goes straight into
// `TranscriptNormalizer` (normalize.ts), the one module allowed to know the transcript format.
import { readFileSync, statSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { encodeSseFrame } from "../sse.ts";
import { TranscriptNormalizer } from "./normalize.ts";

const HEARTBEAT_MS = 15_000;

type BunServer = ReturnType<typeof Bun.serve>;

export interface TranscriptCursor {
  inode: number;
  byte_offset: number;
}

/** The A1 §8.1 opaque cursor for this stream — `{inode, byte_offset}` base64url-encoded so it's
 * round-trippable through `Last-Event-ID`/`?since=` without leaking its shape to the client (A1
 * §8.1: "opaque to the client, only round-tripped"). */
export function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Decodes a client-supplied cursor. Returns `null` for anything malformed — the caller treats
 * that identically to an absent cursor (first connect), the same tolerant-fallback posture
 * stream.ts's journal cursor parsing uses for an out-of-range `Last-Event-ID` rather than
 * rejecting the request outright. */
export function decodeTranscriptCursor(raw: string): TranscriptCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.inode === "number" &&
      typeof obj.byte_offset === "number" &&
      obj.byte_offset >= 0
    ) {
      return { inode: obj.inode, byte_offset: obj.byte_offset };
    }
    return null;
  } catch {
    return null;
  }
}

function statOrNull(path: string): { ino: number; size: number } | null {
  try {
    const s = statSync(path);
    return { ino: s.ino, size: s.size };
  } catch {
    return null;
  }
}

export interface TranscriptStreamOptions {
  /** Test-only override — production always uses the real 15s (A1 §8.3). */
  heartbeatMs?: number;
  /** Test-only escape hatch to skip standing up a chokidar watcher per connection when a test only
   * cares about the initial read/cursor mechanics. Defaults to on. */
  watchFile?: boolean;
  shutdownSignal?: AbortSignal;
}

/** Builds the `GET /w/:slug/transcript/stream` response. `transcriptPath` MUST already have
 * passed `confineTranscriptPath` (root.ts) — this module trusts it as given and never re-checks
 * confinement itself, same division of labor as stream.ts trusting an already-reconciled
 * `WorkspaceBus`. `server` disables Bun's idle timeout for this response only (A1 §8.3), same as
 * the journal stream; optional so a route-schema-level test that calls this directly doesn't need
 * a real bound `Bun.serve`. */
export function createTranscriptStreamResponse(
  transcriptPath: string,
  req: Request,
  server: BunServer | undefined,
  opts: TranscriptStreamOptions = {},
): Response {
  const url = new URL(req.url);
  const cursorRaw = req.headers.get("Last-Event-ID") ?? url.searchParams.get("since");
  const cursor = cursorRaw !== null ? decodeTranscriptCursor(cursorRaw) : null;

  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const encoder = new TextEncoder();
  const normalizer = new TranscriptNormalizer();

  let closed = false;
  let watcher: FSWatcher | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let shutdownListener: (() => void) | null = null;
  let offset = 0;
  let currentIno: number | null = null;

  const teardown = (): void => {
    if (closed) return;
    closed = true;
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
          // Controller already closed/errored — the client went away mid-write. Real teardown
          // happens via cancel()/the abort listener below; a lost enqueue here is harmless.
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

      const sendTranscriptEvent = (ev: unknown) => {
        send(encodeSseFrame({ id: encodeTranscriptCursor({ inode: currentIno as number, byte_offset: offset }), event: "transcript", data: ev }));
      };
      /** Fail-soft escape hatch (A2 §F16 "Failure Recovery"): ANY problem reading/tailing the
       * transcript emits this instead of ever throwing out of the stream — ends up as `event:
       * mirror_unavailable` on the wire, no `id` (advisory, doesn't advance the cursor, same
       * posture as `heartbeat`/`artifact`). */
      const sendMirrorUnavailable = () => send(encodeSseFrame({ event: "mirror_unavailable" }));
      /** A2 §F16's resume/clear state-transition table ("Tailer sees truncation or inode change;
       * resync from 0") — reused as the transcript stream's own `resync_required` (A1 §8.2 case
       * 3's escape hatch, unreachable for the journal but real here): tells the client to drop its
       * cursor and reconnect fresh, then ends THIS connection — the client's existing reconnect
       * loop (backoff + no Last-Event-ID) does the rest. */
      const sendResyncAndClose = () => {
        send(encodeSseFrame({ event: "resync_required" }));
        teardown();
        try {
          controller.close();
        } catch {
          // already closing/closed — fine
        }
      };

      function readNewBytesAndEmit(): void {
        let buf: Buffer;
        try {
          buf = readFileSync(transcriptPath);
        } catch {
          sendMirrorUnavailable();
          return;
        }
        const slice = buf.subarray(offset);
        let events;
        try {
          events = normalizer.feed(slice);
        } catch {
          // normalize.ts is written to never throw — this is belt-and-suspenders only, matching
          // the same posture the normalizer itself applies internally.
          sendMirrorUnavailable();
          return;
        }
        offset = buf.length - normalizer.pendingBytes;
        for (const ev of events) sendTranscriptEvent(ev);
      }

      try {
        const stat = statOrNull(transcriptPath);
        if (stat === null) {
          // No transcript bytes yet (a session can register before its first turn is written) —
          // fail soft rather than treat "file doesn't exist YET" as a hard error; heartbeats keep
          // the connection alive and a later chokidar `add` (once the file appears) catches it up.
          sendMirrorUnavailable();
        } else {
          currentIno = stat.ino;
          if (cursor !== null) {
            if (cursor.inode === stat.ino && cursor.byte_offset <= stat.size) {
              offset = cursor.byte_offset;
              readNewBytesAndEmit();
            } else {
              // Rotated (different inode — a `/resume`-like file swap) or truncated (a `/clear`-
              // like rewrite to empty) since this cursor was issued — A2 §F16's resync heuristic.
              sendResyncAndClose();
            }
          } else {
            // First connect (no cursor, or an undecodable one — tolerated the same way stream.ts
            // tolerates an out-of-range Last-Event-ID): read the whole file from 0.
            readNewBytesAndEmit();
          }
        }

        if (!closed) {
          // Immediate heartbeat + interval — same reasoning as stream.ts's journal stream: a
          // reconnect/first-connect with nothing new to emit must still put a byte on the wire
          // right away, or the client's `fetch()` hangs until the first periodic tick.
          send(encodeSseFrame({ event: "heartbeat" }));
          heartbeatTimer = setInterval(() => send(encodeSseFrame({ event: "heartbeat" })), heartbeatMs);
          heartbeatTimer.unref?.();

          if (opts.watchFile !== false && currentIno !== null) {
            watcher = watch(transcriptPath, { ignoreInitial: true });
            watcher.on("change", () => {
              const stat = statOrNull(transcriptPath);
              if (stat === null) {
                sendMirrorUnavailable();
                return;
              }
              if (stat.ino !== currentIno || stat.size < offset) {
                sendResyncAndClose();
                return;
              }
              if (stat.size <= offset) return; // nothing new (e.g. a metadata-only touch)
              readNewBytesAndEmit();
            });
            watcher.on("unlink", () => sendResyncAndClose());
          }
        }
      } catch (err) {
        // Defense-in-depth: everything above is expected to degrade to `sendMirrorUnavailable`
        // internally, but a future change (or an edge case neither review caught) throwing here
        // must never leak the heartbeat timer/watcher or crash the stream.
        teardown();
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
