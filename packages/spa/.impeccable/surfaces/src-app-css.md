---
version: 1
slug: "src-app-css"
primary_target: "src/app.css"
related_targets: []
---

# Workbench surface — SPA (`packages/spa`)

Scope: the whole browser workbench (navigator · manuscript · margin · topbar), every mode. Visitor mode: **Operate**.
Audience: a writer or engineer reviewing a rendered Markdown document beside a running agent session, for hours, in daylight. Documents range from product specs to long-form prose and sermons; the page face is the writer's choice (Default sans, Serif, Mono, per page).
Task: read, mark passages, send marks to a session, see the session's answers with honest provenance, approve a revision.
Constraints: light-first; layout topology kept; no cmux; core stays generic (no domain vocabulary in chrome); no custom markup in documents, so passage addresses are derived from Markdown structure at render time and are labels, never identity.

## Direction contract

THESIS: One identity across every document, carried by the marks rather than by a typeface or a period artefact. The manuscript is the writer's, in the writer's face; glosa is recognisable by how a human mark, a session's answer and provenance look. It refuses the calm-editor template (cards in a rail, one decorative accent) and every source-domain costume (scriptorium, lab, score).

OWN-WORLD: White page, near-black ink, achromatic quiet chrome (grey sidebar, hairlines, segmented mode switch, face switch). Two hands: the human's marks are one colour everywhere, deep teal `#0F5D5D` (oklch ≈ 0.42 0.06 195), as a light wash on the words in Review plus a § superscript address, in the margin text and the composer; unsent marks are graphite and dashed (pencil), sent marks take the teal (ink). The session never uses the hand colour: its answers are printed black, in line under the passage they changed, with revision and address. No cards; margin entries open on a hairline aligned to their passage. A provenance line at the foot of the page: written, changed, outside glosa, approval. Diff colours stay green/red and are the only other hues.

STORY: The reader opens a document in their own face, reads without chrome, switches to Review, marks a passage (pencil), sends it (ink), and later sees the session's printed answer under that passage with its revision. They always know which words are theirs, which are the session's, and what stands approved.

FIRST VIEWPORT: 1440 wide. Left 232px sidebar: workspace, document outline as § addresses, artifacts, sessions. Top bar: crumb, Read/Review/Edit segmented, Aa face switch, session status, More. Centre manuscript at reading measure; § address in the gutter at each heading; marked passages washed in pencil grey or teal with a superscript address; session answers as black in-line reply lines. Right 300px margin: entries by address, pencil or ink, composer under the pencil entry with Discard / Send to session; approval strip pinned at the foot. Provenance line under the manuscript.

FORM: user-pinned synthesis, chosen after two dealt hands (seed key c061c19e, re-roll 1). It sits outside the ordered candidate list: it assembles the winning rules of the dealt directions (Glossed Leaf: two hands; Marked Score: pencil-then-ink and addresses; Lab Notebook: provenance line) into a domain-neutral identity. Mark treatment B (wash + superscript) and hand colour deep teal were chosen from rendered variants against a real sermon manuscript. Code-led build: no image generation on this machine.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Unresolved
- Exact address format when a section has no heading; behaviour of addresses in Edit.
- Whether Read mode shows any mark at all (recommended: no wash, superscripts only, provenance line stays).
- Dark appearance: derived later from this world; not part of the first build.
