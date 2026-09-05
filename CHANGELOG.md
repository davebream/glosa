# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An agent can point at a passage and ask about it, and wait for the answer. The question appears in
  the margin beside the words it concerns, with a mark on the passage; the human answers there and
  the agent's turn resumes. The new `glosa_ask` MCP tool blocks on a held request rather than a poll
  loop, so a turn resumes the moment the answer is sent. Omitting the question makes it a pointer,
  which returns immediately.
- An agent may offer answer options in its own vocabulary. glosa always adds a free-text field
  beside them, so offering options never stops a human answering something the agent did not
  anticipate.

### Changed

- The artifact modes are now **Read**, **Review** and **Edit**, named for what the human is doing
  rather than for who the counterparty is. Review is the anchored two-way margin: the reviewer's own
  comments and a session's questions about a passage, answered where the words are. The former names
  remain valid on the wire — `mode=preview`, `mode=annotate`, `lock=preview`, `--preview` and
  `glosa_present`'s enum all normalize to the new vocabulary.
- Leaving Edit with unsaved source no longer discards it. Drafts and half-written margin notes are
  kept across mode switches, including one an agent causes, and the Edit control shows that held
  work exists. Closing a pane still asks before discarding.
- The Attention tray sends the reader to the artifact a request concerns rather than offering a
  second place to answer it. A request with no artifact keeps its inline answer.

## [0.1.0-alpha.16] - 2026-09-05

The release makes an annotation something the workspace holds rather than something one browser tab
remembers, and makes the apply-lease behind it work at all outside a lab.

### Fixed

- An annotation now survives closing the tab. Reload the page, open the same manuscript in a second
  pane, or come back tomorrow, and the cards, the underline under each annotated passage, the
  gutter dots and the offer to undo an applied change are all still there. The entries were always
  durable — journal lines, still queued for the session — but the pane held them only in memory, so
  a reload showed an untouched document with work still pending on it.
- Undo appears on an applied annotation. It never did: the offer was looked up in the checkpoint
  list, and a lease taken against a clean worktree writes no checkpoint at all, so there was nothing
  to find. The rollback target now comes from `apply_end`, the one event that states it, and the
  fold carries it onto the entry so it outlives the tab that watched the lease close.
- `glosa apply-begin` and `glosa resolve` accept `--workspace`, so an agent working in one directory
  can act on a review of a document in another. They previously read the current working directory
  and nothing else, which made a lease impossible to take from anywhere but the workspace itself.
- A matched artifact the project gitignores no longer kills every checkpoint in the workspace. `git
  add` exits non-zero on an ignored pathspec unless forced, and the whole apply-lease mechanism is
  built on checkpoints, so one ignored file — a `tmp/` note, a generated report — silently stopped
  proven attribution for that workspace and surfaced only as "internal error".
- `glosa apply-begin` refuses an entry the workspace does not own, with a 404 naming the reason,
  instead of taking the one lease slot for the full TTL on a misrouted id. A lease proves "this
  session changed this workspace because of THIS entry", so a foreign id makes the proof
  meaningless.
- The tab strip no longer grows a vertical scrollbar. Its horizontal scrollbar lane was drawn inside
  the strip's own height, which made a full-height row of tabs too tall for its box and produced a
  second scrollbar beside a single row. It was also taking 11 of the strip's 36 pixels.

### Added

- `GET /w/:slug/annotations` (A1 §5.6a) lists a workspace's annotations, optionally scoped to one
  artifact, each with the payload it was written with, its status, its delivery-attempt count and
  the commit an undo would restore to. Notes withdrawn in glosa are not listed; the journal keeps
  them, but a removed card must not come back on the next page load.
- A withdrawal is recorded as `detail.withdrawn` on its transition. A human taking a note back and a
  session declining one both land on the terminal `rejected`, and only one of them should reappear
  on the page.
- The presentation an agent receives for an annotation now spells out the apply-lease protocol —
  take the lease before editing, resolve after — so a session that has never seen glosa before
  attributes its own work instead of leaving it `unknown`.

## [0.1.0-alpha.15] - 2026-09-05

### Fixed

- A glosa install no longer stops a daemon another install started. Daemons publish an `install_id`
  (a hash of their package root) in the lock and handshake, and a client that finds a divergent
  build refuses to signal it unless identity proves the daemon is its own. Two installs on one
  machine — typically a source checkout beside a published install — previously evicted each other
  on every command, producing a continuous spawn-and-kill storm on port 4646. An upgrade still
  replaces an older daemon, including one that predates the field.
- Running glosa from a source checkout no longer shares `~/.glosa` or port 4646 with a published
  install. A checkout derives `GLOSA_HOME=~/.glosa-dev/<install-id>` and a deterministic port in
  60000-65498; an explicit `GLOSA_HOME`, `GLOSA_PORT` or `--port` still wins, and the CLI reports
  the derived values once on an interactive terminal. **A checkout will no longer see workspaces
  registered in `~/.glosa`** — set `GLOSA_HOME=~/.glosa` to keep the previous behaviour.
- A browser tab no longer loses its pairing for good when a different glosa install takes the port.
  A 401 is now attributed before anything is discarded: if the daemon answering is not the one that
  issued the tab's credential, the tab keeps it, stops sending it, waits on the tokenless handshake,
  and resumes on its own once its daemon is back. A genuine revocation still clears the credential
  exactly as before. Previously any 401 wiped `sessionStorage` and reloaded, and since the pairing
  token had already been stripped from the URL there was no way back short of `glosa open`.
- `glosa init --scope user` now targets `$CLAUDE_CONFIG_DIR` when Claude Code's configuration has
  been relocated — which is what account switchers do to give each account its own root. It
  previously always wrote `~/.claude/settings.json`, a file the asking session never reads, and
  reported success.
- Conversation transcripts from a session under a non-default Claude config root are no longer
  refused. The daemon is a singleton and inherits one `CLAUDE_CONFIG_DIR` while serving sessions
  from all of them, so single-root confinement rejected those paths with a 400 and the conversation
  view was dead for them. Confinement now accepts any of the discovered roots, each realpath-confined
  exactly as before.
- "A process is bound to this port but is not answering the handshake" now names the PID and prints
  the `lsof` and `kill -TERM` commands that clear it, instead of leaving the user to find the
  process themselves.

### Added

- The daemon records rejected requests in `daemon.log` by reason (`no-token-on-daemon`,
  `bearer-mismatch`, `credential-rotated`), throttled to one line per reason per minute with a
  suppressed count. It records no request path and no credential, so a caller cannot use it to grow
  the log or inject a line. Without this, a report of a browser tab losing its pairing could not be
  diagnosed after the fact.
- `glosa doctor` reports every Claude Code config root it can find and which are not wired. An
  account switcher gives each account its own root, and user-scope wiring reaches only the active
  one; the check names the others instead of leaving the gap silent.

## [0.1.0-alpha.14] - 2026-09-05

### Fixed

- Annotating in a pane too narrow for the side rail works. The composer opens under the passage
  it is attached to and travels with it while you scroll, instead of being pinned inside the
  scroll container where it sat one screen above the visible area for anyone reading past the
  first screenful.
- Annotated passages carry their mark again. Since 0.1.0-alpha.12 each pane registered its
  highlights under a per-pane key that no stylesheet rule could match, so the passage underline,
  the hover wash and the composer's selection wash had all been invisible: a heavily annotated
  manuscript read as untouched. The keys are shared now, with each pane contributing and
  withdrawing only its own ranges.
- Saved annotations no longer flow off the end of the manuscript. They live in a collapsible tray
  on the pane, which states its count while collapsed.
- Gutter dots for several notes on one line no longer stack on top of each other, and each names
  its own note for assistive technology.
- Edit keeps the manuscript's measure. The editor column was derived from `68ch` resolved in the
  chrome's sans face rather than the manuscript's serif, so it came out 86px narrower than the
  text it was editing; switching modes now moves the first line by about a pixel.

### Added

- A session that applies an annotation is told how to prove it. Every delivered annotation now
  carries the apply-lease protocol — `glosa apply-begin` before editing, `glosa resolve` after —
  which is what attributes the change to that session and leaves a checkpoint to return to.
  Both commands already existed; nothing had ever told an agent to use them, so annotations
  stayed pending however faithfully they were acted on and every edit was attributed to nobody.
- An applied annotation can be undone. Resolved notes group under their own heading, and one an
  agent applied offers a rollback to the artifact as it read before that change, through the same
  dirty-worktree guard the history pane uses. Where no lease was taken there is no checkpoint to
  return to, and no offer is made.
- Annotations can be revised. Editing one reopens the composer on the same passage; because the
  journal is append-only, sending posts a new entry and then withdraws the original, and the
  composer says so before you send.
- Hovering an annotated passage shows what was written there, with the options to edit or remove
  it, without leaving the text.

## [0.1.0-alpha.13] - 2026-09-05

### Changed

- The workbench chrome is quieter and better proportioned. Tabs read as an index tab on the
  sheet: the active tab's paper runs into the manuscript, resting tabs are separated by a short
  hairline instead of a full-height wall, and every tab label clears AA contrast. The filled
  toolbar above each manuscript is gone; the directory, the mode control on its own segmented
  track, History and More sit on a transparent row at the manuscript's width. The navigator's
  first heading shares the tab strip's line, and a file open in a pane is marked by a dot in the
  disclosure slot instead of a bar that pushed its icon out of line.
- The rendered manuscript is set more like a typeset page: a larger title, more air above each
  section, subheads closed up under their section, semibold rather than bold emphasis, muted
  list markers, a short section rule, a hairline beside quotations, and tables ruled horizontally.
  Iowan Old Style is now named first in the serif stack so Safari and Chromium render the same
  face and the same measure.
- Radii and shadows are tokens; nested corners follow their container's radius, menus and trays
  share one lift, and the caret and any visible scrollbar take the palette.

## [0.1.0-alpha.12] - 2026-09-04

### Added

- Several artifacts can be open at once. Open them as tabs, drag a tab to a pane edge to read two
  side by side, and the arrangement comes back on the next visit. Each pane carries its own mode,
  its own annotations and its own version history, so one bar no longer speaks for two documents.
- A comparison between two saved versions opens as its own pane, so it can stay on screen beside
  the manuscript it describes.
- Every way of dragging a tab has a single-pointer equivalent in the pane's More menu, and a
  direction that would do nothing is shown as unavailable rather than silently doing nothing.
- New keys: Ctrl+Tab and Ctrl+Shift+Tab step through a pane's tabs, Command/Ctrl+Option+Left/Right
  move between panes, Command/Ctrl+\ moves the active tab into a new split, and Command/Ctrl+W
  closes it. The keyboard sheet lists all of them.

### Changed

- The navigator is a column at every width, replacing the drawer that alpha.11 kept under 1024px.
  A narrow window keeps the navigator and every pane at their own minimum width and clips, the way
  a desktop editor does, instead of covering the work with an overlay exactly when you are moving
  between two documents. A single presented document still has no navigator at all.
- Entering Annotate no longer shifts the manuscript sideways. The annotation rail is placed in
  whitespace the manuscript was never using, measured from the pane rather than the window, or it
  is not placed at all.
- Annotating in a split pane works. The rail needs about 1200px and an even split never has that
  on any ordinary display, so entering Annotate borrows width from the pane beside it and gives it
  back on the way out.
- Underlines and gutter marks on annotated passages survive every mode. Leaving Annotate used to
  erase them, so a heavily reviewed document read as untouched in Preview.
- Editing markdown source takes the width of the pane up to a 100-character measure. Tables,
  fenced code and long URLs were being wrapped at the 68-character measure meant for prose.
- The artifact bar sits above the manuscript at the manuscript's own width, and names only the
  directory the tab has no room for. The filename is on the tab; it is not repeated underneath.

## [0.1.0-alpha.11] - 2026-09-04

### Changed

- The navigator is a column beside the manuscript at 1024px and wider instead of an overlay that
  every artifact you opened dismissed. The top-bar control shows and hides it in every mode, and
  that choice is remembered per browser. Under 1024px it stays the drawer it was.
- The workspace switcher is a disclosure that collapses out of the artifact tree's way, and
  remembers whether it was left open.

### Fixed

- A live daemon now repairs a deleted ownership lock without waiting for a handshake, while clients
  use stable port observations and one overall deadline before reclaiming or spawning. Hook-side
  discovery yields quietly inside its host timeout instead of creating repeated EADDRINUSE
  contenders or delaying unrelated prompts.

## [0.1.0-alpha.10] - 2026-09-03

### Fixed

- The browser workspace now serves every module in the SPA import graph, fixing the blank page
  introduced by the alpha.9 viewer decomposition.

## [0.1.0-alpha.9] - 2026-09-03

### Added

- `glosa doctor` now reports journal byte and physical-line growth so operators can distinguish
  ordinary queue depth from a journal that needs attention.

### Changed

- The daemon now separates application routes and services from transport, security, and process
  lifecycle modules; the SPA viewer lifecycle is likewise split into transport-free components.
- The deterministic T8 gate names its acceptance set explicitly and exercises browser security,
  provider delivery, and daemon lifecycle behavior across real process boundaries.

### Fixed

- Expired apply leases, stale shadow indexes, and approval replay can no longer assign unproven
  session provenance or lose the durable approval identity recorded in the journal.
- Workspace registration, adoption, fallback leases, lock reclamation, journal tails, and approval
  uniqueness now fail closed under ambiguous or concurrent state instead of risking lost updates.
- Provider setup remains generic, transcript selection rejects ambiguity, descendant workspaces
  drain correctly, and the SPA offers honest recovery when more than one session could be selected.
- CLI uninstall preserves foreign configuration and indentation, request-review failures retain
  their real category, and durable-install recovery guidance is restored.
- Daemon startup fails promptly when its spawned child exits before handshake, while interrupted
  test runners reliably reap their isolated daemon children.

### Security

- Every CLI-spawned child environment scrubs `ANTHROPIC_API_KEY`, browser token storage is covered
  by the real-engine security gate, and stale git locks are removed only with proven ownership.

## [0.1.0-alpha.8] - 2026-08-10

### Fixed

- Explicitly opening a regular non-symlink artifact now succeeds even when an already-registered
  parent workspace excludes it: glosa creates or reuses a bounded loose-file registration while
  leaving the parent's tracked list unchanged. Repeated paths and hardlink aliases retain one
  history, and strict directory-focus and symlink behavior are unchanged.
- A current daemon now recreates its own lock if that coordination file disappears after startup,
  allowing hooks and CLI commands to recover silently after verifying the repaired lock/handshake
  pair. Corrupt or mismatched locks remain fail-closed, and older lockless daemons receive exact
  manual recovery guidance without being signalled automatically.

## [0.1.0-alpha.7] - 2026-08-07

### Added

- The SPA now has one compact, accessible Agent feedback control that reports explicit session
  connection as connected, stale, or unbound while retaining queued-entry and feedback-off state.
  Stale and unbound workspaces expose provider-owned, copyable reconnect prompts with a generic CLI
  fallback; clipboard denial selects the prompt for manual copying.
- Providers now supply current-session reconnect guidance through `connectPrompt`, and
  `GET /api/status` exposes those additive prompts without changing binding persistence. The HTTP
  contract is now 1.5 with same-major N-1 tolerance.
- Real HTTP integration coverage proves `glosa open --bind <own-session-id>` registers and binds a
  live session in one operation while preserving the existing nonfatal unknown-session behavior.

### Changed

- Agent feedback status refreshes on workspace selection, existing workspace-stream activity and
  reconnect, window focus, and the 15-second poll. A failed status fetch clears any prior connected
  claim rather than leaving stale green UI.
- `glosa open` resolves an unowned file inside a git repository to the repo root as a directory
  workspace instead of registering a loose file over the file's containing directory, so `open`,
  `doctor`, and `init` now agree on one workspace root; `open`'s wiring probe reads the same
  scoped manifest `doctor` does, so a correctly-wired workspace no longer reports
  `not-initialized`; and a `loose-file` registration's un-wired hint no longer suggests running
  `glosa init` on its (possibly temp-directory or multi-repo-parent) worktree. `glosa init`/`glosa
  doctor` resolve a bare cwd invocation to the enclosing git repository, and `glosa init` refuses
  to write configuration into a temp directory or a bare multi-repo parent unless `--force` or an
  interactive confirmation. `glosa init --print` now shows a real hunk-level diff instead of
  rendering every change as a whole-file replacement, and reports "already up to date" rather than
  printing nothing when there is nothing to change. (#96)

## [0.1.0-alpha.6] - 2026-07-27

### Added

- The workbench top bar now shows an ambient wiring badge: `Live → session` when annotations
  will be delivered, `Wired — no session bound` when the integration is installed but no session
  is listening (restart/resume needed), and `Off — annotations stay local` when `glosa init`
  never ran — with a queued-entry count when work is waiting. The badge stays hidden until the
  state is actually observed and never claims a connection it hasn't seen.
- The first annotation in an un-wired workspace offers to set up agent feedback in place: one
  explicit click runs `glosa init` through the daemon and a follow-up notice states the remaining
  restart/resume step. Declining — or the setup failing — never blocks the annotation: it is
  saved locally either way, and the fallback notice shows the terminal command.

- Per-workspace wiring status API (`GET /w/:slug/wiring`): a three-state signal — `live`
  (delivery would reach a session), `wired` (init installed, restart/resume needed), `unwired`
  (init never ran) — plus pending-entry count, with the same value surfaced on `GET /api/status`.
- Consent-gated init trigger (`POST /w/:slug/init`): on an explicit client request the daemon
  runs `glosa init` for a registered directory workspace (CSRF-protected state-changing route;
  scrubbed child env, 30s timeout, single-flighted per workspace) and reports whether a session
  restart is still required. API contract bumped to 1.4 (additive).

### Fixed

- `glosa open` now resolves relative targets against the invoking client's working directory
  before contacting the daemon, preventing an existing daemon from silently registering the same
  relative path beneath its own unrelated working directory.
- Artifact watching now uses one bounded, shared watcher per workspace instead of one recursive
  workspace-root watcher per SSE connection. Canonical pruning keeps `node_modules`, `.git`,
  dot-worktrees, symlinks, and unrelated files out of the watch set; oversized workspaces degrade
  safely instead of driving the singleton daemon into an error, memory-growth, and respawn loop.
- Workspace garbage collection can no longer remove a registration whose bus still holds pending
  (undelivered) entries — parked annotations now block removal indefinitely, and an unreadable
  journal counts as pending rather than removable. `glosa forget` remains an explicit override.

- `GET /api/status` reports `orphaned_state`: home-state buses (`~/.glosa/state/<id>`) holding
  pending entries with no live registration. `glosa doctor` gained matching `pending-delivery`
  and `orphaned-state` checks that warn when annotations are queued without delivery wiring or
  stranded in an orphaned state dir, with the recovery hint (re-open the original path — the
  deterministic registration id reclaims the surviving bus).

### Added

- `glosa open` now tells you when a workspace is not wired for agent feedback: an un-init'd
  workspace gets a `not-initialized` warning (drifted config gets `init-drifted`) naming the exact
  fix and the session-restart step, and on a TTY `open` offers to run `glosa init` after a single
  explicit yes (`--init` runs it without asking, `--no-init` silences the offer). Exit codes and
  the init-free SPA-only contract are unchanged.
- `glosa doctor` gained an `mcp-enabled` check that catches the enabled-but-undefined trap: a
  `.claude/settings*.json` layer force-enabling an MCP server named `glosa` that `.mcp.json` never
  defines.

### Changed

- `glosa init` success output now states the remaining step explicitly: restart or `/resume` the
  Claude Code session so it loads glosa — until then annotations are queued, not delivered.

## [0.1.0-alpha.5] - 2026-07-25

### Changed

- Collapsed the wide top bar so secondary actions (Attention, History, Conversation, Copy source,
  Print / Save as PDF, Appearance, Keyboard shortcuts) live behind the More menu at every width,
  matching the Preview Boundary Rule in `DESIGN.md`.

## [0.1.0-alpha.4] - 2026-07-25

### Added

- `glosa update` upgrades an existing installation in place. It resolves and verifies the release
  independently of local npm or bun registry configuration, so a private scope mapping no longer
  breaks the upgrade path. `glosa update --check` reports what would change without installing.

### Fixed

- Corrected the install command in the README and in `glosa init`'s durable-install hint. Both
  recommended a `--registry` flag that a scope-level `.npmrc` mapping silently overrides, so the
  documented workaround failed in exactly the situation it claimed to fix.
- Detected package-runner caches under a custom `BUN_INSTALL` root, which were previously mistaken
  for durable installs.
- Pinned the transitive `brace-expansion` dependency to clear the OSV release-security advisory.

## [0.1.0-alpha.3] - 2026-07-24

### Fixed

- Prevented daemon startup failures and repeated contender spawns when a genuine daemon answers the configured port but its lock file is missing or malformed.
- Retried daemon discovery when another client replaces the daemon between lock inspection and handshake, avoiding false ownership-mismatch failures.
- Updated the locked `tar` dependency to resolve the release security advisory.

## [0.1.0-alpha.2] - 2026-07-24

### Added

- Durable loose-file-to-directory workspace adoption with preserved historical lineages.
- Read-only presentation surfaces, including source copy, print, and session-independent preview actions.
- Revision-bound artifact approval and canonical URL focus for review workflows.

### Changed

- Made Preview a reading-only canvas and improved responsive workspace review behavior.
- Consolidated provider naming and legacy integration traces around the generic provider boundary.

### Fixed

- Completed open-surface lifecycle handling and annotation-flow reliability.

## [0.1.0-alpha.1] - 2026-07-23

### Added

- Public, maintainer-owned roadmap backed by a live GitHub Project and release milestone.
- Durable `WorkspaceMetadataDescriptor` v1 registration through HTTP, CLI, and MCP.
- Explicit CLI/MCP session binding and an action-aware attention badge/tray with structured results.
- Local bearer-token rotation and revocation with immediate invalidation in the running daemon,
  stale-tab unpairing, and a documented `glosa open` re-pairing path. Token commands never print
  credential material.

### Changed

- Archived the completed autonomous v1 build records and documented AI-assisted contribution
  disclosure and ownership requirements.
- Bumped the additive HTTP contract to v1.1 and made Claude Channels explicitly optional when the
  audited hook/MCP fallback succeeds.
- Replaced live domain-specific integration guidance with the declarative public boundary.
- Migrated `glosa mcp` to the official TypeScript MCP SDK with strict Zod schemas and
  SDK-native protocol negotiation, validation, and error framing.

## [0.1.0-alpha.0] - 2026-07-21

### Added

- Experimental macOS CLI for opening the local writing and review workspace.
- Local daemon, browser workspace, and Claude Code and Codex provider integrations.
- Public release documentation, security policy, and automated release gates.

### Security

- Loopback-only daemon access with capability tokens and confined workspace paths.

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.16...HEAD
[0.1.0-alpha.16]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.15...v0.1.0-alpha.16
[0.1.0-alpha.15]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.14...v0.1.0-alpha.15
[0.1.0-alpha.14]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.13...v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.12...v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.11...v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.10...v0.1.0-alpha.11
[0.1.0-alpha.10]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.9...v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.8...v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.0
