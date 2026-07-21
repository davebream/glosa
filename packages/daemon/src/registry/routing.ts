// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — R2's routing decision. Pure orchestration over a `SessionRegistry`: given a
// workspace an entry is destined for, decide which live session (if any) should receive it.
// Never guesses (R2: "never guess") — two live sessions with no `sessionHint` naming either one
// always surfaces a picker rather than silently choosing one.
import type { SessionRegistry } from "./session-registry.ts";

export type RouteResult =
  | { target: string }
  | { needsPicker: string[] }
  | { parked: true };

/** `workspaceCanonical` must already be canonicalized (see slug.ts's `canonicalize`) — routing
 * doesn't re-derive identity, it just consults the registry with whatever path it's given.
 *
 * MUST stay fully synchronous — no `await` anywhere in this function. `registry.markParked()`
 * below touches `SessionRegistry`'s `parkedWorkspaces` set OUTSIDE its mutex (see the comment on
 * `markParked` in session-registry.ts); the only reason that's safe is that this whole call runs
 * to completion in one tick, so it can never interleave with a concurrent `register()`'s drain
 * check. Adding an `await` here would reopen that race. */
export function route(registry: SessionRegistry, workspaceCanonical: string, opts: { sessionHint?: string } = {}): RouteResult {
  const live = registry.forWorkspace(workspaceCanonical);

  if (live.length === 0) {
    // R2: "No live session -> the entry parks; next session registration for that workspace
    // drains it." Recording the park is a side effect of this decision, not a separate step the
    // caller has to remember to perform.
    registry.markParked(workspaceCanonical);
    return { parked: true };
  }

  if (live.length === 1) {
    const only = live[0] as (typeof live)[number];
    return { target: only.session_id };
  }

  if (opts.sessionHint) {
    const hinted = live.find((r) => r.session_id === opts.sessionHint);
    if (hinted) return { target: hinted.session_id };
  }
  // Multiple live sessions bound to one workspace, no hint naming either — surface a picker
  // rather than guessing (R2).
  return { needsPicker: live.map((r) => r.session_id) };
}
