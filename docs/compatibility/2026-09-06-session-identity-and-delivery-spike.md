# Session identity and delivery spike — 2026-09-06

Settles whether a Claude Code plugin monitor and an MCP server started by either agent runtime are
handed the session identity glosa needs, how fast a monitor line reaches an idle agent, and whether
the Codex app-server control socket is a usable push rail. Ran against real binaries on one macOS
machine. No product code changed.

## Result

| # | Question | Answer |
|---|---|---|
| 1 | Does a `when: "always"` plugin monitor get `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR`? | **Session id yes, project dir no.** Also no `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`. |
| 2 | When does an idle agent see a monitor's stdout line? | **Immediately**, 215–282 ms, and it starts a turn. Not a turn boundary, not the next prompt. |
| 3 | Does a plugin-declared `.mcp.json` server get `CLAUDE_CODE_SESSION_ID`? | **Yes**, plus `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`. |
| 4 | Does a Codex `[mcp_servers.*]` server get `CODEX_THREAD_ID`? | **No.** Eight fixed variables, none of them Codex's. No config can widen it. |
| 5 | Does Claude kill the monitor at session end? Does it survive `/clear` and `/compact`? | **Killed** within ~70 ms of the session process dying. **Survives** `/clear` and `/compact` as the same pid. |
| 6 | Is the app-server control socket there after a plain `codex` launch? | **No** — and `codex app-server daemon start` refuses to run on a Homebrew/npm install. |
| 7 | Does a second connection's `thread/resume` subscribe or error? | **Subscribes** — but only once the thread has run a turn. Before that it errors with `no rollout found`. |
| 8 | Do `turn/start` / `turn/steer` from that connection reach the session? | **Both.** Injected text renders in the TUI in ~1 s; a steer lands mid-tool-call, 45 s before the turn ended. |
| 9 | Does `turn/completed` reach the second connection? | **Yes**, along with `turn/started` and the `item/*` stream. |

One finding nobody asked for, and it is the most consequential: **a plugin monitor does not start at
all when `DISABLE_TELEMETRY=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set.** Details below.

## Environment

| Component | Version |
|---|---|
| Claude Code | 2.1.263 (`~/.local/share/claude/versions/2.1.263`) |
| Claude Agent SDK (reported in child env) | 0.3.257 |
| Codex CLI | 0.153.4 (Homebrew `@openai/codex`, `codex-darwin-arm64` vendor binary) |
| macOS | 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| node (MCP probe host) | v24.19.0 |

Sessions ran in a scratch project outside the repo, with a scratch `CODEX_HOME`. Claude sessions used
`--plugin-dir`, so no plugin was installed into the machine's Claude configuration.

## Claude Code

### 1 — the monitor's environment

A monitor process inherits the launching shell's environment verbatim. Claude Code sets or overwrites
exactly this on top of it:

| Variable | Value in the run | Note |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | the session's own UUID | Matched the `--session-id` the session was started with, byte for byte. |
| `CLAUDECODE` | `1` | |
| `CLAUDE_CODE_ENTRYPOINT` | `cli` | |
| `CLAUDE_CODE_EXECPATH` | path of the running Claude Code build | |
| `CLAUDE_PID` | pid of the session process | The monitor's own parent is a shell, not this pid. |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `..._TOKEN` | `/tmp/cc-socks/<pid>.sock` and a hex token | |
| `AI_AGENT` | `claude-code_2-1-263_agent` | Carries the build version. |
| `PATH`, `PWD`, `SHLVL`, `TERM`, `_` | rewritten | `PWD` is the session's working directory. |

Absent, and this matters for the plugin design: **`CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and
`CLAUDE_PLUGIN_DATA` are not in a monitor's environment.** Those three are documented as `${...}`
substitutions inside the monitor's `command` string, not as variables the process can read. A monitor
that needs its plugin root or the project directory has to be handed them as arguments:

```json
{ "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/glosa monitor --plugin-root \"${CLAUDE_PLUGIN_ROOT}\" --project-dir \"${CLAUDE_PROJECT_DIR}\"" }
```

The working directory is the session's, so cwd alone answers "which workspace am I in" for the
registration path. Everything outside that table is the launching shell's environment, passed through
untouched — 108 keys in this run, and the thirteen above are the only ones Claude Code controls.

### 2 — an idle agent sees a monitor line in about a quarter of a second

Seven lines written to stdout by a monitor, none of them while a turn was running:

| Line | Written at (s from monitor start) | Delay to render |
|---|---|---|
| 1 | 0.0 | 282 ms |
| 2 | 15.1 | 229 ms |
| 3 | 30.1 | 234 ms |
| 4 | 45.2 | 229 ms |
| 5 | 60.2 | 226 ms |
| 6 | 75.3 | 226 ms |
| 7 | 90.3 | 215 ms |

The first was written as the session started; the other six landed inside an 80-second window with no
keystrokes between two prompts. Each one rendered as
`⏺ Monitor event: "<the monitor's description>"` and started a turn immediately. So the answer to the
question as posed is the first option: **immediately, as a notification**, with no dependence on a
turn boundary or the next user prompt. A monitor is a genuine push rail.

Two limits on this measurement. The delay is monitor-stdout to *session render*; the session in this
run could not reach the API (see "Limits" below), so the moment the text lands in the model's context
is bounded below by these figures, not equal to them. And the notification carries the monitor's
`description` field in the visible summary, not the line's text, so an entry id prefixed into the
stdout line is still the only way for `glosa_conversation_ack` (A2 §F06) to name the entry it is
acknowledging — as #151 already assumes.

### 3 — a plugin's own MCP server gets more than the monitor does

The `.mcp.json` server declared inside the plugin was spawned at session start, before any tool call,
with cwd set to the session's working directory. Its environment carries everything the monitor's
does **plus** the three the monitor lacks:

| Variable | Value in the run |
|---|---|
| `CLAUDE_CODE_SESSION_ID` | the same UUID the monitor saw, for the same session |
| `CLAUDE_PROJECT_DIR` | the scratch project directory |
| `CLAUDE_PLUGIN_ROOT` | the plugin directory |
| `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/<plugin>-inline` |

A2 §F06's statement that the stdio MCP shim reads `CLAUDE_CODE_SESSION_ID` therefore holds for
plugin-declared servers, not only for a project `.mcp.json`.

### 5 — lifecycle

- **Session end kills it.** `SIGTERM` sent to the Claude Code process alone — not the process group —
  and the monitor took its own `SIGTERM` 71 ms later and was gone within a second. Claude Code kills
  the monitor; the process does not have to notice its parent left.
- **`/clear` and `/compact` do not disturb it.** Same pid before and after both, no restart, no
  second process. The "prevents duplicate processes when the plugin reloads" wording in the plugin
  reference matches what happens.
- **Resume was not tested.** The session could not complete a turn, so no transcript existed to
  resume from.

### The one that changes the plan: monitors are off when telemetry is off

Three sessions, same plugin, same machine, 25 seconds each:

| Session environment | Monitor started | Plugin MCP server started |
|---|---|---|
| (baseline) | **yes** | yes |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | **no** | yes |
| `DISABLE_TELEMETRY=1` | **no** | yes |

The tools reference states this for the Monitor tool and the plugin reference says plugin monitors
share its availability constraints; this run confirms it end to end, and confirms the MCP server is
unaffected. The session UI showed no monitor and gave no warning.

The population most likely to set `DISABLE_TELEMETRY=1` is the population glosa is built for. For
those users the plugin monitor rail is silently absent and MCP pull is the only rail. Two further
exclusions come from the same documented constraint: monitors run **only in interactive CLI
sessions** (a `claude -p` / SDK session never starts one), and they are unavailable on Bedrock,
Google Cloud's Agent Platform, and Microsoft Foundry.

## Codex

### 4 — a Codex MCP server is handed nothing

A server declared as `[mcp_servers.<name>]` in `config.toml` and spawned by `codex exec` received
exactly eight variables:

```
HOME  LANG  LOGNAME  PATH  SHELL  TMPDIR  USER  __CF_USER_TEXT_ENCODING
```

No `CODEX_THREAD_ID`, no `CODEX_SESSION_ID`, no `CODEX_HOME`. Setting
`shell_environment_policy.inherit = "all"` changed nothing — the list stayed at those eight. The only
way to add anything is the server's own `env` table in `config.toml`, which cannot carry a value that
does not exist until the thread starts.

The same thread's **shell tool**, by contrast, sees 134 variables including:

```
CODEX_THREAD_ID  CODEX_SESSION_ID  CODEX_HOME  CODEX_SANDBOX
CODEX_SANDBOX_NETWORK_DISABLED  CODEX_CI  CODEX_MANAGED_BY_NPM  CODEX_MANAGED_PACKAGE_ROOT
```

`CODEX_THREAD_ID` read from the shell tool was character-for-character the session id Codex printed
for that run.

So the split is clean, and it decides two different things:

- **A2 §F08 was wrong for Codex** where it said the MCP shim discovers provider identity through
  `CLAUDE_CODE_SESSION_ID` **or** `CODEX_THREAD_ID`. A glosa MCP server started by Codex cannot
  identify its session from its own environment, under any configuration. §F08 is corrected in the
  same change as this note.
- **The Codex provider's `connectPrompt` is right.** `packages/providers/codex/src/provider.ts`
  tells the agent to read `CODEX_THREAD_ID` from its own environment and pass it to
  `glosa_session_bind`; the agent's shell has it. That is an agent action, not a human one, so the
  fallback is one tool call rather than a person typing `glosa session bind`.

### 6 — the app-server daemon is not there, and cannot be started here

A plain `codex` TUI launch ran for 30 seconds against a scratch `CODEX_HOME`. Neither
`$CODEX_HOME/app-server-control/` nor the socket inside it was ever created. The machine's everyday
`~/.codex`, in daily use for months, has no such directory either.

`codex app-server daemon start` then failed:

```
Error: managed standalone Codex install not found at $CODEX_HOME/packages/standalone/current/codex
This command requires the standalone install managed by the Codex installer, because the daemon
starts and updates app-server from that fixed path.
Install it with:
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

This is stronger than "the daemon is off by default". On a Homebrew or npm install of Codex —
`@openai/codex`, which is what this machine has — the managed daemon **cannot be started at all**
without switching to a different distribution channel. #161's "document `codex app-server daemon
start` as the one-time Codex setup" understates the ask.

A daemon can still be run by hand at the path the TUI probes:

```bash
codex app-server --listen "unix://$CODEX_HOME/app-server-control/app-server-control.sock"
```

That is what items 7–9 were tested against, and the TUI did attach to it: a second connection's
`thread/loaded/list` listed the thread the TUI had just created, which only happens when the thread
lives in the daemon process rather than in an embedded server inside the TUI. glosa must not be
the process that starts it — invariant 5 and #151's "never spawns the daemon" both apply — so on this
install shape the honest capability line is `push: false` unless the user has the standalone install
or runs that command themselves.

Two side observations from the manual daemon's own logs, both relevant to A3:

- the app-server opens a **remote-control websocket task to `chatgpt.com/backend-api/`** at startup
  (it reported `status: disabled` here). Attaching to an app-server means sitting beside a process
  that holds an outbound connection. glosa's own egress is unchanged, but "local socket only" does
  not make the surrounding process local-only. Worth a line in `docs/appendices/A3-security.md`; it
  does not block #161.
- the control socket is **WebSocket over `AF_UNIX`**, not newline-delimited JSON. A raw JSON-RPC
  write is rejected with `failed to upgrade control socket websocket connection` and the connection
  is closed. `codex app-server proxy` did not bridge it in this run either. A client has to perform
  an RFC 6455 handshake itself.

### 7 — a second connection can subscribe to a live thread, once the thread has a rollout

With the TUI attached to the daemon, a second connection over the same socket called:

```json
{"method":"thread/resume","params":{"threadId":"<the TUI's thread>","excludeTurns":true}}
```

On a thread that had already run one turn it returned full thread state (`thread`, `model`, `cwd`,
`approvalPolicy`, `sandbox`, `initialTurnsPage`, …) in about 60 ms. No error, no exclusivity
complaint. The subscriber-set model #161 read out of `thread_state.rs` behaves as described.

On a **freshly started TUI whose thread has not run a turn yet**, the same call fails:

```json
{"code":-32600,"message":"no rollout found for thread id <the thread>"}
```

Reproduced twice. A thread becomes resumable once it has a persisted rollout, which happens on its
first turn. An attach that fires at session start will hit this, so `glosa codex-attach` needs a
retry, not a one-shot connect — and the failure is not a reason to fall back to pull-only.

Two more notes for the implementation:

- **`thread/loaded/list` returns bare id strings under `data`**, and the TUI's own thread is the one
  loaded when the TUI starts. A turn also creates a short-lived second thread whose `thread/resume`
  fails with the same `no rollout found`. Picking "the newest loaded thread" is wrong; glosa will
  have `CODEX_THREAD_ID` from the bind call and should use it rather than enumerate.
- Threads stay loaded in the app-server after their TUI exits, so "loaded" is not "live".

### 8 — injected input arrives as a user message, and steer lands mid-tool-call

`turn/start` from the second connection, on the TUI's thread, with the TUI idle:

| Step | Observed |
|---|---|
| `turn/start` accepted | 56 ms |
| text visible in the TUI | 1064 ms after the call |

The text rendered in the transcript and Codex answered it. Nothing was typed into a terminal; this is
the documented control-plane API doing what #161 expects of it.

`turn/steer` was then tested against a turn that was executing a 45-second shell command:

| Step | Time | Observed |
|---|---|---|
| `turn/started` for the TUI's turn | t+0 | carries `turn.id` |
| command execution in flight | t+0.3 s | `item/started` for the command |
| `turn/steer` accepted | t+0.4 s | 59 ms round trip, returned that same `turnId` |
| steered text visible in the TUI | t+4.5 s | while the command was still running |
| `turn/completed` | t+50 s | the sleep finished |
| model acted on the steered instruction | within that turn | it said the word the steer asked for |

**Steer lands mid-tool-call.** It does not queue to the turn boundary, and it does not interrupt the
running command. The 45-second gap between the steer rendering and `turn/completed` settles the
question #161 raised: an annotation delivered by `turn/steer` reaches the agent inside the turn it is
already working on.

`turn/steer` requires `expectedTurnId`, which only a subscribed connection learns (from
`turn/started`). A transport that reconnects mid-turn has no turn id until the next `turn/started`
and must fall back to `turn/start`, which queues.

### 9 — turn boundaries arrive without a hook

The subscribed second connection received, over the course of one injected turn and one TUI turn:

```
turn/started  turn/completed  thread/status/changed  thread/tokenUsage/updated
item/started  item/completed  item/agentMessage/delta  item/commandExecution/outputDelta
account/rateLimits/updated
```

`turn/completed` reaches the second connection. The `Stop`-hook role for Codex — drain parked entries
at a turn boundary — is covered by a notification, with no hook installed.

## What the blocked issues must now assume

### #151 — Claude plugin rail

- **Registration works from the monitor.** `CLAUDE_CODE_SESSION_ID` is exact and the cwd is the
  session's, so the degraded mode in #151 ("locate the session by the newest transcript, else a
  synthetic id") is not needed for identity. Keep it, if at all, only for the telemetry-off case
  below, where there is no monitor to run it.
- **The plugin root and project dir must be passed as arguments**, not read from the environment.
- **Push is real and immediate.** Roughly a quarter of a second from stdout line to the session
  reacting, with no turn in flight.
- **The open connection is liveness, as #151 specifies.** Claude Code kills the monitor when the session
  process dies; `/clear` and `/compact` leave it alone, so neither boundary needs re-registration and
  neither creates a duplicate.
- **`push` must be evaluated from a connected monitor, never from plugin installation.** Three
  populations get no monitor: sessions with `DISABLE_TELEMETRY` or
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set, non-interactive (`-p` / SDK) sessions, and
  Bedrock / Google Cloud Agent Platform / Microsoft Foundry sessions. All three still get the plugin
  MCP server, so pull is intact. `glosa doctor` should name this rather than let a user wonder why
  annotations sit in the queue.
- **The delivery figures above are session-render latency, not model-context latency.** Re-run item 2
  on a machine with working credentials before pinning the monitor line's payload format.

### #152 — hooks and rewake removal

- **No attention-state source was found.** Neither the monitor environment nor the plugin MCP
  environment carries anything resembling Claude's `Notification` hook signal, and a monitor only
  ever carries glosa's own stdout. #152's "attention state is a real loss" stands as written: until
  something else turns up, the attention badge is driven only by glosa's own `attention_request`
  entries.
- **MCP pull survives every case where the monitor does not**, which is what makes removing the hooks
  safe for the telemetry-off population — provided #141 (a session registers itself on the MCP
  server's first tool call) has landed.

### #161 — Codex push rail

- **`push` is false on a normal install.** Not "off by default" — unavailable. `codex app-server
  daemon start` requires the standalone installer's tree, which a Homebrew or npm install does not
  have. The README line should offer the manual `codex app-server --listen unix://…` form and say
  plainly that glosa will not start it.
- **`thread/resume` needs a retry loop**, because a thread has no rollout until its first turn.
- **Deliver with `turn/steer` when a turn is in flight and `turn/start` otherwise, as #161 specifies** — the
  steer genuinely lands mid-tool-call. `expectedTurnId` comes from `turn/started`, so a connection
  that attaches mid-turn has no id and must use `turn/start`, which queues.
- **`turn/completed` replaces the `Stop` hook** for turn-boundary drains.
- **The control socket is WebSocket over `AF_UNIX`.** Whatever client library `glosa codex-attach`
  uses has to do an RFC 6455 handshake; a plain JSON-RPC-over-socket client is rejected and
  disconnected.
- **Codex's own MCP server env cannot identify the thread**, so `glosa codex-attach` gets the thread
  id from the bind call the agent makes, not from its own environment.

### #150's own blocking clauses

The issue said "if (1) fails, the monitor cannot register the session"; (1) passed, so it can. It said
"if (4) fails, Codex sessions need the manual `glosa session bind` path"; (4) failed, but not into a
manual path — the Codex agent's shell does have `CODEX_THREAD_ID`, so the existing `connectPrompt`
instruction resolves it in one agent tool call. `glosa session bind` typed by a human stays the last
resort, not the default.

## Method

Everything ran from a scratch directory outside the repo. No plugin was installed into the machine's
Claude configuration (`--plugin-dir`), and Codex used a scratch `CODEX_HOME` holding a copy of the
auth file, a `config.toml` with two probe MCP servers, and nothing else.

- **Claude**: a throwaway plugin with `monitors/monitors.json` (`when: "always"`) and a `.mcp.json`
  server. The monitor dumped its environment, logged its own signals, and wrote one timestamped line
  every 15 seconds. The MCP server dumped its environment at spawn and answered `initialize` /
  `tools/list`. Sessions were driven through a pty so the TUI was real; timings come from comparing
  the monitor's own write timestamp with the timestamp of the pty bytes that rendered it.
- **Lifecycle** was tested by signalling the Claude Code process alone, never the process group, so
  the monitor's `SIGTERM` could only have come from Claude Code.
- **Codex**: `codex exec` for the MCP environment questions; a pty-driven TUI plus a second
  connection over the control socket for items 6–9. The second connection is a hand-written RFC 6455
  client over `AF_UNIX` — see the transport note in item 6.

## Limits of this run

- **One machine, one account, one install shape.** Claude Code from the native installer, Codex from
  Homebrew. The Codex daemon findings in item 6 are specific to a non-standalone install; a machine
  with the standalone installer will behave differently and that case is untested here.
- **The Claude sessions could not reach the API.** The stored OAuth credentials on this machine had
  expired and would not refresh, so every Claude turn ended at `Login expired`. This does not affect
  items 1, 3 and 5, which are process and environment facts, and it does not affect the *delivery
  decision* in item 2 — the session rendered the notification and started a turn on its own, with no
  prompt, which is the behaviour in question. It does mean the figures in item 2 are session-render
  latency, not model-context latency, and that the exact text a monitor line becomes in the model's
  context was not observed. Worth one re-run on a logged-in machine before #151 pins a payload format.
- **Resume was not tested** for the same reason: no transcript existed to resume.
- **`/compact` was exercised but not completed** — it needs the API. What the run shows is that
  invoking it does not restart or kill the monitor.
