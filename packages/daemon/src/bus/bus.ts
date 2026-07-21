// @glosa/daemon — WorkspaceBus: the live, in-process facade over one workspace's file bus. Ties
// together the pieces the other modules in this directory keep deliberately separate:
//   - a long-lived JournalWriter (one fd held for the life of the bus, A4 §F04)
//   - the per-workspace mutex slot from a shared KeyedMutex (cross-cutting invariant: daemon is
//     the sole writer, serialized per workspace)
//   - the "inbox file atomically first, then entry_created" ordering that module 4 (inbox.ts)
//     requires but can't enforce by itself, since it spans both inbox.ts and journal.ts.
// This is what the HTTP layer (later tasks) and this task's concurrency tests call.
import { JournalWriter, appendEvent, type EventBy, type JournalEvent } from "./journal.ts";
import { writeInboxEntryOnce } from "./inbox.ts";
import { journalPath, workspaceBusDir } from "./paths.ts";
import { applyEvent, createEmptyState, defaultReducer, type DerivedState, type Reducer } from "./replay.ts";
import { reconcileWorkspace, type ReconcileResult } from "./reconcile.ts";
import { KeyedMutex } from "./mutex.ts";
import { ulid as defaultUlid } from "./ulid.ts";
import { mkdirSync } from "node:fs";

// P2.4: nothing here stops two WorkspaceBus instances from being opened for the same canonical
// root — each would hold its own fd and in-memory state, defeating the single-writer invariant.
// Enforcing "one WorkspaceBus per canonical root" needs a process-wide registry, which isn't
// reachable until the HTTP/lifecycle layer (later task) decides where workspace roots get
// resolved and cached. Not implemented here — callers must not open the same root twice.
export interface WorkspaceBusDeps {
  /** Shared across every WorkspaceBus in the daemon process so different workspaces never share
   * a mutex slot, but the same workspace (opened twice) does. Defaults to a private one, which is
   * fine for a single WorkspaceBus but wrong if the daemon opens the same workspace root twice —
   * callers doing that must pass a shared instance. */
  mutex?: KeyedMutex<string>;
  ulid?: () => string;
  now?: () => Date;
  reducer?: Reducer;
}

export class WorkspaceBus {
  readonly root: string;
  state: DerivedState = createEmptyState();

  private readonly writer: JournalWriter;
  private readonly mutex: KeyedMutex<string>;
  private readonly ulidFn: () => string;
  private readonly nowFn: () => Date;
  private readonly reducer: Reducer;

  constructor(workspaceRoot: string, deps: WorkspaceBusDeps = {}) {
    this.root = workspaceRoot;
    mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });
    this.writer = new JournalWriter(journalPath(workspaceRoot));
    this.mutex = deps.mutex ?? new KeyedMutex<string>();
    this.ulidFn = deps.ulid ?? defaultUlid;
    this.nowFn = deps.now ?? (() => new Date());
    this.reducer = deps.reducer ?? defaultReducer;
  }

  /** Runs the startup reconcile sequence (its own short-lived writer) and adopts the resulting
   * derived state as this bus's baseline. Call once before serving live writes. */
  reconcile(): Promise<ReconcileResult> {
    return this.mutex.runExclusive(this.root, () => {
      const result = reconcileWorkspace(this.root, { ulid: this.ulidFn, now: this.nowFn, reducer: this.reducer });
      this.state = result.state;
      return result;
    });
  }

  /** Inbox file atomically first, then `entry_created` — the load-bearing order from A4 §F04.
   * Both steps run inside the same mutex critical section as every other write to this
   * workspace, so a concurrent transition/delivery call can never observe a half-created entry. */
  createEntry(id: string, payload: unknown, fields: Partial<Pick<JournalEvent, "by" | "idem" | "detail">> = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      writeInboxEntryOnce(this.root, id, payload);
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: id,
        event: "entry_created",
        by: fields.by ?? "daemon",
        ...(fields.idem !== undefined ? { idem: fields.idem } : {}),
        ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** Appends a `transition_committed{to}` event. Passing the same `idem` across retried calls
   * makes a repeat a no-op on replay — see replay.ts. */
  commitTransition(entryId: string, to: string, opts: { by?: EventBy; idem?: string } = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "transition_committed",
        by: opts.by ?? "daemon",
        ...(opts.idem !== undefined ? { idem: opts.idem } : {}),
        detail: { to },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** `delivery_attempt` never changes status (separate axis, A5 §F23) and may skip the per-write
   * fsync — loss here is only a redundant re-nudge. */
  recordDeliveryAttempt(entryId: string, opts: { by?: EventBy } = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "delivery_attempt",
        by: opts.by ?? "daemon",
      };
      appendEvent(this.writer, event, { fsync: false });
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** Routed through the mutex so any write already in flight for this workspace finishes first —
   * `close()` then makes the writer terminal (see `JournalWriter#fd`'s `closed` guard), so a
   * write racing in from AFTER this call throws instead of silently reopening the fd. */
  close(): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      this.writer.close();
    });
  }
}
