# Agent session connection

Date: 2026-08-06

Issue: #95

Status: implemented

## Decision

glosa exposes one explicit Agent feedback control for the selected workspace. It reports the
session connection independently from integration wiring, then gives the user a provider-owned
prompt to paste into the agent session they intend to connect. glosa does not launch an agent,
enumerate agent CLIs, guess a target, or persist a binding.

The two supported directions are:

| Direction | User action | Binding mechanism |
|---|---|---|
| Agent opens glosa | From the agent session, run `glosa open <target> --bind <own-session-id>` | CLI registers the workspace, then calls the existing explicit HTTP binding route. |
| SPA reconnects an agent | In Agent feedback, choose a provider, copy the prompt, and paste it into the intended agent session. | The agent reads its provider-owned current-session id and calls `glosa_session_bind`; the prompt also shows the generic CLI fallback. |

```text
agent session --open + own id--> glosa daemon --explicit binding--> workspace
SPA --copy provider prompt--> intended agent session --explicit binding--> glosa daemon
```

Both flows converge on the same in-memory `workspace_binding`. Neither creates another binding
store or changes session arbitration.

## Connection state

The SPA reads the existing `/api/status` session rows and derives state only from
`workspace_binding` and `liveness`:

```text
any explicit alive binding --> CONNECTED
otherwise any explicit stale binding --> STALE
otherwise --> UNBOUND
```

Cwd-ancestor routing does not count. It remains a delivery fallback, but displaying it as connected
would overstate user intent. If at least one explicit live session exists, the workspace is connected
even when another explicit session is stale. The popover lists every explicit live or stale binding
without changing the router's arbitration.

Integration wiring is orthogonal. When wiring is absent, the control appends `feedback off` without
hiding connected/stale/unbound state and retains the consented Wire it now action. Pending journal
entries remain visible as a queued count.

## Provider boundary

`AgentProvider.connectPrompt({slug, path})` returns:

```ts
{
  display_name: string;
  instruction: string;
}
```

Provider authors must:

1. Describe how the current agent session obtains its own opaque session id.
2. Tell that session to call `glosa_session_bind` with the exact id and workspace path.
3. Keep the method pure: no process launch, registration, binding, network call, or filesystem write.
4. Avoid secrets and durable identity claims; the prompt is local, human-visible copy.
5. Treat registration as a prerequisite. For open-and-bind, an unknown or stale id must preserve the
   existing nonfatal warning and usable presentation URL.

Claude Code owns `CLAUDE_CODE_SESSION_ID` guidance. Codex owns `CODEX_THREAD_ID` guidance. Those
names and agent-specific words do not enter the daemon core or SPA. The daemon adds only workspace
identity and this fallback:

```text
glosa session bind <current-session-id> --workspace <workspace-path>
```

An unbound workspace with one available provider selects it automatically. With several providers,
the user must choose. A stale workspace preselects the provider of the most recently active stale
explicit binding.

## Recovery and freshness

Bindings are session-scoped and daemon-memory-scoped. A session end, lease expiry, or daemon restart
may move the UI to stale or unbound. Recovery is another explicit bind from the intended current
session; glosa never restores a previous association from disk.

No new stream event exists for binding. The SPA reuses aggregate status reads on:

- workspace selection;
- existing workspace-stream activity and reconnect;
- window focus;
- the existing 15-second timer.

Overlapping reads are latest-request-wins. Any failed aggregate refresh clears the prior observation,
so a disconnected daemon cannot leave a stale connected claim on screen.

## Rejected: SPA-driven agent CLI control

The SPA does not discover or drive Claude Code, Codex, or another agent CLI. Doing so would require
provider-specific process discovery and launch behavior in the generic product surface, would still
leave multi-session selection ambiguous, and would turn a visible user choice into a hidden control
action. It would also invite terminal-host coupling, including cmux-specific behavior, which glosa
explicitly forbids.

The copy-prompt design keeps the target choice with the user, provider semantics in providers, and
all runtime communication on glosa's existing local authenticated API/MCP paths. It adds no outbound
network call, telemetry, authentication mechanism, persistence layer, or agent-launch capability.
