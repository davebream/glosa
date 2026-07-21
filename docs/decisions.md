# Artifact Desk — session decisions log (2026-07-20)

Companion to `2026-07-20-artifact-desk-options.md` (the architecture/options document, §1–§11).
This file records HOW the session got there: every question asked, every idea's fate, open
questions, and action items. One sitting, ~16 research/verification agents + one 16-agent
ultracode workflow.

## 1. The arc in one paragraph

Started as "should I build a jethro-specific GUI or a general writing-first Claude Code GUI?"
Ended as: **neither, yet** — build an agent-agnostic artifact loop (file bus + delivery + desk)
whose general core is a shell + viewers + annotation bus + resolver interface, with
jethro-specific parts confined to resolver implementations. v1 is cut per-sermon against the
weekly preaching deadline; the general-product and standalone-shell decisions are deferred to a
pre-committed decision point after 3–4 sermons of real use.

## 2. Questions asked → how they were answered

| # | Question (user) | Answer (evidence) |
|---|---|---|
| 1 | What am I building actually — jethro GUI or general writing-first GUI? | Two conflated products: the shell (commodity; Anthropic + others building it) and the artifact loop (unserved niche, confirmed by landscape scan). Build the loop, borrow the shell. §10.4 later made the split architectural: general core = shell/viewers/bus/resolver-interface; jethro part = resolvers + registration. |
| 2 | Followups (via AskUserQuestion) | Primary goal = kill sermon-week pain (explicitly #1, ADHD-aware). Single window = must; desktop feel preferred; cmux-like ok. Time = "aside" (kombajn > CoA > this). Interaction = desktop keyboard + annotate rendered output + dictation; phone/iPad secondary-future. |
| 3 | Does GUI wrapping need `claude -p`/stream-json (July 2026)? | Yes — standard is spawning user's claude with `-p --output-format stream-json --input-format stream-json`; Vibe Kanban = best OSS reference; nobody PTY-wraps as primary. All 10 flags confirmed on installed 2.1.215. |
| 4 | Will headless get separate quota; accept the cost? | Nearly happened: May 14 credit scheme ($20–200/mo at API rates), paused June 15 launch-day; framed as rework. Researcher's 70–80%/12mo return estimate (flagged UNVERIFIABLE in verification). Interactive terminal usage stayed on subscription in every announced scheme → v1's zero-wrap approach is quota-immune. Hedge: transport seam + budget automation at API rates. |
| 5 | Wrap sessions without headless (agentapi)? | Possible three ways: don't wrap (v1), PTY-input + live JSONL-tail hybrid (cross-mode resume confirmed), agentapi (rejected: Coder calls it a stopgap; text-only; TUI-chasing). ACP = the emerging standard (v1.x by Jul 2026). |
| 6 | Can a web app inform a cmux session event-driven, no polling? 10 sessions routing? | Yes. Binding ≠ delivery: bind at render time (artifact identity), resolve target at delivery time via SessionStart-hook registry {session_id, cwd, CMUX_SURFACE_ID}. Push initially via `cmux send` (later superseded, see #12). Files carry content; nudges are doorbells. |
| 7 | Other extensible AI terminals better than cmux? | No (verified survey): Tabby = only true DOM-plugin host but zero agent ergonomics; Wave widgets = webviews (Tsunami "planned"); Warp/MS-Intelligent-Terminal/Zellij/Hyper/WezTerm/Ghostty/Kitty all fail on rich-UI extensibility or maintenance. Stay on cmux; watch Wave Tsunami + Ghostty 1.4. |
| 8 | (ultracode) Verify findings, specify options concretely | 16-agent workflow → options doc §1–§6; judge scores 7/9/8; 10 claims corrected (see §5 below); calendar-honest per-sermon milestone cut with explicit stop-point after M3. |
| 9 | How does Plannotator work (transport, storage, share URL, plan vs code review, arbitrary artifacts)? | Source-level: no MCP; blocking child process, stdout = whole channel; PermissionRequest/ExitPlanMode hook (4-day timeout) or on-demand CLI; flat-file storage; session binding = OS process tree (no IDs, no redelivery). Annotate mode opens ARBITRARY md/html/folders, renders custom HTML verbatim (iframe srcdoc bridge). Share URL: fragment-is-document + E2EE paste service; no tunnel; `PLANNOTATOR_SHARE=disabled` kill switch. Plan vs code review = two separate React apps + document models over shared substrate; annotate mode lacks a suggested-replacement type. |
| 10 | Should tila host this? | tila is ACTIVE (v0.2.7, commits same-day — contrary to user's belief) and already a near-isomorph of the loop spine (signals≈inbox/ack, journal, sha256 artifacts, presence≈registry, gates, MCP). But UI chartered read-only, no local-server/watcher runtime, 7-package vertical tax → v1 standalone, v2 promotes proven schemas into a tila vertical (also unlocks phone/iPad via Worker relay). |
| 11 | Is blocking-stdout still cleanest? Events? Channels? | Blocking-hook-stdout = still SOTA for lifecycle gates. **Channels = official CC inbound push** (v2.1.80 research preview; verified via docs + Telegram plugin source + CC binary strings): session-owned MCP server → `notifications/claude/channel` → wakes idle sessions. Plus asyncRewake hooks, tripled hook inventory (FileChanged/watchPaths, PostToolBatch, Elicitation), MCP elicitation URL mode. |
| 12 | (implied by #11) Delivery re-rank | 1 channel bridge · 2 asyncRewake · 3 boundary hooks · 4 `cmux send` (demoted to universal/non-Claude-agent fallback). Transport swap, not redesign — all behind the same file bus. |
| 13 | (ultrathink) Speech-notes HTML — annotating a compiled artifact, skipped? | Conceded; verified: HYBRID artifact — body prose verbatim (quote→source works), headings/cues transformed, H4s LLM-invented (quote correctly fails → classification/style intent branch). Manifest lacks source positions; chunk identity dies at reconciliation. Fix = manifest-first anchoring (M4b: segment.py finditer ranges + sha256; @@CHUNK(NNN)@@ threading → data-chunk). |
| 14 | Round-trip: annotate final notes → manuscript fixed → re-render? | Confirmed as the designed happy path (6-step loop); the missing artifact is a ~15-line drain instruction (the real M1 deliverable). M4b's source map additionally enables chunk-level re-render (only changed chunks re-classify → unrelated anchors survive). |
| 15 | "Half-solution" objection: md desk vs HTML desk not the same thing | Conceded and formalized as §10: one annotation contract, N viewers. Class R (desk-rendered md, ~90% of pipeline phases), Class F (foreign HTML — speech notes; iframe + bridge + pipeline provenance), Class D (diffs). Resolver is the per-class pluggable seam. Plannotator/agentation = scaffolding whose role ends when both viewers exist (§10.5). |
| 16 | (ultrathink) Hosted stateless cloud desk? URL-params? GDPR? blocking? | §11: browser-as-bridge — cloud serves ONLY static shell; page fetches from 127.0.0.1; content never leaves machine (stronger than URL-statelessness). L0 cmux → L1 desk.localhost → L2 hosted shell → L3 relay (deferred; tila or E2EE paste). Blocking unchanged (always local). GDPR: L0–L2 near-nil; Art. 9 sharpener (congregant anecdotes in religious context) argues for content-never-leaves as default. |
| 17 | Contract so random visitors can't play; handshake? | §11.1: real threat = drive-by localhost from OTHER websites + DNS rebinding, not strangers-with-URL. Jupyter-lineage pairing (fragment token via `desk open`, Bearer header, no cookies), server-side Origin/Host allowlist, semver'd handshake with 3 distinct failure screens. Auth built into M4a server day one. |
| 18 | Claude Desktop / other setups — cloud "sends nothing back"? | §11.2: return-path LADDER — 1 push (CC only) · 2 blocking gate (CC only) · 3 **pull via MCP tool (works in Claude Desktop/claude.ai/Cursor/Codex)** · 4 manual export. Packaging: daemon shipped AS an MCP server (host app spawns it → "server required" becomes invisible). Honest ceiling: pushing into Claude Desktop is impossible today — rung 3 is pull-only there. Zero-local persona → remote MCP + cloud state (consent) or self-hosted tila. |
| 19 | 10 artifacts ≠ 10 servers/tokens | §11.3: singleton daemon — one machine, one port, one token; workspace-namespaced routes; gates long-poll the singleton (no per-review servers); MCP faces are shims that proxy to the singleton (docker-CLI→dockerd shape). |

## 3. Accepted decisions (with why)

1. **v1 = zero-wrap**: interactive Claude Code TUI in cmux + local artifact desk. Why: quota-immune (interactive class untouched in every announced scheme), zero ToS exposure, days not months.
2. **Loop spine = agent-agnostic file bus** (artifact-centric inbox + lifecycle journal + shadow-git provenance). Why: sequential sessions, multi-agent (Codex/`agy`), debuggability; the genuinely novel unserved piece (verified: no tool ships human-edit diffs as agent-consumable summaries).
3. **Sessions are interchangeable workers; routing resolves at delivery time**; parked entries drain at SessionStart. Why: sequential-session reality; annotate-at-11pm becomes a feature.
4. **Anchoring = W3C-shaped records; per-artifact-class resolvers** (stamps for class R, manifest source map for class F, hunks for class D); quote as fallback tier; sha256 staleness; never guess.
5. **Delivery ladder** with channels first, cmux send as universal fallback; blocking-hook-stdout for gates. Why: verified capability map of July-2026 CC + non-Claude agents.
6. **Milestone 1 = Plannotator trial** (zero code, `PLANNOTATOR_SHARE=disabled`) before patching annotate.js. Why: source read proved annotate mode renders foreign HTML verbatim with annotation on top, today.
7. **Steal, don't fork, Plannotator**: external-annotations bus, srcdoc bridge, exportAnnotations format, flat-file journal + pid registry, hook-contract matrix.
8. **tila = v2 home for the bus** (not v1). Why: near-isomorph primitives already exist; charter/runtime conflicts + deadline forbid v1; relay story unlocks mobile later.
9. **Per-sermon milestone cut with legitimate stop-point after M3** (option 2 in full). Why: ADHD abandonment-curve honesty; 4–6 focused days = 6–12 calendar weeks at real budget.
10. **Distribution ladder L0→L3** with browser-as-bridge for the hosted shell; singleton daemon; Jupyter-style pairing; semver'd handshake; auth from day one.
11. **Daemon packaged with an MCP-server face (as shim to singleton)** → rung-3 pull support for every MCP host.
12. Speech-notes pipeline upgrades in M4b: `data-chunk` + manifest source ranges + chunk-level re-render.

## 4. Rejected / deferred ideas (with why)

| Idea | Fate | Why |
|---|---|---|
| Claude Code desktop app as shell | REJECTED (user) | Claude-only (no Codex/`agy` judge panels), config pain, quality |
| General writing-first GUI now | DEFERRED to post-sermon-4 decision point | ADHD trap; Anthropic squeeze (desktop rebuild + Cowork's July co-editing editor); time budget |
| Standalone Tauri/Electron shell v1 | DEFERRED | Web-first desk = same code later wrappable; nothing wasted |
| agentapi / PTY-scraping foundation | REJECTED | Coder's own "stopgap"; text-only; TUI-chasing tax |
| Fork Plannotator | REJECTED | 160k LOC, Bun lock-in; sync→async inversion = "different program wearing its UI" |
| Adopt Plannotator as the product | REJECTED (accepted as scaffolding) | No session IDs, no redelivery, no journal, process-tree binding — structurally can't do the async half |
| Wave / Tabby / Zed / Obsidian as shell | DOMINATED | Per-option: webview-only widgets / no agent ergonomics / ACP metered class + no annotation seam / no terminal + plugin tax |
| tila as v1 host | REJECTED for v1, ACCEPTED for v2 | Read-only UI charter; no local server/watcher runtime; 7-package tax; sermon deadline |
| Content-in-URL as primary transport | REJECTED → rung-4 fallback | URL is the document (leak vector); unnecessary once a local daemon exists |
| Session-centric inbox | REPLACED by artifact-centric | Session-keyed inboxes die with their session; sequential-session reality |
| `cmux send` as primary delivery | SUPERSEDED by channels | Channels are official push that wakes idle sessions; cmux send kept for non-Claude agents |
| CriticMarkup inline annotation storage | REJECTED | Pollutes every pipeline consumer; presupposes the rendered→source mapping it should provide |
| OT/Google-Docs position transformation | REJECTED | A file bus never owns the edit stream |
| recogito / Apache Annotator adoption | FALLBACK / AVOID | annotate.js covers ~80% already; Apache Annotator retired |
| MCP resource-subscription push | REJECTED | Unproven in CC; not how CC consumes context (channels are the sanctioned exception) |
| Per-review HTTP servers (Plannotator pattern) | REJECTED at scale | 10 artifacts ≠ 10 servers; singleton + long-poll gates |
| Per-artifact tokens | REJECTED | Token authenticates user↔machine; per-share tokens only at L3 |
| E2EE for zero-local remote MCP | IMPOSSIBLE | The MCP endpoint must serve plaintext to the agent → consent mode or self-hosted tila |
| Dictation capture v1 | DEFERRED (schema slot reserved) | Mechanism undecided; `/voice` now broadly rolled out with Polish support |
| Phone/iPad v1 | DEFERRED | Secondary per user; agentation localhost-only; later unlocked by tila relay |
| Quote-only anchoring for speech notes | REFINED | Verified hybrid artifact → manifest-first for class F, quote as verifier/fallback |

## 5. Corrections to prior beliefs (verification pass + follow-ups)

- Cowork launched **Jan 2026** (not July) and since ~Jul 14–16 has a **live co-editing editor + dictation** → "no product combines all four" holds only for third-party/agent-agnostic tools; **Plannotator** discovered as nearest prior art.
- cmux key syntax `ctrl+c` NOT `C-c` (✅ fixed in ~/CLAUDE.md); `cmux send` interprets `\n`/`\r` as Enter → sanitize payloads; `cmux events` = cursor-based event stream.
- Stop hook: 8-consecutive-block cap; silent on user interrupt; API errors → StopFailure. UserPromptSubmit: 30s timeout, silent discard. Queued input flushes at next STEP boundary.
- Live transcripts here under `~/.ccs/instances/<name>/projects/` ($CLAUDE_CONFIG_DIR) — never hardcode `~/.claude`.
- Policy: Feb-2026 OAuth ban superseded in practice — post-pause, third-party Agent-SDK subscription apps are sanctioned; Conductor policy-sanctioned, not gray.
- +50% weekly quota promo extended through **Aug 19** (not expired Jul 13); Fable 5 promo ended Jul 19.
- ACP is v1.x (not 0.11); adapter renamed claude-agent-acp.
- agentation-mcp registered only in leadcue's `.mcp.json` — must be added to the sermon workspace or tools silently don't bind (#278 failure class).
- tila is actively maintained (user believed otherwise).
- format-sermon: reconciler is NOT a fidelity check; sermons publicly deployed to Cloudflare Pages; render.py `<title>` bug; annotate.js localStorage is per-origin.

## 6. Open questions

1. Does Plannotator's synchronous-gate UX fit sermon rhythm? (M1 trial answers; also whether prose-comment rewording suffices given no suggestion type.)
2. Channels preview evolution: allowlist, `tengu_harbor` gate on this account, protocol stability. (Dev flag works today regardless.)
3. Quota rework return — watch support article 15036540 + changelog (the 70–80% figure is an unfalsifiable estimate, not a fact).
4. Chrome/Safari local-network permission-prompt UX (pre-L2 verification; affects onboarding copy, not feasibility).
5. Dictation capture mechanism — decide post-sermon-4; `/voice` (Polish supported) may cover it natively.
6. Wave Tsunami shipping / Ghostty 1.4 scriptability (shell watch items).
7. Classification-overrides sidecar — build on first real recurrence of an evaporating correction.
8. FileChanged hook behavior on installed CC (documented; locally unverified).
9. Final jethro-specific vs general packaging call — deferred to the decision point; §10.4 architecture supports both.
10. Cloudflare Pages sermon deploy: keep with Access, or drop once desk serves locally?

## 7. Action items

**Before sermon #1 (M1, ~0.5 day):** `PLANNOTATOR_SHARE=disabled`; install Plannotator; trial `plannotator annotate` on latest speech-notes HTML; write the ~15-line drain instruction (quote→manuscript search; found→edit source; not-found→classification/style feedback; after content edits→re-run /format-sermon, report new path). Fallback: register agentation-mcp in sermon workspace `.mcp.json` + patch annotate.js to POST W3C-shaped records.
**M2 (sermon #2, ~1 day):** chokidar watcher + shadow-git checkpoints + inbox `human_edit` entries + journal.ndjson + `desk-resolve` CLI.
**M3 (sermon #2–3, ~1 day):** hooks + registry + delivery — channel bridge AND asyncRewake AND cmux send behind one interface, A/B them; scrub `ANTHROPIC_API_KEY` from spawned envs. ⛳ Legitimate stop point.
**M4a (sermon #3, ~0.5–1 day):** Bun server WITH §11.1 auth (Origin/Host + Bearer + handshake, ~50 lines) from day one; markdown-it with `data-line`/`data-chunk`; SSE + idiomorph. Keep SPA data client behind one interface (same-origin vs 127.0.0.1) for future L2.
**M4b (sermon #4, ~1 day):** speech-notes passthrough + bridge-injected annotation; `segment.py` source ranges + sha256 into manifest; `@@CHUNK(NNN)@@` threading → `data-chunk`; diff2html pane.
**M5 (post-window):** daemon-side anchor pre-resolver; fuzzy tier only if real orphans occur.
**Non-milestone:** fix render.py title bug; decide Cloudflare Pages privacy posture; audit kombajn/jethro headless pipeline envs for `ANTHROPIC_API_KEY` (the $1,800 footgun class).
**Decision point (after sermon 3–4):** desk sufficiency; tila v2 promotion; standalone shell / general product / L2 hosted shell.

**Late recalibration (user correction)**: with multiple Max subscriptions + kombajn autonomous pipelines, M1–M4c compresses to 1–2 autonomous epic runs; the sermon cadence stays as the *validation* clock only. Milestone boundaries become the epic's task decomposition. Blocking decision before the epic: new repo + name (this is not jethro code). Pain A addressed properly via **M4c Class-T conversation viewer** (live transcript JSONL tail rendered with real typography + composer via delivery ladder — terminal stays the engine, desk becomes the cockpit) plus a zero-build Ghostty writing profile + jethro prose-register instruction available today.

**Editor is v1 (user decision, post-Codex-review)**: v1 SPA has THREE modes per artifact — **Preview** (rendered, read-only), **Annotate** (margin comments on rendered view; extends the existing annotate.js Preview/Annotate toggle), **Edit** (modify source, save, re-render). Flips the earlier "no in-app editing" non-goal. Rationale: removes the Obsidian round-trip; makes human-edit attribution certain-by-construction (glosa originates the edit → labels it `human`, dissolving most of Codex F05); the editor is the most-used daily surface so deferring it weakened v1's feel. Watcher stays as the safety net for agent writes + format-sermon re-renders + occasional external edits (attributed `session:<id>` via apply-lease, or `unknown`). v1 editor = deliberately minimal (source markdown editing + save); fancy live-preview/inline-annotate-while-editing = later. Concurrency (human editing in glosa while agent wants the same file) → "changed since last read" guard.

**Class-F edit + staleness = generic "derived-from" mechanism, NOT jethro knowledge in core (user caught the layering smell)**: glosa CORE treats a class-F HTML artifact as opaque — Preview + Annotate only, no Edit, no concept of a source or staleness, because the core doesn't know the file came from anywhere. The DERIVATION is adapter-supplied metadata: an adapter declares a generic edge `derived-from(A → B, via process)`. Given that edge, the core provides two GENERIC behaviors with zero pipeline knowledge: (1) Edit on A = follow the edge, open editable source B; (2) staleness = generic hash/mtime comparison (B newer than A's build → A stale badge). The jethro adapter populates the speech-notes→manuscript edge; core never mentions sermons/format-sermon. Generalizes free to any generator/compiler that declares derived-from edges. No edge declared → HTML is just an opaque preview+annotate artifact.

**glosa is FULLY DECOUPLED from cmux (user decision, final)**: cmux is NOT a dependency, NOT a delivery rung, NOT the UI host. Replaces both jobs cmux did: (1) UI host → SPA served over http://localhost, viewable in ANY browser (Safari Add-to-Dock for dock icon, browser tab, later Electron); (2) delivery fallback → each agent's OWN hooks. Corrected delivery model by capability: **async push into idle = Claude channels (Claude only)**; **blocking review gate (synchronous, structured stdout) = Claude + Codex + Gemini + Copilot via their hooks (Plannotator-proven)**; **turn-boundary drain (async) = any hook-capable CLI**; **pull-on-demand = MCP tool (any MCP host)**. Durable inbox always the truth; provider delivers at whatever injection points the agent offers. **Claude Code = deep, required provider (channels+hooks+transcript mirror); Codex = built against the same provider interface (gate+boundary+MCP-pull); provider interface is a first-class v1 deliverable designed against Claude+Codex+generic-MCP so adding a CLI is an adapter not a rewrite.** This resolves the A/B multi-agent question: refined-A + Codex. **Honest limit**: no instant-wake of a non-Claude IDLE agent (no channels-equivalent) → non-Claude feedback delivered at next turn/gate (pull), never lost (durable inbox), just not instant; Claude has no such limit. Remove all cmux references from R4 delivery ladder, registry (`cmux_surface`), doctor checks, and UI-host language in the integration pass.

**Attention model (settled via the 3-concurrent-sessions scenario)**: **agents knock, never barge.** Agent-initiated "show this artifact" is an `attention_request` bus entry (via MCP tool `desk_request_review` or CLI), durable with the standard lifecycle — surfaced in the desk as a workspace-switcher badge/attention tray + optional OS notification, NEVER as a focus steal or auto-switch (contrast Plannotator, which opens tabs — affordable for per-review apps, forbidden for a multi-session desk). The human is the only agent of focus change. Requesting sessions choose fire-and-continue or wait-with-timeout; ignored requests persist and re-surface via the normal drain paths. Feedback routing needs no addressing: annotation → artifact → workspace(cwd) → registry → live session; the artifact's location IS the address. One daemon, N workspaces, N optional views (per-workspace URLs → multiple cmux splits if wanted).

**Naming study (4 lenses: phonosemantics, cognitive branding, etymology, live namespace empirics)**: winner = **glosa** — the only candidate top-tier in ALL four lenses (real Polish living word for expert marginal commentary on an institution's output = the product's core act; one letter from EN "gloss" so instantly decodable; 5-letter fork-free CV-CV; npm FREE; only friction = dormant same-idea GitHub org squat, which validates the metaphor). Runner-up: **brulion** (cleanest namespace of 27 checked, SEO 5/5, PL rough-draft-notebook warmth; cost = EN pronunciation tax). Subsystem drawer: **masora** = internal codename for the provenance layer (deepest thesis fit — the Masoretes' margin apparatus — kept off the storefront to avoid faith-locking); **kolofon** = version-history pane; **brulion** = agent-draft buffer if not used as product name. HARD DQs from live checks: margo (margo-dev.com is nearly this product + Linux Foundation Margo consortium + 5 AI Margos), pulpit (two live "Pulpit AI" church-tech products), margin ("Margin — The Writer's IDE" exists), marginalia (6+ apps + marginalia.nu), verso/scholia/folio/codex/quill/vellum/scribe/skryba (each collided). Repo shape when named: davebream/<name>, packages: daemon / spa / adapters-jethro.

**Future-drawer feature (user idea, explicitly not-now)**: "make it a git repo" — one-click promotion of a desk project directory to a real git repo (pick location, optional create/connect GitHub remote). Design notes for when it fires: the shadow repo already holds full history, so promotion can SEED the real repo from it (graft/replay or initial import) instead of starting empty; after promotion the two ledgers stay separate (shadow = automatic fine-grained, real repo = user-chosen snapshots/milestones, optional mirroring opt-in); surface wording stays writer-register ("Back up / publish this project", never "init repo"); pushing to a cloud VCS is the first moment content leaves the machine → private-by-default + explicit consent warning (sermon content, Art. 9 posture); GitHub remote and tila are two publish targets behind the same surface.

**Surfacing principle (settled)**: git is plumbing, never porcelain. A "project" in the desk is a directory (git repo or not — sermon dirs in the Obsidian vault aren't repos); provenance runs in the desk's own shadow repo (§2.6), which by design never touches any real repo the directory might have. The UI speaks document-native language — versions, timeline, "changed since your annotation", restore — in the track-changes register writers know; never commits/branches/SHAs/staging. Engineer escape hatch: the shadow repo is a normal git dir, inspectable with standard tooling (`git log --author=session:…`). This also keeps the tila-v2 migration clean (version lineage swaps backing stores without changing surface concepts).

**Product identity (settled after the Electron/PTY discussion)**: this is a **writing-first agent GUI, built artifact-core-first** — not "only an artifact management tool." Companion mode (terminal authoritative, desk beside cmux) is v1's deployment TOPOLOGY, chosen for sequencing reasons (deadline, interactive quota class, skip dialog-handling); it is not the product definition. The only subsystem separating v1 from the full GUI is **session ownership** (Conductor-style headless transport + control-protocol permission/AskUserQuestion buttons — no PTY), one bounded component behind the §4 transport seam, added at the decision point. Naming should name the end state (writing workspace for agent work), not the plumbing layer.

**Final plan-philosophy correction (user decision)**: **Plannotator trial REJECTED** — "writing a sermon is too important to be a testing ground." No experiments during sermon week, ever. Plannotator = steal-list only. Build the FULL v1 via autonomous epic BEFORE the next sermon; validate by **offline rehearsal against a copy of a past sermon's artifacts** (po-co-to-wszystko run exists on disk) + pipeline E2E; the desk enters a real sermon week only after the dry-run passes. Also settled: future Electron shell needs NO PTY (Conductor-style headless stream-json is the §4 default; PTY-hybrid exists only as a quota-event contingency); Electron > Tauri verdict recorded in `.kombajn/research/2026-07-20-electron-vs-tauri-desk-shell.md`; personal use can run unpackaged/dev-mode indefinitely, or no-shell via Safari Add-to-Dock.

**2026-07-21 — daemon build identity and automatic refresh**: `build_id` uses the root `package.json` semver and SHA-256 over every regular file below exactly `packages/daemon/src`, `packages/cli/src`, `packages/spa/src`, and `packages/providers/*/src`. Repository-relative POSIX paths are sorted; every path and file body is framed separately as `<decimal-byte-length>:<bytes>\0`; the published hash is the first 16 lowercase hex characters. Protocol compatibility and build identity are distinct. A same-semver hash mismatch is deliberately client-wins so unversioned fixes take effect. Accepted limitation: two divergent installations sharing one semver can alternate the daemon when invoked; differing semvers remain monotonic because older clients reuse a compatible newer daemon or fail without signalling an incompatible newer daemon.

## 8. Artifacts produced this session

- `2026-07-20-artifact-desk-options.md` (§1–§11.3: options matrix, spine spec, reuse calls, transport, verified-facts appendix, build order, Plannotator addenda, viewers architecture, distribution topologies, pairing contract, return-path ladder, singleton daemon)
- This decisions log
- ~/CLAUDE.md cmux key-syntax fix (verified against two sources)
- Memory: `artifact-desk-direction.md` (strategy + all verification corrections, Plannotator/tila/channels/format-sermon findings)
