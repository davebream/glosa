# Public boundary decisions

This file records current architectural boundaries. `docs/requirements.md` and its normative
appendices remain the authoritative build input.

## External integrations are declarative

External integrations own their packages, workflow logic, and domain vocabulary. They register a
`WorkspaceMetadataDescriptor` v1 through glosa's CLI or MCP tools. glosa persists one active
descriptor per workspace and exposes it through the existing generic `ContentAdapter` interface.

The descriptor may declare artifact class, ordering, a derived-from edge, and a manifest location.
The core interprets only those generic fields. It does not import an integration package, inspect
an integration's state schema, or infer workflow behavior from filenames.

## Session routing is explicit when cwd is insufficient

Providers register live sessions. An external integration may then bind a live session to a glosa
workspace through `glosa session bind` or `glosa_session_bind`. Bindings are session-scoped and
must be restored by the integration after session registration or daemon restart.

## Runtime trust boundary

glosa remains local-first and makes no telemetry or external runtime calls. Channels are an
optional delivery optimization. Hook, turn-boundary, and MCP delivery remain supported fallbacks.

## Token lifecycle is a local filesystem authority

Rotation and revocation mutate the single mode-0600 token file directly instead of calling an API
route. This keeps recovery available when the daemon is stopped or its in-memory token state is stale,
and avoids a second persisted epoch whose update could not be atomic with the token file. Atomic rename
or unlink is the durable linearization point; the daemon derives an in-memory generation from the
complete current value.

The daemon combines a directory watcher with request-time refresh. A generation change aborts existing
credential-bound streams and clears class-F capabilities; subsequent Bearer checks accept only the new
value. The CLI never returns the replacement token. `glosa open` remains the explicit browser-pairing
boundary and recovery path.

## The URL fragment is the canonical on-screen focus

The SPA reflects the current workspace and open artifact into the address-bar fragment
(`#w=<slug>&a=<artifact>`) via `history.replaceState` as the user navigates, not only on load. This
makes reload/refresh restore the view and makes the URL shareable, so focus lives in one place
instead of duplicated UI state. The deep-link is no longer one-shot: `readRoute` seeds the initial
view and `writeFocus` keeps it current thereafter.

Three constraints hold this inside the security boundary:

- **Fragment, never query string.** Focus stays in the `#` fragment so it is never sent to the
  daemon or written to its request path (A1 §2) — the same reason the pairing token uses the
  fragment.
- **The written fragment carries only `w`/`a`, never `t=`.** `focusHash` is rebuilt from scratch on
  every call and reads only slug/artifact, so live-reflecting focus can never re-expose the pairing
  token that `scrubSecrets` strips on load (A3 §3/F24). This is structural, not a runtime filter.
- **`replaceState`, not `pushState`.** Reflecting focus does not spawn a history entry per artifact;
  it mutates the current one.

Mode (Preview/Annotate/Edit) is deliberately **not** in the URL. It is an act with a stateful save
guard (leaving Edit while dirty is blocked pending a discard prompt), and a shareable link should
land in Preview rather than the source editor — modes are acts, not defaults.

## Ownership rule

A change that needs integration-specific code belongs outside this repository. A change belongs in
glosa only when it strengthens a generic contract that remains useful with zero adapters loaded.

## Agent onboarding is scoped, targeted, and lazy

Research snapshot: 2026-07-25. The comparison uses first-party documentation and the current Sentry
Wizard source rather than assuming the examples in issue #65 remained unchanged.

| Tool | Scope model | Target detection/selection | Interaction pattern |
|---|---|---|---|
| Claude Code | MCP has explicit `local` (private project), `project` (shared `.mcp.json`), and `user` scopes; settings also have user, shared-project, and local-project layers. | Single-agent tool, so no agent selection. | `claude mcp add` is flag-driven; `--scope` is explicit and no setup wizard is required. |
| Codex | Personal defaults live in `~/.codex/config.toml`; trusted repositories may add `.codex/config.toml`. Hooks follow the same user/project split. `codex mcp add` currently writes the user config; project scope is configured in the project file. | Single-agent tool, so no agent selection. | CLI add is flag-driven. Authentication may prompt, but scope selection is not a wizard. |
| Sentry Wizard | Mutates the selected project; it has no user/global configuration scope. | The integration is supplied with `--integration` or selected from a prompt. Contrary to the original issue snapshot, the current dispatcher does not auto-detect the framework. | Interactive by default where choices are missing; explicit flags support scripted runs. `--quiet` prevents fallback questions in legacy flows, and a narrower `--non-interactive` mode exists for agentic Apple setup. |
| glosa (decision) | `workspace` (default) or explicit `user`. | Repeated `--agent` flags are authoritative. Provider-owned, local-only probes may resolve an omitted target when exactly one provider is present; ambiguous selection gets one TTY prompt or a usage error in non-interactive mode. | Flags are the complete automation surface. Prompts fill only an unresolved provider choice and never occur in `--json` or non-TTY mode. |

Sources:

- [Claude Code MCP scopes](https://docs.anthropic.com/en/docs/claude-code/mcp#installation-scope)
  and [settings precedence](https://docs.anthropic.com/en/docs/claude-code/settings#settings-files)
- [Codex configuration layers](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Sentry Wizard options](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/README.md#options),
  [CLI flags](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/bin.ts),
  and [integration selection](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/src/run.ts)

The resulting glosa design is:

- `glosa open` is the first-run path. It creates workspace state and opens Preview without installing
  hooks or agent configuration. Preview-only `glosa_present` remains session-independent.
- `glosa init` installs delivery integration only when the user wants feedback routing, hooks,
  conversation delivery, or optional Channels. It never runs implicitly from `open`.
- `--scope workspace` is the compatibility-preserving default. `--scope user` is an explicit choice
  because user hooks run in every project and therefore have a wider overhead and trust surface.
- Agent detection is advisory and local-only: provider executables and existing provider config may
  inform a default, but glosa never launches an agent, reads a transcript, or performs network
  discovery during init.
- Provider-specific config paths, detection, desired nodes, and activation help come from
  `packages/providers/*`. The generic CLI owns selection, transaction/rollback, backups, and the
  ownership manifest; it does not gain Claude Code or Codex branches.

## A glosa install never stops a daemon it did not start

`build_id` answers "which bytes is this daemon running"; it cannot answer "whose daemon is this".
Those are different questions, and conflating them made every command a takeover: a source checkout
and a published install of the same version each read the other as a divergent build and SIGTERMed
it, so the two evicted each other continuously. Observed in the wild as seven daemons from three
source trees contending for one port, with the process count halving every few seconds.

Daemons therefore publish an `install_id` — `sha256(realpath(<package root>))`, truncated — in the
lock and the handshake, and a client refuses to signal a daemon that identity proves belongs to
somewhere else.

Three deliberate consequences:

- **An absent `install_id` is unknown, never "mine".** Two `undefined`s do not compare equal for
  this purpose. Equal-version-different-bytes is ambiguous — a developer editing their own source,
  or two installs sharing a home — so it needs proof of ownership and resolves the unknown case to
  refusal.
- **An upgrade is exempt from that burden.** A strictly newer client replacing an older daemon is
  the documented path, and every existing daemon predates the field, so requiring proof there would
  break every user's next upgrade exactly once. It restarts unless the daemon is provably foreign.
- **The id is a hash, not the path.** `/api/handshake` is tokenless, and a filesystem path on an
  unauthenticated endpoint is a privacy regression for a tool holding manuscripts. The hash is not
  a secrecy boundary either — its input is guessable, and A3's threat model is hostile web content,
  not a same-uid process, which can read `<home>/token` directly regardless.

## A source checkout gets its own home and port

Running glosa from a checkout used to mean sharing `~/.glosa` and port 4646 with whatever the user
had installed: one lock, one pairing token, one workspace index, two mutually hostile daemons. A
checkout now derives `~/.glosa-dev/<install_id>` and a deterministic port in 60000–65498.

The home lives **outside** the working tree deliberately. `.gitignore` protects only git-mediated
paths — not backups, not sync, and above all not the coding agents that read an entire repository,
which is exactly the tooling glosa is built to sit beside. A plaintext bearer credential inside a
checkout is a credential in the blast radius of every "read all the files in this project".

Deriving rather than refusing: a developer who edits source genuinely wants their own daemon
restarted, and an error would leave the default still pointing at `~/.glosa` for anyone who ignored
it. The cost is that a checkout no longer sees state created before this change; the CLI says which
values it derived, once, on an interactive terminal, and `GLOSA_HOME=~/.glosa` restores the old
behaviour.

## Rejected requests are logged by reason, never by request

A de-pair report could not be settled after the fact, because nothing recorded why a 401 was
returned — "the tab held a stale credential" and "this daemon held no credential" are the same
response on the wire and completely different diagnoses. The daemon now records the reason.

It records nothing else. The request path is attacker-controlled, so logging it would be both an
injection vector into a line-oriented log and unbounded key cardinality — and a throttle keyed on
the path is no throttle at all, since varying the path makes every request a fresh first
occurrence. The key is the reason alone, first occurrence immediate, then at most one line per
minute carrying the suppressed count.

