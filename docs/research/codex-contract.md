# Codex CLI integration contract (research note)

Pins the concrete mechanics `packages/providers/codex`'s `AgentProvider` implementation is built
against. This note is non-normative research support: where it and a normative appendix disagree,
the appendix governs and this note is corrected, never the reverse.

**Refreshed 2026-09-15** against the `openai/codex` GitHub repository's `main` branch at commit
`1427825c4044d48b513c7d4ea32b84e58806a188` (source, not blog paraphrase) — a sparse checkout of
`codex-rs/{hooks,plugin,features,protocol/src,app-server-protocol/src,app-server/src,app-server-client,app-server-transport/src,rollout/src,cli/src,rmcp-client/src}`,
`codex-rs/tui/src/lib.rs`, `codex-rs/core/src/hook_runtime.rs`, `codex-rs/core/src/mcp*`, and
`docs/`. Every factual claim below cites one of those paths; a claim the snapshot cannot support is
marked **UNCONFIRMED** rather than guessed. This pass corrects several shape errors a prior pass
introduced (wrong output nesting, a claimed universal envelope that doesn't hold, missing enum
variants) — every struct cited below was re-read field-by-field against `schema.rs`/`main.rs` for
this pass, not assumed from the earlier draft.

**Prior passes**, superseded by this one where they overlap: **2026-07-21** against
`codex-rs/hooks/src/schema.rs`, `codex-rs/hooks/src/events/{session_start,stop,user_prompt_submit,session_end,common}.rs`
and `codex-rs/core/src/hook_runtime.rs`, cross-checked
against the (now-unavailable to this snapshot) official docs. **Amended 2026-09-06**
(`docs/compatibility/2026-09-06-session-identity-and-delivery-spike.md`, Codex CLI 0.153.4): found
the app-server control socket as a real push path and corrected the "Codex has no MCP server mode"
claim. This pass re-verifies §4 fully against the pinned commit above, and re-verifies §6 as far as
the sparse snapshot allows — the one sub-claim it cannot reach (which of Codex's tools reads
`CODEX_THREAD_ID`) is marked below as still resting on the 2026-09-06 spike's live measurement,
not on this snapshot.

glosa's own contract has moved since those passes: the Stop-hook blocking gate and the
turn-boundary drain this note originally pinned were **retired in #152** — the current delivery
ladder is `push → mcp_pull` (R4), and neither the Claude nor the Codex provider implements a
blocking gate. §9 below keeps that mechanism's description because it is still accurate
Codex-source content — every hook the Codex CLI ships works exactly as described — but it is no
longer glosa's contract, and is marked historical accordingly.

**More broadly: §§1–3 and §5 below are Codex-source research only.** They describe Codex's own
hook/plugin/transcript system exactly as its source implements it, not anything glosa currently
does. glosa's Codex provider consumes none of it — it has exactly two rungs, the app-server push
(§4) and MCP pull (§6), stated as glosa's actual contract in §7. An earlier pass blurred this line
in several places — calling the hook event set "the set glosa can ever be asked to handle", calling
glosa "hook-capable", sourcing glosa's transcripts from "hook events", and hanging R6/R9's
attention model on a hypothetical Codex `Notification` equivalent. Those are corrected below:
glosa's attention model (R9) is driven solely by its own `attention_request` entries
(`glosa_ask`, `request-review`) and reads no provider hook at all, for either Claude or Codex.

## 1. Hook events, and the fields on Codex's own hook payloads (Codex-source research only) **CONFIRMED (source)**

`codex_protocol::protocol::HookEventName` (`codex-rs/protocol/src/protocol.rs:1578`) is the
complete, closed set of hook events Codex's own hook engine dispatches — a fact about Codex, not a
set glosa consumes:

```
PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd,
UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt
```

**There is no single input envelope shared by every event** — checked field-by-field against every
`*CommandInput` struct in `codex-rs/hooks/src/schema.rs`. Only these fields are on every one:
`session_id`, `transcript_path`, `cwd`, `hook_event_name`. Beyond that it fragments:
- `turn_id` is on every event except `SessionStart` and `SessionEnd` (`schema.rs:499-523`).
- `model`/`permission_mode` are on every event except `SessionEnd`, which has neither
  (`SessionEndCommandInput`, `schema.rs:515-523`: just `session_id`/`transcript_path`/`cwd`/
  `hook_event_name`/`reason`).
- `source` (`"startup"|"resume"|"clear"|"compact"`) is **`SessionStart`-only**
  (`schema.rs:499-510`). `SubagentStart` has no `source` field despite otherwise looking like a
  turn-scoped event (`SubagentStartCommandInput`, `schema.rs:549-562`).
- `reason` is `SessionEnd`-only.
- `agent_id`/`agent_type` are optional on the tool-scoped events (`PreToolUse`,
  `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
  `schema.rs:278-582`) and required (non-optional strings) on `SubagentStart`/`SubagentStop`;
  absent entirely from `SessionStart`, `SessionEnd`, `Stop`, `Interrupt`.
- `stop_hook_active`/`last_assistant_message` are `Stop`/`SubagentStop`-only; `SubagentStop`
  additionally carries `agent_transcript_path` (`schema.rs:606-621`).

`Interrupt` (`codex-rs/hooks/src/events/interrupt.rs`; input `InterruptCommandInput`,
`schema.rs:626-636`) fires when a running turn is interrupted; its stdin is
`session_id`/`turn_id`/`transcript_path`/`cwd`/`hook_event_name`/`model`/`permission_mode` — the
same shape as `Stop` minus the stop-specific fields, not a distinct envelope of its own. Discovery
order (highest to lowest precedence, later merges rather than replaces) is unchanged from the
prior pass: `~/.codex/hooks.json` → `~/.codex/config.toml [hooks]` → `<repo>/.codex/hooks.json`
(requires the project be trusted) → `<repo>/.codex/config.toml [hooks]` → plugin-bundled
`hooks/hooks.json` → org-enforced `requirements.toml` managed hooks
(`codex-rs/hooks/src/engine/discovery.rs`).

**Hook output fields.** Most hooks' stdout JSON shares a universal envelope
(`codex-rs/hooks/src/engine/output_parser.rs`'s `UniversalOutput`, sourced from
`HookUniversalOutputWire`, `schema.rs:87-99`, flattened via `#[serde(flatten)]` into every
`*CommandOutputWire` struct **except one**):

```json
{ "continue": true, "stopReason": "<string>", "suppressOutput": false, "systemMessage": "<string>" }
```

`InterruptCommandOutputWire` (`schema.rs:485-488`) is that one exception: it carries **only** an
optional `systemMessage` — no `continue`/`stopReason`/`suppressOutput` field exists on it at all —
matching `InterruptOutcome` (`interrupt.rs`), which has no blocking or continuation semantics
whatsoever (no `should_block`/`should_stop`, only `hook_events`).

On top of the universal envelope (where it applies), each event type layers its own fields. This
paragraph covers the decision and context fields that shape a turn; `schema.rs` is the complete
inventory. `Stop`/`SubagentStop`/`PostToolUse`/`UserPromptSubmit` add `decision:"block"` + non-empty
`reason` (`BlockDecisionWire`). `PreToolUse` has **two separate decision channels**, not one: a legacy
top-level `decision:"approve"|"block"` (`PreToolUseDecisionWire`, `schema.rs:267-273`, no third
value), and `hookSpecificOutput.permissionDecision:"allow"|"deny"|"ask"`
(`PreToolUsePermissionDecisionWire`, `schema.rs:257-265`), with sibling `permissionDecisionReason`,
`updatedInput` and `additionalContext` (`PreToolUseHookSpecificOutputWire`, `schema.rs:244-255`).
`PostToolUse`'s `hookSpecificOutput` carries `additionalContext` and `updatedMCPToolOutput`
(`PostToolUseHookSpecificOutputWire`, `schema.rs:231-239`). `PermissionRequest` nests its decision
**two levels deep**: `hookSpecificOutput.decision.behavior:"allow"|"deny"`
(`PermissionRequestDecisionWire`, `schema.rs:189-226`) — `decision` is an object, not a bare string.
On that object, `message` is accepted and becomes the denial message (`events/permission_request.rs`,
`PermissionRequestDecision::Deny { message }`); `updatedInput` and `updatedPermissions` are reserved
and fail closed if present; `interrupt` is reserved and fails closed only when `true` (the source's
own doc comments on each field). `SessionStart`, `SubagentStart` and `UserPromptSubmit` add
`hookSpecificOutput.additionalContext`.

Codex's own hook system has no `Notification` event in this closed set. This is
Codex-source information only, offered for whoever eventually designs a Codex-specific signal;
glosa's own attention model does not need or use it (see the intro above and §8).

## 2. Legacy `notify` — a deprecated compatibility shim, not gone (Codex-source research only) **CONFIRMED (source)**

The prior passes described `notify` as something the multi-event hook framework "superseded."
Source in this snapshot shows the truth is narrower: `codex-rs/hooks/src/legacy_notify.rs` still
exists and still runs, config-gated by an optional `legacy_notify_argv: Option<Vec<String>>` on the
hook registry (`codex-rs/hooks/src/registry.rs:43`, wired at `registry.rs:125-127`). When configured,
it fires on the turn-complete (`AfterAgent`) event and spawns the configured argv with one extra
JSON argument (`UserNotification::AgentTurnComplete{thread_id,turn_id,cwd,client,input_messages,last_assistant_message}`,
kebab-case on the wire). The source itself marks it
`// TODO: Remove this hook and its environment plumbing when legacy notify support is removed` —
still present, but explicitly slated for eventual removal, and superseded in practice by `Stop`/
`SessionEnd` hooks for any Codex-side consumer that needs a turn-completion or session-end signal.
Nothing in glosa depends on `notify` or on any hook; this section is grounded here only to correct
the prior note's overstatement about Codex's own history, not because it matters to glosa's design.

## 3. Plugins: manifest, absence of a monitor component, and feature stages (Codex-source research only) **CONFIRMED (source)**

A plugin manifest's declarable components (`codex_plugin::manifest::PluginManifestPaths`,
`codex-rs/plugin/src/manifest.rs:19-24`) are exactly four: `skills` (a list), `mcp_servers`
(a path or inline object), `apps`, and `hooks` (a list of paths, or inline `HooksFile`s). **There is
no monitor, watcher, or background-process component type anywhere in the manifest schema** — a
Codex plugin can bundle skills, an MCP server, an app, and/or hooks, and nothing else. This confirms
by absence that Codex has no plugin-native equivalent of Claude's per-session plugin monitor; the
Codex provider's own push transport (§4 below) is not plugin-delivered at all.

Feature-flag stages (`codex-rs/features/src/lib.rs`'s `FeatureSpec` table):
- `hooks` (`Feature::CodexHooks`, `features/src/lib.rs:1187`) — `Stage::Stable`, `default_enabled: true`.
- `plugins` (`Feature::Plugins`, `features/src/lib.rs:1395`) — `Stage::Stable`, `default_enabled: true`.
- `plugin_hooks` (`Feature::PluginHooks`, `features/src/lib.rs:1413`) — `Stage::Removed`, `default_enabled: false`,
  documented in the enum itself as "Removed compatibility flag for plugin-bundled lifecycle hooks"
  (`features/src/lib.rs:242`). A config file that still sets `plugin_hooks` is silently ignored, not
  rejected — the flag exists only so an old config doesn't hard-fail.

Both hooks and plugins are therefore stable, on-by-default Codex features, not experiments — the
2026-07-21 framing of a "multi-event hook framework" as something new/emerging no longer applies;
it's the established baseline. None of this is glosa's own behavior — glosa is not a Codex plugin
and consumes no Codex hook.

## 4. The app-server model — this is glosa's actual Codex push mechanism **CONFIRMED (source)**

**TUI runs on the app-server; there is no separate legacy TUI transport.** The `tui_app_server`
legacy config key is recognized only to be silently dropped (`codex-rs/features/src/lib.rs:589-591`,
matched and `continue`d with no effect) — it used to gate whether the TUI spoke to a local
app-server; now that path is unconditional, and the TUI's own remote-attach code
(`codex-rs/tui/src/lib.rs:397-408`, `resolve_remote_addr`) resolves a bare `unix://` URL to the same
control socket every other app-server client uses.

**Control socket path, as the source actually builds it** (not assumed from a CLI flag or a prior
comment): `codex-rs/app-server-transport/src/transport/mod.rs:56-73` defines
`app_server_control_socket_path(codex_home)` as
`codex_home.join("app-server-control").join("app-server-control.sock")` — exactly
`$CODEX_HOME/app-server-control/app-server-control.sock`.
Every consumer (`codex-rs/tui/src/lib.rs`, `codex-rs/cli/src/main.rs`,
`codex-rs/cli/src/doctor/background.rs`) resolves the path through this one function — matches
`packages/providers/codex/src/unix-websocket.ts`'s `codexControlSocketPath()` exactly.

**Multiple simultaneous connections are supported.** The control-socket acceptor loop
(`codex-rs/app-server-transport/src/transport/unix_socket.rs:80-136`, `run_control_socket_acceptor`)
`tokio::spawn`s a fresh task per accepted connection and immediately goes back to `accept()`ing —
there's no single-client assumption anywhere in the accept loop, so glosa's MCP shim attaching
alongside a live TUI session (or another tool) on the same socket is a supported shape, not an
edge case glosa has to defend against.

**Push mechanics** — `codex_app_server_protocol` (`codex-rs/app-server-protocol/src/protocol/common.rs`)
still names exactly the four methods glosa's attachment uses:
- `thread/resume` (`common.rs:565`, params `ThreadResumeParams` in
  `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:351`, including `exclude_turns: bool` at
  line 420) — resumes a specific `thread_id` without replaying its history.
- `turn/start` (`common.rs:1033`, params `TurnStartParams`,
  `codex-rs/app-server-protocol/src/protocol/v2/turn.rs:166`, `input: Vec<UserInput>`) — starts a
  turn on an idle thread.
- `turn/steer` (`common.rs:1045`, params `TurnSteerParams`, `v2/turn.rs:291`) — steers an
  **already-active** turn; `expected_turn_id: String` (`v2/turn.rs:312`, `expectedTurnId` on the
  wire) is a required precondition field, not optional — the request fails outright if it doesn't
  match the live turn, exactly the guard glosa's `CodexJsonRpcClient.deliver()` relies on.
- `turn/completed` notification (`common.rs:1932`, `"turn/completed"`) — the boundary signal glosa's
  attachment uses to clear its tracked active-turn id and to drive its own heartbeat
  (`packages/providers/codex/src/app-server.ts`'s `onTurnCompleted`).

This is exactly the shape `packages/providers/codex/src/{unix-websocket.ts,app-server.ts}`
implement — nothing in this refresh contradicts the existing provider code.

**New since the 2026-09-06 spike, noted but not load-bearing for glosa**: the CLI now has a
`codex app-server daemon {bootstrap,start,restart,stop,update,enable-remote-control,disable-remote-control,version}`
subcommand tree (`AppServerDaemonSubcommand`, `codex-rs/cli/src/main.rs:786-816`; the outer
`AppServerSubcommand::Daemon` wrapper is at `main.rs:761-763`) for installing a durable,
user-managed app-server process — `version` ("print local CLI and running app-server versions as
JSON", `main.rs:815-816`) was missing from the 2026-07-21/09-06 framing and is included here. This
is an explicit opt-in a user runs, not a default — it doesn't change glosa's own rule that `push`
is a live-connection fact per session, never inferred from installation (R4) — but it does mean the
"separately run `codex app-server --listen ...`" phrasing in A2 §F07 now has a documented
first-class CLI form (`codex app-server daemon bootstrap` / `start`) alongside the raw flag
invocation; worth an A2 wording pass the next time that appendix is touched, out of scope for this
docs pass.

## 5. Transcript / rollout file (Codex-source claim, then glosa's actual code path) **CONFIRMED (source)**

Codex-source fact, research only: every hook event's stdin struct carries `transcript_path`
directly (§1) — a hypothetical future Codex hook consumer would never have to derive or guess it
from anything else. This is not glosa's code path: glosa's Codex provider does not consume hook
events at all (no rung reads them; §7's two rungs are app-server push and MCP pull).

Independently, Codex's on-disk session storage doc comment (`codex-rs/rollout/src/list.rs:436`)
confirms the layout: `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` —
matching `packages/providers/codex/src/provider.ts`'s `transcriptPath()` scan exactly (same
three-level date directories, same `rollout-` prefix stripping). In glosa's actual code,
`transcriptPath()` returns `session.transcript_path` verbatim only when it was already present on
the `SessionBinding` — which would require either an explicit MCP bind that supplied one, or a
(currently uncalled-in-production) `detectSession(payload)` invocation against a payload that had
one. The live app-server push registration path supplies neither: `app-server.ts`'s
`daemon.register({session_id, provider, cwd, workspace_binding, source})` call carries no
`transcript_path` field at all. So in practice, every push-registered Codex session's
`transcriptPath()` call falls through to this directory scan — it is the normal path today, not a
fallback for a rare miss.

**New in this pass**: a background compression worker (`codex-rs/rollout/src/compression.rs`) can
rewrite a "cold" (not recently modified) rollout file to `<name>.jsonl.zst` to save disk. It only
targets cold files (`compress_rollout_if_cold_blocking`, `compression.rs:648`), so a live registered
session's own transcript — actively being appended to — is never a compression target; this doesn't
affect the `AgentProvider` interface. It is relevant to whoever eventually builds the conversation
mirror's Codex event mapper against **older** sessions, since `provider.ts`'s current scan only
matches `*.jsonl`, not `*.jsonl.zst`. The JSONL line-level event schema itself remains
**UNCONFIRMED** at the field level — still a separate, later task, not required for `AgentProvider`.

## 6. MCP — glosa is the server, Codex the client **CONFIRMED (source, this pass) / UNCONFIRMED where noted**

**Codex's MCP client surface, re-verified this pass.** `codex mcp {list,get,add,remove,login,logout}`
(`McpSubcommand`, `codex-rs/cli/src/mcp_cmd.rs:65-71`) is the current subcommand set — a superset of
the "add/list/login" this note previously named, all still present. `add`'s own doc comment
confirms where a server launcher entry lands: `~/.codex/config.toml`
(`mcp_cmd.rs:51`, `find_codex_home()` + `load_global_mcp_servers()`/`ConfigEditsBuilder` at
`mcp_cmd.rs:294,415-425`). That is what `mcpPull` needs — glosa runs its own MCP server
(`glosa mcp`), and a Codex session has `glosa` registered as one of its `mcp_servers`; the pull
direction is always "Codex calls glosa's tool." The prior claim of an additional **project-scoped**
`.codex/config.toml` location for `mcp_servers` has **no citation in this snapshot** — `mcp_cmd.rs`
names only the global `~/.codex/config.toml` — so it is removed here rather than repeated
unverified.

The prior claim that "`codex mcp-server` exists" is **contradicted by this snapshot**: the full
top-level `Subcommand` enum (`codex-rs/cli/src/main.rs:149-243`) has no `mcp-server` variant, and
the literal string `"mcp-server"` does not appear anywhere in this checkout. That claim is removed
rather than carried forward. `codex app-server` does exist (§4), but it speaks its own
`thread/turn` JSON-RPC protocol, not MCP — citing it as an "MCP-facing process" conflated two
different protocols, so that framing is also dropped.

**The environment a spawned local MCP server actually receives.** `create_env_for_mcp_server`
(`codex-rs/rmcp-client/src/utils.rs:16-59`), called from the local stdio launcher
(`codex-rs/rmcp-client/src/stdio_server_launcher.rs:276`), builds the child environment from an
allowlist, `DEFAULT_ENV_VARS` (unix, `utils.rs:162-175`): `HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER`,
`__CF_USER_TEXT_ENCODING`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `TZ`. Each name is copied only when it
is set in Codex's own environment (`filter_map(|var| env::var_os(var)…)`). On top of that come the
names the server's own `env` table declares (`local_stdio_env_var_names`, `utils.rs:90-100`), and
the custom-CA keys when set. The 2026-09-06 spike observed eight variables. That is consistent with
this allowlist on a host where `LC_ALL`, `TERM` and `TZ` were unset, and it is how A2 §F08 states the
result. No `CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CODEX_HOME` is on the allowlist or added by this
function. A glosa MCP server started by Codex therefore cannot identify its own thread from its
spawn environment; the thread id reaches glosa through an explicit bind instead.

**UNCONFIRMED (2026-09-06 spike, not re-verified) — which Codex tool actually exposes `CODEX_THREAD_ID`.**
The constant `CODEX_THREAD_ID_ENV_VAR` and a populating step do exist in this snapshot
(`codex-rs/protocol/src/shell_environment.rs:7,150-153`, `populate_env`'s "Step 6 - Populate the
thread ID environment variable when provided"), which shows Codex has *a* mechanism that can inject
`CODEX_THREAD_ID` into a spawned process's environment. This sparse checkout does not include the
caller that would confirm it is specifically the agent's **shell tool** invocation that receives
it, rather than some other Codex-spawned subprocess — that specific attribution rests on the
2026-09-06 spike's live measurement ("verified equal to the session id Codex printed"), not on a
source path in this snapshot. `connectPrompt` in `packages/providers/codex/src/provider.ts` still
asks the agent to read `CODEX_THREAD_ID` from its own shell environment; nothing here contradicts
that, but this pass cannot independently confirm the exact call site.

## 7. glosa's current Codex contract

Per `docs/requirements.md` R4, the delivery ladder is **`push → mcp_pull`**; there is no hook rung
of any kind, blocking or otherwise (#152). For Codex:

| Rung | Mechanism | Grounded in |
|---|---|---|
| push (async, idle-or-active) | app-server control socket: `thread/resume` once, then `turn/steer` (active turn known) or `turn/start` (otherwise) per delivered entry | §4 |
| mcp_pull | `glosa mcp` tool via `.codex/config.toml [mcp_servers.glosa]`, Codex as the calling client | §6 |

`capabilities = { push: <exact thread has a live app-server attachment>, mcpPull: true }` —
`push` is evaluated per session from the live connection, never from Codex installation or socket
existence (R4); a normal Homebrew/npm install has no socket listening by default, so the ordinary
fallback is MCP pull alone. `detectSession(payload)` accepts any payload carrying `session_id`
(string) + `cwd` (string) — every Codex `*CommandInput` struct in §1 carries exactly those two
fields under exactly those names, so this guard is structural, not heuristic, and mirrors the
Claude provider's own `looksLikeSessionPayload` guard exactly. `source` reads the payload's own
`source` field when present (`SessionStart` only — §1 confirms `SubagentStart` has no `source`
field), else falls back to `hook_event_name`, matching
`packages/providers/claude-code/src/provider.ts`'s fallback.

## 8. What's honestly unresolved

- **No Codex-side attention signal, by design, not as a gap to fill** (§1) — R9's attention model
  reads no provider hook at all, for Claude or Codex; it is driven solely by glosa's own
  `attention_request` entries. This is current, shipped behavior, not something "whoever builds R9"
  still has to solve.
- **Rollout JSONL event schema** (§5) — path and naming confirmed; line-level event shape is not;
  compressed (`.jsonl.zst`) cold rollouts are a new wrinkle for that future mapper, not for the
  current `AgentProvider`.
- **`codex app-server daemon` subcommand tree** (§4) — new in this snapshot; doesn't change glosa's
  push-is-a-live-fact rule, but A2 §F07's install-surface wording could eventually cite the CLI
  subcommand instead of (or alongside) the raw `--listen` invocation. Not acted on here — A2 is a
  normative appendix and this note doesn't edit it.
- **Which Codex tool reads `CODEX_THREAD_ID`** (§6) — the environment-injection mechanism is
  confirmed present in this snapshot; the specific "the shell tool sees it" attribution still rests
  on the 2026-09-06 spike's live run, not on a source path this sparse checkout includes. Re-verify
  with a wider checkout or a fresh live run before depending on it for anything new.
- The removed "`codex mcp-server`" and "project-scoped `.codex/config.toml`" claims (§6) — dropped
  as unsupported by this snapshot, not confirmed false; a future wider checkout could re-add either
  one with a real citation if it turns out to exist elsewhere in the tree.
- This document reflects `openai/codex` `main` at `1427825c4044d48b513c7d4ea32b84e58806a188`
  (2026-09-15). Codex CLI is a fast-moving target — a pin worth re-checking before any release gate
  that depends on this note.

## 9. Historical — the Stop-hook blocking gate and turn-boundary drain (retired by #152)

Kept for its source-grounding value only. **This is not glosa's contract.** Before #152 removed
every hook rung, glosa's plan was to implement a Codex `Stop`-hook handler mirroring Claude's
`decision:block` gate. That mechanism still exists in current Codex source exactly as described
below — nothing here is stale about Codex itself — it's simply no longer something glosa builds.

**The gate.** `codex-rs/hooks/src/events/stop.rs` — `Stop` fires when a turn completes; it is
synchronous/blocking. Stdin (`StopCommandInput`, `codex-rs/hooks/src/schema.rs`) carries
`session_id`/`turn_id`/`transcript_path`/`cwd`/`hook_event_name`/`model`/`permission_mode`/
`stop_hook_active`/`last_assistant_message`. Stdout/exit contract: exit 0 with
`{"decision":"block","reason":"<non-empty>"}` blocks the stop and injects `reason` as a continuation
prompt fragment (`HookPromptFragment`, `stop.rs`); a `block` with an empty `reason` is rejected as a
hook **failure**, not a no-op (`block_decision_without_reason_is_invalid` test, `stop.rs`). Exit 0
with `{"continue":false,"stopReason":"..."}` overrides any `decision:block` in the same payload
(`continue_false_overrides_block_decision` test, `stop.rs`). Exit code 2 with non-empty stderr has
the same blocking effect as `decision:block`, stderr as the reason. Empty/no stdout on exit 0 is a
no-op.

**The drain.** The non-blocking form used the same `Stop`/`UserPromptSubmit` hooks, returning plain
stdout or `hookSpecificOutput.additionalContext` instead of `decision:block` — surfacing a pending
entry as context without holding up the turn. Claude Code never had a separate async-drain hook
either; both providers would have collapsed `gate` and `boundaryDrain` into one rung for the same
reason.

Neither rung is implemented by `packages/providers/codex/src` today; the provider's only two rungs
are `codex_app_server` push and `mcp_pull` (§7).
