// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-claude-code — the structural guard `detectSession` (R7) uses to recognize a
// Claude Code session/event payload.

/** Narrow, structural guard — checks only the fields glosa reads, not any event-name discriminant
 * (the call site, `detectSession`, wants to accept "anything with a session_id and cwd" rather
 * than reject a shape Claude Code emits that this file hasn't been told about yet). */
export function looksLikeSessionPayload(value: unknown): value is { session_id: string; cwd: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.session_id === "string" && v.session_id.length > 0 && typeof v.cwd === "string" && v.cwd.length > 0;
}
