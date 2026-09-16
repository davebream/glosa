// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — #153 Part 2: `glosa_watch`'s held-request wait, generalizing
// `attention.ts`'s `waitForEntryTerminal` from "one entry reaches a terminal status" to "the
// workspace's `external_edit` cursor has something new for this session". Kept a separate module
// (not folded into attention.ts) because a watch is not an attention concept — it shares only the
// wait SHAPE (subscribe-then-recheck, timer, abort), not any attention-specific state.
import type { DeliverableEntry } from "../agent-provider/interface.ts";
import type { WorkspaceBus } from "../bus/bus.ts";
import { type EntryWaitDeps, MAX_ENTRY_WAIT_MS, realEntryWaitDeps } from "./attention.ts";

export { MAX_ENTRY_WAIT_MS };

export interface WatchPreview {
  entries: DeliverableEntry[];
  has_more: boolean;
  latest_checkpoint: string | null;
}

export interface WatchWaitResult extends WatchPreview {
  waited: boolean;
}

export type WatchPresentationBuilder = (
  id: string,
  payload: unknown,
  status: string,
) => DeliverableEntry | null | Promise<DeliverableEntry | null>;

/**
 * Resolves when the watch cursor (`bus.previewWatch`) has at least one entry for `session`, when
 * `signal` aborts, or when `waitMs` elapses — whichever happens first. Same subscribe-then-recheck
 * shape as `waitForEntryTerminal` and for the identical reason (criterion 2): an entry created
 * between the initial read and the subscription must not be stranded until `waitMs`.
 *
 * The listener itself never calls back into `bus.previewWatch` (mutex-guarded) synchronously —
 * `entry_created` fires from INSIDE the appending write's own critical section (`bus.ts`'s
 * `notify`), and `KeyedMutex.runExclusive` is not reentrant. `recheck` below is an ordinary async
 * function: calling it from the listener queues its `previewWatch` call behind the writer's own
 * critical section instead of deadlocking against it, and by the time it runs the write (and every
 * entry it created) is already durably applied.
 */
export interface WaitForWatchHooks {
  /**
   * Test-only seam (default: no-op). Awaited AFTER the initial read completes and BEFORE
   * `bus.subscribe` registers, artificially widening the otherwise sub-microtask gap criterion 2
   * exists to close, so a test can deterministically land a real append inside it rather than
   * trying to win an unwinnable race with wall-clock sleeps (L-issue-164-2: widen the window,
   * don't re-run for luck). Production never supplies this — the gap stays whatever one
   * synchronous JS turn actually takes.
   */
  afterInitialRead?: () => Promise<void>;
}

export async function waitForWatch(
  bus: WorkspaceBus,
  opts: { session: string; path?: string; since?: string; waitMs: number; signal?: AbortSignal },
  build: WatchPresentationBuilder,
  timers: EntryWaitDeps = realEntryWaitDeps,
  hooks: WaitForWatchHooks = {},
): Promise<WatchWaitResult> {
  const preview = () => bus.previewWatch({ session: opts.session, path: opts.path, since: opts.since }, build);

  const settled = await preview();
  if (settled.entries.length > 0 || opts.waitMs <= 0 || opts.signal?.aborted) {
    return { ...settled, waited: false };
  }
  await hooks.afterInitialRead?.();

  return await new Promise<WatchWaitResult>((resolve) => {
    let done = false;
    const cleanup = () => {
      unsubscribe();
      timers.clearTimer(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    /** Settles unconditionally — the timer and client-disconnect paths, where an empty
     * `entries:[]` is itself the correct, honest answer (criterion 5). */
    const settleAlways = async () => {
      if (done) return;
      const result = await preview();
      if (done) return;
      done = true;
      cleanup();
      resolve({ ...result, waited: true });
    };
    /** Settles only if the recheck actually found something — a wake from an out-of-scope
     * `entry_created` (wrong path, already presented, `since`-excluded) must not end the hold
     * early with nothing to show for it. */
    const settleIfFound = async () => {
      if (done) return;
      const result = await preview();
      if (done) return;
      if (result.entries.length === 0) return;
      done = true;
      cleanup();
      resolve({ ...result, waited: true });
    };
    const onAbort = () => void settleAlways();
    const unsubscribe = bus.subscribe(({ event }) => {
      if (event.event !== "entry_created") return;
      if (event.detail?.payload_kind !== "external_edit") return;
      void settleIfFound();
    });
    const timer = timers.setTimer(() => void settleAlways(), Math.min(opts.waitMs, MAX_ENTRY_WAIT_MS));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // An AbortSignal that already fired does not call a listener registered afterwards, so an abort
    // landing between the initial read and this registration would otherwise hold the request until
    // its timer — the client is gone, or the session was rebound, and nothing would notice. Checked
    // AFTER registering so the two paths cannot both miss it (review round 1, F-7).
    if (opts.signal?.aborted) void settleAlways();
    // Post-subscribe re-read — closes the read→subscribe gap (criterion 2), exactly like
    // `waitForEntryTerminal`'s own `afterSubscribe` check.
    void settleIfFound();
  });
}
