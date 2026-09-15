---
name: glosa
description: Local-first marginal workspace for reading, marking and approving agent-drafted writing, with honest provenance.
colors:
  reading-surface: "oklch(1 0 0)"
  control-surface: "oklch(0.97 0 0)"
  sunken-surface: "oklch(0.94 0 0)"
  ink: "oklch(0.2 0 0)"
  ink-hover: "oklch(0.32 0 0)"
  muted-ink: "oklch(0.5 0 0)"
  faint-ink: "oklch(0.65 0 0)"
  quiet-border: "oklch(0.9 0 0)"
  strong-border: "oklch(0.62 0 0)"
  hand: "oklch(0.42 0.06 195)"
  hand-hover: "oklch(0.36 0.06 195)"
  pencil: "oklch(0.55 0 0)"
  hand-wash: "color-mix(in oklch, oklch(0.42 0.06 195) 14%, transparent)"
  pencil-wash: "color-mix(in oklch, oklch(0.55 0 0) 16%, transparent)"
  hand-line: "color-mix(in oklch, oklch(0.42 0.06 195) 70%, transparent)"
  anchor-wash: "color-mix(in oklch, oklch(0.42 0.06 195) 14%, oklch(1 0 0))"
  scrim: "oklch(0.2 0 0 / 0.3)"
  on-accent: "oklch(1 0 0)"
  danger: "oklch(0.5 0.16 25)"
  warning: "oklch(0.55 0.12 75)"
  success: "oklch(0.52 0.1 150)"
  dark-reading-surface: "oklch(0.19 0 0)"
  dark-control-surface: "oklch(0.225 0 0)"
  dark-sunken-surface: "oklch(0.265 0 0)"
  dark-ink: "oklch(0.93 0 0)"
  dark-ink-hover: "oklch(0.85 0 0)"
  dark-muted-ink: "oklch(0.7 0 0)"
  dark-faint-ink: "oklch(0.55 0 0)"
  dark-quiet-border: "oklch(0.3 0 0)"
  dark-strong-border: "oklch(0.5 0 0)"
  dark-hand: "oklch(0.75 0.08 190)"
  dark-hand-hover: "oklch(0.8 0.08 190)"
  dark-pencil: "oklch(0.62 0 0)"
  dark-danger: "oklch(0.7 0.14 25)"
  dark-warning: "oklch(0.74 0.11 75)"
  dark-success: "oklch(0.7 0.09 150)"
typography:
  manuscript-title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  manuscript-section:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  manuscript-subhead:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
  manuscript-body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  manuscript-body-serif:
    fontFamily: "Iowan Old Style, Charter, ui-serif, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
  manuscript-body-mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  headline:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  address:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0"
  path:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  source:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  focus: "2px"
  micro: "4px"
  tool: "5px"
  control: "6px"
  panel: "8px"
  composer: "10px"
  overlay: "12px"
  pill: "999px"
spacing:
  1: "0.25rem"
  2: "0.5rem"
  3: "0.75rem"
  4: "1rem"
  6: "1.5rem"
  8: "2rem"
  12: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-primary-disabled:
    backgroundColor: "{colors.sunken-surface}"
    textColor: "{colors.faint-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-secondary:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-secondary-hover:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-ghost-hover:
    backgroundColor: "{colors.sunken-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  segmented-track:
    backgroundColor: "{colors.sunken-surface}"
    rounded: "{rounded.panel}"
    padding: "2px"
  segmented-segment:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 {spacing.3}"
    height: "24px"
  segmented-segment-selected:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 {spacing.3}"
    height: "24px"
  menu:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.panel}"
    padding: "{spacing.1}"
    width: "13rem"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.micro}"
    padding: "{spacing.1} {spacing.2}"
  menu-row-hover:
    backgroundColor: "{colors.sunken-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.micro}"
    padding: "{spacing.1} {spacing.2}"
  nav-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tool}"
    padding: "0 {spacing.2} 0 {spacing.1}"
    height: "28px"
  nav-row-current:
    backgroundColor: "{colors.sunken-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tool}"
    padding: "0 {spacing.2} 0 {spacing.1}"
    height: "28px"
  input:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.2}"
  source-editor:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.source}"
    rounded: "{rounded.panel}"
    padding: "{spacing.4}"
  composer-input:
    backgroundColor: "transparent"
    textColor: "{colors.pencil}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "{spacing.1} 0 {spacing.2}"
  chip-intent:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "2px {spacing.2}"
  chip-intent-selected:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "2px {spacing.2}"
  chip-attribution-human:
    backgroundColor: "{colors.hand}"
    textColor: "{colors.reading-surface}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 {spacing.2}"
  chip-attribution-session:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 {spacing.2}"
  chip-attribution-unknown:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 {spacing.2}"
  margin-entry:
    backgroundColor: "transparent"
    textColor: "{colors.hand}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "{spacing.2} 0 {spacing.3}"
  margin-entry-composer:
    backgroundColor: "transparent"
    textColor: "{colors.pencil}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "{spacing.2} 0 {spacing.3}"
  margin-entry-session:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "{spacing.2} 0 {spacing.3}"
  conversation-turn-human:
    backgroundColor: "{colors.anchor-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "{spacing.3} {spacing.4}"
  provenance-line:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.metadata}"
    rounded: "0"
    padding: "{spacing.3} {spacing.8} {spacing.8}"
  dialog:
    backgroundColor: "{colors.reading-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.overlay}"
    padding: "{spacing.6}"
    width: "26rem"
---

# Design System: glosa

## Overview

**Creative North Star: "One Identity, Two Hands"**

glosa is a reading and marking instrument, not a dashboard. The manuscript is the writer's: it is set in the writer's own face, chosen per artifact (Default sans, Serif or Mono), on white paper at a book measure. Nothing in the chrome competes with it. The desk around the page is achromatic grey, hairlines and one segmented mode switch, so the only colour on the screen is the one that means *you*.

The product is recognisable by its marks, not by a typeface or an accent wash. Two hands write on the page. The human's marks are one deep teal everywhere they appear: the wash on the words in Review, the § address in the gutter, the margin entry, the caret, the selection, the focus ring, the unsaved dot, the drag target and the accent of the logo mark. A mark that has not been sent yet is the same mark in graphite, the pencil. A session never borrows either: its entries, its chips and its answers are printed in ink, on an ink hairline. Diff green and red, and the semantic danger, warning and success, are the only other hues, and each of those always arrives with a label or a shape.

The system refuses the calm-editor template (cards in a rail, one decorative accent), source-domain costumes (scriptorium, lab, score), IDE chrome, and every kind of resting elevation. Dark appearance is the same page under lower light, never an inverted console.

**Key Characteristics:**
- Achromatic neutrals in both appearances: every grey has zero chroma, so the hand is the only colour on the desk.
- Primary actions are the page's own black. The hand is never a button colour.
- Margin entries are typography on a hairline, aligned to their passage, never cards.
- Passage addresses ("§2.1") are derived from Markdown structure at render time and shown at headings in Review, on entries and in the outline. They are labels, not identities.
- A provenance line under the manuscript states, in words, who marked, what a session applied, what changed outside glosa, and what stands approved.
- Flat at rest; a shadow appears only under something genuinely floating.

## Colors

The palette is white paper, near-black ink, an achromatic desk, and one teal hand; graphite for what is not yet sent.

### Primary
- **Ink** (`oklch(0.2 0 0)`): Primary text at roughly 16:1 on paper, and the primary button. The Send, Save and Approve buttons are filled ink with paper text; hover lifts to Ink Hover (`oklch(0.32 0 0)`). A session's margin entries, their opening hairline, the focused sideline, the active tab's top edge and the current navigator row are all ink: a session's answer is *printed*.
- **The Hand** (`oklch(0.42 0.06 195)`, #0F5D5D in the source comment): The human reviewer's colour, deep teal, chosen to sit clear of link blue, danger, diff green and success. It carries the wash on annotated words in Review, the § address in the gutter and on entries, the margin entry's own words, the caret, `::selection`, the focus ring (`--focus` resolves to the hand), the unsaved-tab dot and the parked-edit dot, the dock's drag target and edge indicator, the "human" attribution chip, the human's turns in the conversation pane, the "delivered" state on an entry, and the accent path of the logo mark. Hover darkens to Hand Hover (`oklch(0.36 0.06 195)`). In dark appearance it lifts to `oklch(0.75 0.08 190)`, described in the source as the ceiling before teal glows.
- **The Pencil** (`oklch(0.55 0 0)`): The same mark before it is sent. The composer's opening hairline, its address, its "You · not sent yet" line, the graphite text being typed and the dashed rule under it are all pencil. Dark: `oklch(0.62 0 0)`.

### Washes
- **Hand Wash** (`color-mix(in oklch, var(--hand) 14%, transparent)`): The translucent wash on annotated words in Review, browser selection, and the dock's drop target. Translucent so it composes over any text colour.
- **Anchor Wash** (`color-mix(in oklch, var(--hand) 14%, var(--bg))`): The opaque form of the same wash, for surfaces: the hovered or focused mark, the underlay under a quoted passage in a margin entry, the gutter marker's fill, a selected answer option, and the human's turn in the conversation pane.
- **Pencil Wash** (`color-mix(in oklch, var(--pencil) 16%, transparent)`): The selected passage while its composer is open and unsent.
- **Hand Line** (`color-mix(in oklch, var(--hand) 70%, transparent)`): The 2px underline every annotated passage carries in every mode. In Read this line is the only trace of a mark.
- **Scrim** (`oklch(0.2 0 0 / 0.3)`): The dim behind a blocking dialog.

### Semantic
- **Danger** (`oklch(0.5 0.16 25)`): Error status text, the destructive button, the "Remove" hover, and diff deletions through the diff pane's variables.
- **Warning** (`oklch(0.55 0.12 75)`): A stale entry's dot, "Lost its place", the stale connection state, an attention notice.
- **Success** (`oklch(0.52 0.1 150)`): The "applied" state on an entry, the connected agent state, and the diff's insert colour. It appears nowhere a human mark could be mistaken for it.

### Neutral
- **Reading Surface** (`oklch(1 0 0)`): The manuscript, the active tab, menus, dialogs, panels and every button that must read as paper. Also the text colour on a primary button (`--on-primary` is the paper).
- **Control Surface** (`oklch(0.97 0 0)`): Top bar, navigator, tab strip, history and conversation panels, the compact tray, the sunken code block inside prose.
- **Sunken Surface** (`oklch(0.94 0 0)`): The segmented control's track, hover beds under rows and icon buttons, disabled fills, the dialog's byte-detail box.
- **Muted Ink** (`oklch(0.5 0 0)`): Secondary text at roughly 5.7:1: metadata, timestamps, quotes, placeholders, list markers, the resting state of most icon buttons.
- **Faint Ink** (`oklch(0.65 0 0)`): Disabled text and glyphs only, never live copy. The fore-edge hairlines mix Faint 72% toward Ink to reach 4:1.
- **Quiet Border** (`oklch(0.9 0 0)`): Structural hairlines: panel edges, the desk between panes, table rules, the provenance line's rule.
- **Strong Border** (`oklch(0.62 0 0)`): Interactive edges at or above 3:1: button and menu borders, the margin entry's opening hairline, a resting sideline, the blockquote rule, a firm table head rule.

### Dark appearance
Dark is the same desk under lower light. Every neutral stays at zero chroma: paper `oklch(0.19 0 0)`, control surface `oklch(0.225 0 0)`, sunken `oklch(0.265 0 0)`, ink `oklch(0.93 0 0)`, muted `oklch(0.7 0 0)`, faint `oklch(0.55 0 0)`, quiet border `oklch(0.3 0 0)`, strong border `oklch(0.5 0 0)`. The hand lifts to `oklch(0.75 0.08 190)` (#5fbdb3 in the source comment) and its hover to `oklch(0.8 0.08 190)`; the pencil to `oklch(0.62 0 0)`; ink hover to `oklch(0.85 0 0)`; danger, warning and success lift to `oklch(0.7 0.14 25)`, `oklch(0.74 0.11 75)` and `oklch(0.7 0.09 150)`. Whole-entry opacity for settled states is turned off in dark because it compounds contrast loss on small metadata.

### Named Rules
**The Two Hands Rule.** Everything the human marks takes the hand; everything not yet sent takes the pencil; everything a session writes is printed in ink. No exceptions, and no third colour for marks.

**The Achromatic Desk Rule.** Every neutral is `oklch(L 0 0)` in both appearances. Tinted greys are forbidden because any tint competes with the one colour that means "you".

**The Ink Actions Rule.** The primary button is the page's own black. The hand is never a button, a link or a panel wash.

**The Status Needs Shape Rule.** Danger, warning, success, delivery and provenance always carry a label, a dot or an edge treatment. A hollow dot is waiting, a filled dot is delivered or applied; a human chip is filled, a session chip is outlined in ink, an unknown chip is dashed. Colour is never the only channel.

**The Manuscript Contrast Rule.** Long-form body copy, placeholders and 12–13px metadata meet WCAG 2.2 AA in every appearance. If a muted token is marginal, mix it toward Ink; never reach for Faint on live text.

## Typography

**Manuscript Font:** the writer's face, per artifact, through one variable (`--font-manuscript`). Default is the system sans (`system-ui, -apple-system, sans-serif`) at 16px; Serif is `"Iowan Old Style", Charter, ui-serif, Georgia, serif` at 17px; Mono is `ui-monospace, "SF Mono", Menlo, monospace` at 15px. The rendered page, the rich editor and every quote that echoes the page read the same variable, so a margin entry's quote is set in the manuscript's face.
**Chrome Font:** the system sans, always.
**Mono Font:** `ui-monospace, "SF Mono", Menlo, monospace` for paths, identifiers, tool output, the byte-detail box and the source face of the editor.

**Character:** The manuscript belongs to the writer, and glosa's identity survives every face unchanged, because it lives in the marks. Iowan Old Style is named first in the serif stack on purpose: `ui-serif` resolves to New York in Safari and to nothing in Chromium, and the two faces differ by 65px over a 68ch measure. Inside the manuscript, emphasis is semibold rather than the serif's full bold, titles carry a touch of negative tracking, list markers step back to Muted Ink with tabular numerals, a blockquote hangs from a one-pixel Strong Border rule in italic muted ink, the section break is a short 4rem rule, and tables are set with horizontal rules only.

### Hierarchy
- **Manuscript Title** (600, 2rem, 1.15, −0.015em): The artifact's `h1`, in the manuscript face, with 2rem below it.
- **Manuscript Section** (600, 1.5rem, 1.25, −0.01em): The artifact's `h2`, opened by 3rem of air above and 0.75rem below.
- **Manuscript Subhead** (600, 1.125rem, 1.35): The artifact's `h3`; 2rem above, 0.5rem below, closed to 0.75rem above when it follows its section heading directly. `h4`–`h6` sit at 17px, 1.4.
- **Manuscript Body** (400, 1rem / 1.6 in the sans; 1.0625rem / 1.65 in the serif; 0.9375rem / 1.65 in mono): Rendered prose at a 68ch maximum measure with pretty wrapping and hanging punctuation.
- **Headline** (600, 1.375rem): Boot screens and screen-level headlines, balanced wrapping.
- **Title** (600, 1.1875rem): Dialog and panel titles.
- **Body** (400, 0.9375rem, 1.6): Panel prose, the conversation pane, dialog copy, tables inside the manuscript.
- **Label** (500, 0.8125rem): Buttons, tabs, menu rows, navigator rows, the annotation body, the chrome default.
- **Metadata** (400, 0.75rem): Timestamps, state labels, the provenance line, chips, the entry's first line.
- **Address** (700, 0.6875rem, tabular numerals): The § passage address, in the hand, at headings in the gutter, on entries and leading each outline row.
- **Path** (400, 0.75rem, mono): The directory in the artifact bar, a session's claimed label.
- **Source** (400, 0.8125rem, 1.7, mono): The editor's source face and rendered code blocks.

### Named Rules
**The Reading Measure Rule.** Manuscript prose stays at a 68ch maximum measure with generous line-height. Operational panels may be denser; writing never becomes a data table.

**The Prose Rhythm Rule.** Blocks in the manuscript are separated by 1.2em of the body size, list items by 0.3em, and the page opens with 4rem above the title and closes with 6rem below the last line. Headings always carry more space above than below.

**The Writer's Face Rule.** The manuscript is set in the artifact's chosen face; the chrome never follows it. Any surface that quotes the page (a margin entry's quote, the composer's quote, a session's quoted passage) is set in the manuscript face, so the thread back to the text is visible.

**The No Display Labels Rule.** Buttons, tabs, chips, paths and state labels never use expressive display typography. There is no display face; the chrome is the system sans at 13px.

## Layout

The app is a grid of top bar (3rem), an optional banner, and a main area. The main area holds a 232px navigator on the left and a dock of panes to its right; the dock's 1px gaps show the Quiet Border desk through, so a sash reads as the same one-pixel rule as every other division. Each pane is a container (`container-name: pane`) with a transparent artifact bar on top and a scrolling body below, so every artifact-scoped width rule is written against the pane, not the viewport, because two artifacts can share a screen.

The manuscript column is `--measure` (68ch) plus two 2rem gutters, centred; its painted width is fixed at 707px (`--manuscript-block`, measured in the serif face) so the margin ladder can reason about it from outside the manuscript's font context. The artifact bar spans the manuscript's width, not the pane's: it is the document's own header line. The bar collapses on its own width: at 470px History drops its word, at 400px the directory drops, at 340px the mode control goes icon-only, at 250px History folds into the More menu. The mode control is the last thing standing.

**The margin** is painted, never reserved. From a pane width of 1205px (`MARGIN_RAIL_FLOOR`) the margin is a transparent right rail between 240px and 320px wide, holding entries absolutely positioned beside their passage; it overlays whitespace and the manuscript never moves. Below that, the composer opens at its passage over the manuscript column and the saved entries move into a collection tray at the foot of the pane. The **fore-edge index** (the outline) is painted at the left edge the same way: a 24px rail of hairlines, its panel between 200px and 288px, folding into the manuscript's 2rem padding once the artifact fills the pane and standing down from hover-to-open below a 216px gutter (`OUTLINE_PANEL_FLOOR`).

Passage addresses sit in the manuscript's left 2rem gutter (`right: 100%`, 0.45em from the block's top) so no node is inserted into the rendered content and the quote-and-offset anchors stay untouched.

Compact (< 1024px) hides the logo mark, tightens the top bar, and lets the attention tray span the width. Phone widths (≤ 640px) reduce the manuscript's side padding to 1rem and stack the approval strip. Coarse pointers grow every hit target to 44px without changing the visible vocabulary. The dock floor is one pane at 360px; below that the app scrolls.

Spacing is a 4pt scale: 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3rem.

## Elevation & Depth

The workbench is flat at rest. One-pixel Quiet Border rules, the three-step surface ladder (paper, control, sunken) and spacing carry all structure. A shadow appears only under something that is genuinely above the work for a moment: a menu, a popover, the fore-edge panel, the compact composer opening at its passage, the entry preview under a hovered mark, the collection tray, and the blocking dialog. Each shadow is two layers: a tight edge that separates and a broad lift with an offset so the light has a direction. In dark appearance shadows become black-based and tighter, and the resting shadow resolves to none.

### Shadow Vocabulary
- **Menu Lift** (`box-shadow: 0 1px 2px oklch(0.2 0 0 / 0.06), 0 10px 28px -6px oklch(0.2 0 0 / 0.16)`): Every menu and popover, the fore-edge panel, the anchored composer and the mark preview.
- **Tray Edge** (`box-shadow: 0 -1px 2px oklch(0.2 0 0 / 0.05), 0 -12px 32px -8px oklch(0.2 0 0 / 0.16)`): The upward shadow on the collection tray at the foot of a compact pane.
- **Dialog Float** (`box-shadow: 0 2px 6px oklch(0.2 0 0 / 0.08), 0 24px 56px -12px oklch(0.2 0 0 / 0.24)`): The blocking dialog, paired with the Scrim backdrop.
- **Rest** (`box-shadow: 0 1px 2px oklch(0.2 0 0 / 0.06)`): Defined, and currently used by nothing; the margin entry and composer that once carried it are now hairlines.

### Named Rules
**The Flat-Until-Floating Rule.** Resting panels are flat. Shadows are forbidden unless the element is temporarily above the workspace. This is not a preference for subtle shadows: the dock's floating shadows resolve to none, not to something quieter.

**The Same Desk Rule.** Under low light a shadow is a darker patch of the same desk, not haze: black-based, tighter, and nothing at rest casts one.

## Shapes

One radius per role, and a nested corner is its container's radius minus the padding between them, so concentric shapes stay parallel instead of pinching: menu 8px − 4px padding = 4px rows; segmented track 8px − 2px = 6px segments. Focus 2px, micro 4px, tool 5px, control 6px, panel 8px, composer 10px, overlay 12px, pill 999px.

Marks on the page are square or hairline: margin entries, the composer and a session's entry open on a full-width 1px rule with no radius and no fill. Tabs are square; a rounded tab is a card and a card floats. The 2px fore-edge hairline uses the pill token to round both ends. State dots, gutter markers and drawn radios are circles. Borders are one pixel throughout; the only two-pixel edges are the active tab's ink top edge, the focused sideline, the annotation underline, the focus ring and the dock drop target.

## Components

### Buttons
- **Shape:** Gently rounded (6px), 13px medium label, padding 0.25rem 0.75rem, 1px border.
- **Primary** (Send to session, Save, Approve): Filled Ink with paper text, border the same ink. Hover lifts to Ink Hover. Disabled sits on Sunken Surface with Quiet Border and Faint text.
- **Secondary:** Paper with a Strong Border edge and Ink text; hover to Control Surface.
- **Ghost:** Transparent, Muted text, no border; hover to a Sunken bed and Ink text.
- **Danger:** Filled Danger with near-white text; hover mixes 12% toward black.
- **Focus:** Every control shares one ring: 2px solid in the hand, 2px offset, 2px radius. Text fields do not take the ring; see Inputs.
- **Recessive verbs** (Edit, Remove, Undo on a margin entry): 12px underlined muted text, no box. Edit and Undo hover to the hand; Remove hovers to Danger.

### Segmented Mode Control (Read / Review / Edit)
- **Style:** A Sunken track (8px) holding 24px segments (6px) with 2px padding and gap; labels 13px medium, Muted. Icons 14px, stroked 1.6.
- **Selected:** Paper fill, Ink text, weight 600, a 1px Quiet Border ring. The selected segment is the same paper as the manuscript below it: the tab strip's active-sheet idiom at control scale.
- **Parked edit:** A 5px hand dot in the Edit segment's corner marks an unsaved draft parked off screen.

### Menus and Popovers
- **Style:** Paper on a 1px Strong Border hairline, 8px radius, Menu Lift, 4px padding, 13rem minimum. Rows are 13px, Muted, 4px radius, hover to a Sunken bed and Ink. Disabled rows go Faint with no hover bed. Groups separate with a Quiet Border rule and 4px of air; group headings are 12px semibold Muted with 0.02em tracking.
- **The Manuscript face group:** Inside the pane's More menu, under the heading "Manuscript face", three radio rows (Default / Serif / Mono). Each row leads with an "Aa" sample set in the face it names; the chosen row is told by weight 600 and a drawn check, never by colour alone. This is a decision: a reading preference is a setting, not primary chrome, so the chooser lives in the menu and never in the artifact bar.

### Navigator
- **Style:** Control Surface with a Quiet Border on its right, 232px wide, no top padding so its first heading shares the tab strip's 36px horizon. Section labels are 11px uppercase Muted. Rows are 28px, 13px Ink, 5px radius, hover to a Sunken bed.
- **Current:** Sunken bed, Ink, weight 600. An artifact that is merely open in another pane is told apart by weight, not by a second colour.

### Tabs and Dock
- **Style:** The strip is Control Surface, 36px, with an inset 1px Quiet Border rule. Tabs are square, 13px, Muted; between resting tabs a 14px-tall Strong Border hairline, not a full-height wall. The active tab takes paper, Ink text, weight 600, 1px Quiet Border sides painted inside the box, and a 2px Ink top edge, so the sheet runs unbroken into the manuscript. An unfocused group's current tab keeps the sheet with a Strong Border top edge.
- **Unsaved:** A 7px hand dot on the tab. The unsaved edit is the human's hand, not yet on disk.
- **Drag:** The drop target is Hand Wash inside a 2px hand border, gone the instant the pointer is released. The sash takes the hand only while it is being dragged.

### Inputs / Fields
- **Style:** Paper or Control Surface, 6px radius, padding 0.5rem, Ink text; placeholders are Muted (≥ 4.5:1, never default grey). The source editor is a mono textarea at 13px / 1.7 on paper with a Quiet Border and 8px radius.
- **Focus:** Text fields take a soft ring rather than the button outline: the border turns to the hand and a 3px halo at 14–16% of the hand surrounds it. The conversation composer takes the same ring on `:focus-within`.
- **Caret:** Every textarea, input and contenteditable draws its caret in the hand.
- **The annotation composer's field** is the exception: transparent, graphite text, a 1px dashed pencil rule under the words, no box. On focus the line sharpens to solid Ink rather than glowing: writing, not a form field.

### Chips
- **Intent chips** (composer): Free-floating pills, 1px Quiet Border, 12px Muted; hover to a Strong Border and Ink; selected is transparent with an Ink border, Ink text and weight 600. Never a segmented tub.
- **Attribution chips** (history): 12px semibold pills with a 1px Strong Border. Human is filled in the hand with paper text; session is paper with an Ink border and Ink text; unknown is a dashed Muted outline. Weight and edge carry the difference as well as colour.
- **Answer options** (a session's question): 13px pills; the radio is drawn (13px ring, 7px hand dot) rather than native, and a selected option takes an Ink border, Anchor Wash fill and weight 600 together.
- **A session's claimed label:** 11px mono in a dashed Strong Border box beside the verified provider name in 600 Ink, so proven and claimed sit on one line, visibly unequal.

### The Margin Entry (signature)
Not a card. An entry is typography on the same paper as the manuscript, opened by a full-width 1px hairline at the height of its passage, with 0.5rem above and 0.75rem below, and a 0.5rem grid gap between its lines.
- **First line:** the § address in the hand (11px, 700, tabular numerals), then "You" in 12px semibold Ink. "You" is honest: every entry here was written in glosa's own composer.
- **Quote:** the passage's words in the manuscript face, italic, 13px Muted, clamped to two lines (one in the side rail), with an Anchor Wash underlay hugging the baseline half of the words like a pencil underline. An entry that has lost its place strikes the quote through and says so in 12px Warning.
- **Body:** the human's words, 13px, in the hand. Settled (applied) words recede to Muted.
- **State row:** an 8px dot (hollow Muted while waiting, filled hand when delivered, filled Success when applied, filled Warning when stale) beside a 12px label, then the intent as plain "· Change the words" metadata. Rejected, stale and dismissed entries fade to 75% in light.
- **Hover thread:** hovering the underlined passage lights the entry's hairline in the hand with a 1px inset; hovering the entry deepens the passage from Hand Line to the full Anchor Wash and turns its underline to the hand. A newly arrived entry flashes its hairline in the hand for 1.2s.
- **A session's entry** is the same object with authorship said in words: it opens on an Ink hairline, prints its provider name in Ink, its message in 13px Ink, and its quoted passage behind a 2px Strong Border sideline echoing the mark in the manuscript. It never takes the hand.

### The Composer (the entry before it is sent)
Opens on the same hairline as a sent entry, in pencil: a 1px solid pencil rule above, the address and "You · not sent yet" in pencil, the quote in the manuscript face with a graphite underlay, intent chips, the dashed-underline field, and a right-aligned row of Cancel (ghost) and Send to session (primary ink). Nothing is filled in the hand until Send. In a compact pane the composer floats over the manuscript column at its passage, capped at the manuscript's width, carrying Menu Lift because it is then genuinely above the work.

### Marks on the Page
Three marking vocabularies share the manuscript and stay distinguishable without colour. **Browser selection** is transient Hand Wash. **A human annotation** lives ON the words: a 2px Hand Line underline in every mode, plus the Hand Wash in Review; the hovered or focused one takes the opaque Anchor Wash and a hand underline. **A session's pointer** stands BESIDE the words as a 2px Strong Border sideline in the gutter, Ink and 3px while it is the passage being answered. Position, not hue, carries the difference, so a session mark and an annotation can cover the same sentence.

Read mode shows no wash. The quiet underline is the only trace of a mark, and the page stays clean paper. This is a decision.

### Passage Addresses
An address is a derived label ("§2.1": the first block under the second section; "¶3" on a headless page; a lone leading `h1` is §0 and sections count from `h2`). In Review every heading shows its address in the left gutter in the hand at 11px / 700, and any block shows its own while hovered or focused. Entries, the composer and the outline lead with the same address. Addresses renumber when the document changes; the anchor is the quote, never the label. Addresses are never inserted into the rendered content: the gutter label is a pseudo-element on the block.

### The Provenance Line (signature)
Under the manuscript, on its measure, above a Quiet Border rule: a wrapping row of facts in the chrome face at 12px, terms in 600 Ink and details in Muted. The four terms are **You** (marks, and how many are open), the **provider's name** (what it applied), **Outside glosa** (changed on disk or not), and **Approval** (approved with its revision, requested, or not requested). It reports whether the workbench's promises hold for this document; it is never a badge, and it is hidden in Edit.

### The Fore-Edge Index
A column of 2px hairlines at the pane's left edge, one per heading, placed where the heading falls in the document and cut to a length that states its depth, right edges flush. Faint mixed 72% toward Ink at rest (4:1), Muted on hover, the current section in full Ink at 3px. Focus lights the whole column on a Sunken bed with a 2px inset hand edge instead of drawing an empty capsule the height of the page. Open, it is the workbench's ordinary menu: paper, Strong Border, Menu Lift, a 28px filter line, 28px rows indented 12px per depth, each row leading with its address in the hand, the current row on a Sunken bed in Ink at 600.

### Conversation Pane
Turns are prose at 15px / 1.6 with a 12px semibold speaker label. The human's turn sits right-aligned on an Anchor Wash pill (10px radius) with the label in the hand; a session's turn sits left, unboxed, in Ink. Tool calls are 12px mono Muted disclosures. The composer is a paper box with a Strong Border and 10px radius that takes the soft hand ring on focus-within.

### History
Rows in a paper list with Quiet Border rules; attribution chips as above. The diff pane keeps diff2html's green and red, remapped in dark onto Success and Danger mixes.

### Dialog
Paper, 12px radius, 1.5rem padding, 26rem maximum, Dialog Float over the Scrim. Title at 19px / 600, copy at 15px Muted, the exact bytes in question in a Sunken mono box capped at 40vh, actions right-aligned.

### Motion
One easing (`cubic-bezier(0.25, 1, 0.5, 1)`) at 150ms for hover and colour, 200ms for position; a menu fades in with a 4px slide, the anchored composer with a 6px rise. Under reduced motion every transition and animation is removed and the arrival flash becomes a static 3px ring.

## Do's and Don'ts

### Do:
- **Do** give every human mark the hand and every unsent mark the pencil; print everything a session writes in ink.
- **Do** keep every neutral at zero chroma in both appearances.
- **Do** set the manuscript in the artifact's chosen face through the one manuscript variable, and set every quote of the page in that same face.
- **Do** open a margin entry on a hairline aligned to its passage, with no fill, no radius and no shadow.
- **Do** lead entries, the composer, the gutter and the outline with the derived § address, and treat it as a label the document can renumber.
- **Do** state provenance in words: "You", the provider's name, "Outside glosa", "Approval", "not sent yet", "Lost its place".
- **Do** pair every colour state with a shape: hollow or filled dot, filled or outlined or dashed chip, weight and edge together.
- **Do** keep the reading measure at 68ch and paint the margin and the outline over whitespace rather than subtracting a gutter.
- **Do** keep a save byte-exact: write back only the blocks the writer changed, and when writing a block back would still change bytes they did not touch, show those bytes and ask (save anyway, or drop to the source face) rather than reformatting quietly.

### Don't:
- **Don't** use the hand for a button, a link, a panel wash or a session's output.
- **Don't** put the face chooser, or any reading preference, in primary chrome; it lives in the pane's More menu.
- **Don't** wash annotated words in Read; the quiet underline is the only mark there.
- **Don't** insert nodes into the rendered manuscript for addresses or marks; the quote-based anchors depend on the DOM staying the writer's.
- **Don't** print a session's answer in line under the passage yet: the journal does not carry the applied text, so a session's entries stay in the margin, in ink. Revisit when it does.
- **Don't** draw cards in the margin, rounded tabs, resting shadows, tinted greys, nested cards or coloured side-stripe panels.
- **Don't** let colour be the only signal for waiting, delivered, applied, stale, human, session or unknown.
- **Don't** use a display face anywhere, or mono for ordinary prose.
