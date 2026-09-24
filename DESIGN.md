---
name: glosa
description: A writing desk beside an agent session. Warm paper, black ink, one vermilion hand.
colors:
  paper: "oklch(0.99 0.007 85)"
  surface: "oklch(0.97 0.006 80)"
  surface-sunken: "oklch(0.94 0.009 78)"
  ink: "oklch(0.2 0.012 60)"
  ink-hover: "oklch(0.34 0.012 60)"
  muted: "oklch(0.47 0.016 60)"
  faint: "oklch(0.64 0.012 65)"
  border: "oklch(0.88 0.01 75)"
  border-strong: "oklch(0.6 0.014 65)"
  hand: "oklch(0.52 0.16 42)"
  hand-hover: "oklch(0.46 0.15 42)"
  pencil: "oklch(0.56 0.01 65)"
  session: "oklch(0.42 0.11 255)"
  danger: "oklch(0.47 0.17 22)"
  warn: "oklch(0.53 0.11 80)"
  ok: "oklch(0.5 0.09 150)"
  dark-paper: "oklch(0.205 0.008 60)"
  dark-surface: "oklch(0.235 0.009 60)"
  dark-surface-sunken: "oklch(0.275 0.01 60)"
  dark-ink: "oklch(0.93 0.01 80)"
  dark-muted: "oklch(0.72 0.014 70)"
  dark-rule: "oklch(0.74 0.01 80)"
  dark-border: "oklch(0.32 0.01 60)"
  dark-border-strong: "oklch(0.58 0.012 65)"
  dark-hand: "oklch(0.72 0.13 45)"
  dark-pencil: "oklch(0.64 0.01 70)"
  dark-session: "oklch(0.76 0.1 250)"
typography:
  manuscript-title:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "2.5rem"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  manuscript-title-narrow:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  manuscript-section:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "1.625rem"
    fontWeight: 620
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  manuscript-section-narrow:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 620
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  manuscript-subhead:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 620
    lineHeight: 1.3
  manuscript-body:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.62
  manuscript-body-sans:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  manuscript-body-mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  note:
    fontFamily: "Source Serif 4, Iowan Old Style, Charter, Georgia, serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  headline:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.25
  bar-title:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  section-label:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  metadata:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  address:
    fontFamily: "Source Sans 3, system-ui, -apple-system, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0"
    fontFeature: "tnum"
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
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.25rem 0.75rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.25rem 0.75rem"
  button-secondary-hover:
    backgroundColor: "{colors.surface}"
  mode-control:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    rounded: "{rounded.panel}"
    padding: "2px"
  mode-control-segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "24px"
    padding: "0 0.75rem"
  composer:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.composer}"
    padding: "0.75rem 1rem 1rem"
  chip-human:
    backgroundColor: "{colors.hand}"
    textColor: "{colors.paper}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 0.5rem"
  chip-session:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.metadata}"
    rounded: "{rounded.pill}"
    padding: "0 0.5rem"
  dialog:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.overlay}"
    padding: "1.5rem"
    width: "26rem"
---

# Design System: glosa

## Overview

**Creative North Star: "The Writing Desk, Two Hands"**

glosa reads like a well-set page, not an app. The whole desk is one warm paper: the manuscript, the top bar, the navigator and the tab strip share the same ground, and the desk's outer regions are divided by printed ink hairlines rather than grey panels. Typography does the structural work. Source Serif 4 sets the manuscript, its headings, every quote of it and every note written in the margin; Source Sans 3, its designed companion, sets the chrome. Both are vendored OFL woff2 served by the daemon, so the page never reaches a font service.

Two hands write on the sheet. The human's marks are one burnt vermilion everywhere they appear: the wash and underline on the words, the § address, the note's words, the caret, the selection, the focus ring, the unsaved dot, the drag target, and the comma logo. A mark not yet sent is the same mark in warm graphite, the pencil. A session never borrows either: its entries, chips and answers are printed in ink. Actions are ink too; the chosen mode is struck forward as filled ink inside an ink outline.

Density is calm and bookish in the manuscript (18px serif on a 68ch measure) and compact in the chrome (13px sans). The surface is flat at rest; only things genuinely above the work cast a shadow. Dark is the same desk under a reading lamp: warm near-black ground, ink lifted to warm off-white, the hand lifted only as far as it stays legible without glowing.

**Key Characteristics:**
- Warm paper for the entire desk; no grey sidebar, top bar or tab strip.
- Ink hairlines mark the desk's regions: under the top bar and at the navigator's right edge.
- One colour means "you": vermilion. Pencil means "not sent yet". Ink means printed, by a session or as an action.
- Margin entries are typography on a hairline, set in the serif, never cards. The open composer is the one card.
- Passage addresses ("§2.1") are derived labels painted in the gutter, never inserted into content.
- A provenance line under the manuscript states in words who marked, what a session applied, what changed outside glosa, and what stands approved.

## Colors

Warm paper, warm near-black ink, low-chroma warm greys, one burnt vermilion hand and a graphite pencil. OKLCH is the source of truth.

### Primary
- **The Hand, Burnt Vermilion** (`{colors.hand}`, about #b03f00; 5.7:1 on paper): every human mark. The translucent wash on annotated words in Review, the 2px underline in every mode, the § address in the gutter and on entries, the note's words, the caret, `::selection`, the focus ring, the unsaved-tab and parked-edit dots, the "delivered" state, the human attribution chip, the human's turn label in the conversation, the dock's drag target and active sash, and the logo's top layer. Hover deepens to Hand Hover. Dark: `{colors.dark-hand}` (6.9:1).
- **Ink** (`{colors.ink}`; 17.6:1 on paper): body text, the primary button (Send to session, Save, Approve), the active mode segment, links, the active tab's 2px top edge, a session's entry rule and words, the session chip's edge. Hover lifts to Ink Hover. Ink is also the rule between the desk's regions (see Neutral).

### Secondary
- **The Pencil, Warm Graphite** (`{colors.pencil}`; 4.5:1 on paper): the same mark before it is sent. The composer's 2px top rule, its address and "You · not sent yet", the typed text and the dashed rule under it, the graphite underlay under its quote, and the pencil wash on the selected passage while the draft is open. Dark: `{colors.dark-pencil}`.

### Washes
- **Hand Wash** (hand at 14% over transparent): annotated words in Review, selection.
- **Anchor Wash** (hand at 14% mixed into paper, opaque): the hovered or focused mark, the underlay under an entry's quote, the human's conversation turn.
- **Pencil Wash** (pencil at 16% over transparent): the passage held by an open composer.
- **Hand Line** (hand at 70% over transparent): the 2px underline every anchored passage carries; the only trace of a mark in Read.
- **Scrim** (ink at 30%; black at 45% in dark): behind a blocking dialog.

### Session
- **Session Ink, Blue-Black** (`{colors.session}`; about 8.9:1 on paper): a session's mark on the page and nothing else: the bracket in the gutter, its tab (paper text on Session Ink) and the "{provider} asks" label printed in the margin beside it, the dotted rule under a pointer's words, the "?" glyph on the question notice, and the 1.5px top rule of a session's card (2px on the card that floats at a passage). Dark: `{colors.dark-session}`.
- **Session Wash** (Session Ink at 10% over transparent, 14% in dark): the wash on the exact words a question is about, and the ground under a session's quote on its card. The words of the request the reader is on, or whose card is hovered or focused, take a second wash over the first, so they read deeper without a third colour.

### Semantic
- **Danger, Crimson** (`{colors.danger}`; 7.3:1): errors, destructive actions, the Remove hover, diff deletions. Held apart from the hand by hue and lightness.
- **Warning, Ochre** (`{colors.warn}`; 5.2:1): stale entries, "Lost its place", attention notices.
- **Success, Sage** (`{colors.ok}`; 5.6:1): the "applied" state and the diff's insert colour; never anywhere a human mark could be mistaken for it.

### Neutral
- **Paper** (`{colors.paper}`): the manuscript and the whole desk (`--desk` resolves to paper), menus, dialogs, the composer, the active tab. Also the text on filled ink and filled hand.
- **Surface** (`{colors.surface}`): code beds, the compact collection tray, secondary-button hover; the composer and dialog fill in dark.
- **Sunken** (`{colors.surface-sunken}`): hover beds under rows, tabs and mode segments; disabled fills.
- **Muted Ink** (`{colors.muted}`; 6.7:1): metadata, timestamps, quotes, placeholders, section labels, resting icons and inactive mode labels.
- **Faint** (`{colors.faint}`): disabled text only, never live copy.
- **Quiet Border** (`{colors.border}`): rules inside a region: the tab strip's bottom rule, dock separators, the provenance line's rule, the palette query line, table rules.
- **Strong Border** (`{colors.border-strong}`; 3.9:1): interactive edges: secondary buttons, the margin entry's opening hairline, the blockquote rule, the section-break rule, the composer's edge.
- **Region Rule** (`--rule`): ink in light; `{colors.dark-rule}` (7.8:1) in dark, stepped below text ink so a full-width rule does not glare. Draws the top bar's bottom edge, the navigator's right edge and the mode control's outline.

### Named Rules
**The Two Hands Rule.** Everything the human marks takes the hand; everything not yet sent takes the pencil; everything a session writes is printed in ink. A session's *mark on the page* (the bracket beside the block it asks about or points at, and the wash or dotted rule on its words) takes Session Ink, and that is the only thing that does (#308). Session Ink is never a button, a link, a panel fill or the colour of a session's words.

**The Paper Desk Rule.** The desk is one paper. Chrome regions do not get their own grey fill; they are separated by the Region Rule. Tinted neutrals stay warm and low in chroma so nothing competes with the hand.

**The Ink Actions Rule.** Buttons and the chosen mode are the page's own ink. The hand is never a button, a link or a panel fill.

**The Status Needs Shape Rule.** Danger, warning, success, delivery and provenance always carry a label, a dot or an edge. A hollow dot is waiting; a filled dot is delivered (hand), applied (success) or stale (warning). A human chip is filled, a session chip is outlined in ink, an unknown chip is dashed. Colour is never the only channel.

**The Manuscript Contrast Rule.** Body copy, placeholders and 12–13px metadata meet WCAG 2.2 AA in both appearances. Pencil sits exactly at the 4.5:1 floor, so it is never lightened further; Faint never carries live text.

## Typography

**Manuscript Font:** Source Serif 4 (fallback Iowan Old Style, Charter, Georgia), variable weight, `font-optical-sizing: auto` so titles take the display cut and body the text cut.
**Chrome Font:** Source Sans 3 (fallback system-ui).
**Mono Font:** ui-monospace, SF Mono, Menlo, for paths, identifiers, tool output, code and the source editor.

**Character:** A book serif and its designed sans, used at restrained weights (600–650 headings, 600 emphasis) so the page reads as typeset rather than as a magazine.

The writer can switch a page's face in the pane's More menu (Default = serif, Sans, Mono) through one variable, `--font-manuscript`, with its own size and leading. The chooser rows lead with an "Aa" sample in the face they name; the chosen row is told by weight and a drawn check.

### Hierarchy
- **Manuscript Title** (650, 2.5rem, 1.1, −0.015em): the artifact's `h1`, 2rem below. It scales with the pane, not the viewport: full size from an 800px pane, down to **Manuscript Title Narrow** (1.875rem) at 400px and below.
- **Manuscript Section** (620, 1.625rem, 1.25, −0.01em): `h2`, 3rem above, 0.75rem below. It scales with the pane too, down to **Manuscript Section Narrow** (1.5rem), so the title keeps its lead at every width.
- **Manuscript Subhead** (620, 1.25rem, 1.3): `h3`, 2rem above, 0.5rem below; closes to 0.75rem above when it follows its section directly. `h4`–`h6` at 600, 17px, 1.4.
- **Manuscript Body** (400, 18px / 1.62 serif; 16px / 1.6 sans; 15px / 1.65 mono): prose on a 68ch measure, pretty wrapping, hanging punctuation. Emphasis is 600, not the full bold.
- **Note** (400, 15px / 1.45, serif): the words of a margin entry, the composer field and a session's message, in the serif whatever the page face. Notes are writing, not chrome.
- **Headline** (600, 22px, sans): boot screens. **Title** (600, 19px): dialogs and panels. **Bar Title** (600, 14px): the active artifact's path, centred in the top bar.
- **Body** (400, 15px / 1.6, sans): panel prose, the conversation, dialog copy.
- **Label** (500, 13px): buttons, tabs, menu rows, navigator rows; the chrome default.
- **Section Label** (600, 12px, 0.06em, uppercase, Muted): the heading of a real list: navigator sections, the margin's title and open/settled divider. The Go to palette's group headings use 11px at 0.04em.
- **Metadata** (400, 12px): timestamps, state rows, chips, the provenance line.
- **Address** (700, 11px, tabular numerals, sans): the § passage address.
- **Source** (400, 13px / 1.7, mono): the source editor; code blocks in prose at 13px / 1.6.

### Named Rules
**The Reading Measure Rule.** Manuscript prose stays at a 68ch measure. Blocks are separated by 1.2em of the body size; the page opens with 4rem above the title and closes with 6rem below. Headings carry more space above than below.

**The Serif Is Writing Rule.** Anything a person or a session wrote (the manuscript, its quotes, margin notes, the composer field, a session's message) is set in serif; anything the application says (buttons, tabs, states, addresses, provenance) is set in Source Sans 3. Quotes of the page follow `--font-manuscript` so the thread back to the text is visible.

**The Section Label Rule.** Uppercase tracked labels name a list that follows them. They never sit above a headline as a decorative lead-in.

## Layout

A grid of top bar (3rem), an optional banner and a main area. The main area holds a 232px navigator and a dock of panes. The top bar has three columns with equal outer columns, so the path title sits at the bar's true centre; the logo sits left, connection state and More sit right. The navigator's show/hide toggle is pinned in the desk's bottom-left corner on a 44px foot strip, so it never shifts the logo. The navigator has no top padding: its first section label shares the tab strip's 36px horizon.

Each pane is a container (`pane`), so width rules are written against the pane, not the viewport. The artifact bar (40px, its own `bar` container) holds the directory at left in mono, the mode control on the pane's centre line, and History and More at right; the right column never shrinks, so the path gives way first. It collapses on its own width: at 520px History drops its word, at 440px the directory drops, at 400px the mode control goes icon-only, at 270px History folds into More.

The manuscript column is 68ch plus two 2rem gutters, centred; its painted block is fixed at 707px (`--manuscript-block`) so the margin ladder can reason about it from outside the manuscript's font. The serif at 18px paints 688px, inside that block, so the rail floor did not move.

**The margin** is painted, never reserved: the manuscript never moves when Review is entered or the first entry arrives. From a pane width of 1205px the margin is a right rail (240–320px) of what has a place on the page: open entries whose words are still there, and a session's cards, each positioned beside its passage over whitespace. The rail carries no headings, because page order is its grouping. What has no place (settled entries, and open entries that lost their place) is in the rail's drawer: the collection tray, the rail's width, at the pane's foot, shown only when it holds something, its strip counting "N lost its place · N resolved" with a Warning dot for the first. Below 1205px the tray spans the pane and holds every entry and card, under their headings. At every width the composer opens at its passage: directly under the selection (flipping above it when there is no room), aligned to its first word and held inside the manuscript column, 26rem wide. A draft never opens in the rail, where it sat far from the words just selected. The outline is reached through Go to (⌘K), never through the gutter.

Compact (≤ 1023px) hides the logo, tightens the top bar and lets the tray span the width. Phone (≤ 640px) stacks the approval strip. The manuscript keeps both 2rem gutters at every width, because its marks live there: the § addresses and a session's brackets and tabs on the left, the note dots on the right. The title and section heading shrink with the pane instead. Coarse pointers grow hit targets to 44px without changing the visible vocabulary. The dock floor is one 360px pane; below that, the app scrolls.

Spacing is a 4pt scale: 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 3rem.

## Elevation & Depth

Flat at rest. Paper, hairlines and spacing carry all structure. A shadow appears only under something temporarily above the work: menus and popovers, the Go to palette, the composer, the collection tray and the blocking dialog. Every shadow is two layers, a tight separating edge and a broad offset lift, tinted with warm ink (`0.2 0.012 60`). In dark the shadow ink becomes black and tighter, and the resting shadow resolves to none; the dialog and composer lift one surface step instead, and the dialog drops its shadow.

### Shadow Vocabulary
- **Menu Lift** (`box-shadow: 0 1px 2px oklch(0.2 0.012 60 / 0.06), 0 10px 28px -6px oklch(0.2 0.012 60 / 0.16)`): menus, popovers, the composer, the compact mark preview.
- **Tray Edge** (`box-shadow: 0 -1px 2px oklch(0.2 0.012 60 / 0.05), 0 -12px 32px -8px oklch(0.2 0.012 60 / 0.16)`): the collection tray at a compact pane's foot.
- **Dialog Float** (`box-shadow: 0 2px 6px oklch(0.2 0.012 60 / 0.08), 0 24px 56px -12px oklch(0.2 0.012 60 / 0.24)`): the blocking dialog over the Scrim.

### Named Rules
**The Flat-Until-Floating Rule.** Resting panels, entries, tabs and bars cast no shadow. A shadow is earned only by being temporarily above the workspace.

**The Same Desk Rule.** Under the lamp, a shadow is a darker patch of the same desk, not haze.

## Shapes

One radius per role: focus 2px, micro 4px, tool 5px, control 6px, panel 8px, composer 10px, overlay 12px, pill 999px. A nested corner is its container's radius minus the padding between them (mode track 8px − 2px = 6px segments; menu 8px − 4px = 4px rows).

Marks on the page are square or hairline. Margin entries open on a full-width 1px rule with no radius and no fill; tabs are square. State dots and drawn radios are circles; chips are pills. Borders are 1px; the 2px edges are the active tab's ink top, the composer's pencil top, the annotation underline, the focus ring and the drag target.

The logo is the comma overprinted: an ink layer at 45% opacity offset down and right, with the vermilion comma printed opaquely on top, so the ink shows only as an offset edge. In dark the under layer is Muted at 60%.

## Components

### Buttons
Quiet and ink-led.
- **Shape:** gently rounded (6px), 13px medium label, 0.25rem 0.75rem padding, 1px border.
- **Primary** (Send to session, Save, Approve): filled ink, paper text; hover to Ink Hover. Disabled: Sunken fill, Quiet Border, Faint text.
- **Secondary:** paper, Strong Border edge, ink text; hover to Surface. **Ghost:** transparent border.
- **Focus:** one ring for every control: 2px solid hand, 2px offset, 2px radius.
- **Recessive verbs** (Edit, Remove, Undo on an entry): 12px underlined Muted text, no box. Edit and Undo hover to the hand; Remove hovers to Danger.

### Page Control (Notes · Edit, or Done)
- **Style:** an ink outline (1px inset Region Rule) on paper, 8px radius, 2px padding and gap, centred in the artifact bar. Buttons are 28px, 6px radius, 13px medium Muted labels with icons; hover to a Sunken bed and ink.
- **Reading:** a Notes toggle and Edit. Notes shown is a quiet pressed bed (Sunken, ink) rather than a fill, because showing notes is a view of the same page. The toggle's accessible name says what it does: "Hide notes" or "Show notes".
- **Editing:** only Done, struck forward as filled ink with paper text at 600, because editing is the state the page is in. Done returns to whichever view was left.
- **Paused:** while a session holds the workspace's apply lease, Edit is disabled and says why; a draft already open stays open with a status line.
- **Parked edit:** a hand dot on Edit marks an unsaved draft parked off screen.

### Go to Trigger
- **Style:** the top bar's title, drawn as a quiet field: 30px, Quiet Border, 6px radius, Surface fill, the stable label “Search artifacts and chats” in 14px/600 ink on the left and a `⌘K` keycap (11px/600 Muted in a Quiet Border box on paper) on the right. Hover sharpens the edge to Strong Border on paper.
- **Behaviour:** a button, not an input: clicking it opens the Go to palette, which searches artifacts and chats together. All, Artifacts, Chats and Commands filters share one query. Existing `#`, `/`, `@` and `>` prefixes still reach sections, files, workspaces and commands. Chat search includes older and archived conversations, with more results available inside the palette.

### Edit on the Page
- **Scrolling:** the page scrolls in Edit, never an inner editor box. The formatting toolbar (with the Rich/Source toggle on its row) sticks to the top of the pane, and the Save row sticks to the bottom on paper above a Quiet Border rule. The source face grows with its text.
- **Place:** entering and leaving Edit keeps the page's scroll position.

### Navigator
- **Style:** paper, ink hairline at its right, 232px. Section labels in the Section Label style. Rows are 28px, 13px ink, 5px radius, hover to a Sunken bed; the current row is Sunken, ink, 600.

### Tabs and Dock
- **Style:** a 36px strip on paper with a Quiet Border bottom rule painted as an inset, so the active tab runs unbroken into the manuscript. Tabs are square, 13px, Muted; the active tab is paper, ink, 600, with Quiet Border sides and a 2px ink top edge (a neutral edge in an unfocused group).
- **Unsaved:** a hand dot. **Drag:** Hand Wash inside a 2px hand border; the sash takes the hand only while dragged.

### Inputs / Fields
- **Style:** 6px radius, ink text, Muted placeholders. Source editor: mono 13px / 1.7.
- **Focus:** the border turns to the hand with a 3px halo of hand at 14%.
- **Caret:** the hand, in every field.
- **Intent choice** (composer): three drawn radios in a row that wraps, no boxes. Each is a 13px circle with a 1.5px Strong Border beside a 13px Muted label. Chosen, the circle takes an ink edge and a 7px ink dot, and the label turns ink. Its weight never changes, so the row holds still. Hover lifts the label and an empty circle's edge to ink. It is the same radio a session's question draws. One choice of three with one already made is a radio group, never a row of pills: pills read as tags you can pick several of.

### Chips
- **Attribution chips** (history): 12px 600 pills. Human: filled hand, paper text. Session: paper, ink border, ink text. Unknown: dashed Strong Border, Muted.

### The Margin Entry (signature)
Typography on a hairline, not a card: a 1px Strong Border rule at the passage's height, 0.5rem above and 0.75rem below, 0.5rem between lines.
- **Head:** the § address in the hand (11px, 700, tabular) then "You" in 12px 600 ink.
- **Quote:** the passage in `--font-manuscript`, italic, 13px Muted, clamped to two lines, over an Anchor Wash underlay on the lower third of the words. An open entry whose anchor is lost strikes the quote through and says "Lost its place — the passage has changed." in 12px 600 Warning. A settled entry whose words are gone lost nothing: "Applied. The passage now reads differently." (closed or dismissed: "The passage has changed since.") in 12px Muted, over an unstruck quote.
- **Note:** the human's words in the Note style, in the hand; applied notes recede to Muted.
- **State row:** an 8px dot (hollow Muted waiting, filled hand delivered, filled Success applied, filled Warning stale) beside a 12px label and the intent as "· Change the words", and "· nudged ×N" only while the entry is open. Rejected, stale and dismissed entries fade to 75% in light. Settled entries carry "Clear" (one card) and, under the tray's "Resolved" heading, "Clear all".
- **Hover thread:** hovering the passage lights the entry's rule in the hand; hovering the entry deepens the passage to Anchor Wash with a hand underline. A new entry flashes its rule in the hand for 1.2s.
- **A session's entry:** the same object with a 1.5px Session Ink rule (the same ink as its bracket, so the two read as one object in two places), the verified provider name in 600 ink beside its claimed label in a dashed box, and its message in the Note style, in ink. Its quote sits on Session Wash. It never takes the hand.

### The Question Notice
A 1-row strip under the artifact bar, on paper over a Region Rule, shown whenever a session's question is not beside its words: the passage is off screen, the pane is not in Review, or there is no rail and the question's card is not open. An 18px Session Ink "?" glyph, "{provider} is asking about a passage" with the provider in 600, the passage address, a count when several are open ("1 of 3", oldest first), a primary **Go to it** and a drawn dismiss. glosa never scrolls or switches mode for an arriving request; this strip is the only thing that reaches a reader who is elsewhere. After the reader goes it offers **Back to where you were**. A passage that cannot be located is never offered as somewhere to go: the strip says so and the button reads "Show the question". A question about an artifact no pane has open is offered by the active pane, with the file's name.

### The Question at Its Passage
Below the rail floor the question the reader is on floats at its passage: under the block its words are in, so the rest of that paragraph stays readable while it is answered, with its left edge on the bracket's line so the card hangs from the mark it belongs to. It opens above the block only when there is no room below once "Go to it" has come to rest, never measured against the place the reader is leaving. 26rem wide, paper (Surface in dark), 1px Strong Border, 2px Session Ink top rule, 10px radius, Menu Lift. Unlike the composer it is not clamped into view: a draft follows its writer, a question belongs to its words. It carries the provider and claimed label, the message, the options, the free-text field, Can't answer and Send answer, and a drawn close. The tray lists the same question as a row with "Answer at the passage", so there is only ever one live answer form.

### The Composer
The entry before it is sent, and the one card on the page, because an open draft is above the work for a moment. It floats under the passage it is about, in its own layer in the pane's scroll space, so it travels with the words: paper (Surface in dark), 1px Strong Border, 2px pencil top rule, 10px radius, Menu Lift, 0.75rem 1rem 1rem padding. The address and "You · not sent yet" in pencil, the quote over a graphite underlay, the intent radios, a transparent field in pencil Note type over a 1px dashed pencil rule that turns solid ink with ink text on focus, then Cancel and Send to session. Nothing takes the hand until Send. On Send at rail widths, the new entry travels from the draft's place to its own beside the passage (280ms, the standard easing), so the reader sees where the note went.

### Mark Preview
Hovering an annotated passage where the rail is not shown opens the entry under its words as a floating card: paper fill, 1px Strong Border, 10px radius, 0.75rem 1rem padding, Menu Lift. Unlike an entry in the rail it has its own paper, because it floats over the manuscript.

### Marks on the Page
- **Selection:** transient Hand Wash.
- **A human annotation** lives on the words: the 2px Hand Line underline in every mode, plus Hand Wash in Review; hovered or focused, the opaque Anchor Wash with a hand underline. Read shows no wash.
- **A session's mark** works at two levels, both in Session Ink and both out of the manuscript's flow. The **block** gets a proofreader's bracket in the gutter: a 1.5px `[` 20px left of the text column, spanning the block (or run of blocks) the words are in, with 6px ticks turned toward the text so it reads as a mark in the margin, not a stripe. On it sits a 20px filled tab for each request, level with the line its words start on. The **words** are marked exactly, through the highlight registry, so nothing is inserted into the rendered text. A **question** holds its session until answered: its words take Session Wash, its tab carries "?", and "{provider} asks" is printed in 11px 600 Session Ink in the page's margin beside the tab. Where the pane has no margin to print in, the label hides and the tab's accessible name carries the words. A **pointer** puts a 1.5px dotted rule under its words and an arrow on its tab, with no wash and no label. Requests in the same block share its bracket and keep a tab each; tabs whose words start on one line are pushed apart. While a card is hovered or focused its bracket thickens to 2px and its words take the second wash. On arrival the bracket thickens once (1.2s) and the tab pops. The reader's marks are the hand's wash and solid rule on the words; a session's are its own ink, and only a session's mark has a bracket and a tab, so both can sit on one sentence and the difference survives greyscale. The mark is never an outline around the words themselves: that outline has only the line's leading to live in, so it runs through the line above and its label lands on that line's words. It is meant to be seen at once.

### Passage Addresses
A derived label ("§2.1"; "¶3" on a headless page; a lone leading `h1` is §0). In Review, headings show their address in the 2rem gutter in the hand, positioned `right: 100%` at 0.45em, and any block shows its own while hovered or focused, except beside a session's bracket, where the tab says the address instead. Entries, the composer and Go to lead with the same label. Addresses renumber with the document; the anchor is the quote. The gutter label is a pseudo-element; nothing is inserted into rendered content.

### The Provenance Line (signature)
Under the manuscript, on its measure, above a Quiet Border rule: a wrapping row of facts in 12px sans, terms in 600 ink and details in Muted: **You**, the **provider's name**, **Outside glosa**, **Approval**. The provider's "N applied" is underlined and opens the tray on the settled entries, since they are not in the rail. Never a badge; hidden in Edit.

### Go to (⌘K)
A 36rem sheet 12vh from the top over the Scrim: a 44px transparent query line at 15px sans on a Quiet Border rule (hand on focus), groups under 11px uppercase Muted headings, the document's sections first (28px rows indented 12px per depth, each leading with its address in the hand), then workspace files with their folder trailing in Muted. The selected row sits on a Sunken bed.

### Conversation Pane
Managed chat uses right-aligned human bubbles (sans, Surface, up to 80% of the column) and unboxed assistant prose on the left (serif). Author names remain available to assistive technology but are not printed above every message. Tool calls and reported settings remain disclosures. Copy actions appear on hover or keyboard focus.

The composer has a borderless text area and compact, borderless model and effort controls sized to their selected labels, with accessible names. The model button opens a versioned model list plus the current Subscription row. Selecting that row replaces the model list with a compact subscription view and Back action; do not stack both lists. Same-agent subscriptions stay with the chat, while another agent opens a new chat after submission. Attachments, Stop, Send and native tool approvals remain operable; no Plan mode selector is shown. Model and effort share the same quiet control treatment and explanatory hover/focus tooltips. Effort adds a compact monochrome four-bar indicator, consistently mapped across providers. Model labels always include the provider-reported version; retain resolved alias metadata and never hardcode a family’s latest version. Older entries without version metadata say “version not reported” until models are refreshed. The picker shows one row per resolved model; default status belongs in its tooltip, not a duplicate row. A context suffix appears in the label only when the discovered catalog contains a distinct context variant. Existing chats retain their selected wire alias. Tooltips expose the concrete model ID, context and alias relationship. At narrow pane widths controls wrap. The sidebar shows at most 20 title-only conversation rows, pinned first, without a count or separate search field. A hover/focus menu supplies Pin/Unpin; older chats remain searchable. Row hover text contains only the title, never account metadata, and hover is quieter than the selected state.

### Settings
The sidebar footer and shared palette open Settings. Agents & accounts and Appearance are separate destinations within the page. Small monochrome Claude asterisk and OpenAI knot marks follow the selected reference; local Lobe Icons geometry carries its MIT attribution. Show installation first when a runtime is missing. Installation reports its native phase, elapsed time, completed package count and approximate completed archive bytes beside an indeterminate indicator. A quiet installer and an interrupted status connection have distinct notices; polling continues until the outcome is known. No percentage or transfer rate is inferred from incomplete counters. Installation disables dependent controls; account setup remains visibly disabled until the runtime and the build are ready. Account navigation displays a compact list and one selected detail pane, preserving identity, default, enable/disable, authentication, model discovery, MCP and cleanup actions.

Healthy runtime maintenance is a collapsed disclosure above Accounts; missing, failed and active installations retain the prominent setup treatment. Account labels wrap and show the signed-in identity, with connection health separate from the Default marker. At narrow widths a compact account chooser reveals the list and closes after selection, keeping the selected account's controls in view. Disabled accounts lead with Enable account and explain its scope; Disable account lives with sign-out and removal in a separate account-access menu group. Eligible accounts expose Make default beside their routine action. Menus fit their contents, keep compact rows, and return keyboard focus on dismissal. Rename account focuses the editable name; Escape restores its saved value. Failed actions retain their message and offer Refresh settings; refresh preserves unfinished account labels and stays available during uncertain installation status. Settings controls have 36px targets, expanded to 44px for coarse pointers.

### Dialog
Paper, Quiet Border, 12px radius, 1.5rem padding, 26rem maximum, Dialog Float over the Scrim. Title 19px 600, copy Muted, actions right-aligned.

### Motion
One easing (`cubic-bezier(0.25, 1, 0.5, 1)`), 150ms for hover and colour, 200ms for position. Menus and the palette fade in with a short 4–6px slide; the composer rises 6px into place under its passage. The product's one authored moment is the send: a copy of the new entry glides from the draft to its place in the rail in 280ms while the real entry waits invisible beneath it. Under reduced motion transitions and animations are removed.

## Do's and Don'ts

### Do:
- **Do** give every human mark the hand, every unsent mark the pencil, and print everything a session writes in ink. Draw a session's mark on the page, and only that, in Session Ink.
- **Do** keep the whole desk on paper and divide the desk's regions with the Region Rule (ink in light, `oklch(0.74 0.01 80)` in dark).
- **Do** set anything written (manuscript, quotes, notes, the composer field, a session's message) in Source Serif 4, and everything the application says in Source Sans 3.
- **Do** strike the chosen mode forward as filled ink inside the ink outline.
- **Do** open a margin entry on a hairline aligned to its passage, with no fill, no radius and no shadow.
- **Do** lead entries, the composer, the gutter and Go to with the derived § address, and treat it as a label the document can renumber.
- **Do** state provenance in words: "You", the provider's name, "Outside glosa", "Approval", "not sent yet", "Lost its place".
- **Do** pair every colour state with a shape: hollow or filled dot, filled, outlined or dashed chip.
- **Do** keep the reading measure at 68ch and paint the margin over whitespace rather than moving the manuscript.
- **Do** serve every face from the vendored OFL woff2 files; the runtime never reaches a font service.

### Don't:
- **Don't** use the hand for a button, a link, a panel fill or a session's output.
- **Don't** use Session Ink for a button, a link, a panel fill or a session's words; it marks a passage and names that mark, nothing more.
- **Don't** scroll, switch mode or move focus because a session's request arrived. Offer the way there.
- **Don't** give chrome regions a grey fill of their own; the desk is one paper.
- **Don't** put the face chooser or any reading preference in primary chrome; it lives in the pane's More menu.
- **Don't** wash annotated words in Read; the underline is the only mark there.
- **Don't** insert nodes into the rendered manuscript for addresses or marks.
- **Don't** draw cards in the margin (the open composer excepted), rounded tabs, resting shadows or coloured side-stripe panels.
- **Don't** let colour be the only signal for waiting, delivered, applied, stale, human, session or unknown.
- **Don't** set uppercase tracked labels above headlines as lead-ins; they only head a list.
- **Don't** lighten the pencil or use Faint for live text; both are already at their floor.
