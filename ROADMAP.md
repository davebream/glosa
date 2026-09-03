# Glosa roadmap

Last reviewed: 2026-09-03

Glosa's maintainers own this roadmap. It describes accepted product direction, not a promise that
every item will ship. The public [Glosa Roadmap project](https://github.com/users/davebream/projects/5)
is the live source for execution status, and only work assigned to a GitHub milestone is a release
commitment. We intentionally do not publish speculative delivery dates.

## Now

- **Finish the generic v1 compatibility gate.** The recorded
  [T8 rehearsal](docs/compatibility/2026-07-22-t8-manual-rehearsal.md) passed the generic scenarios
  it exercised. The expanded real-session conversation-delivery scenario and explicit maintainer
  sign-off remain pending. No external integration package or workflow logic enters Glosa. Track:
  [#19](https://github.com/davebream/glosa/issues/19).
- **Graduate the public alpha.** Close the undated
  [v1.0 milestone](https://github.com/davebream/glosa/milestone/1) only after its release commitments
  pass their stated acceptance gates.

## Recently completed

- **Actionable agent feedback.** Bounded annotation context and human-edit hunks now reach Claude
  Code and Codex through their supported hook, gate, and MCP paths, with honest delivery accounting.
  Track: [#18](https://github.com/davebream/glosa/issues/18).
- **Token rotation and revocation.** Users can invalidate Glosa bearer credentials and re-pair
  clients safely. Track: [#20](https://github.com/davebream/glosa/issues/20).
- **Accessible long-form review.** The core workspace was audited and remediated against Glosa's
  WCAG 2.2 AA target. Track: [#21](https://github.com/davebream/glosa/issues/21).

## Next

- **Respond to public-alpha evidence.** Prioritize reliability and review-workflow improvements from
  reproducible user reports rather than expanding the surface speculatively.

## Later

- A standalone desktop shell that preserves the local daemon and browser architecture.
- Support beyond macOS after the local-first security and lifecycle contracts are portable.
- Dictation capture when a clear workflow remains after evaluating provider-native voice support.
- Stable public extension contracts beyond workspace metadata v1 and the current provider interface.

Later items remain exploratory. They receive tracking issues only when maintainers promote them into
concrete work.

## Not planned

- Hosted document processing, cloud sync, or a Glosa cloud service.
- Product telemetry.
- Remote or mobile workspace access.
- cmux coupling or terminal-keystroke injection.
- Domain-specific behavior in the generic core.

The normative v1 technical contract remains in [docs/requirements.md](docs/requirements.md).
