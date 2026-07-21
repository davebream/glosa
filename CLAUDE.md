# glosa

A local-first, writing-first workspace for people working with AI coding agents. An agent drafts
documents; the human reads them rendered, annotates in the margins, and edits; glosa routes those
annotations and edits back to the right agent session with honest provenance. **Companion topology**:
the agent runs as a normal interactive session in the user's terminal; glosa is a singleton daemon
beside it serving a browser SPA. Claude Code is the deep, required integration; the design is
agent-agnostic (Codex and other hook/MCP-capable CLIs supported through one provider interface).

Status: **experimental public alpha.** The implementation and deterministic acceptance suites exist,
but the manual T8 rehearsal against a copy of a real past sermon and the subsequent token-revocation
check remain incomplete. This is not yet approved for a live sermon week.

## Read this before writing any code

- **`docs/requirements.md`** — the authoritative build input (v2). Start here. It states every
  requirement (R1–R9), the fixed stack, task decomposition (T0–T8), and the release gate.
- **`docs/appendices/A1–A6`** — the **normative** deep contracts. When implementing a subsystem, the
  matching appendix is the spec: A1 api/transport, A2 claude-code integration, A3 security,
  A4 file-bus concurrency, A5 daemon architecture, A6 cli/platform. **Precedence: where `requirements.md`
  and an appendix disagree, `requirements.md` governs.**
- **`docs/decisions.md`** — the decision log (why things are the way they are; read when a requirement
  seems arbitrary). **`docs/options.md`** — the product rationale. **`docs/research/`** — the research
  the design rests on (the adversarial review, JSONL-UI components, electron-vs-tauri). **`docs/archive/`**
  — the superseded v1 (do not build from it).

## Non-negotiable invariants (violating any is a review-blocker)

1. **Generic core, domain in adapters.** The core knows nothing about sermons, jethro, or any pipeline.
   Agent-specific knowledge lives in **providers** (`packages/providers/*`); domain knowledge lives in
   **content adapters** (`packages/adapters/*`). The core runs with zero adapters.
2. **The journal is the single source of truth.** Inbox entries are immutable; status is derived by
   replaying the journal. No cross-file "atomic" writes exist (A4).
3. **Honest provenance.** Attribute a change to a session only when a `apply-begin`→`resolve` lease
   proves it; edits made in glosa's editor are `human` by construction; everything else is `unknown`,
   never falsely `human` (A4 §F05).
4. **No cmux.** glosa is fully decoupled from cmux — not a dependency, not a delivery mechanism, not the
   UI host. The SPA runs in any browser over `http://127.0.0.1`. Delivery uses each agent's own
   hooks/MCP (channels for Claude; blocking gate + turn-boundary + MCP-pull cross-agent) (R4).
5. **Local-first, zero telemetry, zero external runtime calls.** Manuscripts may hold special-category
   personal data; class-F network egress is CSP-blocked (A3). Scrub `ANTHROPIC_API_KEY` from every
   spawned child env.
6. **The SPA reaches the daemon through ONE data-access module** (so a future hosted shell is a deploy,
   not a refactor) (R6).

## Stack (fixed)

- **Bun + TypeScript** end to end; one daemon process serves the SPA + API. **No build step** (`bun run`
  direct; no bundle/transpile, no native/compiled addons). **No heavy frontend framework** — server-
  rendered HTML + small vanilla ES modules. markdown-it (+ `data-line` stamping), idiomorph, diff2html,
  picomatch, chokidar v4, system `git` (shadow repo), a vendored transcript-event normalizer.
- **macOS-only v1** (pinned floors in A6 §F30). Monorepo:
  `packages/{daemon, spa, providers/claude-code, providers/codex, adapters/jethro, cli}`.

## Build approach

Implementation follows `docs/requirements.md`. Tasks T0–T8 have A-level detail in the appendices.
**T8 is the release gate**: the deterministic acceptance suites (fault,
concurrency, security, anchor, transcript, actual-jethro-topology) must pass AND a manual rehearsal
against a copy of a real past sermon must pass. **"Green CI" is not the acceptance bar** — the
fault-injection/security/concurrency suites are, because a model's self-written happy-path tests will
not catch the hard invariants. When in doubt about a subsystem's contract, the appendix is authoritative;
do not invent.

## Naming

`glosa` — a *glosa* is a marginal commentary on an authoritative text; the product's core act. Never
shorten to "gloss" in user-facing copy.
