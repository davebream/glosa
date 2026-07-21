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

export class WorkspaceBusRegistry {
  private readonly buses = new Map<string, WorkspaceBus>();
  // ONE mutex shared by every bus this registry ever constructs, regardless of root — matches
  // WorkspaceBusDeps.mutex's existing contract (a shared KeyedMutex already keys per-root
  // internally), so this doesn't change per-workspace serialization semantics, it just makes
  // sure every bus in the process draws from the same keyed pool instead of each getting its own.
  private readonly mutex = new KeyedMutex<string>();

  /** Returns the SAME `WorkspaceBus` instance for `canonicalRoot` every time — constructed at
   * most once per root. `deps` (ulid/now/reducer) is only consulted on first construction; a
   * later call for an already-open root ignores it silently, since there is only ever one bus to
   * reconfigure and reconfiguring a live one out from under existing callers would be worse than
   * ignoring the request. */
  get(canonicalRoot: string, deps: Omit<WorkspaceBusDeps, "mutex"> = {}): WorkspaceBus {
    let bus = this.buses.get(canonicalRoot);
    if (!bus) {
      bus = new WorkspaceBus(canonicalRoot, { ...deps, mutex: this.mutex });
      this.buses.set(canonicalRoot, bus);
    }
    return bus;
  }

  has(canonicalRoot: string): boolean {
    return this.buses.has(canonicalRoot);
  }

  /** Closes and forgets the bus for a root, if one is open. A later `get()` for the same root
   * opens a fresh instance. `close()` awaits the bus's own `close()`, which routes through the
   * bus's mutex, so any write already in flight for this root finishes first. */
  async close(canonicalRoot: string): Promise<void> {
    const bus = this.buses.get(canonicalRoot);
    if (!bus) return;
    this.buses.delete(canonicalRoot);
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
   *   const index = new WorkspaceIndex({ onHardRemove: (p) => busRegistry.evict(p) });
   * Without that wiring, a hard-removed workspace's `WorkspaceBus` (open journal fd, `KeyedMutex`
   * slot, in-memory state) leaks for the life of the daemon process, and a later `get()` for the
   * same (now-reused) canonical path would return that stale instance instead of a fresh one. */
  evict(canonicalRoot: string): Promise<void> {
    return this.close(canonicalRoot);
  }
}

// Process-wide default instance + convenience wrapper — the intended entry point for every
// production caller (the future HTTP/lifecycle layer included): `getWorkspaceBus(root)` always
// resolves through this ONE registry, so "same root -> same instance" holds process-wide, not
// just within whichever module happened to construct its own `WorkspaceBusRegistry`. Tests that
// want isolation from this shared state construct their own `WorkspaceBusRegistry` directly.
const defaultRegistry = new WorkspaceBusRegistry();

export function getWorkspaceBus(canonicalRoot: string, deps: Omit<WorkspaceBusDeps, "mutex"> = {}): WorkspaceBus {
  return defaultRegistry.get(canonicalRoot, deps);
}
