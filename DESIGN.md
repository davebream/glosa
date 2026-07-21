---
name: glosa
description: Local-first marginal workspace for reviewing, annotating, and routing AI-assisted writing artifacts.
colors:
  reading-surface: "oklch(1 0 0)"
  control-surface: "oklch(0.972 0.004 110)"
  sunken-surface: "oklch(0.945 0.006 110)"
  ink: "oklch(0.24 0.01 110)"
  muted-ink: "oklch(0.46 0.012 110)"
  faint-ink: "oklch(0.62 0.01 110)"
  quiet-border: "oklch(0.9 0.005 110)"
  strong-border: "oklch(0.82 0.008 110)"
  workbench-olive: "oklch(0.5 0.1 110)"
  workbench-olive-hover: "oklch(0.44 0.1 110)"
  anchor-wash: "oklch(0.94 0.032 120)"
  danger: "oklch(0.5 0.16 25)"
  warning: "oklch(0.55 0.12 75)"
  success: "oklch(0.52 0.1 150)"
  on-accent: "oklch(0.99 0 0)"
  dark-reading-surface: "oklch(0.19 0.012 110)"
  dark-control-surface: "oklch(0.235 0.014 110)"
  dark-sunken-surface: "oklch(0.275 0.016 110)"
  dark-ink: "oklch(0.92 0.012 105)"
  dark-muted-ink: "oklch(0.72 0.014 105)"
  dark-faint-ink: "oklch(0.56 0.012 105)"
  dark-quiet-border: "oklch(0.32 0.014 110)"
  dark-strong-border: "oklch(0.5 0.018 110)"
  dark-workbench-olive: "oklch(0.68 0.085 110)"
typography:
  manuscript-title:
    fontFamily: "ui-serif, Iowan Old Style, Georgia, serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
  manuscript-subhead:
    fontFamily: "ui-serif, Iowan Old Style, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  headline:
    fontFamily: "ui-serif, Iowan Old Style, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "ui-serif, Iowan Old Style, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
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
    backgroundColor: "{colors.workbench-olive}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-primary-hover:
    backgroundColor: "{colors.workbench-olive-hover}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.1} {spacing.3}"
  input:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.2}"
---

# Design System: glosa

## 1. Overview

**Creative North Star: "The Annotated Workbench"**

glosa is a precise reading and review instrument. The manuscript is the page; navigation, annotations, provenance, and agent state form the quiet desk around it. The interface is light-first because its primary scene is a writer reviewing long work for hours in ordinary daylight, but appearance choices must preserve the same hierarchy rather than recasting the product as a developer console.

The visual system combines iA Writer's typographic calm, a copy editor's marked manuscript, and Linear-grade operational clarity only where state needs to be explicit. It rejects generic AI-workflow dashboards, SaaS landing-page gloss, dark-mode purple gradients, glassmorphism, decorative agent theatrics, and cmux-shaped language or structure.

**Key Characteristics:**
- Rendered writing dominates a stable 68ch reading measure.
- Control surfaces are quiet, flat, and slightly sage-tinted.
- One olive accent is rare and functional.
- Provenance and delivery state are stated with text or shape as well as color.
- Responsive behavior collapses chrome before compromising the manuscript.

## 2. Colors

The palette is a daylight editor's desk: white paper, sage-tinted furniture, dark ink, and one olive pencil.

### Primary
- **Workbench Olive:** Marks primary actions, selection, focus, the active annotation, and known session provenance.

### Neutral
- **Reading Surface:** The manuscript, editors, dialogs, and controls that must feel like paper rather than chrome.
- **Control Surface:** Top bar, navigator, contextual margin, history, and conversation panels.
- **Sunken Surface:** Segmented tracks, hover beds, and disabled controls.
- **Ink / Muted Ink / Faint Ink:** A deliberate three-level text hierarchy; muted copy remains AA-readable and faint copy is reserved for disabled or large tertiary glyphs.
- **Quiet Border / Strong Border:** Structural separation and interactive boundaries without resting elevation.

### Named Rules

**The Accent Rarity Rule.** Workbench Olive marks action, focus, selection, or trustworthy state and occupies no more than ten percent of a screen. It never becomes a decorative panel wash.

**The Status Needs Shape Rule.** Danger, warning, success, delivery, and provenance always carry a label, icon, or border treatment. Color is never the only channel.

**The Manuscript Contrast Rule.** Long-form body copy and placeholders meet WCAG 2.2 AA in every appearance. If a muted token is marginal, move it toward Ink.

### Appearance

Light and dark are two readings of the same workbench, not independent themes. Dark mode uses warm olive-charcoal surfaces, parchment ink, and a lifted Workbench Olive; it does not invert the light palette mechanically. Structural surfaces remain close in value so the manuscript retains priority, while interactive borders, focus, selection, and semantic states keep their non-color cues.

The top bar owns one quiet, icon-only appearance control at its far edge. Its native popover offers **System**, **Light**, and **Dark** as radio-style choices. System is the default, follows operating-system changes live, and shows the currently resolved appearance in the control's accessible name. Explicit choices persist across launches and ignore later system changes until System is selected again. The selected appearance is applied before the main stylesheet loads so boot, ready, disconnected, and error states never flash the wrong surface.

## 3. Typography

**Display Font:** `ui-serif` with Iowan Old Style and Georgia fallbacks
**Body Font:** `ui-serif` with Iowan Old Style and Georgia fallbacks for rendered writing; `system-ui` for product prose
**Label/Mono Font:** `system-ui` for controls; `ui-monospace` with SF Mono and Menlo fallbacks for paths and technical metadata

**Character:** Editorial manuscript plus quiet humanist product chrome. The serif/sans contrast separates the artifact from commentary on the artifact; mono appears only when the content is genuinely technical.

### Hierarchy
- **Manuscript Title** (600, 1.75rem): First-party artifact `h1`; editorial content rather than product chrome.
- **Manuscript Subhead** (600, 1.125rem): First-party artifact `h3`; preserves the authored document hierarchy.
- **Headline** (600, 1.375rem): Boot-screen and dialog headlines; balanced wrapping.
- **Title** (600, 0.9375rem): Panel and grouped-control titles.
- **Body** (400, 1.0625rem, 1.6): Rendered manuscripts at a 68ch maximum measure with pretty wrapping.
- **Label** (500, 0.8125rem): Buttons, tabs, annotations, and compact product copy.
- **Metadata** (400, 0.75rem): Paths, timestamps, anchor references, and technical identifiers.

### Named Rules

**The Reading Measure Rule.** Manuscript prose stays between 65ch and 75ch with generous line-height. Operational panels may be denser; writing never becomes a data table.

**The No Display Labels Rule.** Buttons, tabs, chips, paths, and state labels never use expressive display typography.

## 4. Elevation

The workspace is flat at rest. Spacing, one-pixel borders, and tonal layering establish structure; elevation appears only when a component genuinely floats over the work, such as a dialog, compact drawer, or bottom composer tray. Focus halos communicate interaction state, not physical depth.

### Shadow Vocabulary
- **Composer Rest:** A tight 1px/3px shadow separates the margin composer without turning it into a card.
- **Drawer Edge:** A narrow directional shadow clarifies that the compact navigator overlays the manuscript.
- **Dialog Float:** A broad shadow is reserved for the blocking native dialog and is paired with a dim backdrop because it is an actual overlay.

### Named Rules

**The Flat-Until-Floating Rule.** Resting panels are flat. Shadows are forbidden unless the element is temporarily above the workspace or needs interaction priority.

## 5. Components

### Buttons
- **Shape:** Modest six-pixel corners with compact, task-oriented padding.
- **Primary:** Workbench Olive with near-white text, reserved for Save, Send, and the next unambiguous action.
- **Hover / Focus:** A darker olive hover and a two-pixel focus-visible outline; transitions run 150–200ms with the shared ease-out curve.
- **Secondary / Ghost:** Reading Surface plus a strong border for ordinary actions; borderless Muted Ink on hover beds for low-priority actions.
- **Disabled:** Sunken Surface, Quiet Border, and Faint Ink. Disabled controls never masquerade as active state.

### Chips
- **Style:** Annotation intent is a free-wrapping pill with a quiet full border, not a segmented tub.
- **State:** Selection uses a restrained olive tint plus weight and border so it is never color-alone. Provenance chips use distinct solid, tinted, and dashed shapes.

### Cards / Containers
- **Corner Style:** Eight pixels for panels, ten for the composer, twelve only for overlays.
- **Background:** Reading Surface for focused work inside Control Surface chrome.
- **Shadow Strategy:** Flat at rest; the composer gets only a tight separation shadow.
- **Border:** Full quiet borders. Colored side stripes are prohibited.
- **Internal Padding:** Twelve to sixteen pixels for compact panels, twenty-four pixels for dialogs.

### Inputs / Fields
- **Style:** Control Surface fill, six-pixel corners, and a transparent resting border.
- **Focus:** Workbench Olive border with a faint three-pixel halo; the global button outline is suppressed only when this field-specific treatment replaces it.
- **Error / Disabled:** Semantic color is accompanied by text; user-entered text is never discarded on failure.

### Navigation
- **Style:** A 260px sage-tinted navigator with small sans headings, compact 28px tree rows, and no resting elevation. Current rows use a sunken background plus olive text and weight. Below 1024px it becomes an explicit drawer over a backdrop.

### Appearance Control
- **Style:** A 32px icon button with a 44px invisible hit target, separated from the work modes by a quiet divider. Its popover is a compact 176px menu with three 36px rows and a checkmark for the selected value.
- **Behavior:** System listens to `prefers-color-scheme` changes in real time. Light and Dark are explicit persisted overrides. The trigger and rows expose expanded and checked state to assistive technology.

### Manuscript and Contextual Margin
- **Style:** The rendered artifact remains centered and serif-led. Annotation cards align with their source passages at wide widths; the same composer becomes a bottom tray in compact mode.
- **Behavior:** Preview removes annotation affordances, Annotate reveals anchors and marginalia, and Edit preserves the same reading measure. Live updates preserve selection and scroll position.

## 6. Do's and Don'ts

### Do:
- **Do** keep rendered writing as the dominant surface and collapse chrome before shrinking the reading measure.
- **Do** use Workbench Olive only for primary action, focus, selection, and explicit operational state.
- **Do** state provenance and delivery honestly with labels such as “You,” “Outside glosa,” and “Waiting for a session.”
- **Do** preserve keyboard access, visible focus, reduced-motion alternatives, and WCAG 2.2 AA contrast.
- **Do** use stable product affordances—native dialogs, buttons, fields, segmented controls, lists, and drawers.

### Don't:
- **Don't** build a generic AI-workflow dashboard or let agent state compete with the manuscript.
- **Don't** use SaaS landing-page gloss, dark-mode purple gradients, glassmorphism, or decorative agent theatrics.
- **Don't** imply cmux coupling or hide routing, attribution, or delivery behind vague “synced” language.
- **Don't** use colored side-stripe borders, resting card shadows, decorative gradients, or nested cards.
- **Don't** use display typography for UI labels or mono typography for ordinary prose.
