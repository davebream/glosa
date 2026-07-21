// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-claude-code — the hook JSON shapes glosa actually reads (A2 §F08 "Cross-Cutting
// Minimum Hook JSON Schemas"). Deliberately minimal: Claude Code's hook payloads carry more fields
// than these (model, permission_mode, etc.) that glosa has no use for — these types only name what
// `detectSession`/the `glosa hook <event>` handlers consume, so a Claude Code version bump that adds
// fields never breaks this file, and one that REMOVES a field we read is the only kind of drift
// that can.

/** SessionStart hook stdin (A2 §F08). `source` distinguishes a fresh session from a `/resume`,
 * `/clear`, or `/compact` continuation — F26's SessionStart matcher is literally
 * `startup|resume|clear|compact`, i.e. every value this field can take. */
export interface SessionStartHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model?: string;
}

/** SessionEnd hook stdin — same envelope, no `source` (Claude Code doesn't document one for the
 * end event; glosa only needs `session_id` to release the registry entry + the rewake lease). */
export interface SessionEndHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: "SessionEnd";
}

/** UserPromptSubmit hook stdin — rung-3's additionalContext injection point. */
export interface UserPromptSubmitHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: "UserPromptSubmit";
  prompt?: string;
}

/** Stop hook stdin — rung-3's drain + the asyncRewake rearm trigger (A2 §F07). */
export interface StopHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: "Stop";
}

/** Notification hook stdin — feeds the R9 attention model's "hook-fed attention state" (preferred
 * over a transcript-stall heuristic, per R6). */
export interface NotificationHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: "Notification";
  message?: string;
}

export type ClaudeHookInput =
  | SessionStartHookInput
  | SessionEndHookInput
  | UserPromptSubmitHookInput
  | StopHookInput
  | NotificationHookInput;

/** Narrow, structural guard — checks only the fields glosa reads, not `hook_event_name` (some
 * call sites, e.g. `detectSession`, want to accept "anything with a session_id and cwd" rather
 * than reject a shape Claude Code emits that this file hasn't been told about yet). */
export function looksLikeClaudeHookInput(value: unknown): value is { session_id: string; cwd: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.session_id === "string" && v.session_id.length > 0 && typeof v.cwd === "string" && v.cwd.length > 0;
}

/** UserPromptSubmit hook output (A2 §F08 cross-cutting schema) — the rung-3 additionalContext
 * injection. */
export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

/** Stop hook output (block decision) — used only when the drain has entries worth surfacing as a
 * blocking reminder rather than silent additionalContext; most Stop drains just exit 0. */
export interface StopHookBlockOutput {
  decision: "block";
  reason: string;
}
