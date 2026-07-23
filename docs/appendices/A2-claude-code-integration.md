# glosa ↔ Claude Code integration contract

This appendix specifies the provider boundary, delivery ladder, session registry, and transcript
mirror. The durable inbox and journal remain authoritative regardless of transport availability.

## F06 — optional Channels capability

Claude Channels are an optional first delivery rung. They are attempted during compatibility
rehearsal when the installed Claude Code build and policy allow them, but unavailable or rejected
Channels do not fail the gate when hook or MCP fallback presents the same durable entry.

For glosa's bare MCP server, the development activation command is:

```bash
claude --dangerously-load-development-channels server:glosa
```

Never invent or append a `--channels` flag. Consent and organization policy may still deny activation.
`glosa doctor` reports Channel status as optional and unverified unless a real current-session
registration signal exists; it never fabricates a pass from configuration presence.

A Channel notification accepted by the transport records `delivery_attempt` with
`via:"channel", outcome:"transport_accepted"`. Acceptance does not prove presentation and therefore
does not change lifecycle status by itself.

The stdio MCP shim reads `CLAUDE_CODE_SESSION_ID`, advertises
`capabilities.experimental["claude/channel"]`, and opens one authenticated serialized push stream for
that exact registered session. A live stream—not configuration or an activation flag—is Channel
availability. It emits `notifications/claude/channel` with the exact composer text and
`meta.message_id`, then records only `transport_accepted`.

Claude calls `glosa_conversation_ack` after the event reaches its context. That exact-session
acknowledgement records `presented` and the terminal conversation transition. Without it, the
immutable entry stays pending and remains eligible for hook/MCP presentation.

## F07 — delivery ladder and asyncRewake

Claude delivery uses the best capability available to that live session:

```text
Channel → asyncRewake → blocking/turn-boundary hook → MCP pull
```

- Every rung presents the same provider-neutral, UTF-8-bounded payload.
- A failed rung never mutates the immutable inbox entry.
- `delivery_attempt` is a separate journal axis; only an acknowledged presentation may append
  `delivered`.
- Hook and MCP paths are the required compatibility fallback.
- Targeted conversation entries are filtered by `target_session_id`; another bound session cannot
  drain or acknowledge them. Generic MCP pull requires an explicit registered session identity for
  these entries while untargeted inbox behavior remains unchanged.
- Stop and UserPromptSubmit drains are bounded to eight entries and 32 KiB per batch.

`asyncRewake` is one-shot. SessionStart arms one watcher; after a wake, Stop rearms it under a
per-session lease so repeated entries do not create duplicate watcher processes. If rearm is
unavailable, the blocking/turn-boundary and MCP rungs still work.

Hook output shapes:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<bounded actionable presentation>"
  }
}
```

```json
{
  "decision": "block",
  "reason": "<bounded actionable presentation>"
}
```

An async watcher writes the presentation to its hook stream before the process exits with the
rewake code. The shim acknowledges `presented` only after that write succeeds.

## F08 — session registry and explicit binding

Providers register through the daemon API; no hook writes registry files directly. A record contains:

```json
{
  "session_id": "opaque-provider-id",
  "provider": "claude-code",
  "cwd": "/workspace/agent-cwd",
  "transcript_path": "/allowed/config-root/projects/example/session.jsonl",
  "source": "hook",
  "last_active_at": "ISO-8601",
  "lease_expiry": "ISO-8601"
}
```

Liveness is lease plus activity heartbeat, never `kill(pid,0)`. Transcript paths must remain under the
configured Claude root after realpath confinement.

Routing precedence is fixed:

1. explicit `POST /w/:slug/session-binding`, `glosa session bind`, `glosa_session_bind`,
   `glosa open --bind <session-id>`, or `glosa_present` (host session or explicit `session_id`);
   open/present binding failures are nonfatal warnings that preserve the presentation URL;
2. generic cwd-ancestor matching;
3. park the entry until a session is registered and bound.

Bindings are session-scoped. An external integration restores them after session registration rather
than persisting workflow-specific state inside glosa. Two live sessions bound to one workspace require
an explicit hint or user choice; glosa never guesses and never auto-switches the SPA workspace.

## F15 — hook registration

`glosa init` owns only its signed entries and merges them transactionally:

| Claude event | glosa role |
|---|---|
| `SessionStart` | register/refresh session; drain parked entries; arm watcher |
| `SessionEnd` | release the session lease |
| `UserPromptSubmit` | refresh activity; bounded additional-context drain |
| `Stop` | bounded drain; rearm async watcher |
| `Notification` | update provider attention signal |

SessionStart accepts startup, resume, clear, and compact sources. Hook input is treated as untrusted:
unknown fields are ignored, required identifiers are validated, and failures degrade to the next
transport without losing inbox data.

## F16 — conversation mirror

The mirror is read-only. It tails the registered transcript using a vendored normalizer and never
writes JSONL. The composer sends a new user message through the provider delivery path; it does not
append to or edit the transcript.

Required parser behavior:

- buffer a partial final line until complete;
- quarantine unknown or malformed completed events without crashing the workspace;
- handle resume, clear, and compact boundaries;
- cap tool results and hide unsupported metadata safely;
- use opaque stream cursors and recover after rotation or truncation.

Any parser or discovery failure is fail-soft: show “mirror unavailable — use the terminal” while
artifact viewing, editing, annotation, and inbox delivery remain usable.

## Compatibility tests

1. Channels accepted when available, and unavailable Channels followed by successful hook/MCP fallback.
2. Three sequential async wakes do not duplicate watchers and fallback remains available.
3. Explicit binding routes across different agent/artifact working directories; parked entries drain.
4. Stop/UserPromptSubmit presentations obey byte/count limits and acknowledgement ordering.
5. Transcript fixtures cover partial, unknown, corrupt, resume, clear, compact, and large tool results.
6. Conversation delivery covers unacknowledged Channel transport, acknowledgement-tool success,
   exact-session hook/MCP fallback, wrong-session isolation, retries, and daemon restart.

The manual T8 report records the installed Claude Code version, actual session model, Channel attempt,
and the successful transport used. A Channel failure is reported, never hidden; fallback success is a
separate observed fact.
