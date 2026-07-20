# Research: UI component libraries / styling for Claude Code JSONL & stream-json (2026-07-20)

**Question**: Are there frameworks/libraries that give you basic styling/components for Claude Code's
session JSONL / stream-json events, usable in your own product and restylable?

**Mode**: DEEP — 3 parallel research workers + 1 verification worker (~40 searches/fetches total).
Licenses below marked VERIFIED were confirmed from primary sources (LICENSE files / npm registry
JSON); others are as-reported. Context: candidate rendering layer for the artifact desk's
conversation pane (M4c, options doc §11 amendment).

## TL;DR verdict

**There is no established "Claude Code transcript components" ecosystem — but there is exactly one
true component library, one excellent parser, and one MIT reference app worth stealing from.**
Everything else is either a finished app (not importable), a generic chat kit (needs an adapter),
or legally tainted. For the desk's current no-build vanilla architecture: use the parser + steal
the reference app's patterns. If the desk ever goes React: assistant-ui is the foundation.

## 1. Direct hits — components built for Claude Code event shapes

| Package | What it is | License / status | Verdict |
|---|---|---|---|
| **`@10play/claude-agent-sdk-ui`** | The only genuine reusable React component library found: `StreamingMessage`, `SystemMessage`, `ToolCallMessage`, `ToolResultMessage`, separate `./styles.css` export (restylable), `./server` subpath | **MIT VERIFIED**, v0.1.4, published 2026-02-03 | Closest match to the ask. Early maturity (0.1.x, ~5 months since publish) — evaluate, don't bet on |
| `@claude-code-kit/ui` + `ink-renderer` (minnzen) | Terminal(Ink)-oriented components; `ink-renderer` **extracted from Claude Code's leaked source** (Mar 2026 npm sourcemap leak) | MIT claimed; provenance legally unresolved | **AVOID** — leaked-source lineage, wrong medium (terminal, not web) |

## 2. Parsers (typed events, bring your own UI)

| Package | What it covers | License / status | Verdict |
|---|---|---|---|
| **`claude-code-parser`** (udhaykumarbala) | Purpose-built typed parser for `-p --output-format stream-json`: NDJSON → typed TS events, subagent/multi-agent interleaving via content fingerprinting, `--verbose` cumulative-snapshot dedup, polymorphic `tool_result.content`, double-encoded `result` fields. Zero deps, 11 kB. Explicitly positioned for building browser viewers | **MIT VERIFIED**, v0.1.1, 2026-03-21 | **Adopt or vendor** — it encodes exactly the gnarly protocol knowledge we'd otherwise rediscover. Early version; small enough to vendor and own |
| `@constellos/claude-code-kit` | Typed Zod schemas + `parseTranscript` for the **transcript JSONL** (vs the stream): subagent conversations by agentId, `getAgentEdits()` per-agent diffs | License unverified (403s) | Second look worthwhile — it targets the FILE format, which is what the desk tails |

Note the format split: `claude-code-parser` targets the *stream* (stdout pipe); constellos targets
the *transcript file*. Same cargo, slightly different wrappers — the desk needs the file side, so
expect a thin mapping layer whichever is chosen.

## 3. Finished apps — not importable, but MIT/steal-grade

| Project | Why it matters | License / status |
|---|---|---|
| **`d-kimuson/claude-code-viewer`** (corrected path; npm `@kimuson/claude-code-viewer`) | A live web viewer of Claude Code sessions with **file-watching (live session support)** — i.e., an existing implementation of the desk's conversation-pane transport. shadcn internals, terminal + git diff panes, runs via `npx` on :3400. NOT a component lib (whole-app npm publish, no subpath exports) | **MIT VERIFIED**, 1,253★, last push 2026-05-10, v0.7.5 |
| `claude-code-log` (daaain) | Python CLI: transcript JSONL → standalone static HTML/Markdown with **modular separate CSS** (`base/messages/syntax/timeline.css` — restylable). Multi-provider: also Antigravity CLI and Codex exports. Actively maintained (v1.5.0, 2026-07-09) | MIT, active |
| `cclogviewer` (Brads3290) | JSONL → interactive HTML with explicit **nested Task/subagent grouping**, expandable tool calls | MIT; recency unconfirmed |
| `simonw/claude-code-transcripts` | Transcript → clean paginated mobile-friendly static HTML | Dec 2025, credible |
| GUI apps: opcode / claudecodeui | Full chat renderers exist inside them | **AGPL-3.0 — do not reuse code** (network copyleft) |
| GUI apps: Nimbalyst (MIT) / Vibe Kanban (Apache-2.0) | Permissive; renderers are app-coupled (fork/copy, no lib) | Reference only |

## 4. Generic agent-chat kits (restylable, need an adapter)

| Library | Agentic message model | Custom stream? | Restyling | Verdict |
|---|---|---|---|---|
| **assistant-ui** | Best: `ToolGroup` collapsible tool-calls, per-tool UI states, **subagent-scoped rendering pattern exists** (LangChain integration) | Yes — `LocalRuntime`/`ExternalStoreRuntime` (**verified current, not deprecated**) | Headless Radix-style primitives | Best general foundation **if React** |
| shadcn chat components (official, Jun 2026) + prompt-kit + Blazity kit | Primitives incl. tool-call/reasoning components | DIY wiring | Copy-in source, Tailwind/CSS vars — maximum control | Best DIY floor **if React** |
| Vercel AI Elements | Rich (tool calls, reasoning) | Must emit Vercel's UI Message Stream Protocol — translation layer | shadcn-based | Workable, ecosystem pull toward Vercel stack |
| CopilotKit | Good, generative UI | AG-UI protocol; framework lock-in | Headless mode | Too heavy for a pane |
| NLUX / LlamaIndex chat-ui / deep-chat | Clean adapters (NLUX) but **no evidenced tool-call/subagent primitives** | Yes | OK | Would rebuild the hard part anyway |
| Web ACP client UI | — | — | — | **Does not exist yet** (only `@mcpc/acp-ai-provider` bridge) — confirmed ecosystem gap |

## 5. Anthropic ships nothing official

The Agent SDK npm package is protocol/transport only; the demos repo is explicitly non-production;
docs document the stream format, not a renderer. The gap is real and community-filled (HIGH confidence).

## Recommendation for the desk (M4c conversation pane)

1. **Today / scaffolding**: trial `npx @kimuson/claude-code-viewer` in a cmux browser pane — it is a
   working live session viewer (MIT) and answers "what does a rendered live transcript feel like"
   for zero code, the same de-risking role Plannotator plays for annotation.
2. **v1 pane (current no-build vanilla desk per §3)**: vendor `claude-code-parser` (11 kB, MIT,
   zero-dep) or map its type knowledge onto the transcript-file entries; render with hand-rolled
   vanilla templates, stealing UX patterns from d-kimuson's viewer and CSS structure from
   claude-code-log. The event-type → rendering mapping (prose turns = typography; tool calls =
   collapsed chips; subagents = grouped; meta = hidden) is ours regardless of library.
3. **If/when the desk goes React** (e.g., L2 hosted-shell era): assistant-ui (MIT, custom runtime)
   or shadcn copy-in kits become the upgrade path; `@10play/claude-agent-sdk-ui` worth re-evaluating
   for maturity by then.
4. **Never**: AGPL app code (opcode, claudecodeui) in our codebase; leaked-source-derived
   `ink-renderer`.

## Confidence & gaps

- HIGH: no reusable-component ecosystem exists (three independent workers converged); Anthropic
  ships nothing; assistant-ui MIT + current runtime API; @10play and claude-code-parser licenses
  (registry-verified); d-kimuson viewer identity/nature (API-verified).
- MEDIUM/LOW: `@constellos/claude-code-kit` license; cclogviewer recency; claude-code-log CSS
  structure (search-summary only); star counts (single T3 comparison source).
- Not investigated: sst/opencode web UI internals; TanStack AI; `clog`, `claude-log-viewer`,
  `delexw/claude-code-trace` (surfaced, unexamined — low expected value given converged verdict).
