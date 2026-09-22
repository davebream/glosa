# glosa ↔ Claude Code integration contract

This appendix specifies the provider boundary, delivery ladder, session registry, and transcript
mirror. The durable inbox and journal remain authoritative regardless of transport availability.

## F06 — plugin monitor capability

The Claude plugin is the install boundary. It carries `.mcp.json`, the `glosa-connect` skill, a
launcher that resolves a local glosa executable without a `PATH` lookup or download, and TWO
monitor declarations that start ONE process: `when:"always"`, which covers a session that began
with the plugin installed, and `when:"on-skill-invoke:glosa-connect"` (issue #306), which covers a
session where it did not — the only mechanism Claude documents for starting a monitor mid-session.
The skill may additionally start `glosa monitor` through the Monitor tool when neither fired.

Exactly one `glosa monitor` per session survives all three paths, because the command takes an
exclusive `flock` on `<GLOSA_HOME>/monitors/<sha256(session-id)>.lock` before it registers; a later
starter exits 0, silent on stdout, naming the holder on stderr. The lock is `flock` and not a pid
file deliberately: the kernel releases it when the holder dies, SIGKILL included, so there is no
stale lock to adjudicate and no unlink/recreate window in which two processes both believe they
own the session. The guard FAILS OPEN — only `EWOULDBLOCK` stops a monitor, so a filesystem
without `flock` support degrades to the pre-#306 behaviour rather than to no push at all. Without
this guard two declarations are not merely wasteful: the second displaces the first (the
park/supersede protocol below),
and the replacement's empty accepted-set re-emits any entry that was transport-accepted but not
yet `presented`, delivering the same `[glosa <id>]` line twice.

The Monitor-tool path is a fallback, not an equal: Claude stops a Monitor watch that emits too many
events, and the monitor's stdout IS the delivery channel, so a burst of queued entries can end a
skill-started monitor with nothing re-arming it. A plugin-declared monitor has no such governor.

The monitor receives its exact identity from `CLAUDE_CODE_SESSION_ID`, which is the one variable
Claude exports to both a monitor and an ordinary shell; `${CLAUDE_PROJECT_DIR}` is expanded into
the command arguments because Claude does not place it in either environment, and `--project-dir`
defaults to the working directory so the skill can start a monitor without it. `--plugin-root` is
accepted and ignored, retained only so an older installed manifest keeps working.

The monitor reads `workspaces.json` without mutating it. Outside a registered workspace it waits for
that file to change and makes no daemon request. Once the project is registered, it registers with
`source:"monitor"`, opens `GET /api/sessions/:id/stream`, and holds the session lease through that
connection. It never starts or repairs a daemon. An ordinary disconnect (plain EOF, error, or
non-2xx) retries with jittered exponential backoff whose floor is five seconds and whose cap is sixty
seconds. A stream that ends with the terminal `event: superseded` frame (issue #206: another
connection for the same session took over) is different: the monitor stops streaming and does not
re-register or reconnect. It parks, polling `GET /api/sessions/:id/stream/status` on a fixed 15-second
interval plus up to 3 seconds of jitter (never tighter, no backoff growth), re-running daemon
discovery and re-reading credentials on every poll. It stays parked on every inconclusive answer
(daemon unreachable, auth failure, network error, or `connected:true`) and re-enters the normal
connect loop only once the probe authoritatively reports `connected:false` — including for an unknown
session id, which is treated as free.

Each bounded stream presentation is written as one stdout line beginning `[glosa <entry-id>]`.
Successful stdout completion records `via:"monitor", outcome:"transport_accepted"`; it is still
eligible for MCP pull. Claude calls `glosa_delivery_ack` with the in-band id after the line reaches
agent context. Only that exact-session acknowledgement records `presented`; conversation messages
then make their terminal transition.

An `event: signal` frame (A1 §5.11g, issue #155) is written as its own stdout line,
`[glosa signal <signal-id>] <kind>: <message>`, and the monitor then acknowledges it itself with the
frame's `ack_token`. For a signal, reaching agent context is the whole point, so there is no separate
agent acknowledgement. A failed print or ack never ends the stream. The signal stays unacknowledged
and is offered again on the next connect or MCP pull.

Claude suppresses plugin monitors when `DISABLE_TELEMETRY=1` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and does not run them for noninteractive or unsupported
hosted-model sessions. `push` is therefore true only while a monitor is connected. Because that is
a fact about one session rather than about the installation, `GET /api/status` reports it per
session row as
`push:{connected,transport}` (contract 1.16), carrying the same shape the `stream/status` probe
returns; `glosa doctor`'s `claude-monitor` check and the `glosa-connect` skill both read it rather
than inferring from `source`, which an explicit bind overwrites with `mcp`. MCP tools still
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
socket, a pre-rollout `thread/resume` failure, or any ordinary stream end retries with jittered
exponential backoff from five to sixty seconds while MCP pull remains usable. A stream that ends with
the terminal `event: superseded` frame (issue #206: another attachment — the MCP shim's bind or a
separate `glosa codex-attach` — took over the same thread) is different: the attachment stops
streaming and does not re-register or reconnect. It parks, polling `GET
/api/sessions/:id/stream/status` on a fixed 15-second interval plus up to 3 seconds of jitter (never
tighter, no backoff growth), re-establishing its daemon client fresh on every poll. It stays parked on
every inconclusive answer and re-enters the normal connect loop only once the probe authoritatively
reports `connected:false` — including for an unknown session id, which is treated as free. Homebrew/npm Codex installs do not provide a managed
daemon. A user who wants one either installs the standalone distribution, runs Codex's own
`codex app-server daemon bootstrap` (or `start`, once bootstrapped) to install and run a durable
user-managed app-server, or runs the listener directly:

```sh
codex app-server --listen "unix://$CODEX_HOME/app-server-control/app-server-control.sock"
```

Whichever way it starts, it stays user-owned: glosa attaches to a socket it finds and starts nothing.

For each `delivery` frame, the attachment sends one text input prefixed `[glosa <entry-id>]`.
`turn/steer` is used only after this connection observed `turn/started` for the resumed thread and can
supply `expectedTurnId`; otherwise it uses `turn/start`, which also covers attachment during an
already-running turn. A successful JSON-RPC response records
`via:"codex_app_server", outcome:"transport_accepted"`. The agent then calls
`glosa_delivery_ack`; only that exact-session acknowledgement records `presented`. `turn/completed`
clears the active turn and provides the hook-free boundary signal while the open generic stream
continues draining parked and new entries.

An `event: signal` frame (A1 §5.11g, issue #155) is steered into the same thread as one text input,
`[glosa signal <signal-id>] <kind>: <message>`, the line the Claude monitor prints. The attachment
then acknowledges it with the frame's `ack_token`.

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

Registering does not, by itself, make the reported `cwd` a workspace (#146). A directory already
inside a registered workspace resolves to that workspace and the row's `workspace_binding` is set to
it; `$HOME` or an ancestor registers no workspace at all, leaving the session live and pullable over
MCP with nothing minted; a path a `glosa forget` is midway through deleting is refused with
`workspace-forgetting` rather than recreated. `cwd` always keeps saying where the process runs, and
a binding the caller supplied is never overridden by this resolution.

Liveness is one unexpired 60-second registry lease, never `kill(pid,0)`. Registration, every MCP
tool call, and an open session transport refresh it. Connection-held refreshes run
every 20 seconds; closing/replacing/revoking a stream stops its own refreshes and the last lease then
expires normally. Old timers cannot refresh a deregistered or replacement session. The generic
connection handle is used by the monitor and Codex subscription transports. The registration
sources glosa's own callers send are `monitor`, `codex-app-server`, `mcp`, and `cli` (explicit bind);
an explicit bind that sends no `source`, such as `glosa open --bind`, is recorded as `manual`. There
are no hook sources.

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
