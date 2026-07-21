// @glosa/providers-codex — the Codex hook JSON shapes glosa reads, pinned against real Codex CLI
// source (`docs/research/codex-contract.md`, T2a) rather than the Plannotator-era guess. Every
// `*CommandInput` struct in `codex-rs/hooks/src/schema.rs` carries `session_id`/`cwd` under those
// exact snake_case names — same convention Claude Code uses — so this file deliberately mirrors
// `packages/providers/claude-code/src/hook-types.ts`'s shape rather than inventing a parallel one.
// Minimal by the same principle as the Claude file: Codex's real payloads carry more fields
// (`model`, `permission_mode`, `turn_id`, …) this package has no use for; only what
// `detectSession`/a future `glosa hook codex <event>` handler consumes is named here.

/** `SessionStart` hook stdin (codex-contract.md §4). `source`'s four values are byte-identical to
 * Claude Code's own `SessionStartHookInput.source` — verified directly against
 * `SessionStartCommandInput` in `codex-rs/hooks/src/schema.rs`. */
export interface CodexSessionStartHookInput {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model?: string;
}

/** `SessionEnd` hook stdin — `SessionEndCommandInput` (codex-contract.md §4). No documented PID,
 * same as every other Codex hook payload. */
export interface CodexSessionEndHookInput {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: "SessionEnd";
  reason?: string;
}

/** `UserPromptSubmit` hook stdin — `UserPromptSubmitCommandInput` (codex-contract.md §3). One of
 * the two rungs `gate`/`boundaryDrain` collapse onto, same as Claude's. */
export interface CodexUserPromptSubmitHookInput {
  session_id: string;
  turn_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt?: string;
}

/** `Stop` hook stdin — `StopCommandInput` (codex-contract.md §2), the blocking-gate rung. Codex's
 * `decision:block` requires a non-empty `reason` (empty/whitespace-only is a hook FAILURE, not a
 * no-op — codex-contract.md §2) — that's a `glosa hook codex stop` handler concern (later T-task),
 * not this file's, but it's why this type exists at all: the handler needs to know the shape it's
 * responding to. */
export interface CodexStopHookInput {
  session_id: string;
  turn_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: "Stop";
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

export type CodexHookInput =
  | CodexSessionStartHookInput
  | CodexSessionEndHookInput
  | CodexUserPromptSubmitHookInput
  | CodexStopHookInput;

/** Narrow, structural guard — mirrors `looksLikeClaudeHookInput` exactly (same two fields, same
 * reasoning: accept anything carrying `session_id`/`cwd` rather than gate on `hook_event_name`, so
 * a Codex version bump that adds event types or fields never breaks `detectSession`). */
export function looksLikeCodexHookInput(value: unknown): value is { session_id: string; cwd: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.session_id === "string" && v.session_id.length > 0 && typeof v.cwd === "string" && v.cwd.length > 0;
}

/** `Stop` hook output for the blocking-gate rung (codex-contract.md §2) — exit 0, this JSON on
 * stdout. `reason` MUST be non-empty: Codex's own hook runtime treats `decision:block` with an
 * empty/whitespace-only `reason` as a hook FAILURE, not a silent no-op (verified in
 * `codex-rs/hooks/src/events/stop.rs`'s `block_decision_with_blank_reason_fails_instead_of_blocking`
 * test). Mutually exclusive with `continue:false` in the same response — `continue:false`
 * unconditionally overrides a `decision:block` in the same payload. */
export interface CodexStopHookBlockOutput {
  decision: "block";
  reason: string;
}
