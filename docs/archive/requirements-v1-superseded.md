> **SUPERSEDED by `2026-07-20-glosa-v1-requirements-v2.md` (2026-07-20, post-Codex-review). Do not build from this file — v2 governs.**

# glosa v1 — requirements

**Product**: glosa — a local-first, writing-first workspace for people working with AI coding agents.
An agent (Claude Code first; agent-agnostic by design) drafts documents; the human reads them
rendered, annotates in the margins, edits files directly; glosa makes sure every annotation and
edit reliably reaches the right agent session, with full provenance. v1 is the **companion
topology**: the agent session stays a normal interactive terminal session; glosa runs beside it.

**Target repo**: `davebream/glosa` (new, private). This document is the build input for a kombajn
autonomous epic run against that repo (kombajn: the user's autonomous build-pipeline
orchestrator — it decomposes this document into designed, planned, built, and reviewed tasks).

**Background documents** (context, not required reading to build; this doc is self-sufficient):
- `/Users/dawid/code/jethro/.kombajn/inbox/pitches/2026-07-20-artifact-desk-options.md` (architecture + verified research, §1–§11)
- `/Users/dawid/code/jethro/.kombajn/inbox/pitches/2026-07-20-artifact-desk-session-decisions.md` (decision log)
- `/Users/dawid/code/jethro/.kombajn/research/2026-07-20-claude-code-jsonl-ui-components.md` (component research)
- `/Users/dawid/code/jethro/.kombajn/research/2026-07-20-electron-vs-tauri-desk-shell.md` (shell research; v1 ships NO shell)

## 1. Goal and success criteria

**Goal**: eliminate four failure modes of agent-assisted writing, verified against real sermon-prep
workflows: (A) unreadable terminal rendering of long-form dialogue, (B) no artifact
preview/annotation beside the agent, (C) manual file edits invisible to the agent session,
(D) annotation of rendered output requiring manual copy-paste back to the agent.

**Release gate (hard)**: the full **rehearsal harness** (T8) passes end-to-end against a copy of a
real past project. glosa is NOT used in a live working week before that gate passes. No
live-usage experiments are part of v1 validation.

**Non-goals for v1 (explicitly out of scope — do not build)**: session ownership/spawning (the
agent session is always started by the user in their terminal); any desktop shell
(Electron/Tauri — v1 is daemon + browser page); dictation capture; mobile/remote access; cloud
sync or hosted anything; in-app text editing of artifacts (humans edit files in their own
editors); real-time collaborative editing; fuzzy annotation re-anchoring beyond exact/normalized
quote match; a public plugin/SDK surface; telemetry of any kind.

## 2. Architecture (fixed decisions — do not re-litigate)

```
┌─ user's terminal (cmux) ──────────────┐   ┌─ browser page (cmux browser pane) ─┐
│ interactive `claude` session(s)       │   │ glosa SPA, served by the daemon    │
│  - SessionStart/End/Stop/UserPrompt-  │   │  - workspace switcher              │
│    Submit hooks → register/drain      │   │  - viewers: markdown / foreign-    │
│  - receives pushes (channel/cmux)     │   │    HTML / diff / conversation      │
│  - runs `glosa resolve` via Bash      │   │  - annotation UI                   │
└──────────────┬────────────────────────┘   └──────────────┬─────────────────────┘
               │ hooks, MCP (stdio shims), CLI             │ HTTP + SSE, Bearer token
        ┌──────▼─────────────────────────────────────────▼──────┐
        │ glosa daemon — ONE per machine (singleton, fixed port) │
        │ file bus: per-workspace inbox + journal + shadow git   │
        │ watcher (chokidar) · session registry · delivery       │
        │ auth: Origin/Host allowlist + Bearer pairing token     │
        └────────────────────────────────────────────────────────┘
```

Fixed technology decisions: **Bun** (daemon runtime, `Bun.serve`, single process serves API + SPA);
**TypeScript** everywhere; **no heavy frontend framework** (no React/Vue in v1 — server-rendered
HTML + small vanilla modules); **markdown-it** (+ plugin to stamp `data-line` attributes);
**idiomorph** for live DOM morphing; **diff2html** for the diff pane; **chokidar v4** for
watching; shadow-git via the system `git` binary. Vendor or port the protocol knowledge of
`claude-code-parser` (npm, MIT) for transcript event typing rather than reinventing it.

Monorepo layout: `packages/daemon`, `packages/spa`, `packages/adapters/jethro`, `packages/cli`
(the `glosa` binary wraps daemon+CLI; MCP server mode is a subcommand). Three invariant
boundaries (violating any is a review-blocker): (1) the daemon API is versioned and
client-agnostic; (2) session *providers* only ever enter via the registry — no special-casing of
how a session came to exist; (3) the SPA talks to the daemon exclusively through the public
authenticated API.

## 3. Functional requirements

### R1 — Singleton daemon & workspace model
- One daemon per machine: lock file (`~/.glosa/daemon.lock`), **default port 4646** (override via
  `GLOSA_PORT` env or `~/.glosa/config.json`; chosen to avoid locally-used ports 3400/4747/8384),
  lazily started by the first thing that needs it (CLI, hook, MCP shim). MCP/CLI entry points are
  **shims**: if the daemon runs, proxy to it; if not, the first one wins the lock and becomes it.
- A **workspace = a directory**. Sources of workspaces: live-session registry entries (cwd),
  directories containing `.glosa/`, manual `glosa open <dir>`. First touch creates
  `<workspace>/.glosa/` containing `inbox/`, `journal.ndjson`, `shadow.git/`, `registry.json`.
- **Tracked-artifact rule (core default, no adapter)**: a file is an artifact iff it matches the
  workspace's include globs and no exclude glob. Defaults: include `**/*.md`, `**/*.html`,
  `**/*.txt`; exclude dot-directories (incl. `.glosa/`), `node_modules/`, and files >2 MB.
  Per-workspace override in `.glosa/config.json` (`artifacts.include` / `artifacts.exclude`).
  This one rule drives all three consumers identically: the watcher, the shadow-git pathspec,
  and the sidebar listing (natural-sort order in the no-adapter case).
- Workspace **slug** (used in URLs `/w/<slug>/…`): `sanitized-basename` + `-` +
  `sha256(absolute-path)[:6]` — human-readable, collision-free, stable across restarts.
- Workspaces are **git-agnostic**: never assume, require, or touch a real git repo in or above
  the workspace. All provenance lives in the shadow repo (bare, `GIT_DIR=.glosa/shadow.git`,
  `--work-tree=<workspace>`, pathspec = the tracked-artifact rule above). UI language is
  document-native (versions, timeline, restore) — never commits/branches/SHAs.

### R2 — Session registry
- Claude Code hooks (installed by `glosa init`, see R8) register sessions:
  SessionStart (matcher `startup|resume|clear`) writes `{session_id, cwd, cmux_surface?, pid,
  registered_at}`; SessionEnd removes (must complete <1s; SessionEnd hooks have a 1.5s budget).
  `cmux_surface` comes from `$CMUX_SURFACE_ID` when present; its absence is normal (non-cmux
  terminals) and only downgrades delivery (R4).
- Liveness: `kill(pid, 0)`-style checks; stale entries pruned on read.
- Routing rule: an event about a file resolves to the live session whose cwd is the nearest
  ancestor of that file. Two live sessions in one directory → deliver to the one named by the
  event's `session_hint` if alive, else surface a picker in the SPA (never guess silently).
  No live session → the entry **parks**; the next SessionStart in that cwd drains it.

### R3 — File bus: inbox, journal, provenance
- **Inbox**: one JSON file per entry, `.glosa/inbox/<id>.json`. Lifecycle
  `pending → delivered → applied | rejected | stale` (plus `seen → done` for
  `attention_request`). Entry kinds in v1: `human_edit`, `annotation`, `attention_request`.
  (`dictation` is reserved in the schema, never produced.)
- Entry envelope (all kinds):
  ```json
  {
    "id": "inb-<timestamp>-<rand>",
    "kind": "human_edit | annotation | attention_request",
    "created_at": "ISO-8601",
    "status": "pending",
    "artifact": {
      "source_path": "<workspace-relative>",
      "source_sha256": "<hex>",
      "rendered_path": "<workspace-relative, optional>",
      "rendered_sha256": "<hex, optional>"
    },
    "session_hint": "<session_id, optional>",
    "payload": { }
  }
  ```
- `human_edit` payload: `{checkpoint_before, checkpoint_after, files:[{path, diff, diff_bytes}],
  burst_window_s}` — unified diffs inline, hunk-level, never full file bodies.
- `session_hint` is set by the **daemon** at entry creation: the session the SPA has explicitly
  bound to the workspace (user picked one via the picker), else the most-recently-active live
  session whose cwd contains the artifact, else omitted. It is a fast-path hint only — R2's
  routing rule remains authoritative at delivery time.
- `annotation` payload (W3C-selector shaped): `{body, intent: "content"|"classification"|"style",
  target:{chunk_id?, quote:{exact, prefix, suffix}, position:{start,end}}}`. `position` is valid
  only while `rendered_sha256` matches; `quote` (±40 chars context, whitespace-normalized
  matching) is the durable anchor; `chunk_id` scopes search when present.
- **Journal** (`.glosa/journal.ndjson`): append-only, one JSON object per line —
  `{at, entry, event, by, detail}`. `by` ∈ `watcher | daemon | hook:<name> | session:<id> |
  human`. Every lifecycle transition has exactly one defined writer; single-line `O_APPEND`
  writes. `glosa resolve <id> applied|rejected|stale [--session <id>] [--note]` (run by the
  agent via Bash) appends the journal line AND rewrites the inbox entry's status atomically —
  one command, both writes.
- **Provenance**: watcher-triggered shadow-git checkpoints on save-burst debounce (2–5s,
  timer-reset semantics: one burst = one commit) and before an agent applies an entry.
  Attribution via author field: `human <glosa@local>` vs `session:<id> <glosa@local>`.
  On daemon start, diff work-tree vs last checkpoint to journal offline edits (downtime catch-up).

### R4 — Delivery ladder (all behind one interface; per-session best-rung selection)
1. **Channel push** (Claude Code ≥2.1.80, research preview): a stdio MCP server mode
   (`glosa mcp`) declaring `capabilities.experimental['claude/channel']`; forwards this
   session's pending entries as `notifications/claude/channel` `{content, meta}` (meta keys must
   match `[a-zA-Z_][a-zA-Z0-9_]*`). Requires the session launched with `--channels` (+ dev flag
   for unlisted plugins); MUST degrade silently to lower rungs when unavailable — the
   notification is a doorbell, the inbox entry is the truth.
2. **asyncRewake hook**: SessionStart-launched watcher process that exits code 2 with a short
   payload when the workspace inbox gains entries.
3. **Boundary hooks**: Stop hook drains (block-with-reason, ≤8 consecutive — treat as drain, not
   loop; does not fire on user interrupt; API errors route to StopFailure whose output is
   ignored); UserPromptSubmit attaches pending summaries as additionalContext (30s budget,
   silent-discard on timeout — keep reads <100ms).
4. **cmux typing** (works for ANY agent CLI, incl. non-Claude): `cmux send` +
   `cmux send-key enter` into the registered surface. Payloads MUST be sanitized: literal
   `\n`/`\r` in `cmux send` text auto-submit; key syntax is `ctrl+c` style (tmux-style `C-c` is
   rejected).
- Delivery marks `delivered` in the journal with `{via, session}`. Un-actioned `delivered`
  entries re-surface at the next boundary/SessionStart — the failure mode is a repeat nudge,
  never silence.

### R5 — Daemon HTTP API + auth (in from day one)
- Bind `127.0.0.1` only. Every request validated: `Host` allowlist and `Origin` allowlist
  (daemon's own origin; the API rejects requests with a missing/foreign Origin for state-changing
  routes) — this kills drive-by-localhost and DNS rebinding. No cookies anywhere.
- **Pairing**: 128-bit token generated once at `~/.glosa/token` (0600). `glosa open` launches the
  browser at `http://127.0.0.1:<port>/#t=<token>`; SPA stores it and sends
  `Authorization: Bearer` thereafter. Tokenless requests: only `GET /api/handshake` (returns
  `{contract_version, daemon_version, paired: false}`) — still Origin-gated.
- **Handshake**: SPA calls it first; three distinct failure screens (daemon down / unpaired /
  contract mismatch). The HTTP contract is semver'd; SPA tolerates N-1.
- Routes namespaced per workspace: `/w/<slug>/…` (artifacts list, artifact content, SSE stream,
  annotations POST, diff data, transcript stream, inbox/attention state). Decision-affecting
  routes (attention responses, future gates) are a separate route group (scoping is additive
  later).

### R6 — SPA: viewers and annotation
- **Shell**: workspace switcher (badges for attention requests), artifact sidebar, pinned tabs +
  follow-mode (default: follow the most recently active session's most recently written
  artifact). Every workspace/artifact addressable by URL. Light+dark, readable typography
  (this is a writing tool: real line-height, measure ~65–75ch, prose-first defaults).
- **Class R viewer (markdown)**: markdown-it render with `data-line` stamping; SSE-driven
  updates morphed via idiomorph (scroll/selection preserved). Annotation: select text →
  popover → W3C-shaped record → POST. Anchors resolve via stamps (line ranges) + quote.
- **Class F viewer (foreign HTML)**: renders a self-contained HTML artifact **verbatim** in a
  sandboxed iframe (served, not srcdoc, from the daemon under the workspace route; scripts
  allowed, same-origin NOT granted to the parent app origin beyond the bridge). A bridge script
  is injected at serve time: selection capture, mark-drawing, quote-based re-marking after
  reload, postMessage protocol to the shell (annotation UI lives in the shell — the bridge only
  captures/marks). Document CSS/JS must run untouched; bridge styles namespaced.
- **Diff pane**: shadow-git diffs rendered via diff2html; selector for "since my last
  annotation" / "since yesterday" / between any two checkpoints; human vs session attribution
  visible. Writer-register labels.
- **Conversation viewer (read-only mirror + composer)**: tails the registered session's
  transcript JSONL (root = `$CLAUDE_CONFIG_DIR`, NEVER hardcode `~/.claude` — on the reference
  machine live transcripts are under `~/.ccs/instances/<name>/projects/<slug>/<id>.jsonl`).
  Renders by entry type: dialogue turns as typeset prose; tool calls as collapsed one-line
  chips; subagent activity grouped; meta hidden behind a toggle. Updates arrive per
  message/tool event (NOT token-streaming — set expectation in UI). Composer sends a new user
  message via the delivery ladder (R4 rung 4/1). **Fail soft**: any parse failure switches the
  pane to "mirror unavailable — use the terminal" rather than degrading incorrectly. An
  "attention needed in terminal" indicator shows when the session awaits interactive input
  (heuristic: transcript quiet + process alive + last event is a permission-shaped stall; best
  effort, false negatives acceptable).
- **Anchor resolution & staleness** (applies to both viewers): exact quote in source (scoped by
  chunk/line hint) → apply; source hash changed → scoped exact search → normalized search →
  else mark `stale` and surface. **Never guess.** For annotations whose quote does not exist in
  the SOURCE (transformed/compiled artifacts — see R7), classify by `intent` and deliver as
  pipeline feedback rather than a source edit.

### R7 — jethro adapter pack (`packages/adapters/jethro`)
Adapters make the core smarter, never necessary. The core must run with zero adapters (plain
directory → plain ordered file list; follow-mode keys on write activity).
- Recognizes jethro sermon workspaces (presence of jethro's session `state.json`). Reads stage
  state + the `canonical_manuscript` pointer to: order the sidebar by pipeline stage, badge the
  canonical manuscript, mark stale renders, default follow-mode to the current stage's artifact.
- Registers artifact classes: numbered stage `.md` files → class R; `output/<slug>/speech-notes-*.html`
  (produced by the user's local `format-sermon` skill) → class F with sidecar provenance:
  `chunks-<ts>/manifest.json` + the rendered HTML's `data-chunk`/`data-page` attributes.
- **Companion change set (separate task, files live OUTSIDE the repo on the reference machine,
  in `~/.claude/skills/format-sermon/`)**: (a) `scripts/segment.py`: record
  `source_start_line`/`source_end_line` per chunk (switch `re.split` to `finditer`) and write
  `source_sha256` into `manifest.json`; (b) thread `@@CHUNK(NNN)@@` markers through
  reconciliation (teach `prompts/reconciler.md` + `scripts/normalize.py` to preserve them) and
  translate to `data-chunk="chunk-NNN"` attributes in `scripts/render.py`; (c) fix the
  `render.py` `<title>` bug (title variable clobbered by the last H2). These changes are
  HITL-gated: propose as diffs for the user to approve before touching the skill.

### R8 — CLI + install
- `glosa open [dir]` (pair + open browser page), `glosa init` (idempotent: writes the hooks
  block into the workspace's `.claude/settings.json`, registers `glosa mcp` in `.mcp.json`,
  prints the `--channels` launch hint), `glosa resolve <id> <verdict>` (agent-facing, R3),
  `glosa request-review <path> [--wait <timeout>]` (agent-facing attention request),
  `glosa doctor` (daemon/port/token/hook/transcript-root diagnostics), `glosa status`.
- MCP tools (same binary, `glosa mcp`): `annotations_pending`, `annotations_resolve`,
  `request_review`, `status`. Tools are the portability surface (Claude Desktop etc.); Claude
  Code v1 primarily uses hooks + channel + CLI.

### R9 — Attention model
Agents knock, never barge: `attention_request` entries surface as switcher badges + an attention
tray (+ optional OS notification via the page's Notification API). The SPA NEVER auto-switches
workspace or steals focus. Requests persist until acted on; `--wait` callers receive resolution
via the request entry's status change.

## 4. Non-functional requirements

- **Privacy**: loopback-only; no telemetry, no external calls of any kind at runtime; nothing
  ever uploaded. (Manuscript content may include special-category personal data.)
- **Latency**: human save → journal entry <1s; annotation POST → delivery attempt <2s (excluding
  agent turn boundaries); SSE render update <500ms after artifact write.
- **Robustness**: daemon crash loses nothing (bus is files; SSE clients reconnect; watcher
  catch-up on restart). Any face (hook/MCP/CLI) failing changes *which* rung delivers, never
  whether the entry survives. Transcript-parser failures fail soft (R6).
- **Footprint**: idle daemon <100MB RSS; no build step required to run from checkout
  (`bun run` end-to-end); zero native compile dependencies.
- **Testing**: unit tests for bus lifecycle/routing/anchor cascade; integration tests with a
  scripted fake session (registry + hook + delivery paths, cmux mocked); the rehearsal harness
  (T8) as the acceptance suite. Baseline commands green before first task merges.

## 5. Task decomposition (epic order; each task lists its acceptance gate)

- **T0 — repo bootstrap**: create `davebream/glosa` (private), monorepo scaffolding, lefthook +
  CI running `bun test` + typecheck, `.kombajn/project.json` with testRunner/baseline commands.
  Gate: CI green on empty-but-wired packages.
- **T1 — daemon core**: singleton/lock/port, workspace model, file bus (inbox/journal schemas
  exactly as R3), watcher + shadow-git checkpoints + downtime catch-up, session registry, HTTP
  API skeleton with full R5 auth. Gate: unit+integration tests over every lifecycle transition
  and the routing rules incl. parked-entry drain.
- **T2 — delivery + agent faces**: hooks pack (`glosa init` writes it), channel MCP mode,
  asyncRewake watcher, cmux adapter with payload sanitization, `glosa resolve`,
  `request-review`, MCP tools. Gate: scripted-session integration test proving each rung
  delivers AND that killing rungs 1–3 still delivers via 4; journal records `via` correctly.
- **T3 — SPA shell + class R viewer + diff pane**: handshake/pairing screens, switcher/sidebar/
  tabs/follow-mode, markdown viewer with stamps + SSE + idiomorph, annotation popover + POST,
  diff pane. Gate: E2E (Playwright or cmux browser automation) — annotate a live-updating
  markdown file, entry created with correct anchors, morph preserves scroll.
- **T4 — class F viewer**: iframe serving + bridge injection + postMessage protocol + quote
  re-marking; renders the real speech-notes HTML sample byte-identical (visual regression on a
  fixture copy). Gate: E2E annotating the fixture speech-notes HTML; document's own JS still works.
- **T5 — conversation viewer**: transcript discovery via registry + `$CLAUDE_CONFIG_DIR`,
  typed-entry rendering (vendor claude-code-parser knowledge), composer via delivery ladder,
  fail-soft. Gate: E2E against recorded transcript fixtures (incl. a deliberately corrupted one
  → graceful "mirror unavailable").
- **T6 — jethro adapter**: R7 recognition/ordering/badging, manifest-based class-F provenance
  resolution (manifest→source-range primary, quote fallback), intent-routing of
  non-resolvable annotations. Gate: adapter tests against fixture copies of (a) the real jethro
  session dir `/Users/dawid/.claude/sermon-sessions/2026-05-05_j-1,1-18/` — note it is
  **pre-#314** (no `canonical_manuscript` key in state.json), so it exercises the legacy
  07b→07 fallback path — and (b) the format-sermon output fixture (see T8 paths). A synthetic
  post-#314 state.json (with `canonical_manuscript`) must also be fixtured; field reference:
  jethro repo `/Users/dawid/code/jethro/mcp-server/src/state/` (TypeScript types are the schema
  authority).
- **T7 — format-sermon companion diffs** (HITL): produce the R7 change set as reviewable diffs
  + regenerate the fixture to prove `data-chunk`/manifest ranges appear and old outputs still
  render. Gate: user approval; fixture regeneration diff clean.
- **T8 — rehearsal harness (release gate)**: scripted end-to-end dry-run against a COPY of the
  real past project `po-co-to-wszystko`. Fixture sources on the reference machine (copy into a
  temp workspace; never modify the originals):
  rendered output + chunks + manifest: `/Users/dawid/Obsidian/Vault/Ministry/Sermons/output/po-co-to-wszystko/`;
  source manuscript: `/Users/dawid/Obsidian/Vault/Ministry/Sermons/Blisko/jan-17-20-26/Manuskrypt — Po co to wszystko.md`.
  Steps: start a real
  Claude Code session in it (subscription auth, `--channels` where available); human-edit
  simulation (scripted file edits) → verify journal/nudge/acknowledgment; annotation on the
  speech-notes fixture → verify quote→manuscript resolution, source edit, re-render pickup,
  `applied` journaling; transformed-element annotation → verify `intent` routing (no source
  edit, surfaced as feedback); parked-entry flow (annotate with no session → resume → drain);
  attention-request flow; conversation mirror renders the session live. Gate: every step
  asserted; a written rehearsal report artifact. **v1 is done when T8 passes, not before.**

## 6. Risks & mitigations (build-relevant only)

- **Channels are a research preview** (flags required; may change): treated as rung 1 of 4;
  all tests must pass with channels disabled.
- **Transcript JSONL format is internal/unstable**: parser isolated in one module with fixture
  tests; fail-soft contract (R6); breakage degrades the mirror only.
- **`ANTHROPIC_API_KEY` silently outranks subscription OAuth in spawned/hook contexts**: every
  process glosa spawns scrubs it from env; `glosa doctor` warns if set in the user shell.
- **WKWebView/Safari quirks**: v1 targets the cmux browser pane (Chromium). Safari Add-to-Dock
  is a documented nicety, not a tested target.
- **Stop-hook 8-block cap / UserPromptSubmit 30s silent discard**: drains are bounded and reads
  fast by design; delivery correctness never depends on any single hook firing.

## 7. Glossary (for builders without prior context)

- **Artifact**: a document file an agent produces or a human edits (markdown, or self-contained
  rendered HTML). **Workspace**: the directory a project's artifacts live in. **Session**: one
  interactive Claude Code process, identified by its session_id, working in a workspace.
- **Class R / F**: artifact classes — R = markdown glosa renders itself (anchors via stamps);
  F = foreign pre-rendered HTML glosa must not restyle (anchors via sidecar manifest + quotes).
- **Companion topology**: the agent session runs in the user's terminal; glosa observes and
  communicates but never owns or spawns sessions (that is explicitly v2+).
- **jethro**: the user's Claude Code plugin for sermon preparation (repo:
  `/Users/dawid/code/jethro`). It coaches a pastor through a staged pipeline and produces
  numbered stage artifacts (e.g. `04_sermon_brief.md`, `07_manuscript.md`,
  `07b_manuscript_clean.md`) inside a session directory `.claude/sermon-sessions/<session_id>/`
  (session id example: `2026-05-05_j-1,1-18`; artifacts live in its `artifacts/` subdir).
  Session state lives in that directory's `state.json`; fields the glosa adapter reads:
  `current_stage` (string; stage names like `manuscript_writing`), and — on post-#314 sessions
  only — `canonical_manuscript` `{path, sha256, bytes, updated_at, updated_by}` naming the
  authoritative manuscript file. When `canonical_manuscript` is absent (older sessions), the
  adapter falls back to file-precedence: `07b_manuscript_clean.md`, else `07_manuscript.md`.
  Schema authority: the TypeScript types in `/Users/dawid/code/jethro/mcp-server/src/state/`.
- **format-sermon**: a local Claude Code skill on the reference machine
  (`~/.claude/skills/format-sermon/`) that compiles a sermon manuscript (markdown) into
  color-coded speech-notes HTML via an LLM classifier + Python renderer; its output is the
  canonical class-F fixture.
- **cmux**: the user's terminal multiplexer; provides browser panes (where the SPA lives in v1)
  and a CLI that can type into any terminal pane (`cmux send`) — delivery rung 4.
