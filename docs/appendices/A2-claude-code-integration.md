# glosa ↔ Claude Code Integration Spec (July 2026 / CC 2.1.x)

**Current verified against:** Claude Code 2.1.211+, documented Channels, SessionStart, Stop, UserPromptSubmit, asyncRewake behaviors.

---

## F06 — Channels Activation (Development Server Packaging)

**Finding:** The requirements state `--channels` plus a dev flag. Current official docs distinguish bare servers from plugins.

### Specification

**For a bare `.mcp.json` server (glosa v1 approach):**
- Registration: add `glosa` entry to `.mcp.json` with `command: "bun"` and args
- Activation: `claude --dangerously-load-development-channels server:glosa`
- Flags DO NOT combine: `--channels` (for allowlisted/plugin entries) and `--dangerously-load-development-channels` are mutually exclusive
- The development flag bypasses the Anthropic curated allowlist only for the specified entry
- Consent on first use: "New MCP server found in this project: glosa" dialog requires "Use this MCP server"
- Enterprise/org policy: `channelsEnabled` org policy still applies and can block even with the dev flag

**Hooked Output (Stop hook drain):**
```json
{
  "via": "channel",
  "session": "<session-id>",
  "attempt": "channel_notification",
  "accepted_at": "ISO-8601",
  "channel_source": "server:glosa"
}
```

**Journal Event Schema:**
```json
{
  "at": "ISO-8601",
  "entry": "inb-<id>",
  "event": "delivery_attempted",
  "by": "hook:deliver-ladder",
  "detail": {
    "rung": 1,
    "transport": "channel",
    "method": "notifications/claude/channel",
    "meta_keys": ["any-key", "with-underscores"],
    "server_name": "glosa",
    "notification_accepted": true,
    "resolution_required": "no"
  }
}
```

**Doctor Check:**
```bash
glosa doctor channels
# Outputs:
# ✓ glosa registered in .mcp.json (command: bun, args: [...])
# ? Channel MCP loaded: starting test session with --dangerously-load-development-channels server:glosa
# ✓ Handshake: channel=glosa active in this session
# Channels status: REGISTERED & ACTIVE in current session
# Launch hint: claude --dangerously-load-development-channels server:glosa
```

**Minimum Version:** Claude Code 2.1.80 (Channels research preview).

---

## F07 — asyncRewake Lifecycle & Rearm Protocol

**Finding:** A SessionStart-launched watcher exits on first wake; repeated inbox entries silently lose rung 2.

### Specification

**Hook Configuration:**
```json
{
  "type": "command",
  "name": "glosa-watcher",
  "matchers": ["SessionStart"],
  "command": "glosa",
  "args": ["await-entries", "--session", "$SESSION_ID"],
  "async": true,
  "asyncRewake": true,
  "description": "Background watcher for new inbox entries; wakes the session on arrival"
}
```

**Exit Behavior:**
- Exit code 0: normal (no new entries yet, process continues)
- Exit code 2: rewake triggered; stderr (or stdout if stderr empty) becomes a system reminder
- Process lifetime: NOT automatically re-spawned after rewake; it exits after the first code-2 wake
- Rewake message (stderr): `"glosa: inbox/${entry_id} pending (via ${transport})"` (one-liner, ≤160 chars)

**Rearm State Machine:**

The hook runs once per `SessionStart`, not repeatedly. Glosa implements rearm via a **per-session persistent watcher state** stored in `~/.glosa/sessions.json`:

```json
{
  "abc123": {
    "session_id": "abc123",
    "cwd": "/path/to/workspace",
    "watcher_pid": 12345,
    "watcher_started": "ISO-8601",
    "watcher_state": "running",
    "last_wake": "ISO-8601",
    "wake_count": 1,
    "entries_delivered": ["inb-xxx", "inb-yyy"]
  }
}
```

**Rearm Transitions:**

1. **SessionStart matches "startup" or "resume"**: daemon starts a new watcher process (or reattaches to running one if PID still valid)
2. **First asyncRewake exit(2)**: watcher process exits; daemon records wake and increments counter
3. **Second inbox entry arrives during same session**: daemon checks watcher state, finds it dead, starts a fresh watcher process
4. **Multiple sequential entries**: pattern repeats (new entry → new watcher spawn per entry)

**Duplicate-Watcher Prevention (per-session lease):**
- Lease file: `~/.glosa/.sessions/abc123.watcher.lock`
- Content: `{ "pid": 12345, "started": "ISO-8601" }`
- Mechanism: `openSync(path, 'wx')` (exclusive create); stale PIDs reclaimed after 30s staleness
- Prevents two sessions with same ID from spawning concurrent watchers

**Journal Events:**
```json
[
  {
    "at": "ISO-8601",
    "entry": "inb-xxx",
    "event": "delivery_attempted",
    "by": "daemon",
    "detail": {
      "rung": 2,
      "transport": "asyncRewake",
      "session": "abc123",
      "watcher_spawned": true,
      "watcher_pid": 12345
    }
  },
  {
    "at": "ISO-8601",
    "entry": "inb-xxx",
    "event": "rewake_signaled",
    "by": "daemon",
    "detail": {
      "watcher_pid": 12345,
      "exit_code": 2,
      "stderr": "glosa: inbox/inb-xxx pending (via asyncRewake)",
      "entries_pending": 0,
      "next_entry": null,
      "watcher_state_after": "exited"
    }
  }
]
```

**Minimum Version:** Claude Code 2.1.0 (asyncRewake primitive, undocumented rearming behavior — production stability: treat as best-effort, fallback to rung 3/4).

---

## F08 — Session Registry: Provider Binding & Liveness

**Finding:** Hook input lacks Claude PID; registry omits `transcript_path` and `last_active_at`; R2 routing cannot map jethro plugin-data artifacts.

### Specification

**Hook Input Schema (SessionStart JSON object on stdin):**

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/name/.claude/projects/my-repo-slug/abc123.jsonl",
  "cwd": "/Users/name/code/my-repo",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-5"
}
```

**Missing Field:** NO `pid` or `ppid` field is documented or provided. (Codex F08 finding confirmed.)

**Registry Schema (stored in daemon memory + serialized to `~/.glosa/sessions.json`):**

```json
{
  "session:abc123": {
    "session_id": "abc123",
    "provider": "claude-code",
    "cwd": "/Users/name/code/my-repo",
    "transcript_path": "/Users/name/.claude/projects/my-repo-slug/abc123.jsonl",
    "last_active_at": "ISO-8601",
    "last_active_entry": "inb-xxx",
    "source": "startup",
    "model": "claude-sonnet-5",
    "lease": {
      "holder": "SessionStart",
      "expires_at": "ISO-8601"
    },
    "bindings": [
      {
        "workspace_path": "/Users/name/code/my-repo/.glosa",
        "binding_source": "jethro-adapter",
        "data": { "sermon_session_id": "2026-07-20_j-1,1-18" }
      }
    ]
  }
}
```

**Key Fields:**

- `transcript_path`: extracted directly from SessionStart hook; used to tail conversation viewer
- `last_active_at`: updated on **every SessionStart, UserPromptSubmit, or Stop hook** (three sources)
- `lease`: issued by SessionStart hook; auto-expires in 60s (heartbeat buffer); refreshed on each hook
- `bindings[].workspace_path`: explicit provider-supplied workspace associations (overrides cwd fallback)
- `bindings[].binding_source`: which adapter/mechanism created the binding (jethro-adapter, manual, inferred)

**Liveness Without PID:**

1. **Lease-based (primary):** SessionStart hook renews the lease on every hook firing; expiry = now + 60s
2. **Activity-based (secondary):** last_active_at used to prune stale sessions on read; hard expiry = 30 min
3. **No process check:** never call `kill(pid, 0)`. The lack of documented PID means any per-process check is unsupported

**SessionEnd Hook Behavior:**

SessionEnd fires when session ends and has ~1.5s total budget. Glosa implementation:

```bash
glosa resolve --session "$SESSION_ID" --mark-ended
```

This atomically:
1. Sets session status to `ended_at: ISO-8601`
2. Marks all `pending` entries in that session as `parked_until_next_session`
3. Removes the session from the active registry (keeps journal audit trail)

**Parked Entry Drain:**

The next SessionStart in the **same workspace** (same cwd) automatically drains by:
1. Reading `session_history` from jethro's `state.json` if present (adapter binding)
2. Checking for any parked entries in that workspace
3. Marking them `delivered` and scheduling delivery via the active session

**Routing Algorithm (R2 + F08):**

```
Route(entry, workspace) →
  1. Check bindings[] for explicit provider-supplied workspace match
     → Use that binding's session_id (jethro-adapter example)
  2. Check active sessions with session.cwd = nearest ancestor of entry.file
     → Pick the most-recently-active (max last_active_at)
  3. If multiple same-recency sessions in one cwd → surface picker, user picks
  4. If no live session → park entry; drain on next SessionStart
```

**Journal Events:**

```json
[
  {
    "at": "ISO-8601",
    "event": "session_registered",
    "by": "hook:SessionStart",
    "detail": {
      "session_id": "abc123",
      "source": "startup",
      "cwd": "/Users/name/code/my-repo",
      "transcript_path": "/Users/name/.claude/projects/my-repo-slug/abc123.jsonl",
      "lease_expires": "ISO-8601"
    }
  },
  {
    "at": "ISO-8601",
    "event": "binding_registered",
    "by": "jethro-adapter",
    "detail": {
      "session_id": "abc123",
      "workspace_path": "/Users/name/code/my-repo/.glosa",
      "binding_type": "jethro-session",
      "jethro_session_id": "2026-07-20_j-1,1-18"
    }
  }
]
```

**Minimum Version:** Claude Code 2.1.0 (SessionStart hook, transcript_path field). Doctor check verifies registry integrity and binding sources.

---

## F16 — Transcript Tailing Contract

**Finding:** No contract for partial lines, unknown events, resume/clear/compact, sidechains, tool-result caps, or parser recovery.

### Specification

**Source (Authoritative):**

- Path from `SessionStart.transcript_path` hook input (not derived from cwd)
- File: `.jsonl` format (one JSON object per line = one "record")
- Encoding: UTF-8; newlines are `\n` only (not `\r\n` on Windows)
- Fallback root: `$CLAUDE_CONFIG_DIR/projects/<slug>/<session-id>.jsonl` (per official docs)

**Record Schema (one JSON object per line):**

The documentation states the format is **internal to Claude Code and changes between versions**. Glosa MUST NOT parse directly; instead vendor a **normalized event abstraction**:

```typescript
type TranscriptEvent =
  | { type: "message"; role: "user" | "assistant"; content: string; id: string }
  | { type: "tool_use"; tool_name: string; tool_id: string; input: Record }
  | { type: "tool_result"; tool_id: string; content: string; size: number }
  | { type: "text"; role: "assistant"; content: string }
  | { type: "unknown"; raw: string; line_num: number }
```

**Partial Line Handling (CRITICAL):**

1. **Last line buffering:** keep the last read offset and line boundary
2. **Incomplete line detection:** if a line has no trailing `\n`, buffer it and retry after 100ms
3. **Timeout:** abandon a partial line after 5s (treat as complete, log warning)
4. **Resume:** on reconnect, re-read from last complete line offset; discard stale buffer

**Unknown Event Quarantine:**

- Any line that does not deserialize to valid JSON, or JSON that does not match known shape → `type: "unknown"`
- Log unknown events with line number and first 200 chars of raw text
- Continue parsing from the next line; do NOT abort the whole pane
- Metrics: expose unknown-event count to `glosa doctor status` (without telemetry)

**State Transitions (resume, clear, compact, fork):**

| Command | Transcript Effect | Glosa Behavior |
|---------|---|---|
| `/resume` | Opens a different session's transcript file | Daemon closes old tailer, opens new transcript_path |
| `/clear` | New empty transcript file for same session_id | Tailer sees truncation or inode change; resync from 0 |
| `/compact` | Replaces history with summary; new transcript_path (usually same file, appended) | Tailer continues from last offset; no file change expected |
| `/branch` | New session_id with copy of old transcript | New SessionStart hook fired; new session_id registered; separate tailer instance |
| `/fork-session` | (same as `/branch` from CLI) | (same as `/branch`) |

**Resume/Clear/Compact Resync Heuristic:**

```
On Read Error or Lag Detected:
  1. Query session via SessionStart hook (or check active registry)
  2. If transcript_path changed → close old tailer, open new
  3. If file size < last_offset → truncation; resync from 0, log warning
  4. If inode changed → file rotated; re-open new inode
  5. If read stalls >10s → session may be idle or crashed; keep tailer alive, do not auto-close
```

**Subagent Sidechains:**

- Subagent transcripts are stored separately under the same `$CLAUDE_CONFIG_DIR/projects/...` tree
- Main transcript may contain a reference like `subagent_id: "xyz"` or similar (format undocumented; vendor parser knowledge only)
- Glosa v1 does NOT attempt to follow subagent links; main-session events are rendered, subagent activity not mirrored
- Future: adapters may plug in subagent awareness

**Tool Result Caps:**

```json
{
  "type": "tool_result",
  "tool_id": "x",
  "content": "... truncated at 10KB ...",
  "size_bytes": 10240,
  "size_original": 250000,
  "truncated": true
}
```

- In-memory cap per event: 10 KB (retain start + "... truncated ..." marker + 200 chars of end)
- DOM cap per rendered event: 50 KB of HTML (overflow: hidden, collapsed by default in UI)
- No streaming of large tool results; fetch from transcript file as needed

**Event Size Limits (per message):**

- `content` field: cap at 100 KB after truncation
- `tool_input`: cap at 50 KB
- Metadata (tool_id, role, etc.): unlimited (expected to be small)

**Failure Recovery:**

```
Parse Error on Line N:
  1. Log: "Transcript parse error at line 1234: <reason>"
  2. Increment unknown-event counter
  3. Continue from line N+1
  4. If unknown events exceed 20% of total or >100 consecutive → fail soft:
     Show "Mirror unavailable — use the terminal to interact" in UI
     Keep last-good snapshot rendered; do not auto-hide
  5. Metrics (local, no telemetry): expose parse-error count in `glosa doctor status`
```

**Tailer Lifecycle:**

- Start on SPA first view of conversation pane
- Stop on workspace switch or SPA exit (graceful close; no force-kill)
- Restart on workspace re-entry; resume from last offset
- Idle timeout: none (keep stream open indefinitely if session is live)

**Minimum Version:** Claude Code 2.1.0 (transcript_path in SessionStart hook). Vendor `TranscriptEvent` normalization rather than parsing internal format; no guarantee of stability across CC versions.

---

## Cross-Cutting Minimum Hook JSON Schemas (All Hooks)

**SessionStart Input (minimal example):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/.../abc123.jsonl",
  "cwd": "/path/to/cwd",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-5"
}
```

**Stop Hook Output (block decision):**
```json
{
  "decision": "block",
  "reason": "Validation required before stopping"
}
```

**UserPromptSubmit Output (block + context):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "New inbox entries ready for review"
  }
}
```

**asyncRewake Hook Rewake (exit code 2):**
```bash
exit 2  # stderr/stdout is shown to Claude as a reminder
```

**Minimum Claude Code Version (for all): 2.1.80** (Channels research preview, stable hooks, SessionStart schema).

---

## Testing Requirements (per Codex §5.7)

1. **Deterministic storage/fault suite:** kill daemon after each journal append; verify recovery
2. **Concurrency suite:** simultaneous SessionStart hooks, multiple entries arriving, stale watcher processes
3. **Delivery suite:** two consecutive asyncRewake events; Channel unregistered; Stop cap behavior
4. **Registry suite:** jethro cwd/plugin-data topology routing; parked entry drain on next SessionStart
5. **Transcript suite:** partial line buffering; unknown events; resume/clear/compact state transitions

---

**Version:** 2026-07-20  
**CC Minimum:** 2.1.80 (Channels research preview)  
**Authority:** Official code.claude.com documentation + verified hook behavior via WebFetch
