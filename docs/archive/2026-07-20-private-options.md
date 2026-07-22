# Artifact Loop + Artifact Desk — Final Options Document

**Date**: 2026-07-20
**Status**: decision-ready, final (supersedes the draft). Every consequential claim traces to a verification verdict (appendix, §5) or is explicitly flagged as scout-asserted. Pick an option in §1, adopt the schemas in §2, follow the per-sermon build order in §6.

Pains being solved (from shared context §1):

- **A** — terminal output/UX unfriendly for creative writing
- **B** — no markdown preview/editor for artifacts in the same app as Claude Code
- **C** — manual edits to artifacts invisible to the Claude session
- **D** — speech-notes annotation requires copy-paste back into Claude

Hard constraints: Claude Code **subscription** (not API), single window, must later host non-Claude agent CLIs (Codex, `agy`), Claude Desktop rejected.

---

## 1. Options matrix — v1 shell/architecture

| # | Option | Solves A | Solves B | Solves C | Solves D | Effort (solo + AI) | Key risks | Exit path to standalone shell |
|---|--------|----------|----------|----------|----------|--------------------|-----------|-------------------------------|
| **1** | **cmux + web desk** (as designed): Bun daemon = watcher + inbox + 4-route server; desk in cmux browser split; annotate.js posts annotations; delivery via `cmux send` + hooks | Partial (chat stays TUI; artifacts get real UI) | Yes | Yes | Yes | **4–6 focused days** total (desk-stack scout estimate + spine) — see §6 for the calendar-honest cut | cmux is a single-vendor dependency (no plugin API, but full socket CLI is confirmed [V:6b]); `cmux send` payload sanitization required (\n auto-submits, see §2.4) | Clean: the desk is a plain local web app; the future shell embeds the same pages in its own webview. File bus is agent-agnostic by design |
| **2** | **Desk-less minimal**: no web app. chokidar watcher + shadow-git journal + agentation-mcp channel + hooks only; preview via `brew install mdserve` in a cmux browser pane | No | Partial (mdserve renders md but cannot serve the speech-notes HTML or inject annotate.js — disqualified for pane D per its own docs; scout-asserted, unverified) | Yes | Partial (annotation flows only when a page can reach :4747; no diff pane, no unified UI) | **~1–2 days** | Solves the invisible-edits pain but leaves A/B mostly standing; high chance you build the desk in month 2 anyway | Everything built here (watcher, journal, inbox, hooks) is the spine option 1 also needs — zero throwaway |
| **3** | **Plannotator fork/adopt** (surfaced by verification [V:7a]): backnotprop/plannotator, 7.1k stars, Apache-2.0/MIT, v0.24.1 released 2026-07-20; CC plugin + browser annotation UI over markdown/HTML/diffs, structured accept/deny feedback looped into the live session | No | Partial (renders md/HTML/diffs, its own UI) | No (no human-edit watcher/journal) | Mostly (its core IS annotate→feedback→session) | ~1 day to trial as-is; fork cost unknown (needs a code read) — acceptable only because the verdict is don't-adopt; the code read becomes mandatory if adoption is ever reconsidered | Covers only pains B/D-adjacent; no dictation, no sequential-session parking, no edit journal, no custom speech-notes renderer hosting; feedback path is Claude-plugin-shaped, not agent-agnostic | Weak — you'd be extending someone else's plugin architecture instead of owning the file bus |
| **4** | **Wave Terminal shell**: replace cmux; use Wave's native markdown blocks + `web` widget for the desk pages | Partial | Yes (native md preview) | Yes (same daemon) | Yes (web widget hosts desk pages) | Same daemon work + migration cost from cmux | Custom widgets hard-limited to `term`/`web`/`sysinfo` (CONFIRMED [V:6a-2]); Tsunami framework still "planned"; release cadence slowed (v0.14.5 Apr 2026, ~3 months quiet) | Same as option 1 (desk pages portable) but you bet the shell on a slowing project |
| **5** | **Tabby plugin**: build the desk as an Angular plugin inside Tabby (only maintained terminal with true third-party DOM UI, v1.0.234 May 2026, 117 plugins on npm — CONFIRMED [V:6a-1]) | Yes (one app, native panes) | Yes | Yes | Yes | **1–2 weeks+**: Angular/Electron plugin dev, packaging, and you still build the daemon | Highest effort; Tabby has **no session management — agent ergonomics are chat-panel bolt-ons only** (tabby-ai-agent, tabby-agent-chat/MCP exist; verifier wording); locks UI code to Angular; you lose cmux's agent-oriented CLI (`send`, `read-screen`, browser automation) | Poor — plugin code doesn't port to a standalone shell |
| **6** | **Zed as v1 shell** (listed for completeness): ACP-native via claude-agent-acp, agent-**agnostic** (codex-acp, Gemini ACP-native — satisfies the Codex/`agy` constraint), single window, built-in markdown preview | Yes | Yes (md preview; not the speech-notes HTML pipeline) | Partial (no edit journal; Zed sees the buffer, the bus doesn't exist) | No (no way to inject annotate.js into its preview; no annotation channel) | Adapter config ~0.5 day; but the loop spine still has to be built and has no host | **ACP is exactly the named metered class** (§4) — if Agent SDK credits return, Zed-hosted Claude leaves subscription while the cmux TUI doesn't; annotation and speech-notes hosting are structurally unsolvable inside Zed's preview | Decent for the *shell* (ACP is the multi-agent future) — but nothing of pains C/D gets built by choosing it |
| — | (For honesty) **Claude Desktop**: as of mid-July 2026 it is the ONE shipped app combining session management + markdown preview + highlight-to-edit co-editing (Cowork editor, ~Jul 14–16) + dictation ([V:7d] corrected) | Yes | Yes | Partial | Partial | 0 | Rejected on stated grounds: Claude-only, can't host Codex/`agy` critics, "hard to configure". Listed so the rejection is a known trade, not an oversight | None — vendor shell |

A weaker variant of option 6 — an **Obsidian-plugin desk** (existing Obsidian + MCP assets, jethro's `/sermon-export-obsidian` skill) — was considered and rejected on the same grounds plus plugin-dev tax and no terminal hosting; noted so it too is a trade, not an oversight.

**Verdict**: **Option 1**, with option 2's components built first (they are a strict subset — and §6 marks the point where you *have* option 2 in full and may legitimately stop). Option 3's only role: steal its UX patterns for the annotation review flow; do not adopt (agent-agnostic file bus is the non-negotiable core, and Plannotator lacks dictation, parking, and the edit journal). Options 4–6 are dominated for v1; option 6's ACP shape returns as a *transport* candidate at shell time (§4).

---

## 2. Loop-spine spec

### 2.1 Directory layout (artifact/project-centric — sessions are interchangeable workers)

```
<sermon-session-dir>/            # e.g. ~/.claude/sermon-sessions/2026-07-25_mk-9-33-37/
  artifacts/                     # jethro's numbered stage files (source of truth)
  .desk/
    inbox/                       # one JSON file per pending entry (file bus)
    journal.ndjson               # append-only lifecycle log (schema: §2.7)
    registry.json                # live-session registry
    shadow.git/                  # bare repo, GIT_DIR here, --work-tree=artifacts/ (Cline pattern)
    bin/desk-resolve             # tiny CLI the agent runs to journal applied/rejected (§2.7)
```

Manuscript source of truth: the jethro `canonical_manuscript` pointer when set; else 07b → 07 precedence (local-assets scout; jethro #314). Never guess between 07/07b/07c.

### 2.2 Inbox entry schema (concrete)

One JSON file per entry: `.desk/inbox/<id>.json`. Lifecycle: `pending → delivered → applied | rejected | stale` — every transition is appended to `journal.ndjson` by a defined writer (§2.7).

```json
{
  "id": "inb-20260725-101502-a3f",
  "kind": "human_edit",
  "created_at": "2026-07-25T10:15:02+02:00",
  "status": "pending",
  "artifact": {
    "source_path": "artifacts/07b_manuscript_clean.md",
    "source_sha256": "9f2c…",
    "rendered_path": "output/mk-9-33-37/speech-notes-20260724.html",
    "rendered_sha256": "41ab…",
    "rendered_at": "2026-07-24T21:03:11+02:00"
  },
  "session_hint": "52b17c80-…",
  "payload": { "…kind-specific, see below…": true }
}
```

`session_hint` is a fast-path only — routing resolves file → cwd → live session at **delivery** time (decision §2.4 of context). Parked entries (no live session) are drained by the next SessionStart hook.

**`kind: "human_edit"` payload** — hunk-level, never full file bodies (full-content injection is Claude Code's own documented context-bloat failure mode, issues #4464/#9614 — scout-asserted; bare "file changed" pings are Cursor's documented revert-user-edits failure mode — scout-asserted, edit-awareness scout):

```json
{
  "checkpoint_before": "shadow:8c1d2e…",
  "checkpoint_after": "shadow:b04f91…",
  "files": [
    {
      "path": "artifacts/07b_manuscript_clean.md",
      "diff": "@@ -112,7 +112,9 @@\n-…\n+…",
      "diff_bytes": 812
    }
  ],
  "burst_window_s": 4
}
```

**v1 always inlines the diff** (`diff_bytes` is recorded for observability only). The draft's oversized-burst protocol (`hunks_inline:false`, hunk-headers-only delivery, fetch-full-diff-by-checkpoint-ref) is **deferred to v2** — it is speculative machinery until a real >4 KB editing burst occurs in practice; the checkpoint refs already make it addable without a schema break.

**`kind: "annotation"`** — reserved in the schema, but **v1 annotations do NOT travel through this inbox**. The canonical v1 annotation channel is agentation-mcp (§2.4a, §3); the W3C-shaped payload below is embedded in the agentation record so the same shape survives a later migration to the daemon inbox with no re-anchoring. (annotation-standards scout recommendation; formalizes the decided quote+chunk+hash design in W3C field names):

```json
{
  "body": "Rephrase: too abstract for the congregation — make it a picture.",
  "intent": "rephrase",
  "target": {
    "chunk_id": "chunk-003",
    "quote": { "exact": "królestwo Boże jest jak…", "prefix": "…40 chars before…", "suffix": "…40 chars after…" },
    "position": { "start": 12840, "end": 12911 }
  }
}
```

- `chunk_id` = FragmentSelector: `data-chunk` attribute render.py must start emitting (it has chunk boundaries in manifest.json today; currently only `data-page` exists — local-assets scout). Scopes source-side search to one H2 section.
- `quote` = TextQuoteSelector: the ONLY component that survives both sequential edits and the LLM-classifier hop between source md and rendered HTML (annotation-standards scout). ~40-char context; whitespace-normalized compare.
- `position` = TextPositionSelector into rendered text, **valid only while `rendered_sha256` matches** — the hash turns it into an O(1) exactness proof instead of a silent-drift liability.

**`kind: "dictation"`** — reserved: `{ "transcript": "…", "target": { "chunk_id": "…" } | null }`. **No v1 build step produces this kind — dictation is explicitly deferred** (see the do-NOT-build list, §6). Reason: the capture mechanism is genuinely undecided (macOS system dictation into the chat pane vs Claude's `/voice` — now broadly rolled out with Polish support, per appendix — vs a whisper-based transcriber), and `/voice` may cover the priority-3 interaction mode natively before any custom capture is worth building. The schema slot exists so a later capture path lands as data, not a redesign. Revisit at the post-sermon-4 decision point.

### 2.3 Anchor format — options compared

| Option | Survives sequential edits | Bridges rendered→source | Verdict |
|---|---|---|---|
| **Quote + chunk-id + hash, W3C field names** (above) | Yes — Hypothesis cascade, battle-tested since 2013 | Yes — quote is findable in source despite the classifier hop | **Adopt.** Costs nothing over the ad-hoc format; keeps recogito/Hypothesis tooling adoptable later |
| Pure W3C library adoption (@recogito/text-annotator, v3.4.0 Apr 2026 — scout-asserted version/liveness) | Yes | Yes | Fallback only — annotate.js already implements ~80% of a TextQuoteSelector with a working normalized re-finder; recogito buys UI polish at integration cost |
| CriticMarkup-style inline (`{>>…<<}` in the md) | Travels with file | **No — presupposes the rendered→source mapping it's meant to provide** | **Reject** for storage: pollutes every consumer (segment.py, classifier, render.py, Obsidian export), collides with "agent edits source only", merges annotation and edit channels. Keep as an output vocabulary for agent-*proposed* edits in a diff view |
| OT-style position transformation (Google Docs model) | Only if you own the edit stream | n/a | **Reject** — a file bus never owns the edit stream; Google's own API calls external anchors position-unguaranteed. (One-line answer to "why not track offsets like Docs?") |

**Resolution cascade** at delivery/apply time (Hypothesis pattern + sha256 gate). In v1 the *agent itself* executes this cascade when it drains an annotation (the drain instructions spell it out); a daemon-side pre-resolver is later hardening (§6 step 5):

1. `source_sha256` matches render-time stamp → anchor fresh; resolve quote in source md scoped to the chunk's H2 section; exact match expected.
2. Hash mismatch → same scoped exact-quote search.
3. Miss → normalized/fuzzy search document-wide (diff-match-patch tier — NOT in v1).
4. Still missing → mark entry **`stale`** and surface it. **Never guess** (Hypothesis's orphan rule; verify-after-anchor is mandatory — their backlog #954, scout-asserted).

### 2.4 Delivery mechanisms, ranked

| Rank | Mechanism | Behavior | Caveats (all verified) |
|---|---|---|---|
| 1 | **`cmux send` + `send-key Enter`** into the session's surface | Typed input mid-turn is queued, never lost, never interrupts — injected at the **next step boundary** (tool-call gap / subagent return) or turn end, whichever first ([queuing PARTIAL] — so the model may act on it before the turn ends; that's a feature here) | **Sanitize payloads**: `send` translates literal `\n`/`\r` to Enter (auto-submit) — strip/escape before typing. Key canon, hands-on verified on cmux 0.64.20: `ctrl+c`, NOT tmux-style `C-c` (rejected; ~/CLAUDE.md's cmux section is wrong on this and should be fixed). Queued slash-commands may arrive as raw text (#18399); occasional queued-message-not-actioned reports (#61718) |
| 2 | **Stop hook** (fallback): check inbox at turn end, `{"decision":"block","reason":"…entries…"}` to make Claude continue | Confirmed contract | **Hard cap: 8 consecutive blocks**, then CC force-ends the turn (`stop_hook_active` flags re-entry). A Stop-hook loop cannot run indefinitely — fine for "drain a few entries", not a loop spine. Stop does NOT fire on user interrupt; API errors route to StopFailure (output ignored) — rate-limit death is invisible to it |
| 3 | **UserPromptSubmit hook**: attach pending entries as `additionalContext` (invisible system-reminder) to the next prompt | Confirmed | 30s default timeout (vs 600s elsewhere); a timed-out hook's context is **silently discarded** — keep the inbox read fast |
| 4 | **SessionStart hook**: drain parked entries when a new/resumed session opens; supports `additionalContext`, and in `-p` mode even `initialUserMessage` | Confirmed; this is the sequential-sessions answer | — |
| — | MCP resource-subscription push | — | **Reject**: optional in the protocol, CC support unproven, and mid-turn push isn't how CC consumes context (mcp-observer-server is a 170-line POC; edit-awareness scout) |

Acknowledged gap (unchanged from context): idle session + no cmux. Mitigated by rank 3/4 on next interaction.

Cheap adjacency: register CC's native **FileChanged** hook on artifact files as a zero-daemon journaling path for the in-session case — side-effect-only (cannot inject context), limited matcher syntax; **verify against installed CC 2.1.215 before depending on it** (edit-awareness scout flags this as unverified locally). CC's native "modified by user or linter" system-reminder already covers already-Read files in-session; the desk deduplicates against it rather than double-notifying.

#### 2.4a Annotation channel — ONE canonical path in v1

The draft had annotate.js POSTing to **both** the daemon inbox and the agentation fast path; the same annotation could then arrive twice (once typed via `cmux send`, once via `agentation_get_pending`) with no dedup rule. **Resolved by construction: v1 has exactly one annotation channel — agentation-mcp.** annotate.js POSTs only to :4747; the agent drains via `agentation_get_pending` and closes via `agentation_resolve`/`agentation_dismiss`. The daemon inbox carries `human_edit` entries only. If annotations ever migrate to the daemon inbox (v2, e.g. if agentation hits a wall), the migration *replaces* the channel — dual-write is never a supported state, so no dedup key is needed.

### 2.5 Session registry

`.desk/registry.json`, written by SessionStart / cleaned by SessionEnd hooks (both events CONFIRMED; hook stdin carries `session_id`, `cwd` — CONFIRMED):

```json
{
  "sessions": {
    "52b17c80-59e7-4710-ac01-d18292646dc0": {
      "cwd": "/Users/dawid/code/jethro",
      "cmux_surface": "A5950256-…",
      "registered_at": "2026-07-25T09:00:11+02:00",
      "source": "startup"
    }
  }
}
```

Notes: `CMUX_SURFACE_ID` holds a **UUID**, not the `surface:<n>` short ref — both address forms are accepted by cmux commands (CONFIRMED). SessionEnd has a 1.5s default timeout and cannot block — keep the deregister write trivial. SessionStart matcher distinguishes `startup|resume|clear|compact`; register on all but `compact`.

**Concrete hook wiring** — this goes in the sermon workspace's `.claude/settings.json`; hook syntax errors silently no-op, so paste-adapt rather than retype (Stop and UserPromptSubmit take no matcher; timeouts overridden where the defaults bite):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear",
        "hooks": [ { "type": "command", "command": "bun /Users/dawid/sermons/.desk/bin/hook-session-start.ts" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "bun /Users/dawid/sermons/.desk/bin/hook-session-end.ts", "timeout": 1 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bun /Users/dawid/sermons/.desk/bin/hook-stop.ts", "timeout": 10 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "bun /Users/dawid/sermons/.desk/bin/hook-prompt.ts", "timeout": 10 } ] }
    ]
  }
}
```

Each hook script reads stdin JSON (`session_id`, `cwd`, and for SessionStart the `source`), touches only `.desk/`, and prints the documented JSON response shape (`additionalContext` for SessionStart/UserPromptSubmit, `{"decision":"block","reason":…}` for Stop). Keep every script under ~100ms — the UserPromptSubmit discard-on-timeout is silent.

### 2.6 Git checkpointing strategy

**Shadow repo, Cline pattern** (edit-awareness scout): bare repo at `.desk/shadow.git`, `GIT_DIR=.desk/shadow.git --work-tree=artifacts/`. Never touches jethro's real branches or ref namespace (dura's in-repo `dura/*` branches are the anti-pattern; gitwatch commits to the real branch — both rejected).

- **Checkpoint triggers**: after each watcher quiet-period (debounce ~2–5s, gitwatch's timer-reset shape: one editing burst = one commit); before an agent applies an inbox entry (aider's dirty-commit pattern).
- **Attribution in the commit author field**, aider-style, machine-parseable: `human <desk@local>` vs `session:<id> <desk@local>` → `git log --author` filters provenance for free.
- **Free wins**: downtime catch-up (diff work-tree vs last checkpoint on daemon start — neutralizes @parcel/watcher's getEventsSince advantage), and the diff pane's data (`git diff <ref>..<ref>` piped to diff2html).
- CC's native `/rewind` checkpointing does **not** capture manual edits (per its docs — scout-asserted, not verifier-checked) — the shadow repo is not redundant with it, and `/rewind` can silently roll past human edits it never saw.

### 2.7 journal.ndjson — schema and lifecycle writers

The journal is the append-only audit spine the context requires (decision §2.5: lifecycle transitions journaled **with the applying session id**). One JSON object per line; `O_APPEND` writes of single lines (well under PIPE_BUF) are atomic enough for the write pattern here — one daemon plus occasional one-shot CLI/hook appends.

```json
{"at":"2026-07-25T10:15:02+02:00","entry":"inb-20260725-101502-a3f","event":"pending","by":"watcher","detail":{"kind":"human_edit","files":["artifacts/07b_manuscript_clean.md"]}}
{"at":"2026-07-25T10:16:40+02:00","entry":"inb-20260725-101502-a3f","event":"delivered","by":"daemon","detail":{"via":"cmux_send","session":"52b17c80-…","surface":"A5950256-…"}}
{"at":"2026-07-25T10:18:03+02:00","entry":"inb-20260725-101502-a3f","event":"applied","by":"session:52b17c80-…","detail":{"note":"merged hunk into §3"}}
```

Fields: `at` (ISO-8601), `entry` (inbox id), `event` (`pending|delivered|applied|rejected|stale`), `by` (writer identity: `watcher`, `daemon`, `hook:<name>`, `session:<id>`, `human`), `detail` (event-specific object, may be `{}`).

**Who writes each transition — no transition is writerless:**

| Event | Writer | Mechanism |
|---|---|---|
| `pending` | Whatever creates the inbox file: the watcher (`human_edit`) | Appends in the same operation that writes `.desk/inbox/<id>.json` |
| `delivered` | The deliverer: daemon (after a successful `cmux send`) or the hook script that attached the entry (`hook:user-prompt-submit`, `hook:session-start`, `hook:stop`) | Appends with `via` + resolved `session` — this is where the registry lookup result is recorded |
| `applied` / `rejected` | **The agent**, via `.desk/bin/desk-resolve` | The delivery text embeds the exact command to run after acting, with the session id pre-filled by the deliverer (it just resolved it): `desk-resolve inb-… applied --session 52b17c80-… [--note "…"]`. `desk-resolve` appends the journal line AND rewrites `status` in the inbox JSON — one tool, both writes, so file and journal cannot drift. The agent runs it through its normal Bash tool; no MCP server needed |
| `stale` | The resolver that failed the anchor cascade (§2.3): in v1 the agent (again via `desk-resolve … stale`), later the daemon-side pre-resolver | Same append path |

If an entry is delivered but never resolved (agent forgot, session died), it stays `delivered` in the journal — the next SessionStart drain re-surfaces every non-terminal entry, so the failure mode is a repeat nudge, not silence.

**Annotations (v1)** live entirely in agentation's own store: `agentation_resolve` ≙ applied, `agentation_dismiss` ≙ rejected. They are not double-entered into journal.ndjson in v1 — one channel, one store (§2.4a). When/if annotations migrate to the daemon inbox in v2, they inherit this journal for free.

---

## 3. Reuse-vs-build calls

| Component | Call | Why (one line) |
|---|---|---|
| **agentation-mcp server + MCP tools** (observed at scout time on this machine: server running on :4747 with an empty SQLite store — an ephemeral runtime fact; re-check liveness before sermon #1. Scout-verified only; no verifier covered Agentation) | **REUSE** as the canonical v1 annotation channel (§2.4a): REST POST from any page, `agentation_get_pending`/`resolve`/`watch_annotations` for the agent | Right shape, zero new server code. **Trap to avoid**: it's registered only in leadcue's `.mcp.json` — register it in the sermon workspace's `.mcp.json` (`npx -y agentation-mcp server`) or the tools silently don't bind (same unbound-tool class as jethro #278). Localhost-only → phone annotation deferred (§6 do-NOT-build) |
| **`agentation` React toolbar** (v3.0.2, orphaned in jethro/node_modules) | **AVOID** | React-18 peer dep, no vanilla/UMD build — cannot mount in static speech-notes/desk HTML. That's why it was never wired in |
| **annotate.js** (913 lines, user's own, dependency-free) | **REUSE + EXTEND** (small patch — plan for ~30–90 lines: record reshape to W3C fields + POST; the draft's "~30-line" figure was optimistic once error handling is included, and the step-1 half-day estimate absorbs the difference) | Already has selection popover, quote+prefix/suffix+selector anchoring, normalized re-finder, Preview/Annotate modes. Change: reshape record to the W3C-shaped schema (§2.2) + POST to agentation on :4747. Its header comment is the desk's visual-design charter |
| @recogito/text-annotator | Documented **fallback**, not v1 | Alive per scout (v3.4.0 Apr 2026 — scout-asserted) but restyling cost > the small patch; adopt only if annotate.js's UI hits a wall (e.g. threaded comments) |
| Apache Annotator / annotator.js | **AVOID** | Retired from Apache Incubator Aug 2025, repo archived; annotator.js long dead. Reference code only |
| **Watcher: chokidar v4** | **BUILD ON** | Node default, 1 dependency; `awaitWriteFinish` + atomic-save coalescing handle the editor temp-file+rename storm. watchman = heavyweight daemon to babysit; fswatch = raw events, DIY debounce; @parcel/watcher's only envy-feature (getEventsSince) is covered by shadow-git catch-up |
| **Renderer: markdown-it** + github-markdown-css | **REUSE** | VS Code preview's engine; trivial core rule stamps `data-line`/`data-chunk` attributes (the anchor + scroll-sync substrate); sync render fits a tiny SSE server. remark = AST power the desk doesn't need; marked = documented footguns |
| **Server: Bun.serve, one process, no build step** | **BUILD** (small) | Bun 1.2.7 installed; HTTP+SSE+static in one API; the daemon and desk server are the same process; whole desk stays 3–5 files a future session can hold in context (ADHD-relevant). Rejected: Vite+React (framework tax, zero requirements served), Rust/axum (slowest iteration for a solo dev, nothing perf-bound) |
| **Live reload: idiomorph** (~7 KB) | **REUSE** | Morphs fresh HTML into the live DOM preserving scroll/selection/popovers — a full reload on every save is exactly the ADHD-hostile flow-break the desk exists to kill. Caveat: inner-scroll-container positions need explicit handling |
| **Diff pane: diff2html** | **REUSE** | `git diff` (shadow repo) → GitHub-style HTML; maintained (v3.4.56 — scout-asserted version); zero custom diff UI |
| **render.py** | **EXTEND** (small, deterministic) | Emit `data-chunk="chunk-NNN"` per section from manifest.json headings; currently only `data-page` exists — the decided chunk-id anchor component doesn't exist in the DOM yet |
| mdserve | Interim tool only (`brew install mdserve`) | Built for AI-agent preview but cannot serve arbitrary HTML or inject JS (per its own docs — scout-asserted) — kills the speech-notes and diff panes |
| Plannotator | **STEAL UX patterns** (accept/deny review flow), don't adopt | See §1 option 3 |
| agentapi | **AVOID** as any foundation | Coder's own maintainer: "stopgap… architecture pretty bad" (coder/coder **discussion** #26048); converging on ACP itself |
| Editor widget (v2 only) | CodeMirror 6 + lang-markdown when in-desk editing arrives | Markdown text stays the document (no AST round-trip against agent-edited files); Obsidian/Silverbullet CM6-decoration precedent → Typora-style hybrid later. TipTap = wrong data model; Milkdown only if true WYSIWYG proves necessary |

**The genuinely novel build** (nothing to reuse anywhere, per the edit-awareness survey): the hunk-summary journal for agent consumption. No surveyed tool ships human-edit diffs as agent-consumable summaries — that slot is open and is the defensible core of this loop.

---

## 4. Future-shell transport (condensed — later decision)

| Transport | Shape | Quota status TODAY (verified 2026-07-20) | Call |
|---|---|---|---|
| **Headless stream-json** (`claude -p --output-format stream-json --input-format stream-json`, `--resume`, hidden `--resume-session-at`) | What every serious surveyed wrapper uses (Vibe Kanban's claude.rs confirmed passing exactly these flags, incl. both hidden ones); **no surveyed wrapper PTY-wraps the TUI as primary** (generalization from a 5-codebase scout survey — scout-asserted, unverified beyond those five) | On subscription — Agent SDK credit metering **paused since Jun 15, still paused** (live fetch of support article 15036540). But `claude -p`/SDK/ACP is exactly the named metered class if the rework returns (framed as rework, not cancellation) | Default choice when the shell is built; carry the hedge |
| **ACP-shaped** (claude-agent-acp adapter — renamed from claude-code-acp; protocol now v1.x: crate 1.4.0, schema 1.19.0, Jul 2026; Zed/JetBrains/MS Intelligent Terminal shipping) | Strong momentum, agent-agnostic by design (fits the Codex/`agy` requirement; this is also why Zed appears in §1 as a shell candidate) | Same metered class — Zed's blog named ACP explicitly; post-pause it draws from subscription | The multi-agent future favors ACP; revisit at shell time |
| **PTY + JSONL-tail hybrid** (drive the real TUI, tail `$CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl`) | Structure without headless; transcript updates live (confirmed) | **Unaffected in every scheme announced so far** — interactive terminal usage stayed on subscription in each announced metering scheme to date (Zed's blog documents this workaround explicitly). That is an inductive observation about past schemes, not a guarantee | The hedge. Note: JSONL format documented as internal/version-unstable; and on THIS machine live transcripts are under `~/.ccs/instances/…`, not `~/.claude/` — never hardcode the default root |

Cross-mode resume works both directions but **only by explicit session ID** since v2.1.90 (-p/SDK sessions hidden from the /resume picker), scoped to the starting project dir.

**Mandatory regardless of transport**: scrub `ANTHROPIC_API_KEY` from every spawned child env — the env var silently outranks subscription OAuth in headless runs; #37686 is a $1,800 incident, closed-without-fix, with a duplicate class (#36350, #12352, #34609) and a second ~$1,700 report.

Policy comfort, updated: the Feb 2026 OAuth ban is **superseded in practice** — third-party apps authenticating with a subscription through the Agent SDK are currently sanctioned and draw from subscription limits (May reinstatement + June pause). A local desk spawning the user's own `claude` was never even in the questioned class.

---

## 5. Verified-facts appendix

Legend: **C** = CONFIRMED, **P** = PARTIAL (correction applied above), **R** = REFUTED, **U** = UNVERIFIED.

| Claim | Verdict | Correction / evidence anchor |
|---|---|---|
| cmux `send` types without Enter; `send-key` submits | **P** | True, BUT: `\n`/`\r` in `send` text auto-submit (sanitize); `C-c` rejected — use `ctrl+c` (fix ~/CLAUDE.md's cmux section). Hands-on verified on cmux 0.64.20 |
| `surface:<n>` addressing + CMUX_SURFACE_ID env | **C** | Env var holds UUID form; both forms accepted |
| cmux browser pane scriptable | **C** | navigate/snapshot/click/eval/fill + full RPC surface via `cmux capabilities` |
| Socket API for external daemon | **C** | `env -i cmux ping` → PONG: unauthenticated local callers work today; `cmux events` gives a cursor-based event stream (no polling needed) |
| cmux plugins | **P** | No plugin/extension system anywhere in docs. Extensibility that exists: dock.json, custom sidebars (beta), `cmux hooks` |
| CC queues mid-turn typed input to turn end | **P** | Queued yes, never lost/interrupting — but flushed at the **next step boundary**, not strictly turn end (#49373); slash-commands may arrive as raw text (#18399) |
| SessionStart/SessionEnd/Stop/UserPromptSubmit exist; UserPromptSubmit injects additionalContext; hooks fire in `-p`; stdin has session_id+cwd; config locations | **C** | Docs (mirror 2026-07-19, CLI 2.1.215). UserPromptSubmit: 30s timeout, silent discard on timeout. SessionEnd: 1.5s timeout, can't block. Stop/UserPromptSubmit take no matcher |
| Stop hook block-with-reason | **P** | Contract confirmed; **8-consecutive-block cap**, `stop_hook_active` flag; no fire on user interrupt; API errors → StopFailure (output ignored) |
| Quota: 5h windows + weekly caps; May 6 doubling; shared pool; overflow at API rates | **P** | All holds EXCEPT: +50% weekly promo **extended through Aug 19 2026**, still active — not expired Jul 13. (Fable 5: promo access ended Jul 19; stays on Max at 50% limits; Pro and Team-Standard received a **one-time $100 Fable 5 credit** — relevant if weighing plan tiers) |
| Agent SDK credits announced May 13/14, paused Jun 15, pause still in effect | **C** | Live fetch 2026-07-20 of support article 15036540: pause banner still leads. findskill.ai's "went live Jul 10" claim = uncorroborated noise, contradicted by the official page |
| Feb 2026 OAuth ban; local-spawn safe | **P** | Enforcement actually began Jan 9 (server-side), Feb was the terms clarification, ~Apr 4 the cutoff; **and the regime is superseded** — May 13 reinstated Agent-SDK third-party apps, post-pause they draw from subscription. Conductor is policy-sanctioned, not gray-zone |
| ANTHROPIC_API_KEY outranks OAuth headless (#37686, $1,800) | **C** | Issue closed-without-fix (presume live); recurring class; Conductor docs independently document the precedence |
| CLI flag set incl. --permission-prompt-tool, --resume-session-at | **C** | All 10 exist on 2.1.215; those two are hidden from --help (undocumented surface, may churn) |
| Transcripts at ~/.claude/projects/…, live-updating | **P** | Root is `$CLAUDE_CONFIG_DIR/projects/…`; this machine writes under `~/.ccs/instances/…`. Live update confirmed. Format documented as internal/unstable |
| Vibe Kanban uses the flag set + --resume | **C** | Raw claude.rs fetched; `--mcp-config` specifically NOT confirmed in that file — soften if cited |
| Cross-mode resume (-p ↔ interactive) | **C** | By explicit session ID only since v2.1.90; project-dir-scoped |
| agentapi stopgap; text-only; TUI-chasing | **C** | Cite as coder/coder **discussion** #26048 (not issue); agentapi itself converging on ACP |
| ACP v0.11.0, adopters | **P** | Stale: crate v1.4.0 / schema v1.19.0 (Jul 2026); claude-code-acp renamed **claude-agent-acp** (v0.59.0 Jul 13, active). Zed/JetBrains/MS Intelligent Terminal confirmed. **U**: Neovim/Emacs adoption not independently verified |
| Antigravity `agy` --headless, not in agentapi | **C** | Known defect: headless drops final output when stdout not a TTY (community PTY bridges exist) |
| Terminal survey (Tabby DOM plugins; Wave 3 fixed view types; Warp no ext; Hyper dead; Ghostty no plugin API; Zellij text-grid) | **C** (all six) | Nuances: Ghostty 1.3 shipped preview AppleScript scripting (automation, not UI); WezTerm stable releases stale (Feb 2024), repo alive (nightlies); Tabby "zero agent ergonomics" was slightly overstated — verifier wording is "no session management, chat-panel bolt-ons only" (tabby-ai-agent, tabby-agent-chat/MCP exist), carried into §1 option 5 |
| OpenMarkdown | **C** | "Section-scoped read/write" specifically **U** — integration verified as file-level + selection-level |
| Proof / Nimbalyst | **C** | As described |
| Claude Desktop rebuilt Apr 14; Cowork; /voice 5% | **P** | Cowork launched **Jan 13 2026** (not ~Jul 2; Jul 7 = web/mobile expansion); as of ~Jul 14–16 Cowork HAS a live co-editing document editor with highlight-to-edit + dictation; /voice is now broadly documented (hold/tap, VS Code ext, **Polish supported**) — not a 5% experiment |
| [V:7a] "no shipped product combines all four" | **P** | Restated: no **third-party/agent-agnostic** product combines all four; Anthropic's own Desktop now does; Plannotator covers preview+annotation+feedback-to-session (no dictation/session mgmt). Discovery: Plannotator is the nearest prior art to this plan |
| Researcher's "70–80% probability metering returns within 12 months" | **U** | Unfalsifiable estimate, not a fact. "IPO optics" attribution: no source found |
| CC FileChanged hook fires on this machine's CC version | **U** | Documented in current docs; verify locally before depending on it (side-effect-only either way) |
| Agent halt-obedience, misc jethro internals | n/a | Out of scope for this doc |

**Scout-asserted, never verifier-checked (treat all as U)** — these appear above/inline as supporting evidence and none was covered by any verifier's scope: CC context-bloat issues #4464/#9614; Cursor's revert-user-edits failure mode; Hypothesis backlog #954 (verify-after-anchor); "/rewind does not capture manual edits" (docs claim); mdserve disqualified-for-pane-D by its own docs; @recogito/text-annotator v3.4.0; diff2html v3.4.56; the "no surveyed wrapper PTY-wraps the TUI as primary" generalization (§4 — survey of 5 codebases, not the field); everything about Agentation (§3 — scout inspection only, and its runtime state is ephemeral). None is load-bearing for the §1 verdict; several are load-bearing for §2/§3 component picks, so if one falls, swap the component, not the architecture.

Nothing was outright **REFUTED**; the closest was the promo-expiry date (wrong by two extensions) and the Cowork characterization (stale by ~6 months of product movement).

---

## 6. Recommendation + build order

**Build option 1, in option-2-first order — cut per sermon, not per focused day.**

The honest calendar math first: total effort is **4–6 focused days**, but at the realistic budget of a few hours per week that is **6–12 calendar weeks** — which would blow straight past the success window (next 3–4 sermons ≈ 3–4 weeks, preaching weekly). So the recommendation is only executable as a **per-sermon milestone cut**: each week ships the smallest slice that changes the next sermon's prep, highest-sting pain first. The draft's order — two days of invisible infrastructure before any visible payoff — was the ADHD abandonment-curve worst case; this order inverts it.

| Milestone | Ship before | What | Pain hit | Focused effort |
|---|---|---|---|---|
| **1 — Kill the copy-paste** | **Sermon #1 (this week)** | The §3 fast path, no daemon needed: (a) register agentation-mcp in the sermon workspace `.mcp.json` (`npx -y agentation-mcp server`) and confirm the tools bind; (b) patch annotate.js to POST the W3C-shaped record (§2.2) to :4747; (c) add a drain instruction to the session prompt/skill: `agentation_get_pending` → apply per cascade §2.3 → `resolve`/`dismiss` | **D — the weekly sting, dead first** | ~0.5 day |
| **2 — Edits become visible** | Sermon #2 | Spine skeleton: chokidar-v4 watcher (awaitWriteFinish, 2–5s debounce) → shadow-git checkpoints (`.desk/shadow.git`, author-field attribution) → inbox `human_edit` entries (inline diffs, §2.2) + journal.ndjson appends (§2.7) + `desk-resolve` CLI | C (capture) | ~1 day |
| **3 — Edits reach the session** | Sermon #2–3 | Hooks + registry + delivery: paste-adapt the settings.json block (§2.5); SessionStart register/drain, SessionEnd deregister, Stop-hook drain (≤8 blocks — a drain, not a loop), UserPromptSubmit attach; daemon → `cmux send` with payload sanitization (strip `\n\r`), `ctrl+c` canon, `send-key Enter`, hook fallback when no surface. Scrub ANTHROPIC_API_KEY from anything the daemon spawns. Fix the `C-c` line in ~/CLAUDE.md | C (delivery) | ~1 day |
| — | | **⛳ Legitimate stop point: you now have option 2 in full.** Pains C and D are solved end-to-end with no web app. **Stopping here is a win, not a failure** — everything below is additive and nothing above gets thrown away | | |
| **4a — First desk pane** | Sermon #3 | Markdown pane in a cmux browser split: markdown-it render with `data-line`/`data-chunk` stamping + SSE + idiomorph morphing. One Bun process = daemon + desk server; 3–5 files, no build step. This is the visible v1 win — ship it alone | B (core) | ~0.5–1 day |
| **4b/4c — Full desk** | Sermon #4 | Speech-notes HTML passthrough with annotate.js injected (render.py emits `data-chunk`); diff2html pane over shadow-git diffs | A, B (complete) | ~1 day |
| **5 — Hardening (post-window)** | After sermon #4, only if cycles demand it | Daemon-side scoped quote pre-resolver with `stale` verdict (until then the agent runs cascade §2.3 itself); fuzzy tier (diff-match-patch) only if real orphans occur | D robustness | ~0.5–1 day |

If a week's budget collapses, the milestone slips to the next sermon — **scope never grows to catch up**. Milestones 1 and 4a are the two motivation anchors: each ends with something you see working during actual sermon prep.

**Do NOT build** (explicit): the general writing-first GUI (deferred per decision §2.6 — and Cowork's July editor shows Anthropic sprinting into that space, strengthening the deferral); **dictation capture** (schema slot reserved, §2.2 — deferred because the capture mechanism is undecided and `/voice` with Polish support may cover it natively; decide after sermon 4); **the phone/offline annotation fallback** (localStorage+clipboard, and any Pages Function relay — mobile is constraint-listed as secondary-future; build nothing for it in v1); the oversized-diff fetch-by-ref protocol (§2.2 — v2, on first real >4 KB burst); a second annotation channel or any dual-write (§2.4a); in-desk editing (v2: CodeMirror 6); any agentapi/PTY wrapping; MCP push channels; recogito adoption; a fuzzy re-anchor tier before orphans actually occur.

**Success test** stands: 3–4 sermons prepped with no artifact chaos, no lost edits, no copy-paste. Decision point on the standalone shell comes after that — with §4's transport table waiting.

---

## 7. Addendum (2026-07-20, post-source-read): Plannotator revision to Milestone 1

The §1 option-3 row flagged "fork cost unknown (needs a code read)." The code read happened (full source analysis, ~160k LOC reviewed at architecture level). Corrections and one milestone change:

**How it actually works** (relevant facts): no MCP anywhere. It is a Bun-compiled CLI binary; per-agent adapters (Claude Code hook + skills, Codex, Gemini, OpenCode/Pi in-process plugins, Copilot, VS Code ext). For Claude Code, plan review is a `PermissionRequest` hook on `ExitPlanMode` with a 4-day timeout — the hook process embeds a `Bun.serve()` server, opens the browser, and **blocks the session** until the human decides; the decision returns as hook stdout JSON (`behavior:"allow"` with an `updatedInput` echo, or `deny` with feedback markdown). Annotate mode's `--hook` contract: empty stdout = pass, `{"decision":"block","reason":"<feedback md>"}` = feedback. Storage is flat files under `~/.plannotator/` (per-decision snapshots + deduped `NNN.md` version history). Session binding is purely OS process inheritance — no session IDs, no envelope, no redelivery.

**Milestone-1 change — SUPERSEDED (see the plan-philosophy amendment before §11.3): the pastor rejected any live Plannotator trial; Plannotator remains steal-list-only.** Original text kept for the record: `plannotator annotate <path>` accepts **arbitrary** md/html/txt/URLs/folders on demand — and renders custom HTML verbatim in an iframe with its own CSS/JS intact via a rendering-neutral srcdoc bridge, with drag-select and pinpoint-element annotation on top. That is the speech-notes page, working today, zero code. Feedback templates are per-runtime overridable (can speak Polish). Therefore: **trial Plannotator as Milestone 1 for sermon #1** (`PLANNOTATOR_SHARE=disabled`, `/plannotator-annotate output/<slug>/speech-notes-*.html`, or the PostToolUse-on-Write hook recipe for agent-produced artifacts) **before** patching annotate.js. If the synchronous-gate UX fits sermon rhythm, Milestone 1 costs ~zero; the annotate.js+agentation path remains the fallback if blocking-the-session reviews feel wrong. Milestones 2–5 are unaffected either way — Plannotator structurally cannot do the async half (durable inbox, session routing, parked delivery, edit journal): identity and delivery are borrowed from the process tree, feedback-in-flight does not survive the process.

**Privacy note for sermon content**: the default Share button encodes the ENTIRE document into a `share.plannotator.ai/#<blob>` URL fragment (the document *is* the URL — pasteable into Slack/scrollback by accident), and remote/SSH sessions auto-generate share links when sharing is enabled. Set `PLANNOTATOR_SHARE=disabled` (env or `~/.plannotator/config.json`) before first use.

**Mode anatomy (second-pass source read)**: plan review and code review are **two separate React apps with separate document models** (block-parsed prose in `packages/editor` vs `@pierre/diffs` patch viewer in `packages/review-editor`) over a shared substrate (port allocation, drafts, external-annotations bus, `packages/ui` primitives). Annotate mode — the one that matters for manuscripts — is literally the plan-review app with the ExitPlanMode coupling removed (~100 lines at the CLI boundary), fed from a file/URL/folder: the least trigger-coupled path in the system. Two capability notes for the trial: (1) plan/annotate mode has **no suggested-replacement annotation type** — that exists only in code review (`suggestion` with `suggestedCode`); "propose replacement wording" feedback would be fork-level, so in the trial such feedback must travel as plain comments; (2) plan mode supports direct in-UI text editing (`directEdits.ts`) — annotate mode's `/api/source/save` direct-save is the equivalent seam, but it bypasses the agent entirely (the watcher/journal of milestone 2 is what would catch those edits).

**Steal list (for milestones 2–4), confirmed at file level**: `packages/server/external-annotations.ts` (~700-line HTTP+SSE inbound annotation bus — closest prior art to our daemon inbox); `packages/ui/components/html-viewer/{srcdoc,bridge-script}.ts` (iframe bridge: quote-based find-and-mark re-anchoring, pinpoint selection, `--pn-*` token discipline); `packages/ui/utils/parser.ts` `exportAnnotations` (quote + line-label feedback format agents demonstrably act on); `packages/shared/storage.ts` + `server/sessions.ts` (flat-file version journal + pid-registry with `kill(0)` liveness); the `emitAnnotateOutcome` stdout matrix as hook-contract reference. Fork verdict unchanged: don't — Bun lock-in, 160k LOC monorepo, and the async inversion would be "a different program wearing Plannotator's UI."

---

## 8. Addendum 2 (2026-07-20, evening): Channels supersede `cmux send` as primary delivery — §2.4 re-ranked

Post-publication research (official docs + source dissection of the installed Telegram channel plugin + strings of the CC 2.1.215 binary) found that **Claude Code has an official inbound-push mechanism: Channels** (research preview, v2.1.80; docs at code.claude.com/docs/en/channels). Mechanics: a stdio MCP server declaring `capabilities.experimental['claude/channel']` sends the MCP notification `notifications/claude/channel` `{content, meta}`; CC wraps it as a `<channel source=… meta-attrs…>` prompt, **starts a turn in an idle session** (true push — the stdio read event is the wakeup), and queues to the next turn boundary when busy. Enabled per session via `claude --channels plugin:<name>`; custom plugins need `--dangerously-load-development-channels` during the preview (Anthropic-curated allowlist otherwise). A permission relay (`claude/channel/permission`) even supports remote tool-approval verdicts.

**Revised §2.4 ranking**:

| Rank | Mechanism | Status |
|---|---|---|
| 1 | **Channel plugin**: the desk ships a tiny stdio MCP channel server per session that bridges daemon→session (watches `.desk/inbox/` or connects to the daemon's socket, forwards entries as channel notifications) | Official (preview); wakes idle sessions; the constraint is that the pusher must be the session-owned MCP server process, so the daemon never pushes directly — each session's bridge instance does. Dev-flag friction until allowlisted; silent drop if `--channels` not passed → journal `delivered` only on a subsequent ack tool-call, else hooks re-surface |
| 2 | **`asyncRewake` hook** (official, no preview flag): a SessionStart-launched watcher process exits code 2 when the inbox gains entries → CC wakes with stderr payload as a system reminder | Official; per-session watcher respawn per wake; good fallback where channels are unavailable |
| 3 | Hooks-on-boundary (Stop/UserPromptSubmit/SessionStart drains) | Unchanged — passive complement, parked-entry drain |
| 4 | `cmux send` typing | **Demoted from rank 1 to universal fallback** — still the only mechanism that works for non-Claude agents (Codex/`agy` panes) and needs no launch flag; keep the payload-sanitization rules |

Two more inventory updates from the same research: the hook surface roughly tripled by 2.1.x (notably `FileChanged` + SessionStart `watchPaths` — side-effect-only but may thin the watcher's in-session duties; `PostToolBatch`; `Elicitation`/`ElicitationResult`), and **MCP elicitation with URL mode** (v2.1.76) is now a documented alternative for form/URL review gates owned by an MCP tool. Verdict A from the research stands: **Plannotator's blocking-hook-stdout remains state of the art for lifecycle-position gates** — elicitation and the channel permission relay complement it for tool-shaped approvals; nothing supersedes it. Milestone-3 build note: implement the channel bridge + asyncRewake variant behind the same daemon interface as the `cmux send` path, and A/B them during sermon #2 — the file bus and journal are identical in all cases, so this is a transport swap, not a redesign.

---

## 9. Addendum 3 (2026-07-20): speech-notes anchoring — pipeline verified, §2.3 finalized for compiled artifacts

Source-level verification of `~/.claude/skills/format-sermon/` against a real run (`output/po-co-to-wszystko/`, 2026-07-19, matched to its source manuscript by SHA256) settles the "does the quote survive the classifier hop" assumption. **Verdict: the speech-notes HTML is a hybrid artifact.**

- **Body paragraph prose is verbatim** — both prompts forbid word changes and the real run confirms word-for-word fidelity (even a source typo survives). Quote→source search works today for content annotations, which is the dominant annotation class.
- **Structural/delivery elements are transformed or synthesized**: headings condensed (time budgets dropped), `*[pauza 3 sek]*`-style cues rewritten, some metadata dropped, and **H4 navigation labels are LLM-invented with no source counterpart**. Quotes from these elements do NOT exist in source — and correctly so.
- The fidelity split aligns with the `intent` taxonomy: content annotations land on verbatim prose (mappable); annotations on transformed/synthesized elements are classification/style feedback that should route to pipeline decisions, not source edits. **v1 drain rule**: quote found verbatim in source → content edit; quote not found → classify as classification/style, surface to the pastor/agent as pipeline feedback — never guess a source edit (the §2.3 stale rule, now with a defined non-content branch).
- **Reconciler is NOT a fidelity check** — it never sees the source; it only smooths marker consistency across chunk borders. Do not cite it as a verbatim guarantee.

**Pipeline facts that bound the design**: `manifest.json` records chunk order/headings/word-counts only — no source positions, no hash (source sha256 lives in a `*.md.sha256` sidecar used for skip-if-unchanged caching). Chunk identity **dies at reconciliation** — the HTML has only `data-page` and zero ids. Segmentation (`segment.py`) is deterministic regex over H2/H3; the rendered element stream is LLM-dependent across runs (but the hash cache masks re-runs of unchanged sources). `annotate.js` already captures quote + prefix/suffix + DOM anchors + a freeform `rephrase` — no chunk/source refs; export is clipboard-only; storage is per-origin localStorage (annotations on the deployed URL and on `file://` are separate stores — the desk serving locally unifies this).

**Milestone-4b pipeline upgrade (mechanical, two changes)** for deterministic mapping even on transformed elements:
1. `segment.py`: record `source_start_line`/`source_end_line` per chunk (switch `re.split` to `finditer` — positions are currently discarded) and move `source_sha256` into the manifest.
2. Thread chunk identity to the DOM: chunk files keep identity until reconciliation — insert `@@CHUNK(NNN)@@` markers at concatenation, teach the reconciler prompt + `normalize.py` to preserve them, and have `render.py` translate them to `data-chunk` attributes. Then annotation → `data-chunk` → manifest → source lines resolves without any text search, including for invented H4s (they inherit their chunk's source range).

**v2 hardening (build on first real recurrence, not before)**: a classification-overrides sidecar consumed by the classifier prompt, so pastor corrections to LLM decisions (wrong type/split/invented label) survive a re-classification after the source changes — today they'd silently evaporate, partially masked by the hash cache.

**Incidental findings**: (1) `render.py` title bug — the `<title>` gets clobbered by the last H2 (variable reuse at line ~143 vs `HTML_HEAD.format` after the loop); trivial fix. (2) **Phase 4 deploys the speech notes to public Cloudflare Pages** (`npx wrangler pages deploy`, project `sermon-notes`) — sermon HTML is publicly hosted; annotations never leave the browser, but the manuscript content does. Worth an explicit decision (password/Access, or desk-local hosting replacing the deploy) once the desk exists.

---

## 10. The full solution: one annotation contract, N viewers (the section this document was missing)

Everything above describes components; this section states the end-state architecture that makes them one product rather than a pile of workarounds — and it exists because annotating desk-rendered markdown and annotating a self-contained HTML document are **different problems that must produce identical output**.

### 10.1 Artifact-class census across the pipeline

| Pipeline phase artifact | Format | Viewer class |
|---|---|---|
| Study notes, exegetical briefs, sermon brief (stages 1–6) | markdown | **R** (desk-rendered) |
| Manuscript 07 / 07b / 07c | markdown | **R** |
| Review reports, retro analyses, transcripts, slides brief | markdown | **R** |
| **Speech notes** (format-sermon) | self-contained HTML + own CSS/JS | **F** (foreign HTML) |
| Human-edit diffs (shadow-git) | diff | **D** (desk-generated diff view) |

~90% of phases are class R; speech notes are the one class-F artifact today — but class F is what makes the desk *general* (any future compiled/exported artifact — slides HTML, PDF-adjacent exports, other people's pipelines — lands there).

### 10.2 The contract (identical across viewers)

One annotation record (§2.2 W3C shape: quote + prefix/suffix + position + structural anchor + `{path, sha256}` doc identity + intent + body), one capture→channel flow (§2.4a), one resolution interface: `resolve(annotation, doc) → source_range | pipeline_feedback | stale`. What differs per class is only the **resolver implementation**:

- **Class R**: identity-plus-stamps — the desk rendered the DOM itself and stamped `data-line`/`data-chunk` during markdown-it rendering, so view→source is a lookup it fabricated. Trivial and exact.
- **Class F**: sidecar source map — the desk did NOT render the DOM and cannot stamp it; provenance must come from the producing pipeline (§9: manifest source ranges + `data-chunk` threading), with quote-search + the verbatim/transformed intent split as the fallback tier.
- **Class D**: file+line from the hunk header. Exact by construction.

### 10.3 The two viewers are genuinely different machinery

| Concern | Class R viewer (markdown) | Class F viewer (foreign HTML) |
|---|---|---|
| DOM ownership | Desk's own page; desk CSS applies | **Sandboxed iframe** (served locally); document's CSS/JS run untouched; desk styles must not leak in either direction |
| Annotation capture | Selection API directly in-page | **Injected bridge script** speaking postMessage to the shell (selection events in, find-and-mark/scroll commands out) — Plannotator's `srcdoc.ts`/`bridge-script.ts` is the validated reference design |
| Annotation UI (popover, list, submit) | Desk shell components, used directly | **Same shell components** — the bridge stays minimal (capture + marking only) so the UI is written once |
| Anchoring | Desk-stamped `data-line` | Document-provided `data-chunk` (needs §9 pipeline work) + quote anchors |
| Live update after re-render | idiomorph morph, scroll/selection preserved | iframe swap + bridge re-marks surviving annotations by quote |
| Script coexistence | n/a | Desk-injected bridge **replaces** build-time annotate.js when viewing through the desk; the pipeline's embedded copy remains for standalone/deployed viewing only — one annotation system per context, never two at once |

### 10.4 What this resolves strategically

This is the concrete answer to the session's opening question (jethro-specific vs general): the **general core** is the shell + class-R/F/D viewers + annotation bus + the resolver *interface*; the **jethro-specific part** is resolver implementations and artifact-class metadata (which file is which class, where its manifest lives, what the canonical source is — the `canonical_manuscript` pointer already answers that for manuscripts). Packaging boundary: the desk never contains sermon knowledge; jethro (or any other pipeline) registers `{path_pattern → class, source_map_locator}`. That is what would later generalize to "other people's writing pipelines" without a rewrite — and what tila would eventually host the state plane for (§ tila decision, memory).

### 10.5 Scaffolding vs. product — stated plainly

Plannotator (§7) and the bare agentation channel (§3) are **scaffolding**: they validate loop semantics and carry sermons while the desk grows, and their role ends when the class-R and class-F viewers exist. They are not the packaged solution, and milestone 1 should be read as "de-risk the loop," not "ship the product." The milestone sequence in §6 is unchanged but re-labeled in these terms: M2–M3 build the bus (class-independent), M4a builds the class-R viewer, M4b builds the class-F viewer + the §9 pipeline provenance, M5 hardens resolution. Full solution = shell + both viewers + bus + resolvers, per this section.

---

## 11. Distribution topologies: where the desk is served from (hosted shell, pretty URLs, GDPR)

The question "could the desk be a hosted, stateless cloud app?" decomposes into three transports — document→browser, browser-app itself, annotations→local session — and the key architectural fact: **the cloud never needs to reach localhost; the page running in the user's browser bridges both worlds.** Blocking/unblocking is untouched in every topology below: the wait is always between the local hook process and Claude Code; the daemon resolves it when a decision *arrives*, wherever it came from.

| Layer | Topology | Content path | When |
|---|---|---|---|
| **L0** | Desk in a cmux browser pane | all local | v1 — URL chrome is invisible anyway; the "ugly localhost" problem doesn't exist here |
| **L1** | Pretty local URL, zero cloud: daemon binds port 80 (macOS allows non-root <1024 binds since 10.14) → `http://desk.localhost` (`*.localhost` resolves to loopback in modern browsers, no /etc/hosts) | all local | Whenever standalone-browser use starts; ~an hour of work |
| **L2** | **Hosted static shell + browser→localhost bridge**: `https://desk.<domain>` serves ONLY the SPA assets (CDN, versioned); the page then `fetch()`es documents from `http://127.0.0.1:<port>` and POSTs annotations/decisions back to it. URL carries a document *reference* (path/hash), never content | **Content never leaves the machine.** Stateless in the strongest sense — not "state in URL" but "no content transport at all" | The real answer to "semi-technical users shouldn't see localhost." Same SPA as L0/L1 (data client switches same-origin ↔ 127.0.0.1 bridge) |
| **L3** | Remote annotators without a local stack: relay required, because only now does content leave the machine. Options: (a) E2EE paste + daemon polling (Plannotator paste-service pattern — key in URL fragment, server sees ciphertext, TTL); (b) **tila as the relay** — annotation lands as a tila signal, the author's daemon drains its own tila inbox (outbound-only, self-hosted on the author's Cloudflare account → author is their own controller); (c) fragment-URL offline round-trip (Plannotator portal pattern) as the zero-infra fallback with manual re-import | E2EE or self-hosted; metadata only at any shared host | Deferred — this is the multi-user product step, and tila-as-relay is the §-tila v2 story arriving on schedule, not early |

**Blocking with a hosted shell (L2)**, concretely: hook fires → local process starts its wait exactly as Plannotator does → user's browser shows `https://desk.<domain>/review/<doc-hash>` → page fetches the doc from the local daemon → user decides → page POSTs to `127.0.0.1` → daemon resolves the wait → stdout → session unblocks. The cloud host served static files and nothing else. For L3 the only change: the decision reaches the daemon via its own *outbound* subscription (poll/WS to relay or tila) — inbound-to-localhost never happens anywhere.

**"Everything in URL params" verdict**: wrong primary mechanism, right fallback. With a local daemon, content-in-URL is unnecessary (L2 carries a reference); without one (L3c) it works but the URL *is* the document — a leak vector for anything pasted into chat/logs, acceptable only for deliberate one-shot shares. Also note browser-practical fragment limits (~tens of KB compressed is fine; a full manuscript fits but it's clunky).

**GDPR**: L0–L2 = the host processes no content; obligations shrink to log minimization + a privacy notice (IPs are personal data). L3 with E2EE = still "processing" in transit; needs DPA-grade terms, TTL, EU region — or self-hosting (tila model), which moves controllership to each author. **One domain-specific sharpener: sermon manuscripts can contain pastoral anecdotes about identifiable congregants in a religious context — GDPR Art. 9 special-category territory.** That is the strongest argument for L2's "content never leaves the machine" as the default posture and self-hosted relays for L3, and it should be stated in any future product docs.

**Pre-build verification for L2 (the one open platform question)**: the https-page→http-localhost fetch is exempt from mixed-content blocking (localhost is a "potentially trustworthy origin" per the secure-contexts spec) but subject to CORS (daemon sets headers — trivial) and Chrome's Private/Local Network Access controls, which by mid-2026 are believed to surface a one-time permission prompt ("allow this site to access your local network?"); Safari has OS-level local-network prompts. **Verify current Chrome/Safari enforcement UX before building L2** — it changes onboarding copy (one prompt to explain), not feasibility. Design hedge either way: ship the SPA with a service worker so the shell is cached offline and the app degrades to L1 if the CDN is unreachable.

### 11.1 The shell↔daemon contract: pairing, handshake, version skew

Threat model first. (1) A visitor without a daemon is a UX case, not a security case — handshake fails, show a friendly screen. (2) The real attack surface is **any other website in the user's browser** doing drive-by `fetch`es at `127.0.0.1` (including via DNS rebinding): the daemon holds manuscript content and accepts gate/annotation POSTs that ultimately steer an agent session — prompt-injection-by-HTTP. (3) A compromised CDN shell is the residual risk (it legitimately holds the credential); versioned deploys + capability-scoped endpoints bound it, and at L0/L1 the shell is served locally so the exposure is L2-only.

The contract (Jupyter-token lineage — the decades-proven local-daemon pattern — updated to 2026 hygiene):

- **Bind + reject first**: daemon binds `127.0.0.1` only; every request server-side-validates `Origin` against an allowlist (`https://desk.<domain>`, `http://desk.localhost`, the daemon's own origin) and the `Host` header (kills DNS rebinding, since a rebound request carries the attacker's Origin). No cookies anywhere → CSRF is structurally dead; PNA/LNA preflights add a Chromium-level gate for free. Origin-gating even the ping endpoint prevents a "does this user run the desk?" fingerprinting oracle for arbitrary sites.
- **Pairing**: daemon generates a 128-bit token once (`~/.desk/token`, 0600). `desk open` launches the browser at `https://desk.<domain>/#t=<token>` — the fragment never reaches the CDN in any HTTP request; the page stores it (per-origin localStorage) and sends it thereafter as `Authorization: Bearer`. Re-pairing = run `desk open` again. Fallback for typed-URL visits: a 6-digit pairing code shown by CLI, entered in the page (device-code style).
- **Handshake**: page → `GET /api/handshake` (token + Origin) → `{contract_version, daemon_version, capabilities, workspace}`. The **contract is semver'd**: the auto-updating cloud shell must tolerate N older daemon contract versions and refuse forward-incompatible ones. Three distinct failure screens, which ARE the semi-technical onboarding surface: **no daemon** ("desk isn't running — start it / install"), **unpaired** ("run `desk open` in your terminal"), **contract mismatch** ("update your desk: `brew upgrade …`"). Show error, never a degraded half-working UI — exactly the fail-loud posture the rest of this document uses.
- **Capability scoping**: read endpoints (document fetch, SSE) and write endpoints (annotations) are separate token scopes from **decision endpoints** (gate approve/deny — the agent-steering ones); v1 can ship one token but the route split exists from day one so scoping is additive.

**Build-order impact (revised from "none")**: the Origin/Host validation + bearer-token check + `/api/handshake` (~50 lines total) go into the **milestone-4a Bun server from day one** — the same auth layer protects the daemon in every topology (other local websites can probe `127.0.0.1` regardless of where the desk UI is served from), and retrofitting auth onto a live API is exactly the kind of migration v1 should never need.

### 11.2 The return-path ladder: what "sending back to the agent" means per host

The return path is not binary (push vs copy-paste); it degrades along a ladder, and each rung is chosen by what the user's agent host supports — the desk works at every rung with the SAME annotation records:

| Rung | Mechanism | Requires | Hosts served |
|---|---|---|---|
| 1. Push | Channels / cmux nudge / asyncRewake (§8) | Our process + Claude Code | CC terminal/cmux |
| 2. Blocking gate | Hook-stdout wait (§7) | Hook support | Claude Code |
| 3. **Pull** | **MCP tool** (`annotations_pending`, `annotations_resolve`) — agent fetches when instructed or at workflow points | An MCP host, nothing else | **Claude Desktop, claude.ai (remote connector), Cursor, Codex, Gemini — anything speaking MCP** |
| 4. Manual | Export markdown / fragment-URL / clipboard | Nothing | Everything, forever |

**The packaging move that makes rung 3 cheap: ship the daemon AS an MCP server.** One binary, three faces: (a) MCP stdio interface (tools for pull + resolution), (b) the localhost HTTP endpoint the desk page bridges to (§11.1), (c) the file bus + watcher. A Claude Desktop user "installs a server" the only way they know how — adding an MCP entry — and the host app spawns and supervises the process for them; the objection "the server is required" becomes true-but-invisible: zero separate ops, no terminal. The desk page's handshake finds the same process regardless of who spawned it. (Precedent: agentation-mcp is already this shape — MCP face + HTTP listener on :4747; the desk daemon generalizes it.) Claude Code users get rungs 1–2 *in addition*, from the same binary.

**Honest ceiling, stated**: pushing into Claude Desktop is not possible today — channels are Claude-Code-only — so rung 3 is pull-only: the agent sees annotations when it's told to look ("apply my review") or when a skill/system-prompt instructs checking at natural workflow points. That is a real UX difference from rung 1, not a bug to engineer around; document it per-host rather than promising push everywhere.

**Zero-local persona** (nothing installable, e.g. iPad + claude.ai only): the meeting point must be shared state — a **remote MCP connector** backed by cloud storage the desk also writes to. That necessarily abandons both E2EE (the MCP endpoint must serve plaintext to the agent) and the content-never-leaves posture → it's a consent-gated mode, and the GDPR-clean version is **self-hosted tila** (which already ships an MCP server with signals-inbox tools — the agent drains annotations from the author's own tila; §L3b arrives with its return path built in).

**Does rung 4 contradict the non-URL-param decision? No — it demotes it.** Content-in-URL/export is the *manual* rung only: always available, never the architecture. Rungs 1–3 carry references over authenticated channels; rung 4 exists so no user is ever stranded (and it's the answer to "share this one review with someone who has nothing").

### Amendment (late addition, sits between §11.2 and §11.3): effort recalibration + the conversation surface (pain A, addressed properly)

**Effort recalibration**: §6's per-sermon pacing assumed solo hand-building. With multiple Max subscriptions and the kombajn autonomous pipeline, the build clock compresses to **1–2 autonomous epic runs (days of wall-clock)** for M1–M4b; the human costs that remain are UX judgment calls, review, and the one thing no pipeline compresses — **living with it through real sermon weeks**. So the re-cut is: build fast (epic), validate on the sermon cadence (unchanged), keep §6's milestone *boundaries* as the epic's task decomposition and its stop-point semantics. Blocking decision before any epic starts: **this is not jethro code — it needs its own repo and name** (jethro consumes it, like CoA).

**Plan philosophy (user decision, final): no experiments during sermon week.** Sermon prep is production, not a testing ground — the goal is maximum preparedness for the next sermon, not minimal-viable iteration on the way. Consequences: (1) the §7 Plannotator trial as Milestone 1 is **rejected** — Plannotator is steal-list inspiration only, never installed into the sermon workflow; (2) the per-sermon milestone pacing becomes an epic **task decomposition**, with the FULL v1 (bus + delivery + all viewers incl. conversation pane) built and hardened by autonomous pipeline BEFORE the next sermon; (3) validation happens **offline, by rehearsal**: run the complete loop against a *copy* of a past sermon's artifacts (e.g. the `po-co-to-wszystko` run already on disk) — annotate the real speech-notes HTML, verify quote→manuscript resolution, apply edits, re-render, check delivery/journal — plus the pipeline's normal E2E tests. The desk enters real sermon week only after a full dry-run passes. The §6 "stop point" logic (built for solo hand-building) no longer gates scope; it survives only as the epic's task ordering.

**The conversation surface (pain A)**: the desk as specced fixes artifact viewing but leaves the *coaching dialogue itself* — jethro's actual work, long-form Polish Socratic exchange — in raw terminal rendering. Two-tier answer:

- **Today, zero build**: a cmux/Ghostty "writing profile" for the sermon workspace (larger font, generous line height, warm theme, narrower measure) + a jethro register instruction (coaching turns in short paragraphs, no headers/tables/bullets mid-dialogue). Real but bounded relief.
- **The proper fix — a Class T viewer (amends §10.1's census): the live conversation is just another artifact.** The desk tails the session's transcript JSONL (live-updating, path via registry → `$CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl`) and renders the dialogue with real typography — reading font, measure, spacing, Polish text as prose, tool noise filtered. A composer box sends replies back via the existing delivery ladder (`cmux send` / channel). **The terminal stays the engine; the desk becomes the cockpit.** This is the §4 "PTY + JSONL-tail hybrid" applied at the UI layer instead of the transport layer: no wrapping, no headless, quota-class unchanged, and it reuses three things the spine already has (registry, delivery, SSE). Known limits, stated: transcript format is internal/version-unstable (accepted risk — opcode parses it in production); permission prompts/AskUserQuestion dialogs stay in the terminal, so the pane shows an "attention needed in terminal" indicator rather than pretending to be a full front-end. Slot as **M4c** in the epic — with pipeline build capacity it is one more viewer over one more data source, not a new project.

### 11.3 Singleton daemon: one machine, one port, one token — N artifacts, N sessions

Ten concurrent artifacts must NOT mean ten HTTP servers or ten pairing tokens. Topology rules:

- **One long-lived daemon per machine** (`~/.desk/daemon.lock`, well-known port, lazily started by whatever touches it first). It multiplexes everything the data model already supports: the session registry (§2.5) is plural by design, inboxes are per-artifact-dir (§2.1), and the HTTP API namespaces by workspace — `/w/<slug>/doc/…`, `/w/<slug>/annotations` — so the desk page offers a workspace switcher over one origin, one handshake.
- **One pairing token per machine.** The token authenticates *this user's browser ↔ this machine's daemon*; artifacts are authorization-irrelevant locally (same user). Per-share tokens only ever appear at L3 (remote relay), a different layer.
- **Blocking gates go through the singleton too**: a hook process doesn't embed its own server (the Plannotator per-review pattern is what this rule replaces); it long-polls the daemon — "decision D created, respond when resolved" — the daemon notifies the page, the page resolves, the long-poll returns, the hook prints stdout and exits. Ephemeral waits, zero ephemeral servers, no port proliferation.
- **The MCP faces are shims, not daemons** (amends §11.2's packaging): MCP hosts spawn stdio servers per app/session, so a naive daemon-as-MCP-server yields N daemons — exactly the proliferation to avoid. The spawned MCP process checks for the singleton (lock file + well-known port); if present it proxies, if absent the first one wins the lock and becomes (or detaches) the daemon. Docker-CLI→dockerd / language-server shape: many thin clients, one engine. N stdio shims cost nothing; there is always exactly one port and one token.
