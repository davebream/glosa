// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the daemon-wide attention feed (#389). The desktop shell's Dock badge and its
// notifications count attention across every workspace (docs/design/2026-09-25-desktop-shell-
// feature-map.md §4, decision 4), but a page's stream (`GET /w/:slug/stream`) only carries its own
// workspace's journal. This fans every workspace bus's attention events out to one set of
// listeners, so each open workspace stream can forward `attention_changed {slug}` for all of them.
//
// Which events count is read off the bus's own derived state, not a list of event names: the bus
// applies an event before notifying (bus.ts), so `state.entries[event.entry].kind === "attention"`
// holds for the creating `entry_created`, every `attention_committed`, an adoption, a dismissal,
// and anything added later, with no second list to keep in step with lifecycle.ts.
import type { WorkspaceTarget } from "../workspace.ts";
import type { WorkspaceBus } from "./bus.ts";

export type AttentionListener = (slug: string) => void;

export class AttentionFeed {
  private readonly listeners = new Set<AttentionListener>();

  /** `slugFor` resolves a bus's workspace to the slug the SPA knows it by, at emit time; a
   * workspace with no slug (not registered, or forgotten since) emits nothing. */
  constructor(private readonly slugFor: (workspace: WorkspaceTarget) => string | undefined) {}

  /** Observes one bus. Returns the unsubscribe; the caller ties it to the bus's close. */
  attach(bus: WorkspaceBus, workspace: WorkspaceTarget): () => void {
    return bus.subscribe(({ event }) => {
      if (event.entry === undefined) return;
      if (bus.state.entries[event.entry]?.kind !== "attention") return;
      const slug = this.slugFor(workspace);
      if (slug !== undefined) this.emit(slug);
    });
  }

  subscribe(listener: AttentionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(slug: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(slug);
      } catch {
        // One broken stream never stops the others from hearing about attention.
      }
    }
  }
}
