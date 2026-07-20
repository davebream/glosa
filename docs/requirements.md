# glosa v1 — requirements (v2, build-ready)

**This is the authoritative build input for glosa v1.** It supersedes v1 in full
(`archive/requirements-v1-superseded.md`). v1 + the adversarial review
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

**Target repo**: `davebream/glosa` (new, private). Build input for a kombajn autonomous epic.

## 0. What changed from v1 (orientation for anyone who read v1)
- **No cmux coupling** anywhere. SPA runs in any browser over localhost; delivery uses each agent's own hooks/MCP, not keystroke injection.
- **In-app editor is IN scope** (Preview / Annotate / Edit modes). v1's "no editing" non-goal is removed.
- **jethro routing** uses jethro's existing session binding, never terminal cwd (F01).
- **Multi-agent**: Claude Code deep + Codex built to the same provider interface; provider interface is a first-class deliverable.
- **History = full** (compare + restore). **Platform = macOS-only, pinned versions.**
- Durability, auth, daemon lifecycle, anchoring, security, CLI all hardened per appendices A1–A6.

## 1. Goal & release gate
**Goal**: eliminate four failure modes of agent-assisted writing — (A) unreadable terminal rendering
of long-form dialogue, (B) no artifact preview/annotation beside the agent, (C) manual edits invisible
to the agent, (D) annotation of rendered output requiring copy-paste.

**Hard release gate**: the deterministic acceptance suites (§6, per Codex F14) pass, AND the manual
rehearsal (T8) against a copy of a real past sermon passes. glosa is not used in a live sermon week
before both pass. No live-week experiments; no Plannotator trial.

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
providers/codex, adapters/jethro, cli}`. Three invariant boundaries (review-blockers if violated):
(1) daemon API is versioned + client-agnostic; (2) agent providers and content adapters only enter
via their interfaces — no special-casing; (3) the SPA talks to the daemon only through the public
authenticated API. **Adapters/providers carry ALL domain- and agent-specific knowledge; the core is
generic.**

## 3. Functional requirements

### R1 — singleton daemon, ports, workspace model  (detail: A5 §F13, A4, A6 §F30)
- One daemon/machine; lock `~/.glosa/daemon.lock` carries `{instance_id,pid,port,protocol_version,…}`;
  **`lock.port` is the authoritative port** (env `GLOSA_PORT` default 4646 only seeds a fresh spawn;
  class-F port = `GLOSA_PORT+1` = 4647). No entry point *becomes* the daemon in-process: a client with
  no live daemon **spawns a detached `glosa __daemon`** (unref + ignores SIGHUP/SIGINT) and acts as a
  client; the MCP shim (`glosa mcp`) only proxies, never binds/locks. Readiness = passing
  `/api/handshake`. `bind → O_EXCL lock create` is the CAS; simultaneous spawns → one wins.
- **Workspace = a directory** (git repo or not; never assume/touch a real repo). Sources: session
  registration, `glosa open <dir>`, first-touch `.glosa/`. A **global index** `~/.glosa/workspaces.json`
  (daemon-only writer, atomic) enumerates workspaces; identity = realpath→NFC→strip-slash; slug =
  `basename-sha256(path)[:6]` with deterministic collision-lengthening (A4 §F25).
- **Tracked-artifact rule** (one picomatch matcher → one normalized file LIST feeding watcher + sidebar
  + git pathspec identically): include `**/*.md,**/*.html,**/*.txt`; exclude dot-dirs, `node_modules`,
  files > 2 MiB; symlinks never followed/matched; NFC + case-sensitive; per-workspace override in
  `.glosa/config.json` (A4 §F20).
- Git-agnostic provenance: shadow repo `GIT_DIR=.glosa/shadow.git --work-tree=<root>`, argv-safe, one
  git mutex/workspace, deterministic init + baseline, index-lock recovery (A4 §F21). UI speaks
  versions/timeline/restore — never commits/SHAs.

### R2 — session registry & routing  (detail: A2 §F08, A5 §F19)
- Providers register live agent sessions via hooks → daemon API (never direct file writes; serialized
  by the daemon → no lost entries). Record: `{session_id, provider, workspace_binding, cwd,
  transcript_path, source, last_active_at, lease_expiry}`. Liveness = **lease + activity heartbeat**
  (NOT `kill(pid,0)` — hook input has no documented PID).
- **Routing precedence**: (1) an **explicit provider/adapter-supplied binding** (authoritative); (2)
  the generic cwd-ancestor fallback. For jethro this is decisive (R7): jethro artifacts live outside
  any cwd, and jethro's own `track-claude-session` hook already records `{session_id, transcript_path}`
  in the sermon `state.json` `session_history` — the adapter consumes that. Two sessions bound to one
  workspace → deliver to the `session_hint`; else a one-time SPA picker (never guess). No live session →
  the entry **parks**; next session registration for that workspace drains it.

### R3 — file bus: inbox, journal (=truth), provenance  (detail: A4 §F04/§F05, A5 §F23)
- **The journal is the single source of truth.** Inbox entries are **immutable** (write-once, temp→
  fsync→rename); current status is derived by **replaying the journal** (idempotent fold; ULID
  `event_id` + `idem` keys). `glosa resolve` appends **one** journal line — no cross-file atomic write
  exists (this is the F04 fix). Startup reconciliation: torn-tail truncate → replay → inbox self-heal →
  apply-lease reconcile → offline-edit catch-up. Corrupt interior line → quarantine, never fatal.
- Entry kinds: `human_edit`, `annotation`, `attention_request`. Envelope + payloads exactly per A4/A5
  (`human_edit` = inline hunk diffs referenced by shadow-git sha, never full bodies; `annotation` =
  W3C quote+prefix/suffix+position + `intent` + `target.chunk_id?`). Annotation `intent` enum =
  `content` (change the words → source edit) | `classification` (wrong type/split/label → pipeline
  feedback) | `style` (rendering/notation → renderer/CSS). The resolver (R6) uses `intent` only to
  frame/route feedback once anchoring has decided source-vs-pipeline; it never overrides anchoring.
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
- **No cmux.** The universal cross-agent path is the structured blocking gate (Plannotator-proven on
  Claude/Codex/Gemini/Copilot) + turn-boundary drain + MCP-pull.

### R5 — HTTP API + auth  (detail: A1 full, A3 §4)
- Two fixed loopback listeners (SPA/API 4646; class-F content 4647) — one daemon, two origins.
- **Auth**: `Host` must literally equal `127.0.0.1:<port>` on every request (no DNS → anti-rebinding);
  Bearer token (128-bit, `~/.glosa/token` 0600) on API requests via `Authorization` header; **SSE uses
  `fetch()`-streaming (NOT native EventSource) so the header rides normally**; the class-F iframe loads
  via a **one-time 256-bit capability URL** on port 4647 (no ambient token there). Origin allowlist is
  route-class-scoped (strict on state-changing, foreign-only-reject on reads/handshake, inapplicable to
  navigation) — the resolved table is A3 §4. No cookies (CSRF structurally dead).
- Versioned route catalog (`/api/handshake` + eleven `/w/<slug>/…` routes incl. artifact list/content,
  streaming SSE with journal-offset cursor + reconnect replay, annotations, diff, checkpoints/restore
  (full history), transcript stream, inbox/attention) — schemas, status codes, 1 MiB body cap,
  `X-Contract-Version` (major mismatch → 409 + reload; minor tolerated) in A1. All paths pass the single
  `confinePath()` realpath guard (A3 §3).

### R6 — SPA: three modes, four viewers  (detail: A3 §1-2, A5 §F10/§F11, A1)
- **v1 invariant — swappable data layer**: the SPA reaches the daemon through ONE data-access module
  (same-origin fetch today). This is a v1 build constraint, not future scope: it is what makes a future
  hosted-shell/Electron topology a config change rather than a refactor (the L0→L3 distribution ladder).
  No SPA component talks to the daemon except through that module.
- **Three modes per artifact**: **Preview** (rendered, read-only), **Annotate** (margin comments on the
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
  state from the provider's `Notification` hook, not a transcript stall heuristic.
- **Anchoring resolution contract** (A5 §F10/§F11): total `resolve(annotation, artifact, ctx) →
  source_range | pipeline_feedback | orphaned`. Fixed normalization (NFC, whitespace-fold, UTF-16
  offsets, uniqueness required). Class R = quote-in-stamped-line-range, else `block_range` guidance,
  else orphaned — **never pipeline_feedback**. Class F = manifest chunk → if `transformed:false` resolve
  within chunk lines (miss → `orphaned{quote_absent_not_transformed}`), if producer-declared
  `transformed:true` → typed `pipeline_feedback` to the producer. **Intent never rescues a bad mapping.**

### R7 — providers & adapters (the generic/domain boundary)
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
  **`derived-from(A→B, via process)`** edges. From an edge the core generically provides (1) Edit-on-A
  opens source B and (2) staleness (B newer than A's build → A stale). The core has **zero** pipeline/
  sermon knowledge.
- **jethro adapter** (`packages/adapters/jethro`): recognizes sermon workspaces at the fixed plugin-data
  path `~/.claude/plugins/data/jethro-jethro/sermon-sessions/<id>/`; supplies the session binding from
  `state.json` `session_history` (R2); orders the sidebar by stage; marks the canonical manuscript
  (`canonical_manuscript` pointer when present, else `07b`→`07` fallback — the common case, verified);
  declares the speech-notes-HTML → manuscript derived-from edge; classifies numbered stage `.md` as
  class R and `output/<slug>/speech-notes-*.html` as class F with the `chunks-<ts>/manifest.json`
  provenance. Schema authority = the TypeScript types in `~/code/jethro/mcp-server/src/state/`.
- **Core runs with zero adapters**: a plain directory → ordered file list, follow-mode on write
  activity, all viewers/annotation/editor work; no derived-from → HTML is opaque preview+annotate.
- **format-sermon companion changes** (separate HITL task T7; files live at
  `~/.claude/skills/format-sermon/`, outside the repo): `segment.py` records per-chunk
  `source_start_line`/`source_end_line` + `source_sha256` into `manifest.json`; thread `@@CHUNK(NNN)@@`
  markers reconciler→`normalize.py`→`render.py` `data-chunk`; add a per-chunk `transformed` flag; fix
  the `render.py` `<title>` bug. Proposed as reviewable diffs for approval.

### R8 — CLI + install  (detail: A6 full)
- Commands (all with `--json` + stable exit codes, A6): `open`, `init` (idempotent hook/MCP merge with
  ownership manifest, backups, uninstall — prints the correct channels dev command, never `--channels`),
  `resolve`, `apply-begin`, `request-review [--wait]`, `doctor` (13 enumerated checks incl. real-channel-
  registration + transcript-root confinement), `status`; internal `mcp`, `hook <event>`. `open`
  auto-creates the `.glosa/` scaffold (distinct from `init`); a workspace is usable SPA-only without
  `init`.

### R9 — attention model  (detail: A5 §F23)
- Agents **knock, never barge**: `attention_request` entries surface as workspace-switcher badges + an
  attention tray (+ optional OS notification, deferred if it complicates persistent state). The SPA
  **never** auto-switches workspace or steals focus. `attention_request` has a defined payload +
  unified lifecycle (`open→delivered→seen→done|expired|stale`); `request-review --wait` resolves on
  `done`/`expired` with the verdict in the event detail.

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
- **T0 — bootstrap**: create `davebream/glosa` (private); monorepo + lefthook/CI (`bun test` + typecheck);
  `.kombajn/project.json` runner/baseline; copy A1–A6 into the repo as `docs/appendices/`. Gate: CI green.
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
  the real speech-notes fixture (renders within tolerance, its JS runs, network blocked); the full A3 §5
  attack suite; transformed-vs-verbatim chunk anchoring corpus.
- **T5 — conversation viewer**: transcript discovery via registry + `$CLAUDE_CONFIG_DIR`; normalized
  `TranscriptEvent` layer; typed rendering; out-of-band composer; fail-soft. Gate: fixtures incl. partial
  line, unknown event, resume/clear/compact, huge tool_result, and a corrupted line → graceful degrade.
- **T6 — jethro adapter**: recognition at plugin-data path; session binding from `session_history`;
  stage ordering; derived-from edge; class-F manifest resolution. Gate: against fixture copies of the
  real session `~/.claude/plugins/data/jethro-jethro/sermon-sessions/2026-07-15_j-17,20-23/` (canonical
  pointer ABSENT → exercises the 07b→07 fallback) + a synthetic post-#314 state + the speech-notes fixture.
- **T7 — format-sermon companion diffs (HITL)**: produce R7 changes as reviewable diffs; regenerate the
  fixture to prove `data-chunk`/manifest ranges/`transformed` appear and old outputs still render. Gate:
  user approval; fixture regenerated clean. **Must precede T6/T8 assertions that depend on new manifest fields.**
- **T8 — release gate = deterministic suites + manual rehearsal** (Codex F14):
  - Deterministic suites (mandatory): storage/fault (kill daemon at each write step → one legal recovered
    state); concurrency; delivery (channels on/off, asyncRewake rearm, boundary, parked/resumed); browser
    security (the A3 §5 attacks); anchor corpus (Polish combining chars, md markup, duplicate quotes,
    stale hashes, transformed HTML); transcript suite; **actual jethro topology** (Claude cwd ≠ sermon
    plugin-data path; provider binding routes correctly).
  - Manual rehearsal: against a COPY of `po-co-to-wszystko` — sources
    `~/Obsidian/Vault/Ministry/Sermons/output/po-co-to-wszystko/` (render+chunks+manifest) and
    `~/Obsidian/Vault/Ministry/Sermons/Blisko/jan-17-20-26/Manuskrypt — Po co to wszystko.md` (source).
    Run a real Claude session (subscription; channels where available): human-edit → journal/attribution;
    annotate speech-notes → quote→manuscript resolution + source edit + re-render pickup; transformed-
    element annotation → intent routing (no source edit); parked-entry drain; attention flow; conversation
    mirror live. Pin Claude version/model; produce a signed-off compatibility report.
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
- **Cloudflare-Pages public sermon deploy** (a format-sermon/jethro concern, not glosa): format-sermon's
  Phase 4 currently deploys speech notes to a public Pages project — an orthogonal privacy decision
  (add Access, or drop the deploy once glosa serves notes locally). Tracked; not a glosa v1 task.
- **Reference implementations for T5** (transcript viewer): `d-kimuson/claude-code-viewer` (MIT, live
  file-watching viewer) and `claude-code-parser` for protocol knowledge are steal-from references; the
  deliberate decision is **vanilla, not assistant-ui/React** (v2 §2 stack).

## 8. Glossary
- **glosa** — this product. **Artifact** — a document file (markdown, or self-contained rendered HTML).
  **Workspace** — the directory an artifact set lives in. **Session** — one interactive agent process
  working in a workspace. **Provider** — an agent-integration adapter (Claude Code, Codex). **Content
  adapter** — a domain adapter supplying artifact classes + derived-from edges (jethro). **Class R/F** —
  markdown glosa renders (anchors via stamps) / foreign pre-rendered HTML glosa must not restyle (anchors
  via manifest + quotes). **derived-from edge** — generic "A is a rendered/compiled view of source B"
  metadata an adapter declares; the core computes edit-source + staleness from it with no domain knowledge.
- **jethro** — the user's sermon-prep Claude Code plugin (`~/code/jethro`); produces numbered stage
  artifacts + `state.json` in `~/.claude/plugins/data/jethro-jethro/sermon-sessions/<id>/`; its
  `track-claude-session` hook records `{session_id, transcript_path}` into `state.json` `session_history`.
- **format-sermon** — a local Claude Code skill (`~/.claude/skills/format-sermon/`) compiling a manuscript
  into color-coded speech-notes HTML (LLM classifier + Python renderer); its output is the class-F fixture.
- **kombajn** — the user's autonomous build-pipeline orchestrator that consumes this document.
