// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-codex — the structural guard `detectSession` (R7) uses to recognize a Codex
// session/event payload. Mirrors `packages/providers/claude-code/src/session-payload.ts`'s guard
// exactly (same two fields, same reasoning): every Codex `*CommandInput` struct carries
// `session_id`/`cwd` under those exact names (`docs/research/codex-contract.md` §1/§7).

/** Narrow, structural guard — checks only the fields glosa reads, not any event-name discriminant
 * (the call site, `detectSession`, wants to accept "anything with a session_id and cwd" rather
 * than reject a shape Codex emits that this file hasn't been told about yet). */
export function looksLikeSessionPayload(value: unknown): value is { session_id: string; cwd: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.session_id === "string" && v.session_id.length > 0 && typeof v.cwd === "string" && v.cwd.length > 0;
}
