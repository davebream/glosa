# Design Brief — glosa Workspace Review Surface

**Command:** `impeccable shape workspace review surface` · **Status:** confirmed 2026-07-21
**Source of truth for behavior:** `docs/requirements.md` (R1–R9) + appendices A1–A6. This brief specifies the UX/UI; where it touches contracts it cites the requirement.

---

## 1. Feature Summary

The complete focused-review surface of the glosa SPA: a human reviewer reads a rendered artifact beside a running terminal agent, leaves precise margin annotations, edits source when needed, and verifies history and provenance — all without the screen becoming an agent dashboard. This brief covers the full flow: workspace/artifact navigation, Preview / Annotate / Edit modes, contextual margin annotations, delivery and provenance state, history/diff, attention tray, all empty/loading/error states, and the compact split-screen layout.

## 2. Primary User Action

**Select a passage in the rendered manuscript and attach an intent-aware annotation that visibly routes to the right agent session.** Everything else (navigation, history, transcript, attention) is one action away and never competes with this.

## 3. Design Direction

- **Register:** product (PRODUCT.md). **Color strategy: Restrained** — neutral surfaces, one disciplined olive accent ≤10% of the surface, semantic state colors with shape+text support.
- **Scene sentence:** a writer reviewing a long manuscript for hours at a quiet desk in ordinary daylight, focused and detail-conscious → **light-first**.
- **Anchor references:** *iA Writer* (dominant — reading focus, typographic calm), *a copy editor's marked manuscript* (marginalia close to the text), with *Linear-grade operational state clarity* applied only where glosa needs it (delivery, provenance, history).
- **Probe outcome (prior session):** the editorial-manuscript direction won; the "devy" feel was rejected. Two consequences are now rules in this brief: the mode-specific line-number rule (§7.6) and the typography split (§4).

### Confirmed discovery decisions

| # | Decision |
|---|---|
| 1 | Focused review is primary; agent dialogue is a near-term extension point, not a v1 pane |
| 2 | Complete review flow (nav, reading, annotation, edit entry, history, all states, responsive) |
| 3 | Production-ready specification |
| 4 | Light-first editorial workbench |
| 5 | iA Writer-led references |
| 6 | Contextual margin annotations |
| 7 | Writer-sized workspace: 5–30 artifacts, 0–20 active annotations |
| 8 | Desktop-first, narrow-window resilient; no phone workflow |
| 9–10 | CLI opens the whole owning workspace deep-linked to the passed file; compact layout activates automatically by viewport width |
| 11 | Contextual margin at full width; **bottom annotation tray** in compact |
| 12 | Line numbers: Preview none · Annotate hover/selection anchor ref only · Edit optional, off by default · Diff/history shown |
| 13 | **Editorial manuscript + quiet sans UI**: serif for rendered Markdown, humanist sans for controls, mono only for paths/technical metadata |

## 4. Typography (resolves DESIGN.md §3 placeholders)

macOS-only v1 + zero external calls + no build step → **system font stacks, no vendored webfonts**.

| Role | Stack | Usage |
|---|---|---|
| Manuscript serif | `ui-serif` (New York), Georgia fallback | Rendered Markdown body, headings inside the manuscript, blockquotes |
| UI sans | `system-ui` (SF Pro) | All chrome: sidebar, toolbar, buttons, tabs, annotations, dialogs, empty states |
| Mono | `ui-monospace` (SF Mono) | File paths, anchor refs, session ids, diff pane code, technical metadata only |

- Manuscript body: 17–18px serif, line-height 1.6, **measure 68ch max**, `text-wrap: pretty`.
- UI scale: fixed rem scale, ratio 1.125 (product register): 12 / 13 / 15 / 17 / 19 / 21. No fluid clamp in chrome.
- Annotations set in UI sans at 13–14px — marginalia is commentary *on* the manuscript, not part of it.
- `text-wrap: balance` on manuscript h1–h3. No display styling on any label, button, chip, or tab (No Display Labels Rule).

## 5. Color (resolves DESIGN.md §2 placeholders — validate contrast at implementation)

Mood: *a copy editor's daylight desk — ink, white paper, one olive pencil.* Seed: `oklch(0.650 0.100 110)` (editorial sage/olive). All tokens OKLCH.

```
--bg:            oklch(1 0 0);              /* Reading Surface — pure white paper */
--surface:       oklch(0.972 0.004 110);    /* Control Surface — sidebar, toolbar, panels */
--ink:           oklch(0.24 0.01 110);      /* body text, ≥7:1 on bg */
--muted:         oklch(0.50 0.012 110);     /* secondary text, ≥4.5:1 on bg */
--border:        oklch(0.90 0.005 110);     /* Quiet Border */
--primary:       oklch(0.50 0.10 110);      /* Workbench Accent — deep olive; white text on fills */
--anchor-wash:   oklch(0.95 0.045 108);     /* annotation anchor highlight in the manuscript */
--danger:        oklch(0.50 0.16 25);       /* errors, destructive confirms */
--warn:          oklch(0.55 0.12 75);       /* orphaned, stale, expired */
--ok:            oklch(0.52 0.10 150);      /* resolved, delivered-confirmed */
```

- **Accent Rarity Rule** (DESIGN.md): `--primary` marks the primary action, active mode, selection, focused annotation, and session provenance. Never panel washes.
- **Status Needs Shape Rule**: every state color is paired with an icon or text label (state vocabulary in §7.5). Color is never the only channel.
- Selection highlight in the manuscript uses `--anchor-wash`; the active annotation's anchor deepens it slightly and gains a 2px full underline (not a side-stripe).

## 6. Scope

Production-ready specification · complete review flow (one whole surface) · shipped-quality interactive behavior · polish-until-ships. Task-scoped; not persisted to PRODUCT.md/DESIGN.md.

## 7. Layout Strategy

### 7.1 Topology (wide, ≥1200px)

Three regions on `--bg`, separated by quiet borders — no cards, no elevation at rest (Flat-Until-Floating):

- **Artifact navigator** (left, 260px, collapsible to zero): workspace switcher at top (name + attention badge), then the adapter-ordered artifact list — name, class glyph (R/F), staleness dot, unresolved-annotation count. Writer-sized (5–30 items): a flat scrollable list, no search-first UI, no virtualization.
- **Manuscript column** (center, dominant): 68ch serif measure, centered in remaining width, generous top whitespace. This is the page; everything else is desk.
- **Contextual margin** (right, 300px, only in Annotate mode on wide screens): saved annotations align beside their anchors, connected on hover/focus by anchor-wash highlight. Overflowing/stacked annotations collapse to compact chips that expand on focus.

**Top bar** (single quiet row on `--surface`): artifact title + path (mono, truncated middle) · Preview/Annotate/Edit segmented control · History · connection/delivery indicator · attention tray button. Nothing else.

### 7.2 Responsive behavior (structural, not fluid)

| Width | Navigator | Margin annotations | Composer |
|---|---|---|---|
| ≥1440px | Open | Full margin beside anchors | Margin composer |
| 1024–1439px | Open (collapsible) | Gutter markers + slide-over annotation panel on demand | Margin/panel composer |
| <1024px (**compact**) | Collapsed → workspace button in top bar | Gutter markers only | **Bottom tray** |

- Compact is **automatic by viewport width** — the split-screen (Claude Code + glosa) case. No `--compact` flag, no persistent mode.
- The manuscript measure never drops below ~60ch before chrome collapses; chrome always yields before the text does.

### 7.3 Compact bottom tray (confirmed behavior)

- Selection → tray rises from the bottom (~180px, drag-resizable, never a modal). glosa auto-scrolls the selected passage into the unobscured upper area first.
- One compact stack: intent choice → comment field → submit. Esc or submit closes it, leaving an anchored gutter marker. Tapping a marker reopens the tray with that annotation.
- At wider widths the identical interaction graduates into the contextual margin — same component, two placements.

### 7.4 Modes (R6)

- **Annotate is the default mode on artifact open** — focused review = reading with the pencil in hand. Preview is the distraction-free/pure-read mode; Edit is deliberate.
- **Preview:** rendered artifact only. No line numbers, no markers, no selection affordance.
- **Annotate:** rendered artifact + gutter markers + margin/tray. Selecting text reveals a small floating "Annotate" affordance near the selection (never a toolbar). Anchor refs (mono, e.g. `¶ 14`) appear only on hover/selection.
- **Edit:** minimal source editor (R6), UI-sans chrome with mono content, line numbers available but **off by default**, save → re-render → `human` provenance. Class F artifacts follow the derived-from edge to their source; opaque artifacts show no Edit tab at all (not a disabled one).
- Mode switching preserves scroll position and selection (R6 idiomorph invariant extends to mode flips).

### 7.5 Operational state vocabulary (writer-register labels, exact enum in metadata)

| Domain state | Label | Shape + color |
|---|---|---|
| annotation `unresolved` | "Waiting" | hollow dot, `--muted` |
| parked (no live session, R2) | "Waiting for a session" | hollow dot + pause glyph, `--muted` |
| `delivered` | "Sent to session" | filled dot, `--primary` |
| delivery re-attempt (R3 separate axis) | "Nudged ×2" | same dot + count — attempts never change status |
| `resolving` (apply-lease open) | "Being applied…" | pulsing ring, `--primary` (reduced-motion: static ring) |
| `resolved` | "Done" | check, `--ok` |
| `orphaned` | "Lost its place" + reason | broken-anchor glyph, `--warn`; offers "show original quote" |
| provenance `human` | "You" | solid ink chip |
| provenance `session:<id>` | session name | `--primary`-tinted chip |
| provenance `unknown` | "Outside glosa" | dashed-border chip, `--muted` — never dressed up as certainty |

Annotation **intents** (R3) as a three-option segmented choice in the composer: **"Change the words"** (`content`) · **"Wrong label or split"** (`classification`) · **"Fix how it looks"** (`style`).

### 7.6 Line-number rule (confirmed)

Preview: none · Annotate: hover/selection anchor ref only · Edit: optional, off by default · Diff/history: shown. The rendered manuscript must never read as an editor buffer.

## 8. Key States

**Shell**
- **First run, no workspaces:** teaching empty state — one serif sentence on what glosa is, then the exact `glosa open <dir>` command (mono). No illustration spectacle.
- **Empty workspace** (no tracked artifacts): explains the tracked-artifact rule briefly ("Markdown, HTML and text files appear here") + link to per-workspace config.
- **Loading artifact:** skeleton paragraphs at the manuscript measure — never a centered spinner.
- **Daemon unreachable / SSE dropped:** thin top banner "Reconnecting…" (`--warn`), content stays readable; on reconnect, journal-cursor replay is silent. Persistent failure → banner offers "What happened" detail.
- **Contract mismatch (A1 409):** blocking single-purpose dialog: "glosa was updated — reload to continue." Reload button only.

**Reading & live updates**
- External artifact change: idiomorph morph, scroll/selection preserved; transient "Updated" whisper near the title (auto-fades; reduced-motion: appears/disappears without fade).
- Artifact deleted/renamed: non-blocking notice replacing the manuscript, list refreshes; annotations for it remain in history.
- Stale derived artifact (adapter `derived-from`): quiet "Source changed since this was built" notice with jump-to-source.

**Annotation & delivery** — all states in §7.5, plus: composer draft (unsent text survives accidental deselect until Esc); two live sessions → one-time session picker dialog (R2, "never guess"); orphaned annotations keep the original quote inspectable.

**Edit**
- Dirty indicator on the mode control; unsaved-changes guard on navigation.
- Save failure: inline error above the editor, source text never lost.
- Disk conflict (file changed under the editor): non-destructive choice — "Reload their version" / "Keep editing mine" with diff link.

**History / diff**
- Timeline of checkpoints (writer language: versions and times, **never commits/SHAs** — R1), provenance chip per entry.
- Compare any two; diff2html pane with line numbers (allowed here).
- Restore: dirty-worktree guard is an explicit confirm listing exactly what uncommitted changes stand to be lost (`--danger` action).

**Attention (R9)** — badge counts on workspace switcher + attention tray listing `open→delivered→seen→done|expired|stale`; the SPA **never auto-switches workspace or steals focus**.

**Transcript viewer (R6/F32)** — read-only mirror, prose turns in reading typography, tool chips collapsed, out-of-band composer clearly labeled "Sends a new message to the session"; any parse failure → "Mirror unavailable — use the terminal," artifact workflow untouched.

## 9. Interaction Model

- **Annotate flow (wide):** select text → floating affordance → margin composer opens aligned to anchor → intent + comment → submit → composer collapses to a margin card in "Waiting/Sent" state. Full keyboard path: select → `a` opens composer, `⌘↩` submits, `Esc` cancels.
- **Annotate flow (compact):** identical semantics via the bottom tray (§7.3).
- **Navigation:** `⌘1/2/3` mode switch · `[` toggles navigator · `n`/`p` next/previous annotation (scrolls anchor + margin card together) · `⌘K` artifact switcher (flat list, writer-sized).
- **Markers:** click/Enter opens the annotation; hover shows a preview tooltip + anchor wash on the text.
- **Motion:** 150–250ms, ease-out-quart; tray slide 200ms; anchor-wash fade 150ms; resolving pulse ~2s subtle. Every animation has a `prefers-reduced-motion` alternative (crossfade or instant). No page-load choreography.
- **CLI entry:** `glosa open <file>` → SPA opens the owning workspace with that artifact focused in Annotate mode, navigator state per viewport width. ⚠️ **Requirements delta:** R8/A6 currently specify `open <dir>`; the file-argument deep-link form is a contract extension that must land in A6 (flagged in the prior session; carried here so it isn't lost).

## 10. Content Requirements

- Honest delivery language everywhere: "Waiting for a session", "Sent to session", "Being applied…" — **never** "synced", "magic", or agent theatrics (PRODUCT.md anti-references).
- Provenance copy: "You" / session name / "Outside glosa". Unknown is stated plainly, never inflated.
- Empty states teach (the command to run, the rule that filters files); error states name the failure and the recovery action.
- Dynamic ranges: artifact names to ~60 chars (truncate middle, full path in tooltip); 0–20 annotations per doc (stacked-chip collapse ≥3 in one viewport band); annotation comments soft-cap ~2000 chars with graceful scroll.
- No images/illustrations required anywhere in v1; the manuscript is the visual content. Icons from one consistent set (e.g. Lucide, vendored — no CDN).

## 11. Recommended References (during implementation)

`typeset.md` (the serif/sans split is the load-bearing decision) · `layout.md` (three-region topology + collapse ladder) · `onboard.md` (first-run and empty states) · `harden.md` (the state inventory in §8 is large and mandatory) · `animate.md` (tray, wash, resolving pulse — light touch).

## 12. Open Questions

None. All defaults above are asserted; the one item requiring action outside this brief is the **CLI deep-link contract extension** (§9), which is a requirements/A6 edit, not a design question.
