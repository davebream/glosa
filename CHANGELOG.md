# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.6] - 2026-07-26

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

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.6...HEAD
[0.1.0-alpha.6]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.0
