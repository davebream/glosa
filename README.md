<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/glosa-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/glosa-wordmark.svg">
  <img
    src="docs/assets/glosa-wordmark.svg"
    alt="glosa, annotated with the margin note: make it measurable"
  >
</picture>

<p><strong>The review surface for writing with coding agents.</strong></p>

<p>
  Read Markdown, HTML, and text as documents. Review exact passages, edit source,<br>
  and route feedback back to Claude Code or Codex without moving the work to a cloud service.
</p>

<p><sub>macOS 13+ &nbsp;·&nbsp; Bun 1.2.7+ &nbsp;·&nbsp; local-first &nbsp;·&nbsp; Apache-2.0</sub></p>

</div>

> [!WARNING]
> **glosa is an experimental public alpha.** Back up important work. The deterministic acceptance
> suites pass, but the final maintainer-reviewed compatibility rehearsal and token-revocation check
> are not yet approved for a live document week.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/hero-light.png">
  <img
    src="docs/assets/screens/hero-light.png"
    alt="A Claude Code terminal in front of glosa in a browser window. In glosa, the sentence &quot;Improve checkout reliability.&quot; is highlighted in a 90-day plan and a margin comment reads &quot;This phase has no measurable outcome. Give it a target I can check on day 60.&quot; In the terminal, that comment arrives as a glosa annotation with its file, line, and anchor confidence, and the agent rewrites the line with a day-60 target."
    width="830"
  >
</picture>

The agent keeps its terminal. The document gets a surface. A comment you write in the margin arrives
in that session as anchored feedback — with the file, the line, and the anchor confidence.

Writing in a terminal is fine. Reviewing a long document there is not. glosa gives the document its
own surface while the agent remains a normal interactive session in your terminal.

```text
agent drafts -> glosa renders -> you annotate or edit -> feedback reaches the bound session -> revision returns
```

## What glosa does

| Surface | What it is for |
|---|---|
| **Read** | Read rendered Markdown, trusted text, or isolated HTML without terminal noise. |
| **Review** | The margin, both ways. Attach feedback to a passage's durable source anchor, and answer the questions an agent session attaches to one. |
| **Edit** | Change the source directly; glosa saves and re-renders it as a human edit. |
| **History** | Compare versions and restore an earlier checkpoint without touching your repository's Git history. |

The workspace sidebar preserves directory nesting across mixed artifacts. Multiple workspaces can be
open at once, and feedback waits durably when no matching agent session is live.

### Comments stay attached to the words they are about

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/annotate-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/annotate-light.png">
  <img
    src="docs/assets/screens/annotate-light.png"
    alt="Two annotation cards in glosa&#39;s right margin, each quoting the passage it is attached to. Both cards read &quot;Waiting for a session&quot;, the feedback intent &quot;Change the words&quot;, and a Remove action. The underlined passages in the document show where each comment is anchored."
    width="960"
  >
</picture>

Each comment is stored against a durable source anchor — the quoted text plus its surrounding
context — not a line number that the next revision invalidates. Entries wait in the workspace journal
until a matching agent session picks them up, so nothing is lost when no session is running.

### Every revision is a version you can read and undo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/history-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/history-light.png">
  <img
    src="docs/assets/screens/history-light.png"
    alt="glosa&#39;s version history pane listing two versions of a plan: one labelled &quot;You — You edited this version&quot; and one labelled &quot;Unknown change — Started tracking this version&quot;. Below them, a word-level diff shows the two review-driven edits."
    width="960"
  >
</picture>

History lives in a shadow repository glosa keeps apart from your project's, so restoring an earlier
version never touches your project's Git history. Attribution is deliberately conservative: edits
made in glosa's own editor are yours by construction, and a change glosa did not witness through an
apply lease stays `Unknown change` rather than being credited to anyone. Edit a tracked file in your
own editor and glosa records it as exactly that — a file that changed outside glosa, since a named
checkpoint, attributed to nobody. It is a note in your inbox, not a task: nothing is asked of you, and
no agent is nudged with it unless its own session explicitly asks to watch for exactly this — it
waits there until you dismiss it either way.

If checkpoint storage is damaged, `glosa doctor --workspace <slug>` reports it and counts inbox entries
that reference missing history. `glosa doctor --workspace <slug> --repair-baseline` explicitly starts
a new baseline from current tracked files, so future saves can be captured again. It leaves your files
and surviving history intact; it cannot restore lost checkpoints.

### An agent can stop and wait for your verdict

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/approval-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/approval-light.png">
  <img
    src="docs/assets/screens/approval-light.png"
    alt="A strip across the top of the glosa document reading &quot;Final approval requested — Sign off on the revised day 31–60 targets before I start the week-05 check-in&quot;, with a Final approval button."
    width="960"
  >
</picture>

`glosa request-review <path> --require-approval --wait 30m` blocks in the agent's terminal until you
approve or reject that saved revision in the browser, then returns the verdict to the waiting
command. Without `--wait` the request parks in the inbox for later.

## Quick start

Install the alpha CLI globally:

```sh
bun add --global @davebream/glosa@alpha
```

Do not use the `davebream/glosa` GitHub shorthand: it installs the repository's moving default branch
rather than the published alpha.

<details>
<summary>If your npm config maps the <code>@davebream</code> scope to another registry</summary>

glosa is published to the public npm registry. A scope mapping in `~/.npmrc` — for example
`@davebream:registry=https://npm.pkg.github.com` — redirects the install and produces a 404. A scope
mapping outranks the `--registry` flag, and bun has no scoped-registry flag at all, so
`--registry=https://registry.npmjs.org/` does **not** fix this.

Install from the published tarball URL, which resolves without consulting any registry configuration:

```sh
bun add --global https://registry.npmjs.org/@davebream/glosa/-/glosa-0.1.0-alpha.22.tgz
```

Or, with npm, use the scoped form — which does beat a scope mapping:

```sh
npm install -g --@davebream:registry=https://registry.npmjs.org/ @davebream/glosa@alpha
```

After the first install, `glosa update` handles this automatically.

</details>

Add the official marketplace and install the Claude Code plugin once:

```text
/plugin marketplace add davebream/glosa
/plugin install glosa
```

For Codex, register the MCP server once:

```sh
codex mcp add glosa -- glosa mcp
```

That is the whole install. There is no `glosa init`, and glosa writes nothing into your agent's
configuration. Then open a writing workspace:

```sh
cd /path/to/your/workspace
glosa open
```

The plugin supplies Claude's MCP tools and one session monitor. A session started outside a glosa
workspace stays idle; after `glosa open` registers that directory, the same monitor connects without
a session restart. Read-only `glosa open` and `glosa_present` do not require an agent session. Run
`glosa doctor` to diagnose the daemon and monitor suppression,
or `glosa --help` to see every command. If an inbox entry's payload goes missing — moved or deleted
by hand — `glosa inbox list` names it and `glosa inbox dismiss <id>` closes it without a session.
To permanently delete a workspace's registration and bus (never its work-tree files), use
`glosa forget <slug> [--yes]` — it refuses first if a live session or apply lease is active, and
previews the exact paths before asking once.

`glosa open --document <file>` opens one document with no file navigator. Its link also works in
an existing workspace tab: unsaved editor changes require discard confirmation before navigation.
Cancelling keeps the draft and current view; document visits preserve your saved workspace tabs.

### Updating

```sh
glosa update           # upgrade in place
glosa update --check   # report what would change, install nothing
```

`glosa update` resolves the release over a plain HTTPS request that reads no npm configuration, verifies
the downloaded tarball against the registry's published sha512, and installs it through whichever package
manager owns your glosa install. It is the only part of glosa that makes an outbound network request, it
runs only when you invoke it, and it sends no identifying data.

> [!NOTE]
> A durable global install is required by the plugin launcher. `bunx` and `npx` remain suitable for
> one-shot commands.

## Agent support

| Agent | Integration |
|---|---|
| **Claude Code** | Official plugin with MCP pull and a per-session monitor over the generic push stream. |
| **Codex** | App-server push when its local control socket is running, with MCP pull as the fallback. |
| **Generic MCP host** | Durable feedback can be pulled through the MCP tools without teaching the core about that agent. |

glosa binds feedback to an explicit live session when possible. If more than one session matches, the
browser asks instead of guessing. If none is live, the entry parks until a matching session registers.

A running session survives a glosa daemon restart: its next MCP tool call re-registers it. Restore
an explicit workspace connection with `glosa_session_bind` or
`glosa session bind <session-id> --workspace <path>`; binding also registers an unknown session, so
restarting the agent is unnecessary. Claude identity comes from its session environment. Codex's MCP
process receives no thread identity, so the agent reads `CODEX_THREAD_ID` in its shell and supplies it
with MCP `provider:"codex"`. `--provider <id>` supplies identity explicitly to the CLI. Without provider evidence,
binding uses a generic MCP session. A missing transcript affects only the conversation mirror.
Open session streams keep the session lease alive; once closed, the lease expires after its remaining TTL.

Codex push requires a separately running app-server control socket. Glosa never starts it. The
standalone Codex distribution can manage that daemon; Homebrew/npm users can run it themselves before
starting the TUI:

```sh
codex app-server --listen "unix://$CODEX_HOME/app-server-control/app-server-control.sock"
```

`glosa_session_bind` starts the attachment inside the long-lived MCP process. For troubleshooting or
an MCP host without that lifecycle, run `glosa codex-attach <thread-id> --workspace <path>` in a
foreground terminal and stop it with Ctrl-C. If the socket is absent, feedback remains available via
`glosa_inbox_pull`.

## Related tools

glosa is one part of a useful ecosystem of human-in-the-loop tools. These projects solve adjacent
problems well; use the one that best fits the work.

| Project | Reach for it when | How glosa differs |
|---|---|---|
| [Plannotator](https://github.com/backnotprop/plannotator) | You want a mature, on-demand review surface for plans, documents, HTML, code diffs, or pull requests, with broad agent support and optional sharing. | glosa treats a directory as a long-lived writing workspace. Its journal, parked feedback, shadow history, and conservative provenance are designed to survive changes across files, tools, and agent sessions. It deliberately has no sharing service or runtime network egress. |
| [Agentation](https://github.com/benjitaylor/agentation) | You are reviewing a running React interface and want element, area, or text annotations with selectors an agent can act on. | glosa reviews file-backed Markdown, HTML, and text, then routes durable feedback through each agent's own push transport and MCP. It does not embed a feedback toolbar in the application being reviewed. |

Plannotator is the closest neighboring project and a strong place to start for established plan,
document, or code review today. glosa is exploring a narrower question: can a sensitive writing
workspace remain local, durable, and honestly attributable across many artifacts and agent sessions?

## Local by design

- glosa listens only on your Mac. `glosa open` pairs your browser tab with the local API at `http://glosa.localhost:4646`, and requests routed through other websites are rejected ([security model](docs/appendices/A3-security.md)). Browsers and macOS answer `.localhost` names on your machine without a DNS lookup. Set `GLOSA_OPEN_HOST=127.0.0.1` to get `http://127.0.0.1:4646` links instead; the daemon accepts both.
- glosa has no telemetry, cloud sync, or external runtime calls. Your agent may still send content to its own provider under that tool's terms.
- Versions live in a shadow repository glosa keeps for itself: in the workspace's `.glosa/` folder, or under `~/.glosa/state/` when it does not sit beside your files, for example for a single file opened on its own, a folder you cannot write to, or a folder opened with `glosa open --external-state`. glosa never assumes or modifies your real Git repository. Nothing in that history expires and individual versions cannot be deleted; `glosa forget <slug>` deletes a workspace's entire history and leaves your files alone.
- Provenance is conservative: edits are attributed to a session only when an apply lease proves it; everything else is `human` or `unknown`, never guessed. A change glosa merely finds on disk is reported as an external edit, never as one you made.

If a local bearer token may have leaked, run `glosa token revoke`, then `glosa open <directory>` to
create and pair a replacement. Use `glosa token rotate` for immediate replacement. Token commands
never print credential material.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/davebream/glosa/security/advisories/new),
not a public issue. See [SECURITY.md](SECURITY.md).

## How it is built

```text
Claude Code / Codex
        |
  plugin monitor / app-server push + MCP
        |
  glosa daemon -------- browser workspace
        |
 workspace files + append-only journal + shadow history
```

glosa is a Bun + TypeScript monorepo with one daemon serving a small vanilla-JS SPA. The core is
agent- and domain-agnostic: agent knowledge belongs in providers, while artifact metadata enters
through a declarative adapter boundary. The append-only journal is the source of truth for every
feedback lifecycle.

Start with [the requirements](docs/requirements.md) for the normative contract, [the roadmap](ROADMAP.md)
for accepted direction, and [the decision log](docs/decisions.md) for the reasoning behind the design.

## Development

```sh
bun install --frozen-lockfile
bun run setup:hooks
bun run typecheck
bun test
bun run audit:licenses
bun run package:check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a
pull request. The project is licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution details.
