# glosa v1 — requirements (v2, build-ready)

> **Status:** This is the normative v1 technical contract, not the live product roadmap or work queue.
> See [`ROADMAP.md`](../ROADMAP.md) for accepted direction and its linked GitHub Project for current
> execution status.

**This is the authoritative build input for glosa v1.** It supersedes the original v1 contract in
full. v1 + the adversarial review
(`research/codex-review.md`, verdict NEEDS-REWORK, 32 findings) + a six-specialist resolution pass
produced this document; where v1 and v2 disagree, **v2 governs**. Deep contracts live in the six
normative appendices under `appendices/` (A1–A6); this document states requirements and references the
appendix that specifies each. **Precedence: where
this v2 body and an appendix disagree, v2 governs** — in particular, cmux appears nowhere in the delivery or
UI model; any lingering cmux mention in an appendix is stale and superseded by R4's cmux-free model.

**Product**: glosa — a local-first, writing-first workspace for people working with AI coding agents.
An agent drafts documents; the human reads them rendered, annotates in the margins, and edits; glosa
routes annotations and edits back to the right agent session with honest provenance. **Companion
topology**: the agent runs as a normal interactive session in the user's terminal; glosa is a singleton
daemon beside it serving a browser SPA. Claude Code is the deep, required integration; the design is
agent-agnostic (Codex and other hook/MCP-capable CLIs supported through one provider interface).

**Repository**: `davebream/glosa`. GitHub issues are the executable work queue; this document is the
normative product contract.

## 0. What changed from v1 (orientation for anyone who read v1)
- **No cmux coupling** anywhere. SPA runs in any browser over localhost; delivery uses each agent's own hooks/MCP, not keystroke injection.
- **In-app editor is IN scope** (Preview / Annotate / Edit modes). v1's "no editing" non-goal is removed.
- **Explicit session binding** is authoritative; terminal cwd is only a generic fallback (F01).
- **Declarative workspace metadata** replaces embedded producer/domain adapters. An external
  integration describes artifacts through the public CLI or MCP contract; glosa owns no integration
  package or workflow logic.
- **Multi-agent**: Claude Code deep + Codex built to the same provider interface; provider interface is a first-class deliverable.
- **History = full** (compare + restore). **Platform = macOS-only, pinned versions.**
- Durability, auth, daemon lifecycle, anchoring, security, CLI all hardened per appendices A1–A6.

## 1. Goal & release gate
**Goal**: eliminate four failure modes of agent-assisted writing — (A) unreadable terminal rendering
of long-form dialogue, (B) no artifact preview/annotation beside the agent, (C) manual edits invisible
to the agent, (D) annotation of rendered output requiring copy-paste.

**Hard release gate**: the deterministic acceptance suites pass, AND a maintainer-reviewed manual
rehearsal (T8) against an ignored copy of real past artifacts passes. The maintainer selects the
private input and signs the sanitized report; an agent never signs on the maintainer's behalf.

**Non-goals (v1)**: desktop shell (Electron/Tauri — v1 is daemon + browser); dictation capture;
mobile/remote access; cloud sync; a second-agent provider *beyond* Claude Code + Codex; a public
plugin/SDK surface; telemetry; cross-platform (macOS-only); instant-wake of a non-Claude *idle* agent
(honest limit — see R4).

## 2. Architecture (fixed)
```
 user's terminal: interactive `claude` (or `codex`) session(s)      browser (any: Safari-dock / tab / later Electron)
   hooks → register/drain · receive channel push · run `glosa            glosa SPA (served by daemon over http://127.0.0.1)
   resolve`/`apply-begin` via Bash · MCP shim (`glosa mcp`)               Preview/Annotate/Edit · 4 viewers · workspace switcher
                    │ hooks, MCP(stdio), CLI                                        │ fetch + streaming-SSE, Bearer (SPA origin)
             ┌──────▼──────────────────────────────────────────────────────────────▼──────┐
             │ glosa daemon — singleton per machine, TWO fixed ports (4646 SPA/API, 4647    │
             │ class-F content). file bus: per-workspace inbox + journal(=truth) + shadow-  │
             │ git · picomatch matcher · session registry · global workspace index ·        │
             │ provider-based delivery · auth (Host+Origin allowlist + Bearer + capabilities)│
             └──────────────────────────────────────────────────────────────────────────────┘
```
Fixed stack: **Bun + TypeScript**; one process serves SPA + API; **no heavy frontend framework**
(server-rendered HTML + small vanilla ES modules); **markdown-it** (+ `data-line` stamping),
**idiomorph** (live morph), **diff2html** (diff pane), **picomatch** (the one matcher), **chokidar v4**
(directory watch), system **git** (shadow repo), a vendored **transcript-event normalizer** (do NOT
parse raw transcript JSONL directly — A2). Monorepo: `packages/{daemon, spa, providers/claude-code,
providers/codex, cli}`. Three invariant boundaries (review-blockers if violated):
(1) daemon API is versioned + client-agnostic; (2) agent providers and content adapters only enter
via their interfaces — no special-casing; (3) the SPA talks to the daemon only through the public
authenticated API. **Adapters/providers carry ALL domain- and agent-specific knowledge; the core is
generic.**

## 3. Functional requirements

### R1 — singleton daemon, ports, workspace model  (detail: A5 §F13, A4, A6 §F30)
- One daemon/machine; lock `~/.glosa/daemon.lock` carries
  `{instance_id,pid,port,protocol_version,build_id,…}`. `build_id` is the root package semver plus a
  content hash of all runtime source; legacy locks/handshakes may omit it only during migration.
  A verified older or same-semver-different daemon is automatically replaced; a newer compatible
  daemon is reused, while an incompatible newer daemon fails closed and is never signalled;
  **`lock.port` is the authoritative port** (env `GLOSA_PORT` default 4646 only seeds a fresh spawn;
  class-F port = `GLOSA_PORT+1` = 4647). No entry point *becomes* the daemon in-process: a client with
  no live daemon **spawns a detached `glosa __daemon`** (unref + ignores SIGHUP/SIGINT) and acts as a
  client; the MCP shim (`glosa mcp`) only proxies, never binds/locks. Readiness = passing
  `/api/handshake`. Lock and handshake identity/PID/instance must agree before any signal is sent.
  Replacement waits up to five seconds for that lock ownership to change, then re-enters the normal
  `bind → O_EXCL lock create` CAS loop so simultaneous refreshes converge on one daemon.
- **Workspace registration** separates an immutable registration ID, kind (`directory` or
  `loose-file`), canonical identity path, work-tree, absolute bus path, and tracked-file policy.
  Sources: session registration, `glosa open <path>`, first-touch `.glosa/`. The daemon-only,
  atomically written global index `~/.glosa/workspaces.json` is authoritative. Identity paths use
  realpath→NFC→strip-slash; slugs remain display/routing labels with deterministic
  collision-lengthening (A4 §F25). Loose files and redirected directories store state beneath
  `~/.glosa/state/<full-sha256-registration-id>/` while retaining their original work-tree.
- **Tracked-artifact rule** produces one normalized file LIST feeding watcher + sidebar + git
  pathspec identically. Directory registrations use the recursive picomatch policy: include
  `**/*.md,**/*.html,**/*.txt`; exclude dot-dirs, `node_modules`, files > 2 MiB; symlinks never
  followed/matched; NFC + case-sensitive. Loose-file registrations use a bounded relative-path
  list containing exactly the requested existing regular non-symlink file and intentionally bypass
  matcher extension, exclusion, and size rules. Per-workspace overrides resolve from
  `<bus-path>/config.json` (A4 §F20).
- Git-agnostic provenance: shadow repo
  `GIT_DIR=<bus-path>/shadow.git --work-tree=<work-tree>`, argv-safe, one git mutex/registration,
  deterministic init + baseline, index-lock recovery (A4 §F21). UI speaks versions/timeline/restore
  — never commits/SHAs.
- **Loose-to-directory adoption is seal-and-link, never a physical migration.** Opening a parent
  directory seals each contained loose-file bus, retains its journal/inbox and shadow repo beneath
  `~/.glosa` as historical truth, imports its Git head under a target lineage ref, and carries only
  non-terminal entries as explicitly provenance-marked target aliases. The new directory bus is
  the sole live writer. A target with pre-existing state or a live source apply lease fails closed;
  the implementation never recursively moves or deletes source state (A4/A5).

### R2 — session registry & routing  (detail: A2 §F08, A5 §F19)
- Providers register live agent sessions via hooks → daemon API (never direct file writes; serialized
  by the daemon → no lost entries). Record: `{session_id, provider, workspace_binding, cwd,
  transcript_path, source, last_active_at, lease_expiry}`. Liveness = **lease + activity heartbeat**
  (NOT `kill(pid,0)` — hook input has no documented PID).
- **Routing precedence**: (1) an **explicit session binding** supplied through the API, CLI, or MCP
  contract (authoritative); (2) the generic cwd-ancestor fallback. This supports artifact workspaces
  that differ from the agent process cwd without teaching glosa about an external workflow. Two sessions bound to one
  workspace → deliver to the `session_hint`; else a one-time SPA picker (never guess). No live session →
  the entry **parks**; next session registration for that workspace drains it.

### R3 — file bus: inbox, journal (=truth), provenance  (detail: A4 §F04/§F05, A5 §F23)
- **The journal is the single source of truth.** Inbox entries are **immutable** (write-once, temp→
  fsync→rename); current status is derived by **replaying the journal** (idempotent fold; ULID
  `event_id` + `idem` keys). `glosa resolve` appends **one** journal line — no cross-file atomic write
  exists (this is the F04 fix). Startup reconciliation: torn-tail truncate → replay → inbox self-heal →
  apply-lease reconcile → offline-edit catch-up. Corrupt interior line → quarantine, never fatal.
- Journal, inbox, quarantine, declarative metadata/config, reconciliation state, checkpoints, and
  shadow Git resolve through the registration's absolute bus path. Redirection changes storage
  location only; journal replay and apply-lease evidence retain unchanged authority.
- Entry kinds: `human_edit`, `annotation`, `attention_request`, `conversation_message`. Envelope + payloads exactly per A4/A5
  (`human_edit` = inline hunk diffs referenced by shadow-git sha, never full bodies; `annotation` =
  W3C quote+prefix/suffix+position + `intent` + `target.chunk_id?`). Annotation `intent` enum =
  `content` (change the words → source edit) | `classification` (wrong type/split/label → pipeline
  feedback) | `style` (rendering/notation → renderer/CSS). The resolver (R6) uses `intent` only to
  frame/route feedback once anchoring has decided source-vs-pipeline; it never overrides anchoring.
- Actionable delivery is built from the immutable entry at presentation time. Annotation presentation
  includes its workspace-relative artifact path, comment body, intent, durable quote/position context,
  and the current F10/F11 anchoring resolution. Human-edit presentation includes before/after
  shadow-git checkpoints and bounded unified hunks; it never includes a full artifact body.
- **Lifecycle** is a state machine with delivery kept as a *separate axis* (A5 §F23): `delivery_attempt`
  events never change status; re-nudging a `delivered` entry emits attempts, not transitions. Full
  transition table + single writer per event in A5.
- **Provenance / attribution (honest)**: agent edits are bracketed by an explicit **apply-lease**
  (`glosa apply-begin` → pre-checkpoint; `glosa resolve` → post-checkpoint; the proven `pre..post` diff
  → `session:<id>`). Edits made in glosa's own editor → `human` by construction. **Every other
  watcher-observed write → `unknown`, never falsely `human`.** Attribution rides in git commit trailers
  (A4 §F05/§F21).

### R4 — delivery: provider-based, cmux-free  (detail: A2 §F06/§F07/§F16)
Delivery is per-agent-provider, selecting the best injection point that provider offers. Durable inbox
is always the truth; a transport failure only changes *which* mechanism delivers next, never whether
the entry survives.

| Capability | Claude Code provider | Codex / other hook-capable provider | Generic MCP host |
|---|---|---|---|
| Async push into idle | **channels** (MCP `notifications/claude/channel`; `--dangerously-load-development-channels server:glosa`; wakes idle) | — (honest limit: delivered at next turn/gate) | — |
| Blocking review gate (sync) | hook gate | **their hook gate** (Codex Stop-hook etc.) | — |
| Turn-boundary drain (async) | Stop / UserPromptSubmit hooks | their turn hooks | — |
| Pull on demand | MCP tool | MCP tool | **MCP tool** |
- Claude channels: correct activation flag + `glosa doctor` verifies *actual* registration, not config
  presence (A2 §F06). **asyncRewake is one-shot → rearmed by the Stop hook via a per-session lease** to
  prevent duplicate watchers (A2 §F07). Stop drains are bounded (≤8) and treated as drains, not loops.
- Channels are treated as **optional compatibility, not a required gate**: all delivery tests pass with
  channels disabled (the fallback rungs deliver). "Channel smoke test" and "required fallback test" are
  separate gates.
- Channel writes prove only `transport_accepted`. A targeted conversation message becomes terminal
  `delivered` only after the exact session acknowledges `presented`; until then it remains eligible
  for hook/MCP fallback. MCP pull identifies the registered target session explicitly.
- **No cmux.** The universal cross-agent path is the structured blocking gate (Plannotator-proven on
  Claude/Codex/Gemini/Copilot) + turn-boundary drain + MCP-pull.
- Every injected presentation is UTF-8 bounded: at most 16 KiB per entry and 32 KiB per batch, with
  at most eight entries in journal creation order. Truncation happens only at field or complete-hunk
  boundaries and always carries omitted counts plus `glosa inbox get <id> --cursor <cursor>` and MCP
  `glosa_inbox_get` retrieval instructions. Preparing content reserves it briefly; only a successful
  hook/channel/MCP write may acknowledge it as `presented`. Failed or expired reservations remain
  eligible, and later attempts append `reason:re_nudge` without mutating the inbox payload.

### R5 — HTTP API + auth  (detail: A1 full, A3 §4)
- Two fixed loopback listeners (SPA/API 4646; class-F content 4647) — one daemon, two origins.
- **Auth**: `Host` must literally equal `127.0.0.1:<port>` on every request (no DNS → anti-rebinding);
  Bearer token (128-bit, `~/.glosa/token` 0600) on API requests via `Authorization` header; **SSE uses
  `fetch()`-streaming (NOT native EventSource) so the header rides normally**; the class-F iframe loads
  via a **one-time 256-bit capability URL** on port 4647 (no ambient token there). Origin allowlist is
  route-class-scoped (strict on state-changing, foreign-only-reject on reads/handshake, inapplicable to
  navigation) — the resolved table is A3 §4. No cookies (CSRF structurally dead).
- **Token lifecycle**: `glosa token rotate` atomically replaces the credential with a fresh 128-bit
  mode-0600 token; `glosa token revoke` removes the credential. The running daemon observes either
  transition without restart, aborts credential-bound streams, invalidates every class-F capability,
  and accepts only the current token with no grace period. Stale SPA requests receive 401, clear their
  tab-scoped credential, and return to the unpaired screen; `glosa open` is the documented re-pairing
  path. Mutation failures preserve the prior credential state. Token commands never print token material.
- Versioned route catalog (contract v1.2: `/api/handshake` plus workspace routes including metadata,
  explicit session binding, artifact list/content,
  streaming SSE with journal-offset cursor + reconnect replay, annotations, diff, checkpoints/restore
  (full history), transcript stream, inbox/attention, presentation-token mint/redeem) — schemas, status codes, 1 MiB body cap,
  `X-Contract-Version` (major mismatch → 409 + reload; minor tolerated) in A1. All paths pass the single
  `confinePath()` realpath guard (A3 §3).

### R6 — SPA: three modes, four viewers  (detail: A3 §1-2, A5 §F10/§F11, A1)
- **v1 invariant — swappable data layer**: the SPA reaches the daemon through ONE data-access module
  (same-origin fetch today). This is a v1 build constraint, not future scope: it is what makes a future
  hosted-shell/Electron topology a config change rather than a refactor (the L0→L3 distribution ladder).
  No SPA component talks to the daemon except through that module.
- **Three modes per artifact**: **Preview** (rendered, reading-only canvas: navigation and read-only context are progressive disclosures; annotation, restore, and agent composition require an explicit mode transition), **Annotate** (margin comments on the
  rendered view — extends the existing annotate.js Preview/Annotate toggle), **Edit** (modify source,
  save → re-render). v1 editor is deliberately minimal (source editing + save; fancy live-preview/
  inline-annotate-while-editing deferred). Human edits in glosa → attributed `human` by construction.
- **Class R viewer (markdown)**: markdown-it + `data-line` stamping; SSE-driven updates morphed via
  idiomorph (scroll/selection preserved); annotation → W3C record → POST.
- **Class F viewer (foreign HTML)**: **source-preserving (bridge-augmented)** — served from the
  separate 4647 origin under a capability, document HTML/CSS/JS unmodified except one namespaced glosa
  bridge appended before `</body>`; strict CSP (`sandbox allow-scripts`, `connect-src 'none'`,
  separate origin) makes it safe even opened top-level and enforces "no external calls"; annotation via
  nonce-authenticated **MessageChannel** bridge to the parent (A3 §1-2). **Edit mode on class F**
  follows the generic **derived-from edge** (see R7) → opens the source artifact; if the artifact has no
  derived-from edge it is opaque (Preview + Annotate only, no Edit).
- **Diff pane**: shadow-git diffs via diff2html; **full history** (compare any two checkpoints, `restore`
  with dirty-worktree guard) per the user scope decision (A6 §F31 3.B). Human vs session vs unknown
  attribution shown; writer-register labels.
- **Conversation viewer** = **read-only transcript view with an out-of-band composer** (F32): tails the
  registered session's transcript (path from the registry, NOT a cwd→slug guess; root =
  `$CLAUDE_CONFIG_DIR`). Renders by event type (prose turns; collapsed tool chips; grouped subagents;
  meta hidden); vendored normalized `TranscriptEvent` layer with partial-line buffering, unknown-event
  quarantine, resume/clear/compact handling, tool-result caps (A2 §F16). **Fail soft**: any parse
  failure → "mirror unavailable — use the terminal", never worse; artifact/annotation workflow stays
  usable. Composer sends a NEW user message out-of-band via R4 (never writes the transcript). Attention
  state from the provider's `Notification` hook, not a transcript stall heuristic. The composer keeps
  one tab-scoped in-flight submission, clears only after `presented`, preserves newer edits, and shows
  an inline native session picker when multiple live explicit bindings are eligible.
- **Anchoring resolution contract** (A5 §F10/§F11): total `resolve(annotation, artifact, ctx) →
  source_range | pipeline_feedback | orphaned`. Fixed normalization (NFC, whitespace-fold, UTF-16
  offsets, uniqueness required). Class R = quote-in-stamped-line-range, else `block_range` guidance,
  else orphaned — **never pipeline_feedback**. Class F = manifest chunk → if `transformed:false` resolve
  within chunk lines (miss → `orphaned{quote_absent_not_transformed}`), if producer-declared
  `transformed:true` → typed `pipeline_feedback` to the producer. **Intent never rescues a bad mapping.**

### R7 — providers, adapters, and declarative workspace metadata
- **Agent-provider interface** (first-class v1 deliverable). Minimal interface (design stage may extend,
  not narrow):
  ```
  interface AgentProvider {
    id: string                                   // "claude-code" | "codex"
    detectSession(hookEvent): SessionBinding | null   // from hook payload → {session_id, workspace, transcript_path?, source}
    capabilities(session): { push:bool, gate:bool, boundaryDrain:bool, mcpPull:bool }
    deliver(session, entry): DeliveryResult      // uses the best available capability; result → journal delivery_attempt
    liveness(session): "alive" | "stale"         // lease/heartbeat, never kill(pid,0)
    transcriptPath(session): string | null       // for the conversation mirror
  }
  ```
  v1 ships: **Claude Code provider** (deep: push=channels, gate+boundary=hooks, mcpPull=tools, transcript
  mirror) and a **Codex provider** (gate + boundaryDrain + mcpPull; push=false — no channels-equivalent).
  Adding a CLI = a new provider, never a core change.
- **Content-adapter interface**: supplies artifact-class metadata, sidebar ordering, and generic
  **`derived-from(A→B, via process)`** edges. From an edge the core provides Edit-on-A→source-B,
  staleness, and class-F source resolution without knowing the workflow that produced either file.
- **`WorkspaceMetadataDescriptor` v1** is the durable public adapter input. It has an `id` and artifact
  entries containing a workspace-relative `path`, optional `class`, `order`, `derived_from {path,via}`,
  and `manifest {path,component}`. There is one active descriptor per workspace. Setting the same id
  replaces it atomically; a different id conflicts until the active descriptor is cleared.
- The daemon validates the complete descriptor before persistence: byte and entry limits, exact schema,
  unique paths, workspace confinement, no symlink components, and existence of every artifact,
  derived source, and manifest. A failed replacement leaves the previous descriptor intact. The active
  descriptor persists in daemon-owned workspace runtime state, reloads when the workspace opens, and
  invalidates connected SPA clients after set or clear.
- The descriptor is materialized behind the existing generic content-adapter interface. Manifest v1
  remains the class-F source-map authority; a transformed chunk's pipeline-feedback target is derived
  only from descriptor id, manifest component, chunk id, and source range. No external package or
  workflow logic enters glosa.
- **Core runs with zero adapters**: a plain directory yields an ordered file list and all generic
  viewer/annotation/editor behavior. Without a descriptor, HTML remains opaque Preview+Annotate.

### R8 — CLI + install  (detail: A6 full)
- Commands (all with `--json` + stable exit codes, A6): `open [--url]`, `init` (idempotent hook/MCP merge with
  ownership manifest, backups, uninstall — prints the correct channels dev command, never `--channels`),
  `resolve`, `apply-begin`, `request-review [--wait]`, `metadata set|show|clear`, `session bind`,
  `token rotate|revoke`, `doctor` (12 enumerated checks incl. optional-Channel status + transcript-root confinement), `status`;
  internal `mcp`, `hook <event>`. `open`
  auto-creates the `.glosa/` scaffold (distinct from `init`); a workspace is usable SPA-only without
  `init`.

### R9 — attention model  (detail: A5 §F23)
- Agents **knock, never barge**: `attention_request` entries retain their immutable `message`, `action`,
  and `target` and surface as workspace-switcher badges plus an
  attention tray (+ optional OS notification, deferred if it complicates persistent state). The SPA
  **never** auto-switches workspace or steals focus. All completion paths advance through
  `delivered→seen→done`; repeated mutations are idempotent. Generic actions show **Done**.
  `request-review` defaults to action `review` and shows **Approve** / **Request changes**. The terminal
  `done.detail` is `{outcome:done|approved|changes_requested,response?}` with a bounded optional response;
  `request-review --wait` returns that structure.

## 4. Non-functional  (detail: A6 §F30)
- **Platform: macOS-only v1** (Apple Silicon + Intel), pinned floors: macOS 13, Bun 1.2.7, Git 2.30,
  Claude Code 2.1.80 (channel floor; rec ≥2.1.200), browser Chromium≥111/Safari≥16.4. Non-Darwin →
  exit 5.
- **Privacy**: loopback-only; zero telemetry/external runtime calls; class-F network egress blocked by
  CSP. (Manuscripts may hold special-category personal data — this posture is load-bearing.)
- **Robustness**: daemon crash loses nothing (journal-as-truth + fsync-before-ACK + replay; SSE
  reconnect replays from cursor; watcher catch-up on restart). Any face (hook/MCP/CLI) failing changes
  which mechanism delivers, never whether the entry survives.
- **No build step** = no bundle/transpile + no native/compiled addons (`bun run` direct); Bun, system
  git, a browser are required host software (A6 §F30). Scrub `ANTHROPIC_API_KEY` from every spawned
  child env (the $1,800 footgun). Idle daemon < 100 MB RSS.

## 5. Task decomposition (epic order; each has a testable gate)
- **T0 — bootstrap**: create the repository; monorepo + lefthook/CI (`bun test` + typecheck); copy
  A1–A6 into the repo as `docs/appendices/`. Gate: CI green.
- **T1a — daemon lifecycle & API skeleton**: detached-daemon spawn/lock/handshake/port-discovery/
  shutdown (A5 §F13); full R5 auth (Host/Origin/Bearer/capability, `confinePath`); versioned route
  skeleton + `X-Contract-Version`. Gate: lifecycle + auth + attack-suite (A3 §5) unit/integration tests.
- **T1b — file bus & provenance**: inbox/journal(=truth)/replay/reconciliation (A4 §F04); picomatch
  matcher (A4 §F20); shadow-git + apply-lease attribution (A4 §F05/§F21); global workspace index +
  registry (A5 §F19). Gate: every lifecycle transition + crash-recovery (fault injection at each write
  boundary) + concurrency (two sessions/one cwd, duplicate resolve) + routing incl. parked-drain.
- **T2a — pin the Codex integration contract** (research sub-task, BEFORE the Codex provider build):
  verify current (mid-2026) Codex CLI hook/gate/transcript-file mechanics against real docs/source — the
  Plannotator-era "Codex Stop-hook + rollout-file parsing" note is the starting point, not gospel. Output:
  a concrete Codex provider contract (which hook fires the blocking gate, its stdin/stdout shape, where
  Codex writes its transcript, whether it speaks MCP). Gate: a written contract the provider is built against.
- **T2 — providers & delivery**: agent-provider interface (R7); Claude Code provider (channels + asyncRewake
  rearm + boundary hooks); **Codex provider** (per T2a; gate + boundary + MCP-pull); `glosa init` hook/MCP
  merge; `resolve`/`apply-begin`/MCP tools. Gate: each capability delivers for each provider; channels-disabled
  fallback still delivers; asyncRewake rearms across ≥3 sequential entries; journal records correct
  transport `outcome`.
- **T3 — SPA shell + class R viewer + three modes + diff/history**: handshake/pairing screens; switcher/
  sidebar/tabs/follow-mode; markdown Preview/Annotate/Edit; streaming-SSE (fetch) with reconnect replay;
  idiomorph; diff2html with full compare + restore. Gate: E2E — annotate a live-updating md file (anchors
  correct, morph preserves scroll); edit-in-glosa attributed `human`; restore with dirty-guard; SSE
  reconnect loses no events.
- **T4 — class F viewer**: separate-origin serving + capability + CSP + MessageChannel bridge (A3);
  source-preserving render; derived-from Edit→source; anchoring resolution (A5 §F11). Gate: E2E annotate
  the real rendered-preview fixture (renders within tolerance, its JS runs, network blocked); the full A3 §5
  attack suite; transformed-vs-verbatim chunk anchoring corpus.
- **T5 — conversation viewer**: transcript discovery via registry + `$CLAUDE_CONFIG_DIR`; normalized
  `TranscriptEvent` layer; typed rendering; out-of-band composer; fail-soft. Gate: fixtures incl. partial
  line, unknown event, resume/clear/compact, huge tool_result, and a corrupted line → graceful degrade.
- **T6 — generic metadata compatibility**: durable descriptor registration, adapter hydration,
  explicit session binding, class-F manifest resolution, API/CLI/MCP parity, and SPA refresh. Gate:
  malformed/conflicting/confined/symlink/rollback/restart tests plus neutral manifest fixtures.
- **T7 — external integration boundary**: an integration may call the public CLI/MCP contracts and
  produce manifest v1, but glosa never imports its package, state schema, paths, or workflow logic.
  Gate: compatibility exercised entirely through public contracts with no external code in this repo.
- **T8 — release gate = deterministic suites + private manual rehearsal**:
  - Deterministic suites (mandatory): storage/fault (kill daemon at each write step → one legal recovered
    state); concurrency; delivery (channels on/off, asyncRewake rearm, boundary, parked/resumed); browser
    security (the A3 §5 attacks); anchor corpus (Polish combining chars, md markup, duplicate quotes,
    stale hashes, transformed HTML); transcript suite; **explicit-binding topology** (agent cwd differs
    from the artifact workspace and routing still succeeds).
  - Manual rehearsal: copy maintainer-selected real source and rendered artifacts into an ignored
    workspace under `.context/`, rename them neutrally, and add only private descriptor/manifest marker
    data needed for one verbatim and one transformed region. Run an isolated daemon and a real Claude
    Code session from another cwd; bind it explicitly. Exercise human edit/provenance, verbatim source
    resolution and apply lease, transformed feedback without a source edit, parked drain, attention,
    conversation mirror/fallback, optional Channels/fallback delivery, and a local inert browser CSP probe.
    Record exact runtime versions and produce a sanitized report with separate T8 and v1-readiness results.
  - **v1 is done when the deterministic suites are green AND the manual rehearsal passes — not on one model run.**

## 6. Risks (build-relevant)
- Channels are research-preview → optional capability, all tests pass with channels off (R4).
- Transcript format internal/unstable → isolated normalizer, fixture tests, fail-soft (R6/A2).
- `ANTHROPIC_API_KEY` outranks subscription OAuth in spawned/hook contexts → scrub in every spawn; doctor warns.
- Codex provider is designed to the same interface as Claude's but its gate/transcript shapes differ →
  verify current Codex hook contract during T2 (the Plannotator-era snapshot is the starting point, not gospel).

## 7. Normative appendices (in repo as `docs/appendices/`)
- **A1** api-transport — HTTP contract, streaming-SSE, cursors/resync, capability URLs, versioning.
- **A2** claude-code-integration — channels flag, asyncRewake rearm, registry, transcript tailer, hook JSON shapes.
- **A3** security — two-origin split, CSP, MessageChannel bridge, token lifecycle, confinePath, Host/Origin table, attack→test matrix.
- **A4** filebus-concurrency — journal-as-truth durability, apply-lease attribution, shadow-git mechanics, picomatch matcher, slug.
- **A5** daemon-architecture — daemon lifecycle, workspace index, lifecycle state-transition table, anchoring resolution contract.
- **A6** cli-platform — command surface, exit codes, `init` merge/uninstall, platform pins, checkpoint/restore, terminology.

## 7b. Deferred / future (explicitly NOT v1 — recorded so they are not re-litigated or lost)
- **tila as the state-relay home**: promote the proven inbox/journal/registry schemas into a tila vertical
  (multi-machine, unlocks phone/iPad annotation via tila's Cloudflare Worker). Decision point after v1
  proves the loop. glosa v1 uses local files only.
- **Hosted-shell / Electron / L2–L3 distribution**: the SPA-swappable-data-layer invariant (R6) is built
  now so these are later deploys, but no shell/hosted mode ships in v1.
- **"Make it a git repo" promotion**: one-click promote a workspace to a real repo (seeded from the shadow
  history) + optional GitHub remote. Future; needs an explicit privacy-consent moment.
- **Publishing an artifact externally** is an integration concern, not a glosa responsibility. glosa
  itself makes no external runtime calls.
- **Reference implementations for T5** (transcript viewer): `d-kimuson/claude-code-viewer` (MIT, live
  file-watching viewer) and `claude-code-parser` for protocol knowledge are steal-from references; the
  deliberate decision is **vanilla, not assistant-ui/React** (v2 §2 stack).

## 8. Glossary
- **glosa** — this product. **Artifact** — a document file (markdown, or self-contained rendered HTML).
  **Workspace** — the directory an artifact set lives in. **Session** — one interactive agent process
  working in a workspace. **Provider** — an agent-integration adapter (Claude Code, Codex). **Content
  adapter** — a generic adapter supplying artifact classes + derived-from edges. **Class R/F** —
  markdown glosa renders (anchors via stamps) / foreign pre-rendered HTML glosa must not restyle (anchors
  via manifest + quotes). **derived-from edge** — generic "A is a rendered/compiled view of source B"
  metadata an adapter declares; the core computes edit-source + staleness from it with no domain knowledge.
  **WorkspaceMetadataDescriptor** — the durable declarative metadata v1 document supplied through
  CLI/MCP. **External integration** — any process outside glosa that supplies metadata, binds sessions,
  or generates artifacts using public contracts only.
