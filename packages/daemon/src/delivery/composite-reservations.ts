// SPDX-License-Identifier: Apache-2.0
// Ephemeral coordination for one agent-visible delivery assembled from several workspace buses.
// This is deliberately NOT a durable ledger: each constituent reservation is short-lived process
// state and every completed acknowledgement is independently true in that workspace's journal.
// Losing this map on crash invalidates the composite token; presented prefixes remain journal truth
// and unacknowledged suffixes become eligible again when their bus process state disappears.
import { randomUUID } from "node:crypto";
import type { WorkspaceBus } from "../bus/bus.ts";
import { AsyncMutex } from "../bus/mutex.ts";

const COMPOSITE_TTL_MS = 30_000;
const COMPOSITE_PREFIX = "cmp_";

export interface CompositeReservationChild {
  bus: WorkspaceBus;
  delivery_id: string;
}

interface CompositeChildState extends CompositeReservationChild {
  acknowledged: boolean;
}

interface CompositeReservation {
  session: string;
  expires_at: number;
  outcome?: "presented" | "failed";
  children: CompositeChildState[];
}

export type CompositeAckResult = "acknowledged" | "missing" | "outcome-conflict";

export interface CompositeDeliveryRegistryDeps {
  now?: () => number;
  id?: () => string;
}

export class CompositeDeliveryRegistry {
  private readonly reservations = new Map<string, CompositeReservation>();
  private readonly coordinatorMutex = new AsyncMutex();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(deps: CompositeDeliveryRegistryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  static isCompositeToken(token: string): boolean {
    return token.startsWith(COMPOSITE_PREFIX);
  }

  /** Planning spans several independently locked journals, while acknowledgements mutate the
   * shared per-child bitmap. One short-lived coordinator mutex prevents duplicate ACKs from
   * consuming/cancelling each other's child tokens and gives ordinary activity a safe point to
   * prune expired composites. This mutex has no durable meaning. */
  prepare<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinatorMutex.runExclusive(async () => {
      await this.pruneExpiredLocked();
      return operation();
    });
  }

  create(session: string, children: readonly CompositeReservationChild[]): string {
    if (children.length === 0) throw new Error("a composite delivery requires at least one child reservation");
    let token: string;
    do token = `${COMPOSITE_PREFIX}${this.id()}`;
    while (this.reservations.has(token));
    this.reservations.set(token, {
      session,
      expires_at: this.now() + COMPOSITE_TTL_MS,
      children: children.map((child) => ({ ...child, acknowledged: false })),
    });
    return token;
  }

  async acknowledge(
    token: string,
    session: string,
    outcome: "presented" | "failed",
    error?: string,
  ): Promise<CompositeAckResult> {
    return this.coordinatorMutex.runExclusive(async () => {
      await this.pruneExpiredLocked();
      const reservation = this.reservations.get(token);
      if (!reservation || reservation.session !== session) return "missing";
      if (reservation.outcome !== undefined && reservation.outcome !== outcome) return "outcome-conflict";
      reservation.outcome = outcome;

      for (const child of reservation.children) {
        if (child.acknowledged) continue;
        const acknowledged = await child.bus.acknowledgeDelivery(child.delivery_id, outcome, error);
        if (!acknowledged) {
          await this.releasePending(reservation);
          this.reservations.delete(token);
          return "missing";
        }
        // This bitmap only prevents a same-process HTTP retry from duplicating a child append. It
        // is not authority: after process loss, journal replay decides which entries were presented.
        child.acknowledged = true;
      }

      this.reservations.delete(token);
      return "acknowledged";
    });
  }

  private async pruneExpiredLocked(): Promise<void> {
    const now = this.now();
    const expired = [...this.reservations.entries()].filter(([, reservation]) => reservation.expires_at <= now);
    if (expired.length === 0) return;

    const releases = await Promise.allSettled(
      expired.map(async ([token, reservation]) => {
        try {
          await this.releasePending(reservation);
        } finally {
          this.reservations.delete(token);
        }
      }),
    );
    const failures = releases
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "expired composite reservation release failed");
  }

  private async releasePending(reservation: CompositeReservation): Promise<void> {
    await Promise.all(
      reservation.children
        .filter((child) => !child.acknowledged)
        .map((child) => child.bus.cancelDelivery(child.delivery_id)),
    );
  }
}
