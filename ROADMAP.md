# Glosa roadmap

Last reviewed: 2026-09-21

Glosa's maintainers own this roadmap. It describes accepted product direction, not a promise that
every item will ship. The public [Glosa Roadmap project](https://github.com/users/davebream/projects/5)
is the live source for execution status, and only work assigned to a GitHub milestone is a release
commitment. We intentionally do not publish speculative delivery dates.

Current work runs in phases. Each phase has a parent issue that lists its children, their order, and
the exit criteria that close it.

## Now

- **Opt-in Wispr Flow dictation.** A configured user can dictate into Glosa's four prose composers;
  audio and bounded visible plaintext leave the machine only after the user clicks Dictate. Dictation
  inserts a reviewable draft and never submits it. A paid attended live-provider smoke test is the
  support gate; CI and the core workflow stay offline.
- **Phase 3: several agents on one workspace.** Visible per-artifact and per-entry claims and a
  signals channel between sessions, in place of today's single apply lease (the lock one agent holds
  while it applies a change). Track: [#166](https://github.com/davebream/glosa/issues/166).

## Recently completed

- **Phase 2: onboarding without ceremony.** Claude Code installs glosa through a plugin and Codex
  through `codex mcp add`, both push feedback to an idle session, and `glosa init`, its hooks, the
  rewake hook and Claude Code Channels are gone. Shipped in alpha.22. Track:
  [#165](https://github.com/davebream/glosa/issues/165).
- **A readable local address.** `glosa open` links to `http://glosa.localhost:4646`, and
  `127.0.0.1` keeps working beside it, without adding a DNS rebinding risk. Shipped in alpha.22.
  Track: [#159](https://github.com/davebream/glosa/issues/159).
- **Phase 1: the loop is honest.** A change made in another editor is reported as an external edit,
  never as an edit you made in glosa; a workspace is never your home directory; `glosa mcp`
  processes exit when their host closes, hangs up, or goes away; a workspace can be forgotten.
  Shipped in alpha.18 through alpha.21. Track:
  [#164](https://github.com/davebream/glosa/issues/164).
- **Phase 0: the loop works again.** A daemon that stops responding recovers, sessions re-register
  on their next MCP tool call after a daemon restart, an Edit-mode save rewrites only the blocks you
  changed, and the inbox can be listed and cleared from the CLI. Shipped in alpha.18. Track:
  [#163](https://github.com/davebream/glosa/issues/163).
- **Review mode.** An agent can point at a passage, ask about it, and wait for the answer you give
  in the margin. Shipped in alpha.17.
- **Actionable agent feedback.** Bounded annotation context and human-edit hunks now reach Claude
  Code and Codex through their supported hook, gate, and MCP paths, with honest delivery accounting.
  Track: [#18](https://github.com/davebream/glosa/issues/18).
- **Token rotation and revocation.** Users can invalidate Glosa bearer credentials and re-pair
  clients safely. Track: [#20](https://github.com/davebream/glosa/issues/20).
- **Accessible long-form review.** The core workspace was audited and remediated against Glosa's
  WCAG 2.2 AA target. Track: [#21](https://github.com/davebream/glosa/issues/21).

## Next

- **Phase 4: editor and workbench.** Front matter and `%%` comments handled consistently, and the
  multi-artifact workbench reconciled with what shipped. Track:
  [#167](https://github.com/davebream/glosa/issues/167).
- **Finish the generic v1 compatibility gate.** The recorded [T8
  rehearsal](docs/compatibility/2026-07-22-t8-manual-rehearsal.md) passed the generic scenarios it
  exercised. The re-run needs Phases 0–2 in place, because the delivery path it certifies is the one
  Phase 2 builds, and it runs after Phase 4's reconciliation. Phase 3 is not a precondition. The
  expanded real-session conversation-delivery scenario and explicit maintainer sign-off remain
  pending. No external integration package or workflow logic enters Glosa. Track:
  [#19](https://github.com/davebream/glosa/issues/19).
- **Graduate the public alpha.** Close the undated [v1.0
  milestone](https://github.com/davebream/glosa/milestone/1) only after its release commitments pass
  their stated acceptance gates.
- **Phase 5: the desktop shell.** An Electron window on the same daemon-served SPA, for pointing glosa
  at a folder without a terminal; the browser mode stays. The unpackaged skeleton and its renderer
  security suite exist; packaging, signing and a release are the remaining work. Track:
  [#160](https://github.com/davebream/glosa/issues/160).
- **Respond to public-alpha evidence.** Prioritize reliability and review-workflow improvements from
  reproducible user reports rather than expanding the surface speculatively.

## Later

- Whether glosa should ever launch an agent session itself, which it deliberately does not do today
  ([#157](https://github.com/davebream/glosa/issues/157)).
- Support beyond macOS after the local-first security and lifecycle contracts are portable.
- Stable public extension contracts beyond workspace metadata v1 and the current provider interface.

Later items remain exploratory. Some have an issue that records their reasoning
([#168](https://github.com/davebream/glosa/issues/168)); none becomes scheduled work until
maintainers promote it.

## Not planned

- Hosted document processing, cloud sync, or a Glosa cloud service.
- Product telemetry.
- Remote or mobile workspace access.
- cmux coupling or terminal-keystroke injection. (Codex push over its app-server socket is the
  agent's own API, not injection — see "Codex `turn/steer` is the agent's own API" in
  [docs/decisions.md](docs/decisions.md).)
- Domain-specific behavior in the generic core.

The normative v1 technical contract remains in [docs/requirements.md](docs/requirements.md).
