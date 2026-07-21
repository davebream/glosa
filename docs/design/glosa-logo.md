# glosa product mark

## Concept

The mark is a custom one-storey lowercase `g` built from two filled forms:

- The dark bowl is the authoritative manuscript: stable, primary, and easy to read at small sizes.
- The olive stem is marginal commentary. It sits at the page edge, then becomes the letter's descender and closes the review loop.

Filled geometry replaces icon-like outlines and internal text strokes, so the mark remains recognizable at favicon scale. There is no sparkle, chat bubble, robot, cloud, or generic file metaphor.

## Usage

- Master asset: `packages/spa/src/glosa-mark.svg`
- Minimum UI size: 16px. Preferred product-chrome size: 24px.
- Clear space: keep at least one quarter of the mark's width free on every side.
- On light surfaces use Editorial Ink with Workbench Olive. On dark surfaces use Dark Ink with Dark Workbench Olive.
- The mark may be shown without the word `glosa` in persistent product chrome. For external contexts, pair it with the lowercase product name in the surrounding UI sans or editorial serif; do not bake live text into the SVG.
- Do not place the mark in a rounded square, add shadows, rotate it, outline it, or recolor the marginal stroke as a decorative gradient.

The standalone SVG follows the operating-system color preference. The ready-state app uses the same geometry inline so persisted light/dark choices can follow glosa's theme tokens exactly.
