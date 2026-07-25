# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.5...HEAD
[0.1.0-alpha.5]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.0
