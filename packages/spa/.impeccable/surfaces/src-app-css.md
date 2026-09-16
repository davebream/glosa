---
version: 1
slug: "src-app-css"
primary_target: "src/app.css"
related_targets: []
---

# Workbench surface — SPA (`packages/spa`)

Scope: the whole browser workbench (navigator · tabs · artifact bar · manuscript · margin · palette · dialogs), every mode. Visitor mode: **Operate**.
Audience: a writer reviewing a rendered Markdown document beside a running agent session, for hours, in daylight. Documents range from product specs to essays and sermons.
Task: read, mark passages, send marks to a session, see the session's answers with honest provenance, approve a revision.
Constraints: light-first; layout, topology and behaviour unchanged (maintainer, 2026-09-16); no cmux; no network at runtime, so every face is vendored OFL woff2 served from the daemon's own allowlist; core stays generic; passage addresses stay derived labels.

## Direction contract

THESIS: A calm writing desk where typography does the work. Warm paper, black ink, one vermilion hand. It replaces the previous achromatic grey workbench with system sans and a teal accent, which read as a modern developer tool rather than a place to write.

OWN-WORLD: Warm near-white paper for the whole desk: no grey sidebar or top bar; regions are divided by 1px ink hairlines. Warm near-black ink, warm muted greys. One burnt-vermilion hand for every human mark (wash, underline, § address, margin text, caret, selection, focus); pencil stays warm graphite; a session prints in ink. Source Serif 4 sets the manuscript, its headings (restrained 600–650 weights, optical sizes) and every quote and margin note; Source Sans 3 sets the chrome. The Read/Review/Edit control is an ink outline with the chosen mode struck forward as filled ink. The logo is the comma overprinted: an ink layer offset under a vermilion layer.

STORY: The writer opens a document and it reads like a well-set page, not an app. In Review they mark words and their note appears beside the passage in the same serif, in vermilion. They always know which words are theirs, which are the session's, and what stands approved.

FIRST VIEWPORT: 1440×900 light. Top bar on paper, overprint comma at left, file path centred in Source Sans 600, ink hairline beneath. Navigator on paper with an ink hairline at its right; uppercase tracked 12px section labels. Artifact bar: path left, ink-outline mode control centred with the active mode filled ink, History and More right. Manuscript in Source Serif 4 at 18px on a 68ch measure, title at 40px/650, § addresses in vermilion in the gutter. Margin rail at right: a hairline, "§1.1 You", the quote in italic serif, the note in vermilion serif, state row in Source Sans.

FORM: Ink Weather, the led card of re-roll round 1 in the bolder register (seed key 9098bd93), a fusion of the "alphabet storm" form (letters as matter, black on open white ground) with donations from the Nixie counter (one warm glow as the only colour) and cathode gauze (the chosen state struck forward). Type toned down to restrained serif headings and Source Sans 3 chrome after maintainer review and font research (2026-09-16). Mark colour vermilion and logo overprint chosen from rendered samples. Code-led build.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Decided after the contract was written
- The face chooser stays in the pane's More menu: Default (Source Serif 4), Sans (Source Sans 3), Mono. A stored "serif" choice resolves to Default, which is now the serif.
- Addresses stay on margin entries, the composer and gutter pseudo-elements, never inserted into the rendered content.
- Manuscript body is 18px Source Serif 4, which paints 688px at 68ch: inside the existing 707px `--manuscript-block`, so the margin-rail floor (1205px) and layout constants did not move.
- Margin notes, the composer field and a session's message are set in the serif whatever the page face: notes are writing, not chrome.
- Logo: vermilion printed opaquely over a thin (45%) ink layer offset down-right. The multiply overprint was built first and read as oxblood at top-bar size; the maintainer chose vermilion on top (2026-09-16).
- Dark appearance: region hairlines and the mode-control outline use a softened light ink (`--rule` oklch 0.74), not full text ink, so a full-width rule does not glare under low light.
- Source Sans 3 ships unsubset (Reserved Font Name "Source"); Source Serif 4 ships as a Latin subset.

## Unresolved
- README screenshots in docs/assets/screens predate this world and need re-capture.
