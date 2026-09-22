<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/glosa-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/glosa-wordmark.svg">
  <img
    src="docs/assets/glosa-wordmark.svg"
    alt="glosa, with a vermilion comma mark and a margin note reading: make it measurable"
  >
</picture>

<p><strong>A calm place to read and review what your coding agent writes.</strong></p>

<p>
  Read Markdown, HTML and text as documents. Mark exact passages, edit the source,<br>
  and send your notes back to Claude Code or Codex without moving the work to a cloud service.
</p>

<p><sub>macOS 13+ &nbsp;·&nbsp; Bun 1.2.7+ &nbsp;·&nbsp; local-first &nbsp;·&nbsp; Apache-2.0</sub></p>

</div>

> [!WARNING]
> **glosa is an experimental public alpha.** Back up important work. The deterministic acceptance
> suites pass and token rotation and revocation have shipped. Maintainer sign-off on the real-session
> compatibility rehearsal is still pending, so glosa is not yet approved for a live document week.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/hero-light.png">
  <img
    src="docs/assets/screens/hero-light.png"
    alt="A Claude Code terminal beside glosa in a browser. In glosa, the sentence &quot;Improve checkout reliability.&quot; in a 90-day plan is selected and a note is being written under it: &quot;This phase has no measurable outcome. Give it a target I can check on day 60.&quot; In the terminal, the agent pulls that note from glosa with its file, line and anchor confidence, takes an apply lease, rewrites the sentence with a day-60 target, and resolves the note as applied."
    width="830"
  >
</picture>

The agent keeps its terminal and the document gets its own page. Select a passage, write a note under
it, and the note reaches that session as anchored feedback: the file, the line and how confidently
glosa matched the words.

Writing in a terminal works. Reviewing a long document there does not. glosa renders the document
beside the agent, which stays a normal interactive session in your terminal.

```text
agent drafts -> glosa renders -> you mark or edit -> the note reaches the bound session -> the revision comes back
```

## What glosa does

| On the page | What it is for |
|---|---|
| **Reading and notes** | A document opens rendered, with the margin beside it. Select words and a note opens right under them; your notes and a session's questions sit beside the passages they are about. **Notes** hides the margin when you just want to read. |
| **Edit** | **Edit** (⌘E) turns the same page into an editor, rich or exact source, and **Done** turns it back. glosa saves only the blocks you changed and records the edit as yours. |
| **Go to** | The document's path in the top bar, or ⌘K, jumps to a section or a file, or runs a command such as hiding notes. |
| **History** | Compare versions and restore an earlier one without touching your repository's Git history. |

Each document can be set in the default serif, a sans or a mono face from its own menu. The sidebar
keeps your directory structure across mixed files, several workspaces can be open at once, and notes
wait safely when no matching agent session is running.

### Notes stay attached to the words they are about

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/annotate-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/annotate-light.png">
  <img
    src="docs/assets/screens/annotate-light.png"
    alt="Two notes in glosa's right margin, each level with the underlined passage it is about. One asks how many pages the checkout timeouts caused last quarter; the other asks who reviews the request-path diagram. Both read &quot;Waiting for a session&quot; with the intent &quot;Change the words&quot; and Edit and Remove actions."
    width="960"
  >
</picture>

Each note is stored against the quoted words and a little context on either side, not a line number
that the next revision breaks. If the passage changes so much that glosa can no longer find it, the
note says so ("Lost its place") instead of pointing somewhere wrong. Notes wait in the workspace
journal until a matching agent session picks them up, so nothing is lost while no session is running.

### Every revision is a version you can read and undo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/history-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/history-light.png">
  <img
    src="docs/assets/screens/history-light.png"
    alt="glosa's version history for a plan, listing three versions: &quot;You: You edited this version&quot;, &quot;An agent session: Agent applied a change&quot;, and &quot;Unknown change: Started tracking this version&quot;, with a button to compare the selected version with the current one."
    width="960"
  >
</picture>

History lives in a shadow repository that glosa keeps apart from your project's, so restoring a
version never touches your project's Git history.

Attribution is deliberately conservative:

- an edit made in glosa's own editor is yours;
- a change is credited to an agent session only when the session held an apply lease for that note;
- anything else stays `Unknown change` rather than being credited to anyone.

Edit a tracked file in another editor and glosa records exactly that: the file changed outside glosa,
attributed to nobody. It appears in your inbox as information, not a task. No agent is nudged about
it unless its own session asked to watch for outside changes, and it stays until you dismiss it.

If checkpoint storage is damaged, `glosa doctor --workspace <slug>` reports it and counts inbox entries
that reference missing history. `glosa doctor --workspace <slug> --repair-baseline` starts a new
baseline from the current tracked files so later saves are captured again. It leaves your files and
surviving history alone, and it cannot bring back lost checkpoints.

### An agent can stop and wait for your verdict

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/approval-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screens/approval-light.png">
  <img
    src="docs/assets/screens/approval-light.png"
    alt="A strip across the top of a glosa document reading &quot;Final approval requested: Sign off on the revised day 31–60 targets before I start the week-5 check-in&quot;, with a Final approval button."
    width="960"
  >
</picture>

`glosa request-review <path> --require-approval --wait 30m` blocks in the agent's terminal until you
approve or reject that saved revision in the browser, then hands the verdict back to the waiting
command. Without `--wait`, the request waits in the inbox for later.

## Quick start

Install the alpha CLI globally:

```sh
bun add --global @davebream/glosa@alpha
```

Do not use the `davebream/glosa` GitHub shorthand. It installs the repository's moving default branch
instead of the published alpha.

<details>
<summary>If your npm config maps the <code>@davebream</code> scope to another registry</summary>

glosa is published to the public npm registry. A scope mapping in `~/.npmrc`, for example
`@davebream:registry=https://npm.pkg.github.com`, redirects the install and produces a 404. A scope
mapping outranks the `--registry` flag, and bun has no scoped-registry flag at all, so
`--registry=https://registry.npmjs.org/` does **not** fix this.

Install from the published tarball URL, which resolves without consulting any registry configuration:

```sh
bun add --global https://registry.npmjs.org/@davebream/glosa/-/glosa-0.1.0-alpha.30.tgz
```

Or, with npm, use the scoped form, which does beat a scope mapping:

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

The plugin supplies Claude's MCP tools and one session monitor per session. A session started
outside a glosa workspace stays idle; once `glosa open` registers that directory, the same monitor
connects without restarting the session. A session that installed the plugin after it began has no
monitor yet, so running the `glosa-connect` skill starts one — and whichever route starts it, only
one ever runs for a session. Read-only `glosa open --read` and `glosa_present` do not need an agent
session.

A few commands worth knowing:

- `glosa doctor` diagnoses the daemon and the session monitor; `glosa --help` lists every command.
- `glosa inbox list` names an inbox entry whose file was moved or deleted by hand, and
  `glosa inbox dismiss <id>` closes it without a session.
- `glosa forget <slug> [--yes]` permanently deletes a workspace's registration and history, never your
  files. It refuses while a live session or apply lease is active and previews the exact paths first.
- `glosa open --document <file>` opens one document with no file navigator. Its link also works in an
  open workspace tab: unsaved edits need a discard confirmation first, and cancelling keeps the draft.
- `glosa dictation configure --provider wispr-flow` explicitly enables Wispr Flow for the four prose
  composers after showing its data disclosure and storing the organization key in macOS Keychain.
  `glosa dictation status` is local-only; `glosa dictation disable` turns egress off before removing
  the credential.

### Updating

```sh
glosa update           # upgrade in place
glosa update --check   # report what would change, install nothing
```

`glosa update` fetches the release over a plain HTTPS request that reads no npm configuration, checks
the downloaded tarball against the registry's published sha512, and installs it through whichever
package manager owns your glosa install. It runs only when you invoke it and sends no identifying
data. The other optional external action is configured dictation, which starts only when you click
Dictate and sends only the data named in its consent disclosure.

> [!NOTE]
> The plugin launcher needs a durable global install. `bunx` and `npx` are fine for one-off commands.

## Agent support

| Agent | Integration |
|---|---|
| **Claude Code** | Official plugin with MCP pull and a per-session monitor over the generic push stream. The monitor starts at session start, or when `glosa-connect` runs in a session that began without the plugin. |
| **Codex** | App-server push when its local control socket is running, with MCP pull as the fallback. Binding a session is what starts the attachment. |
| **Generic MCP host** | Notes can be pulled through the MCP tools without teaching glosa's core about that agent. |

glosa binds notes to an explicit live session when it can. If more than one session matches, the
browser asks you instead of guessing. If none is live, the note waits until a matching session
registers.

A running session survives a daemon restart: its next MCP tool call registers it again. To restore an
explicit connection, use `glosa_session_bind` or `glosa session bind <session-id> --workspace <path>`.
Binding also registers an unknown session, so the agent does not need a restart.

Claude Code's session identity comes from its session environment. Codex's MCP process receives no
thread identity, so the agent reads `CODEX_THREAD_ID` in its shell and passes it with MCP
`provider:"codex"`. On the CLI, `--provider <id>` supplies identity explicitly. Without any provider
evidence, binding uses a generic MCP session.

A missing transcript only affects the conversation mirror. Open session streams keep the session lease
alive; once they close, the lease expires after its remaining time. Whether a session holds one right
now is reported per session by `glosa status --json` and named by `glosa doctor`, because being bound
and being reachable by push are different things — and a note queued for a bound session with no
stream waits until something pulls it.

Codex push needs a separately running app-server control socket, and glosa never starts it. The
standalone Codex distribution can manage that daemon; Homebrew and npm users can start it themselves
before the TUI:

```sh
codex app-server --listen "unix://$CODEX_HOME/app-server-control/app-server-control.sock"
```

`glosa_session_bind` starts the attachment inside the long-lived MCP process. For troubleshooting, or
for an MCP host without that lifecycle, run `glosa codex-attach <thread-id> --workspace <path>` in a
foreground terminal and stop it with Ctrl-C. If the socket is missing, notes stay available through
`glosa_inbox_pull`.

## Related tools

glosa is one of several human-in-the-loop tools. These projects solve neighbouring problems well; use
whichever fits the work.

| Project | Reach for it when | How glosa differs |
|---|---|---|
| [Plannotator](https://github.com/backnotprop/plannotator) | You want a mature, on-demand review surface for plans, documents, HTML, code diffs or pull requests, with broad agent support and optional sharing. | glosa treats a directory as a long-lived writing workspace. Its journal, waiting notes, shadow history and conservative attribution are built to hold up across files, tools and agent sessions. It has no sharing service; unconfigured core use makes no external runtime calls. |
| [Agentation](https://github.com/benjitaylor/agentation) | You are reviewing a running React interface and want element, area or text annotations with selectors an agent can act on. | glosa reviews file-backed Markdown, HTML and text, and routes notes through each agent's own push transport and MCP. It does not embed a feedback toolbar in the app under review. |

Plannotator is the closest neighbour and a strong place to start for plan, document or code review
today. glosa explores a narrower question: can a sensitive writing workspace stay local, durable and
honestly attributed across many files and agent sessions?

## Local by design

- glosa listens only on your Mac. `glosa open` pairs your browser tab with the local API at `http://glosa.localhost:4646`, and requests routed through other websites are rejected ([security model](docs/appendices/A3-security.md)). Browsers and macOS answer `.localhost` names locally without a DNS lookup. Set `GLOSA_OPEN_HOST=127.0.0.1` for `http://127.0.0.1:4646` links instead; the daemon accepts both.
- glosa has no telemetry, cloud sync, background checks, warm-ups, or unconfigured external calls.
  The page's fonts ship inside glosa, so opening a document fetches nothing from outside your Mac.
  Optional Wispr Flow dictation sends microphone audio and up to 256 KiB of visible plaintext only
  after versioned consent and a Dictate click; it inserts a draft and never submits it. Your agent may
  still send content to its own provider under that tool's terms.
- Versions live in a shadow repository glosa keeps for itself: in the workspace's `.glosa/` folder, or under `~/.glosa/state/` when it cannot sit beside your files (a single file opened on its own, a folder you cannot write to, or a folder opened with `glosa open --external-state`). glosa never modifies your real Git repository. History does not expire and single versions cannot be deleted; `glosa forget <slug>` deletes a workspace's whole history and leaves your files alone.
- Attribution is never guessed. A change is credited to a session only when an apply lease proves it. Everything else is yours or unknown, and a change glosa only finds on disk is reported as an outside edit, never as yours.

If a local bearer token may have leaked, run `glosa token revoke`, then `glosa open <directory>` to
create and pair a replacement. Use `glosa token rotate` to replace it immediately. Token commands never
print credential material.

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

glosa is a Bun and TypeScript monorepo with one daemon serving a small vanilla-JS single-page app. The
core knows nothing about specific agents or domains: agent knowledge lives in providers, and document
metadata comes in through a declarative adapter boundary. The append-only journal is the source of
truth for every note's lifecycle.

Start with [the requirements](docs/requirements.md) for the normative contract, [the roadmap](ROADMAP.md)
for accepted direction, [the decision log](docs/decisions.md) for the reasoning behind the design, and
[DESIGN.md](DESIGN.md) for the visual system.

## Development

Development uses the Bun version pinned in `package.json` (currently 1.4.2); the test runner refuses
older versions.

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
