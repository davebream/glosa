# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.10...HEAD
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
