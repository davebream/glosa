// SPDX-License-Identifier: Apache-2.0
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

  /** Acquires a stable, deduplicated set of keys in lexical order. Adoption needs this narrow
   * multi-key primitive so it can inspect every source lease and seal every source without a
   * second writer slipping between source A and source B. */
  runExclusiveMany<T>(keys: readonly K[], fn: () => T | Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort((a, b) => String(a).localeCompare(String(b)));
    const acquire = (index: number): Promise<T> => {
      if (index >= sorted.length) return Promise.resolve().then(fn);
      return this.runExclusive(sorted[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }
}
