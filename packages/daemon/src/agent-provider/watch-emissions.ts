// SPDX-License-Identifier: Apache-2.0
// What a watch RESPONSE actually handed to a session, so `POST /api/sessions/:id/watch/transport-ack`
// can prove the entries it is asked to attribute were ones this session was really given (#153
// Part 2, review round 2). Purely in-memory, like SessionPushRegistry: durable truth stays in the
// journal, and losing this on restart costs a window of un-ackable emissions, never a false one.

/** How long an emitted id stays ackable. A watch client acks as soon as the HTTP body lands, so
 * this only has to outlive the round trip; it is generous because the cost of expiring early is a
 * lost `transport_accepted` (the entry stays undelivered and is re-offered), while the cost of
 * expiring late is nothing — the id was genuinely emitted to this session either way. */
const DEFAULT_EMISSION_TTL_MS = 5 * 60_000;

export class WatchEmissionRegistry {
  private readonly emitted = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ttlMs: number = DEFAULT_EMISSION_TTL_MS) {}

  private static key(sessionId: string, entryId: string): string {
    return `${sessionId}\0${entryId}`;
  }

  /** Called with the ids a watch response is about to return. Re-emitting an id (a second watch
   * that still finds it undelivered) restarts its window rather than opening a second one. */
  noteEmitted(sessionId: string, entryIds: readonly string[]): void {
    for (const entryId of entryIds) {
      const key = WatchEmissionRegistry.key(sessionId, entryId);
      const prior = this.emitted.get(key);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => this.emitted.delete(key), this.ttlMs);
      timer.unref?.();
      this.emitted.set(key, timer);
    }
  }

  /** The watch-route equivalent of `SessionPushRegistry.isAwaitingTransport`. Deliberately NOT
   * consuming: the journal write behind it is idempotent, so a client retrying its ack after a
   * dropped response must not be told 409 for an entry it really did receive. */
  isAwaitingTransport(sessionId: string, entryId: string): boolean {
    return this.emitted.has(WatchEmissionRegistry.key(sessionId, entryId));
  }

  /** Drops everything recorded for a session. Called when a session deregisters, so a later
   * registration reusing the same id starts with no inherited claim. */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const [key, timer] of this.emitted) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.emitted.delete(key);
    }
  }

  /** Test/diagnostic-only: how many emissions are live right now. */
  size(): number {
    return this.emitted.size;
  }
}
