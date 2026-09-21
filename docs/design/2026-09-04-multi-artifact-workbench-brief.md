# Design Brief — glosa Multi-Artifact Workbench

**Date:** 2026-09-04
**Surface:** `packages/spa` — the workspace review surface
**Status:** Shipped in 0.1.0-alpha.12 (2026-09-04) and refined since; reconciled against the tree
2026-09-21 (#162). The sections below are kept as the original design record — read **Reconciliation**
for what the code actually does now, and for the short list of what is still open.
**Amends:** [2026-07-21 Workspace Review Surface brief](2026-07-21-workspace-review-surface-brief.md) §7.1, §7.2, §7.4
**Authority:** `PRODUCT.md`, `DESIGN.md`, `docs/requirements.md` (governs where they disagree with an appendix)

**What is being amended.** §7.1 placed the artifact title, the mode control, and History in the top
bar and closed with "Nothing else" — §6 below moves all three into the pane. §7.2 defined a responsive
ladder keyed to viewport width (≥1440px, 1024–1439px, <1024px) — §7 below rebuilds that ladder on pane
width and changes its thresholds. §7.4 required mode switches to preserve scroll and selection — that
still holds, and now holds per pane.

**Named rules.** `The Flat-Until-Floating Rule` (`DESIGN.md` §4) and `The Reading Measure Rule`
(§3) are cited by name below and still carry those names. `The Accent Rarity Rule` and
`The Preview Boundary Rule` belonged to the design system as it stood before the two-hands
redesign in `0.1.0-alpha.22`, and no longer appear in `DESIGN.md`. What replaced them: the rules about where colour may go are now
`The Two Hands Rule`, `The Ink Actions Rule` and `The Paper Desk Rule` (§2), and the question of
what may stay on screen as persistent chrome is answered structurally, in `DESIGN.md`'s Layout
(§3) and Tabs and Dock (§4) entries. Where this brief says "olive", read the hand (burnt vermilion).

**Mode names.** This brief calls the three states Preview, Annotate and Edit. They have been Read,
Review and Edit since the 2026-09-05 review-mode brief, on the wire as well as on screen
(`docs/requirements.md` R6). The sections below are not renamed; the mapping is Preview → Read,
Annotate → Review.

**Class R and class F** are glosa's two artifact classes, defined in `docs/requirements.md` §8: class R
is markdown that glosa renders itself; class F is foreign pre-rendered HTML that glosa must not
restyle, and therefore serves inside a sandboxed iframe on a separate port. The distinction matters
here because an iframe reloads when its element is reparented, which §11 addresses. As built, no
move inside the dock reparents it — see Reconciliation §11.

---

## Reconciliation (2026-09-21, #162)

Everything from §3 onward shipped, most of it in `0.1.0-alpha.12` on the brief's own date. What
follows is the section-by-section record: where each one lives now, and how what shipped differs
from what was specified. A blank Delta means the section is built as written.

| Section | Shipped in | Where it lives | Delta from the brief |
|---|---|---|---|
| §3 Selected direction | alpha.12 | `packages/spa/src/dock.js`, `vendor/dockview.js` | dockview 8.2.0 vendored as specified; glosa owns everything inside a pane |
| §4 Scope and boundaries | alpha.12 | `viewer.js` (`singlePane`), `dock.js` | The presentation surface is not a separate route: `surface=document` is a one-pane layout of the same dock, with `storage: null` so it never writes over the workspace's arrangement (#145) |
| §5 Tab identity | alpha.12 | `dock.js` (`disambiguateLabels`, `diffPanelId`), `viewer.js` (`tabStateFor`) | — |
| §6 Where every control lives | alpha.12 | `artifact-pane.js`, `viewer-shell.js` | The top bar's title slot shows the ACTIVE PANE's artifact path, not the workspace name; the workspace name appears only while nothing is open (`viewer.js` `refreshTopbarTitle`, `DESIGN.md` §3 Layout). The artifact bar is 40px, not 36px |
| §7 The manuscript never moves | alpha.12 | `app.css` (`@container pane`), `artifact-pane.js` (`MARGIN_RAIL_FLOOR`) | Both ladders moved. The bar collapses at 520 / 440 / 400 / 270px of BAR width, in that order, rather than "below about 560px". The rail floor is 1205px, not 1130px: the built manuscript block measures 707px rather than the brief's estimated 642px, and the pane's scrollbar takes another ~8px |
| §8 Editor measure | alpha.12 | `app.css` `[data-editor-face="source"]` | The source face is CENTRED, not left-aligned, so the column sits under the centred mode control. The 100ch cap is as specified |
| §9 Dock behavior | alpha.12 | `dock.js` (`moveCommands`, `resolveMove`), `viewer.js` `onShortcut` | Every option value in the table is set as specified. The keyboard list changed: `[`, `n` and `p` are gone, and `⌘E` (Edit this page, or Done) was added. `⌘1`/`⌘2` are Hide notes / Show notes. The current list is `viewer-context-surfaces.js`'s `SHORTCUTS`, and the sheet renders it |
| §10 Persistence and URL | alpha.12; per-pane state 2026-09-21 (#162) | `dock.js` (`saveLayout`/`restoreLayout`/`pruneGrid`), `viewer.js` (`persistPaneMode`) | The arrangement and the defensive restore shipped with the brief. Each pane's MODE did not: it was fixed at open and only the pane named in the URL came back in the state it was left in. Fixed here — the mode rides in that panel's own params |
| §11 States | alpha.12 | `artifact-pane.js`, `viewer.js` `refreshArtifactIndex` | The class-F row is wrong, and is corrected below |
| §12 Constraints | n/a |  | The reserved pane kinds are still reserved and still unbuilt. The open decision about context menus is still open and still does not block anything: glosa specifies none |

**§11's class-F row, corrected.** The row says a class-F pane dragged between groups reloads and
re-mints, and calls that expected. It is not what happens. With `defaultRenderer: "always"`, floating
groups disabled and popout windows unused, a panel's content sits in a render overlay under the dock
root and nothing in the dock's move paths takes it out of the document — so a tab switch, a tab move
and a whole-group merge all keep the same iframe, with no second `load` and no fresh mint.

That is not a performance nicety. `classf-viewer.js` reads a second `load` on one iframe element as
the document navigating itself (A3's residual), tears the frame down and shows
"This preview couldn't be opened." So reparenting an INTERACTIVE preview would not look like a
reload to the reader; it would look like an attack. What pins it: a tab switch and a tab move in
`test/acceptance/workbench-real-engine.test.ts`, and the whole-group merge — the one path that needs
a pointer drag of a tab strip's void area to reach in a browser — in `packages/spa/test/dock.test.ts`.

### Remaining

- [ ] **Per-pane claim badge** (§5 tab state, §6 artifact bar). The one piece of §6's vocabulary
      that is not built. Blocked on #155: there is no per-artifact claim to show yet. The
      workspace's apply lease already fans out to every open pane (`viewer.js` `setApplyLease` →
      `artifact-pane.js` `setApplyPause`), so what is missing is the claim, not the routing.
- [ ] **Dragging, as an actual pointer gesture** (§9). Every move in every test is driven the
      non-drag way: the pane menu's Move tab commands, or the same movement API the drop handler
      calls. That is deliberate — those commands are what WCAG 2.2 SC 2.5.7 makes a release
      requirement, and a CDP-synthesized drag would pin the synthesis rather than the gesture. It
      does leave the drag itself, including the whole-group drag from a tab strip's void area, to
      the attended rehearsal.
- [ ] **Safari.** Every browser assertion here runs on Chromium. `dndStrategy: 'pointer'` was
      chosen for Safari (§9) and has never been exercised there outside the manual pass.

---

## 1. Job and audience

A writer reviewing agent-drafted work opens a workspace directory, not a file. They read one artifact
against another, compare a draft to the version it replaced, and move between several documents in a
sitting. Today the surface shows exactly one artifact at a time, so every comparison costs a round
trip through the sidebar and loses scroll position, mode, and any unsaved edit.

The visitor mode is **Operate**. Scanability, stable placement, and native expectations outrank
expression. The manuscript still leads; the workbench around it gets more capable without getting
louder.

## 2. Outcome and proof

The writer opens several artifacts as tabs, arranges them side by side by dragging, and keeps that
arrangement across a reload. Each pane carries its own mode, its own annotations, and its own
history. Nothing about reading a single artifact gets worse.

Success is measurable against four failures this brief removes:

1. One artifact at a time. Comparison requires memory.
2. Artifact controls sit in the top bar, where they cannot address two artifacts at once.
3. Annotate mode shifts the manuscript sideways on entry, before any annotation exists.
4. Edit mode inherits the prose reading measure, so markdown source is squeezed into 68 characters.

## 3. Selected direction

**Visual authority:** the existing world, unchanged. `DESIGN.md`'s "Annotated Workbench" governs —
flat at rest, quiet one-pixel borders, serif manuscript on paper, olive accent under the ten-percent
Accent Rarity Rule. Tabs and splits are furniture; they must read as an index tab on a manuscript,
never as IDE chrome.

**Structural thesis:** the top bar becomes workspace chrome. Everything about a particular artifact
moves inside the pane that holds it. That relocation is what makes two artifacts on screen coherent —
one bar cannot honestly speak for two documents.

**Focal moment:** dragging a tab to a pane edge, seeing the target region light up in olive, and
releasing into a split. It is the one place in the product where the accent marks a spatial intent
rather than a state, and it is transient.

**Implementation consequence:** dockview 8.2.0 (MIT) is vendored as the dock engine, themed entirely
through its CSS custom properties. glosa keeps ownership of everything inside a pane.

### Confirmed decisions

| Decision | Choice | Why |
|---|---|---|
| Engine | Vendor dockview, not hand-built | See the trade below |
| Scope | Tabs, per-pane chrome, drag-to-split, and both width fixes in one round | The two width fixes are both consequences of the pane becoming a component with its own width. Phasing them would mean building the pane boundary once for tabs and again for the ladder |
| Pane kinds shipping | `artifact-R`, `artifact-F`, `diff` | |
| Pane kinds reserved | `browser`, `loopback-preview` | Specified in §12, not built |
| Nesting | Uncapped, bounded by a per-pane minimum width | A physical floor beats an arbitrary rule |
| Same file twice | Forbidden globally, including across panes | Saves are guarded by an optimistic `ifMatch: source_sha256` (`viewer.js:1257`). Two panes on one path would hold divergent unsaved buffers against the same base hash, so the second save either fails or silently discards the first pane's work |

**The engine trade.** The alternative was a hand-built dock in the same vanilla idiom as
`viewer-shell.js`: roughly 400–600 lines for a tab strip, a split tree, and a drop-zone overlay, with
the topology capped at four panes. Vendoring dockview costs 374KB of JavaScript and 150KB of CSS —
about ten times the current SPA source — and hands panel DOM and the drag lifecycle to third-party
code. It buys drop-target geometry, layout serialization, tab overflow, and uncapped nesting without
writing or maintaining any of them.

Worth recording for anyone revisiting this: vendoring does **not** remove glosa's three hardest
problems here. Anchor measurement on pane resize (§7), iframe reparenting (§11), and focus routing
across panes are glosa-specific and would need the same work either way. The decision is revisitable
if the theme mapping in §9 proves unstable across dockview upgrades, or if popout windows are ever
wanted — that is where a hand-built dock stops paying and the desktop shell takes over.

## 4. Scope and boundaries

**In scope:** the tab strip and dock in the workspace surface, per-pane artifact chrome, drag-to-split
with its keyboard equivalent, the annotation margin ladder rebuilt on pane width, the editor measure
split by face, diff as a pane, and layout persistence.

**Untouched:** the annotation model, provenance vocabulary, delivery states, the file bus, the
navigator tree, the top bar's workspace-scoped controls, and every copy string in
[the 2026-07-21 brief](2026-07-21-workspace-review-surface-brief.md) §7.5.

**The presentation surface stays single-pane.** `data-surface="document"` — what `glosa present` and
`glosa open <file>` produce for a single artifact — gets no tab strip and no dock. A presented
document is one document.

> **Shipped delta (2026-09-21).** It is one PANE of the same dock, not a second route — one tab
> group holding one panel, the navigator hidden, and `storage: null` so a presented document never
> writes over the workspace's saved arrangement. That is #145's fold: the difference between the
> two surfaces is a layout and a flag, not a parallel viewer. Gated by the browser tests in
> `test/acceptance/rich-editor-browser-roundtrip.test.ts`.

**Anti-goals.** No floating panels. No popout windows. No panel-level toolbars beyond the one artifact
bar specified in §6. No tab colors, icons-as-decoration, or badges beyond the state vocabulary that
already exists in the navigator tree. Nothing that makes the dock feel like a code editor.

## 5. Tab identity

A tab's identity is the workspace-relative artifact path. dockview enforces panel-id uniqueness, so
"one tab per file, no duplicates" needs no bookkeeping of its own:

```
open(path):
  existing = api.getPanel(path)
  if existing: existing.api.setActive()      // focus, never duplicate
  else:        api.addPanel({ id: path, ... })
```

Opening a file already visible in another pane focuses that pane. It does not copy the file into the
active one.

**Tab label** is the filename. When two open tabs share a filename, both grow the shortest
distinguishing parent segment (`drafts/index.md` and `final/index.md`), the way an editor does. The
tooltip always carries the full path.

**Tab state** reuses the vocabulary already rendered in the navigator tree, so a file reads the same
in both places: class glyph for R or F, staleness dot, unresolved-annotation count, and an
unsaved-edit dot. This needs dockview's `createTabComponent` hook; the default tab renderer shows a
title and a close button and nothing else.

**Diff tabs** carry the id `diff:<path>:<from>:<to>` and label `<filename> · <from>…<to>`. The same
pair of versions focuses the existing tab rather than opening a second one.

## 6. Where every control lives

The relocation is the substance of this brief. Read this table as the specification.

| Control | Today | Moves to | Scope |
|---|---|---|---|
| Navigator toggle, brand mark | top bar | unchanged | workspace |
| Artifact name and directory | top bar | tab label plus artifact bar | artifact |
| Preview / Annotate / Edit | top bar | **artifact bar** | artifact |
| History | top bar | **artifact bar** | artifact |
| Copy source, Print | top bar More | **artifact bar ⋯** | artifact |
| Approval strip | main region | **pane, sticky above the manuscript** | artifact |
| Conversation | top bar More | top bar More | workspace |
| Appearance, Keyboard shortcuts | top bar More | top bar More | workspace |
| Attention tray | top bar | unchanged | workspace |
| Agent feedback | top bar | unchanged | workspace |
| Connection banner | main region | **top bar, above the dock** | workspace |

Conversation is workspace-scoped in the code already (`conversation.js` keys on `slug` alone), so it
stays global. History is artifact-scoped (`history.js` keys on `slug` and `path`), so it moves into
the pane.

The top bar's title slot loses the artifact name and gains the workspace name. That is the honest
label for what the bar now controls.

> **Shipped delta (2026-09-21).** The title slot went the other way: it names the ACTIVE PANE's
> artifact by its workspace-relative path, and falls back to the workspace only while nothing is
> open. With several panes there is still exactly one thing the bar can honestly name — the pane
> the mode control, the shortcuts and the address bar are all addressing — and naming it is more
> use than naming the folder the navigator is already showing. The artifact bar is 40px, not 36px.
> Two further per-pane arrivals since: the #154 disk-change banner is built inside the pane, so it
> is per pane by construction, and the apply-lease pause fans out to every open pane at once.

### The artifact bar

One row, 36px, at the top of each pane's content, on `--surface` with a quiet bottom border and no
elevation.

```
┌────────────────────────────────────────────────────────────┐
│ docs/drafts/  chapter-3.md   [Preview|Annotate|Edit]  ⏱ ⋯ │
└────────────────────────────────────────────────────────────┘
```

Directory in mono metadata type, truncated from the middle; filename in label type. The mode control
is the existing segmented control. `⏱` is History. `⋯` holds Copy source, Print, Compare versions,
and the pane-movement commands from §9.

Below about 560px of pane width the bar collapses in order: the directory drops first, then the mode
control goes icon-only, then History folds into `⋯`. The filename and the mode control are the last
two things standing.

This satisfies `DESIGN.md`'s Preview Boundary Rule, which admits artifact access, the mode switch, and
More as persistent chrome. It relocates that chrome; it does not expand it.

## 7. The manuscript never moves

Two defects share one root cause. `app.css:298` reads:

```css
@media (min-width: 1280px) {
  .glosa-app[data-mode="annotate"] .glosa-main {
    padding-right: calc(var(--margin-width) + var(--space-4));
  }
}
```

It reserves the margin on mode, not on whether an annotation exists. It also keys on viewport width,
which says nothing useful once a pane is one of several.

One rule fixes both. It goes further than repairing failure 3 in §2, which describes only the shift on
mode entry; the viewport keying is a second defect that failure 3 does not name and that only becomes
visible once a pane is narrower than the window.

> **The Manuscript Never Moves Rule.** Entering Annotate, leaving it, or receiving the first
> annotation never changes the manuscript's horizontal position. The margin is placed in space the
> manuscript was never using, or it is not placed at all.

At a 68-character serif measure the text block is roughly 642px wide including its padding. Everything
else in the pane is already whitespace. The ladder puts the margin there:

| Pane inline size | Margin | Manuscript |
|---|---|---|
| ≥ 1320px | 320px rail, anchor-aligned, in existing whitespace | fixed |
| 1130–1319px | rail shrinks between 240px and 320px to fit the whitespace | fixed |
| < 1130px | bottom tray, per the 2026-07-21 brief §7.3 | fixed |

The 1130px floor is where the right-hand whitespace stops holding a 240px rail. Below it the tray is
the honest answer, and the tray was already designed.

> **Shipped delta (2026-09-21).** The floor is **1205px**. The arithmetic above assumes a 642px
> manuscript block; the built one measures 707px, because 68ch at the shipped serif is wider than
> the estimate, and the pane's scrollbar takes about another 8px. Keeping 1130 would have let the
> rail cross the manuscript through the whole 1130–1203 band. The number lives in three places that
> must move together: `MARGIN_RAIL_FLOOR`, `@container pane (min-width: 1205px)`, and
> `--manuscript-block`. The rule itself — painted in whitespace, never reserved — is unchanged.

Three consequences a builder must implement rather than infer:

Each pane declares `container-type: inline-size`, and the ladder is written as container queries, not
media queries. Pane width is the only width that matters now. Container queries are available across
glosa's browser floors (Chromium 111, Safari 16.4).

`layoutMargin`'s anchor measurement currently listens for window resize. It must observe the pane
through a `ResizeObserver` instead, because a pane changes width when a sash moves and the window does
not.

The empty margin renders nothing and reserves nothing. No `:empty` collapse trick is needed once the
rail lives in whitespace, because an empty rail occupies whitespace that was already empty.

## 8. Editor measure follows the face, not the mode

`.glosa-edit-wrap` inherits `--measure`, the prose reading measure. That is right for one of the two
editor faces and wrong for the other.

| Face | Content | Measure |
|---|---|---|
| Rich (ProseMirror) | prose | 68ch, centered — unchanged |
| Source (textarea) | markdown: tables, fences, front-matter, URLs | `min(100ch, 100%)`, left-aligned |

The Reading Measure Rule governs prose. Markdown source is not prose, and a 68-character wrap makes
tables and code fences unreadable while forcing horizontal scrolling inside a column that has room to
spare. The source face takes the pane's width up to a 100-character cap, keeps the mono face it
already has, and is the face where optional line numbers apply.

`.glosa-app[data-mode="edit"] .glosa-main { overflow: hidden }` becomes a per-pane rule.

> **Shipped delta (2026-09-21).** The source face is centred, not left-aligned: the column sits
> under the centred mode control rather than hugging the pane's left edge. The 100ch cap is as
> specified, declared on the wrap in the mono context so the toolbar and the Save row measure the
> same width as the text they frame.

## 9. Dock behavior

### Drag to split

dockview provides the interaction natively: dragging a tab over a pane shows a five-way overlay where
the center joins the group and the four edges split it, plus whole-layout edge targets.

Required option values, with the reason each is not a default:

| Option | Value | Reason |
|---|---|---|
| `dndStrategy` | `'pointer'` | HTML5 drag-and-drop is unreliable on Safari, which is inside glosa's browser floor |
| `disableFloatingGroups` | `true` | Floating groups are shadowed cards over the work, which the Flat-Until-Floating Rule forbids |
| popout windows | not used | Needs a second route and a CSP amendment; the desktop shell is their honest home |
| `noPanelsOverlay` | `'watermark'` | With `createWatermarkComponent` supplying glosa's own empty state |
| `defaultRenderer` | `'always'` | Required so class-F iframes survive a tab switch |
| panel `Constraints` | `minimumWidth: 360` | The physical floor that keeps nesting sane without an arbitrary cap |

A pane cannot be dragged narrower than 360px, which is where the compact tray ladder bottoms out. That
is the constraint on nesting: not a rule about depth, a floor on usable width.

### Dragging must not be the only way

WCAG 2.2 SC 2.5.7 (Dragging Movements) is Level AA, and `PRODUCT.md` targets WCAG 2.2 AA. Every drag
operation needs a single-pointer alternative.

dockview's keyboard docking and spatial keyboard navigation are **enterprise-only**. glosa builds the
alternative itself, on the free movement API:

- The artifact bar's `⋯` menu carries **Move tab to → Left · Right · Up · Down · New tab group**.
- The same commands are keyboard-reachable and appear in the Keyboard shortcuts sheet.

This is a release requirement, not a nicety. Ship the menu with the drag, or ship neither.

### Keyboard

Existing bindings hold. `⌘1/2/3` switches mode, `[` toggles the navigator, `n` and `p` step through
annotations, `⌘K` opens the artifact switcher.

Added:

| Binding | Action |
|---|---|
| `⌘K` | opens into the **active** pane, focusing an existing tab if one holds that file |
| `⌘W` | close the active tab, with the unsaved-edit prompt |
| `⌃Tab` / `⌃⇧Tab` | next / previous tab within the active pane |
| `⌘⌥→` / `⌘⌥←` | move focus to the next / previous pane |
| `⌘\` | **move** the active tab into a new right-hand split |

`⌘\` moves rather than copies. Splitting must never produce the same file twice.

> **Shipped delta (2026-09-21).** Every added binding above shipped. The "existing bindings" line
> did not survive intact: `[`, `n` and `p` are gone, and `⌘E` (Edit this page, or Done) was added
> beside `⌘1`/`⌘2` (Hide notes / Show notes). The list the sheet renders is `SHORTCUTS` in
> `viewer-context-surfaces.js`; `docs/accessibility.md`'s keyboard matrix is the normative
> statement, including that only the focused pane exposes a mode control.

### Theming

dockview exposes 113 CSS custom properties and accepts a `DockviewTheme` object, so the workbench look
is authored in glosa's own stylesheet without editing vendored CSS.

```js
{ name: 'glosa-workbench', className: 'glosa-dock-theme',
  colorScheme: <resolved appearance>, gap: 1,
  dndOverlayMounting: 'relative', dndPanelOverlay: 'content',
  dndTabIndicator: 'line', dndOverlayBorder: '2px solid var(--primary)' }
```

The mappings that carry the direction:

- Group background resolves to `--bg`. A pane holds paper.
- The active tab takes `--bg` and the inactive tabs take `--surface`, so the active tab reads as the
  same sheet as the manuscript below it.
- Tabs are square. The active tab is marked by a 2px olive top edge, weight, and the surface change.
  No rounding, no fill, no shadow.
- Separators and sashes resolve to the existing `1px solid var(--border)`; the sash only takes
  `--primary` while it is being dragged.
- Drop-target overlays take olive at low alpha with a 2px olive border. This is transient and marks a
  target, which the Accent Rarity Rule permits.
- Every shadow variable resolves to `none`. Floating groups are off, and nothing else in the dock
  floats.

`colorScheme` must be re-set from `appearance.js`'s resolved value through `api.updateOptions()`. It
must not read `prefers-color-scheme` on its own, or the dock will disagree with the app whenever the
reader has chosen an explicit Light or Dark override.

> **Shipped delta (2026-09-21).** The theme object and the `updateOptions` subscription are built
> as written. The accent is the hand (burnt vermilion), which is what this brief means by olive —
> see the Named rules note at the top. The active tab's top edge is ink, and neutral in an
> unfocused group (`DESIGN.md` §4 Tabs and Dock).

### Vendoring

`dockview-core@8.2.0/dist/package/main.esm.min.mjs` (374KB) is copied verbatim to
`packages/spa/src/vendor/dockview.js` and imported by relative path, alongside `idiomorph.js` and
`diff2html.js`. The file contains no bare import specifiers, so it needs no bundler and no import map,
which keeps `docs/requirements.md:343` ("no build step") intact. The `dockview` package itself is a
583-byte re-export of `dockview-core`; vendoring the core bundle is the same code.

`dockview.css` (150KB) is served from the SPA origin, which `style-src 'self'` already permits.
dockview's inline style writes are covered by the existing `'unsafe-inline'` for styles; its `nonce`
option exists if that ever tightens.

dockview core is MIT, compatible with glosa's Apache-2.0. **Do not import `dockview-enterprise`.**
Beyond keyboard docking, these documented features are enterprise-only and none of them appear in this
brief: multi-row tabs, advanced overflow search, pinned tabs, DnD compass, smart guides, auto-hide and
auto-dock edge groups, layout history, and tab context menus. Tab overflow uses the free single-row
strip with a chevron dropdown. Verify licensing before reaching for anything not listed in §9's option
table.

## 10. Persistence and URL

The URL keeps describing one focused artifact. `bootstrap.js`'s focus hash continues to carry
`{slug, artifact, mode}` for the **active pane**, which preserves the `glosa open <file>` deep-link
contract and keeps a shared URL short and legible.

The layout persists per workspace in `localStorage` under `glosa:layout:<slug>`, serialized with
`api.toJSON()` and restored with `fromJSON()` on workspace selection. This matches how `appearance.js`
already persists a preference, and it stays local-first.

Restoration is defensive by requirement:

- A panel whose artifact no longer exists is dropped during restore. `refreshArtifactIndex` already
  handles that case for one artifact; the logic generalizes.
- If restore throws for any reason, fall back to a single pane holding the URL's artifact. A corrupt
  saved layout must never make a workspace unopenable.

> **Shipped delta (2026-09-21).** The URL contract and both defensive rules shipped with the brief;
> §2's "each pane carries its own mode" did not survive a reload. A pane's mode was fixed when the
> pane was opened, and the only mode that came back was the one in the address bar — so a companion
> left in Read reopened showing its notes. Fixed in #162: the mode rides in that panel's own params
> and is saved in the same tick as the change, because dockview buffers the layout-change event a
> parameter update raises. The arrangement is still never serialized into the URL.

## 11. States

| State | Behavior |
|---|---|
| No tabs open | dockview watermark carries glosa's own empty state and its copy |
| Workspace has no artifacts | existing "No artifacts yet" copy, inside the watermark |
| Artifact deleted while its tab is open | the tab dims, the pane says the file is gone and offers Close. Never close a tab the reader opened — that silently destroys their layout |
| Closing a tab with unsaved edits | the existing `modeReducer` `blocked` path, with its existing prompt copy |
| Dragging a pane with unsaved edits | no prompt. A move is not a close |
| Class-F pane dragged between groups | **Corrected 2026-09-21 — see the callout below.** The iframe does NOT reload and does NOT re-mint. `renderer: 'always'` keeps it alive across a tab switch, a tab move and a whole-group merge alike |
| Reconnecting | one banner in the top bar above the dock, never one per pane |
| Single pane, single tab | reads as close to today's surface as the artifact bar allows. The dock must not tax the common case |

> **Shipped delta (2026-09-21).** The class-F row above was written from A1 §7's "fresh mint per
> iframe open/reload" plus the assumption that a move reparents the element. The second half is
> wrong, and it matters more than a wasted fetch: `classf-viewer.js` treats a second `load` on one
> iframe as the document navigating itself, so a reparented interactive preview would be torn down
> and reported as an error to the reader, not merely reloaded. See Reconciliation §11 for what is
> pinned where.

## 12. Constraints and open decisions

**Binding constraints.** No build step and no heavy frontend framework
(`docs/requirements.md:64`, `:343`). WCAG 2.2 AA, which makes §9's non-drag alternative mandatory.
Loopback-only origins; the SPA's CSP allows framing only the class-F port
(`docs/appendices/A3-security.md:60`). Zero external runtime calls.

**Reserved pane kinds, deliberately not built.** The pane contract is typed as a source with a kind so
that later kinds are additions rather than a rewrite.

- `browser` — an open-web pane is impossible in the SPA and would stay impossible if the CSP were
  amended, because most sites refuse framing through `frame-ancestors`. Its honest home is the
  desktop shell's `WebContentsView` (`docs/research/electron-vs-tauri.md` selects Electron).
- `loopback-preview` — an iframe restricted to `http://127.0.0.1:*` for watching a dev server. It
  needs an A3 `frame-src` amendment and a `docs/decisions.md` entry. Deferred as scope creep away
  from a writing-first product, not as a technical blocker.

**A builder must not invent these.** Do not serialize layout into the URL. Do not give the dock its
own appearance source. Do not enable floating groups or popouts. Do not move Conversation, the
attention tray, or the connection banner into panes. Do not add a bundler to consume dockview. Do not
introduce a second tab-state vocabulary; reuse the navigator tree's.

**Open decision.** dockview's framework options expose `createContextMenuItemComponent`, while the
licence page lists tab and chip context menus as enterprise. Determine which context menus are free
before relying on any. This brief specifies none, so the answer does not block implementation.
