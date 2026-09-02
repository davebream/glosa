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
   * second writer slipping between source A and source B.
   *
   * Acquisition is hold-and-wait (each key's critical section nests inside the previous one), so
   * A4 "Loose-file adoption — seal and link" — "holds every source registration mutex in stable
   * lexical order" — is a deadlock-freedom requirement, not a cosmetic one. Two callers whose key
   * sets overlap must agree on the order, which needs a genuine TOTAL order.
   *
   * `localeCompare` is NOT one: ICU collates distinct-but-canonically-equivalent strings (NFC vs
   * NFD, among others) as equal, and `Array.prototype.sort` is stable, so tied keys fall back to
   * *insertion* order — which differs per caller. A4 F20 records that "APFS returns NFD", and
   * `workspaceRegistrationId` embeds a raw path as `directory:<path>`, so two adoptions over the
   * same accented directory really can present one NFC key and one NFD key, acquire `{A,B}` and
   * `{B,A}`, and wedge those workspaces for the life of the daemon — `AsyncMutex` has no timeout
   * and no deadlock detection. Compare byte-exact instead: `<`/`>` on strings is a total order,
   * tie-free for every pair of distinct strings. */
  runExclusiveMany<T>(keys: readonly K[], fn: () => T | Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort((a, b) => {
      const left = String(a);
      const right = String(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    // Byte-exact comparison can still tie when two keys are distinct to `Map`/`Set` but identical
    // once stringified (`1` vs `"1"`, two objects sharing a `toString`). Those get separate mutex
    // slots yet no defined relative order, which is the same hold-and-wait hazard again. Nothing
    // in the workspace layer can produce it — `workspaceRegistrationId` always returns a string —
    // so reaching here is a caller bug, and A4's fail-closed posture ("Any live lease or existing
    // target state fails closed before a source is sealed") says surface it. Reject BEFORE the
    // first acquisition, so a rejected call never leaves a key held.
    for (let i = 1; i < sorted.length; i++) {
      if (String(sorted[i - 1]) !== String(sorted[i])) continue;
      return Promise.reject(
        new Error(
          `runExclusiveMany received indistinguishable keys (${JSON.stringify(String(sorted[i]))} appears twice once stringified) — multi-key acquisition needs a total order over distinct keys or it can deadlock`,
        ),
      );
    }
    const acquire = (index: number): Promise<T> => {
      if (index >= sorted.length) return Promise.resolve().then(fn);
      return this.runExclusive(sorted[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  }
}
