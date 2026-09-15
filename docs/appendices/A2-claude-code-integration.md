# glosa ↔ Claude Code integration contract

This appendix specifies the provider boundary, delivery ladder, session registry, and transcript
mirror. The durable inbox and journal remain authoritative regardless of transport availability.

## F06 — plugin monitor capability

The Claude plugin is the install boundary. It carries `.mcp.json`, an always-declared per-session
monitor, the `glosa-connect` skill, and a launcher that resolves a local glosa executable without a
`PATH` lookup or download. The monitor receives its exact identity from
`CLAUDE_CODE_SESSION_ID`; `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are expanded into its
command arguments because Claude does not place them in the monitor environment.

The monitor reads `workspaces.json` without mutating it. Outside a registered workspace it waits for
that file to change and makes no daemon request. Once the project is registered, it registers with
`source:"monitor"`, opens `GET /api/sessions/:id/stream`, and holds the session lease through that
connection. It never starts or repairs a daemon. A disconnect retries with jittered exponential
backoff whose floor is five seconds and whose cap is sixty seconds.

Each bounded stream presentation is written as one stdout line beginning `[glosa <entry-id>]`.
Successful stdout completion records `via:"monitor", outcome:"transport_accepted"`; it is still
eligible for MCP pull. Claude calls `glosa_delivery_ack` with the in-band id after the line reaches
agent context. Only that exact-session acknowledgement records `presented`; conversation messages
then make their terminal transition.

Claude suppresses plugin monitors when `DISABLE_TELEMETRY=1` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and does not run them for noninteractive or unsupported
hosted-model sessions. `push` is therefore true only while a monitor is connected. MCP tools still
load in those modes, and doctor names the environment-variable case rather than implying delivery is
broken.

## F07 — monitor delivery and fallback

Claude delivery uses the best capability available to that live session:

```text
plugin monitor → MCP pull
```

- Every rung presents the same provider-neutral, UTF-8-bounded payload.
- A failed rung never mutates the immutable inbox entry.
- `delivery_attempt` is a separate journal axis; only an acknowledged presentation may append
  `delivered`.
- MCP pull is the required compatibility fallback.
- Targeted conversation entries are filtered by `target_session_id`; another bound session cannot
  drain or acknowledge them. Generic MCP pull requires an explicit registered session identity for
  these entries while untargeted inbox behavior remains unchanged.
- The stream emits at most eight entries per selection pass, with 16 KiB per entry and the same
  32 KiB batch presentation contract used by pull.

There are no other rungs. Channels, the `asyncRewake` watcher, the `SessionStart`/`SessionEnd`/
`UserPromptSubmit`/`Stop`/`Notification` hooks and `glosa init` are removed (#152). `glosa hook
<event>` remains for one release as a silent exit-0 stub so a machine still carrying old
`settings.json` entries never shows a failing hook; `glosa doctor`'s `legacy-config` line names the
entries that can be deleted.

### Codex app-server transport

Codex has a separate provider-owned push rail. After an explicit `glosa_session_bind` carrying
`provider:"codex"`, the MCP shim connects to
`$CODEX_HOME/app-server-control/app-server-control.sock`, performs an RFC 6455 WebSocket handshake
over `AF_UNIX`, initializes the app-server protocol, and calls
`thread/resume {threadId, excludeTurns:true}` for that exact bound thread. The MCP process owns the
connection: stdin EOF, SIGHUP, parent loss, or replacement by a newer Codex bind closes it within the
same bounded shutdown path as the MCP server.

The attachment never enumerates threads and never starts, stops, or repairs the app-server. A missing
socket or a pre-rollout `thread/resume` failure retries with jittered exponential backoff from five to
sixty seconds while MCP pull remains usable. Homebrew/npm Codex installs do not provide a managed
daemon; users either install the standalone distribution or separately run:

```sh
codex app-server --listen "unix://$CODEX_HOME/app-server-control/app-server-control.sock"
```

For each `delivery` frame, the attachment sends one text input prefixed `[glosa <entry-id>]`.
`turn/steer` is used only after this connection observed `turn/started` for the resumed thread and can
supply `expectedTurnId`; otherwise it uses `turn/start`, which also covers attachment during an
already-running turn. A successful JSON-RPC response records
`via:"codex_app_server", outcome:"transport_accepted"`. The agent then calls
`glosa_delivery_ack`; only that exact-session acknowledgement records `presented`. `turn/completed`
clears the active turn and provides the hook-free boundary signal while the open generic stream
continues draining parked and new entries.

## F08 — session registry and explicit binding

Providers register through the daemon API; no hook writes registry files directly. A record contains:

```json
{
  "session_id": "opaque-provider-id",
  "provider": "claude-code",
  "cwd": "/workspace/agent-cwd",
  "workspace_binding": "/workspace/explicit-review-target",
  "transcript_path": "/allowed/config-root/projects/example/session.jsonl",
  "source": "monitor",
  "last_active_at": "ISO-8601",
  "lease_expiry": "ISO-8601"
}
```

Liveness is one unexpired 60-second registry lease, never `kill(pid,0)`. Registration, every MCP
tool call, and an open session transport refresh it. Connection-held refreshes run
every 20 seconds; closing/replacing/revoking a stream stops its own refreshes and the last lease then
expires normally. Old timers cannot refresh a deregistered or replacement session. The generic
connection handle is used by the monitor and Codex subscription transports. Registration sources
are `monitor`, `codex-app-server`, `mcp`, and `cli` (explicit bind); there are no hook sources.

The MCP shim additionally polls its own OS-level parent pid and exits when it changes (issue #140),
alongside stdin EOF and SIGHUP. That poll decides only the shim's own lifetime — a process ending
itself — and tells the daemon nothing beyond what the connection drop it triggers already does. It
is not a second liveness authority: the daemon still infers liveness from the lease alone, never by
inspecting or polling any process itself.

The MCP shim discovers provider identity through provider-owned environment readers, registers on
first tool use, and heartbeats thereafter. Only Claude Code supplies one: a shim started by Claude
Code — from a project `.mcp.json` or a plugin's own `.mcp.json` — reads `CLAUDE_CODE_SESSION_ID`.
**Codex supplies nothing.** A server spawned from `[mcp_servers.*]` inherits only an allowlist of
host variables that are set (eight were set in the measurement below), plus its own `env` table, and
no Codex identity under any configuration, so a Codex shim has no host identity of its
own and takes the thread id from an explicit bind carrying `CODEX_THREAD_ID`, which the agent reads
from its own shell environment (`connectPrompt`). Measurements in
`docs/compatibility/2026-09-06-session-identity-and-delivery-spike.md`.
After that bind succeeds, the MCP process retains the exact provider/session/cwd identity for its
later pull and acknowledgement calls; it never falls back to its synthetic generic id while the
bound Codex process is alive.
An unknown-session heartbeat is a typed 404 and triggers re-registration. Before an explicit bind,
no host identity means one stable generic `mcp` identity per shim. A generic inbox pull retains its explicit `workspace`
routing scope even under two overlapping pulls on that one shared identity: the pull sends the
workspace it was asked for on the drain request itself, and the daemon uses that request-carried
scope for the whole drain rather than the registry row's `cwd`, which a concurrent pull's own
registration is otherwise free to move in between (issue #205). Identified host sessions always
retain their actual process cwd and never send a scope at all. Explicit requested identities must
match a known host.
Registration merges preserve omitted bindings/transcripts, enrich generic provider identity, and
reject conflicting concrete providers. Explicit bind registers an unknown ID or refreshes an expired
lease; optional provider/cwd metadata comes from the caller, with generic `mcp` and target workspace
fallbacks for a bare request. Binding and registration share one serialized registry writer.

Transcript derivation is provider-owned and uses exact identity, never the newest file. Claude uses
`<root>/projects/<encoded-cwd>/<session-id>.jsonl` under its configured/default/account-switcher roots.
Codex searches the `sessions/YYYY/MM/DD/rollout-…-<thread-id>.jsonl` layout under configured
`CODEX_HOME` and the default Codex home. Every candidate is confined to the provider allowlist;
symlink escapes and ambiguous matches are rejected. Missing files are retried on mirror requests
and leave registration usable with the fail-soft conversation mirror.

Routing precedence is fixed:

1. explicit `POST /w/:slug/session-binding`, `glosa session bind`, `glosa_session_bind`,
   `glosa open --bind <session-id>`, or `glosa_present` with `mode:"annotate"` or `mode:"edit"`
   (host session or explicit `session_id`); open/present binding failures are nonfatal warnings that
   preserve the presentation URL;
2. generic cwd-ancestor matching;
3. park the entry until a session is registered and bound.

MCP drains preserve the same routing relation in the inverse direction. An explicit
binding stays exact. An unbound session may be a valid ancestor candidate for several present, active
workspace journals, so the daemon emits one globally capped, workspace-labelled composite batch; it
never picks one descendant. Composite coordination and crash-prefix acknowledgement semantics are
specified in A1 §5.15 and do not replace any workspace journal as truth.

`glosa_present` with `mode:"preview"` is session-independent: it registers the artifact and returns
a preview-locked URL but never binds a session. `glosa open` registers and opens the artifact,
creates only glosa workspace state, and never installs agent configuration — there is nothing to
install: Claude provider delivery comes only through the plugin marketplace, Codex through
`codex mcp add glosa -- glosa mcp`. No per-workspace Claude settings are written. `glosa doctor`
reports daemon health, any observable monitor suppression, and leftover `glosa init` entries.

Bindings are session-scoped and held only in memory. An explicit bind restores them after a daemon
restart, including registration if needed, rather
than persisting workflow-specific state inside glosa. Two live sessions bound to one workspace require
an explicit hint or user choice; glosa never guesses and never auto-switches the SPA workspace.
The SPA reports connected/stale/unbound from explicit `workspace_binding` plus lease liveness only;
cwd-ancestor routing remains a delivery fallback and is never presented as an explicit connection.

Every provider implements the pure `connectPrompt({slug,path})` boundary and owns the words needed to
discover the current provider session id. Claude Code guidance uses `CLAUDE_CODE_SESSION_ID`; other
providers own their equivalent. The daemon and SPA wrap that instruction with generic workspace
identity and `glosa session bind <current-session-id> --workspace <workspace-path>` fallback copy.
The prompt asks the current agent session to bind itself; glosa never launches an agent, enumerates
agent CLI processes, selects between candidate sessions, or persists a binding for later restoration.

## F15 — hook registration (removed, #152)

The hook-based registration surface — `glosa init`, its ownership manifest, and the
`SessionStart`/`SessionEnd`/`UserPromptSubmit`/`Stop`/`Notification` roles — is gone. Registration is
the monitor's at session start (F06) or the MCP shim's on its first tool call (F08). The only
remnant is the one-release `glosa hook <event>` stub described in F07, which reads nothing, prints
nothing and exits 0 for every event and provider.

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

1. A real plugin monitor process idles outside a registered workspace, connects after `glosa open`,
   and receives parked and live entries without spawning a daemon.
2. A dropped daemon stream reconnects only after the five-second floor and resumes parked delivery.
3. Explicit binding routes across different agent/artifact working directories; parked entries drain.
4. Monitor presentations obey byte/count limits and transport/presentation acknowledgement ordering.
5. Transcript fixtures cover partial, unknown, corrupt, resume, clear, compact, and large tool results.
6. Conversation delivery covers unacknowledged monitor transport, acknowledgement-tool success,
   exact-session MCP fallback, wrong-session isolation, retries, and daemon restart.

The manual T8 report records the installed Claude Code version, actual session model, monitor line
arrival, and the successful transport used. Monitor suppression or absence is reported separately
from observed MCP fallback success.
