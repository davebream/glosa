// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — process-wide WorkspaceBus registry (P2.4). Closes the gap `WorkspaceBusDeps`
// documents at the top of bus.ts: nothing in `WorkspaceBus` itself stops two instances from being
// opened for the same canonical root, each with its own fd/state/KeyedMutex — this is what
// enforces "one WorkspaceBus per canonical root, one shared mutex" by construction instead of by
// caller convention. Every caller that wants a bus for a given root gets literally the SAME
// instance, so there is exactly one `KeyedMutex` slot, one `JournalWriter` fd, and one in-memory
// `state` per workspace — never two independently-unsynchronized writers racing the same
// shadow-git repo or journal file.
import { KeyedMutex } from "./mutex.ts";
import { WorkspaceBus, type WorkspaceBusDeps } from "./bus.ts";
import { leaseHeldError } from "./lease.ts";
import { workspaceRegistrationId, type WorkspaceTarget } from "../workspace.ts";

export class WorkspaceBusRegistry {
  private readonly buses = new Map<string, WorkspaceBus>();
  // ONE mutex shared by every bus this registry ever constructs, regardless of root — matches
  // WorkspaceBusDeps.mutex's existing contract (a shared KeyedMutex already keys per-root
  // internally), so this doesn't change per-workspace serialization semantics, it just makes
  // sure every bus in the process draws from the same keyed pool instead of each getting its own.
  private readonly mutex = new KeyedMutex<string>();

  constructor(private readonly defaultDeps: Omit<WorkspaceBusDeps, "mutex"> = {}) {}

  /** Returns the SAME `WorkspaceBus` instance for `canonicalRoot` every time — constructed at
   * most once per root. `deps` (ulid/now/reducer) is only consulted on first construction; a
   * later call for an already-open root ignores it silently, since there is only ever one bus to
   * reconfigure and reconfiguring a live one out from under existing callers would be worse than
   * ignoring the request. */
  get(canonicalRoot: WorkspaceTarget, deps: Omit<WorkspaceBusDeps, "mutex"> = {}): WorkspaceBus {
    // ONE lookup, no shape-bridging fallbacks: `workspaceRegistrationId` now hashes a bare
    // directory string into the SAME sha256 the index persists for that directory, so both shapes
    // of one workspace land on this key. The two remap/reverse-scan fallbacks that used to sit
    // here only ever repaired `get()`; `has()` and `evictRegistration()` had no equivalent and
    // silently answered for the wrong key, and any `new WorkspaceBus(...)` built outside this
    // registry got a second mutex slot regardless (A4 F21 allows ONE git mutex per workspace).
    const id = workspaceRegistrationId(canonicalRoot);
    let bus = this.buses.get(id);
    if (!bus) {
      bus = new WorkspaceBus(canonicalRoot, { ...this.defaultDeps, ...deps, mutex: this.mutex });
      this.buses.set(id, bus);
    }
    return bus;
  }

  has(canonicalRoot: WorkspaceTarget): boolean {
    return this.buses.has(workspaceRegistrationId(canonicalRoot));
  }

  /** Atomically preflights and seals a set of source registrations. All source locks are held in
   * one total order, so either every source observes no active apply lease and seals, or none do. */
  sealForAdoption(
    sources: readonly WorkspaceTarget[],
    adoptionId: string,
    targetRegistrationId: string,
  ): Promise<void> {
    const keys = sources.map((source) => workspaceRegistrationId(source));
    return this.mutex.runExclusiveMany(keys, () => {
      const buses = sources.map((source) => this.get(source));
      // Preflight every source before appending. Holding all source mutexes prevents a new
      // apply lease between this check and the corresponding seal.
      for (const bus of buses) {
        const leaseId = bus.activeApplyLeaseIdForAdoptionLocked();
        if (leaseId) throw leaseHeldError(leaseId);
      }
      for (const bus of buses) bus.sealForAdoptionLocked(adoptionId, targetRegistrationId);
    });
  }

  /** Closes and forgets the bus for a root, if one is open. A later `get()` for the same root
   * opens a fresh instance. `close()` awaits the bus's own `close()`, which routes through the
   * bus's mutex, so any write already in flight for this root finishes first. */
  async close(canonicalRoot: WorkspaceTarget): Promise<void> {
    const id = workspaceRegistrationId(canonicalRoot);
    const bus = this.buses.get(id);
    if (!bus) return;
    this.buses.delete(id);
    await bus.close();
  }

  /** Stops every open bus after its current workspace-scoped mutation completes. New lookups
   * cannot recover an old instance because the map is cleared before any close is awaited. */
  async closeAll(): Promise<void> {
    const buses = [...this.buses.values()];
    this.buses.clear();
    await Promise.all(buses.map((bus) => bus.close()));
  }

  /** Same operation as `close()`, named for its actual call site: `WorkspaceIndex`'s GC (or an
   * explicit `forget(slug)`) hard-removing a workspace. `WorkspaceIndex` has no reference to this
   * registry on its own — nothing wires the two together automatically — so production boot code
   * MUST connect them once, right after constructing both:
   *   const busRegistry = new WorkspaceBusRegistry();
   *   const index = new WorkspaceIndex({ onHardRemove: (entry) => busRegistry.evict(entry) });
   * Without that wiring, a hard-removed workspace's `WorkspaceBus` (open journal fd, `KeyedMutex`
   * slot, in-memory state) leaks for the life of the daemon process, and a later `get()` for the
   * same (now-reused) canonical path would return that stale instance instead of a fresh one. */
  evict(canonicalRoot: WorkspaceTarget): Promise<void> {
    return this.close(canonicalRoot);
  }

  async evictRegistration(registrationId: string): Promise<void> {
    const bus = this.buses.get(registrationId);
    if (!bus) return;
    this.buses.delete(registrationId);
    await bus.close();
  }
}

// Process-wide default instance + convenience wrapper — the intended entry point for every
// production caller (the future HTTP/lifecycle layer included): `getWorkspaceBus(root)` always
// resolves through this ONE registry, so "same root -> same instance" holds process-wide, not
// just within whichever module happened to construct its own `WorkspaceBusRegistry`. Tests that
// want isolation from this shared state construct their own `WorkspaceBusRegistry` directly.
const defaultRegistry = new WorkspaceBusRegistry();

export function getWorkspaceBus(
  canonicalRoot: WorkspaceTarget,
  deps: Omit<WorkspaceBusDeps, "mutex"> = {},
): WorkspaceBus {
  return defaultRegistry.get(canonicalRoot, deps);
}
