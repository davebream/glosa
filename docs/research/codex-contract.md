# Codex CLI integration contract (T2a)

Pins the concrete mechanics the `packages/providers/codex` `AgentProvider` implementation is built
against — per requirements.md T2a: "verify current (mid-2026) Codex CLI hook/gate/transcript-file
mechanics against real docs/source — the Plannotator-era 'Codex Stop-hook + rollout-file parsing'
note is the starting point, not gospel."

**Verified 2026-07-21** against the `openai/codex` GitHub repository's `main` branch source (not
blog paraphrase) — specifically `codex-rs/hooks/src/schema.rs`, `codex-rs/hooks/src/events/{session_start,stop,user_prompt_submit,session_end,common}.rs`,
and `codex-rs/core/src/hook_runtime.rs`. Secondary confirmation from the official docs at
`developers.openai.com/codex/hooks` (redirects to `learn.chatgpt.com/docs/hooks`) and
`developers.openai.com/codex/mcp`, which agree with the source on every point checked. Where the
two sources agreed, that's marked **CONFIRMED**; where only inferred from source without an
explicit docs statement, marked **INFERRED (source-grounded)**; where neither source answered the
question, marked **UNCONFIRMED**.

The headline finding: Codex CLI's hook system (as of mid-2026) is no longer the old single
`notify`-on-turn-complete callback the Plannotator-era note assumed. It has grown into a
multi-event hook framework (`hooks.json` / `config.toml [hooks]`) whose event names, JSON field
names, and blocking semantics are close enough to Claude Code's own hooks that the two providers
can share almost the same shape of logic — this made the provider genuinely easy to build to spec,
not a coincidence to be suspicious of; Anthropic and OpenAI hook conventions appear to have
converged independently on the same `session_id`/`cwd`/`transcript_path`/`hook_event_name` /
`decision:block` vocabulary.

## 1. Hook events that exist **CONFIRMED**

`codex-protocol::protocol::HookEventName`: `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, `Stop`. Discovery order (highest to lowest precedence, later merges rather than
replaces): `~/.codex/hooks.json` → `~/.codex/config.toml [hooks]` → `<repo>/.codex/hooks.json`
(requires the project be trusted) → `<repo>/.codex/config.toml [hooks]` → plugin-bundled
`hooks/hooks.json` → org-enforced `requirements.toml` managed hooks.

There is **no `Notification` event** — Claude Code's attention-state hook (R6: "Attention state
from the provider's `Notification` hook, not a transcript stall heuristic") has no Codex
equivalent. `PermissionRequest` fires when Codex needs an approval decision, which is the closest
analog, but it's a distinct signal (approval-needed, not "the agent flagged something for the
human") — **this is an honest gap, not solved by this task** (the Codex provider doesn't implement
an attention channel; R9's attention model falls back to whatever the generic/no-hook default is
for a Codex session).

## 2. The blocking gate → Codex's `Stop` hook **CONFIRMED (source)**

`codex-rs/hooks/src/events/stop.rs` — `Stop` fires when the agent's turn completes; it is
synchronous/blocking (the turn genuinely does not finish until every matched handler returns).

**Stdin** (`StopCommandInput`, `codex-rs/hooks/src/schema.rs:575`), one JSON object on stdin,
snake_case fields, no camelCase transform:
```json
{
  "session_id": "<thread-id string>",
  "turn_id": "<string>",
  "transcript_path": "<path string> | null",
  "cwd": "<absolute path string>",
  "hook_event_name": "Stop",
  "model": "<model slug>",
  "permission_mode": "<string>",
  "stop_hook_active": false,
  "last_assistant_message": "<string> | null"
}
```
(`SubagentStop` carries the same shape plus `agent_transcript_path`, `agent_id`, `agent_type`.)

**Stdout/exit contract** — glosa's Codex hook handler for the gate rung must emit exactly this:
- Exit 0, stdout `{"decision":"block","reason":"<non-empty string>"}` → the turn is blocked from
  actually stopping; `reason` is injected as a **continuation prompt fragment** for the next turn
  (`StopOutcome.continuation_fragments`, via `codex_protocol::items::HookPromptFragment`) — this is
  the delivery mechanism: the pending entry's content rides in `reason`. A `block` with an empty/
  whitespace-only `reason` is rejected as a hook **failure** (`HookRunStatus::Failed`), not treated
  as a no-op — glosa must never emit an empty reason.
- Exit 0, stdout `{"continue":false,"stopReason":"..."}` → stops processing entirely and
  **overrides** any `decision:block` in the same payload (verified directly in
  `stop.rs`'s `continue_false_overrides_block_decision` test) — glosa's hook handler must never
  emit both in the same response.
- Exit code **2**, non-empty stderr → same blocking effect as `decision:block`, with stderr as the
  reason (a legacy/scriptable alternative to the JSON form — glosa's daemon-invoked hook always
  controls its own exit code, so this repo uses the JSON form, not this path).
- Empty/no stdout on exit 0 → hook completes as a no-op (`HookRunStatus::Completed`), nothing
  delivered.

This is Codex's Stop-hook analog of Claude's `decision:block` — confirms the R4 table's "their hook
gate (Codex Stop-hook etc.)" row is accurate, and gives the exact JSON glosa's `glosa hook codex
stop` handler (out of scope for this task — the CLI wiring is a later T-task) must produce.

## 3. Turn-boundary drain — same `Stop` hook, non-blocking form **CONFIRMED (source)**

Codex has no separate "async drain" hook distinct from `Stop`/`UserPromptSubmit` — exactly as
Claude Code doesn't either (the existing `ClaudeCodeProvider.deliver()` already collapses `gate`
and `boundaryDrain` into one rung for this reason, `packages/providers/claude-code/src/provider.ts:146`).
For Codex the non-blocking path is the same `Stop` hook (or `UserPromptSubmit`, stdin shape below)
returning plain stdout text or `hookSpecificOutput.additionalContext` instead of `decision:block` —
this surfaces the pending entry as context without holding up the turn. The Codex provider mirrors
Claude's design: `gate` and `boundaryDrain` collapse into one ladder rung, `via:"gate"`.

**`UserPromptSubmit` stdin** (`UserPromptSubmitCommandInput`, `schema.rs:554`):
```json
{
  "session_id": "<thread-id string>",
  "turn_id": "<string>",
  "agent_id": "<string> | (omitted)",
  "agent_type": "<string> | (omitted)",
  "transcript_path": "<path string> | null",
  "cwd": "<absolute path string>",
  "hook_event_name": "UserPromptSubmit",
  "model": "<model slug>",
  "permission_mode": "<string>",
  "prompt": "<the user's submitted prompt text>"
}
```

## 4. `SessionStart` — session identity + `source` **CONFIRMED (source)**

`SessionStartCommandInput` (`schema.rs:486`):
```json
{
  "session_id": "<thread-id string>",
  "transcript_path": "<path string> | null",
  "cwd": "<absolute path string>",
  "hook_event_name": "SessionStart",
  "model": "<model slug>",
  "permission_mode": "<string>",
  "source": "startup" | "resume" | "clear" | "compact"
}
```
`source`'s four values are byte-identical to Claude Code's own `SessionStartHookInput.source`
enum (`packages/providers/claude-code/src/hook-types.ts:16`) — no translation needed between
providers for this field. `SessionEnd` also exists (`SessionEndCommandInput`, `schema.rs:502`) with
`session_id`/`transcript_path`/`cwd`/`hook_event_name`/`reason`, mirroring Claude's `SessionEnd`.

**No PID anywhere in any Codex hook payload** — same as Claude Code (A2 §F08's finding). Confirms
liveness must be lease/heartbeat-only for Codex too; there's no `kill(pid,0)` even to be tempted by.

## 5. Transcript / rollout file **CONFIRMED (docs) + INFERRED (source, path pattern)**

Every Codex hook payload above carries `transcript_path` directly — glosa never has to derive or
guess the path (same as Claude). Independently, Codex's on-disk session storage (for `codex
resume`) lives at `~/.codex/sessions/YYYY/MM/DD/rollout-<session-id>.jsonl` — one JSONL file per
session recording the full event stream (prompts, model responses, tool calls/results, approval
decisions, token counts). `transcriptPath()` on the provider returns `session.transcript_path`
verbatim, exactly like the Claude provider — it never needs to reconstruct the `YYYY/MM/DD` path
itself. The **JSONL line format itself** (per-event schema for the conversation-mirror parser, R6's
"vendored normalized `TranscriptEvent` layer") is **UNCONFIRMED** at the field level — that's a
separate, later task (the conversation mirror's Codex event mapper), not required for the
`AgentProvider` interface this task implements, and is flagged here rather than guessed.

## 6. MCP — Codex as a client only **CONFIRMED (docs)**

Codex CLI's documented MCP support (`developers.openai.com/codex/mcp`, `codex mcp add/list/login`,
config at `~/.codex/config.toml` `[mcp_servers.<name>]` or project-scoped `.codex/config.toml` for
trusted projects) is **client-only** — Codex connects out to MCP servers; there is no documented
`codex mcp-server`/equivalent making Codex itself callable as a server. This is exactly the shape
`mcpPull` needs: glosa runs its own MCP server (the existing `glosa mcp` tool, same one the Claude
provider's rung 4 targets), and a Codex session has `glosa` registered as one of its `mcp_servers` —
the pull direction is "Codex calls glosa's tool," never "glosa calls into Codex." No Codex-side
capability gap here; the mechanism is identical in shape to Claude's mcpPull, just configured via
`config.toml` instead of `.mcp.json`.

## 7. The concrete provider contract this pins

| R4 rung | Claude Code | Codex | Codex mechanism |
|---|---|---|---|
| push (async, idle) | channels | **none** | no equivalent exists (confirmed absent, not just unconfirmed) |
| gate (blocking) | Stop/UserPromptSubmit hook `decision:block` | Stop hook `decision:block` + non-empty `reason` | §2 above |
| boundaryDrain (async) | Stop/UserPromptSubmit hook, non-blocking | Stop/UserPromptSubmit hook, non-blocking (plain stdout / `additionalContext`) | §3 above |
| mcpPull | `glosa mcp` tool via `.mcp.json` | `glosa mcp` tool via `config.toml [mcp_servers.glosa]` | §6 above |

`capabilities = { push: false, gate: true, boundaryDrain: true, mcpPull: true }` — no channels-
equivalent push, matching R7's "Codex provider (gate + boundaryDrain + mcpPull; push=false — no
channels-equivalent)" verbatim, now backed by source rather than assumption.

`detectSession(hookEvent)` accepts any payload carrying `session_id` (string) + `cwd` (string) —
structurally identical guard to Claude's `looksLikeClaudeHookInput`, since every Codex
`*CommandInput` struct carries exactly those two fields under exactly those two names. `source`
comes from the payload's own `source` field when present (`SessionStart`), else falls back to
`hook_event_name` (`Stop`/`UserPromptSubmit`/etc. carry no `source` field), exactly mirroring the
Claude provider's fallback (`packages/providers/claude-code/src/provider.ts:74`).

## 8. What's honestly unresolved

- **No attention-hook equivalent** (§1) — out of scope for the `AgentProvider` interface (R7), but
  worth flagging for whoever builds R9's attention model against a Codex session: it will need a
  different signal than Claude's `Notification` hook, or degrade gracefully.
- **Rollout JSONL event schema** (§5) — path is confirmed, line-level event shape is not; the
  conversation-mirror's Codex event mapper is a separate, later piece of work.
- **Whether `codex --dangerously-*`-style flags exist for anything Codex-side analogous to Claude's
  channels** — not found in either source; treated as confirmed-absent per §7, but if a future
  Codex release adds an async push mechanism, `capabilities.push` and this doc both need revisiting.
- This document reflects the `openai/codex` `main` branch on 2026-07-21. Codex CLI is a fast-moving
  target (T2a's own framing: "may be a moving research target") — a version pin worth re-checking
  before the T8 release gate.
