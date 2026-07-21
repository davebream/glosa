// @glosa/daemon — a minimal FIFO async mutex, plus a keyed variant (one mutex per key). This is
// the serialization primitive behind "the daemon is the sole writer, per-workspace async mutex"
// (A4 cross-cutting invariant): every journal/inbox write for a given workspace runs inside
// `KeyedMutex.runExclusive(canonicalWorkspacePath, fn)`, so records for that workspace never
// interleave, while different workspaces proceed independently.
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` once every previously-queued holder has released, FIFO. The lock is released
   * (letting the next queued caller run) whether `fn` resolves or rejects; the caller still sees
   * the original result/error via the returned promise. */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // Swallow so a rejection doesn't wedge the chain for the next waiter — the original
    // rejection still propagates to whoever awaits `run`.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class KeyedMutex<K> {
  // Entries are never evicted — a workspace closed for the day still holds a (now-idle, near-
  // zero-cost) AsyncMutex forever. Fine at workspace scale (a handful to a few hundred over a
  // daemon's lifetime, not millions); revisit only if that assumption changes.
  private readonly mutexes = new Map<K, AsyncMutex>();

  runExclusive<T>(key: K, fn: () => T | Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.mutexes.set(key, mutex);
    }
    return mutex.runExclusive(fn);
  }
}
