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

## A 401 from a daemon we did not pair with is not a revocation

The SPA treated every 401 as proof that its credential had been revoked: it removed
`sessionStorage.glosa_token` and reloaded. Bootstrap has already stripped `#t=` from the URL by
then, so nothing could put the credential back — the tab was unpaired permanently, and the only
recovery was a fresh `glosa open`.

That inference is wrong whenever the daemon answering is not the one that issued the credential,
which is precisely what happens when a second glosa install takes the port. The rejection says
nothing about the credential; discarding it destroys the only route back.

Tabs now record the issuing daemon's `install_id` beside the token, and a 401 is classified against
the tokenless handshake before anything is discarded: unreachable (an outage, no verdict), a
different install (foreign), or anything else (revoked, exactly as before).

The safety of keeping a credential in the foreign case rests on not transmitting it, not on
possession. In that state the tab stops sending authenticated requests altogether and polls only the
tokenless handshake, so a process that seizes the port receives strictly less than it does today —
where every stream reconnect re-offers the Bearer to whatever is listening. The wait is bounded at
ten minutes, after which the tab falls back to discarding the credential.

`install_id` is not a proof of possession and is not treated as one. Anything that can bind
127.0.0.1 as this user can also read `<home>/token` directly, so it defends against a coexisting
install, which is an accident, and not against a same-uid attacker, who is outside A3's threat
model either way.

## Claude Code has more than one config root, and glosa has to see all of them

`$CLAUDE_CONFIG_DIR` relocates Claude Code's entire user configuration. Account switchers use
exactly that to give each account its own root, so a machine running one has several live Claude
config directories, each with its own settings, its own MCP registry and its own transcripts.

glosa assumed one. Two consequences, in opposite directions:

- **`init --scope user` wrote the wrong file.** It resolved `~/.claude/settings.json` from the home
  directory and never read the variable, so running it inside a switcher session wired a file that
  session does not load — and reported success. It now targets the root the asking session actually
  reads.
- **Transcripts from every other root were refused.** The daemon is a singleton: it inherits one
  `CLAUDE_CONFIG_DIR` from whichever process spawned it, but serves sessions from all of them. A
  session under another root reports a `transcript_path` outside the daemon's, and single-root
  confinement rejected it with a 400 that looks like a path attack. Confinement now takes a set.

Several roots never weaken confinement. Each is realpath'd independently, an unresolvable one is
simply not a root, and a path is admitted only by resolving inside one of them — so more roots is
more chances to be confined, never a looser check. A symlink escape out of one root is still
refused, because confinement applies to the resolved path.

One `init` still wires one root. Writing to all of them at once means merging into several files
glosa does not own — including per-account `.claude.json` registries a switcher actively rewrites —
and that deserves its own change with its own confinement rules, not a silent widening of what
`--scope user` already means. `doctor` reports the roots it found and which are not wired, so the
gap is visible rather than assumed absent.

Discovery recognises a list of known layouts rather than searching: `$CLAUDE_CONFIG_DIR`,
`~/.claude`, and `~/.ccs/instances/<account>` — the one switcher convention supported so far. A
switcher that arranges its directories differently needs its own entry, and until it has one its
sessions are covered only while they are the active `CLAUDE_CONFIG_DIR`. There is deliberately no
sweep of the home directory for anything Claude-shaped: a wrong guess there widens a confinement
boundary, which is the one kind of mistake this code must not make.

Root discovery is filesystem-only and read-only: no network, no process inspection, nothing
launched (invariant 5). Which variable and which directories matter is provider knowledge and lives
in the claude-code provider; the core supplies only a generic, injectable capability to read the
environment, so it still knows nothing about any particular agent (invariant 1).

