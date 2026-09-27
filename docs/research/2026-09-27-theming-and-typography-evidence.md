# glosa theming and typography study: evidence

Date: 2026-09-27. This is the full evidence behind [the decision report](2026-09-27-theming-and-typography.md). Read that first; come here to check a number, a source or a verdict.

It holds four studies:

| Part | Questions | What it covers |
|---|---|---|
| Part 1 | 1 to 3 | Editor themes (One Dark Pro, Monokai and the rest), the font pair and its proportions, reader comfort controls, and the theming model |
| Question 4 | 4 | The passage addresses (the `§2.3` labels) shown on hover while notes are shown |
| Question 5 | 5 | The chat pane: a serif conversation that stays clean |
| Question 6 | 6 | Two registers, spec and editorial, and how register relates to themes |

How to read it:

- Source numbers are local to each part. `[12]` in Question 5 points at Question 5's own source list.
- Code references (`packages/spa/src/app.css:4913`) are to `main` at 8ed3767 (v0.1.0-alpha.36). The studies read 6a77f15 (alpha.35); the print rework merged since then (#398) rewrote only the print block and moved every later `app.css` line by 136, so those references were remapped and the print passages describe #398 as merged.
- Every claim a recommendation depends on was checked twice: once against its cited sources, and once for whether it applies to glosa's readers and constraints. A claim that failed one check keeps its wording and is followed by the objection; a claim that failed both was removed. Each part states its tally.
- Four code defects were re-measured in Chrome 154 and WebKit against the shipped stylesheet, and again in Chrome on alpha.36; those results, listed in the decision report, override anything here that disagrees.

Visual comparisons of the font pairs, proportions, palettes, chat treatments and registers: [`spikes/theming-comps.html`](spikes/theming-comps.html). Open it in any browser.

## Part 1: editor themes, the font pair and its proportions, and the theming model (Questions 1 to 3)
Date: 2026-09-27. Final version for the maintainer, after verification and a completeness pass.

### Three verdicts

1. **Editor themes (Question 1):** do not ship One Dark Pro, Monokai, Dracula and the rest as a named catalogue of glosa themes.
2. **Fonts and proportions (Question 2):** keep Source Serif 4 with Source Sans 3. Change three values and add a size control.
3. **The model people stay for (Question 3):** one identity, plus reader comfort controls and accessibility variants, on a validated theme file.

### Answer first

**Question 1: editor themes**

- No named catalogue. These themes are syntax palettes. On a prose page with no syntax highlighting, only their background, body colour and code background survive. Ports of the same theme disagree about everything else. A port would also bring each theme's own meaning for the hues glosa uses to show who wrote what.
- If anyone wants the "I know this palette" benefit, offer a role-based import. Base16 (a 16-slot palette convention with a documented meaning per slot) maps onto glosa's tokens. Contrast floors keep protecting the six tokens that carry meaning. The result is named for what it does, not given a borrowed name.

**Question 2: fonts and proportions**

- The pair is right. One foundry designed Source Serif 4 and Source Sans 3 as companions.
- The proportions are sound. They need three fixes and one control:
  - Set the sans face at about 18px. Today it paints about 10 percent smaller than the serif.
  - Give the sans its own measure (characters per line) of about 63 to 64ch.
  - Raise h4 to body size.
  - Add a size control. The 18px body sits at the floor of the fluent-reading range, with no reserve on common Mac setups.
- Everything else measured is inside an authoritative range: line-height 1.62, heading sizes and tracking, chrome 13px, notes 15px, labels 11 to 12px. Three items have no source to rate them against: the mono face, 13px code blocks and manuscript tables set in the chrome sans.

**Question 3: the model people stay for**

- **The model.** One identity, reader comfort controls (size, presets, measure, leading, face) and accessibility variants (high-contrast light and dark, honouring `prefers-contrast`), all on a validated theme file. GitHub is the structural precedent, but it is not proof that people who dislike a look will stay. Obsidian's theme marketplace is the model to avoid.
- **Whether looks make people leave** (added after the completeness pass): rarely. When they do, the reason is mostly comfort (size, contrast, line length) or an unwanted change to a look people had adopted. That supports the comfort layer over a theme catalogue.
- **Custom fonts, in two tiers.**
  - Portable tier: the person puts font files in a config folder, and the daemon serves them as same-origin web fonts. This needs no CSP change and works in Safari.
  - Extra tier: an installed font named by its exact PostScript or full name, loaded through `local()` (a CSS font source that reads an installed font). It works only in the Electron shell and Chromium, because Safari hides user-installed fonts from all CSS font matching.
- **Raw user CSS:** an opt-in, unsupported escape hatch only. A stylesheet can make the hand and the session the same colour, and nothing can check it.
- **Which surfaces a theme reaches** (added after the completeness pass): a theme built on tokens reaches the manuscript, the chrome and chat. Each other surface needs its own mechanism:
  - class F (glosa's sandboxed viewer for agent-written HTML documents)
  - the agent-login terminal
  - the diff pane in light mode
  - print
  - the Electron window

**Fix before any of that**

- A bug: in dark mode the danger button's text is 2.78:1. WCAG AA needs 4.5:1.
- Tech debt: the scheme list is copied in three JS files. Five dark overrides sit outside the token block.

Verification weakened several supporting reasons, but none of the verdicts. The section "What verification weakened", near the end, lists each one.

### Reader and reference class

glosa's readers have an agent write for them. Then they spend hours reading, judging and correcting the result. They include product managers reading specs, writers reading essays, a pastor reading a Polish sermon draft, researchers reading reports and engineers reading design docs. So every verdict is measured against reading apps and writing desks (Kindle, Apple Books, Readwise, iA Writer, Ulysses), not code editors. Developers use glosa too, but each section serves them last.

### What glosa ships today

Two code audits read every number below from the repository at 6a77f15 on 2026-09-27. Where the study brief only quoted a value and an audit measured it, the table shows the measured value. Where verification re-measured a value, the verified figure is added. This table covers the Markdown manuscript and the chrome. Other surfaces are covered in Question 3, under "Surfaces beyond the manuscript".

| Item | What ships | Class of any problem |
|---|---|---|
| Faces | Manuscript: Source Serif 4, a variable font with wght (the weight axis) 200 to 900 and opsz (the optical-size axis) 8 to 60, set with `font-optical-sizing: auto`. Chrome: Source Sans 3, wght 200 to 900. The file's default instance is weight 200, so every element needs an explicit weight. Mono: the system font (`ui-monospace`, SF Mono, Menlo), so the Source superfamily is incomplete. A per-document face chooser (Default / Sans / Mono) sits in the pane's More menu and is stored per workspace and document (`packages/spa/src/face.js`). | none |
| Body sizes and leading | Serif 18px / 1.62. Its x-height is 8.55px at the file's default instance and 8.65px at the optical size glosa renders, opsz 18 [215]. Sans face 16px / 1.6. Its x-height is 7.65px from the ExtraLight master and 7.78px at the Regular weight glosa uses [215]. Mono face 15px / 1.65. The face is the only lever that changes size or leading, and switching it changes both as a side effect. | design flaw (size, leading and measure are not independent) |
| Measure | `--measure: 68ch` (68 widths of the zero glyph in the current font), resolved separately in each face. Serif: 623.8px with optical sizing on, 612px with it off. A comment at `packages/spa/src/app.css:4799` still says 612. Sans: 540.8px. Mono: 614px, exactly 68 characters. At full width the serif holds about 76 characters of English and 73 to 76 of Polish. Its ragged lines average about 74 and 72. The sans holds about 81 and averages about 79, and its longest lines reach 88 [216]. The painted column is 688px inside a fixed 707px block, `--manuscript-block` (the page's painted width as one fixed length). The rail ladder is computed from that block. The rail ladder is the set of pane widths, from 1205px up, at which the margin-note rail fits beside the page. | stale comment. Sans lines run a few characters longer than the serif's. That is a comfort issue, not a WCAG failure (see the measure row in Question 2). |
| Headings | h1: clamp 30 to 40px, weight 650, line-height 1.1, -0.015em. h2: 24 to 26px, 620, 1.25, -0.01em. h3: 20px, 620, 1.3. h4 to h6: 17px, 600, 1.4. strong is 600. Headings inherit the page face. | minor design flaw: h4 (17px, 600) is smaller than a bold run in body text (18px, 600) |
| Ratios to the 18px body | h1 2.22, h2 1.44, h3 1.11, h4 0.94, notes 0.83, chrome 0.72, section labels 0.67, address 0.61. The chrome scale steps through 11, 12, 13, 15, 17, 19 and 22px. The ratios run from 1.08 to 1.16, not a constant 1.125. | none |
| Notes and chrome | Margin notes, the composer and a session's question card: serif 15px / 1.45. Chrome default: sans 13px / 1.5. Section labels: 12px uppercase, 0.06em. Address: 11px bold tabular on the page, 12px inside an entry. Code blocks: 13px / 1.6. Inline code: 0.85em. Manuscript tables switch to the chrome sans at 15px. | consistency debt: the address size drifts (11 vs 12px), and tables leave the manuscript face |
| Modes | Use system setting / Light / Dark. `data-theme` on `html` is both the resolved scheme and the CSS hook. A preload script applies it before CSS loads. The dark block changes 25 colour and shadow tokens and nothing typographic: weight stays 400, with no size or tracking change. | none in itself |
| Controls | Face per document and colour mode. There is no control for size, leading, measure or tracking, no font choice, no theme catalogue, no high contrast and no sepia. `prefers-contrast`, `forced-colors` and `prefers-reduced-transparency` have zero matches. Zoom is the browser's own. The Electron shell's View menu already carries Reset Zoom, Zoom In and Zoom Out (`packages/shell/src/main.ts:373`) [239]. The browser's default font size scales the rem scale but not the px rail constants. So an enlarged default can push the measure past the 707px block. | missing guardrail (a latent layout defect for readers who enlarge type) |
| Payload | 710,896 bytes (694 KiB). Serif roman 218 KB and italic 185 KB, 374 glyphs (Basic Latin, Latin-1, Latin Extended-A). Sans roman 170 KB and italic 138 KB, 1,615 glyphs, unsubset. Served from a fixed allowlist as bytes, with a sha256 ETag, `Cache-Control: private, no-cache` and `font-display: swap`. No subsetting recipe is recorded anywhere in the repo. | tech debt (the subset cannot be reproduced) |
| Diacritics | All 18 Polish letters (ą ć ę ł ń ó ś ź ż and their capitals) are present in all four files. The audit's fontTools check reports `missing []` for each. Neither font has a Polish `locl` variant (language-specific glyph forms), and Polish needs none. The serif subset lacks ș ț ẞ, U+2011, Greek, Cyrillic and ≠ ≤ ≥, which fall back to another face mid-line. `html` is hard-coded to `lang=en`. | limit of the subset. The missing `lang` is a missing guardrail. |
| Contrast (WCAG ratios computed from the OKLCH tokens; OKLCH is a perceptual colour space of lightness, chroma and hue) | Light: ink 17.62:1, muted 6.66, hand 5.74, pencil 4.53, session 8.27 (`DESIGN.md` says about 8.9), danger 7.26. Dark: ink 14.59, muted 7.22, hand 6.91, pencil 5.32, session 8.40. The danger button's text is a raw `oklch(0.99 0 0)`, which gives 2.78:1 on the dark `--danger`. | bug in dark mode (AA needs 4.5:1) |
| Theme-readiness | Score 6 of 10. Token discipline 9/10: outside the token blocks and print there are 3 literal colours and 2 `black` keywords (lines 4916, 4920 to 4921, 7279 and 7550 of `packages/spa/src/app.css`), and 0 in JS. Dark overrides outside the token block: 5 component rules plus 1 print rule. Four of them collapse into three tokens, and one (the diff2html remap) should be unconditional. Plumbing 3/10. The scheme list lives in `packages/spa/src/appearance.js`, `packages/spa/src/appearance-preload.js` and `packages/spa/src/agent-settings.js` with no shared source. The preload cannot learn a named theme's scheme before paint. The Electron shell sets no `backgroundColor` and never sets `nativeTheme.themeSource`. Accessibility hooks 0/10. `@supports` blocks: 0. | tech debt |

The typography audit made two side findings. They are not about theming, but they touch the reading surface.

- The page marks (underline, washes, dotted rule) paint only through `::highlight()`, a CSS feature that paints text ranges without changing the DOM. Safari gained it at 17.2, but the platform floor in `docs/appendices/A6-cli-platform.md:208` is Safari 16.4. The guard in `packages/spa/src/artifact-pane.js:138` returns silently with no DOM fallback. Class: missing guardrail.
- `hanging-punctuation: first` is Safari-only, so the shipped Chromium 152 shell never renders it. Class: a harmless limit.

### Question 1: known editor themes (One Dark Pro, Monokai and the rest)

**Verdict: do not ship them as a named catalogue of glosa themes, either instead of the identity or beside it.** The reasons that survived verification are structural. These palettes colour syntax that glosa does not have. They carry no prose contract that a port could honour. Verification weakened three supporting reasons from the draft (audience, hue collision, licensing), and the tables mark each one. A role-based palette import stays possible later, as a different feature.

#### Why

Licensing is covered once, in its own table below.

| Reason | What the evidence says | Class | Source |
|---|---|---|---|
| Audience | These themes' popularity measures code-editor populations. On the VS Code Marketplace, GitHub Theme has 20.2M installs, One Dark Pro 12.8M and Dracula 11.0M. At least four prose products ship editor palettes as built-in themes: Bear 2 (as paid Pro themes), MarkText, Joplin (free) and Standard Notes (Solarized Dark on paid tiers). All four are note-taking or Markdown apps. The lanes opened 24 prose products but named only those that ship palettes, so the count cannot be audited. Reading apps ship a few page colours instead, from light and dark only (Readwise) to eight (Matter). | weakened (C3): Bear sells these palettes to general note-takers, so audience is not a reason on its own | [59][61][73][79][80][81][135][136][137][219][220] |
| No syntax highlighting | Each theme is a palette keyed to TextMate scopes, the names a code grammar gives each token, such as `markup.heading`, `markup.bold`, strings and keywords. glosa renders code as plain monospace. So the six to eight signature accents have no job on the page. What is left is the background, the body colour and the code background. glosa's tokens already model those three values. | limit of the approach (stands) | [106][113][115] |
| No prose contract | Dracula's own spec paints headings purple and bold text orange. Dracula's Obsidian port paints h1 purple, h2 orange, h3 green and h4 red. Dracula's Typora port keeps headings near-white. One Dark Pro colours headings red and Tokyo Night colours them cyan. Rosé Pine's VS Code theme dims them to the comment grey, at 3.4:1. So a glosa "Dracula" would be glosa's own invention, and no Dracula user would recognise it. | design flaw in the premise (stands) | [106][107][108][109][110][111] |
| Provenance hues | glosa's hand is OKLCH hue 41 (light) and 45 (dark). The session is 255 and 250. All ten families have an accent within 1 to 24 degrees of one of these. Nearest to the hand: Solarized orange 1 to 5 degrees, Gruvbox orange 2 to 7, Catppuccin peach 1 to 8, Nord orange 7, Tokyo Night orange 6 to 8. Nearest to the session: Nord's nord9 1 degree, GitHub's accent 2 to 6, One Dark's blue 5, Solarized blue 5 to 10. glosa colours neither bold text (weight 600 in ink) nor links (underlined ink). So a mark cannot be mistaken for either. A token-level port would map the theme's orange to `--hand` and its blue to `--session` on purpose. Three costs remain. First, the theme's own meaning for that hue: Nord documents its orange as "advanced or dangerous functionality". Second, there is too little hue room between hand and danger where red and orange sit within 15 degrees (Solarized, Gruvbox). Third, the cool near-black backgrounds of the dark-first families replace the warm paper. Only Rosé Pine keeps 18 degrees or more of distance, and its light variant's accents fail as text (gold 2.1:1, rose 2.6:1). | weakened (C1): the risk is borrowed meaning and lost warmth, not a collision with bold or links | [117][119][120][122][123][140][217] |
| Contrast | Contrast is not the obstacle. glosa's own hand and session tokens stay above 4.5:1 on all 16 theme backgrounds tested. The lowest hand ratio is 4.8:1, on Nord and on Tokyo Night Light. Pencil fails on Nord (3.7:1) and on Tokyo Night Light (3.8:1). Solarized light's own body text is 4.1:1, below AA. Any port that respects a floor has already stopped being the theme. | limit of the approach (stands) | [117][118] |
| Coloured headings | In Markdown viewers, coloured headings come from the `markup.heading` scope, not from reading typography. Butterick says the best way to emphasise a heading is space above and below, and that less colour is more effective. GitHub's own Markdown CSS keeps headings in the body colour at weight 600. No reading research on coloured prose headings was found, either for or against. | a gap, not a licence to colour | [16][113][116] |

#### What a port would actually change on a prose page

| Source | Ground | Body text | Headings | Links | Bold / italic | Code bed |
|---|---|---|---|---|---|---|
| Dracula spec [106] | #282A36 | #F8F8F2 | Purple, bold | Pink text, Cyan URL | Orange bold / Yellow italic | inline Green; blocks Orange |
| Dracula Obsidian port [107] | #282a36 | #f8f8f2 | h1 purple, h2 orange, h3 green, h4 red, h5 yellow | pink | orange / green | #20212B |
| Dracula Typora port [108] | #282a36 | #b8bfc6 | #dedede (not coloured) | #e0e0e0 underlined | inherits | #45495C inline |
| One Dark Pro [109] | #282c34 | #abb2bf | red #e06c75 | purple | orange / purple | inline green |
| Monokai, VS Code built-in [223] | #272822 | #f8f8f2 | not checked | yellow #e6db74 | cyan #66d9ef bold | not checked |
| Tokyo Night [110] | #1a1b26 | #9aa5ce | cyan #7dcfff | teal | not stated | not stated |
| Rosé Pine VS Code [111] | #191724 | #e0def4 | muted #6e6a86 (3.4:1) | font style only | font style only | not stated |
| Catppuccin Obsidian [112] | Base | Text | all levels one accent (lavender) | blue | sapphire / green | Mantle |
| GitHub markdown CSS [113] | #ffffff / #0d1117 | #1f2328 / #f0f6fc | body colour, weight 600 | #0969da | weight only | #f6f8fa |
| Base16 styling guide [114] | base00 | base05 | base0D (the functions slot) | base08 text, base09 URL | base0A / base0E | base0B |
| glosa today [140] | warm paper oklch(0.99 0.007 85) | ink oklch(0.2 0.012 60) | ink, size and weight only | ink, underlined | weight 600 / italic | surface oklch(0.97 0.006 80) |

Read across a row. The only cells every port agrees on are the background, the body colour and the code background. For a prose page, that is all a "theme" means. The Monokai row was added in verification. It shows that "orange means bold" is not universal: Monokai colours bold text cyan and links yellow.

The full per-theme table (licence, prose ports, contrast, accent hues) is in Appendix 1c.

#### Licensing and naming

Licensing is covered here only. Verification softened the verdict column (C2): two names need care in how they are used, and neither is barred.

| Name | Palette licence | Name risk | Verdict |
|---|---|---|---|
| GitHub | MIT (Primer) [101][221] | GitHub's brand page bars any use that suggests affiliation or endorsement [125]. Typora ships a built-in theme called "Github" [225]. | The values are usable. The name is a brand-risk judgement, not a bar. A neutral label (for example "Primer") removes the risk. |
| Monokai Pro | Proprietary: 14.50 EUR per editor, and it "may not be sub-licensed, resold, or redistributed" [126][127] | A commercial product | Its values must not be copied |
| Monokai (classic, 2006) | The 2006 tmTheme carries no licence text and no Markdown rules at all [124]. VS Code ships it under MIT [222]. The base16 scheme is credited to Wimer Hazenberg in an MIT repository [224]. | The author's studio is also called Monokai, and it calls third-party themes "unofficial" [128]. No trademark notice on the bare word was found. | Usable with attribution to Wimer Hazenberg, with a small naming caveat |
| One Dark Pro | MIT [129] | One author's product name, built on Atom's archived One Dark [130] | At most "One Dark", with attribution |
| Dracula, Catppuccin, Nord, Solarized, Gruvbox, Rosé Pine, Tokyo Night | MIT (Tokyo Night also Apache-2.0) [118][119][121][122][123][131] | None found | Usable with attribution, if a port could be faithful. The "no prose contract" row shows it cannot be. |

#### The better way to the "I know this palette" benefit

Accept palettes as roles, not as theme names. Base16 is a 16-slot palette convention with documented meanings per slot, used by 230+ schemes and 70+ apps [114][133]. It is the lowest common denominator that Catppuccin, Nord, Solarized and Rosé Pine map onto cleanly. One Dark, Monokai, Gruvbox and Tokyo Night publish no role spec, so glosa would have to invent their roles [114][133]. The importer is the mapping below, plus the same contrast validator that gates every shipped theme (Question 3). Expect many light schemes to fail on the hand slot (base09, orange) and the warn slot (base0A, yellow), and to need darkening [139]. The result is glosa's interpretation of the scheme. So name it for what it does (warm, cool, low-glare) and credit the palette author.

| Base16 slot | Base16 meaning [114] | glosa token | Importer rule |
|---|---|---|---|
| base00 / base01 / base02 | Default background / lighter background / selection | `bg` / `surface` / `surface-sunken` | As is. `scheme` comes from base00's lightness. |
| base03 / base04 / base05 | Comments / dark foreground / default foreground | `faint` / `muted` / `ink` | `faint` is for disabled items only. `muted` must reach 4.5:1 or move toward ink. `ink` must reach 4.5:1 or the import is refused. |
| base08 / base0A / base0B | Variables, diff deleted / classes, bold / strings, diff inserted | `danger` / `warn` / `ok` | 4.5:1 each. Yellows on light backgrounds usually need darkening. |
| base09 / base0D | Integers, constants (orange) / functions, headings (blue) | `hand` / `session` | 4.5:1 as text and 3:1 as a line. They need hue distance from each other and from `danger`. Refuse if the colour cannot pass inside its hue family. |
| base06, base07, base0C, base0E, base0F | Light foregrounds, support, keywords, deprecated | unused in the manuscript | In the manuscript, colour means provenance and nothing else |
| derived | | `pencil`, `border`, `border-strong`, `scrim`, washes | Derived from ink, muted and bg with `color-mix()` (see Implementation shape). `pencil` chroma is clamped near 0.03. |

There is precedent for a reading tool with one identity and a few named variants. Zettlr ships five house themes, each an accent colour plus a face, each with light and dark versions [72]. iA Writer ships Light and Dark [56]. There is also precedent for editor palettes in note-taking tools: Bear's curated, attributed, paid Pro catalogue, and Joplin's free built-in Dracula, Nord and Solarised [61][134][219]. Both are fixed sets, not open theme engines.

### Question 2: are the current pair and proportions right?

**Verdict: the pair is right and the proportions are sound. Three values need a change and one needs a control.** Nothing measured falls outside every authoritative range. The three changes are the sans face size, the sans measure and the h4 size. The control is body size. Three items could not be rated for lack of a source: the mono face, code-block size and manuscript tables. The rest is fine or borderline.

#### Per-parameter table

"Fine" means inside the strongest source's range. "Borderline" means at the edge of one range, or contested between sources. "Change" means the evidence points one way. "Verification: C#" marks a range that was restated after verification (see "What verification weakened").

| Parameter | glosa value | Authoritative range (source) | Verdict | Source |
|---|---|---|---|---|
| Body size, serif | 18px. x-height 8.65px at the rendered optical size. | Fluent reading needs an x-height of at least 0.2 degrees of visual angle and at most about 2. The 0.2 figure is the critical print size, the smallest text read at full speed. Books cluster at 0.23 to 0.24 [1]. The 0.2 figure is a consensus inside a 0.15 to 0.3 band, and one of its two founding studies has a mean of 0.17 [1]. Rello 2016 eye-tracked 104 readers. Fixation time kept falling, significantly so up to 22pt, and comprehension was lower at 10 and 12pt [2]. That study used Arial on a 75 ppi screen with uncontrolled line length and never states pixels. So only its direction transfers to Source Serif 4 on a Retina Mac [2]. Butterick: 15 to 25px [3]. The 18px body's x-height is about 0.196 degrees on a 14-inch MacBook at 50 cm and 0.176 on a 27-inch display at 65 cm. Ordinary scaling and distance move it between about 0.15 and 0.24 [1]. Verification: C5, C6. | Borderline: at the reading-speed floor with no reserve, on a laptop and on a desk monitor alike. Keep 18 as the default. Add a size control with steps up to 24px that works together with the shell's existing zoom. No single px value clears 0.2 degrees on every ordinary Mac setup. | [1][2][3][239] |
| Body size, sans face | 16px. x-height 7.78px at Regular. | Point size is not perceived size [4][5]. The one empirical test (Wallace 2022) found that readers matched overall letter height more often than x-height. It did not match its own fonts by x-height, and most studies use one fixed px size [5]. Matching the serif's rendered x-height needs about 17.8px [215]. Verification: C7. | Change: set the sans face at about 18px. These two faces agree on x-height and cap height, so 16px is about 10 percent smaller by any measure. This is not a general x-height rule. | [4][5][215] |
| Body size, mono face | 15px | No source found. The system mono's x-height varies by machine (SF Mono 0.526, Menlo 0.547). | Unrated. Engineers reading design docs are a named audience, so this stays open (see Not covered). | [37] |
| Line-height | 1.62 | Butterick 1.2 to 1.45 [11]. iA 1.4 [12]. WCAG AAA target at least 1.5 [9]. Material body 1.5 [14]. Rello: 1.2 to 1.68 harmless, 2.16 harmful [2]. | Fine, at the loose end. Treat 1.5 as the floor and 1.7 as the ceiling for any control. | [2][9][11] |
| Measure | 68ch at full pane width. Capacity is about 76 characters in the serif (73 to 76 in Polish) and about 81 in the sans. Ragged lines average about 74 (serif, English), 72 (serif, Polish), 79 (sans, English) and 76 (sans, Polish). The longest sans lines reach 88. The column is narrower in the split-screen layout below 1024px. | Bringhurst 45 to 75, 66 ideal [6]. Butterick 45 to 90 [7]. Baymard 50 to 75, capped at 80 [8]. WCAG AAA at most 80 as an average, met by any mechanism such as a fluid column [9][240]. Dyson: 55 was rated easiest and comprehended better, while 100 read fastest [10]. Nanavati and Bias: no more than about 70 [26]. BBC GEL 60 to 70, max 80 [27]. | Serif: fine, at the long end of Bringhurst's range. Sans: a few characters longer, a comfort issue, not a WCAG failure. Change: give the sans its own measure of about 63 to 64ch. Do not move to a single px or rem measure. It would stretch sans lines to about 81 characters at 18px, or 91 at 16px. | [6][9][10][216][240] |
| Paragraph spacing | 1.2em gap, no indent | Butterick 50 to 100 percent of body size [22]. Bringhurst prefers an indent alone [6]. Spacing must survive a user's 2em override [13]. | Borderline loose. 1.0em would sit at the top of Butterick's range. Never add an indent on top of the gap. | [13][22] |
| h1 | 30 to 40px (2.22x body), weight 650, -0.015em | Apple's Large Title is 2.0x body and Material's headline large is 2.0x [14][15]. No ratio is authoritative. Modular scales are a designer's convention [17]. | Fine. 2.0x would match both platforms exactly if 2.22x reads loud. | [14][15][17] |
| h2 | 24 to 26px (1.44x), 620, -0.01em | Apple Title 2 1.31x. Material title large 1.375x, headline small 1.5x [14][15]. | Fine | [14][15] |
| h3 | 20px (1.11x), 620 | Apple Title 3 1.15x. Material title medium 1.0x. | Fine | [14][15] |
| h4 to h6 | 17px (0.94x), 600 | Apple's Headline is body size, bold. Its Subheadline is 0.85x. Material's title small is 0.875x, Medium. Butterick: a bold heading may drop half a point to one point [15][14][16]. | Borderline. The size has precedent. But strong is also 600 at 18px, so a bold run is larger than a subheading. Change: set h4 to 18px, body size, and let weight do the work (Apple's Headline model). | [14][15][16] |
| Heading weight | 650 / 620 / 620 / 600 | Apple and Material set large titles Regular and small titles Medium. Butterick: bold is fine but optional. Apple: avoid Light [14][15][16]. | Borderline heavy for a book register. Anything from 400 to 650 is defensible. Optional trial: h1 and h2 at 500 to 550. | [14][15][16] |
| Heading line-height | 1.1 / 1.25 / 1.3 / 1.4 | Apple Large Title 26/32 = 1.23. Material display 1.12, headline 1.25. | Fine | [14][15] |
| Heading tracking | -0.015em at 40px, -0.01em at 26px | Apple's serif (New York) tracks -0.012em at 30pt and -0.008em at 19pt. Material is about 0 to -0.004em [15][14]. | Fine. If anything, ease h1 to -0.012em. Check that optical sizing plus tracking does not tighten twice. | [15][18] |
| Uppercase label tracking | 0.06em at 12px | Butterick 5 to 12 percent [18]. Bringhurst 5 to 10 percent. | Fine | [18] |
| Notes, composer | serif 15px / 1.45 | Butterick's web body floor is 15px [3]. Apple Title 3 is 15pt [15]. | Fine, at the floor. A size control should probably scale notes too. | [3][15] |
| Chrome default | sans 13px | macOS Body is 13pt [15]. Material body medium is 14 [14]. | Fine | [15] |
| Section labels | 12px uppercase | Apple Callout 12pt. Material body small 12. | Fine | [14][15] |
| Address labels | 11px bold tabular | macOS minimum 10pt [15]. Material label small 11 [14]. NN/g at least 10pt [23]. | Fine as a label. Never use it for a sentence. | [14][15][23] |
| Code block in prose | 13px mono / 1.6 (0.72x body). It is fixed at `--text-sm`, so a size control built on `--manuscript-size` would not reach it (added after the completeness pass). | No authoritative range found | Unrated, and visibly small next to 18px prose. Decision 7 moves it to 14 to 15px. That figure matches Source Code Pro's apparent size and is not a sourced range. Decision 26 derives it from the reading scale. | [37][273] |
| Manuscript tables | The chrome sans at 15px, not the manuscript face | No source found | No verdict. Whether tables should match the manuscript face is a consistency question to settle with a side-by-side mock-up (decision 27). | audit |
| Print | 12pt / 1.45 in the page's own face since the print rework (#398, `packages/spa/src/app.css:6243-6453`); headings 24, 18, 15, 13, 12 and 12pt; code and table text at least 12pt | Butterick 10 to 12pt for print, 120 to 145 percent line spacing [3] | Fine | [3] |
| Text contrast, light | ink 17.62:1, muted 6.66, hand 5.74, pencil 4.53, session 8.27 | AA requires 4.5:1 for all glosa text, because nothing reaches the 24px large-text threshold. AAA requires 7:1 [19][20]. | AA is fine everywhere. Muted, hand and pencil miss AAA. Pencil has 0.03 of headroom. | [19][20] |
| Text contrast, dark | hand 6.91, session 8.40, pencil 5.32 | as above | AA is fine. Hand misses AAA by 0.1. | [20] |
| WCAG mechanisms | untested | SC 1.4.4 needs text resizable to 200 percent without loss. SC 1.4.12 needs the layout to survive line-height 1.5, paragraph spacing 2em, letter spacing 0.12em and word spacing 0.16em [21][13]. | Owed: two cheap tests against the pane. The fixed 3rem top bar, the 36px strip and hanging punctuation are where to look. | [13][21] |

Where the sources disagree, and how to read it for glosa:

| Parameter | One side | Other side | Reading |
|---|---|---|---|
| Body size ceiling | Legge and Bigelow: practice sits at 0.23 to 0.24 degrees, and reading slows above about 2 degrees [1] | Rello 2016: gains continue to 18 to 22pt, "far beyond" the usual 10/12/14 [2] | Both say 18px is not too big. Rello's sizes are Arial on a 75 ppi screen, so only the direction transfers, not the numbers. A control that goes up to 24px covers both. |
| Line-height ceiling | Butterick 1.2 to 1.45, iA 1.4 [11][12] | WCAG AAA at least 1.5, Material 1.5, Rello 1.68 harmless [9][14][2] | 1.62 is over the practitioners' ceiling and over the standards' floor. Keep it. |
| Measure | Dyson and Kipping: 100 characters read fastest [10] | Dyson and Haselgrove: 55 was comprehended better and rated easiest. Bringhurst 66. WCAG cap 80 [10][6][9]. | Speed and comfort pull apart. Both sides accept 66 to 80 real characters, and glosa's serif lines sit inside that range: about 74 on average, 76 at most [216]. |
| Heading weight | Apple and Material: Regular for large titles [14][15] | Butterick: bold stands out better. Apple: avoid Light [16][15]. | Anything from 400 to 650 is defensible |

#### The pair

Keep Source Serif 4 for the manuscript and Source Sans 3 for the chrome. The evidence:

- **Designed as companions.** Adobe describes Source Serif 4 as "designed to complement the Source Sans 3 family", with "a careful match of letter proportions and typographic color". Griesshammer calls it "a friendly companion to Paul D. Hunt's Source Sans" [32][33].
- **Measured metrics are close.** At the instances glosa renders (serif opsz 18, both at Regular), the x-heights are 0.481 and 0.486 em, 1.2 percent apart [215]. The gap is 2.3 percent at the serif's default optical size and up to 7 percent at display sizes [215]. Adobe matched proportions and colour, not x-height [33]. The verdict does not rest on this number. The companion design and the same-foundry rule carry it. Verification: C4.
- **The practitioners' pairing rule is exactly this one.** Butterick: combine fonts by the same designer, and most documents tolerate a second font but few a third [34]. Google Fonts Knowledge extends the rule to a whole foundry, which covers the Source case [35]. Apple models the same move, with New York beside SF [15].
- **The one gap is the mono.** The system monos are 11 to 15 percent taller than the serif in x-height (SF Mono 0.526, Menlo 0.547), and the 0.85em inline-code ratio is silently tuned to that. Source Code Pro (x-height 0.478 at its default instance, "design based on Source Sans") would complete the family for about 70 KB [36][37]. It would need inline code re-tuned to about 0.95 to 1.0em and code blocks to 14 to 15px to keep today's apparent size. The argument is harmony inside the manuscript, not consistency across machines. glosa is macOS-only, so `ui-monospace` is always SF Mono or Menlo.
- **Apple's typography guidance backs three of glosa's choices:** avoid light weights, keep to two families, and use a designed serif companion beside a UI sans [15].

#### Dark-mode typography

| Parameter | Guidance | glosa today | Verdict | Source |
|---|---|---|---|---|
| Body weight in dark | Light-on-dark text looks heavier (the irradiation illusion). Type designers compensate by going lighter, not bolder, and so does the one font built for the problem: about 0.85x weight, or a grade axis around -50. | 400, no compensation | A correct default. If anything, trial 380 for body and 580 for strong via the wght axis. Never add weight. | [38][39][40] |
| Which mode is default | Positive polarity (dark text on light) gave more accurate proofreading for younger and older adults without eye disease. The effect is medium: proofreading eta squared 0.06. Eta squared is an effect size, the share of variance explained. Reading rate did not differ in the 2013 study and rose with light in the 2014 one. The advantage grows as text shrinks and is concentrated in dim rooms. Light is the correct default, and dark stays opt-in. | "Use system setting" as the default, light as the design baseline | Correct. Apple asks apps to follow the system rather than offer an app-only switch. NN/g makes an exception for long-form reading apps, and glosa is one. | [41][43][44][45][47][48] |
| Where to compensate in dark | The polarity penalty grows as text shrinks. That study tested 8 to 14pt, at about 0.22 to 0.34 degrees of x-height. On common setups glosa's 18px body is about 0.18 to 0.20 degrees, at or below the small end of that range. So the body is affected, not only the chrome and notes. | chrome 11 to 13px, notes 15px, body 18px, all unchanged in dark | The size control matters more than any dark-only change. If a dark-only bump is trialled, add +1px on the smallest tiers: chrome 13 to 14, notes 15 to 16, address 11 to 12. Never change weight. | [1][44] |
| Ink and surface | Material: dark grey, not black, with white text at 87 percent emphasis. Apple: strive for 7:1 in small text, and desaturate accents on dark. | Warm near-black at L 0.205, off-white ink at L 0.93. Hand and session are desaturated, at 6.9:1 and 8.4:1. | Already follows the standards | [41][42] |
| Dark must be complete | Some low-vision readers (with cloudy ocular media) read 10 to 15 percent faster in reversed polarity, and nothing predicts who. | six component-level overrides outside the token block | The people dark helps can only find out by trying it. Every surface must be tokenised, not patched. | [146][147] |

#### Candidate pairs, and whether adding any is worth its bytes

Every candidate is OFL, covers Polish and has a true italic [37][49][50][51]. What separates them is x-height at 18px, whether they have an optical-size axis, file size, and whether the vendor designed them for continuous on-screen reading. Read x-height as a size and measure cost, not as a legibility verdict. No single metric predicts perceived size for every face, so a low x-height means "needs a larger body", not "unreadable" [5]. The cost of vendoring comes from variable-font axis data, not glyph count. Subsetting Source Serif 4 to Latin plus Latin Extended saves almost nothing (217 KB). Limiting wght to 400 to 700 gives 153 KB. Pinning opsz gives 72 KB, but loses the Display and Subhead cuts the headings get today [37][53].

The x-heights in this table are each file's default instance. At the instances glosa renders, Source Serif 4 is 0.481 at 18px and Source Sans 3 is 0.486 at Regular [215].

| Rank | Faces (serif / sans / mono) | x-height serif / sans / mono | Cost (subset woff2) | Why | Worth the bytes? | Source |
|---|---|---|---|---|---|---|
| 1 | Source Serif 4 (keep) / Source Sans 3 (keep) / Source Code Pro (add) | 0.475 / 0.478 / 0.478 | +33 KB roman, +35 KB italic. Net near zero after subsetting the sans (166 to 65 KB, 135 to 51 KB). | Designed companions. Same-foundry rule. The only opsz serif already shipped. | Yes: it completes the family for about 70 KB, and the sans subset pays for it | [32][34][36][37] |
| 2 | Literata / IBM Plex Sans (or keep Source Sans 3) / IBM Plex Mono | 0.507 / 0.516 / 0.516 | Literata 193 + 196 KB with full axes, 68 + 69 KB with opsz pinned. Plex Sans 48 KB pinned. | The one serif designed and tested for backlit continuous reading (Play Books). Its opsz range of 7 to 72 spans notes to h1. Upright italic. Polish covered. | Yes, as one alternative body serif behind the face chooser, not as a replacement | [37][49][51] |
| 3 | Alegreya (at 19px to match apparent size) / Alegreya Sans / Source Code Pro or Plex Mono | 0.456 / 0.461 / 0.478 | Serif 66 + 67 KB. Sans 34 + 35 KB per style. | One designer, "originally intended for literature", an ATypI award. A literary second voice. | Only if the register wants a second voice, and not before Literata | [37][50] |
| not top three | Newsreader / Public Sans or Inter / JetBrains Mono | 0.426 / 0.517 or 0.546 / 0.550 | 173 + 195 KB | Built for on-screen news reading, but its low x-height needs a 20px body | No | [37][55] |
| not top three | IBM Plex Serif / Sans / Mono | 0.516 all | about 23 + 25 KB serif per static style | Identical metrics across one superfamily. A corporate rather than a paper register. | No, for glosa's register | [51] |
| not at 18px | Serifs: EB Garamond, Crimson Pro, Spectral, Fraunces, Merriweather 2024 | 0.405 / 0.420 / 0.450 / 0.482 / 0.555 | Merriweather 1.16 MB per style | Garamond, Crimson and Spectral have low x-heights that need a 20 to 21px body. Fraunces is built for display. Merriweather has a large file and an opsz floor of 18. | No | [37][54] |

Readwise and Instapaper both chose one accessible sans: Atkinson Hyperlegible Next, 38 + 41 KB, OFL on Google Fonts [52][59][80]. Add it on its typographic merits if the face list is widened. Do not make an accessibility claim for it. The only peer-reviewed evidence on "accessible" faces is negative (see What users actually prefer) [149][152].

### Question 3: a theming and font model people stay for

**Verdict: option B, with D's file format underneath it, C as a later import path, and E never.** In one line: one identity, reader comfort controls, accessibility variants, a validated theme file and fonts served by the daemon, plus typed local font names as a Chromium and shell extra.

#### Options

Scores run from 1 (poor) to 5 (strong). Effort is measured inside glosa's stack: plain CSS tokens, vanilla modules, a Bun daemon and no build step. "Invariant risk" means the risk to honest provenance: hand, pencil and session must stay distinguishable and legible. Scores for B, C and E were adjusted after verification.

| Option | Audience fit | Evidence | Effort | Invariant risk | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| A. Keep one identity plus light and dark only | 3: iA, Craft and Notion show that a single-voice product survives without a catalogue [56][74][75] | 2: every reading app ships size, spacing and width controls. glosa is below the floor of its class for the one act it exists for [59][82][86]. Added after the completeness pass: when appearance does make people leave these tools, the reason is mostly comfort, which A lacks [277][281][282]. | none | none | low | Not enough on its own |
| B. One identity plus reader comfort controls (face, size, leading, measure, presets) plus accessibility variants (high-contrast light and dark, colour-vision), on GitHub's structure | 5: the Kindle, Books, Readwise and Firefox Reader shape, which a pastor or PM already knows [82][84][89] | 4: size has the clearest performance evidence. No fixed default clears the reading floor on every screen, and that is itself the case for a control [1]. Polarity research favours a light default with dark opt-in [43][45]. Fonts differ in preference, not in measured speed [5][226]. GitHub's variants are a structural precedent, not reading evidence [101]. | M: tokens and data attributes on the pane (the `packages/spa/src/face.js` pattern), one token block per variant, and a preload that maps each id to a scheme | low: colour stays untouched except in variants, which are re-checked against the same floors | low to medium | Recommended |
| C. Curated presets ported from palette specs, with protected provenance tokens | 2: mostly developers, though Bear sells these palettes to general note-takers and Joplin ships them free [61][135][219] | 2: no reading evidence. Every port needs remapping and a contrast override, after which it is glosa's interpretation [117][139]. | M to L: a Base16 importer, a validator, naming and attribution | medium: every family has an accent near the hand or session hue, which a port reuses on purpose. The real risks are the theme's own meaning for that hue and the tight hand-to-danger gap in Solarized and Gruvbox [217]. | medium: upstream drift, attribution, licence review | Later, as a role-based import. Never as a named catalogue. |
| D. User theme files and custom fonts, Obsidian style | 3: the Bear, Drafts and Obsidian half of the class offers any installed font [60][65][67]. Fewer than 5 percent of people change any setting [157]. | 2: Firefox is the only reader with custom colours [84]. No reader offers font upload. | M: a JSON loader and validator, a daemon-served font folder, a typed `local()` family name and a user CSS tier | high for raw CSS (it can make hand and session equal, and that cannot be checked). Low for a validated JSON. Low for fonts. | medium (an "unsupported" tier) | Yes for the theme JSON, which is B's substrate, and for daemon-served font files. Typed local font names as a Chromium and shell extra. User CSS opt-in and unsupported only. |
| E. Full editor-theme catalogue | 1: puts glosa with MarkText, Bear Pro and Joplin, away from every reading app [61][73][219] | 1: theme popularity measures editor populations [135][136][137]. Added after the completeness pass: enthusiasts invest in themes, but no source links having themes to keeping users [291][300]. | L | high: every family's accents land on the hand or session hue, with their own meanings attached. Two names need care [125][126][217]. | high | No |

#### The recommended model

One identity, three layers of choice, one file format:

1. **Reading comfort on the document pane.** An "Aa" popover, the reading-app convention, with a basic layer (size, preset, measure, face) and a Customize layer (leading, letter and word spacing). Firefox, Kobo and Apple Books split their controls this way. Settings are remembered per person per device. The per-document face stays the only per-document override. One click resets everything [59][81][82][84][86].
2. **Appearance in Settings.** Use system setting / Light / Dark, plus High contrast light and High contrast dark, and later a colour-vision variant. `prefers-contrast: more` selects the high-contrast pair automatically [102][191].
3. **Power users work through files.** A validated `glosa-theme.json` (16 slots plus a scheme flag). A Base16 importer over the same validator. A user font folder that the daemon serves, which works in every supported browser. "Use a font from this Mac" by exact name, in the shell and Chromium only. An opt-in, unsupported Custom CSS file [114][170][194].
4. **The shipped catalogue stays small:** Paper, Paper high contrast, Lamp (dark) and Lamp high contrast. Five named variants is the ceiling in this class. Beyond it a product hands off to a format and a community, which a one-maintainer alpha should not take on [64][69][78].
5. **Defaults carry the product.** Most people never open a setting, so the strong Source Serif 4 on warm paper is what most people will ever see [157][158].

The user-voice pass (added after the completeness pass, not adversarially verified) points the same way. Comfort complaints are more common than identity complaints and read as need. The clearest cases of leaving follow a change to a look people had adopted (see "Does disliking the look make people leave?").

#### Controls to expose, in priority order

First release (the floor for this class of product):

1. **Text size.** 5 to 7 steps from 15 to 24px, default 18, applied to the manuscript scale only. It works together with browser zoom and the shell's existing zoom menu. It also scales notes and the composer by one step. Every product in the class has it, and it is the first thing low-vision readers need [1][2][21][59][239].
2. **Reading presets:** Default, Compact, Large and Low vision. Each is a bundle of size, leading, measure, face and tracking, stored as a preset id plus overrides, with a Reset. People cannot judge their own best settings: half guess wrong [30]. Readability research and Apple Books both converge on a few typographic presets [148][82]. The Wallace study shows only that preferences differ, not that any face or setting makes reading faster (C11) [5][226]. Bundles win on simplicity, because most people never tune settings [157]. The case for them is comfort and ownership, not speed.
3. **Measure.** Narrow / Default / Wide, at about 55 / 68 / 80 real characters, capped at the WCAG AAA limit of 80. Set per face in `ch`, so the sans gets its own value [9][26][27][216]. This first requires decoupling `--manuscript-block` (707px) from the rail ladder.
4. **High-contrast light and dark variants, plus `prefers-contrast: more`.** After warm paper and the reading lamp, this is the last real theme gap. It is also where readers moved in 2024: Firefox added Contrast and Gray, GitHub added 7:1 themes, and since 2025 GitHub has a separate Increase contrast switch [84][102][236].
5. **Line spacing.** 1.45 / 1.62 / 1.8. The 1.5 floor stays reachable for AAA. The block gap stays at least 1.5x the leading [9][13].

Second release:

6. **Faces.** Keep Default / Sans / Mono. Fix the sans at about 18px with its own measure. Vendor Source Code Pro. Add one alternative serif (Literata), and consider Atkinson Hyperlegible Next on its merits [36][49][52].
7. **Fonts beyond the vendored set.** First, a user font folder served by the daemon (see Implementation shape). It is the only route that works in a Safari tab [170][232]. Second, "Use a font from this Mac" in the shell and Chromium. A typed name is written into a runtime `@font-face` with `local()` pairs, using the exact PostScript and full names, because a family name does not match. `document.fonts.check` confirms it loaded [194][233]. `font-size-adjust` narrows the apparent-size gap as progressive enhancement. It is a partial fix, not a perceptual match [202][5]. In the Electron shell, an optional click-gated `queryLocalFonts` picker could sit behind glosa's own confirmation, because Electron's permission handler was reported bypassed [196][197].
8. **Letter and word spacing,** under Customize only: tracking 0 / +7 / +12 percent, word spacing up to 0.16em, included in the Low vision preset. Strongly supported for dyslexia, discouraged for everyone else [30][31][27].
9. **A colour-vision variant, if anyone asks.** GitHub's version swaps red and green for orange and blue [103]. glosa's hand and session already form that pair. A verifier simulated full dichromacy: protanopia, deuteranopia and tritanopia, which lack the red, green and blue cones respectively. The simulation kept hand and session clearly apart [218]. What such a variant would fix in glosa: `danger` against `ok`, which collapse under deuteranopia, and `hand` against `danger`, which are close for everyone and closer under tritanopia [218].
10. **The Base16 importer and the Custom CSS tier, last.**

Never:

- a justify toggle, because WCAG 1.4.8 asks that text not be justified [9]
- free colour pickers for ink or paper. Firefox is the one reader precedent, and pickers endanger the provenance floors [84].
- font upload by URL
- line focus

#### Surfaces beyond the manuscript (added after the completeness pass)

The model above covers the rendered Markdown manuscript: tokens on `:root`, and reading controls on the pane. glosa paints text on other surfaces too. This section records what reaches each one today, from a follow-up research lane. It was not adversarially verified.

**Answer first.** Colour tokens and dark mode already reach the manuscript, the chrome and chat. A size control built on `--manuscript-size` would reach only the manuscript body. Page zoom (Cmd +) is the only size control that reaches every surface today. It stays the accessibility floor: WCAG accepts scaling to 200 percent "using at least one text scaling mechanism supported by user agents" [21].

| Surface | What reaches it today | What does not | Mechanism it would need | Class | Source |
|---|---|---|---|---|---|
| Rendered manuscript and rich editor | Colour tokens, dark mode, the face chooser, and the hand (selection, washes, margin text) | Size reaches only the body. Headings and code blocks are fixed in rem. The rail ladder is fixed in px (707, 1205). | One reading scale that headings, code and the rail all derive from (decision 26) | design flaw | [268][273] |
| Margin notes, composer, chrome | Colour tokens, dark mode | Size. Notes are fixed at 15px serif. The chrome uses a fixed rem scale from 11 to 22px. | Page zoom covers the chrome. Tie notes to the reading scale if wanted. | none today | [273] |
| Chat pane | Colour tokens, dark mode | Size: agent replies 15px serif, human turns 15px sans, detail rows 12px mono. Face: agent replies use `--font-serif`, not `--font-manuscript`. The hand appears only as the caret. | Map agent replies to the reading scale and face. Decide the colour of the human's own turns (decision 31). | decision owed | [273] |
| Diff and History panes (diff2html) | Dark mode, through a variable remap scoped to dark only | In light mode the panes keep diff2html's own white palette. In every mode they keep its own fonts: Menlo at 13px, and "Source Sans Pro", which is not vendored. | Unscope the remap (decision 18). Override the table and wrapper fonts (decision 25). | tech debt | [262][272][273] |
| Class F: agent-written HTML in a sandboxed, cross-origin frame | Partly dark mode, through the browser, in Chromium 129 and later | Tokens, size, face and hand. Saved marks are never drawn on the words. There is no print path. | See the levers table below | limit of the approach, plus dead code | [241][243][245][249][251][264][266][267][269][270] |
| Agent-login terminal (xterm) | Nothing | It shows xterm's default white on black at a fixed 13px, in a raw `#161616` box. In light mode it is an inverted console, which the dark theme's own brief rules out. | A theme object built from the tokens, a contrast floor and the mono stack (decision 24) | design gap | [258][259][260][261][271][273] |
| Print (Markdown documents only) | The face, since #398 | A white palette: 7 palette tokens are reset, and marks and addresses are hidden, at 12pt / 1.45. `--hand`, `--session`, `--pencil`, `--rule` and `--surface-sunken` are not reset | Reset or override every token a preset can set (decision 32) | missing guardrail | [241][268][273] |
| Electron window and blocking page | Nothing | The window keeps Electron's default white background. The blocking page is hard-coded light. | `backgroundColor` from the resolved theme, and a themed blocking page (decisions 18, 25) | tech debt | [206][263][274] |

Class F in more detail:

- **Dark mode reaches class F through the browser, not through glosa's tokens.** The frame inherits glosa's resolved `color-scheme`, the CSS property that picks the browser's light or dark defaults. Chromium passes it on to the document's `prefers-color-scheme`. Chrome supports this from version 129. Electron 44.4.5, glosa's shell, ships Chromium 152. When a document declares no colour scheme, it then shows as an opaque white page on the dark desk, because the spec requires an opaque page when the two schemes differ. In light mode, an undeclared document sits on glosa's paper. Safari ignores the parent's scheme and follows the OS [241][243][244][245][246][265].
- **A probe confirmed this and found one case that must never ship.** In Chrome 154, a frame forced light over a dark background shows black text on a dark background, which cannot be read. Appendix 2b has all four cases [264].
- **Nothing inside class F is painted yellow.** The brief for this lane assumed it was. The injected `.glosa-bridge-mark` rule at `packages/daemon/src/security/classf-bridge.ts:53` is dead CSS, because nothing in the repo applies that class. The real gap has two parts. The reader's live selection inside the frame uses the system highlight, not the hand. Saved marks are never drawn on the words. Class: a design gap plus dead code (tech debt). It is not a bug users see today [266][267][268].
- **glosa's faces cannot reach class F.** Inside an opaque-origin frame (a sandbox gives the frame a null origin, which fails every same-origin check), every font fetch is cross-origin. Each fetch then needs an `Access-Control-Allow-Origin` header, and `packages/daemon/src/transport/classf-serve.ts` never sends one. The probe suggests that a document's own bundled fonts are blocked today and silently fall back. That is probably a live bug, but it has not been reproduced against the daemon yet [249][250][264][269].
- **Size can reach class F without the bridge.** In the probe, CSS `zoom` on the iframe element scaled a sandboxed cross-origin document, and the frame's box grew by the same factor. Safari's behaviour is unverified [251][264].

Hosts that show foreign HTML theme it by injecting host variables and a theme class that the content can choose to use. VS Code webviews and Figma plugins both work this way. None of them restyles arbitrary pages. Obsidian injects nothing, and offers a re-render in its own typography instead (Reader mode) [252][253][254][255][256][257]. glosa's daemon already writes the HTML it serves. So it could inject `--glosa-*` tokens and a theme class inside a low-priority `@layer`. A `@layer` is a CSS cascade layer, and the document's own unlayered styles override it. That reaches future agent-written documents, not arbitrary foreign HTML. Appendix 2c compares the hosts.

| Lever | Reaches | Layer changed | Theme switch without reload | Crosses the A3 §2 bridge | Main risk |
|---|---|---|---|---|---|
| `color-scheme` on `.glosa-classf iframe` (inherited today) | Light or dark, through `prefers-color-scheme` and the page background | SPA CSS | Expected in Chromium, not probed | No | A frame set light over a dark background is unreadable. Safari ignores it. |
| CSS `zoom` on the iframe element | Size | SPA CSS or JS | Yes | No | The box grows by the factor. Safari unverified. |
| Serve-time injection in the bridge `<style>`, inside `@layer glosa`, with both palettes under `prefers-color-scheme` | Selection in the hand colour, opt-in `--glosa-*` variables, a theme class | Daemon, `packages/daemon/src/security/classf-bridge.ts` | Follows the frame's scheme in Chromium | No | It alters foreign HTML. The layer keeps the document's own styles winning. |
| Theme or preset parameters sent at capability creation and stored in the capability record | Any preset palette, size | The A1 §7 mint API | No: needs a reload with a fresh capability | No | A reload loses the document's scroll position and state |
| `Access-Control-Allow-Origin` on class-F fonts plus a class-F font route, or data: URIs | Face | Daemon serving; A1 §7 and A3 §1 | No: needs a reload | No | A wider route surface, or about 290 KB of base64 per face per load |
| A new parent-to-frame message (theme, draw marks) | Theme switching without reload; saved marks in the hand colour | An A3 §2 amendment, plus a validator in the untrusted bridge script | Yes | Yes | The document's own scripts can read every posted value |
| `nativeTheme.themeSource` mirroring an explicit Light or Dark | `prefers-color-scheme` in every frame, plus native UI | Shell main process plus preload IPC | Yes | No | Electron only |

Sources for the levers: [206][241][249][251][252][253][264][266][267][269][270].

Every lever except a new parent-to-frame message stays outside the class-F bridge. The bridge is a MessageChannel pipe whose message types A3 §2 fixes: selection, mark, ready and error. In practice it is one-way. The injected script only sends, and after the one-time `glosa:init` handshake the parent posts nothing [267][270]. So anything that must change inside the frame without a reload needs an A3 amendment. Keep that out of option B.

Other surfaces: fixes

- **Terminal.** It is an xterm constructed at `packages/spa/src/agent-login.js:57` with no `theme` and no `fontFamily`. xterm offers a full theme object (ITheme, its colour-theme interface) and a `minimumContrastRatio` option, which raises foreground contrast dynamically [258][260][271]. VS Code's terminal defaults this option to 4.5 [261]. A floor matters here because the provider's login UI emits colours tuned for its own background. None of this crosses the class-F bridge.
- **Diff.** diff2html's `colorScheme` option defaults to light. Its `auto` value follows the OS, not glosa's explicit choice, so do not use it [262]. glosa remaps the `--d2h-*` variables only under the dark selector (`packages/spa/src/app.css:5090` to 5115). There are no `.d2h` font overrides [272][273]. Insertions and deletions already use `--ok` and `--danger`, well away from the hand. Presets must keep those two distinct from `--hand`.
- **Electron window.** The BrowserWindow at `packages/shell/src/main.ts:248` sets no `backgroundColor`, so it defaults to white. The blocking page at line 125 is an inline light data: page [263][274]. Setting `nativeTheme.themeSource` to glosa's explicit choice makes `prefers-color-scheme` match in every frame, including class F, but only in Electron [206].

Other surfaces: decisions and guards

- **Chat.** Agent replies are long prose set at a fixed 15px `--font-serif` (`packages/spa/src/app.css:7431`). The lane recommends giving them the reading scale and `--font-manuscript`. A human's turn is a surface bubble and does not use the hand colour. A message is not a mark, so today's choice is consistent with the invariant, but it should be made on purpose [273].
- **Print.** Since the print rework (#398), `@media print` (`packages/spa/src/app.css:6243-6453`) keeps the page's face (`--font-manuscript`) on white paper at 12pt / 1.45, resets 7 palette tokens (`--bg`, `--ink`, `--muted`, `--surface`, `--border`, `--border-strong`, `--primary`) and hides every passage address and mark. `--hand`, `--session`, `--pencil`, `--rule` and `--surface-sunken` are not reset, which is harmless only because marks do not print. It sets `print-color-adjust: economy`, so the browser may lighten colours further. Class F has no print path: the print function returns early for anything that is not a Markdown document (`packages/spa/src/artifact-pane.js:1169-1170`) [241][268].
- **A forward risk, low confidence.** The CSS working group has reportedly resolved that `color-scheme` should affect `prefers-color-scheme` in every context, not only in embedded ones [247]. If browsers ship that, "Use system setting" could start reading back glosa's own choice instead of the OS. The reason: `packages/spa/src/appearance-preload.js:14` reads `prefers-color-scheme` and then sets the root scheme [265]. Chrome 154 had not shipped the change. The Media Queries 5 draft lists a `ua-color-scheme` feature for the user's own preference, but the fetched text was cut off before that section [248].

#### Invariants a theme must honour, with the contrast floors

The gate is the WCAG 2.2 ratio, because WCAG 2 is the only normative floor. WCAG 3 has not chosen an algorithm [19][204]. APCA is a newer, polarity-aware contrast formula, and Lc is its contrast score, where higher means more contrast. It is shown only as an advisory readout next to each swatch [203]. Floors are checked against the theme's own `bg` and `surface`. A failing theme is refused, with the token and ratio named. It is never repaired silently, because a corrected vermilion is no longer the theme the person chose.

| Token | Used as | WCAG floor | APCA advisory | Extra rule |
|---|---|---|---|---|
| `ink` | Body text for hours | 4.5:1 minimum. 7:1 for the shipped catalogue [19][20]. | Lc 90 | |
| `muted` | Secondary text | 4.5:1 | Lc 75 | |
| `faint` | Disabled only | exempt | | Refused if mapped to a live text role |
| `hand` | Marks, focus ring, margin text | 4.5:1 as text. 3:1 as a line and wash edge [25]. | Lc 75 | OKLCH hue at least about 90 degrees from `session` (a glosa design value, not a standard). Chroma above `pencil`. Also a hue distance from `danger` (see decision 21). |
| `pencil` | Unsent mark | 4.5:1 | Lc 60 | Chroma ceiling of about 0.03, so it still reads as graphite |
| `session` | Session marks | 4.5:1 as text. 3:1 as a line. | Lc 75 | Hue distance from `hand`. Shape redundancy (bracket vs underline) stays as the SC 1.4.1 backstop [24]. |
| `danger`, `warn`, `ok` | State text and icons | 4.5:1 for text. 3:1 for icons. | Lc 60 | Hue families fixed: red, amber, green, as Catppuccin fixes its roles across flavours [121] |
| `border-strong`, focus ring | Component boundaries | 3:1 [25] | Lc 30 | |
| `contrastMore` set | Under `prefers-contrast: more` | 7:1 for ink and muted. 4.5:1 for the six meaning tokens as lines [20]. | Lc 90 / 75 | Derived automatically when a theme omits it |

Three more invariants are not ratios:

- Every theme is a light-and-dark pair or declares its scheme. 32 percent of Obsidian's catalogue is dark-only, and a dark-only theme would break the preload [69].
- "Use system setting" stays the default, so the app never looks broken against the OS appearance [41].
- Reading controls (size, leading, measure, face) never live in a theme. A person who wants a bigger page keeps it across every theme [208].

Mark colours are where identity and comfort meet (added after the completeness pass). In 2024 Bear redesigned its highlighter and changed the default colour, which drew a 58-post feedback thread. Bear then made the old themed colour the default again and added three colour-blind palettes [289][290]. This supports two rules. First, `--hand`, `--pencil` and `--session` are never free user colours and never come from an imported palette. Second, each theme derives them against a floor, with the vermilion hue kept recognisably the same.

These floors protect solid colours only. The translucent derived tokens (the hand's underline and the washes) have no floor yet. See Not covered.

#### Implementation shape

Token layering uses three layers. The shape matches what DTCG (the W3C Design Tokens Community Group's JSON format), Radix, shadcn and Open Props converge on, and it maps almost one to one onto glosa's current token block [177][178][179][180].

| Layer | Tokens | Who sets it | Protection |
|---|---|---|---|
| 1 Theme slots | `bg`, `surface`, `surface-sunken`, `ink`, `muted`, `faint`, `border`, `border-strong`, `rule`, `hand`, `pencil`, `session`, `danger`, `warn`, `ok`, `scrim`; `scheme: light or dark`; optional `contrastMore` | The theme JSON (the shipped catalogue, a Base16 import, or a person's own file) | The floors above. A failing theme is refused by name. |
| 2 Derived | `desk`, `hand-wash`, `hand-hover`, `hand-line`, `pencil-wash`, `session-wash`, `session-wash-strong`, `primary`, `primary-hover`, focus ring, `shadow-ink`, plus three new tokens (`elevated-bg`, `elevated-border`, `settled-opacity`) and one `on-danger` | `packages/spa/src/app.css` only. Use `color-mix(in oklch, ...)` first: it works at both browser floors, and the file already uses it 40 times. Use relative colour syntax (`oklch(from var(--hand) l c h / 0.14)`) only where `color-mix()` cannot express the value, with a static fallback for Chromium below 119 [182][189][190][230]. | Not settable by a theme. Solid derived tokens inherit their parent's floor. Translucent ones do not. `--hand-line` is the hand at 70 percent alpha, and the washes are 10 to 22 percent (`packages/spa/src/app.css:75` to 79 and 223 to 224). So a hand that passes its floor can still give a line that fails 3:1. These tokens need floors of their own (see Not covered). |
| 3 Fixed | radii, shadow structure, z, motion, layout widths, type scale, `text-wrap`, `hanging-punctuation` | `packages/spa/src/app.css` | Never set by a theme |
| Faces and sizes | `--font-manuscript`, `--manuscript-size`, `--manuscript-leading`, `--measure` (per face), tracking | Per-pane `data-face`, `data-size`, `data-leading` and `data-measure` attributes (the `packages/spa/src/face.js` pattern), plus a font registry | Independent of the theme |

Delivery, inside the existing constraints.

Theme delivery:

- **Switching.** Keep `data-theme` on `html`, and generalise its value to a theme id. The preload keeps reading localStorage, but now maps the id to a scheme through a tiny literal table, so first paint gets the right `color-scheme`. "Use system setting" maps to a chosen light id and a chosen dark id. The scheme list gets one source instead of three files [205].
- **Serving.** The daemon renders every validated theme JSON into one `/app/themes.css`, at startup and on every change. That file is allowlisted like `packages/spa/src/app.css`. A served file sits under `style-src 'self'` and can be cached. An injected `<style>` would rely on `'unsafe-inline'` [169]. The live SPA CSP still allows `'unsafe-inline'` (`style-src 'self' 'unsafe-inline'` at `packages/daemon/src/security/csp.ts:31`). A comment at `packages/daemon/src/transport/http.ts:180` prefers a served stylesheet under `style-src 'self'`. Reading that comment as a plan to drop `'unsafe-inline'` is an inference [269]. A runtime fetch of a theme JSON would be transport, so it would belong in the one data-access module (R6).
- **CSP.** Unchanged. `font-src 'self'` already permits same-origin woff2 and forbids `data:` and remote fonts. `img-src`, `connect-src` and the shell's loopback gate stop even a hostile user stylesheet from phoning home. So the remaining risk of raw CSS is legibility, not egress, which is why raw CSS is a separate unsupported tier [167][168][170].
- **Shell.** Set the `BrowserWindow` `backgroundColor` from the resolved scheme. Mirror the explicit choice into `nativeTheme.themeSource`, so native dialogs and the window before first paint agree with glosa [206]. This needs one new bridge call. A3 §4b lists four today: a one-shot presentation token, open folder, an OS notification and reveal in Finder (`docs/appendices/A3-security.md`, section 4b) [270]. Added after the completeness pass: theme the blocking page with the same two palettes. `themeSource` also makes class-F frames agree in the shell, even where the frame's scheme is not inherited [263][274].

Fonts:

- **`local()` fonts.** Since Safari 12.0 (September 2018), WebKit has hidden user-installed fonts from all CSS font matching as a defence against fingerprinting. That covers `local()` and plain `font-family` names alike. Only system fonts and web fonts resolve [195][232]. Firefox does the same in Private Browsing and in ETP Strict, its strictest Enhanced Tracking Protection mode [234]. Chromium, and so the Electron shell, honours user-installed fonts. But `local()` matches only the exact PostScript or full name, not the family name [233]. glosa lists Safari 16.4 and later as supported, so a feature built on `local()` alone would silently fall back there. The portable route is the user font folder below. `local()` and the Local Font Access API (Chromium-only) are extras for the shell and Chrome [188][209].
- **User font files (the portable route).** `GET /app/fonts/user/<id>.woff2` serves from a registry that the daemon builds at startup. It lists the config font folder, checks the wOF2 magic bytes, caps the size and assigns ids. Themes reference ids, never paths. Files are served as bytes with `nosniff` and the same headers as the vendored files. A traversal test like the existing one at `packages/daemon/test/http.test.ts:473` guards the route. The files are same-origin, so `font-src 'self'` allows them, no network is involved, and Safari accepts them as web fonts [170][200].
- **Fonts to touch anyway.** Subset Source Sans 3 to Latin plus Latin Extended. That saves about 185 KB across both styles with no visible change. Record the subsetting recipe: `pyftsubset` with the unicode ranges and `--layout-features+=onum,pnum,tnum,smcp,c2sc,locl`. Keep the serif's opsz axis. Keep an explicit `font-weight` on every element that uses Source Sans 3 or Source Code Pro, because their default instance is weight 200 [37][200][201].

Checks and platform:

- **Validation.** Compute the WCAG 2 ratio in TypeScript inside the daemon's theme loader: OKLCH to linear sRGB, then relative luminance. That is about 60 lines with no dependency. Run it over every shipped and imported theme. Add a `bun test` that lowers one theme's ink and expects the loader to name that theme and token (the ablation rule) [19]. This is where contrast floors are enforced. A CSS clamp on lightness cannot guarantee a WCAG ratio against an arbitrary background. Vendor `apca-w3` only after reading its licence terms. Otherwise show WCAG alone [203].
- **Media queries to add.**
  - `prefers-contrast: more`, a real variant.
  - `forced-colors: active`, a 20-line block with system colours: Highlight for the human's mark, a 2px CanvasText border for the session bracket, dashed for pencil, and outline rather than box-shadow for focus. It is Windows-only, so it ships untested and says so.
  - `prefers-reduced-transparency`, with opaque washes. It is Chromium-only.

  Sources: [191][192][193][186].
- **Support floors.** Everything above is supported in Electron 44 (Chromium 152). In a Safari tab, both features shipped in Safari 16.4, the floor itself: relative colour syntax (without `currentcolor` or system colours) and `font-size-adjust` (with a single number). The floor that lacks both is Chromium 111. Chrome gained relative colour syntax at 119 and `font-size-adjust` at 127. So treat `font-size-adjust` as progressive enhancement with no fallback code. Use `color-mix()` for derived colours. Give any relative colour syntax a static fallback for older Chromium. Verification: C15 [181][227][228][229][230][231].

### What the comparable tools ship

Every product row comes from a page a research lane opened. No product's features are reported from memory. The three full tables are in Appendix 1:

- 1a: writing tools and reading apps
- 1b: reading products by control
- 1c: the code-editor themes

#### The two conventions, in five lines

1. **The median writing tool** has a light-and-dark axis plus a catalogue behind one house default. The catalogue is either curated defaults with a community gallery, or a fixed set of 5 to 9. Typography sits in a Settings page, with any installed font or 3 to 4 curated faces, plus size, line height and width. User CSS is the escape hatch. iA, Notion and Craft ship no catalogue at all and survive [56][62][67][75].
2. **The median reading app** has an in-context "Aa" popover. It holds a short curated font list, size, spacing, width or margins, and a few paper-like page colours. There is no catalogue and no CSS. The numbers vary widely. Controls range from 3 (Safari) to about 10 (Kobo, Apple Books, Firefox), split into a basic layer and a Customize layer. Page colours range from light and dark only (Readwise) to five presets plus custom colours (Firefox). Global memory is documented only for Safari and Firefox; Readwise saves per device. Against this class, glosa lacks the typography and accessibility layer (size, leading, width, spacing, contrast) more than it lacks page colours. Verification: C14 [59][81][82][84][86][237].
3. **Dark is almost never "a theme".** It is an axis every theme must satisfy, either as a light-and-dark pair per theme or as a separate mode switch. Only reading apps treat black as one more page colour [63][68][82][100].
4. **Where a catalogue exists, the shipped default set stays tiny (2 to 9), and one house default is named.** The big numbers are communities, not products: Obsidian about 1,000, Ulysses 389, Typora about 200 [64][69][71].
5. **Editor palettes appear as built-in themes only in note-taking and Markdown apps,** never in reading apps: Bear Pro, MarkText, Joplin and Standard Notes. From 2024 to 2026, reading apps moved toward finer typographic control and accessibility variants, not palettes. Examples: Firefox's Contrast and Gray themes plus custom colours, the accessible faces in Instapaper and Readwise, and GitHub's 7:1 themes. Verification: C3 [61][73][84][102][219][220].

### What users actually prefer

Read each row by its context column. Evidence about long-form prose reading transfers to the manuscript. General-UI evidence transfers to the chrome and to defaults. Developer evidence transfers to no one in glosa's primary audience. Rows marked "performance" measure how well people read, not what they choose.

Effect sizes, glossed once: eta squared is the share of variance explained (0.06 is medium). d and dz are standardised differences, dz for within-person designs. g is Hedges' g, where 0 means no effect.

Light versus dark:

| Study or source | Context | Sample and task | Result | Effect size or figure |
|---|---|---|---|---|
| YouGov daily question, Feb 2024 [141] | Phone system setting, general GB public | 2,561 GB adults, smartphone mode preference | The public prefers light on phones. This says nothing about desktop long-form reading or glosa's audience. 4 percent have no smartphone, and 18 to 24 year-olds prefer dark, 53 to 38. It shows only that about 3 in 10 choose dark even on phones. Verification: C10. | 58 percent light, 29 percent dark, 9 percent do not know |
| Android Authority polls 2020 and 2026 [142][143] | General UI, enthusiasts | 2,514 and 3,110 reader votes | Enthusiasts prefer dark | 81.9 percent dark (2020). 73.3 percent always dark and 15 percent scheduled (2026). |
| Litmus email data 2022 [144] | General UI, inherited OS setting | tracked email opens | A third of opens are in dark mode | 35 percent |
| Buchner and Baumgartner 2007 [46] | Performance: long-form prose, proofreading | 3 experiments | Dark text on light is better, whatever the ambient light or colour | eta squared 0.23, 0.06, 0.10 |
| Piepenbrock et al. 2013 [43] | Performance, not preference: short timed proofreading on a desktop screen, at a text size comparable to glosa's body | 84 younger (18 to 33) and 85 older (60 to 85) adults, with clinically relevant eye disease excluded. Dark room. Pure black on white against white on black. 250-word texts for 50 s each, about 23 minutes in all. | Dark text on light found more errors at both ages. Reading rate, eyestrain and mood did not differ. The authors attribute the advantage to overall screen luminance, not to polarity itself. | Proofreading eta squared 0.06 (medium, no age interaction). The large figures (acuity eta squared 0.30, d 2.17 younger, 0.58 older) come from a Landolt C threshold test at 184 cm (a ring-gap acuity test), not from reading. |
| Piepenbrock et al. 2014, Ergonomics [45] | Performance and preference: proofreading with pupil measurement | 35 adults, within subjects | Light gave a smaller pupil, better accuracy and faster reading. 82 percent preferred light. | pupil 2.09 vs 3.65 mm (dz 2.96); accuracy dz 0.77; reading rate dz 0.68 |
| Piepenbrock et al. 2014, Human Factors [44] | Performance: small text | proofreading at 8 to 14pt | The light-mode advantage grows as text shrinks | linear with decreasing size |
| Dobres et al. 2017 [47] | Glance reading (automotive), general UI | 34 adults, bright vs near-dark ambient light | In bright light polarity does not matter. In the dark, light-on-dark is much worse. | F(1,33) = 49.6 in the dark; interaction F = 14.18 |
| Ergonomics 2025 and ETRA 2025 [145] | General UI, cognitive tasks and dashboards | 173 online participants; within-subjects dashboards | Light mode scores higher on cognitive tests. Dark helps dashboards only at medium complexity. | not extracted |
| Legge et al. 1985; CEO 2024 [146][147] | Low vision, prose | low-vision readers; 48 vision-impaired children | Readers with cloudy ocular media read faster in reversed polarity. Nothing clinical predicts who. | 10 to 15 percent faster; no predictor |
| Terra case study 2021 [155] | General UI, engagement | web traffic | Honouring `prefers-color-scheme` and prompting an opt-in cut the bounce rate | Windows bounce 27.25 to 10.82 percent |
| Stack Overflow 2020 [156] | Developers | Meta feature requests | Dark mode was the most upvoted request | 12th of 41,785 questions |

Fonts, spacing and colour:

| Study or source | Context | Sample and task | Result | Effect size or figure |
|---|---|---|---|---|
| Wallace et al. 2022 [5][163][226] | Short prose passages ("interlude reading") | 352 crowd readers, passages of about 170 words, 5 of 16 fonts each (their preferred font, Times, Noto Sans and two random ones), size normalised per font by crowd vote | Preferences differ. The reported speed gaps do not survive reanalysis. A reanalysis of the open data reproduced them with the font labels shuffled. Each reader's "fastest" font ran at 0.995 of their average on held-out passages. So the gaps are a selection effect. Verification: C11. | Reported: 35 percent faster fastest vs slowest (314 vs 232 WPM), 14 percent faster than preferred, preference at chance. Reproduced at 34 and 15 percent with shuffled labels. |
| Rello and Baeza-Yates 2017 [30] | Prose, readers with and without dyslexia | 92 participants | Customisability serves the population better than one setting. Only half can guess their own best parameters. | preference vs time r = -0.13 (2013 study) |
| Rello and Baeza-Yates 2013; Wery 2017; Kuster 2017; meta-analysis 2026 [149][150][151][152] | Dyslexia, prose (Wery and Kuster partly letters and word lists) | 48 readers eye-tracked; 12; 317; 15 studies, N = 688 | Dyslexia fonts do not help, and that finding is robust. The advice that sans or roman faces and no italics help rests on one study. In it, reading time did not differ significantly, faces were not matched for x-height, and a serif was among the top three. Arial Italic was the slowest face but not the least preferred. Verification: C12. | OpenDyslexic gave no gain and was least preferred. Pooled g = -0.04 [-0.15, 0.07]. |
| Marinus et al. 2016 (verification) [238] | Dyslexia, children | Dyslexie against Arial | Dyslexie's small gain disappeared once Arial's spacing was matched | The benefit comes from spacing, not letter shapes |
| Zorzi et al. 2012 [31] | Dyslexia, children | Italian and French dyslexic children | Extra-large letter spacing improves reading without training | substantial (figures not extracted) |
| Rello and Bigham 2017; Frontiers 2025 [153][164] | Prose on screen | 341 readers (89 dyslexic); 40 students | Warm backgrounds (peach, orange, yellow) beat cool ones. Light green beat white for first-language reading. | control mean 12.28 s on Peach vs 18.82 s on Blue Grey |
| THERIF 2023 [148] | Prose readability research | hundreds of readers with and without dyslexia, four iterations | In reading research a "theme" is a typographic preset. The pipeline converged on three (Compact, Open, Relaxed), not a catalogue. | three themes |

Settings and choice:

| Study or source | Context | Sample and task | Result | Effect size or figure |
|---|---|---|---|---|
| Nielsen 2024 (Spool 2011); NN/g 2005 [157][158] | General UI | Word users | Most people never change any setting. The default is the product. | under 5 percent changed any setting |
| Iyengar and Lepper 2000; Scheibehenne 2010; Chernev 2015 [159][160][161] | Choice, general | about 754 shoppers; 63 conditions; 99 observations | Choice overload is real when options are complex, the task is hard and preferences are uncertain. Fonts and palettes qualify. Otherwise it is near zero. | 30 percent bought from 6 jams vs 3 percent from 24; b = .41 with moderators vs .04 without |

#### Does disliking the look make people leave? (added after the completeness pass)

**Answer: rarely.** Appearance is seldom why people leave long-form reading and writing tools. When it is, the reason is mostly comfort (size, contrast, line length) or an unwanted change to a look they had adopted. A small, vocal minority leave because they dislike a well-made default face or palette. iA Writer is the documented case, and it has lasted more than a decade with a fixed identity.

These findings were not adversarially verified. All sources are self-selected. People who quietly stop using a tool leave no review, and no source here measures churn.

Why people leave, or say they would:

| Finding | Evidence | Confidence | Source |
|---|---|---|---|
| Function drives departures, not looks | 14 US App Store review feeds, 50 reviews each, cover iA Writer (iOS and Mac), Bear, Ulysses, Readwise Reader, Craft, Notion and Kindle. They hold about 140 low-star or "I left" reviews that give a reason. About 2 to 3 name identity (the face). About 5 name comfort (text size, a size change, a mark colour that is harder to read). The rest name data loss, sync, search, bugs, pricing or AI. Appearance comes up far more often as praise. | medium | [275][276][277][278][279][280][281][282] |
| Changing a look people have adopted is the real risk | In 2018 iA Writer replaced its font: "It's not an option, just gone". In 2024 a Ulysses update enlarged headings, and a subscriber wrote "won't be renewing my subscription". In 2025 Kindle darkened its highlight colour: "harder to read what I've highlighted". In 2024 Bear restored its old highlight colour after a 58-post thread. | medium | [279][280][281][282][283][290] |
| A fixed face loses a small minority | iA Writer: 4 of 50 most-helpful Mac reviews criticise the font. None of the Mac reviews from Oct 2025 to Aug 2026 do. A few people say they left or avoid the app. The vendor has not moved: faces were still fixed at v8.0.9 (Sep 2026), and the app offers 12 text sizes. | medium | [280][284][285][286][287][288] |
| Comfort complaints outnumber identity complaints and read as need | Notion: iPad text is too small and Cmd +/- does not work, one of five reasons a reviewer stopped paying. Craft: "For aging eyes", which 72 of 73 readers found helpful. Obsidian's line-length request has 100 likes and 34,177 views. A Dutch base rate: more than a fifth of mobile users increase text size. | medium | [277][278][279][293][294][297][298][302] |
| No published churn analysis links appearance to leaving | NN/g (2023): "we would be very surprised to see users avoid or abandon a design because it does not support dark mode". Spool (2011): under 5 percent of Word users changed any setting, against 40 to 80 percent of programmers and designers. | medium | [303][304][305] |

What comparable products did:

| Finding | Evidence | Confidence | Source |
|---|---|---|---|
| The closest reading tool ships one identity plus comfort controls | Readwise Reader offers light, dark and auto; several faces, including Atkinson Hyperlegible and OpenDyslexic; size from 14 to 80px; line spacing; and width. Its 25 low-star reviews contain no appearance complaint. Bear's team made the same choice for its long-form app Lettera (2026): no themes, but font, size, line height and paragraph spacing. | high | [59][276][291][292] |
| Users who ask for themes frame it as identity, and users split on it | In the Lettera thread, one user says themes foster "a sense of identity that keeps users loyal". Another wants Lettera "more opinionated than Bear". Ulysses lists 389 community themes, and Obsidian's Minimal theme thread has 739 posts. No source links themes to keeping users. | low | [64][291][300] |
| A changed mark colour had to be restored | After Bear's 2024 highlighter redesign, the old themed colour became the default again. Bear also added Deuteranopia, Protanopia and Tritanopia palettes and tuned the text colour per theme. | medium | [282][289][290] |
| Issue trackers ask for size, zoom and structure more than palette | Typora's top issues are vim bindings (299 reactions), plugins (286) and Grammarly (206). Its top theme issue has 74. Obsidian's largest "looks" thread (792 likes) is about hiding Markdown syntax. | medium | [299][300][301] |
| Typesetting quality is a third kind of complaint | Kindle comments on HN (2010 to 2020) criticise justification, word spacing and hyphenation. None says the reader left. | low | [305] |

How this maps to the options. The lane concluded that the user voice "supports option A plus comfort controls". In this report's terms, that is option B's first release: one identity, reader comfort controls and a higher-contrast variant. What the user voice does not support is a named theme catalogue (options C and E). Its priority order matches the first release: browser and OS zoom, text size, line length and leading, then a higher-contrast variant. It also supports a slightly wider set of vetted faces, plus an installed-font option. Appendix 2 holds the full ledger, the App Store sample and the timeline of backlash after changes.

#### What this means for defaults

Modes:

- **Warm paper (light) stays the shipped default and the design baseline.** The proofreading studies measure something close to glosa's core act, and they favour light for younger and older adults without eye disease [43][45]. The one general-population poll points the same way, but it is about phones and cannot carry the decision [141].
- **Dark stays a complete, first-class, opt-in reading-lamp variant.** It is never the promoted mode, and it never gets smaller type. The polarity penalty grows as text shrinks, and glosa's 18px body sits inside the range where it was measured, not only the chrome and notes [44].
- **"Use system setting" is the right default.** An in-app override is justified for a long-form reading tool [41][48][155].

Faces and settings:

- **Offer a few structurally different faces as a comfort and ownership choice.** Preferences differ, but no study here shows that choosing a face makes reading faster. The per-document chooser is the right shape [5][226].
- **Do not vendor OpenDyslexic, and make no accessibility claim for any face, the sans included.** The better-supported accessibility levers are letter and word spacing, text size and a warm background. glosa has these, or can add them cheaply [31][149][152][153][238].
- **Appearance settings are not a lever for keeping users.** Demand evidence exists (dark mode, fonts). No published churn analysis was found. Added after the completeness pass: the user-voice pass found appearance rarely cited as a reason to leave. Most people never open the panel. Invest in the default. Ship the few things people loudly ask for: dark, size and a face. Keep a shipped look stable [156][157][275][303].

### Decisions left for the maintainer

34 decisions, in five groups:

- Numbers 1 to 23 are the verified list.
- Numbers 24 to 34 were added after the completeness pass and were not adversarially verified.
- Sizes are T-shirt estimates from XS to L, never calendar time. They were made in this edit from the report's own descriptions, and no costing lane ran (see Not covered).
- "Blocks" names the work that should wait for the decision.

#### Fix now

| # | Decision | Recommendation | Size | Blocks |
|---|---|---|---|---|
| 18 | Theme-readiness fixes, whatever the theming decision | Add an `--on-danger` token, which fixes the 2.78:1 dark-mode bug. Make the diff2html remap unconditional. Replace the inline dark overrides with three elevation tokens. Keep one source for the scheme list. Set the shell's `backgroundColor` and `nativeTheme.themeSource`. | M (five small items) | Every new theme or variant. The shell item needs one new bridge call. |
| 19 | Safari mark-painting gap | Raise the A6 Safari floor to 17.2, or add a DOM fallback for `::highlight()`. Today a reader on Safari 16.4 sees no marks on the page. | XS (raise the floor) or M (fallback) | Any claim that Safari 16.4 is supported |
| 22 | `html lang` | Set it per document. Today spellcheck and screen readers treat Polish documents as English. Low cost, with no theming dependency. | S | Polish hyphenation and typesetting rules (Not covered) |
| 24 (added) | Agent-login terminal | Build xterm's theme from the tokens: background `--bg`, foreground `--ink`, cursor `--hand`, selection `--hand-wash`, and the 16 ANSI slots from the palette. Use the `--font-mono` stack and `minimumContrastRatio: 4.5`. Assign a new theme object on every appearance change. | S | A light mode that matches the rest of glosa |
| 25 (added) | Diff fonts and the Electron blocking page | Override `.d2h-diff-table` to `var(--text-sm)/1.6 var(--font-mono)`, and the wrapper to `--font-sans`. Do not switch diff2html to `colorScheme: 'auto'`, which follows the OS, not glosa's choice. Theme the shell's blocking page with the same two palettes. | XS | Presets reaching the diff pane |

#### Typography values

| # | Decision | Recommendation | Size | Blocks |
|---|---|---|---|---|
| 1 | Default body size: 18px, or 19 to 20px | Keep 18px and ship the size control. No single px value clears the reading floor on every ordinary Mac setup, so the control and the shell's zoom do the work. Do not change the default without a reader test. | M (the control) | Nothing. The control itself waits on 4 and 26. |
| 2 | h4 to h6: 17px or body size | 18px. Weight 600 does the work (Apple's Headline model), so a bold run is never larger than a subheading. | XS | none |
| 3 | Sans face: 16 or 18px | 18px. These two faces agree on every size metric, so at 16px the sans paints about 10 percent smaller. | XS | The sans measure (4) |
| 4 | Measure unit | Keep 68ch for the serif. Give the sans its own `ch` value, about 63 to 64ch. Do not move to a single px or rem measure, which would lengthen sans lines. Decouple `--manuscript-block` from the rail ladder before any measure control ships. | M (the decoupling) | The measure control and the size control |
| 5 | Paragraph gap: 1.2em or 1.0em | Try 1.0em in a side-by-side mock-up first. Never add an indent on top of a gap. | XS | none |
| 6 | Heading weights: 650/620, or 500 to 550 for h1 and h2 | A visual trial only. The evidence does not force either. | XS | none |
| 13 | Dark-mode small sizes | The size control comes first. A +1px dark-only trial on chrome, notes and address labels is optional. Never change weight in dark. | XS | none |
| 26 (added) | One reading scale | Derive headings (in em of the body), code blocks and the rail ladder from one reading scale. Otherwise a larger body puts h3 below body text (20px against 22px). | M | The size control (1) |
| 27 (added) | Manuscript tables set in the chrome sans at 15px | No source rates this either way. Decide from a side-by-side mock-up whether tables keep the chrome sans or take the manuscript face. | XS | none |

#### Fonts

| # | Decision | Recommendation | Size | Blocks |
|---|---|---|---|---|
| 7 | Vendor Source Code Pro | Yes, about 70 KB. Re-tune inline code to about 0.95 to 1.0em and code blocks to 14 to 15px. Set an explicit weight everywhere it is used. | S | Code-block size is settled with it |
| 8 | Subset Source Sans 3 and record the recipe | Yes. It saves about 185 KB and pays for the mono. | S | Pays for 7 |
| 9 | A second body serif | Literata, but only when the face list is revisited. Not EB Garamond, Crimson Pro, Newsreader or Merriweather at an 18px body. | S | none |
| 10 | Atkinson Hyperlegible Next as a fourth face | Add it on typographic merit if the list is widened. Make no accessibility claim in copy. | S | none |
| 23 | Custom fonts | Ship the daemon-served user font folder first. It is the only route that works in a Safari tab. Add typed `local()` names as a shell and Chromium extra, with the hint "In Safari, only fonts added to glosa's font folder are available." | M | none |
| 28 (added) | Fonts in class-F documents | Keep glosa's faces in class F out of option B. Getting them there is a serving-layer change (A1 §7, A3 §1), not styling. Separately, a document's own bundled fonts are probably blocked by CORS, the browser's cross-origin permission check. Confirm that against the daemon, then file it. | S (confirm and file) | none for option B |

#### Controls and themes

| # | Decision | Recommendation | Size | Blocks |
|---|---|---|---|---|
| 11 | Preset names | Default, Compact, Large, Low vision. Avoid "Focus" (Apple uses it for a spacing bundle) and any palette names. | XS | The presets |
| 12 | Where controls live | An "Aa" popover on the document pane for reading comfort (a basic layer plus Customize). Settings for mode and defaults. One owner for the scheme list. | S (decide), M (build the popover) | Every reading control |
| 14 | Sepia preset | Skip it for now, because warm paper already plays that role. Add it later only as a comfort option. | XS | none |
| 15 | Theme file format | A flat `glosa-theme.json` with 16 slots and a scheme flag. A DTCG export only if an external tool asks for one. | M (loader and validator) | High-contrast variants, 16 and 17 |
| 16 | Base16 importer | After option B ships, and only if someone asks. Role-mapped, validated and named for what it does. Any scheme derived from GitHub or Monokai gets a neutral label and attribution. | M | none |
| 17 | Custom CSS tier | Defer it. When it is added: opt-in, unsupported, disabled in one click, and never the only way to change a colour. | S | none |
| 29 (added) | Class-F dark policy | Choose one policy and write it down. (a) Inherit: documents that support dark follow glosa, and undeclared ones stay a white page in dark. (b) Show foreign documents as paper: set the frame's `color-scheme` to light AND give the frame host a light background. Never do one of these without the other. Safari follows the OS either way. | S | Any claim that dark mode or a variant covers class F |
| 30 (added) | Class-F selection colour and size | Replace the dead yellow rule with a `::selection` in the hand wash, injected at serve time inside a low-priority `@layer`. Use CSS `zoom` on the iframe for size. Keep drawing saved marks out of option B, because it needs an A3 §2 amendment. | S | none for option B |
| 31 (added) | Chat pane | Decide whether the reading size and face apply to agent replies. The lane recommends the same reading scale and `--font-manuscript`. Decide on purpose whether a human's chat turn carries the hand colour. Today it does not. That is consistent with the invariant, because a message is not a mark. | S | The scope of the size control |

#### Rules to write down and tests owed

| # | Decision | Recommendation | Size | Blocks |
|---|---|---|---|---|
| 20 | Tests owed before controls ship | 200 percent zoom (WCAG 1.4.4) and the 1.4.12 spacing override, both against the pane. The ablation test for the theme validator. | S | Shipping any reading control |
| 21 | Design values that are proposals, not standards | Hand-to-session hue distance of about 90 degrees. A pencil chroma ceiling of about 0.03. A minimum hand-to-danger distance: glosa's `--danger` (hue 22) sits only 20 degrees from `--hand` (hue 42), and a colour-vision simulation found the pair close for everyone and closer under tritanopia. Adopt these or replace them, but write them down. | XS | The validator (15) |
| 32 (added) | Print contract | Every token a preset can set is either reset under `@media print` or comes from a dedicated print block. Since #398 the print block resets 7 palette tokens; `--hand`, `--session`, `--rule`, `--surface-sunken` and `--pencil` are not reset, which is harmless only because print hides marks. Add a test that prints under each preset and asserts the white palette. The page's face reaches print (#398); the screen size does not. | S | Any preset |
| 33 (added) | A guard for "Use system setting" | Add a test that "system" follows an emulated OS change while the root scheme is set explicitly. Plan a fallback OS signal: `ua-color-scheme` once it ships, or `nativeTheme.shouldUseDarkColors` in Electron. Confidence is low, so confirm the reported CSS working group resolution first. | XS | none |
| 34 (added) | Stability of the shipped look | Between releases, do not retune the hand, pencil or session hues, the faces, or the body size and measure without an opt-back path and a changelog line. | XS | none |

### Not covered

The completeness pass named six gaps. Two were researched and folded in above: the surfaces beyond the manuscript, and the user voice. The rest, plus the limits of the added lanes, are listed here.

| Topic | Why it matters | Class | What would close it |
|---|---|---|---|
| Polish typesetting | The maintainer reads and writes Polish, and a pastor reading a Polish sermon is a core reader. The study checked only glyph coverage and characters per line. Four things went unchecked. First, single-letter words (a, i, o, u, w, z) left at the end of a line, which `text-wrap: pretty` does not prevent. Second, Polish quotation marks „…” with `hanging-punctuation: first`. Third, hyphenation, which needs `lang="pl"`, while `packages/spa/src/shell.html:3` hard-codes `lang="en"`. Fourth, in a two-line h1 at line-height 1.1, capital acutes (Ś Ć Ź Ń Ó) colliding with ogonek descenders (ą ę) on the line above. | limit of the approach (the reading evidence is English-only), and a possible visual defect nobody has checked | Polish typesetting sources. A fontTools check of the accent and ogonek extents in the vendored serif. A Chromium render of a two-line Polish h1 at 40px, weight 650. |
| Marks and washes across themes | The floors protect `hand`, `pencil` and `session` as solid colours. On the page, though, provenance shows mostly through translucent derived tokens. `--hand-line` is the hand at 70 percent alpha, and the washes are 10 to 22 percent (`packages/spa/src/app.css:75` to 79 and 223 to 224). The underline is a fixed 2px at a 3px offset. The completeness review's rough composite puts today's light-mode `--hand-line` near 3.3:1 on paper. So a theme whose hand sits exactly at 4.5:1 would put its line under 3:1. Nothing checks ink on a wash, or that a wash stays visible on a new background. The margin-note type size rests on Butterick and Apple only. | a design flaw in the protection model | The composited contrast of each derived token over the 16 tested backgrounds, extending `a local file (not committed)`. Floors for derived tokens. A decision on whether the underline thickness scales with size. |
| High-contrast variants | They are recommended as the first new themes, but the report gives no token values and no derivation method. It never checks that hand, session, pencil and danger stay apart near 7:1, and hand and danger are only 20 degrees apart today. The validator converts OKLCH to sRGB with no gamut mapping. So on a Mac showing P3, the computed ratio may not be the ratio on screen. Also unchecked: whether macOS Increase contrast and Reduce transparency trigger `prefers-contrast` and `prefers-reduced-transparency` in the Electron shell and in Safari. | a gap in the recommended first release | Concrete OKLCH values for all 16 slots of both variants, with ratios, hue distances and a colour-vision simulation (`a local file (not committed)`). CSS Color 4 gamut-mapping behaviour per browser. A platform check. |
| Cost and sequencing | The sizes in the decision tables are editorial estimates, and no costing lane ran. The named prerequisites are not costed item by item. They include decoupling `--manuscript-block` (`packages/spa/src/app.css:176`, used at 3758 and 4300), the px rail constants that break when the browser's default font size grows, and one source for the scheme list. They also include a test matrix of themes × faces × sizes × modes, which grows multiplicatively. | missing decision input | Sizing per decision, with prerequisites and owed tests. A first PR that holds only the Fix now items. |
| Question 2 items without a source | The mono face at 15px, code blocks at 13px, and manuscript tables in the chrome sans at 15px are unrated. Engineers reading design docs are a named audience, so the code sizes matter. | unanswered | A source on code in prose, or a reader test using side-by-side mock-ups |
| Limits of the two added lanes | WebSearch was exhausted, so every source came from a known URL or public API. Reddit was not reachable. No vendor feedback board was reachable for Readwise, Ulysses, iA, Craft or Notion. The App Store sample is US-only, 50 reviews per feed, and self-selected. Safari was not probed. The probes ran in Chrome 154 against a stand-in server, not against glosa's daemon or Electron 44, because glosa's use is attended-only on this machine. The version of the vendored xterm is unknown. | limit of the approach | A search-led repeat. A daemon-level repro of the font CORS block. A Safari probe. |

### What verification weakened

A verification pass checked 16 load-bearing claims and contested 12. Each contested claim appears in the body in its verified, weaker form, tagged with its ID. This table keeps the draft wording, the objection and the effect.

| ID | The draft said | The verifier's objection | What changed | Source |
|---|---|---|---|---|
| C1 | Nine of ten editor palettes put an accent within 1 to 24 degrees of the hand or session hue. So a faithful port would make a human mark look like bold text and a session mark look like a link. | All ten families do, and any palette of 6 to 14 hues guarantees it. glosa colours neither bold text (weight 600 in ink) nor links (underlined ink), so a mark has nothing to be mistaken for. | The collision reason is weakened to "borrowed meaning and lost warmth" in Question 1 and in options C and E | [140][217] |
| C2 | GitHub (a trademark) and Monokai Pro (proprietary) cannot ship at all | GitHub publishes its palette under MIT, and Typora ships a built-in "Github" theme. Only a label implying affiliation is a risk. The study asked about classic Monokai, which VS Code ships under MIT. Only Monokai Pro may not be copied. | The licensing table is softened to naming care. Classic Monokai is usable with attribution. | [221][222][224][225] |
| C3 | Only 2 of 24 prose products ship editor palettes (Bear 2 Pro, MarkText) | Joplin ships Dracula, Nord and two Solarised themes free. Standard Notes ships Solarized Dark on paid tiers. The other 22 products are not listed, so the count cannot be audited. | The audience reason is weakened. Two rows were added to the writing-tool table. | [219][220] |
| C4 | The pair's x-heights match within 1.5 percent | 0.478 is the sans's ExtraLight master. At the rendered instances the x-heights are 0.481 and 0.486 em, 1.2 percent apart. The gap is 2.3 percent at the serif's default optical size and up to 7 percent at display sizes. Adobe matched proportions and colour, not x-height. The cited font file holds no x-height data. | The pair verdict is unchanged. It rests on the companion design and the same-foundry rule. | [33][215] |
| C5 | The 18px body is 0.196 and 0.176 degrees, under the 0.20 critical print size | These are x-height angles at assumed distances. 0.2 degrees is a consensus inside a 0.15 to 0.3 band, and one founding study has a mean of 0.17. Ordinary scaling and distance move the body between about 0.15 and 0.24 degrees. | The verdict is reframed as "at the floor, with no reserve". A size control is preferred over a new default. | [1] |
| C6 | Rello 2016: fixation time fell up to 18pt (24px), and comprehension was lower at 10 and 12pt | Fixations kept falling significantly up to 22pt. The study used Arial on a 75 ppi screen with uncontrolled line length and never states pixels. "24px" is a unit conversion that does not transfer to Source Serif 4 on a Retina Mac. | Only the direction transfers, not the numbers | [2] |
| C7 | Perceived size is x-height, and studies compare faces at matched x-height | Point size is not perceived size. But the one empirical test (Wallace 2022) found readers matched overall letter height more often than x-height, and it did not itself match its fonts by x-height. Most studies use one fixed px size. | The sans at 18px is regrounded on metric parity between these two faces. x-height no longer ranks faces on its own. | [4][5] |
| C10 | YouGov: 58 percent light, 29 dark, 9 don't know | This is a phone setting among the general GB public. 4 percent have no smartphone, and 18 to 24 year-olds prefer dark, 53 to 38. It says nothing about desktop long-form reading or glosa's audience. It shows only that about 3 in 10 choose dark even on phones. | The poll no longer carries the light-default decision | [141] |
| C11 | Wallace 2022: the fastest font was 35 percent faster than the slowest and 14 percent faster than the preferred one, and preference predicted speed at chance | A reanalysis of the open data reproduced 34 and 15 percent with the font labels shuffled. Each reader's "fastest" font ran at 0.995 of their average on held-out passages. The gaps are a selection effect, and the study shows only that preferences differ. | Face choice is justified on comfort and ownership, not speed. The description of the study sample was corrected. | [226] |
| C12 | Dyslexia fonts do not help. Sans and upright faces do. Arial Italic is worst. | Only the first part is robust. The sans and upright advice rests on one study, where reading time did not differ significantly, faces were not matched for x-height and a serif was among the top three. Arial Italic was the slowest face but not the least preferred. | Spacing and size became the accessibility levers | [149][150] |
| C14 | The median reading app has an "Aa" popover with 4 to 6 controls and 3 to 8 page colours, remembered globally | The shape holds, but the numbers do not. Controls range from 3 (Safari) to about 10 (Kobo, Apple Books, Firefox), split into basic and Customize layers. Page colours range from light and dark only (Readwise) to five presets plus custom colours (Firefox). Global memory is documented only for Safari and Firefox. Readwise saves per device. | The recommended popover is split into a basic layer and a Customize layer | [59][81][82][84][86][237] |
| C15 | Relative colour syntax needs Safari 18, and `font-size-adjust` needs Safari 17 | Both first shipped in Safari 16.4, the floor itself: relative colour without `currentcolor` or system colours, and `font-size-adjust` with a single number. The floor that lacks both is Chromium 111. Chrome gained relative colour at 119 and `font-size-adjust` at 127. | `color-mix()` comes first. Relative colour is used only with a static fallback. `font-size-adjust` is progressive enhancement. Contrast floors are enforced in the daemon. | [227][228][229][230][231] |

Four claims were confirmed, with tighter wording:

| ID | Claim | Tighter wording now in the body |
|---|---|---|
| C8 | 68ch holds about 76 / 75 / 81 characters | Capacity is separated from ragged-line averages. The fix changed from a px or rem measure to a per-face sans measure. |
| C9 | Piepenbrock 2013: light is better at both ages, rate is unaffected, accuracy improves | Performance, not preference. Eye disease was excluded. The proofreading effect comes first. The body text sits inside the small-text range. |
| C13 | GitHub ships nine themes | Nine public themes, 14 built, plus a contrast switch. A structural precedent, not reading evidence. The colour-vision variant is scoped to danger and ok. |
| C16 | Safari ignores user fonts via `local()`, and Chromium honours them | Safari hides them from all CSS matching. Chromium needs exact names. Firefox hides them in private modes. Daemon-served font files became the portable route. |

### Method

**How to read this version.** A verification pass checked 16 load-bearing claims. Each claim went through two lenses. One was source: does the cited page say it? The other was applicability: does it hold for glosa's readers and code? The tally was 4 confirmed, 12 contested and 0 dropped. Confirmed claims carry the tighter wording the verifiers gave. Each contested claim now appears in its verified, weaker form, tagged with its ID (C1 to C16). The draft wording, the objection and the effect are in "What verification weakened". Where an objection changed a verdict, the verdict is softened and says so.

**Research lanes.** Seven research lanes ran on 2026-09-27:

- reading typography
- font pairing and dark mode
- writing-tool theming
- code-editor themes
- user preference evidence
- theming implementation
- reader comfort controls

Two code audits of the repository at 6a77f15 ran the same day, one on typography and one on theme-readiness.

**How the lanes gathered evidence.**

- Every product feature was read from the product's own help page, release notes, store listing or repository.
- Every research figure was read from the paper itself, using locally extracted PDFs. When a publisher page was paywalled, the figure came from a Europe PMC or Semantic Scholar record.
- Every font metric was measured with fontTools on the vendored or downloaded font files.
- Every hue and contrast figure was computed with a small script from published hex or OKLCH values.
- Pages that returned 403 or 503 are marked as gaps in the lanes and are not cited here: Amazon Kindle help, Medium and Substack support, and Arc's Boosts page.

**Disagreements between lanes.** Where two lanes disagree, the report shows both figures. Three such cases:

- The Obsidian theme count: 806, 1,040 and 1,099, all from the same registry file.
- The session contrast: 8.27:1 computed, against about 8.9:1 in `DESIGN.md`.
- The Source Sans 3 subset size: 65 KB measured, against about 90 KB estimated from separate Fontsource files.

**What verification changed.** The verifiers found that the font inventory cited as [37] holds no x-height or line-length data. Those figures now cite the measurement scripts [37][215][216]. No claim was dropped, so no conclusion lost its support entirely. Three lost part of it:

- the supporting reasons in Question 1 (audience, collision, licensing)
- the reading-speed case for a face chooser
- the advice that sans and upright faces help dyslexia

Each is stated in its weaker form.

**Added after the completeness pass.** A completeness critic reviewed the verified report and named six gaps. Two were researched in follow-up lanes: surfaces outside the Markdown manuscript, and user-voice evidence on whether appearance makes people leave. Their findings are marked "added after the completeness pass" throughout. They were NOT adversarially verified: no second lens checked their sources or their applicability. They cite sources [241] to [305]. The other four gaps were not researched and are listed in Not covered:

- Polish typesetting
- marks and washes across themes
- high-contrast values and platform settings
- cost and sequencing

The two added lanes had limits. WebSearch was exhausted, so all their sources came from known URLs or public APIs. Reddit was not reachable. The probes ran in Playwright's Chrome 154 against a python http.server on two ports, not against glosa's daemon or Electron 44. glosa itself was not started, because its use is attended-only on this machine. Safari was not probed.

**Corrections in this version.** The completeness critic found three factual defects, and all three are corrected:

- Derived tokens were said to be unable to break a floor they inherit. That is false for translucent mixes such as `--hand-line`, the hand at 70 percent alpha.
- A3 §4b lists four shell bridge calls, not three.
- The live SPA CSP at `packages/daemon/src/security/csp.ts:31` still allows `style-src 'unsafe-inline'`. The claim that glosa means to drop it is now marked as an inference from the comment at `packages/daemon/src/transport/http.ts:180`.

The surfaces lane read a working copy of the print rework before it merged as #398; the print values in this report are those of #398 as merged.

**Editorial pass.** This version applies the critic's structure notes:

- three verdicts come first
- the Answer first section carries no objections or citations
- decisions are grouped, with estimated sizes
- terms are glossed on first use
- licensing is merged into one table
- citations are moved out of verdict sentences
- the three product-catalogue tables are moved to Appendix 1

### Appendix 1: product catalogues

#### 1a. Writing tools and reading apps: appearance catalogue (writing-tool lane)

Every row comes from a page a lane opened. "n/d" means not documented on the pages opened. "y" means reported only by a practitioner or community source. Rows marked "(verification)" were added from sources the verifiers opened.

| Product | Built-in themes | Theme model | Font choice | Size | Spacing | Width / margins | Dark model | Source |
|---|---|---|---|---|---|---|---|---|
| iA Writer | Light, Dark only | none (fixed) | 3 faces: iA Mono, Duo, Quattro | Text size slider | n/d | Line length limit 64 / 72 / 80 | separate axis | [56] |
| Ulysses | default set (names n/d) plus 389 community | curated defaults, community gallery, Mac theme editor | font picker; iOS default San Francisco, .ttf or .otf upload | zoom | Line Height, Paragraph Spacing, First Line Indent | Line Width | every theme has light and dark versions; View menu switch | [62][63][64] |
| Bear 2 | 3 free (Red Graphite, High Contrast, Dark Graphite); about 32 Pro incl. Solarized, Dracula, Nord, Gruvbox, Catppuccin, Rosé Pine, Tokyo Night | fixed curated set | any OS-installed font for Text, Headers, Code | yes | line height, paragraph spacing, indentation | line width | themes individually light or dark | [60][61] |
| Joplin (verification) | Light, Dark, Dracula, Solarised Light, Solarised Dark, Nord, Aritim Dark, OLED Dark, all free | fixed set | n/d | n/d | n/d | n/d | dark themes are separate named themes | [219] |
| Standard Notes (verification) | Midnight, Futura, Autobiography, Titanium, Dark, Dynamic Panels, Carbon, Solarized Dark (Solarized Dark on paid Plus and Pro tiers) | fixed set | n/d | n/d | n/d | n/d | dark themes are separate named themes | [220] |
| Obsidian | 2 base schemes plus accent; community themes (three lanes counted the same registry file and got 806, 1,040 and 1,099; about 59 percent ship both modes, 32 percent dark only) | community marketplace, CSS snippets | Interface, Text, Monospace font fields, any installed | font size slider, zoom | via CSS | Readable line length toggle | base scheme axis independent of theme | [67][68][69] |
| Typora | 6 built-in (github, newsprint, night, pixyll, whitey, gothic); about 200 gallery | CSS files, base.user.css | CSS only | Preferences font size | CSS | CSS | separate theme per mode | [70][71] |
| Zettlr | 5 (Berlin, Frankfurt, Bielefeld, Karl-Marx-Stadt, Bordeaux: accent plus face) | fixed set, custom.css | bound to theme | Editor font size | CSS | CSS | each theme has light and dark; Dark mode manual, scheduled or follow OS | [72] |
| MarkText | 33 (10 light, 23 dark incl. One Dark, Dracula, Nord, Solarized, Gruvbox, Catppuccin, Rosé Pine, Tokyo Night, Monokai Pro) | fixed set, Custom CSS | n/d | n/d | n/d | n/d | separate light and dark themes | [73] |
| Logseq | light, dark, system | marketplace themes, custom.css | n/d | n/d | n/d | n/d | mode axis | [97] |
| Craft | Light / Dark / System plus accent | per-document page styles; no catalogue | 4: System, Serif, Mono, Rounded; no upload | zoom | n/d | n/d | document colour white in Light, black in Dark | [74] |
| Notion | Use system / Light / Dark; high contrast (beta) | none | per page: Default, Serif, Mono | Small text toggle | none | Full width toggle | separate axis | [75][76] |
| Google Docs | mobile: Dark / Light / System default | none | document formatting only | none | none | none | mode axis; collaborators do not see it | [77] |
| Scrivener 3 | Mac 5, Windows 9 | fixed set plus .scrtheme files | per interface element | per element | n/a | n/a | dark themes are separate named themes | [78] |
| Drafts | built-ins plus Directory; JSON theme format | curated, community, JSON | any installed font plus separate mono | base font size | line height multiplier, paragraph spacing | margin, maximum line width in characters | two active themes, one light one dark, or System | [65][66] |
| Readwise Reader | Light, Dark, Auto | fixed | serif and sans list incl. Atkinson Hyperlegible, OpenDyslexic | 14 to 80px, default 20 | line spacing, default 1.4 | line width (web), default medium | mode axis | [59] |
| Kindle apps | background colours; dark interface | fixed | font list incl. a dyslexia face | text size | y (3 levels on devices) | margins, alignment | dark interface | [89][90] |
| Apple Books | Original, Quiet, Paper (Mac); plus Bold, Calm, Focus (iOS, y) | fixed bundles with per-theme Customize and Reset | fixed list | A buttons | line, character, word spacing sliders | margins (iOS, y) | Light / Dark / Automatic independent of theme | [82][83] |
| Kobo | Tone (page colour incl. Night) | fixed | font list; web adds weight | slider | Line Spacing | Margins, Alignment | Night is white on black | [86][87] |
| Instapaper | Light, Sepia, Gray, Dark plus True Black | fixed | Lyon default; Literata, New York, Open Sans, Atkinson Hyperlegible and others | web 6 sizes 14 to 24px | line spacing | line width | 2 light plus 2 dark | [80][98] |
| Matter | 8: Sepia, Dawn, Paper, White; True Black, Winter, Forest, Dark | fixed (Premium) | six fonts | eight sizes | three options | n/d | 4 light plus 4 dark | [79][92] |
| Safari Reader | white, sepia, gray, black | fixed | font list | zoom level | none | none | black is one background | [81] |
| Firefox Reader View | Light, Dark, Sepia, Auto, Gray, Contrast, Custom | fixed plus custom colours (text, background, links) | Serif, Sans-serif, Monospace generics | size | line, character, word spacing, weight | content width, alignment | dark plus contrast plus custom | [84][85][237] |
| Edge Immersive Reader | page themes incl. Irlen-inspired | fixed | n/d | slider | single Text spacing toggle | Text column style | themes | [91] |
| Medium | app night mode (y); web none | n/d | n/d | n/d | n/d | n/d | n/d | [94] |
| Substack app | Auto / dark / light (snippet only) | n/d | n/d | n/d | n/d | n/d | n/d | [95] |
| Pocket | shut down 2025-07-08 | | | | | | | [96] |
| GitHub (non-prose) | 9 public: light, light high contrast, light colorblind (protanopia and deuteranopia), light tritanopia, dark, dark dimmed, dark high contrast, dark colorblind, dark tritanopia. Primer builds 14 (five more high-contrast combinations), and since 2025 a separate Increase contrast switch stacks high contrast on the chosen theme | one identity times accessibility and low-light variants on functional tokens; dark dimmed is a comfort variant, not an accessibility one | n/a | n/a | n/a | n/a | single theme, or day plus night synced to system | [100][101][102][235][236] |
| Slack (non-prose) | preset themes plus Custom (swatch per element, visible only to you); vision assistive themes | presets plus custom | accessibility font change, zoom | | | | Color mode separate and device-specific | [104][105] |
| glosa today | light, dark | none | Default / Sans / Mono per document | none (browser and shell zoom only) | none | none | axis via data-theme | audit |

The GitHub row takes the names of its nine public themes from the Primer README. The GitHub Docs theme page does not list them. The 2024 changelog covers only the two high-contrast themes, with their 7:1 target [100][101][102].

#### 1b. Reading products by control (reader-controls lane)

Y = documented on an opened page. y = practitioner or community source only. n = not offered on the opened page. ? = not verifiable.

| Product | Font family | Text size | Weight | Line spacing | Letter / word spacing | Measure / margins | Alignment | Colour themes | Custom colours | Presets / saved |
|---|---|---|---|---|---|---|---|---|---|---|
| Kindle apps [89] | Y incl. one dyslexia face | Y | y | y | y | Y margins | Y | Y | n | y Compact / Standard / Large / Low Vision plus saved (devices) [93] |
| Apple Books [82][83] | Y fixed list | Y | Y Bold Text | Y slider | Y character (plus word on iOS) | y margins (iOS) | Y Justify toggle | Y themes plus Light / Dark / Automatic | n | Y per-theme Customize and Reset |
| Safari Reader [81] | Y | Y zoom | n | n | n | n | n | Y background theme | n | remembers last choice |
| Firefox Reader View [84][85] | Y generics | Y | Y Light / Regular / Bold | Y | Y character, word | Y content width | Y four alignments | Y six | Y text, background, links | Reset defaults; global prefs [237] |
| Readwise Reader [59] | Y incl. Atkinson Hyperlegible, OpenDyslexic | Y 14 to 80px, default 20 | n | Y default 1.4 | n | Y narrow / medium / wide | n | Y Light / Dark / Auto | n | per-device memory |
| Instapaper [80] | Y | Y slider | n | Y | n | y | y | Y plus True Black | n | n |
| Kobo [86][87][211] | Y; web adds weight | Y | Y (web) | Y | n | Y margins | Y | Y light / sepia / dark | n | publisher default toggle |
| Google Play Books [88][213] | Y | Y | n | Y | n | n | Y Default / Left / Justify | Y Light / Sepia / Dark | n | n |
| Matter [92] | Y six | Y eight | n | Y three | n | n | n | Y light / dark | n | n |
| Edge Immersive Reader [91] | ? | Y | n | Y single toggle | folded in | Y column style | n | Y | n | n |
| Medium, Substack [94][95] | n | n | n | n | n | n | n | y night mode | n | n |
| glosa today | Y per document | n | n | n | n | n | n | Y system / light / dark | n | n |

#### 1c. The code-editor themes (code-editor lane)

Hues are OKLCH degrees, computed from each theme's published hex values. glosa's hand is 41 / 45 and its session is 255 / 250. The "Fit" column predates verification. Read "collides" as "shares a hue that already carries a meaning in that theme". Do not read it as "a mark will look like bold text or a link", because glosa colours neither (C1) [140][217].

| Theme | Licence (canonical) | Palette spec others port? | Prose ports verified | Primary bg / fg (contrast) | Accent hues (deg) | Fit with hand vs session |
|---|---|---|---|---|---|---|
| One Dark Pro on Atom One Dark [129][130] | MIT; Atom one-dark-syntax MIT, archived 2018 | No: VS Code JSON and SCSS only | Obsidian, Typora | #282c34 / #abb2bf (6.6:1) | red 17, orange 64, yellow 82, green 133, cyan 206, blue 245, purple 318 | Needs remap: blue 5 deg from session; orange (bold in this theme's prose mapping) 19 deg from hand; purple has no prose role |
| Monokai (2006) / Monokai Pro [124][126][128] | 2006 tmTheme: no licence text; VS Code ships it as MIT [222]; Monokai Pro proprietary, 14.50 EUR, no redistribution | No | Obsidian (3), Typora | #272822 / #f8f8f2 (13.9:1) | pink 7, orange 62, yellow 103, green 127, blue 212, purple 298 | Orange 17 deg from hand; pink fails as text (3.9:1); Pro values cannot be copied, classic values can |
| Dracula [106][131] | MIT with a spec; Dracula PRO is a separate paid product | Yes: 12 named colours | Obsidian (8), Typora, Logseq, Bear Pro | #282a36 / #f8f8f2 (13.4:1) | red 24, orange 67, yellow 113, green 148, cyan 213, purple 302, pink 347 | Spec paints bold Orange (21 to 26 deg from hand), headings Purple, links Pink and Cyan |
| Solarized [117][118] | MIT | Yes: 16 values with L*a*b* | Obsidian, Typora, Bear Pro | dark #002b36 / #839496 (4.7:1); light #fdf6e3 / #657b83 (4.1:1, fails AA) | yellow 86, orange 40, red 27, magenta 356, violet 279, blue 245, cyan 187, green 119 | Near both: orange 1 to 5 deg from hand, blue 5 to 10 deg from session; red and orange 13 deg apart leave little room for danger beside hand |
| Gruvbox [123] | MIT/X11 | No: Vim colours file | Obsidian (2), Typora, Logseq, Bear Pro | dark #282828 / #ebdbb2 (10.7:1); light #fbf1c7 / #3c3836 (10.2:1) | dark: red 30, orange 52, yellow 83, green 111, aqua 138, blue 170; light: orange 39, blue 216 | Remap orange only (2 to 7 deg from hand); session free in dark (80 deg), 39 in light; red and orange about 17 deg apart |
| Nord [119] | MIT | Yes: nord0 to nord15 with roles | Obsidian (2), Typora, Logseq, Bear Pro; no official writing-tool port among 39 | #2e3440 / #d8dee9 (9.2:1) | frost 194, 217, 249, 254; red 15, orange 38, yellow 84, green 131, purple 333 | Near both: nord12 7 deg from hand (documented as "advanced or dangerous functionality"), nord9 1 deg from session; glosa pencil 3.7:1 on Nord fails AA |
| Catppuccin [120][121][132] | MIT with style guide and port rules | Yes: 26 colours times 4 flavours with roles | Obsidian (official), Logseq (official), Bear Pro | Mocha #1e1e2e / #cdd6f4 (11.3:1); Latte #eff1f5 / #4c4f69 (7.1:1) | peach 42/53, blue 260/262, plus 10 more | Near both (peach 1 to 8 deg, blue 7 to 10 deg) but has enough accents to reserve two |
| Rosé Pine [122] | MIT | Yes: 12 roles plus 3 highlights | Obsidian (4), Bear Pro | main #191724 / #e0def4 (13.4:1); Dawn #faf4ed / #464261 (8.7:1) | love 4, rose 21, gold 75, foam 210, pine 228, iris 305 | Fits on hue (18 to 27 deg away) but Dawn accents fail as text (gold 2.1:1, rose 2.6:1) |
| Tokyo Night [110] | MIT (enkia); Apache-2.0 (folke) | Partly: README hex table per scope | Obsidian (3) | Night #1a1b26 / #a9b1d6 (8.1:1); Light #e6e7ed / #343b58 (8.9:1) | red 10, orange 51, yellow 75, green 130, teal 182, cyan 236, blue 264, magenta 299 | Near both: orange 6 to 8 deg from hand, cyan and blue 5 to 14 deg from session |
| GitHub (Primer) [101][125] | MIT palette [221]; name and logos trademarked | Yes: Primer primitives | Obsidian (3), Typora (3) | light #ffffff / #1f2328 (15.8:1); dark #0d1117 / #f0f6fc (17.4:1) | accent 257/256, danger 25/27, success 148/146 | Near session: accent 2 to 6 deg (a session mark shares GitHub's link blue); name needs a neutral label |

### Appendix 2: detail from the added lanes (not adversarially verified)

These two lanes ran against a working copy that carried the print rework before it merged as #398. Their print values match #398 as merged, and their line numbers are alpha.36 numbers.

#### 2a. Which surfaces a theme, dark mode, a size control, the face chooser and the hand colour reach today

| Surface | Colour tokens | Dark mode | Size | Face | Hand colour | Print | Mechanism needed | Crosses class-F bridge? |
|---|---|---|---|---|---|---|---|---|
| Rendered manuscript `.glosa-content` (Markdown) | Yes | Yes | Body only via `--manuscript-size`; h1 to h6 and code blocks fixed rem; rail ladder fixed px (707, 1205) | Yes, `--font-manuscript` per pane | Yes: `::selection`, `::highlight` washes, margin text | Own sheet since #398: 12pt / 1.45, face kept, white palette, marks and addresses hidden | Derive headings, code and rail from one reading scale | No |
| Rich editor (ProseMirror on `.glosa-content`) | Yes | Yes | Same as manuscript | Yes | Caret, selection | Not printed (rendered snapshot is) | Inherits the manuscript fix | No |
| Source editor textarea | Yes | Yes | No: 13px `--text-sm` | Mono only, by design | Caret | Not printed | Decide whether reading size applies | No |
| Margin notes, composer, session Note | Yes | Yes, plus component overrides | No: 15px serif, quotes 13px | Quotes follow face; note body fixed serif | Yes, `--hand` text | Hidden | Tie to the reading scale if wanted | No |
| Chrome: navigator, tabs, menus, settings, dialogs, palette, tray | Yes | Yes | No: fixed rem 11 to 22 | Sans, fixed | Focus ring, caret | Hidden | Page zoom is enough | No |
| Chat pane | Yes | Yes | No: agent 15px serif, human 15px sans, detail 12px mono | Fixed `--font-serif`, not `--font-manuscript` | Caret only; human turn is a surface bubble | Hidden | Map agent text to reading scale and face | No |
| Diff pane and History diff (diff2html) | Dark only; light keeps d2h's #fff palette | Yes, variable remap | No: 13px table, 15px file name, px | No: Menlo/Consolas; "Source Sans Pro" falls back to Helvetica | N/A: ins `--ok`, del `--danger` (dark only) | Hidden | Unscope the remap; override `.d2h-diff-table` fonts | No |
| Class-F foreign HTML (sandboxed cross-origin iframe) | No | Partial, browser-governed: owner `color-scheme` in Chromium 129+; undeclared documents become a white slab in dark; Safari follows OS | No; page zoom only (owner `zoom` works in Chromium) | No; glosa faces unreachable; bundled fonts CORS-blocked (probe) | No: system highlight inside frame; saved marks never drawn; yellow rule is dead CSS | No print path | Owner `color-scheme` plus frame ground; owner `zoom`; serve-time `@layer` injection; `Access-Control-Allow-Origin` on fonts | Only for live theme switching and drawing saved marks |
| Agent-login terminal (xterm) | No: xterm default white on black in a `#161616` box | Always dark, ignores light | No: fontSize 13 | No: xterm default `monospace` | No: white cursor | N/A | ITheme from tokens, `minimumContrastRatio: 4.5`, fontFamily, re-set on change | No |
| Print output (Markdown only) | White palette; 7 tokens reset | Forced light | 12pt / 1.45, fixed | Follows the page face (#398) | Stripped by design | Itself | Reset or override every preset token; keep the face | No |
| Electron window and blocking page | No: default #FFF window, inline light page | No | N/A | System | N/A | N/A | `backgroundColor` from theme; theme the page; optional `nativeTheme.themeSource` | No |

#### 2b. Class-F iframe colour behaviour by case (Chromium probe against Safari compat data)

| glosa setting (iframe owner scheme) | Document declares | Chromium (probe in Chrome 154; Electron 44 ships 152) | Safari 16.4 to 18 (MDN compat data) | What the reader sees |
|---|---|---|---|---|
| Light (inherited) | Nothing | `prefers-color-scheme` light; schemes match, transparent canvas | Follows OS | Document on glosa's warm paper, UA black text |
| Dark (inherited) | Nothing | `prefers-color-scheme` dark; schemes differ, opaque white canvas (spec §2.4) | Media query follows OS; canvas behaviour unverified | A white page slab on the dark desk, legible |
| Dark (inherited) | `color-scheme: light dark` or `prefers-color-scheme` rules | Dark rendering; transparent canvas over glosa's dark ground | Follows OS, so light on a light OS | Document follows glosa's dark |
| Owner forced light, ground behind frame dark | Nothing | Transparent canvas; black text over the dark ground | N/A | Unreadable: never force owner light without a light frame ground |

In the probe the OS was dark while the parent page's own root was light, and the parent still reported dark. So the behaviour comes from the frame owner's scheme, not from the OS [264]. WebKit bug 316680 (filed 2026-06-09, still NEW) says Safari iframes do not respect the parent's color-scheme for Canvas colours, light-dark() or scrollbars [245]. WebKit bug 309611 fixed nested propagation on trunk on 2026-04-28 [246].

#### 2c. How hosts pass theme and type into foreign HTML

| Product | Isolation | Theme channel | Font or size channel | Live update | Source opened |
|---|---|---|---|---|---|
| VS Code webviews | iframe; messages via `acquireVsCodeApi` | Body class `vscode-light`, `vscode-dark`, `vscode-high-contrast`; `data-vscode-theme-id`; `--vscode-*` colour variables | `--vscode-editor-font-family`, `-font-weight`, `-font-size` | Not stated on the page opened | code.visualstudio.com webview guide [252] |
| Figma plugins | iframe | `themeColors: true`: `figma-light` or `figma-dark` on `<html>`, `<style id="figma-style">` with `--figma-color-*` | None documented | Yes | developers.figma.com css-variables [253] |
| Obsidian | iframe embed; Web viewer | None documented | None; Reader mode re-renders the page with Readability | N/A | obsidian.md help [254][255] |
| JupyterLab HTML viewer | Sandboxed iframe; scripts only when trusted | None documented | None documented | N/A | JupyterLab API HTMLViewer [256] |
| GitHub notebooks | Static HTML; interactive JavaScript does not work | Not documented | Not documented | N/A | docs.github.com non-code files [257] |
| glosa class F today | Sandboxed cross-origin iframe; MessageChannel sends frame to parent only | Implicit: owner `color-scheme` only | Page zoom | N/A | Repo code [266][267] |

#### 2d. xterm options for the agent-login terminal (ITheme is xterm's colour-theme object)

| Option | glosa today | Vendored default | Suggested | Evidence |
|---|---|---|---|---|
| `theme` | Not set | #ffffff on #000000 | background `--bg`, foreground `--ink`, cursor `--hand`, selectionBackground `--hand-wash`, 16 ANSI from palette | xterm ITheme [258] |
| `minimumContrastRatio` | Not set | 1 (do nothing) | 4.5 (WCAG AA) | xterm.d.ts; VS Code terminal default 4.5 [260][261] |
| `fontFamily` | Not set | "monospace" | `--font-mono` stack | ITerminalOptions [259] |
| `fontSize` | 13 | 15 | From the chosen size scale | ITerminalOptions [259] |
| Container background | `#161616` raw | N/A | A token, matching the theme background | `packages/spa/src/app.css:7279` [273] |
| Updating | Never | N/A | Assign a new theme object on appearance change | xterm.d.ts on object options [260] |

#### 2e. User-voice ledger: appearance complaints by product (identity against comfort)

| Product | Complaint | Kind | Frequency proxy | Vendor acted? | Says they left? |
|---|---|---|---|---|---|
| iA Writer (Mac, iOS, Android) | Fixed faces, font cannot be changed, "detest the fonts" | Identity | 4 of 50 most-helpful Mac reviews (top 17/19 helpful); 3 HN comments 2022 to 2023 (1 to 4 replies); 0 in Mac reviews Oct 2025 to Aug 2026 | No. Still Mono, Duo, Quattro at v8.0.9 (Sep 2026); 12 text sizes since Mac 5.2 | Yes: 1-star Mac 2020; HN 2022 "so I don't use the software"; HN 2023 (Android). 4-star 2023: "would be my daily driver" if font choice existed |
| iA Writer | Nitti replaced by Plex-based fonts (Dec 2018) | Identity, triggered by a change | 2 reviews (2-star 1/3 helpful; 5-star) | No, Nitti not restored | Conditionally: "I will return to Writer when the original font is brought back" |
| iA Writer iOS | Ignores system text size | Comfort | 1 review (2-star, 2025) | Not found | No |
| Bear (notes) | System font for UI, darker faces, bigger sidebar and editor text | Mostly comfort, some native-feel identity | Community threads: 14 likes / 537 views; 9 likes; others 0 to 3 likes | Partly. Bear 2 (2023) added any installed font, size, line height, width, spacing; about 30 Pro themes | One poster "lean[s] towards other apps". 0 of 15 unhappy or leaving most-helpful App Store reviews cite looks |
| Bear | Highlighter redesign changed the default mark colour | Identity and comfort of marks | 58 posts, 94 likes, 3,586 views (2024) | Yes. Old colour restored as default; 3 colour-blind palettes; text colour tuned per theme | Not stated |
| Bear Lettera (2026) | Requests for themes | Identity | 20 posts, 43 likes, users split | Declined for now; shipped font, size, line height, paragraph spacing | No |
| Ulysses | An update enlarged headings; presets "still too big" | Comfort, triggered by a change | 7/7 helpful | Small, Medium, Large presets (per reviewer) | Yes: "won't be renewing my subscription" |
| Ulysses | Several fonts per element, Word style | Layout control | 6/6 helpful | No | Yes: "I cannot use this app at all as it is" |
| Notion | iPad text too small, no Cmd +/- | Comfort | 1-star 2023 ("one of the most voted requests on Reddit"); 3-star 2026 repeats it | Only a Small text toggle, 3 faces (help page) | Stopped paying (1 of 5 reasons) |
| Notion | Checkbox blue changed, "more harsh" | Identity, triggered by a change | 5-star, 38/59 helpful | Not found | No |
| Craft | Larger text on the Mac app | Comfort | 5-star, 72/73 helpful | Not found | No |
| Readwise Reader | None found | None | 0 appearance reasons in 25 low-star reviews | Ships light, dark, auto; several faces incl. Atkinson Hyperlegible and OpenDyslexic; size 14 to 80 px; spacing; width | Not applicable |
| Kindle app | Highlight colour darkened; Aa and two-page options removed on Mac and iPad | Comfort, triggered by a change | 4-star and 1-star reviews | Not found | 1-star: "practically unusable for me now" |
| Kindle (HN 2010 to 2020) | Justification, word spacing, hyphenation | Typesetting quality | 6 comments | Not applicable | Not stated |
| Obsidian | Readable line length locked near 700 px | Comfort (measure) | 100 likes, 41 posts, 34,177 views | No staff action recorded | Not stated |
| Obsidian | Dark-mode text too bright | Comfort | 15 posts, 2,632 views | No, archived with a CSS workaround | Not stated |
| Typora | Theme and font requests | Mostly export and presentation | Top theme issue 74 reactions vs vim 299, plugins 286 | Ships CSS themes | Not stated |

Sources: [60][275] to [305].

#### 2f. App Store review sample: why people rate low or leave (US storefront, iTunes RSS, 50 reviews per feed)

| Feed | Window | Low-star or leaving reviews with a reason (approx.) | Identity | Comfort | Other (function, bugs, pricing, AI, sync) |
|---|---|---|---|---|---|
| iA Writer iOS, most helpful | 2017 to 2025 | 17 | 1 (font replaced) | 1 (ignores system text size) | 15 |
| iA Writer iOS, most recent | Nov 2025 to Sep 2026 | 16 | 0 clear (1 titled "Ugly" with no specifics) | 2 (print template type too small; system text size, same review as above) | 13 |
| iA Writer Mac, most helpful | 2017 to 2025 | 6, plus 4 font critiques at any rating | 1 left ("will not allow you to change the font") | 1 ("harsh or jagged on the eyes", 4-star) | rest |
| iA Writer Mac, most recent | Oct 2025 to Aug 2026 | 2 | 0 | 0 | 2 |
| Bear, most helpful | 2017 to 2026 | 15 | 0 | 0 | 15 |
| Bear, most recent | about Oct 2025 to Sep 2026 | 8 | 0 | 0 (1 about visible Markdown syntax) | 7 |
| Ulysses, most helpful | 2018 to 2026 | about 9 | 0 | 1 left (update enlarged headings) | about 7, plus 1 left over per-element fonts (layout control) |
| Readwise Reader, most helpful | 2023 to 2026 | 9 | 0 | 0 | 9 |
| Readwise Reader, most recent | Jan 2025 to Aug 2026 | 16 | 0 | 0 | 16 |
| Craft, most helpful | 2021 to 2024 | about 5 | 0 | 0 (1 comfort request in a 5-star, 72/73 helpful) | about 5 |
| Craft, most recent | Dec 2025 to Sep 2026 | 8 | 0 | 0 | 8 |
| Notion, most helpful | 2020 to 2026 | about 13 | 0 (1 identity complaint in a 5-star, stayed) | 1 (iPad text too small, 1 of 5 reasons) | about 12 |
| Notion, most recent | Aug to Sep 2026 | 18 (1 to 2 stars) | 0 | 0 (1 comfort complaint in a 3-star) | 18 |
| Kindle, most helpful | 2018 to 2026 | 2 | 0 | 2 (Aa options removed; highlight colour darker, 4-star) | 0 |
| Total (approx.) | | about 140 | 2 to 3 | about 5 | about 130 |

A fetch summariser made the first-pass classification. The lane re-checked every appearance-related item by hand and corrected several AI and navigation complaints that had been mislabelled as appearance. The same review can appear in both the "most helpful" and "most recent" feeds [275] to [282].

#### 2g. Backlash after appearance changes (the strongest "left over the look" signal)

| Year | Product | What changed | User reaction | Vendor response |
|---|---|---|---|---|
| 2018 | iA Writer | Nitti replaced by Mono, Duo, Quattro | "It's not an option, just gone"; "yet another free markdown app" | Kept the new fonts |
| 2022 | Notion | Checkbox blue made harsher | "y'all should change it back, please!" (stayed) | Not found |
| 2024 | Ulysses | Heading sizes enlarged by an update | "won't be renewing my subscription" | Presets exist but did not go small enough for this user |
| 2024 | Bear | Highlighter redesign changed the default mark colour | 58-post feedback thread | Reinstated the old colour as default; added colour-blind palettes |
| 2025 | Kindle | Highlight colour darkened | "harder to read what I've highlighted" | Not found |
| 2026 | Kindle (Mac, iPad) | Aa text options and two-page view removed | "practically unusable for me now" | Not found |

Sources: [277][279][280][281][282][283][290].

### Sources

Only sources that a lane or a verifier marked as opened (accessed: true) are listed. Local measurement files are included because numbers in the report rest on them. Sources 215 to 240 were added in verification. Sources 241 to 305 were added after the completeness pass and were not adversarially verified.

Reading typography and standards

1. Legge and Bigelow 2011, Does print size matter for reading? https://pmc.ncbi.nlm.nih.gov/articles/PMC3428264/
2. Rello, Pielot and Marcos 2016, Make It Big! (CHI 2016, author PDF) http://pielot.org/pubs/Rello2016-Fontsize.pdf
3. Butterick, Practical Typography: Point size https://practicaltypography.com/point-size.html
4. Readability Research: An Interdisciplinary Approach (arXiv 2107.09615) https://arxiv.org/pdf/2107.09615
5. Wallace et al. 2022, Towards Individuated Reading Experiences (TOCHI, author PDF) https://jeffhuang.com/papers/Readability_TOCHI22.pdf
6. Bringhurst 2.1.2 as quoted at webtypography.net https://webtypography.net/2.1.2
7. Butterick, Practical Typography: Line length https://practicaltypography.com/line-length.html
8. Baymard, Readability: The Optimal Line Length https://baymard.com/blog/line-length-readability
9. WCAG 2.2 Understanding SC 1.4.8 Visual Presentation https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html
10. Dyson 2004, How physical text layout affects reading from screen https://stu.westga.edu/~ssynan1/literacy/Dyson.pdf
11. Butterick, Practical Typography: Line spacing https://practicaltypography.com/line-spacing.html
12. iA, Responsive Typography: The Basics https://ia.net/topics/responsive-typography-the-basics
13. WCAG 2.2 Understanding SC 1.4.12 Text Spacing https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
14. Flutter TextTheme (Material 3 type scale values) https://api.flutter.dev/flutter/material/TextTheme-class.html
15. Apple Human Interface Guidelines, Typography https://developer.apple.com/design/human-interface-guidelines/typography
16. Butterick, Practical Typography: Headings https://practicaltypography.com/headings.html
17. Tim Brown, More Meaningful Typography (A List Apart) https://alistapart.com/article/more-meaningful-typography/
18. Butterick, Practical Typography: Letterspacing https://practicaltypography.com/letterspacing.html
19. WCAG 2.2 Understanding SC 1.4.3 Contrast (Minimum) https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
20. WCAG 2.2 Understanding SC 1.4.6 Contrast (Enhanced) https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html
21. WCAG 2.2 Understanding SC 1.4.4 Resize Text https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html
22. Butterick, Practical Typography: Space between paragraphs https://practicaltypography.com/space-between-paragraphs.html
23. NN/g, Let Users Control Font Size https://www.nngroup.com/articles/let-users-control-font-size/
24. WCAG 2.2 Understanding SC 1.4.1 Use of Color https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
25. WCAG 2.2 Understanding SC 1.4.11 Non-text Contrast https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
26. Nanavati and Bias 2005, Optimal Line Length in Reading: A Literature Review https://journals.uc.edu/index.php/vl/article/view/5765
27. BBC GEL Technical Guide: Typography https://bbc.github.io/gel/foundations/typography/
28. GOV.UK Design System: Type scale https://design-system.service.gov.uk/styles/type-scale/
29. W3C, Accessibility Requirements for People with Low Vision https://www.w3.org/TR/low-vision-needs/
30. Rello and Baeza-Yates 2017, How to present more readable text for people with dyslexia (UAIS, PDF) https://superarladislexia.org/pdf/2017-Luz%20Rello-UAIS_How%20to%20present%20text.pdf
31. Zorzi et al. 2012, Extra-large letter spacing improves reading in dyslexia (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:10.1073/pnas.1205566109&resultType=core&format=json

Font pairing and dark mode

32. Source Serif 4 description (google/fonts, Adobe text) https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/DESCRIPTION.en_us.html
33. Griesshammer, Source Serif gets optical sizes (Adobe blog) https://blog.adobe.com/en/publish/2021/03/04/source-serif-gets-optical-sizes
34. Butterick, Practical Typography: Mixing fonts https://practicaltypography.com/mixing-fonts.html
35. Google Fonts Knowledge, Pairing typefaces by the same type designer or type foundry https://fonts.google.com/knowledge/choosing_type/pairing_typefaces_by_the_same_type_designer_or_type_foundry
36. Source Code Pro (Wikipedia) https://en.wikipedia.org/wiki/Source_Code_Pro
37. Local font measurements (fontTools, this study). The inventory a local measurement script (not committed) holds axes, glyph coverage, woff2 sizes and licences only, with no x-height or line-length data; the default-instance x-heights come from a local measurement script (not committed) and the characters-per-line capacities from a local measurement script (not committed)
38. TypeDrawers, White on black https://typedrawers.com/discussion/4138/white-on-black
39. Dalton Maag, Darkmode https://www.daltonmaag.com/font-library/darkmode.html
40. CSS-Tricks, Using CSS Custom Properties to Adjust Variable Font Weights in Dark Mode https://css-tricks.com/using-css-custom-properties-to-adjust-variable-font-weights-in-dark-mode/
41. Apple Human Interface Guidelines, Dark Mode https://developer.apple.com/design/human-interface-guidelines/dark-mode
42. Material Design 2, Dark theme https://m2.material.io/design/color/dark-theme.html
43. Piepenbrock, Mayr, Mund and Buchner 2013, Positive display polarity is advantageous for both younger and older adults (author PDF) https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/2013/Piepenbrock-2013-Positive_display_polarity_is_.pdf
44. Piepenbrock, Mayr and Buchner 2014, Positive display polarity is particularly advantageous for small character sizes (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:10.1177/0018720813515509&resultType=core&format=json
45. Piepenbrock, Mayr and Buchner 2014, Smaller pupil size and better proofreading performance with positive than with negative polarity displays (author PDF) https://www.psychologie.hhu.de/fileadmin/redaktion/Oeffentliche_Medien/Fakultaeten/Mathematisch-Naturwissenschaftliche_Fakultaet/Psychologie/AAP/Publikationen/in_press/Piepenbrock-in_press-Smaller_pupil_size_and_better.pdf
46. Buchner and Baumgartner 2007, Text-background polarity affects performance irrespective of ambient illumination and colour contrast (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:17510822&resultType=core&format=json
47. Dobres, Chahine and Reimer 2017, Effects of ambient illumination, contrast polarity, and letter size on text legibility (author PDF) https://jdobr.es/pdf/Dobres-etal-2017-Ambient.pdf
48. NN/g, Dark Mode vs. Light Mode: Which Is Better? https://www.nngroup.com/articles/dark-mode/
49. Literata 3.0 (TypeTogether) https://www.typetogether.com/literata-3
50. Alegreya description (google/fonts) https://raw.githubusercontent.com/google/fonts/main/ofl/alegreya/DESCRIPTION.en_us.html
51. IBM/plex https://github.com/IBM/plex
52. Atkinson Hyperlegible fonts (Braille Institute) https://www.brailleinstitute.org/freefont/
53. adobe-fonts/source-serif https://github.com/adobe-fonts/source-serif
54. Merriweather description (google/fonts) https://raw.githubusercontent.com/google/fonts/main/ofl/merriweather/DESCRIPTION.en_us.html
55. productiontype/Newsreader https://github.com/productiontype/Newsreader

Writing tools and reading apps

56. iA Writer support: Settings https://ia.net/writer/support/basics/settings
57. iA, Bringing Responsiveness to Apps (2012) https://ia.net/topics/bringing-responsiveness-the-app-world
58. iA, From Monospace to Duospace (2017) https://ia.net/topics/in-search-of-the-perfect-writing-font
59. Readwise Reader docs: Appearance https://docs.readwise.io/reader/docs/faqs/appearance
60. Bear FAQ: Editor Typography Options https://bear.app/faq/typography-options/
61. Bear FAQ: Bear's free and Pro themes https://bear.app/faq/about-free-and-pro-themes-in-bear/
62. Ulysses help: Customize the Editor https://help.ulysses.app/dive-into-editing/editor-customization-guide
63. Ulysses help: Editor Themes https://help.ulysses.app/customize-ulysses/editor-themes
64. Ulysses Styles and Themes: Editor Themes gallery https://styles.ulysses.app/themes
65. Drafts User Guide: Editor Settings https://docs.getdrafts.com/docs/editor/editorsettings
66. Drafts User Guide: Themes https://docs.getdrafts.com/docs/extending/themes
67. Obsidian Help: Settings https://obsidian.md/help/settings
68. Obsidian Help: Appearance https://obsidian.md/help/appearance
69. Obsidian community-css-themes.json (obsidianmd/obsidian-releases) https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json
70. Typora support: About Themes https://support.typora.io/About-Themes/
71. Typora Themes Gallery https://theme.typora.io/
72. Zettlr docs: Appearance https://docs.zettlr.com/en/editor/appearance.html
73. MarkText docs: Themes https://marktext.me/docs/themes
74. Craft help: Backdrops, Colors and Separators https://craft-support.mintlify.app/en/write-and-edit/styling/quick-guide.md
75. Notion Help: Customize and style your content https://www.notion.com/help/customize-and-style-your-content
76. Notion Help: Account settings and preferences https://www.notion.com/help/account-settings
77. Google Docs Editors Help: Use Dark theme (Android) https://support.google.com/docs/answer/9955476?hl=en&co=GENIE.Platform%3DAndroid
78. Literature and Latte: Customize the way Scrivener looks with themes https://www.literatureandlatte.com/blog/customize-the-way-scrivener-looks-with-themes
79. Matter updates: New Premium features, True black, fonts, icons and more https://www.getmatter.com/updates/new-premium-features-true-black-fonts-icons-more
80. Instapaper on the App Store https://apps.apple.com/us/app/instapaper/id288545208
81. Apple Support: Hide distractions when reading articles in Safari on Mac https://support.apple.com/guide/safari/sfri32632/mac
82. Apple Support: Change a book's appearance in Books on Mac https://support.apple.com/guide/books/change-a-books-appearance-ibks8923126d/mac
83. iDownloadBlog: How to use themes in Apple Books https://www.idownloadblog.com/2022/09/21/how-to-use-themes-in-books-app-on-ipad-iphone/
84. Firefox 129.0 release notes https://www.firefox.com/en-US/firefox/129.0/releasenotes/
85. Firefox Reader View UI strings (aboutReader.ftl) https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/locales/en-US/toolkit/about/aboutReader.ftl
86. Kobo Web Reader Navigation and Reading Features https://help.kobo.com/hc/en-us/articles/35996239522967-Kobo-Web-Reader-Navigation-Reading-Features
87. Kobo Books app: Adjust page margins, line spacing, and more https://help.kobo.com/hc/en-us/articles/360017865293-Adjust-page-margins-line-spacing-and-more-on-the-Kobo-Books-app-iOS-Android
88. Google Play Books: Change an ebook's font size, color, and more (Android) https://support.google.com/googleplay/answer/9755756?hl=en&co=GENIE.Platform%3DAndroid
89. Amazon Kindle on the App Store https://apps.apple.com/us/app/amazon-kindle/id302584613
90. Amazon: Customize Kindle for Web https://www.amazon.com/gp/help/customer/display.html?nodeId=TT200NNkr2BE4Jnsy9
91. Microsoft: Use Immersive Reader in Microsoft Edge https://support.microsoft.com/en-us/topic/use-immersive-reader-in-microsoft-edge-78a7a17d-52e1-47ee-b0ac-eff8539015e1
92. MacStories: Matter, a fresh take on read-later apps https://www.macstories.net/reviews/matter-a-fresh-take-on-read-later-apps/
93. How-To Geek: How to Customize Text on Your Kindle https://www.howtogeek.com/734656/how-to-customize-text-on-your-kindle/
94. Medium on the App Store https://apps.apple.com/us/app/medium-read-write-stories/id828256236
95. Substack on the App Store https://apps.apple.com/us/app/substack/id1581650857
96. Pocket farewell page https://getpocket.com/farewell
97. Logseq docs: Custom theme https://raw.githubusercontent.com/logseq/docs/master/pages/Custom%20theme.md
98. Veroniiiica: Instapaper accessibility for visual impairment https://veroniiiica.com/instapaper-accessibility/
99. Apple Newsroom: Apple unveils powerful accessibility features coming later this year (2025) https://www.apple.com/newsroom/2025/05/apple-unveils-powerful-accessibility-features-coming-later-this-year/

GitHub and Slack theme models

100. GitHub Docs: Managing your theme settings https://docs.github.com/en/get-started/accessibility/managing-your-theme-settings
101. primer/primitives https://github.com/primer/primitives
102. GitHub Changelog: High contrast theme improvements https://github.blog/changelog/2024-08-15-high-contrast-theme-improvements/
103. GitHub Changelog: Colorblind themes beta https://github.blog/changelog/2021-09-29-colorblind-themes-beta/
104. Slack help: Change your Slack theme https://slack.com/help/articles/205166337-Change-your-Slack-theme
105. Slack help: Use dark mode in Slack https://slack.com/help/articles/360019434914-Use-dark-mode-in-Slack

Code-editor themes

106. Dracula specification https://spec.draculatheme.com/
107. dracula/obsidian theme.css https://raw.githubusercontent.com/dracula/obsidian/master/theme.css
108. dracula/typora dracula.css https://raw.githubusercontent.com/dracula/typora/master/dracula.css
109. One Dark Pro theme JSON https://raw.githubusercontent.com/Binaryify/OneDark-Pro/master/themes/OneDark-Pro.json
110. Tokyo Night VS Code README https://raw.githubusercontent.com/enkia/tokyo-night-vscode-theme/master/README.md
111. rose-pine/vscode theme JSON https://raw.githubusercontent.com/rose-pine/vscode/main/themes/rose-pine-color-theme.json
112. catppuccin/obsidian theme.css https://raw.githubusercontent.com/catppuccin/obsidian/main/theme.css
113. github-markdown-css https://raw.githubusercontent.com/sindresorhus/github-markdown-css/main/github-markdown.css
114. Base16 styling guide (Tinted Theming) https://github.com/tinted-theming/home/blob/main/styling.md
115. TextMate manual: language grammars https://macromates.com/manual/en/language_grammars
116. Butterick, Practical Typography: Color https://practicaltypography.com/color.html
117. Solarized (ethanschoonover.com) https://ethanschoonover.com/solarized/
118. altercation/solarized https://github.com/altercation/solarized
119. Nord colors and palettes https://www.nordtheme.com/docs/colors-and-palettes
120. Catppuccin palette https://catppuccin.com/palette/
121. Catppuccin style guide https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md
122. Rosé Pine palette.json https://raw.githubusercontent.com/rose-pine/palette/main/palette.json
123. Gruvbox palette (colors/gruvbox.vim) https://raw.githubusercontent.com/morhetz/gruvbox/master/colors/gruvbox.vim
124. Original Monokai.tmTheme (2006) gist https://gist.github.com/ntwb/7316a3b610ede7e4fd51871fb00bf3f3
125. GitHub brand: logo and name usage https://brand.github.com/foundations/logo
126. Monokai Pro License https://monokai.pro/license
127. Monokai Pro for VSCode https://monokai.pro/vscode
128. The history of Monokai https://monokai.pro/history
129. Binaryify/OneDark-Pro https://github.com/Binaryify/OneDark-Pro
130. atom/one-dark-syntax (archived) https://github.com/atom/one-dark-syntax
131. Dracula PRO https://draculatheme.com/pro
132. Catppuccin port-creation rules https://github.com/catppuccin/catppuccin/blob/main/docs/port-creation.md
133. Tinted Theming home https://github.com/tinted-theming/home
134. Dracula for Bear https://draculatheme.com/bear
135. VS Code Marketplace: GitHub Theme https://marketplace.visualstudio.com/items?itemName=GitHub.github-vscode-theme
136. VS Code Marketplace: One Dark Pro https://marketplace.visualstudio.com/items?itemName=zhuangtongfa.Material-theme
137. VS Code Marketplace: Dracula Theme Official https://marketplace.visualstudio.com/items?itemName=dracula-theme.theme-dracula
138. VS Code Marketplace: Monokai Pro https://marketplace.visualstudio.com/items?itemName=monokai.theme-monokai-pro-vscode
139. Catppuccin issue 2588: Align palette colours to WCAG Level AA https://github.com/catppuccin/catppuccin/issues/2588
140. glosa app.css tokens (local file, read 2026-09-27; `--primary: var(--ink)` at line 84, `--danger` hue 22 at line 92, bold without colour at line 2712, links in `--primary` at line 2834) packages/spa/src/app.css

User preference

141. YouGov daily question: light mode or dark mode on your smartphone https://yougov.com/en-gb/daily-results/20240208-ec79b-3
142. Android Authority: Just about everyone uses dark mode (2020 poll) https://www.androidauthority.com/dark-mode-poll-results-1090716/
143. Android Authority: You're probably reading this on dark mode (2026 poll) https://www.androidauthority.com/dark-mode-survey-results-3682352/
144. Litmus: The ultimate guide to dark mode for email marketers https://www.litmus.com/blog/the-ultimate-guide-to-dark-mode-for-email-marketers
145. Ergonomics 2025, The dark side of the interface https://www.tandfonline.com/doi/full/10.1080/00140139.2025.2483451
146. Legge et al. 1985, Psychophysics of reading II: Low vision (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%22psychophysics%20of%20reading%22%20AND%20%22low%20vision%22%20AND%20AUTH:%22Legge%20GE%22%20AND%20PUB_YEAR:1985&resultType=core&format=json
147. The impact of using reverse polarity text for children with vision impairment (2024, abstract) https://api.semanticscholar.org/graph/v1/paper/DOI:10.1080/08164622.2024.2367631?fields=title,abstract,year,venue
148. THERIF: A Pipeline for Generating Themes for Readability with Iterative Feedback https://arxiv.org/abs/2303.04221
149. Rello and Baeza-Yates 2013, Good Fonts for Dyslexia (ASSETS, author PDF) https://www.changedyslexia.org/publications/pdfs/2013-ASSETS-Good%20Fonts%20for%20Dyslexia.pdf?v1.5.15=
150. Wery and Diliberto 2017, The effect of a specialized dyslexia font, OpenDyslexic (PMC) https://pmc.ncbi.nlm.nih.gov/articles/PMC5629233/
151. Kuster et al. 2017, Dyslexie font does not benefit reading (abstract) https://api.semanticscholar.org/graph/v1/paper/DOI:10.1007/s11881-017-0154-6?fields=title,abstract,year,venue
152. Does font improve reading in dyslexic children? Meta-analysis 2026 (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:42536336&resultType=core&format=json
153. Rello and Bigham 2017, Good Background Colors for Readers (author PDF) https://www.cs.cmu.edu/~jbigham/pubs/pdfs/2017/colors.pdf
154. Apple Human Interface Guidelines: Dark Mode (documentation JSON) https://developer.apple.com/tutorials/data/design/human-interface-guidelines/dark-mode.json
155. web.dev: How Terra improved user engagement thanks to Dark Mode https://web.dev/case-studies/terra-dark-mode
156. Stack Overflow blog: Introducing Dark Mode (beta) https://stackoverflow.blog/2020/03/30/introducing-dark-mode-for-stack-overflow/
157. Jakob Nielsen: Default Dominance https://jakobnielsenphd.substack.com/p/defaults
158. NN/g: The Power of Defaults https://www.nngroup.com/articles/the-power-of-defaults/
159. Iyengar and Lepper 2000, When choice is demotivating (PDF) https://faculty.washington.edu/jdb/345/345%20Articles/Iyengar%20%26%20Lepper%20(2000).pdf
160. Scheibehenne, Greifeneder and Todd 2010, Can there ever be too many options? https://academic.oup.com/jcr/article-abstract/37/3/409/1827647
161. Chernev, Böckenholt and Goodman 2015, Choice overload: a conceptual review and meta-analysis (PDF) https://chernev.com/wp-content/uploads/2017/02/ChoiceOverload_JCP_2015.pdf
162. Laws of UX: Hick's Law https://lawsofux.com/hicks-law/
163. Readability Matters: Towards Individuated Reading Experiences (research highlight) https://readabilitymatters.org/articles/towards-individuated-reading-experiences
164. Light green background enhances reading performance (Frontiers 2025, Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID:PMC12331638&resultType=core&format=json
165. Bear blog: Bear 2 is here https://blog.bear.app/2023/07/bear-2-is-here/
166. Reading and Myopia: Contrast Polarity Matters (PMC) https://pmc.ncbi.nlm.nih.gov/articles/PMC6052140/

Implementation

167. PortSwigger Research, Blind CSS Exfiltration https://portswigger.net/research/blind-css-exfiltration
168. XS-Leaks Wiki, CSS Injection https://xsleaks.dev/docs/attacks/css-injection/
169. MDN, CSP style-src https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/style-src
170. MDN, CSP font-src https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/font-src
171. Obsidian: Theme guidelines https://docs.obsidian.md/Themes/App+themes/Theme+guidelines
172. Zettlr: Customizing Zettlr with CSS https://github.com/Zettlr/zettlr-docs/blob/master/docs/en/guides/custom-css.md
173. VS Code: Color Theme extension guide https://code.visualstudio.com/api/extension-guides/color-theme
174. GitHub blog: Accelerating GitHub theme creation with color tooling https://github.blog/news-insights/product-news/accelerating-github-theme-creation-with-color-tooling/
175. Apple Human Interface Guidelines: Color (documentation JSON) https://developer.apple.com/tutorials/data/design/human-interface-guidelines/color.json
176. Primer: Color considerations https://primer.style/accessibility/design-guidance/color-considerations/
177. Design Tokens Format Module 2025.10 https://www.designtokens.org/tr/2025.10/format/
178. Radix Colors: Understanding the scale https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
179. shadcn/ui: Theming https://ui.shadcn.com/docs/theming
180. web.dev: Building a color scheme https://web.dev/articles/building/a-color-scheme
181. Electron v44.0.0 release https://releases.electronjs.org/release/v44.0.0
182. caniuse: CSS relative colors https://caniuse.com/css-relative-colors
183. caniuse: light-dark() https://caniuse.com/mdn-css_types_color_light-dark
184. caniuse: prefers-contrast https://caniuse.com/mdn-css_at-rules_media_prefers-contrast
185. caniuse: forced-colors https://caniuse.com/mdn-css_at-rules_media_forced-colors
186. caniuse: prefers-reduced-transparency https://caniuse.com/mdn-css_at-rules_media_prefers-reduced-transparency
187. caniuse: font-size-adjust https://caniuse.com/font-size-adjust
188. caniuse: local-fonts permission https://caniuse.com/mdn-api_permissions_permission_local-fonts
189. MDN: Using relative colors https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_colors/Relative_colors
190. MDN: color-mix() https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix
191. MDN: prefers-contrast https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-contrast
192. MDN: forced-colors https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors
193. Microsoft Edge: Styling for Windows high contrast with new standards for forced colors https://blogs.windows.com/msedgedev/2020/09/17/styling-for-windows-high-contrast-with-new-standards-for-forced-colors/
194. MDN: @font-face src descriptor https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/src
195. W3C: Fonts, Privacy, and Not Breaking the Web https://www.w3.org/2024/09/font-i18n-privacy.html
196. Chrome for Developers: Use advanced typography with local fonts https://developer.chrome.com/docs/capabilities/web-apis/local-fonts
197. Electron issue 39140: Add Local Font Access API to the permission handler https://github.com/electron/electron/issues/39140
198. Electron: session API https://www.electronjs.org/docs/latest/api/session
199. Fontsource: @fontsource-variable/source-serif-4 index.css https://cdn.jsdelivr.net/npm/@fontsource-variable/source-serif-4/index.css
200. fontTools: pyftsubset https://fonttools.readthedocs.io/en/latest/subset/index.html
201. fontTools: varLib.instancer https://fonttools.readthedocs.io/en/latest/varLib/instancer.html
202. MDN: font-size-adjust https://developer.mozilla.org/en-US/docs/Web/CSS/font-size-adjust
203. APCA in a Nutshell (Myndex) https://github.com/Myndex/SAPC-APCA/blob/master/documentation/APCA_in_a_Nutshell.md
204. W3C Accessibility Guidelines (WCAG) 3.0 Working Draft https://www.w3.org/TR/wcag-3.0/
205. MDN: color-scheme https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme
206. Electron: nativeTheme https://www.electronjs.org/docs/latest/api/native-theme
207. Base24 styling guide (Tinted Theming) https://github.com/tinted-theming/base24/blob/main/styling.md
208. Typora: Write Custom Theme https://theme.typora.io/doc/Write-Custom-Theme/
209. MDN: Local Font Access API https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API
210. MDN: light-dark() https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark
211. Kobo eReader: Adjust font size and change the font style https://help.kobo.com/hc/en-us/articles/360017639913-Adjust-font-size-and-change-the-font-style-on-your-Kobo-eReader
212. Pocket-lint: How to change the font on Kindle https://www.pocket-lint.com/how-to-change-kindle-font/
213. Google Play Books: Change an ebook's font size, color, and more (Desktop) https://support.google.com/googleplay/answer/9755756?hl=en&co=GENIE.Platform%3DDesktop
214. MDN: font-optical-sizing https://developer.mozilla.org/en-US/docs/Web/CSS/font-optical-sizing

Added in verification

215. Verification: x-heights at the instances glosa renders (fontTools on the vendored woff2 and the Google Fonts TTFs; serif opsz 18 and 20, sans wght 200 to 700) a local measurement script (not committed) and a local measurement script (not committed)
216. Verification: characters per 68ch line, fontTools capacity and a Chromium 154 render with `text-wrap: pretty` a local measurement script (not committed), a local measurement script (not committed) and a local measurement script (not committed)
217. Verification: OKLCH hue distance from every accent of the ten families to glosa's hand and session a local measurement script (not committed) and a local measurement script (not committed)
218. Verification: simulation of full protanopia, deuteranopia and tritanopia on glosa's tokens (Machado 2009 matrices, OKLab distance) a local measurement script (not committed)
219. Joplin source: theme picker labels (builtInMetadata.ts) https://raw.githubusercontent.com/laurent22/joplin/dev/packages/lib/models/settings/builtInMetadata.ts
220. Standard Notes source: built-in theme list (Themes.ts) https://raw.githubusercontent.com/standardnotes/app/main/packages/features/src/Domain/Lists/Themes.ts
221. primer/github-vscode-theme (GitHub's own VS Code themes, MIT) https://github.com/primer/github-vscode-theme
222. VS Code built-in Monokai theme package.json (licence MIT) https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-monokai/package.json
223. VS Code built-in Monokai theme JSON (markup.bold #66D9EF, markup.underline.link #E6DB74) https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-monokai/themes/monokai-color-theme.json
224. tinted-theming base16 monokai.yaml (author Wimer Hazenberg, MIT repository) https://raw.githubusercontent.com/tinted-theming/schemes/spec-0.11/base16/monokai.yaml
225. Typora theme gallery: Github ("Built-in with Typora", the default theme) https://theme.typora.io/theme/Github/
226. Wallace et al. open study materials and data (tochi-paper-materials-towards-individuated-reading) https://github.com/virtual-readability-lab/tochi-paper-materials-towards-individuated-reading
227. WebKit Features in Safari 16.4 https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
228. WebKit Features in Safari 17.0 https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
229. WebKit Features in Safari 18.0 https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
230. caniuse raw data: css-relative-colors.json https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/css-relative-colors.json
231. caniuse raw data: font-size-adjust.json https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/font-size-adjust.json
232. WebKit: Tracking Prevention (font availability limited to web fonts and OS fonts) https://webkit.org/tracking-prevention/
233. Chromium source: font_matcher_mac.mm (`local()` resolved by PostScript or full name through CoreText) https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/fonts/mac/font_matcher_mac.mm
234. Firefox RFPTargetsDefault.inc (default fingerprinting-protection targets include font visibility) https://hg.mozilla.org/mozilla-central/raw-file/tip/toolkit/components/resistfingerprinting/RFPTargetsDefault.inc
235. primer/primitives scripts/themes.config.ts (14 theme builds) https://github.com/primer/primitives/blob/main/scripts/themes.config.ts
236. GitHub Docs: Managing accessibility settings (Contrast, Increase contrast) https://raw.githubusercontent.com/github/docs/main/content/account-and-profile/how-tos/account-settings/managing-accessibility-settings.md
237. Firefox source: AboutReader.sys.mjs (reader controls, colour schemes, custom colours, global prefs) https://raw.githubusercontent.com/mozilla-firefox/firefox/main/toolkit/components/reader/AboutReader.sys.mjs
238. Marinus et al. 2016, A Special Font for People with Dyslexia: Does it Work and, if so, why? (Europe PMC record) https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE:%22special%20font%20for%20people%20with%20dyslexia%22&resultType=core&format=json
239. glosa Electron shell menu: Reset Zoom, Zoom In, Zoom Out roles (lines 373 to 375) packages/shell/src/main.ts
240. WCAG Technique C20: relative column widths so lines can average 80 characters or less https://www.w3.org/WAI/WCAG22/Techniques/css/C20

Added after the completeness pass: surfaces beyond the manuscript (not adversarially verified)

241. CSS Color Adjustment Module Level 1 (Editor's Draft), §2.1, §2.4 and print-color-adjust https://drafts.csswg.org/css-color-adjust-1/
242. MDN: prefers-color-scheme https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme
243. MDN browser-compat-data: prefers-color-scheme (respects-inherited-scheme) https://bcd.developer.mozilla.org/bcd/api/v0/current/css.at-rules.media.prefers-color-scheme.json
244. Electron v44.4.5 release (Chromium 152.0.7977.130) https://releases.electronjs.org/release/v44.4.5
245. WebKit bug 316680: iframes don't respect the color-scheme CSS property of the parent document https://bugs.webkit.org/show_bug.cgi?id=316680
246. WebKit bug 309611: [Site Isolation] @prefers-color-scheme doesn't see color-scheme from parent frames https://bugs.webkit.org/show_bug.cgi?id=309611
247. WebKit bug 319500: color-scheme should affect prefers-color-scheme media query https://bugs.webkit.org/show_bug.cgi?id=319500
248. Media Queries Level 5 (Editor's Draft) https://drafts.csswg.org/mediaqueries-5/#prefers-color-scheme
249. MDN: iframe element, sandbox attribute https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
250. MDN: @font-face https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face
251. MDN browser-compat-data: css.properties.zoom https://bcd.developer.mozilla.org/bcd/api/v0/current/css.properties.zoom.json
252. VS Code API: Webview (Theming webview content) https://code.visualstudio.com/api/extension-guides/webview
253. Figma plugin docs: CSS Variables and Theming https://developers.figma.com/docs/plugins/css-variables/
254. Obsidian Help: Embed web pages https://obsidian.md/help/embed-web-pages
255. Obsidian Help: Web viewer https://obsidian.md/help/plugins/web-viewer
256. JupyterLab API: HTMLViewer https://jupyterlab.readthedocs.io/en/latest/api/classes/htmlviewer.HTMLViewer.html
257. GitHub Docs: Working with non-code files https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files
258. xterm.js ITheme https://xtermjs.org/docs/api/terminal/interfaces/itheme/
259. xterm.js ITerminalOptions https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
260. xterm.js typings (xterm.d.ts) https://raw.githubusercontent.com/xtermjs/xterm.js/master/typings/xterm.d.ts
261. VS Code docs: Terminal Appearance https://code.visualstudio.com/docs/terminal/appearance
262. diff2html README https://raw.githubusercontent.com/rtfpessoa/diff2html/master/README.md
263. Electron API: BaseWindowOptions (backgroundColor) https://www.electronjs.org/docs/latest/api/structures/base-window-options
264. Local probes: parent.html, parent3.html, parent4.html, iframe-probe-parent-dark.png, iframe-probe-parent3.png, iframe-probe-font-zoom.png and font-probe-console.log (Playwright Chrome 154, python http.server on two ports) a local measurement script (not committed)
265. glosa appearance.js (root colorScheme, line 79) and appearance-preload.js (lines 14 to 20) packages/spa/src/appearance.js and packages/spa/src/appearance-preload.js
266. glosa classf-bridge.ts (injected style at line 53) packages/daemon/src/security/classf-bridge.ts
267. glosa classf-viewer.js (message types at line 12, mark routing at line 131, glosa:init at line 234) packages/spa/src/classf-viewer.js
268. glosa artifact-pane.js (MARGIN_RAIL_FLOOR at line 158, print path at line 1169, class-F mount at line 2265) packages/spa/src/artifact-pane.js
269. glosa classf-serve.ts (font responses, line 100), csp.ts (SPA CSP line 31, class-F CSP line 49) and http.ts (asset allowlist lines 116 to 119, stylesheet comment line 180) packages/daemon/src/transport/classf-serve.ts, packages/daemon/src/security/csp.ts and packages/daemon/src/transport/http.ts
270. glosa A3 security appendix §1, §2 and §4b, and A1 §7 docs/appendices/A3-security.md and docs/appendices/A1-api-transport.md
271. glosa agent-login.js (terminal construction, lines 57 to 65) packages/spa/src/agent-login.js
272. glosa diff surfaces: vendored diff2html.min.css, diff-pane.js line 70 and history.js line 156 packages/spa/src/vendor/diff2html.min.css, packages/spa/src/diff-pane.js and packages/spa/src/history.js
273. glosa app.css surface blocks (selection line 314; manuscript size lines 2616 and 4814; headings 2644 to 2659; code 2778; class F 2890 to 2930; diff 5090 to 5115; print 6243 to 6443; terminal 7278; chat 7398 to 7432) packages/spa/src/app.css
274. glosa shell main.ts (window lines 248 to 261, blocking page line 125, nativeTheme lines 493 to 496) packages/shell/src/main.ts

Added after the completeness pass: user voice (not adversarially verified)

275. Bear App Store reviews (US, iTunes RSS): most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=1016366447/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=1016366447/sortby=mostrecent/json
276. Readwise Reader App Store reviews: most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=1567599761/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=1567599761/sortby=mostrecent/json
277. Notion App Store reviews: most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=1232780281/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=1232780281/sortby=mostrecent/json
278. Craft App Store reviews: most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=1487937127/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=1487937127/sortby=mostrecent/json
279. iA Writer iOS App Store reviews: most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=775737172/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=775737172/sortby=mostrecent/json
280. iA Writer Mac App Store reviews: most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=775737590/sortby=mosthelpful/json and most recent https://itunes.apple.com/us/rss/customerreviews/page=1/id=775737590/sortby=mostrecent/json
281. Ulysses App Store reviews, most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=1225570693/sortby=mosthelpful/json
282. Kindle App Store reviews, most helpful https://itunes.apple.com/us/rss/customerreviews/page=1/id=302584613/sortby=mosthelpful/json
283. iA: A Typographic Christmas (Mono, Duo, Quattro built on IBM Plex, 2018) https://ia.net/topics/a-typographic-christmas
284. iA Writer product page https://ia.net/writer
285. iA Writer Mac store lookup (v8.0.9 release notes and description) https://itunes.apple.com/lookup?id=775737590
286. iA Writer version history (Mac): 5.2 typeface refresh, 12 text sizes https://ia.net/writer/support/help/version-history
287. HN comment on "Almost monospaced: the perfect fonts for writing" (2022) https://hn.algolia.com/api/v1/items/33500570
288. HN comment with a reply defending the constraint (2023) https://hn.algolia.com/api/v1/items/35310900
289. Bear community: Feedback wanted on Colored Highlight proposal (2024) https://community.bear.app/t/13078.json
290. Bear community: Highlighter changes, feedback integration and accessibility improvements (2024) https://community.bear.app/t/13844.json
291. Bear community: Typewriter Mode + Themes? (Lettera, 2026) https://community.bear.app/t/19298.json
292. Bear community: Lettera Beta Update: Typography settings (2026) https://community.bear.app/t/19482.json
293. Bear community: Please more really really black font choices (2026) https://community.bear.app/t/19786.json
294. Bear community: System Font for main app UI (2024) https://community.bear.app/t/12452.json
295. Bear App Store listing (lookup, v3.0 description) https://itunes.apple.com/lookup?id=1016366447
296. Bear FAQ: What's new in Bear 2 https://bear.app/faq/whats-new-in-bear-2/
297. Obsidian forum: Adjustable "Readable Line Length" https://forum.obsidian.md/t/7564.json
298. Obsidian forum: The text is too bright in default CSS https://forum.obsidian.md/t/6382.json
299. Obsidian forum: Fully visual editor mode (WYSIWYG) https://forum.obsidian.md/t/41517.json
300. Obsidian forum searches: themes ordered by likes https://forum.obsidian.md/search.json?q=theme%20in%3Atitle%20order%3Alikes and font in title ordered by likes https://forum.obsidian.md/search.json?q=font%20in%3Atitle%20order%3Alikes
301. GitHub API: typora-issues sorted by reactions https://api.github.com/search/issues?q=repo:typora/typora-issues&sort=reactions&order=desc&per_page=15 and "theme" in title https://api.github.com/search/issues?q=repo:typora/typora-issues+theme+in:title&sort=reactions&order=desc&per_page=20
302. Appt: font size statistics (Netherlands) https://appt.org/en/stats/font-size
303. NN/g: Dark Mode, How Users Think About It and Issues to Avoid https://www.nngroup.com/articles/dark-mode-users-issues/
304. Jared Spool: Do users change their settings? (UIE, 2011) https://archive.uie.com/brainsparks/2011/09/14/do-users-change-their-settings/
305. HN Algolia searches: dark mode retention https://hn.algolia.com/api/v1/search?query=dark%20mode%20retention&hitsPerPage=30 and Kindle typography comments https://hn.algolia.com/api/v1/search?query=Kindle%20typography%20bad&tags=comment&hitsPerPage=40

## Question 4: are the on-hover passage addresses useful, and for whom?

**Verdict**

1. Yes, keep them, on narrower grounds than first stated. They cost almost nothing, they are Review-only, and they let a person match a margin card, a Go to row and a block on the page by one short name. The stronger claim, that every prose review practice numbers every unit during review, did not survive verification: Word, Google Docs and PLOS number printed lines as an opt-in for references made outside the document, and tools with anchored in-place comments keep numbers off even in review.
2. Today they serve only the person. The address is never sent to the agent and never parsed from chat, so the "a name a human and a session can both say" intent in `address.js` is half-built: a person can type `§2.3` into chat and the session cannot resolve it. The hover display is a sound default for body blocks. The label also sits in the accessibility tree on every top-level block in Review, hovered or not.
3. Do: keep the current default, add a hover-in delay, and offer an opt-in "Show all addresses" inside Review if dense review turns out to need it. Treat sending the address to the agent as a product choice, not an evidence-backed requirement: the gap is real, the research offered for closing it is contested. The screen-reader policy step is withdrawn: the WCAG and screen-reader analysis behind it was dropped in verification. Do not remove them, and do not move them to the margin only.

Terms: a *passage address* is the § label. `§2.3` is the third block under the second heading; `¶4` is the fourth paragraph of a document with no headings. Only top-level blocks get one; a list item or a paragraph inside a quote has no address of its own. It is recomputed from the rendered structure on every paint and stored nowhere. "Review" is the pane state `data-mode="review"`; the person reaches it through the "Note" toggle (aria "Show notes" / "Hide notes").

### What glosa ships today

The address is derived, never stored. `addressBlocks()` walks the top-level blocks on every call; nothing writes the label into a record, the journal, localStorage or the URL. Inserting a block above a note renumbers the page and the note's card together, and a test pins that (`§0.1` becomes `§0.2`) [S8]. No test pins the gutter behaviour itself; the "Passage Addresses" section of DESIGN.md is its only written contract [S9].

| Surface | When shown | Who reads it | Derived or stored |
|---|---|---|---|
| Page gutter on the rendered document | Review only. Headings: by default. Other blocks: on hover or keyboard focus. Any block beside a session's bracket, heading or not: never (`display: none`); the session tab carries the address instead. Read and Edit: never | The person, by eye | Derived: a `data-address` attribute restamped on every render, painted by a CSS `::before`, hidden with `opacity: 0` and `pointer-events: none`; the text stays in the accessibility tree |
| Margin entry card (rail, tray, hover preview) | Always, in the card head before "You"; blank when the passage is lost | The person | Derived on every repaint |
| Composer (unsent draft) | Always, in pencil colour beside "You · not sent yet" | The person | Derived when the composer opens |
| Go to palette (⌘K) | Always on each section row; also part of the row's filter text, so typing `2.1` narrows to that section | The person; the only place typing an address does anything | Derived from the heading's `data-address` |
| Right-gutter marker dots | All modes, accessible name only: "§2.3 · Go to annotation: ..." | Screen-reader users | Derived |
| Session tab (a session's question or pointer, left gutter) | Accessible name only: "§2.3 · Question from <provider>. Go to its card." | Screen-reader users | Derived |
| Ask notice strip under the document bar | Visible text when the passage can be located | The person | Derived |
| Run editor (Edit mode, in-place block editing) | Accessible label only: "Editing §2.3" | Screen-reader users | Derived |
| Chat and conversation panes | Never; nothing parses a § in free text | Nobody | Not present |
| Print | Never, since the print rework (#398): the print block hides every generated address and every mark, whatever the pane's mode. Cards, dots and the composer are hidden too | Nobody | Not present |
| Agent payload (inbox entry, monitor line, Codex inject, MCP get and pull) | Never. The delivered text is a `workspace:` line, then the fixed header (id, `artifact:` path, intent, quote, position, resolution, comment), the comment body and an apply-protocol block; the structured detail is artifact_path, body, intent, target and resolution | Nobody; the agent re-finds a passage by `quote {exact, prefix, suffix}` and by the resolution's source line range (path, start_line, end_line, matched_quote, confidence) | Not sent. A Markdown selection's target holds quote and position (class-F targets may add `chunk_id`); the posted record adds body, intent, artifact_path and captured_rendered_sha256. `glosa_ask` names a passage by quote and has no address parameter |

Three facts that shape the rest of this section:

- Nobody has to type an address. Annotating starts from a selection or a focused block; navigation goes through the palette, the dots, the tabs, the notice's "Go to it" or a card's quote [S3].
- Keyboard reach exists. In Review every non-empty top-level block is a roving-tabindex target; Up and Down move between blocks, Enter or Space annotates, and a focused block shows its address [S3, S2].
- The label is announced, not hidden, to assistive technology. `opacity: 0` hides it from the eye only; a Chromium accessibility snapshot of Review reads the address before every top-level block, hovered or not [S2]. No screen reader has been run against it, and whether that is help or noise is untested.

Where to look: `packages/spa/src/address.js:2-12`, `packages/spa/src/app.css:2846-2883`, `packages/spa/src/artifact-pane.js:4127-4143` (stamping), `:3843-3858` (card), `:2361-2366` (composer), `:2901-2934` (dots), `:3148-3159` (session tab), `packages/spa/src/palette.js:243-246`, `packages/daemon/src/delivery/presentation.ts:118-126`, `packages/daemon/src/anchoring.ts:95-103` (source range), `packages/spa/src/annotate.js:32-47`, `packages/cli/src/mcp-schemas.ts:311-378`. The feature shipped in PR #243 with the stated purpose "The label a margin entry names can now be found on the page" [S9].

### Precedents

Four families, plus the AI case. The split that matters is not "numbers or no numbers" but whether the two parties share a live surface.

**Review practice, code and prose: numbers on for reference outside the document, opt-in for prose**

| Tool or practice | Numbering shown when | Purpose | Who benefits |
|---|---|---|---|
| GitHub and GitLab pull request diff | Always, old and new line numbers; hover reveals the comment action, never the number | Anchor and link every comment to a line | Reviewer points, author locates, link recipient, machine via URL fragment [1, 2] |
| Gerrit | Always; `#<line>` in the URL; click a number to comment | Same | Same [3] |
| GitHub rendered Markdown (rich diff) | Never; comments and line links work only in source view | The gap glosa fills: reviewers ask for Docs-style comments on the rendered view and an extension bolts line numbers onto it | Nobody today [5, 6, 7] |
| Microsoft Word line numbers | Added on demand under Layout > Line Numbers; continuous, per page or per section; tables and footnotes skipped | "refer to specific lines in a document, such as a script or a legal contract" | Contract or script reviewer [8] |
| Google Docs line numbers (July 2023) | Off until enabled under Tools > Line numbers; paged mode only; on screen and in print | "reference specific content positions ... particularly when collaborating with others on long or complex content" | Collaborators [9, 10] |
| PLOS ONE manuscript | Required continuous line numbers in the submitted DOC, DOCX or RTF file; gone from the published article | The reviewer writes "line 212" in a separate report (the page states no reason; this is an inference) | Reviewer writing to an author who holds the same copy [11] |
| California Rules of Court 2.108 | Always on filed papers, left margin, separated from the text by a column of space | Pinpoint inside a filing | Court and opposing counsel [12] |

Objection from verification: all three prose sources number typeset lines of a paged layout as a per-document opt-in for reference outside the document (a report, an email, a contract call), none numbers paragraphs or reveals numbers on hover, and Word and Google Docs keep line numbers off even during review because their comments anchor to the words, which is glosa's case too.

**Citation practice, legal and scholarly: the number is on, always, and frozen**

| Practice | Numbering shown when | Purpose | Who benefits |
|---|---|---|---|
| England and Wales judgments (neutral citation, 2001) | Always, paragraph numbers in the margin, no page numbers; "the number allotted by the court in all future versions" | Cite "at [59]" in any medium, reported or not | Lawyer, judge, web reader [13, 14, 15, 16] |
| DHQ, an online-only journal | Always, `[n]` at the start of every paragraph; § for sections and ¶ for paragraphs in citations | Cite a passage in an unpaginated article | Citing scholar [17] |
| APA locator when a source has no pages | Never shown; the citer counts ("paras. 4-5") or names a heading | Fallback pinpoint | Citing writer, reader who re-counts [18] |
| Bible verses, Stephanus pages (Plato), Bekker numbers (Aristotle) | Always, in the margin of every edition; frozen to one reference edition; openly not part of the text | The same passage across editions and translations | Preacher, scholar, mixed-edition readers [19, 20, 21] |
| Kindle locations | Always in the footer when no print mapping exists | Progress; resented for citing because it maps to nothing visible | The reader alone [22] |

**Annotation standards and collaborative editors: no number, because both sides share the surface**

| Tool or standard | Numbering shown when | Purpose | Who benefits |
|---|---|---|---|
| W3C Web Annotation Data Model | Never; anchors are quote, position, CSS, XPath and range selectors; the position selector is "very brittle with regards to changes to the resource", and the spec recommends pairing it with a State (a version pin) | Survive edits | Interoperable clients [23] |
| Hypothes.is | Never; highlight plus sidebar card; three selectors tried in order, range first, position second, quote with prefix and suffix plus fuzzy matching as the fallback, seeded from the stored position | Survive edits "because documents change frequently" | Reader, author [24] |
| Google Docs, Word, Notion comments | Never; highlight plus margin card | Point on a shared live surface | Co-editors [25, 26, 27] |
| Notion "Copy link to block", Craft deeplink | Never shown; an opaque block id lives inside the copied link | A reference that leaves the page | Link recipient [28, 29] |
| Obsidian block reference | A `^id` is written into the source line; headings link by text | A stable link between notes | The author [30] |
| GitHub heading anchor, Pandoc, AsciiDoc, MyST ids | Link icon on hover (GitHub); ids derived from heading text or authored; MyST renders "Section 1.3.7" as display text only | Cross-reference by identity, number only for display | Link sharer, document author [31, 32, 33, 34] |

Objection from verification: the mature answer these sources describe is a layered anchor (a version-pinned position tried first, the quote as fallback), not a quote anchor alone, and glosa already ships that layering (quote plus position gated by the rendered hash and the block's `data-line` scope, fuzzy matching deliberately deferred).

**Reading surfaces and writing-first editors: nothing, or opt-in**

| Tool | Numbering shown when | Purpose | Who benefits |
|---|---|---|---|
| iA Writer, Bear, Ulysses | No line or paragraph numbers exist | A clean writing surface | The writer [35, 36, 37] |
| Obsidian editor | Off by default; Settings > Editor > Show line numbers; users turn it on for long documents | Orientation on demand | The writer [38] |
| Typora source mode | Sparse: first, last, every tenth and the current line | Orientation without clutter | The writer [39] |
| Medium, Substack | Never; a highlight or a copied quote travels; readers can hide others' highlights as distraction | Share a passage | Reader, author [40, 41] |
| Bibliotheca, reader's Bibles | Numbers removed on purpose; the study edition keeps them | Uninterrupted reading | The reader [42, 19] |

**Pointing an AI at a passage**

| Tool | Reference form | Visible label? | Why it is shaped that way |
|---|---|---|---|
| Claude Code in VS Code | Selection auto-shared with every prompt; Option+K optionally inserts `@file.ts#5-10`; the CLI prints "⧉ Selected N lines from <file>" | Optional: file plus line range on top of the shared text | The agent is a separate pane; the text is the default channel, the label a one-key supplement [43] |
| GitHub Copilot Chat | `#selection` and `#line` (VS Code, typed) insert the selected text or the current line; `#MyFile.cs: 66-72` in Visual Studio | Typed variables carrying content, not a one-key label | Same [44] |
| Cursor | Cmd Shift L or K adds the selection to chat or edit | Docs do not say | Same [45] |
| Zed (requested, not shipped) | `@filename#L100-110` from a selection; one user: "the biggest blocker preventing me from switching" | Requested | Same demand [46] |
| ChatGPT Canvas, Claude.ai side-panel editor, Gemini in Docs, Notion AI | Highlight, then ask | None | Model and person share one surface, synchronously: "so you don't have to describe which section you mean" [47, 48, 49, 50] |
| glosa today | Note anchored by quote; § label shown in the SPA only | Yes on the page (Review), card, composer, palette; not sent to the agent | The agent is a separate, asynchronous terminal session, and chat has no selection [S1, S6] |

Objection from verification: these tools share the selected text itself by default and treat the file#line label as an optional supplement (Copilot's variables insert content and are typed, not one-key), so the "one-key label rather than a described passage" reading inverts them, and all of it is code-editing evidence that supports what glosa already does (pass the quote), not a § label for the agent.

### Hover-reveal, always-on, or never: what the evidence says

Hover-only is safe for glosa's body blocks because the address is not on the task's critical path. Reading needs no number, and naming a passage in a note gets its number from the composer and the card. It would fail the moment the page hover became the only place to learn a block's address.

| Question | Evidence | What it says for glosa |
|---|---|---|
| Does hiding things behind hover cost anything? | NN/g's hidden-navigation study: discoverability fell by more than 20%, desktop users were at least 39% slower [51]. NN/g tooltip guideline: "Important information should always be on the page" [53]. NN/g contextual-menu guideline: "Don't: Tuck them away in hover-only states" [52] | Hover-only is acceptable only because the composer and the card carry the number. Keep those copies |
| Is "headings always, blocks on demand, Read clean" the right tiering? | Nielsen: "disclose everything that users frequently need up front", defer the rest [54]. Apple HIG: hide details until relevant; keep the most-used controls visible [55] | This is the textbook split. Do not flatten it into a single global on/off |
| Does the reveal blink while reading? | The cursor tracks gaze (Huang, White and Dumais 2011, on search pages) [57]. NN/g timing rule: reveal hidden content after the pointer has stopped for 0.3 to 0.5 s [56]. glosa reveals with no delay, only a fast opacity transition [S2] | The real cost of hover is motion, not clutter: an 11 px vermilion label appears and vanishes in peripheral vision as the cursor tracks each paragraph, for hours. A hover-in delay of roughly 150 to 300 ms and no hover-out delay removes most of it |
| Would always-on labels hurt reading? | Seductive-details meta-analysis: extraneous material hinders learning [58]. Eye tracking: extraneous illustration detail raised gaze shifts away from text and lowered comprehension, in children [59] | Direction only: keep Read empty. Nothing here condemns the sparse Review gutter, and an 11 px numeral is a weak fit for "seductive detail" |
| What do prose tools ship? | Writing-first editors ship no numbers at all [35, 36, 37]; editors that straddle prose and code make numbers opt-in [38] or sparse [39]; Word and Docs make line numbers opt-in and PLOS requires them in the submitted file, then drops them at publication [8, 9, 11] | The market norm for a prose surface is opt-in. glosa offers neither an opt-in nor an always-on state today; whether dense review needs one is a product question, since the numbering precedents serve out-of-band reference, not in-place review |

Objection from verification, on the first row: the hamburger study measured click-hidden primary navigation on websites and never mentions hover, so its figures do not transfer to a hover-revealed label; the tooltip rule is conditional on the information being task-essential, which the § label is not; and progressive disclosure endorses hiding secondary items, so two of the three sources support the shipped tiering rather than count against it.

Summary rule from the evidence, per condition:

```
Reading, not pointing (Read)                 --> never
Rarely needed, obscures nothing (body blocks)--> hover or focus reveal
Navigation skeleton (headings)               --> always-on
Dense pinpoint review                        --> opt-in always-on inside Review (precedent contested)
Pointer rests on text and the label blinks   --> keep hover, add hover-in delay
Keyboard                                     --> focus reveal
```

The WCAG and screen-reader rows that stood here were removed. Their claim (SC 1.4.13 out of scope, SC 2.1.1 met, three inconsistent screen-reader policies) was dropped in verification. The one accessibility fact that survives is the confirmed one above: the label is in the accessibility tree on every top-level block in Review.

### The human-agent addressing argument

The strongest reason offered for keeping addresses was the pair, and the pair does not exist in the shipped code. After verification the research behind the pair is contested, so this argument carries less weight than the plain wayfinding use.

| What `address.js` intends | What the tree does |
|---|---|
| "A mark needs a short name a human and a session can both say" [S1] | The delivered entry has no address line; the monitor prints `[glosa <id>]` plus the entry JSON; Codex injects the same; the target holds quote and position (plus `chunk_id` for class-F), the record adds body, intent, artifact_path and captured_rendered_sha256, and the resolution carries a source line range [S6, S7] |
| "§2.3" is sayable in chat | Chat is free text; nothing parses a §, and nothing agent-facing (plugin skill, providers, MCP descriptions) teaches the scheme [S3] |
| The agent could say "changed §3.1" back | No daemon or provider code derives an address; `glosa_ask` names a passage by quote [S6, S7] |

Why a shared label was argued to pay, from research that is human-to-human and applied here by analogy:

- Referring is a collaborative process that gets cheap once a label is agreed. In Clark and Wilkes-Gibbs's tangram study, directors averaged 41 words per figure on the first trial and 8 by the sixth, across all their turns on a figure, as pairs settled on standard noun phrases like "the ice skater" [60]. The argument was that `§2.3` is that noun phrase handed over at trial one, and that with an agent the repair it prevents ("which paragraph about the tree?") costs a full round trip.
- Locating the problem helps the writer act on feedback. Nelson and Schunn coded 1,073 peer-feedback segments in a correlational analysis: stating the location of the problem was associated with higher understanding, and understanding was the only significant mediator of implementation [61]; later work confirms vague comments are processed less deeply [62]. glosa's notes are already localized by the quote, so the address could only earn its keep where a quote cannot reach: a chat line, a note about two passages ("§2 repeats §4"), and the agent's reply.

Objection from verification: Clark's cheap labels were descriptions earned through six rounds of talk about unnamed shapes (the pre-numbered array slots played the role of glosa's anchor, not its § label), Nelson and Schunn's localization is already met by glosa's quote anchor, and neither study tests a pre-assigned label that renumbers on edit or a hover-revealed paragraph number.

- Coding agents lean on a location label inserted from a selection: Claude Code's Option+K, Cursor's Cmd Shift L, Copilot's typed `#selection` [43, 44, 45]. Prose AI tools need none because they share one surface synchronously [47, 48, 49, 50]. glosa's agent is a separate asynchronous terminal, and chat has no selection, so glosa is closer to the code case than the prose case.

Objection from verification: those tools pass the selected text by default and add the label only as an optional supplement, which is what glosa already does with the quote, so the precedent supports the shipped anchor rather than a label for the agent.

Two hazards the evidence names, and the shape of the fix:

| Hazard | Evidence | Fix |
|---|---|---|
| Agents read numbers well and edit by them badly | SWE-agent prepends line numbers to localize; aider: "GPT is terrible at working with source code line numbers ... backed up by many quantitative benchmark experiments" and edits by search and replace; Claude Code's Read prints numbers while Edit is exact string replacement [63, 64, 65] | The address is a pointer the agent resolves to a quote, never the key it edits by. Ship the derivation, or a lookup, not a licence to count |
| A spoken address goes stale on the next insert | "fix §2.1" in chat is a position selector in prose. W3C calls position selectors "very brittle with regards to changes" [23]; GitHub's outdated-comment thread has run seven years with 96 downvotes on the accepted answer [66, 67], and GitHub pins a line to a commit SHA permalink [4]; glosa's own header says "insert a paragraph above and everything after it renumbers" [S1] | Whenever glosa inserts an address into a note or chat, append the first few quoted words (address plus quote selector), and have the agent's reply carry the same pair. A bare address is valid for the current checkpoint only |

Objection from verification, first row: content editing is the majority pattern, not a universal one, since SWE-agent's 2024 interface edited by `edit n:m` line ranges with a linter guard and Anthropic's `insert` still takes a line number. Objection, second row: the § label itself never persists (it is recomputed on every render and never stored, posted or delivered), so staleness bites only an address a person types into chat or a note, and the GitHub permalink page cited is about files, not lines.

Who the address serves per use, given the shipped tree:

| Use | Serves | Works today? |
|---|---|---|
| Naming a note in the rail, composer and palette | The person alone: orientation, scanning, Go to | Yes |
| Localizing a note for the agent | The quote and the source line range do it; the address adds nothing | Yes, without the address |
| Talking about two passages in one note or chat | The pair | Half: the person can say it, the agent cannot resolve it |
| The agent replying "changed §3.1" | The pair; the cheapest confirmation there is | No |
| A reference across an edit round | Nobody | No, needs the quote fragment or a checkpoint binding |

Two routes to close the gap, if the maintainer wants it closed, with the trade-off stated plainly: (a) the daemon derives the address from the source map it already resolves and adds an `address:` line to the delivered entry, keeping "derived, never stored" intact but duplicating the derivation rule outside the SPA; (b) the SPA sends the address in the record as a display hint next to the quote, cheaper, but it writes a label into a record that `address.js` says is "never an identity". Either way the agent's instructions must say the quote is the anchor and the number is a label over it. The alternative is to drop the "a session can say it" sentence from `address.js` and let the label be what it is today: a human-side name.

### Recommendation

Keep the addresses, keep the Review-only rule, and change when they show only by adding choices, not by changing the default. Verification narrowed the case: the accessibility leg is gone, the review-practice precedent is contested, and the pair research is contested. What survives is reading calm, the hover-in delay, and an opt-in whose shape (off until enabled) matches Word and Docs even though their reason does not.

Scores are 1 (worst) to 5 (best). Effort is scored so that 5 means least work. The Accessibility column was removed: the WCAG and screen-reader analysis it scored on did not survive verification.

| Option | Reading calm | Findability of a note's passage | Agent addressing | Effort | Total |
|---|---|---|---|---|---|
| A. Keep as is | 4: Read is clean; the label blinks under a travelling cursor in Review | 3: headings always; a body block only by hovering block by block; a card's own jump covers its note, a number from chat does not | 3: a label exists to say; the agent cannot resolve it | 5 | 15 |
| B. Keep addresses, change when they show: hover-in delay, opt-in "Show all addresses" in Review | 5: default unchanged, blink removed, always-on only by choice | 4: dense review can turn every number on; the opt-in shape matches Word and Docs, though they number lines for out-of-band reference, not paragraphs for review | 3: dictating "§2.3" to chat is easier once the page shows it; the agent still cannot resolve it, and the research for the pair is human-to-human | 3 | 15 |
| C. Margin only, never on the page | 5 | 2: a number on a card with nowhere to find it on the page; the palette covers headings only | 2: the agent could say "§3.1" back and the person would have to count | 4 | 13 |
| D. Remove | 5 | 1: only the quote and the card's jump; nothing to say in chat about a passage | 1: nothing to say | 4: delete `address.js` and its eight consumers, tests, DESIGN.md | 11 |

B no longer wins outright. With the accessibility column gone and the precedent softened, B ties A in total: it leads on reading calm (the hover-in delay) and on findability (the opt-in), and pays for both in effort. C and D still lose: they buy calm the page already has in Read and give up the one use that is verified, finding on the page the block a card or a palette row names. The recommendation therefore narrows to what still has support.

What survives of B, concretely:

1. Default unchanged: headings always, body blocks on hover or focus, Read and Edit clean, the session's bracket still wins the spot.
2. A hover-in delay of roughly 150 to 300 ms on `[data-address]:hover::before`, none on hover-out: the NN/g "pointer stopped" heuristic in one CSS line, on evidence that was not challenged [56].
3. An opt-in "Show all addresses" for Review in the pane's More menu, stored per workspace and document like the face chooser in `packages/spa/src/face.js`, never leaking into Read. This is a product choice: the precedent for it is opt-in line numbering for out-of-band reference, not evidence that in-place review needs every paragraph numbered.
4. Print: settled by the print rework (#398), which hides every address and mark in print. No work.

Withdrawn: the "one screen-reader policy" item (a visually hidden span with `aria-describedby`, the palette's `aria-hidden` dropped). Its basis, the SC 1.4.13 and 2.1.1 reading and the three-policies finding, was dropped in verification. What remains verified is only that the label sits in the accessibility tree on every top-level block in Review; a VoiceOver pass is the first step before any policy, and nothing in this section says what that policy should be.

Also a product choice, not a recommendation: the agent step (route a or b above), an address line beside the quote in the delivered entry, the same pair in the agent's replies, and one sentence in the agent's instructions that the number is a label over the quote. The gap is confirmed; the research offered for closing it did not survive as support.

What would change this verdict: a VoiceOver pass showing the per-block announcement to be noise would put an accessibility item back, on new evidence; a maintainer decision that the agent will never receive the address would drop the agent column and leave A and B level, decided by whether the hover-in delay and the opt-in are worth their effort; a decision that it should would make route (a) or (b) the next step.

Gaps in the evidence: no study measures paragraph numbers, as opposed to quotes or highlights, in prose review with or without an AI agent; the referring and feedback research is human-to-human, and verification found it does not transfer to a pre-assigned, renumbering label. The accessibility-tree finding comes from a Chromium snapshot, not from a screen reader. The Google Docs line-numbers row rests on the Workspace Updates post of 24 July 2023 and a news report. Amazon's own Kindle pages could not be opened, so the Kindle row rests on community sources.

### Sources

glosa code, read on 2026-09-27:

- [S1] `packages/spa/src/address.js`
- [S2] `packages/spa/src/app.css`
- [S3] `packages/spa/src/artifact-pane.js`
- [S4] `packages/spa/src/palette.js`
- [S5] `packages/spa/src/annotate.js`
- [S6] `packages/daemon/src/delivery/presentation.ts`
- [S7] `packages/cli/src/mcp-schemas.ts`
- [S8] `packages/spa/test/annotation-surface.test.ts`
- [S9] `DESIGN.md`

External, all opened:

1. GitLab: Changes in merge requests. https://docs.gitlab.com/user/project/merge_requests/changes/
2. GitHub Docs: Commenting on a pull request. https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request
3. Gerrit: Review UI. https://gerrit-review.googlesource.com/Documentation/user-review-ui.html
4. GitHub Docs: Getting permanent links to files. https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files
5. GitHub Docs: Working with non-code files. https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files
6. GitHub Community discussion #160981: Inline comments don't show on rich diff view. https://github.com/orgs/community/discussions/160981
7. sabbour.me: A browser extension for better Markdown reviews in GitHub pull requests. https://sabbour.me/2026/03/23/markdown-rich-review-for-github-prs.html
8. Microsoft Word: Add or remove line numbers. https://support.microsoft.com/en-us/office/add-or-remove-line-numbers-b67cd35e-422c-42eb-adc9-256ca9802e22
9. Google Workspace Updates: Adding line numbers to Google Docs (24 July 2023). https://workspaceupdates.googleblog.com/search?q=line+numbers
10. 9to5Google: Google Docs adds line numbers. https://9to5google.com/2024/04/03/google-docs-line-numbers/
11. PLOS ONE: Submission guidelines. https://journals.plos.org/plosone/s/submission-guidelines
12. California Rules of Court, rule 2.108. https://www.courts.ca.gov/cms/rules/index.cfm?title=two&linkid=rule2_108
13. Law Society Gazette: Practice Direction (Judgments: Form and Citation), 2001. https://www.lawgazette.co.uk/news/practice-directions/33121.article
14. Inner Temple Library: Guide to neutral citations. https://www.innertemplelibrary.org.uk/research-and-training/guide-to-neutral-citations/
15. OSCOLA 4th edn (2012), section 2.1.3. https://www.law.ox.ac.uk/sites/default/files/migrated/oscola_4th_edn_hart_2012.pdf
16. BAILII: Citation of cases. https://www.bailii.org/bailii/citation.html
17. DHQ: Citation guidelines. https://dhq.digitalhumanities.org/submissions/citationGuidelines.html
18. Purdue OWL: APA in-text citations, sources without page numbers. https://owl.purdue.edu/owl/research_and_citation/apa_style/apa_formatting_and_style_guide/in_text_citations_the_basics.html
19. Wikipedia: Chapters and verses of the Bible. https://en.wikipedia.org/wiki/Chapters_and_verses_of_the_Bible
20. Wikipedia: Stephanus pagination. https://en.wikipedia.org/wiki/Stephanus_pagination
21. Wikipedia: Bekker numbering. https://en.wikipedia.org/wiki/Bekker_numbering
22. Screenrant: How to see page numbers on Kindle books. https://screenrant.com/amazon-kindle-books-see-page-numbers-how/
23. W3C: Web Annotation Data Model. https://www.w3.org/TR/annotation-model/
24. Hypothes.is: Fuzzy anchoring. https://web.hypothes.is/blog/fuzzy-anchoring/
25. Google Docs Help: Use comments and action items. https://support.google.com/docs/answer/65129
26. Microsoft Word: Insert or delete a comment. https://support.microsoft.com/en-us/office/insert-or-delete-a-comment-8d3f868a-867e-4df2-8c68-bf96671641e2
27. Notion: Comments, mentions and reminders. https://www.notion.com/help/comments-mentions-and-reminders
28. Notion: Create links and backlinks. https://www.notion.com/help/create-links-and-backlinks
29. Craft: Deeplinks. https://craft-support.mintlify.app/en/organize-and-find/linking/deeplinks.md
30. Obsidian Help: Internal links. https://obsidian.md/help/links
31. GitHub Docs: Basic writing and formatting syntax (section links). https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax
32. Pandoc User's Guide: headings and sections, auto_identifiers. https://pandoc.org/demo/example33/7.2-headings-and-sections.html
33. AsciiDoc: auto-generated section IDs. https://docs.asciidoctor.org/asciidoc/latest/sections/auto-ids/
34. MyST Markdown: cross-references. https://mystmd.org/guide/cross-references
35. iA Writer Support: Settings. https://ia.net/writer/support/basics/settings
36. Bear FAQ. https://bear.app/faq/
37. Ulysses Help. https://help.ulysses.app/
38. Obsidian forum: Toggle Settings > Editor > Show line numbers via Command Palette. https://forum.obsidian.md/t/toggle-settings-editor-show-line-numbers-via-command-palette/86050
39. Typora issue #4502: Display line numbers in source code mode on all lines. https://github.com/typora/typora-issues/issues/4502
40. Medium Help Center: Highlights. https://help.medium.com/hc/en-us/articles/214406358-Highlights
41. Substack Help: What happens when someone restacks my post? https://support.substack.com/hc/en-us/articles/30285743283860-What-happens-when-someone-restacks-my-post
42. Bibliotheca. https://www.bibliotheca.co/
43. Claude Code docs: Use Claude Code in VS Code. https://code.claude.com/docs/en/vs-code
44. GitHub Copilot Chat cheat sheet. https://docs.github.com/en/copilot/reference/github-copilot-chat-cheat-sheet
45. Cursor: keyboard shortcuts. https://cursor.com/docs/configuration/kbd
46. Zed discussion #40211: Support adding selected lines to Claude prompt. https://github.com/zed-industries/zed/discussions/40211
47. Claude Help Center: What are artifacts and how do I use them? https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
48. Google Docs Help: Write and edit with Gemini in Docs. https://support.google.com/docs/answer/13447609?hl=en
49. Notion: Use Notion AI to write better notes and docs. https://www.notion.com/help/guides/notion-ai-for-docs
50. Zapier: How to use ChatGPT canvas. https://zapier.com/blog/chatgpt-canvas/
51. NN/g: Hamburger menus and hidden navigation hurt UX metrics (2016). https://www.nngroup.com/articles/hamburger-menus/
52. NN/g: Designing effective contextual menus, 10 guidelines (2025). https://www.nngroup.com/articles/contextual-menus-guidelines/
53. NN/g: Tooltip guidelines (2019). https://www.nngroup.com/articles/tooltip-guidelines/
54. NN/g: Progressive disclosure (Nielsen, 2006). https://www.nngroup.com/articles/progressive-disclosure/
55. Apple HIG: Disclosure controls. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/disclosure-controls.json
56. NN/g: Timing guidelines for exposing hidden content (Harley, 2015). https://www.nngroup.com/articles/timing-exposing-content/
57. Huang, White and Dumais (CHI 2011): No clicks, no problem: using cursor movements to understand and improve search. https://www.microsoft.com/en-us/research/publication/no-clicks-no-problem-using-cursor-movements-to-understand-and-improve-search/
58. Sundararajan and Adesope (2020): Keep it coherent: a meta-analysis of the seductive details effect. https://link.springer.com/article/10.1007/s10648-020-09522-4
59. Eng et al. (CogSci 2021): The optimal amount of visuals promotes children's comprehension and attention. https://www.cmu.edu/dietrich/psychology/cs/research-teaching/docs/reading-study_2021.pdf
60. Clark and Wilkes-Gibbs (1986): Referring as a collaborative process, Cognition 22. https://web.stanford.edu/~clark/1980s/Clark,%20H.H.%20_%20Wilkes-Gibbs,%20D.%20_Referring%20as%20a%20collaborative%20process_%201986.pdf
61. Nelson and Schunn (2009): The nature of feedback, Instructional Science 37. https://link.springer.com/article/10.1007/s11251-008-9053-x
62. Yang and Schunn (2026): Beyond small gains, Instructional Science 54:59. https://peerceptiv.com/wp-content/uploads/2026/07/Yang-Schunn-2026-Instructional-Science.pdf
63. SWE-agent: Agent-computer interfaces enable automated software engineering (arXiv 2405.15793). https://arxiv.org/html/2405.15793
64. aider: Unified diffs make GPT-4 Turbo 3X less lazy. https://aider.chat/2023/12/21/unified-diffs.html
65. Claude Code docs: Tools reference. https://code.claude.com/docs/en/tools-reference
66. GitHub REST API: Pull request review comments. https://docs.github.com/en/rest/pulls/comments
67. GitHub Community discussion #23138: Review comments not shown if a commit affects the comment's line. https://github.com/orgs/community/discussions/23138

Removed with the dropped claim: W3C WAI Understanding SC 1.4.13, Understanding SC 2.1.1, WebAIM "Invisible content just for screen reader users", WebAIM "Decoding label and name". Sources 60 to 67 were renumbered accordingly.

Verification of this part: 2 confirmed, 5 contested, 1 dropped.

## Question 5: the chat experience, a polished serif register that stays clean

**Verdict**

1. Keep the shape the chat already has: unboxed serif replies, one tinted right-aligned bubble for the person, no visible author labels. ChatGPT and Perplexity do exactly this on their live pages. claude.ai's stylesheet does the same, but its alignment and labels were read from CSS only.
2. Fix the type inside that shape: the reply is one step too small and its column too wide, headings inside replies are browser defaults in the wrong face, and a `###` heading paints at 12px because a label rule leaks into Markdown.
3. Give the chat the manuscript's prose vocabulary one size step down (Source Serif 4 at 16px / 1.62 on about 36rem), so the two columns read as one desk: same serif, same code, same tables, same links. The print-size evidence would accept 17px just as well; it does not pick between them.

Where the numbers come from: every size below was read from the CSS cascade and then confirmed as a computed style in headless Chrome, against a fixture that reproduces the chat DOM and links the real `app.css` with the vendored fonts loaded (pane 720px wide, manuscript container 800px, viewport 1440x900). The fixture and its computed-style dump were kept outside the repository. "UA" below means the browser's default stylesheet applies because glosa has no rule. Source numbers in square brackets point at the list at the end of this section.

Line numbers: `packages/spa/src/app.css` references are to main at 8ed3767 (v0.1.0-alpha.36), remapped from the 6a77f15 lines the audit read (every line after the print block moved by 136).

Two glossed terms used throughout: **measure** is line length in characters; **leading** is line spacing, written here as a multiplier of the font size.

### 5.1 What glosa's chat ships today

Table 5.1a: the transcript, the surfaces a reader actually reads. Line numbers are in `packages/spa/src/app.css` unless a file is named.

| Element | Face | Size / leading | Weight | Colour | Boxed? | Max width | Where |
|---|---|---|---|---|---|---|---|
| Pane base `.glosa-chat-pane` | Source Sans 3 | 15 / 1.5 | 400 | --ink on --bg | no | pane | 6540-6546 |
| Empty state "What would you like to work on?" | Source Serif 4 | clamp(21, 4cqw, 28) / 1.3 | 400 | --ink | no | 32rem | 7372-7376; chat-pane.js:95 |
| Assistant reply body (Markdown paragraphs) | Source Serif 4 | 15 / 1.7 | 400 | --ink | no | 46rem = 736px (633px painted in a 720px pane) | 7384-7388, 7428-7433; chat-pane.js:846-857 |
| Assistant reply before the renderer resolves, or non-Markdown | Source Serif 4 | 15 / 1.7, pre-wrap | 400 | --ink | no | 46rem | 7428-7433; chat-pane.js:806-812 |
| Reply h1 / h2 / h4 | Source Sans 3 | 30 / 22.5 / 15 (UA 2em, 1.5em, 1em), leading 1.7 inherited | 700 (UA) | --ink | no | column | 7457-7461 |
| Reply h3 | Source Sans 3 | 12 / 1.5 (label rule leaks in) | 600 | --ink | no | column | 7389-7394 and 7457-7461 |
| Reply h5 / h6 (not in any selector) | Source Serif 4 (inherited) | 12.45 / 10.05 (UA) | 700 (UA) | --ink | no | column | no rule |
| Reply strong / em | Source Serif 4 | 15 / 1.7 | 700 (UA) / italic | --ink | no | inline | no rule |
| Reply inline code | generic `monospace` (UA), not --font-mono | 15 / 1.7 | 400 | --ink | no bed | inline | no rule |
| Reply link | Source Serif 4 | 15 / 1.7 | 400 | browser default: rgb(0,0,238) light, rgb(158,158,255) dark (UA), underlined | no | inline | no rule; chat-markdown.js:7-15 |
| Reply list / list item | Source Serif 4 | 15 / 1.7 | 400 | --ink, markers --ink | UA padding-left 40px | column | 7454-7456 |
| Reply blockquote | Source Serif 4 | 15 / 1.7, upright | 400 | --ink | UA margin-inline 40px, no rule | column | 7454-7456 |
| Reply code block `pre` | ui-monospace on `pre`; a verification render found the inner `code` resolves to generic monospace (Menlo), because the browser's `code` rule overrides the inherited stack | 12 / 1.6 | 400 | --ink | --surface-sunken bed, radius 5, padding 12 | 100% | 7445-7453 |
| Reply table | Source Serif 4 | 15 / 1.7 | th 700 (UA) | --ink | UA: 1px cell padding, no rules, no overflow handling | column | no rule |
| Reply hr | n/a | 1px | n/a | grey inset (UA) | full width | column | no rule |
| Block gap inside a reply (p, ul, ol, pre, blockquote) | n/a | margin-block 0.6rem = 9.6px | n/a | n/a | n/a | n/a | 7454-7456 |
| Human message | Source Sans 3 | 15 / 1.6, pre-wrap, never Markdown | 400 | --ink | --surface bubble, radius 14, padding 12 16, right edge aligned to the reply column | min(80%, 36rem = 576px), fit-content | 7398-7410; chat-pane.js:838 |
| Message label (h3 / summary) | Source Sans 3 | 12 / 1.5 | 600 | --muted | no | column | 7389-7394; hidden on human and assistant rows |
| Detail row summary ("Model and effort", tool name · status, "Reasoning summary", "Usage & limits") | Source Sans 3 | 12 / 1.5 | 400 | --muted | no | column | 7414-7416; chat-pane.js:842, 850-853 |
| Detail row body | ui-monospace | 12 / 1.6, pre-wrap | 400 | --ink | --surface bed, radius 5, padding 10 12 | column | 7417-7422 |
| Error row "Needs attention" | Source Sans 3 label over Source Serif 4 text | 12 / 1.5 over 15 / 1.7 | 600 / 400 | --muted / --ink | 1px --border-strong, radius 6, padding 12 | 46rem | 7423-7427 |
| Copy button glyph | Source Sans 3 | 17 / 1 | 400 | --muted | 28x28 box, opacity 0 until hover | n/a | 7977-8000, 8115-8133 |
| Decision card (agent question, approval) | Source Sans 3 | 15 / 1.5; title h3 15 / 1.5 700 (UA); detail pre mono 12 / 1.5 | 400 | --ink | --surface card, 1px --border-strong, radius 8, padding 16 | 48rem | 7820-7880; chat-pane.js:922-1028 |
| Truncation note "Display shortened. Export the chat for the complete message." | Source Serif 4 | 15 / 1.7 | 400 | --ink | no | column | chat-markdown.js:17-18; chat-pane.js:854 |

Table 5.1b: the composer and controls, top to bottom, at a 720px pane.

| Position | What the reader sees | Measured style | Where |
|---|---|---|---|
| Above the composer, only when the account cannot send | Readiness sentence with "Load models" or "Manage account" | 12 / 1.5 sans --muted; buttons 13px kit | 7749-7763; chat-pane.js:98-117 |
| Composer frame | One rounded field on --surface, 1px --border-strong, --ink when focused | radius 14, padding 4, width min(100% - 40px, 48rem) = 680px here | 7462-7478 |
| Draft field | Placeholder "What would you like to work on?", grows from 3 rows to 25vh | Source Sans 3 15 / 1.55, padding 12 13, caret --hand | 7479-7493, 7926-7929 |
| Attachment chips | "name ×" pills | 12px sans, 1px --border, radius 6, 32px tall | 7738-7748 |
| Queue notice | "A message is waiting. Model and effort changes apply after it." | 13 / 1.5 --muted, no inline padding, 4px from the frame edge while the draft sits at 17px | 7266-7271 |
| Bottom row, left | "+" attach glyph, borderless | 23px in a 28x28 box, --muted | 7718-7724 |
| Bottom row | Model picker trigger: icon, model name, chevron | 13 / 1.4 --muted, 30px tall, no border | 7506-7537 |
| Bottom row | Effort select: four bars, label, chevron; tooltip on hover | 13 / 1.4 --muted, 30px tall; tooltip 13 / 1.4 on --surface, max 16rem | 7668-7703, 8087-8114 |
| Bottom row, right | Stop (while working), Send as a filled ink circle with "↑" | Stop: 13px kit; Send: 15px 600 --bg on --ink, 32x32, radius 16 | 6567-6576, 7728-7737 |
| Below the composer | "Tools & workspace access" disclosure; "Send feedback · N" | 12px --muted summary; 12px --ink button | 7778-7813 |
| Footer | Status line and "Enter to send · Shift Enter for a new line" | 12 / 1.5 --muted; hint hidden under 440px | 7764-7777, 7906-7908 |
| Under 440px | Header inset 12px, composer 24px narrower, effort capped at 145px | n/a | 7886-7918 |

Table 5.1c: what the audit found wrong, named by class. A **bug** is visible to readers now; a **design gap** is a missing decision; a **design flaw in the record** is a design document that contradicts itself; **tech debt** is a duplicated value nothing guards.

| Finding | Class | Effect on a reader | Where |
|---|---|---|---|
| A `###` heading inside a reply paints at 12px 600 sans, smaller than the 15px body next to it and smaller than a `####` (15px 700). The label rule `.glosa-chat-message h3, .glosa-chat-message summary` matches Markdown h3s because the Markdown sits inside the message article. The Markdown heading rule has equal specificity, (0,1,1), and overrides only family, colour and margin. Confirmed in a browser render | Bug | A sub-heading looks like a footnote | app.css:7389-7394, 7457-7461 |
| Links inside replies have no rule, so they take the browser's default link colour: rgb(0,0,238) in light (9.1:1) and, because the dark theme sets `color-scheme: dark`, rgb(158,158,255) in dark (7.5:1), re-measured in Chrome 154 and WebKit | Design flaw | Off-system browser blue whose hue sits near the session's blue-black ink. Not a contrast failure: an earlier fixture that did not apply `color-scheme: dark` measured 1.4:1, and that figure was withdrawn | app.css:7442-7461; tokens at 208 |
| Reply headings are browser sizes in Source Sans 3: h1 30px 700, h2 22.5px, h4 15px bold, all at 1.7 leading; h5 and h6 are unstyled serif at 12.45px and 10.05px | Design gap | A reply's h1 outranks every manuscript heading; an h4 is bold body text | app.css:7457-7461 |
| Inline code, strong, blockquote, list padding and markers, hr, tables all fall through to browser defaults | Design gap | Replies with structure look unstyled beside the manuscript | app.css:7442-7461 vs 2712-2838 |
| The human's words are sans in the bubble (15 / 1.6) and the draft (15 / 1.55), while the same person's margin notes are serif (15 / 1.45). DESIGN.md contradicts itself here. The Serif Is Writing Rule (:295) says serif. The Body role (:285, "the conversation") and the Conversation Pane section (:412, "right-aligned human bubbles (sans...)") call for exactly the sans that ships. The rule was written on 2026-09-16, before the chat (Conversation Pane added 2026-09-24), and its listed cases are margin notes. The shipped reply size matches neither Note (serif 15 / 1.45) nor Body (sans 15 / 1.6) | Design flaw in the record (the code follows :285 and :412; the conflict is inside DESIGN.md, not drift) | Two faces for one author on one desk | DESIGN.md:283, 285, 295, 412; app.css:7409, 7431, 7488 |
| Reply column 46rem = 736px = 93.6ch of Source Serif 4 at 15px; composer, footer and readiness rows 48rem, wider than the replies at every width | Design gap | About 104 to 108 characters per line, over Butterick's 90 and Bringhurst's 75 (WCAG 1.4.8 does not cap a resizable column; see table 5.3a row 3); the input is wider than what it produces | app.css:7385, 7403, 7466 |
| Radii 5 / 6 / 8 / 12 / 14 / 16px as literals, block gap 0.6rem literal beside the manuscript's --prose-gap, `box-shadow: 0 3px 8px #0002` beside --shadow-menu, `#161616` on the terminal, `color: var(--ink)` re-declared on headings that inherit it | Tech debt | None today; drifts silently | app.css:7276, 7279, 7421, 7426, 7451, 7455, 7459-7460, 7472, 7487, 7549-7550, 7733, 7808, 7830 |
| Manuscript defect found in passing: code inside a manuscript code block renders at 11.05px because `.glosa-content code { font-size: 0.85em }` also hits the `<code>` inside `<pre>` (13 x 0.85) and `.glosa-content pre code` does not reset font-size; DESIGN.md says 13px | Bug (manuscript) | Code blocks are smaller than the record says | app.css:2768-2792; DESIGN.md:290 |
| In-history action rows ("Continue held message" and friends) have no 46rem cap or auto margins, so they sit at the history's left edge while every message is centred | Layout nit | Misaligned buttons | app.css:7347-7352; chat-pane.js:864-877 |
| A truncated streamed reply can carry "Display shortened…" twice: once from the renderer as a `<p>`, once from the pane as plain text | Nit | Duplicate sentence | chat-pane.js:798-812, 854; chat-markdown.js:17-18 |
| Six leadings in one pane: 1.7 reply, 1.6 bubble and detail body, 1.55 draft, 1.5 base and labels, 1.4 buttons and selects; the note beside it is 1.45 and the manuscript 1.62 | Note | Uneven rhythm | app.css:7431, 7409, 7418, 7488, 6544, 7391, 6557 |
| Correction to the study brief: no `:root[data-theme="dark"]` rule names a chat selector; the overrides at app.css:5119-5121 target `.glosa-composer` (the margin composer) and `.glosa-ask-layer .glosa-agent-card`. The chat pane is themed through tokens only, which is the good case | Note | None | app.css:206-238, 5119-5121 |

### 5.2 Catalogue: how assistant chat interfaces set text

Read 2026-09-27. "live" means computed styles from a logged-out session at 1440x900; "CSS" means the product's served stylesheet; "doc" means vendor documentation; "gap" means behind a login and not observed.

| Product | Reply face | Reply size / leading | Column measure | Reply boxed? | Human turn | Markdown inside replies | Labels / avatars | Dark | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| claude.ai and Claude Desktop (Desktop 2.9939.2 loads claude.ai in its app bundle) | Anthropic Serif (`anthropic-serif`, variable 300..800, roman and italic) by default via `--font-claude-response`. A "Chat font" setting switches replies to Anthropic Sans, System, Atkinson Hyperlegible or OpenDyslexic; Claude Code transcripts use the sans. Anthropic Sans for UI and the user's text; Anthropic Mono for code | Prose tokens 16 / 24 at comfortable density, 14 / 20 at base density. `.font-claude-response-body` is 1rem / 1.5, which Anthropic's own code comment calls "Anthropic Serif 16 / 400 / 1.5". The message wrapper declares 1.65rem leading. The live rendered value was not measured. A "Transcript text size" setting (Small / Medium / Large, `data-text-size=sm\|lg`) scales both turns together: 15 or 18px at comfortable density. Weights 400 / 500 / 580 / 600 | `.max-w-prose` 65ch; containers 36 / 42 / 48rem; one context caps replies at 36rem; live width not verified | No (text insets only) | Rounded bubble, at most 85% wide, tinted with `--cds-bg-user-message` (a 5% neutral alpha: rgba(11,11,11,.05), white at 5% in dark), set in the sans (`--font-user-message: var(--font-ui)`); alignment not verified | Headings in the reply's own face (serif by default) at 600. The `.prose` scale is h1 1.75em, h2 1.375em, h3 1.125em, h4 1em, leading 1.25 to 1.3, but every level is shifted down one (`headingLevelOffset` 1), so `#` renders at 1.375em, `##` at 1.125em and `###` at 1em. No fixed opsz: the opsz 20 / 28 classes are not applied to reply headings, which get automatic optical sizing. pre .875em / 1.625 on bg-neutral; inline code .9em; tables 100% with 1px separate borders and radius | Not visible in CSS (gap) | `[data-mode=dark]`; text #f0efec, secondary #c3c2b7 (warm); reply weight drops to wght 360 in dark, headings to 560 | [2] CSS; [84] JS read during verification |
| ChatGPT web (logged out) | System stack (`-apple-system-body, ui-sans-serif, system-ui, Segoe UI, Helvetica`); no web font; OpenAI Sans is brand only | Reply paragraphs and list items 16 / 26 (1.625rem); 16 / 24 is the turn wrapper and the user bubble | 640px (40rem) centred column at 1440px | No | Right-aligned bubble rgb(232,232,232) light / #414141 dark, radius 22, padding 10 16, max 70% (448px), same sans at 16 / 24 | h2 20 / 28 600 in the same sans; pre monospace 16 / 20 in a 16px-radius box with a header strip; tables 14 / 24 with rgba(0,0,0,.05) rules | h4 "You said:" / "ChatGPT said:" hidden with the screen-reader-only pattern (1x1px, clip-path inset(50%)), localised in other UI languages; no avatars | #000 / #fff (light #fcfcfc / #0d0d0d) | [7] live (logged-out build only), [8] CSS |
| Gemini web | Google Sans Flex (variable) body; Google Sans Code for code | body-l 1rem / 1.5rem (17 / 24 in the variable context) | gap | gap | gap | blockquote in Google Sans Code italic; inline code as a pill; rest gap | gap | light #fdfcfc / #000; dark #000, surface #1c1c1c, text #e6e6e6 | [13] CSS in app HTML, [14] [15] doc |
| Perplexity web (logged out) | Perplexity Serif by Grilli Type (`pplxSerif`, opsz axis) for answers, default `data-answer-font=serif`, user-switchable to Perplexity Sans; Perplexity Mono for code | 16 / 26, weight 435, opsz 12; long articles 18 / 1.6 | `--thread-content-width` 720px; `.prose` 65ch = 669px. Contested: the 65ch cap is inert because the answer `.prose` is `display: inline`, so paragraphs run the full 720px, about 86 to 97 characters | No | Left-aligned tinted block rgba(39,26,0,.035), radius 16, padding 16 12, max 600px, sans 16 / 24. Contested: the live DOM shows the block right-aligned in the column (`justify-end`, padding 12 16), which is the pattern glosa already ships | h2 serif 18 / 28 weight 635, 16px above 8px below; ul padding 32; pre mono 14 / 20 radius 4; tables switch to sans 14 / 20 with separate borders, radius 8, th 640 on a 3.5% tint | "Answer" tab; no author label; no avatars | body #171615, text #d6d5d4 (light #fdfbfa / #27251e); serif weight drops to 370 in dark | [3] live, [4] CSS, [5] brand doc |
| Microsoft Copilot (consumer web) | Ginto (variable) UI and body; GintoNord display; Georgia Pro only for `.font-health-serif`; Cascadia Code mono | 16 / 26 | gap (sign-in wall) | gap | gap | gap | gap | light warm paper #f8f4f1 / ink #272320; dark not observable | [12] CSS, live shell |
| Mistral Le Chat (now titled "Vibe Chat", logged out) | Inter (variable) renders; ALT Mistral declared; JetBrainsMono Nerd Font Mono for code | 16 / 24; `html { font-size: calc(16px * var(--font-scale,1)) }` size setting | gap | gap | gap | h1 1.5em, h2 1.25em, h3 1.125em, h4 1em; h2..h6 24px above 16px below, 600, leading 1.5; inline code 85%; pre radius .375rem; table .875em / 1.71 | gap | gap | [9] CSS |
| Notion AI | Notion page faces Default / Serif / Mono; AI panel typography not documented | gap | gap | gap | gap | gap | gap | gap | [26] [27] doc only |
| Cursor chat pane | VS Code-based; markdown root `.anysphere-markdown-container-root`; workbench font | No native chat font setting until 2026; a "Text Size" setting (Cursor 3.5.33) scales only AI responses | pane width | No | VS Code request bubble (inherited) | VS Code renderer | VS Code header | editor theme | [16] [17] community |
| GitHub Copilot Chat (VS Code) | `var(--vscode-chat-font-family, inherit)` = workbench font | `chat.fontSize` default 13; `.rendered-markdown { line-height: 1.5em }`; code blocks `chat.editor.fontSize` 14 | pane width | No | Request in a bubble: `chat-requestBubbleBackground`, radius medium, padding 8 12, max-width 90%, margin-left auto | h1 body-xxl, h2 body-xl, h3 body-l semibold, margin 1.5em 0 .875em, same family as the body; tables with separate borders and radius; blockquote 5px left border | 24px avatar plus username at heading3 semibold | any VS Code theme | [10] CSS, [11] doc |
| Windsurf (Cascade; docs now Devin Desktop) | gap | gap | gap | gap | gap | gap | gap | gap | [28] [29] doc index only |
| iMessage (bubble baseline) | SF Pro; New York is the serif family designed to work alongside SF | iOS Body 17pt / 22pt; macOS Body 13 / 16 | device width | n/a | Sent in blue (iMessage) or green (SMS, RCS) bubbles; received-bubble colour and alignment not documented by Apple | none | contact name in the header | system dark | [21] standard, [22] doc |
| Slack (bubble baseline) | Lato ("Slack-Lato") | 15 / 22, 400 (community tokens; no vendor page states it) | pane width | No (flat, left-aligned) | same as any message | Slack formatting only | avatar, name, timestamp | dark mode preference | [23] [25] community, [24] doc |

Not catalogued at the typography level: Notion AI (stylesheet behind login), Windsurf (docs redirect to Devin Desktop with no appearance page), Claude Code's terminal rendering (outside the lane's list). claude.ai's live thread width, user-turn alignment and label visibility come from CSS tokens only, because the app is behind login.

Table 5.2b: conventions most of the catalogued products share, and where glosa stands.

| Convention | Products that follow it | Exceptions | glosa today | Delta |
|---|---|---|---|---|
| Reply body 16px with 24 to 26px leading (1.5 to 1.625) | claude.ai (prose tokens at comfortable density; 14 / 20 at base density), ChatGPT (16 / 26), Perplexity (16 / 26), Le Chat, Copilot, Gemini (16 to 17px) | VS Code and Cursor panes at 13px | 15 / 1.7 serif | one step small; leading looser than every peer measured live (1.625); claude.ai's wrapper declares 1.65rem, not measured live |
| Reply unboxed; human turn tinted or bubbled | all with an observable layout (claude.ai, ChatGPT, Perplexity, VS Code) | none | unboxed reply, right bubble | matches |
| Human turn in the sans UI face even when replies are serif | claude.ai, Perplexity, VS Code | none | Source Sans 3 bubble | matches the peers and DESIGN.md:285 and :412; conflicts with the Serif Is Writing Rule at DESIGN.md:295 (see 5.5, choice 1) |
| Author labels hidden or absent in consumer chat; avatar and name only in IDE chat | ChatGPT (hidden h4), Perplexity, claude.ai | VS Code, Slack | hidden, semantic names kept | matches |
| Headings inside replies in the reply's own face, weight 600, largest reachable heading about 1.25 to 1.375em, tight margins | claude.ai (serif, every level shifted down one, automatic optical sizing), Perplexity (serif, h2 18 / 28 at 635), ChatGPT (its sans, h2 20 / 28 at 600), VS Code (one family); Le Chat sizes from CSS, family not checked | none observed; Copilot, Gemini, Notion and Windsurf could not be observed; Anthropic's design system offers a sans-heading option that claude.ai does not use | Source Sans 3 headings at browser sizes inside serif replies | diverges |
| Column about 60 to 65ch, narrower than a document page | ChatGPT 640px (about 75 to 80 sans characters), claude.ai 65ch utility and 36rem cap (CSS only), Perplexity 65ch. Contested: Perplexity's cap is inert (`display: inline`), so its paragraphs run the 720px column, about 86 to 97 characters | IDE panes (pane width) | 46rem = 736px | wide end |
| Code blocks and tables one step below the body (13 to 14px at 16px prose); code in a rounded bed | claude.ai, Perplexity, VS Code, Le Chat | ChatGPT keeps code at 16px | code 12px | code too small. Contested: those ratios are set against sans bodies; by x-height glosa's 12px Menlo block is about 0.92 of the 15px serif, at or above GitHub (0.88) and Tailwind (0.906) |
| A reply size step or face switch for the person | claude.ai ("Transcript text size", which scales both turns together; "Chat font" switch with dyslexia faces), Perplexity (serif / sans), Le Chat (font-scale), VS Code (chat.fontSize), Cursor (Text Size) | ChatGPT (system zoom only) | none | missing (belongs with Question 3) |
| Dark mode keeps warm neutrals in reading products | claude.ai (#f0efec text), Perplexity (#171615 ground), Copilot (warm light palette); claude.ai and Perplexity also lighten the serif weight in dark (360, 370) | ChatGPT and Gemini pure black | warm dark tokens; no weight change in dark | matches on colour |
| Brand face and product face may differ; the product face is what counts | ChatGPT (system stack, not OpenAI Sans), Le Chat (Inter, not ALT Mistral) | claude.ai, Perplexity, Copilot use their brand families in product | vendored Source Serif 4 and Source Sans 3 | fine |

### 5.3 Evidence: what makes conversational text readable

Context column: "long-form" is evidence about reading prose for a long stretch, which is glosa's case; "general UI" is evidence about interface text; "messaging" is evidence about bubbles and speakers.

Table 5.3a: measure and size.

| # | Topic | Evidence | Source | Context | Strength |
|---|---|---|---|---|---|
| 1 | Measure | 45 to 90 characters including spaces, two to three alphabets; "insufficient attention to line length" is the common web flaw | Butterick [42] | long-form | practitioner, strong |
| 2 | Measure | 45 to 75 satisfactory for a single-column page in a serif text face, 66 ideal; 40 to 50 for multi-column work, which fits a secondary column beside the manuscript | Bringhurst via Rutter [49] | long-form | practitioner, strong |
| 3 | Measure | Line width no more than 80 characters; leading at least 1.5; paragraph spacing at least 1.5 x leading. Contested: 1.4.8 asks only that a mechanism, which may be the browser, can reach these values, so a fluid, resizable column meets the width item and need not default to 80 | WCAG 2.2 SC 1.4.8 (AAA) [30] | general UI | standard, AAA only |
| 4 | Measure | prose max-width 65ch at 16px / 1.75 | Tailwind Typography [69] | long-form web | product-doc |
| 5 | Measure | 48rem (768px) and 42rem are layout container steps, not measures derived from type size | Tailwind max-width [70] | general UI | product-doc |
| 6 | Measure | Source Serif 4 mean prose advance 0.454em (x-height 0.475em at the default opsz 20, alphabet 13.27em); 46rem at 15px = 108 characters, 3.7 alphabets; at 18px = 90 | vendored font read with fontTools [80]; app.css [75] | glosa | computed, strong |
| 7 | Size | Web body text 15 to 25px, fine-tuned per font | Butterick [43] | long-form | practitioner |
| 8 | Size | Consensus critical print size about 0.2 degrees of x-height, below which reading speed on sustained text falls; individual thresholds run 0.14 to 0.24. At the paper's 40 cm, books average 0.24, newspaper running text 0.23, online news article text 0.21 (above the critical size) and online home-page link text 0.19 | Legge and Bigelow 2011 [38] [39] | long-form | peer-reviewed, strong |
| 9 | Size | 16px Georgia as the desktop benchmark; 140% leading | iA [52] | long-form | practitioner |
| 10 | Size | macOS Body 13 / 16, Title 3 15 / 20, Title 2 17 / 22; minimum 10pt; minimise typefaces; New York designed alongside SF | Apple HIG [21] | general UI | standard |
| 11 | Size | body-large 16 / 24, body-medium 14 / 20, body-small 12 / 16 | Material 3 tokens [37] | general UI | standard |
| 12 | Size | Reading speed differs by up to 35% between a reader's fastest and slowest font; "one font does not fit all" | Wallace et al. 2022 [40] | long-form | peer-reviewed, strong |

Table 5.3b: characters per line in glosa's columns, computed from the vendored fonts (mean prose advance: serif 0.454em, sans 0.401em). The audit's fixture measured the same 736px column as 93.6ch, about 104 average lowercase characters; the two methods bracket the truth and both land over Butterick's and Bringhurst's ceilings.

| Column | Text width | Face and size | Chars per line | Alphabets | Against Butterick 45 to 90 / Bringhurst 45 to 75 / WCAG AAA 80 |
|---|---|---|---|---|---|
| Reply, 46rem | 736px | Source Serif 4, 15px (shipped) | 108 | 3.7 | over all three |
| Reply, 46rem | 736px | Source Serif 4, 16px | 101 | 3.5 | over all three |
| Reply, 46rem | 736px | Source Serif 4, 17px | 95 | 3.3 | over all three |
| Reply, 46rem | 736px | Source Serif 4, 18px | 90 | 3.1 | at Butterick's ceiling |
| Reply as painted in a 720px pane | 633px | Source Serif 4, 15px | about 89 | 3.0 | at Butterick's ceiling, over the other two |
| Human bubble, max 36rem minus 32px padding | 544px | Source Sans 3, 15px (shipped) | 90 | 3.1 | at Butterick's ceiling |
| Composer, 48rem | 768px | Source Sans 3, 15px | 128 | 4.4 | over all three |
| Manuscript, 68ch as measured | 624px | Source Serif 4, 18px | about 76 | 2.6 | inside Butterick, at Bringhurst's top |
| Width for 66 characters | 450 / 480 / 510px | serif 15 / 16 / 17px | 66 | 2.3 | Bringhurst's ideal |
| Width for 75 characters | 511 / 545 / 579px | serif 15 / 16 / 17px | 75 | 2.6 | matches the manuscript |
| Width for 90 characters | 613 / 654 / 694px | serif 15 / 16 / 17px | 90 | 3.1 | Butterick's ceiling |

The WCAG column is contested: 1.4.8 is met by a resizable column, so exceeding 80 characters by default is not a WCAG failure; the measure question is settled by Butterick and Bringhurst.

Table 5.3c: angular x-height of Source Serif 4 against Legge and Bigelow's critical print size of about 0.2 degrees. The x-height is 0.475em at the default opsz 20; with `font-optical-sizing: auto`, which glosa uses, it renders at 0.489 / 0.486 / 0.483 / 0.4805em at 15 / 16 / 17 / 18px, and those values are used below. Plain reading: on a laptop at 50 cm, 15px of this serif sits below the critical size; 16 and 17px narrow the gap without closing it; only about 18px, the manuscript's size, reaches it. At the paper's 40 cm, or on a 4K external monitor, 15px already sits at or above 0.2. This is a soft argument for a larger reply, not a line that 16px clears.

| Display and distance | CSS px to mm | 15px | 16px | 17px | 18px | 20px |
|---|---|---|---|---|---|---|
| MacBook Pro at 2x, 50cm | 0.200mm | 0.168 | 0.178 | 0.188 | 0.198 | 0.218 |
| MacBook Pro at 2x, 40cm (the paper's distance) | 0.200mm | 0.210 | 0.223 | 0.235 | 0.248 | 0.272 |
| 27-inch 5K at 2x, 65cm | 0.233mm | 0.151 | 0.160 | 0.169 | 0.178 | 0.195 |
| 27-inch 4K at 2x, 65cm | 0.312mm | 0.202 | 0.214 | 0.226 | 0.238 | 0.261 |
| Equivalent size of a 0.52 x-height screen sans | | 14.1px | 15.0px | 15.8px | 16.6px | 18.3px |

Table 5.3d: serif on screen, rendering, leading.

| # | Topic | Evidence | Source | Context | Strength |
|---|---|---|---|---|---|
| 13 | Serif on screen | Serifs make negligible difference; no screen difference in Bernard 2001, Boyarski 1998, Tullis 1995; x-height, counters and spacing matter more | Poole review [55] | long-form (screen) | practitioner review, medium |
| 14 | Serif on screen | Fonts differing only in serifs: no legibility difference, no reading-speed effect | Arditi and Cho 2005 [41] | long-form | peer-reviewed, strong |
| 15 | Rendering | Apple devices do not use TrueType hinting | Glyphs [66] | general UI | vendor-doc, strong |
| 16 | Rendering | Mac OS X ignores hinting; Windows ClearType and DirectWrite differ | Smashing Magazine 2012 [56] | general UI | practitioner, dated |
| 17 | Rendering | With high-resolution screens, "use whatever font you'd prefer on the printed page" | Butterick [48] | long-form | practitioner |
| 18 | Rendering | Vendored Source Serif 4: opsz (optical size axis) 8 to 60, default 20, named cuts at 14, 16, 17, 18, 20pt; x-height 0.475em at opsz 20, 0.483 to 0.489em at 15 to 17px under optical sizing auto | vendored font [80]; Google Fonts METADATA [68] (axes only) | glosa | product-doc, strong |
| 19 | Rendering | `font-optical-sizing: auto` picks opsz from the CSS px size; small sizes get thicker strokes and larger serifs | MDN [62] | general UI | vendor-doc |
| 20 | Leading | 120% to 145% of the point size "for most text"; a print-derived ceiling below the 1.5 that MDN and WCAG 1.4.8 name, so not a target for screen prose | Butterick [44] | long-form | practitioner |
| 21 | Leading | Unitless; web text benefits from more; 1.3 and up common; one rhythmical unit | Rutter 2.2.1 (Bringhurst) [50] | long-form | practitioner |
| 22 | Leading | Minimum 1.5 for main paragraph content; unitless preferred | MDN line-height [61] | general UI | vendor-doc |
| 23 | Leading | Content must survive a user-imposed 1.5 line height and 2x paragraph spacing. Contested: the override is spacing after paragraphs of 2x the font size (30px at 15px), applied together with letter spacing 0.12em and word spacing 0.16em | WCAG 2.2 SC 1.4.12 (AA) [34] | general UI | standard |
| 24 | Mixed fonts | A line box grows to contain all its children; a mono span in serif prose enlarges its line | De Oliveira [60] | general UI | practitioner |
| 25 | Mixed fonts | `font-size-adjust` matches x-heights across faces; Baseline 2024 | MDN [63] | general UI | vendor-doc |

Table 5.3e: headings, code and tables, bubbles, speakers, streaming, pairing.

| # | Topic | Evidence | Source | Context | Strength |
|---|---|---|---|---|---|
| 26 | Headings | Only slightly larger, by the smallest visible step; bold, not italic; at most three levels, two better | Butterick [45] | long-form | practitioner |
| 27 | Headings | Any two identifiable fonts may be mixed when each has a consistent role; change at paragraph breaks; same-designer pairs are reliable | Butterick [46] | long-form | practitioner |
| 28 | Headings | Headings are entry points when scanning; a contrasting face distinguishes them | MediaWiki Typography refresh [72] | long-form (reference) | product-doc |
| 29 | Headings | 79% of users scan; subheadings, lists and bold keywords counter the F-pattern | NN/g [53] [54] | general web reading | practitioner research |
| 30 | Code and tables | code 85% of body; pre 85% / 1.45 with overflow auto; tables display block, max-width 100%, overflow auto, 1px cell borders | GitHub Markdown CSS [71] | technical docs, sans body | product-doc |
| 31 | Code and tables | code 0.875em; pre 0.875em / 1.714 with overflow-x auto; tables 0.875em / 1.714, ruled, no overflow container | Tailwind Typography [69] | long-form web, sans body | product-doc |
| 32 | Code | Monospaced fonts are harder to read and wider; code only | Butterick [47] | long-form | practitioner |
| 33 | Bubbles | The speech balloon exists to attribute words to a character | Wikipedia [73] | messaging (origin) | community |
| 34 | Bubbles | iChat (2002) used speech bubbles and pictures to personify chatting | Wikipedia [74] | messaging | community |
| 35 | Speakers | Relationships conveyed by presentation must be programmatic or in text | WCAG 2.2 SC 1.3.1 (A) [31] | general UI | standard |
| 36 | Speakers | Colour must never be the only visual means of distinguishing an element | WCAG 2.2 SC 1.4.1 (A) [32] | general UI | standard |
| 37 | Speakers | Boundaries are not required when other cues identify the item; decorative backgrounds are exempt | WCAG 2.2 SC 1.4.11 (AA) [33] | general UI | standard |
| 38 | Speakers | The log role is named for chat logs; implicit aria-live polite | WAI-ARIA 1.2 [35] | messaging and assistant chat | standard |
| 39 | Speakers | Each article labelled by a distinguishing element; aria-posinset and aria-setsize. Contested: the pattern is for auto-loading article lists with a Page Up / Page Down keyboard contract and never mentions chat, while ARIA 1.2 names chat logs under role=log (row 38) | ARIA APG feed pattern [36] | messaging and assistant chat | standard (pattern) |
| 40 | Speakers | Hidden text is for what sighted users see; what people see and hear should agree | WebAIM [57] | general UI | practitioner |
| 41 | Streaming | A live region announces once; aria-busy batches changes into one announcement; chat is a log but need not be live unless it is the primary surface | Soueidan [58] [59] | messaging and assistant chat | practitioner |
| 42 | Streaming | `text-wrap: pretty`: Chromium adjusts only the last four lines, WebKit the whole paragraph; both call it safe for body text | WebKit and Chrome blogs [64] [65] | general UI | vendor-doc |
| 43 | Pairing | Source Serif 4 was "designed to complement the Source Sans 3 family"; each works alone or together | Google Fonts description [67] | general UI | vendor-doc |
| 44 | Pairing | A modest set of distinct, related intervals | Bringhurst via Rutter 3.1.1 [51] | long-form | practitioner |

Table 5.3f: one-step size and leading ladders in shipped systems, and the two pairing options for glosa.

| System | Small | Base | Large | Note |
|---|---|---|---|---|
| Tailwind Typography [69] | 14 / 1.714 | 16 / 1.75 | 18 / 1.778 | prose-sm, prose, prose-lg; 65ch measure |
| Material 3 [37] | body-medium 14 / 20 | body-large 16 / 24 | title-large 22 / 28 | sp = px at 1x |
| Apple macOS [21] | Body 13 / 16 | Title 3 15 / 20 | Title 2 17 / 22 | UI sizes; minimum 10pt |
| glosa today | notes 15 / 1.45 serif | chat reply 15 / 1.7 serif | manuscript 18 / 1.62 serif | chat is two steps under the manuscript; human turn 15 / 1.6 sans |
| Option A (recommended) | notes 15 / 1.45 | chat 16 / 1.62 serif, paragraphs capped near 36rem | manuscript 18 / 1.62 | a perceptible one-step drop; angular x-height 0.178 degrees on a laptop at 50 cm, still under 0.2 |
| Option B | notes 15 / 1.45 | chat 17 / 1.62 serif on the existing --text-md token, paragraphs capped near 36rem | manuscript 18 / 1.62 | reuses a token; 0.188 degrees, closer to 0.2; nearly indistinguishable from 18 |

### 5.4 Inconsistencies between the chat and the manuscript

Table 5.4a: element by element. `.glosa-content` is the manuscript; `.glosa-chat-markdown` is a rendered reply. Line numbers are in `packages/spa/src/app.css` unless named.

| Element | Manuscript `.glosa-content` | Chat reply `.glosa-chat-markdown` | Other chat text | Where |
|---|---|---|---|---|
| Body face / size / leading | Source Serif 4, 18 / 1.62 | Source Serif 4, 15 / 1.7 | note 15 / 1.45 serif; human bubble 15 / 1.6 sans; draft 15 / 1.55 sans; DESIGN.md Body 15 / 1.6 sans and Note 15 / 1.45 serif | 2615-2617, 7431, 4400-4406, 7409, 7488; DESIGN.md:283, 285 |
| Heading face | Source Serif 4 (inherits --font-manuscript) | Source Sans 3 (explicit) | DESIGN.md:295 says anything a session wrote is serif | 2615, 7458 |
| Heading sizes | h1 clamp 30..40, h2 clamp 24..26, h3 20, h4..h6 17 | h1 30 (UA), h2 22.5 (UA), h3 12 (label leak), h4 15 (UA), h5 12.45 serif, h6 10.05 serif | n/a | 2643-2672, 7389-7394, 7457-7461 |
| Heading weight | 650 / 620 / 620 / 600 | 700 (UA) except h3 600 | n/a | 2646, 2653, 2661, 2670 |
| Heading line height | 1.1 / 1.25 / 1.3 / 1.4 | 1.7 inherited (h3 1.5) | n/a | 2645, 2628, 2660, 2669, 7431 |
| Heading margins | h1 0 0 2rem; h2 3rem 0 0.75rem; h3 2rem 0 0.5rem; h4 1.5rem 0 0.5rem; a block directly under a heading closes to 0 | 18px 8px for h1..h4; no closing rule; h5 / h6 UA margins about 20.8 / 23.4px | n/a | 2648-2692, 7460 |
| Emphasis | strong 600 | strong 700 (UA) | n/a | 2712-2715 |
| Block gap | 1.2em = 21.6px via --prose-gap | 0.6rem = 9.6px literal | n/a | 2620, 7454-7456 |
| Lists | padding-left 1.5rem, li margin-bottom 0.3em, markers --muted tabular, nested top 0.25rem | UA padding-left 40px, li 0, markers --ink | n/a | 2739-2758 |
| Blockquote | margin 1.5rem 0, padding-left 1rem, 1px --border-strong left rule, --muted, italic | UA margin-inline 40px, margin-block 0.6rem, no rule, upright, --ink | n/a | 2717-2723, 7454 |
| Inline code | --font-mono, 0.85em (15.3px), --surface bed, radius 4, padding 0.1em 0.35em | UA generic monospace, 15px, no bed | n/a | 2768-2774 |
| Code block | mono 13 / 1.6, --surface, 1px --border, radius 8, padding 16, margin 1.2em; inner code actually 11.05px (0.85em leak) | mono 12 / 1.6, --surface-sunken, no border, radius 5, padding 12, margin 0.6rem | detail rows mono 12 / 1.6 on --surface radius 5; decision pre mono 12 / 1.5 unboxed | 2776-2792, 7445-7453, 7417-7422, 7837-7843; DESIGN.md:290 |
| Links | --primary (ink), underline at 40% mix, offset 2px | UA default link colour (rgb(0,0,238) light, rgb(158,158,255) dark), underlined | n/a | 2834-2838 |
| Tables | sans 15, tabular numerals, th 13 600 --muted with a --border-strong rule, td 8px 12px with --border rules | UA: serif 15, th 700, padding 1px, no rules, no overflow handling | n/a | 2796-2827 |
| Horizontal rule | 4rem centred, 1px --border-strong, 2rem margins | UA 1px inset grey, full width | n/a | 2761-2766 |
| Images | max-width 100% | replaced by the text "[Image: alt]" | n/a | 2829-2832; chat-markdown.js:5 |
| Measure | 68ch = 624px measured, about 76 characters | 46rem = 736px = 93.6ch, about 104 to 108 characters (633px, about 89, in a 720px pane) | human bubble 576px = 77ch sans, about 90 | 168, 2612, 7385, 7403 |
| Wrapping | text-wrap pretty, hanging-punctuation first | none; overflow-wrap anywhere | n/a | 2618-2619, 7430 |
| Who is serif | the human's margin notes and the session's words in the manuscript | the session's words; the human's words are sans in the bubble and the draft | the Serif Is Writing Rule (DESIGN.md:295) says both are serif; the Conversation Pane section (DESIGN.md:412) says the bubble is sans | 4400-4406, 7409, 7488; DESIGN.md:295, 412 |
| Boxing | manuscript unboxed; notes unboxed on the margin | reply unboxed; human bubble boxed --surface radius 14; detail bodies boxed; error rows boxed | composer frame boxed --surface radius 14 | 7398-7427, 7470-7475 |
| Colour of prose | --ink; quotes --muted | --ink everywhere; nothing --muted inside a reply | labels --muted | 2721, 7459 |
| Column vs controls width | 68ch plus 2 x 2rem gutters | replies 46rem; composer, footer, readiness 48rem, wider than the replies at every width | n/a | 2612, 7385, 7466 |

Table 5.4b: values duplicated between the two rule sets, and what could share a token.

| Property | Manuscript (line) | Chat reply (line) | Shared today? | Candidate |
|---|---|---|---|---|
| Code font family | var(--font-mono) (2769, 2777) | var(--font-mono) (7452) on `pre`; the inner `code` falls back to generic monospace | partly | set it on `pre code` too |
| Code block size | var(--text-sm) 13 (2778) | var(--text-xs) 12 (7452) | no | one `--code-size` in em of the prose |
| Code bed and radius | var(--surface), var(--radius-panel) 8 (2780-2782) | var(--surface-sunken), 5px literal (7450-7451) | no | one bed token, one radius token |
| Code padding | var(--space-4) 16 (2783) | 12px literal (7449) | no | a space token |
| Block gap | var(--prose-gap) 1.2em (2620) | 0.6rem literal (7455) | no | set `--prose-gap` on `.glosa-chat-markdown`, reuse one `:is(p, ul, ol, pre, blockquote)` rule |
| Heading margins | space tokens (2648-2671) | 18px 8px literal (7460) | no | space tokens |
| Heading family | inherited --font-manuscript (2615) | var(--font-sans) (7458) | no | drop the override |
| Body white-space | normal | `.glosa-chat-text` pre-wrap (7429) reset to normal (7443), pre forced back (7446) | chat-only workaround | render Markdown rows without pre-wrap and both resets go |
| Rules only the manuscript has | strong, blockquote, lists and markers, hr, inline code, pre code reset, table, img, a, h5 / h6, heading-plus-block closing, first / last child margins | none | no | one prose vocabulary scoped to `:is(.glosa-content, .glosa-chat-markdown)` with size and measure as variables |
| Radii literals in the chat region | tokens | 5px = --radius-tool; 6px = --radius-control; 8px = --radius-panel; 12px = --radius-overlay; 14px and 16px have no token | partly | use the tokens; decide one bubble-and-composer radius token |
| Shadow and colour literals | tokens | `0 3px 8px #0002` (7550); `#161616` (7279) | no | --shadow-menu; a dark-safe token |

### 5.5 Recommendation: concrete changes, ordered by effect

Effort is sized by complexity, not time: **S** is a few declarations in one file; **M** is a shared rule set, a token, or a new control.

| # | Element | Ships today | Proposed | Why | Evidence | Effort |
|---|---|---|---|---|---|---|
| 1 | Reply size and leading | Source Serif 4 15 / 1.7; paragraph gap 0.6rem (9.6px) | Source Serif 4 16 / 1.62 (one step under the manuscript's 18 / 1.62, the same ratio); paragraph gap about 0.9em of the reply; keep `font-optical-sizing: auto`, do not pin opsz | On a laptop at 50 cm, 15px of this serif subtends about 0.17 degrees of x-height, below the 0.2 degree critical print size. 16px (0.178) and 17px (0.188) narrow the gap without closing it, so the print-size evidence argues softly for a larger reply but does not pick between 16 and 17 (table 5.3c). The serif peers set replies at 16px: Perplexity 16 / 26, claude.ai's prose tokens 16 / 24 at comfortable density. ChatGPT's 16 / 26 is a sans, which Source Serif 4 matches optically only at about 17 to 18px. 1.7 is looser than every peer measured live (1.625); claude.ai's wrapper declares 1.65rem, not measured live. One ratio gives both columns one rhythm | [38] [39] [43] [2] [3] [7] [50] [61] | S |
| 2 | Reply measure | 46rem = 736px, about 104 to 108 characters at 15px (89 painted in a 720px pane) | Cap paragraph text at about 36rem, or 60 to 65ch of the reply size (75 to 90 characters); state the cap in ch or em of the reply so a size step keeps it; lists, code and tables may keep the wider column | Over Butterick's 90 and Bringhurst's 75. Bringhurst gives 40 to 50 for multi-column work, which fits a secondary column beside the manuscript. ChatGPT holds 640px; claude.ai has a 65ch utility and a 36rem cap (CSS only); the manuscript holds about 76. Two supports from the draft no longer count: WCAG 1.4.8 does not cap a resizable column, and Perplexity's 65ch cap is inert (its paragraphs run about 86 to 97 characters). The case rests on the practitioner guidance | [42] [49] [7] [2] | S |
| 3 | The `###` bug | A Markdown h3 inside a reply paints at 12px 600 sans, smaller than its body and smaller than a `####` | Scope the label rule to the row's own label (`.glosa-chat-message > h3`, `> summary`) or give the Markdown heading rule an explicit size and weight; ablate it: a `### heading` fixture row must measure above the body size before the fix counts | Readers see it now. The two rules have equal specificity, (0,1,1), and the later one overrides only family, colour and margin. Confirmed in a browser render | audit fixture row mdh3 [81] [82]; app.css:7389-7394, 7457-7461 [75] | S |
| 4 | Headings inside replies | Source Sans 3 at browser sizes (h1 30, h2 22.5, h4 15, all 700, leading 1.7); h5 / h6 unstyled serif | Source Serif 4, weight 600 to 620, a compact scale that never exceeds the manuscript's h3 (20px): h1 and h2 1.25em, h3 1.125em, h4 to h6 1em; line-height 1.25 to 1.3; about 1.5em above and 0.5em below, closing to 0 when a block follows directly; leave optical sizing to `font-optical-sizing: auto` | claude.ai keeps reply headings in the reply face at 600, shifts every level down one so its largest reachable reply heading is 1.375em, and relies on automatic optical sizing. Perplexity keeps them serif (h2 at 635), ChatGPT in its own sans at 600, VS Code in one family. No observed product switches family. A reply h1 at 30px 700 outranks any manuscript heading. The Serif Is Writing Rule; Butterick's smallest visible step; scanning research wants headings kept, not enlarged | [2] [3] [7] [10] [45] [46] [53] [54] [78] | S |
| 5 | Links | No rule: browser default blue, rgb(0,0,238) light and rgb(158,158,255) dark (7.5:1) | The manuscript's link rule: --primary with a 40% underline, offset 2px | Browser blue is off-system and sits near the session's blue ink in hue; the manuscript already solved this. Not a contrast bug: re-measured at 7.5:1 in dark | app.css:2834-2838 [75]; [33] | S |
| 6 | Code inside replies | Inline: generic monospace at 15px, not --font-mono, no bed; block: 12px / 1.6 (0.80em) on `pre`, inner `code` in generic monospace | Inline: --font-mono at 0.85em on a --surface bed (the manuscript rule) with `font-size-adjust` so a code span does not grow its line. Block: set `pre code` to --font-mono so the ui-monospace stack applies, and hold the block's x-height ratio to the reply (about 0.9 today, about 13px at a 16px reply) rather than moving to a fixed 0.875em. Fix the manuscript's 11.05px `pre code` leak in the same pass | Inline code today is unstyled monospace at 100%, visibly larger than the serif around it. GitHub (85%) and Tailwind (0.875em) set code a step below the body, which makes 12px (0.80em) look small. Contested: those ratios are for sans bodies, and by x-height the shipped 12px Menlo block is about 0.92 of the 15px serif, at or above GitHub's 0.88 and Tailwind's 0.906, so the block has no ratio case for growing | [71] [69] [60] [63] | S |
| 7 | Tables inside replies | Browser defaults: serif 15, th 700, 1px cell padding, no rules, no overflow handling | The manuscript's table rule: Source Sans 3 one step down (14px at a 16px reply), tabular numerals, th 600 muted, hairline --border rows; an optional scroll wrapper for wide tables | Perplexity, claude.ai and Tailwind step tables down and rule them; an unruled wide table can push past the column. Contested: measured, chat tables stay inside the column because inherited `overflow-wrap: anywhere` breaks long cells mid-word, so the defect is broken words and missing rules, not overflow | [3] [2] [69] [71] | S |
| 8 | Lists, quotes, emphasis, rules | Browser defaults: list padding 40px with ink markers, blockquote indented 40px upright in ink, strong 700, grey hr | The manuscript's rules: list padding 1.5rem with --muted markers, blockquote with a left rule in --muted italic, strong 600, the centred 4rem hr | One vocabulary; nothing in a reply should be heavier than the manuscript | app.css:2712-2766 [75]; [46] | S |
| 9 | The human turn | Source Sans 3 15 / 1.6 in a --surface bubble, radius 14, max min(80%, 36rem); never Markdown | Keep the bubble (tint plus right alignment); set the text in Source Serif 4 at the reply size and ratio; cap its text near 30rem (about 75 characters); for long pasted messages keep the right alignment and bubble shape, so at least one non-colour cue stays | The person wrote it, so the Serif Is Writing Rule (DESIGN.md:295) says serif, while DESIGN.md:285 and :412 say sans: this is a choice between two parts of the record. Alignment and tint remain two cues, which WCAG 1.4.1 accepts. Contested: the tint is colour at about 1.06:1 against the paper, so right alignment and the bubble shape carry 1.4.1, and a serif bubble gives up the face cue that helps today. A bubble is a short-utterance device whose measure follows its content. The peers keep the human turn in sans; see choice 1 below | [78] [32] [73] [74] [42] [2] [3] | S |
| 10 | Labels | Hidden for human and assistant rows; visible on error rows and details; the transcript container is a div with `aria-label="Chat messages"` and no role (chat-pane.js:150) | Keep labels hidden and the visually hidden h3 per article, which names the speaker (technique H42). Give the transcript container a real role so its name counts: role=log, tested for how it announces streamed text (aria-busy while a reply streams), or role=region if the live announcements prove noisy. aria-posinset / aria-setsize are optional | Compliant now; the feed pattern is the closest screen-reader practice for a transcript. Contested: this meets 1.4.1 and 1.3.1 only, not WCAG as a whole, and the feed pattern is for auto-loading article lists, while ARIA 1.2 names chat logs under role=log | [31] [35] [36] [57] [58] [59] | S |
| 11 | The composer | Source Sans 3 15 / 1.55 in a 48rem frame, wider than the 46rem replies; the queue notice sits 4px from the frame edge while the draft sits at 17px; six leadings in one pane | Draft text in Source Serif 4 at the reply size and ratio (the margin composer is already serif); the frame at the reply column's width; the queue notice inset to the draft's edge; one leading ladder: 1.62 prose, 1.5 panel text, 1.4 controls | The person's draft is writing; an input should not be wider than the column it feeds; six leadings is noise | [78] [51] audit | S to M |
| 12 | Dark | Tokens only, which is right; two raw colours: `#161616` on the terminal, `0 3px 8px #0002` on the picker | Keep the warm tokens; replace the two literals with tokens (--shadow-menu and a surface token); no dark contrast defect was found in the reply text once links are measured with `color-scheme: dark` applied. Optional, worth a comp: a lighter reply weight in dark, as claude.ai (360) and Perplexity (370) ship | Reading peers keep warm neutrals in dark; no chat rule should name a colour | [2] [3] [12] audit | S |
| 13 | How the chat relates to the manuscript column | Different faces for the human turn and headings, a different code size, a different block gap, measure in rem here and ch there | One prose vocabulary scoped to `:is(.glosa-content, .glosa-chat-markdown)`, with size, measure and gap as variables (`--prose-size`, `--prose-measure`, `--prose-gap`); chat sets 16px on about 36rem, manuscript 18px on 68ch; the per-document face menu (Default / Sans / Mono) applies to the chat beside it | One family per role, size the only difference, one step apart on a shared scale; a reader who switches the page to Sans should not see a serif chat beside it | [46] [51] [21] [67] [40] table 5.4b | M |
| 14 | The design record | DESIGN.md describes the conversation three ways: Note (serif 15 / 1.45, "a session's message"), Body (sans 15 / 1.6, "the conversation") and the Conversation Pane section (sans human bubbles, serif assistant prose). The Serif Is Writing Rule predates the chat. The shipped reply matches neither size | One named style, Conversation (400, 16px / 1.62, serif), covering the reply, the human turn and the draft; Body keeps panel prose and dialog copy; :295 and :412 made to agree | A record that contradicts itself cannot be enforced. The code follows :285 and :412, so the conflict is inside DESIGN.md, not drift | DESIGN.md:283, 285, 295, 412 [78] | S |
| 15 | A reply size step (with Question 3) | None | sm / default / lg on the chat that scales the reply, the human turn, details and code together | claude.ai ships "Transcript text size" (Small / Medium / Large), which scales both turns together, and a "Chat font" switch; Perplexity ships a serif / sans switch; reading speed varies by reader; Cursor's per-element scaling is the failure to avoid | [2] [3] [16] [17] [40] | M, part of the theming model |
| 16 | Small layout fixes | Action rows sit at the history's left edge; the truncation sentence can appear twice; no `text-wrap: pretty` in the chat | Give action rows the message column's cap and auto margins; emit the truncation note once; apply `text-wrap: pretty` to completed replies (Chromium re-breaks only the last four lines, so streaming is safe) | Polish that costs nothing | audit; [64] [65] | S |

Two choices the maintainer has to make. Each has a recommendation.

| Choice | Option | Recommended? | Trade |
|---|---|---|---|
| 1. The human turn's face | Serif at the reply size (row 9) | yes | Keeps the Serif Is Writing Rule (:295) and one face per author across desk and chat. Loses the face cue between speakers, leaving right alignment and the bubble shape to carry it; the tint adds almost nothing at about 1.06:1. DESIGN.md:285 and :412 change with it |
| 1. The human turn's face | Sans, as today | no | Matches claude.ai, Perplexity and VS Code, and DESIGN.md:285 and :412; conflicts with the rule at :295 and puts the same person in two faces (margin note serif, chat sans) |
| 2. Size versus column | 16px on about 36rem (Option A) | yes | A perceptible step below the manuscript; the column narrows to a reading measure; a size control later keeps it if the cap is in ch. The print-size evidence does not favour 16 over 17 |
| 2. Size versus column | 17px on the existing 46rem (Option B) | no | Reuses --text-md and sits closer to the 0.2 degree critical size (0.188 against 0.178), but 95 characters per line is over Butterick's and Bringhurst's ceilings, and 17 is one pixel from 18 |

### 5.6 Invariants that must hold

| Invariant | What it means for the chat | How to check |
|---|---|---|
| The serif is writing | Anything a session wrote (reply body, reply headings) is Source Serif 4, and the human turn and the draft follow choice 1; Source Sans 3 appears only where the application speaks: labels, summaries, buttons, the picker, the footer | No `--font-sans` inside `.glosa-chat-markdown`; a fixture row per element measures the serif family |
| One hand | The human's marks are one colour, --hand, everywhere; the chat adds no second accent; the caret and focus ring stay --hand; the human bubble's tint is --surface, never a colour | No new colour token in the chat region; contrast of --hand on --surface stays at or above the current 5.8:1 light and 6.9:1 dark |
| A session's words stay ink | Reply text is --ink, never --session (blue-black is for a session's marks in the margin, not its prose); inside a reply only quotes may be --muted, as in the manuscript; a tint never becomes an author colour | `.glosa-chat-markdown` sets no colour other than --ink and the manuscript's --muted for quotes |
| Speakers never rest on colour alone | The human turn keeps at least two non-colour cues (right alignment, a bounded bubble); the tint does not count (about 1.06:1 against the paper); every article carries an accessible author name | WCAG 1.4.1 and 1.3.1 [32] [31]; an axe or manual check of the article names |
| Tokens only, no raw colour | No chat rule names a colour, radius or shadow literal; dark stays a token override | A grep of the chat region for `#`, `rgb(`, `oklch(` and pixel radii returns nothing |
| Copy rules | No em dash in anything a person sees; "document(s)" is the only word for what a session drafts | `test/copy-rules.test.ts` already scans `packages/spa/src` |

### 5.7 Sources

Only sources that were opened are listed. Web sources were read on 2026-09-27; local files were opened during this study.

Product stylesheets and live pages

1. claude.ai application stylesheet, shared frame (holds only an icon-font @font-face; supports nothing in this section): https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-frame-BT3oL0Du.css
2. claude.ai application stylesheet, main bundle: https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/cd56b6998-BSZHib9P.css
3. Perplexity live answer page, computed styles (logged out): https://www.perplexity.ai/
4. Perplexity application stylesheet: https://pplx-next-static-public.perplexity.ai/_spa/assets/style__v2-D4iEbOGn.css
5. Perplexity (2026) brand guidelines, Typography: https://live.standards.site/perplexity/type
6. anthropic.com brand stylesheet: https://cdn.prod.website-files.com/67ce28cfec624e2b733f8a52/css/ant-brand.shared.547e4ca1b.min.css
7. ChatGPT live logged-out conversation, computed styles: https://chatgpt.com/
8. ChatGPT StyleX bundle: https://chatgpt.com/unauth-mweb/assets/stylex-initial-modern-AkfErRuT.css
9. Mistral Le Chat stylesheets (read through document.styleSheets): https://chat.mistral.ai/chat
10. VS Code chat widget stylesheet (chat.css, main): https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/chat/browser/widget/media/chat.css
11. VS Code AI settings reference (chat.fontSize, chat.editor.fontSize): https://code.visualstudio.com/docs/copilot/reference/copilot-settings
12. Microsoft Copilot web app stylesheet: https://copilot.microsoft.com/static/cmc/assets/index-DpBTnoGm.css
13. Gemini web app HTML with inline design tokens (logged out): https://gemini.google.com/app
14. Google Design, Google Sans Flex: https://design.google/library/google-sans-flex-font
15. 9to5Google, Google Sans Flex (2025-12-19): https://9to5google.com/2025/12/19/google-sans-flex-font/
16. Cursor forum, How to increase the font size in composer/chat: https://forum.cursor.com/t/how-to-increase-the-font-size-in-composer-chat-in-cursor/45222
17. Cursor forum, "Text Size" setting applies inconsistently: https://forum.cursor.com/t/text-size-setting-applies-inconsistently-across-chat-elements/161673
18. Wallpaper, OpenAI rebrand (2025-02-04): https://www.wallpaper.com/tech/openai-has-undergone-its-first-ever-rebrand-giving-fresh-life-to-chatgpt-interactions
19. The Daily Prompt, What font does ChatGPT use? (2025-05-23): https://daily.promptperfect.xyz/p/what-font-does-chatgpt-use
20. Gooova, Anthropic Designed Its Own Type Family (2026-05-20): https://gooova.com/en/anthropic-designed-its-own-type-family/
21. Apple Human Interface Guidelines, Typography (data endpoint): https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json
22. Apple Support, iMessage, RCS and SMS/MMS bubble colours (2026-05-11): https://support.apple.com/en-us/104972
23. Slack Design System tokens (community, verified 2026-06-06): https://oh-my-design.kr/design-systems/slack
24. Slack help, Change your Slack theme: https://slack.com/help/articles/205166337-Change-your-Slack-theme
25. Design Your Way, What font does Slack use? (2025-01-08): https://www.designyourway.net/blog/what-font-does-slack-use/
26. Notion help, Customize and style your content: https://www.notion.com/help/customize-and-style-your-content
27. Notion guide, Everything you can do with Notion AI: https://www.notion.com/help/guides/everything-you-can-do-with-notion-ai
28. Devin Desktop docs, Cascade (redirect target of docs.windsurf.com): https://docs.devin.ai/desktop/cascade/cascade
29. Devin docs index: https://docs.devin.ai/llms.txt

Standards

30. WCAG 2.2, Understanding SC 1.4.8 Visual Presentation: https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html
31. WCAG 2.2, Understanding SC 1.3.1 Info and Relationships: https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html
32. WCAG 2.2, Understanding SC 1.4.1 Use of Color: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
33. WCAG 2.2, Understanding SC 1.4.11 Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
34. WCAG 2.2, Understanding SC 1.4.12 Text Spacing: https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
35. WAI-ARIA 1.2, log role: https://www.w3.org/TR/wai-aria-1.2/#log
36. ARIA Authoring Practices Guide, Feed pattern: https://www.w3.org/WAI/ARIA/apg/patterns/feed/
37. Material 3 type scale tokens: https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-typescale.scss

Peer-reviewed

38. Legge and Bigelow 2011, Does print size matter for reading? (Europe PMC record): https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE:%22Does%20print%20size%20matter%20for%20reading%22&resultType=core&format=json
39. Legge and Bigelow 2011, full text (PMC3428264): https://pmc.ncbi.nlm.nih.gov/articles/PMC3428264/
40. Wallace et al. 2022, Towards individuated reading experiences (Adobe Research): https://research.adobe.com/publication/towards-individuated-reading-experiences-different-fonts-increase-reading-speed-for-different-individuals/
41. Arditi and Cho 2005, Serifs and font legibility (Europe PMC record): https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:16099015&resultType=core&format=json

Practitioners

42. Butterick, Practical Typography, Line length: https://practicaltypography.com/line-length.html
43. Butterick, Point size: https://practicaltypography.com/point-size.html
44. Butterick, Line spacing: https://practicaltypography.com/line-spacing.html
45. Butterick, Headings: https://practicaltypography.com/headings.html
46. Butterick, Mixing fonts: https://practicaltypography.com/mixing-fonts.html
47. Butterick, Monospaced fonts: https://practicaltypography.com/monospaced-fonts.html
48. Butterick, Screen-reading considerations: https://practicaltypography.com/screen-reading-considerations.html
49. Rutter, The Elements of Typographic Style Applied to the Web, 2.1.2 Choose a comfortable measure: http://webtypography.net/2.1.2
50. Rutter, 2.2.1 Choose a basic leading: http://webtypography.net/2.2.1
51. Rutter, 3.1.1 Don't compose without a scale: http://webtypography.net/3.1.1
52. iA, Responsive Typography: The Basics: https://ia.net/topics/responsive-typography-the-basics
53. Nielsen Norman Group, How Users Read on the Web (1997): https://www.nngroup.com/articles/how-users-read-on-the-web/
54. Nielsen Norman Group, F-Shaped Pattern of Reading on the Web: https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/
55. Poole, Which Are More Legible: Serif or Sans Serif Typefaces?: https://alexpoole.info/blog/which-are-more-legible-serif-or-sans-serif-typefaces/
56. Smashing Magazine, A Closer Look at Font Rendering (2012): https://www.smashingmagazine.com/2012/04/a-closer-look-at-font-rendering/
57. WebAIM, Invisible Content Just for Screen Reader Users: https://webaim.org/techniques/css/invisiblecontent/
58. Soueidan, Accessible notifications with ARIA live regions, part 1: https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-1/
59. Soueidan, Accessible notifications with ARIA live regions, part 2: https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-2/
60. De Oliveira, Deep dive CSS: font metrics, line-height and vertical-align: https://iamvdo.me/en/blog/css-font-metrics-line-height-and-vertical-align

Vendor documentation and references

61. MDN, line-height: https://developer.mozilla.org/en-US/docs/Web/CSS/line-height
62. MDN, font-optical-sizing: https://developer.mozilla.org/en-US/docs/Web/CSS/font-optical-sizing
63. MDN, font-size-adjust: https://developer.mozilla.org/en-US/docs/Web/CSS/font-size-adjust
64. WebKit blog, Better typography with text-wrap pretty: https://webkit.org/blog/16547/better-typography-with-text-wrap-pretty/
65. Chrome for Developers, CSS text-wrap: pretty: https://developer.chrome.com/blog/css-text-wrap-pretty
66. Glyphs, Manual TrueType hinting (platform support): https://glyphsapp.com/learn/hinting-manual-truetype-hinting
67. Google Fonts description of Source Serif 4: https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/DESCRIPTION.en_us.html
68. Google Fonts METADATA.pb for Source Serif 4 (axes): https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/METADATA.pb
69. Tailwind Typography plugin, src/styles.js: https://raw.githubusercontent.com/tailwindlabs/tailwindcss-typography/main/src/styles.js
70. Tailwind CSS max-width utilities: https://tailwindcss.com/docs/max-width
71. github-markdown-css: https://raw.githubusercontent.com/sindresorhus/github-markdown-css/main/github-markdown.css
72. MediaWiki Typography refresh (2014 rationale): https://www.mediawiki.org/wiki/Typography_refresh

Community

73. Wikipedia, Speech balloon: https://en.wikipedia.org/wiki/Speech_balloon
74. Wikipedia, iChat: https://en.wikipedia.org/wiki/IChat

Local: repository

75. glosa stylesheet: packages/spa/src/app.css
76. glosa chat pane: packages/spa/src/chat-pane.js
77. glosa chat Markdown renderer: packages/spa/src/chat-markdown.js
78. glosa design record: DESIGN.md (lines 283, 285, 290, 295, 412)
79. Agent chat implementation record: docs/design/2026-09-23-agent-chat-implementation.md (line 701)
80. Vendored Source Serif 4 roman (metrics read with fontTools): packages/spa/src/fonts/source-serif-4-roman.woff2
81. Audit fixture material: a local page reproducing the chat DOM with the shipped `app.css` and fonts, and its computed-style dumps (not committed).
82. Audit fixture material: a local page reproducing the chat DOM with the shipped `app.css` and fonts, and its computed-style dumps (not committed).
83. Audit fixture material: a local page reproducing the chat DOM with the shipped `app.css` and fonts, and its computed-style dumps (not committed).

Read during verification

84. claude.ai application JS chunks served from assets-proxy.anthropic.com (reply renderer, Prose component, chat font and transcript text size settings), read 2026-09-27

Verification of this part: 6 confirmed, 4 contested.

## Question 6: two registers (spec and editorial), and how register relates to themes

**Verdict**

1. Yes, they are two independent axes, with one qualification. Appearance (the palette: light, dark, any ported editor colours) belongs to the reader's environment. Register (face, size, leading, heading ladder, spacing, table size and width) belongs to the document. Only the light or dark mode reliably sits outside a preset, and only Apple Books keeps it cleanly apart: since macOS Sonoma 14 its Appearance control sits beside the page themes. In Typora the system mode swaps one whole theme for another, face included. In both, the paper tint stays inside the preset [63][64][65].
2. So a theme catalogue answers only the palette question. Porting One Dark Pro or Dracula changes no face, no size and no spacing; it does nothing for the product manager or the essayist. The reverse also holds: a register does nothing for a person who dislikes warm paper. Keeping ported palettes colour-only is a glosa choice, not an industry rule: Obsidian and Typora themes are CSS and can set fonts [64][70].
3. The path: keep appearance per device as shipped, and upgrade the per-document face chooser into a per-document register (Editorial, Spec, Mono) with a workspace default. Expect modest differences: heading ladder and weight, leading, block gap, table size and width. The evidence does not show that readers need sans for specs. The case is genre convention plus structure, and element rules such as right-aligned numbers belong in every register. If named presets ever come, a preset may bundle a register with at most a paper tint, authored in both light and dark, never with the light or dark choice itself.

Terms used below:

| Term | Meaning here |
|---|---|
| Register | The dress of a document: face, body size, leading, heading ladder, block spacing, and how lists, tables and code are treated |
| Appearance | The palette: light, dark, sepia, high contrast, or a ported editor theme |
| Face | The typeface family (Source Serif 4, Source Sans 3, system mono) |
| Leading | Line height, given as a multiple of the body size |
| Measure | Line length, given in characters (`ch`) |
| Component row / reading row | A design system's small body style for controls and short text (13 to 14px) versus its body style for long passages (16 to 19px) |
| Provenance colours | `--hand` (the person's marks), `--pencil` (an unsent mark), `--session` (the agent's marks) |

### What glosa ships for register today

Read from the code on 2026-09-27: `packages/spa/src/app.css` and `packages/spa/src/face.js`.

| Control | Shipped value | Scope and storage | Gap against the two-register need |
|---|---|---|---|
| Face chooser (pane More menu) | Default (Source Serif 4), Sans (Source Sans 3), Mono (system `ui-monospace`) | Per workspace and document, localStorage (`face.js`): a reader-side preference per device that no session sees; the pane sets `--font-manuscript`, `--manuscript-size`, `--manuscript-leading` | Names the face, not the intent; no workspace default |
| Body size and leading | Serif 18px / 1.62; Sans 16px / 1.6; Mono 15px / 1.65 | Follows the face | The Sans leading and block gap stay editorial |
| Measure | 68ch in all three faces | Fixed | No breakout for wide tables or code |
| Block gap | 1.2em | Fixed | Same gap in Sans as in serif |
| Headings | h1 clamp(30..40px) 650 lh 1.1; h2 clamp(24..26px) 620 lh 1.25; h3 20px 620 lh 1.3; h4..h6 17px 600 lh 1.4; all in `--font-manuscript` | Do not change with the face | A Sans page gets the serif's sizes, weights and 3rem h2 margins; h4 is smaller than the serif body |
| Tables | Source Sans 3, 15px, whatever the face; tabular numerals already set; `---:` columns already render right aligned (`packages/spa/src/app.css:2796-2810`) | Fixed | Smaller than body in every face; no breakout |
| Lists | Items 0.3em apart; list margin is the block gap; nested lists `--space-1` above; markers muted with tabular numerals (`packages/spa/src/app.css:2729-2757`) | Fixed | The first and last child margin reset zeroes a loose item's paragraph margins, so loose and tight lists look the same |
| Code | Blocks: mono 13px / 1.6. Inline: 0.85em | Fixed | Sized for the serif page |
| Margin notes, composer, session note | Source Serif 4, 15px / 1.45, whatever the face | Fixed ("notes are writing, not chrome") | None; a design choice, see the proposal |
| Workspace default, size, leading, presets | None | | The half Notion users ask for and do not get [48] |
| Appearance | Settings > Appearance: system / light / dark; localStorage `glosa_appearance`, applied by a preload script | Per device | Already a separate axis |

The right alignment works because markdown-it turns `---:` into an inline `text-align:right`, which beats the left default, and the SPA's CSP allows inline styles (`packages/daemon/src/security/csp.ts:31`).

### Register fit: what the evidence says

| Question | Finding | Bearing on glosa | Sources |
|---|---|---|---|
| Is "sans for specs, serif for essays" a legibility fact? | No, not at ordinary sizes on screen. No controlled study finds a reading-speed effect of serifs. Fonts do differ from one another, but the differences cut across the serif line, not along it (study table below). | Present Serif and Sans as registers (what the document is), never as "easier to read". Keep both vendored faces; both are screen tuned and variable. | [1][2][3][4][81][82] |
| Is the convention real at all? | Readers attribute personality by family and judge fit to document type [9]; the same satire read as more funny and angry in Times than in Arial [10]; font and product congruity carried as much weight as the product name [11]. Objection from verification: in the 2006 data serif and sans were both near neutral and chosen for the same onscreen reading uses (website text: serif 67%, sans 62%), and Juni and Gross measured the emotional colouring of one print font pair, so this literature separates text faces from decorative ones, not specs from essays. | Supports keeping the face chooser to text faces. It does not show that a spec in serif reads as an essay. The Spec register rests on genre convention in product documentation and on structure, not on reader-personality research. | [9][10][11][12][13][14] |
| What do product UI systems ship? | These are product and public-service UI systems, not documentation systems. All five set a sans body (SF Pro, GDS Transport, Segoe UI, Atlassian Sans, Roboto) in two rows. Component rows: 13 to 14px at leading 1.23 to 1.43 (Atlassian: "for components or where space is limited"). Reading rows: 16 to 19px at 1.29 to 1.5 (Atlassian Body large "for long-form content", Material body-large "for longer passages of text", GOV.UK 19 / 25). GitHub's rendered Markdown sits in the reading row at sans 16px / 1.5. Only Apple (SF Mono) and Atlassian (Atlassian Mono) name a monospace face; Fluent's tokens carry a generic Consolas stack; GOV.UK and Material define none. | The reading rows apply to a manuscript. glosa's Sans face at 16 / 1.6 already sits there, and its 13px chrome matches the component rows. There is no basis for a 13 or 14px Spec body. glosa's system mono stack (SF Mono on macOS) already meets the mono convention. | [15][17][19][20][23][86][87] |
| What do editorial systems ship? | The Guardian sets article body in Guardian Text Egyptian (slab serif) at 15 and 17px / 1.4; the same face is also tokenised at 1.3, so 1.4 is the article-body value. Headlines use a separate display serif, GH Guardian Headline, at 1.15 with no 400 weight. Guardian Text Sans serves buttons, inputs, datelines, captions and charts, and sets the whole body of paid-content (Labs) pages "to help differentiate from editorial content". Butterick: serif is "still the best choice" for body text in print, either class on the web. | The Guardian swaps the body face by content type on tone grounds: a register in all but name. Its 15 and 17px values are news-column sizes for single reads and do not transfer to hours at 18px on 68ch. | [24][84][85][25] |
| What does a spec page need that an essay does not? | RFC 2119 keywords and uniquely numbered requirements; code font for code identifiers, filenames, paths and HTTP status codes (Google's list does not include requirement ids such as R4); a table when each item has three or more related pieces of data; right-aligned numbers when comparing columns; extra list spacing allowed when multi-line items make a list hard to read; description lists for term pairs; one h1 with no skipped levels; status and metadata blocks. | These are rules for single elements, not for a page, and they hold in every register: an essay with a table needs right-aligned numbers too. Most are authoring guidance for the agent writing the Markdown; the renderer can only style what is marked up. They are no evidence that a Spec register needs a different face, size or leading. | [26][27][28][29][30][31][32][33][34][35][36][37][38][39][40] |
| Where is the measurable difference? | Leading and gaps more than size. Reading rows: 16 to 19px at 1.29 to 1.5; Atlassian puts 16px of paragraph space under 16px long-form text (1em) and 12px under 14px component text. Editorial and glosa: 18px at 1.62 with 1.2em gaps. Apple: loose leading for long passages, never tight leading for 3 or more lines. Rello, Pielot and Marcos (104 readers, spacing 0.8 to 1.8) found only the extreme spacings hurt. | Spec leading 1.5 matches the long-form rows, not the 1.23 of component rows. Moving from 1.6 to 1.5 is a density and convention choice, not a reading gain. | [19][20][23][15][41][42][24][83] |
| How do heading ladders differ? | Top heading is about 2x body in UI systems and editorial alike (2.0 to 2.5). Below it, UI systems run even bold steps at leading 1.13 to 1.25; Butterick asks for the smallest visible increment, bold not italic, at most three levels. | Keep h1 near 2x body in both. Spec needs a usable h4; Editorial should treat h4 as body-size bold. h4 must never be smaller than body. | [43][20][17][19][36][31][24] |
| Should headings follow the body face? | Yes. Apple: minimise typefaces, carry hierarchy by weight, size and colour. Fluent, Atlassian, GOV.UK, Material: headings in the body sans. Guardian: headlines serif too, but in a separate display family. | Keep headings in `--font-manuscript`, but let the register set their weight, leading and margins. | [19][24][20][17] |
| Do readers differ? | Yes. Reading speed varied up to 35 percent between a person's fastest and slowest font with no comprehension change; preference and measured speed dissociate. | Reader preference is a third reason to change the face, separate from register. A workspace default covers it for now. | [44][3] |
| Which serif or sans matters more than the class? | Screen-tuned faces win: Verdana beat Arial, Times and Georgia; Georgia was perceived sharper than Times; stroke contrast, not serifs, drives word recognition. | Source Serif 4 and Source Sans 3 are the modern Georgia and Verdana. Keep them; body weight stays 400 or above. | [5][4][1][7][8][19] |
| Does line length change with register? | No. Characters per line is the critical layout variable; 45 to 75 (66 ideal) or 45 to 90. Products give wide content a per-page escape hatch (Notion Full width; GOV.UK small-text tables for large data only). | Keep 68ch for prose in both registers; let tables and code widen in Spec instead of shrinking their type. | [45][46][47][48][34] |

The serif vs sans studies, as verified:

| Study | What it varied | Result | Caveat |
|---|---|---|---|
| Arditi and Cho 2005 [2] | Synthetic fonts differing only in serif length (0, 5, 10% of cap height) | No serif effect on RSVP or continuous reading speed | 5% serifs slightly more legible at acuity threshold (very small or distant text); no comprehension measure |
| Bernard et al. 2001 [81] | Twelve fonts at 12pt, 22 readers, 96 dpi CRT | No difference in effective reading score | Substituted-word detection, not comprehension |
| Bernard et al. 2002 [3] | Eight fonts at 10, 12 and 14pt, 60 readers, same CRT | Efficiency (time adjusted for accuracy) null. Raw reading time differed: Times and Arial faster than Courier, Schoolbook and Georgia | The fast fonts were read less accurately; the split cuts across serif and sans |
| Ali et al. 2013 [4] | Georgia vs Verdana, Times vs Arial, 12pt, 24 readers per pair, 140-word Malay passages read aloud | No difference | Font confounded with passage and order; corroboration at best |
| Beymer, Russell and Orton 2008 [82] | Serif vs sans, eye tracking with comprehension tests, 82 readers | No significant difference; serif slightly faster | The only study here that measured comprehension |

Poole's 2008 review reaches the same conclusion on the older literature and recommends choosing on aesthetic grounds; it cites none of the studies above [1].

Systems as shipped (numbers from each system's own tokens or served CSS):

| System | Body face | Body size / leading | Code face | Top heading over body |
|---|---|---|---|---|
| GOV.UK Design System (public service) | GDS Transport (sans) | 19px / 25px at every breakpoint, reading row (16 / 20 small) | None in the design system; its own site CSS uses ui-monospace, Menlo, Cascadia Mono, Consolas | 48 / 19 = 2.5 [15][16] |
| Fluent 2 (product UI) | Segoe UI (sans) | Body 1 14px / 20px, component row | Tokens: generic Consolas, Courier New stack; Microsoft Learn site CSS: SFMono-Regular, Consolas, Liberation Mono, Menlo | Title 1 32 / 14 = 2.3 [17][18][87] |
| Apple HIG (product UI, pt) | SF Pro (sans); New York (serif) offered beside it | macOS Body 13 / 16, component row; iOS Body 17 / 22, reading row | SF Mono | macOS 26 / 13 = 2.0; iOS 34 / 17 = 2.0 [19] |
| Atlassian (product UI) | Atlassian Sans | Body 14 / 20 for components (12px paragraph gap); Body large 16 / 24 for long-form (16px gap) | Atlassian Mono 12 / 20 | Heading XXL 32 / 14 = 2.3 [20] |
| Material 3 (product UI) | Roboto (sans) | body-large 16 / 24, reading row; body-medium 14 / 20 | None in the typescale | headline-large 32 / 16 = 2.0 [23] |
| Stripe docs | sohne-var (sans) | not extracted | Source Code Pro; Menlo, Consolas | not extracted [21] |
| Linear docs | InterVariable (sans) | not extracted | `--font-monospace` | not extracted [22] |
| Guardian (editorial) | Guardian Text Egyptian (slab serif); Guardian Text Sans for UI, meta and the body of paid-content pages | article 15px and 17px / 1.4; textSans 12 to 42px / 1.3 | not in the tokens | GH Guardian Headline (display serif) 34 or 42 / 17 = 2.0 to 2.5, leading 1.15 [24][84][85] |
| glosa, shipped | Source Serif 4 (Sans and Mono per document) | 18 / 1.62 serif; 16 / 1.6 sans; 15 / 1.65 mono | `ui-monospace` 13 / 1.6 | 40 / 18 = 2.2 |

### Catalogue: how writing tools handle register and presets

| Product | Face | Size | Leading | Width | Register scope | Palette control | Preset bundles face + palette? | Headings follow body face? |
|---|---|---|---|---|---|---|---|---|
| Notion [48] | Default / Serif / Mono per page | Small text toggle per page | none | Full width toggle per page | Per page. FAQ, "Is there a way to set a default style for all pages?": "Not yet" | App light / dark, elsewhere | No | Yes ("All the text on your page will change") |
| Craft [58][59][67] | System / Serif / Mono / Rounded per document | not documented | none | not documented | Per document. A saved default style applies to every new document in that space; existing documents untouched; per-document override | Document colours; App Style bleeds colours, not fonts, into chrome | Yes: a default style bundles font, text colour, document colour, cover and backdrop; not light or dark | Yes ("entire document") |
| Google Docs [60] | Any font via paragraph styles | Per style | Per paragraph | Page margins | Per document; "Save as my default styles" | None | No | Styles per heading level |
| iA Writer [54][72][73] | iA Mono / Duo / Quattro | Slider | none in editor | 64 / 72 / 80 chars | App-wide editor; templates per document for preview, PDF and print | Light / Dark app-wide; no theme catalogue | Editor no; output templates (Modern (Sans), Classic (Serif), Manuscript (Mono, Duo, Quattro), GitHub) bundle face, margins and line height | Single editor face |
| Ulysses [49][50][51][80][88] | Any installed font | Zoom | Line Height | Line Width | App-wide (Settings > General) | Theme = colours of background, text, markup; light and dark versions. The theme editor also sets heading sizes and text styles | Editor no: "Themes define the colors". Export styles (tagged Serif, Sans Serif, Colored) bundle typography for PDF, DOCX, ePub and HTML | Single editor face |
| Bear [52][53] | Any installed font for text, headers, code | Font size | Line height | Line width | App-wide Typography panel | Theme = "mood and color" of text, styling and background; mostly ported palettes | No | Not stated |
| Typora [64][65][66][71][74][75][76][77][78][79] | Set by theme CSS | Theme CSS | Theme CSS (GitHub 1.6) | Theme CSS max-width | App-wide theme. Opt-in "Use separate theme in dark mode" (macOS 10.15+, Windows 10 1903+) picks one whole theme per mode; one theme may also carry both palettes via `prefers-color-scheme` | Inside the theme CSS | Yes: one .css sets face, size, leading, width, colours; six built in (GitHub, Newsprint, Night, Pixyll, Whitey, Gothic). Night, the only dark one, is a sans, so switching mode from Newsprint also changes the face | Theme decides (Gothic changes the face) |
| Obsidian [56][57][61][62][69][70] | Text, Interface and Monospace fonts | Font size (default 16px) | Theme variable (1.5); no user setting | Readable line length: a toggle, not a width | Per vault (`.obsidian` folder) | Light / dark / system, accent, community themes, CSS snippets | Partly: a theme is CSS that may set fonts, heading size and weight, and line height; the user's font settings override it | Yes unless a theme styles headings |
| Readwise Reader [55] | Serif and sans list incl. Atkinson Hyperlegible, OpenDyslexic | 14 to 80px, default 20px | Default 1.4 | Line width (web) | Per device ("saved for any document you open on the same device") | Light / dark / auto, called "mode"; no theme catalogue | No | n/a |
| Apple Books, Mac [63] | Font under Customize | A buttons | Spacing slider | Columns | Theme tile, then Customize | Appearance: Light / Dark / Automatic, separate from the theme since macOS Sonoma 14; before that, Night was a page colour beside White, Sepia and Gray | Yes for face, bold text, spacing and paper tint (Original, Quiet, Paper); each theme renders in both modes | n/a |
| Kindle app [68] | "choice of font style, size and more" | Yes | not verified | not verified | not verified | "adjustable screen brightness and page colour" | Saved themes not verifiable (Amazon help returned HTTP 503) | n/a |

The working claim behind model A below: Ulysses, Bear, iA Writer, Readwise Reader and Obsidian all define a theme as colours only and expose face, size, leading and width as separate app-wide or per-vault typography settings. Objection from verification: that holds cleanly only for Ulysses and Bear editor themes, since Obsidian themes are CSS that set fonts and line height, iA Writer and Readwise have no theme catalogue, and at the rendered-output layer that matches glosa, iA Writer templates and Ulysses export styles bundle typography into named presets.

Three models, and what a bundle buys:

| Model | Who | Register scope | Palette scope | Buys | Costs |
|---|---|---|---|---|---|
| A. Typography settings beside a colour theme | Ulysses and Bear editors cleanly; iA Writer and Readwise with only light / dark; Obsidian with themes that may also set type | App, vault or device | App or vault, light and dark variants | Palettes are cheap to port where the theme is colours only | Cannot hold a spec and an essay in different registers at once |
| B. Per-document register with a default | Notion (default requested, not shipped), Craft, Google Docs | Per document, default for new ones | App light / dark, separate (Craft's default also carries document colours) | The right register per document; the default removes the per-page chore Notion users ask for | One more per-document state to store and show |
| C. Bundled preset | Typora, Apple Books, Craft styles; at the output layer, iA Writer templates and Ulysses export styles | Inside the preset | Inside the preset. Light or dark sits outside only in Apple Books; Typora's mode swaps whole presets, face included | One decision instead of four to six; a named look | Every preset needs a light and a dark rendering; Typora needs a light theme and a dark theme, and the face can change with the mode |

glosa holds specs and essays side by side, so model B is its reference class. What transfers is the control shape (a default plus a per-document override), not the storage. Notion and Craft store the style on the page, for the author. glosa's face is a reader-side preference per device, keyed by workspace and document path. Craft's default also ties font to colours, which glosa should not copy.

### Proposal: a Spec register and an Editorial register

Values are px on a 16px rem. "Ships today" is the Default (serif) face unless the Sans face is named. Spec values come from the reading rows of UI systems' tokens or from a style guide; Editorial values from editorial tokens or practitioner guidance. Heading margins are a judgement call scaled from the block gap, since no source specifies them. The Spec register is a genre and density choice, not a readability fix.

| Parameter | Ships today | Editorial (proposed) | Spec (proposed) | Grounding | What changes |
|---|---|---|---|---|---|
| Face | Serif: Source Serif 4, 400. Sans: Source Sans 3, 400 | Source Serif 4, 400 | Source Sans 3, 400 | Class is convention, not legibility [1][2][3][82]; product UI systems all sans [15][17][19][20]; Guardian body serif, sans for paid content [24][84]; Butterick serif for body [25]. The personality research does not separate specs from essays, so this rests on genre convention | Nothing; both faces already exist |
| Body size | Serif 18. Sans 16 | 18 | 16 | Butterick 15 to 25px on the web [42]; Readwise default 20 [55]; Atlassian Body large 16 "for long-form content" [20]; Material body-large 16 [23]; Obsidian default 16 [69]. Rello et al. found comprehension better at larger sizes [83], so never below 16 | Nothing |
| Leading | Serif 1.62. Sans 1.6 | 1.62 (Question 2 of this report owns whether to trim it; 1.5 to 1.62 is the envelope) | 1.5 (24px) | Apple: loose leading for long passages, never tight for 3+ lines [19]; Atlassian and Material 16 / 24 [20][23]; Typora GitHub theme 1.6 [79]; Butterick 120 to 145 percent [41]; only extreme spacings hurt reading [83] | Spec: 1.6 to 1.5, a look and density change, not a reading gain |
| Block gap | 1.2em | 1.2em | 1em (16px) | Atlassian 16px under 16px long-form text [20]; Typora 1rem [79]; Butterick: space is the main structuring device [43]. Atlassian's tighter 0.86em belongs to 14px component text | Spec: 1.2em to 1em |
| Measure | 68ch, all faces | 68ch | 68ch for prose; tables, code blocks and wide lists may widen to the pane, capped near 96ch | Characters per line is the variable [45]; 45 to 75, 66 ideal [46]; 45 to 90 [47]; Notion Full width per page [48]; GOV.UK small text only for large tables [34] | Spec: breakout is new |
| h1 | clamp(30..40px), 650, lh 1.1, margin 0 0 2rem | Unchanged (40 / 18 = 2.2) | 32px, 650, lh 1.2, margin 0 0 1.5rem (32 / 16 = 2.0) | Top heading 2.0 to 2.5 x body: Apple 26 / 13 and 34 / 17 [19], Material 32 / 16 [23], Atlassian 32 [20], Fluent 32 [17], GOV.UK 48 / 19 [15] | Spec: fixed 32, looser lh, tighter margin |
| h2 | clamp(24..26px), 620, lh 1.25, margin 3rem 0 0.75rem | Unchanged | 24px, 650, lh 1.25, margin 2.25rem 0 0.5rem | Atlassian XL 24 / 28 Bold [20]; Fluent Title 3 24 / 32 Semibold [17]; GOV.UK heading-m 24 / 30 [15] | Spec: 26 to 24, 620 to 650, top margin 3rem to 2.25rem |
| h3 | 20px, 620, lh 1.3, margin 2rem 0 0.5rem | Unchanged | 20px, 650, lh 1.3, margin 1.75rem 0 0.5rem | Atlassian L 20 / 24 [20]; Fluent Subtitle 1 20 / 26 Semibold [17]; Apple iOS Title 3 20 / 25 [19] | Spec: 620 to 650, top margin 2rem to 1.75rem |
| h4 (and h5, h6) | 17px, 600, lh 1.4 (smaller than the 18px serif body) | h4 18px (body size), 650, lh 1.4; h5 and h6 the same, or run in | h4 17px, 650, lh 1.35, margin 1.5rem 0 0.375rem; h5 and h6 16px (body size), 650 | Butterick: smallest visible increment, bold not italic, more than three levels is confusing [43]; Apple iOS Headline 17 semibold and macOS Headline 13 bold at body size [19]; Atlassian S, XS, XXS Bold [20]; Google and GOV.UK: never skip levels [31][36] | Editorial: 17 to 18, 600 to 650. Spec: 600 to 650; never below body |
| Heading weight rule | 650 / 620 / 620 / 600 in the body face | Keep 650 at h1, 620 at h2 and h3, 650 at h4; hierarchy from size and space | One weight, 650, on every level; hierarchy from size and space | Apple: minimise typefaces, hierarchy by weight and size [19]; Atlassian all Bold, Fluent all Semibold [20][17]. The Guardian's 1.15 headline leading belongs to a separate display cut, so it is only a loose guide for a text serif scaled up [24] | The sans needs the heavier step; the serif holds hierarchy through its own stroke contrast |
| Lists | Items 0.3em apart; loose and tight look the same (see the shipped table) | Tight as shipped; loose items (a blank line between items, which markdown-it renders as a paragraph inside each item) apart by the block gap | Tight 0.3em; loose 1em; nested lists add no gap | GOV.UK: you may add spacing when multi-line items make a list hard to read [35]; Google: same structure for all items [30]. An element rule, so it holds in both registers; tight or loose is the author's choice per list | Both: loose lists gain space (new). Spec: loose gap 1em |
| Definition lists | Not rendered (markdown-it core has no definition-list syntax) | No change | If a deflist plugin is ever vendored: `dt` 650, `dd` indented 1.5em, 0.5em between pairs | Google: description lists for term and definition pairs [30] | Optional; not required for the register |
| Tables | Source Sans 3, 15px, all faces; tabular numerals; `---:` columns right aligned | Unchanged | Body face at body size (16px); header 650; cell padding 0.5em 0.75em; may widen past 68ch; a 14px variant only as an opt-in for large datasets | GOV.UK: align numbers right, small text only for a lot of data [34]; Google: a table for three or more related pieces of data, do not merge cells [29]; Butterick: borders off, cell margins up [40]. Alignment and the table-or-list choice are the author's job, and already render | Spec: 15 to 16, padding and breakout new. Editorial: nothing |
| Inline code | 0.85em mono | Unchanged | 0.9em mono, so the mono x-height sits near the sans x-height (a visual check, not a measured value) | Google: code font for code identifiers, filenames, paths and status codes, not product names, URLs or requirement ids [28]; Microsoft: code style for programmatic elements [32][33]; Butterick: mono only for code [39] | Spec: 0.85 to 0.9em |
| Code blocks | Mono 13px / 1.6 | Unchanged | Mono 14px / 1.5; may widen past 68ch | Atlassian code 12 / 20 [20]; among the UI systems only Apple and Atlassian name a mono, and glosa's system stack already resolves to SF Mono on macOS [19][87]; Stripe docs ship Source Code Pro [21]; Butterick: compressed syntax reads better in mono [39] | Spec: 13 to 14, 1.6 to 1.5, breakout new |
| Requirement keywords and ids | Plain text | No change | No parsing. Tabular numerals in list text so R-12 and FR-3.2 align (tables and list markers already have them); ids stay plain text, not code font; MUST, SHOULD, MAY stay the author's caps | RFC 2119 keywords are often capitalised [26]; NASA: one thought per requirement, uniquely numbered, with rationale [27]; Google's code-font list does not cover requirement ids [28] | Spec: tabular numerals in list text new |
| Margin notes, composer, session note | Source Serif 4, 15px / 1.45, whatever the page face | Unchanged | Unchanged | No product opened puts notes in a different face; Craft and Obsidian keep the chrome face constant while the page changes [67][69]. A design choice: notes are the person's writing, one voice in every register | Nothing. The alternative (notes follow the page face) has no precedent either way |
| Chrome | Source Sans 3, 13px on the fixed rem scale | Unchanged | Unchanged | Craft: "The UI continues to use system fonts" [67]; Obsidian: interface font separate from text font [69]; 13px matches the UI systems' component rows [19][17] | Nothing |
| Print | Since #398: the page's face at 12pt / 1.45 on white paper | Unchanged | Unchanged: the register's face already reaches print, at print's own 12pt scale | Ulysses and iA keep an export register separate from the editor [50][72][80] | Nothing |

Why the Sans face today is not a Spec register: it takes the serif's heading sizes and weights, the serif's 3rem h2 margins, the serif's 1.2em block gap, 15px tables that are smaller than its own body, and no room for a wide table. It is the serif page in a sans costume.

The Mono face stays as a third register. It has precedent (iA Manuscript (Mono), Craft Mono, Notion Mono [72][58][48]) and needs no change here.

### How the register is chosen

| Option | Precedent | Fit for glosa | Verdict |
|---|---|---|---|
| Per document, as today | Notion per page [48]; Craft per document [58] | Right home: specs and essays sit side by side in one workspace, and the register says what the document is. The claim that readers judge the text through its face [9][10] is contested (Register fit, row 2), so this rests on genre convention | Keep |
| Per workspace default | Craft's saved default style per space, applied to new documents, with per-document override [59]; Google Docs "Save as my default styles" [60]; Obsidian settings per vault [61]; Notion's FAQ answer "Not yet" [48] | A folder of specs wants Spec on every document. glosa creates no documents itself (agents write files), so apply the default as a read-time fallback, which also covers existing documents | Add. A document's own choice overrides it |
| Inferred from content | None among the tools opened | A document with one table is not a spec. The agent rewrites the document while a person reads it, so an inferred register could flip mid-read | Not now. At most a one-time suggestion when a document has no register and no workspace default |
| Named presets that also carry a palette | Typora themes [64][66]; Apple Books themes [63]; Craft styles [58][59]; at the output layer, iA Writer templates [72] and Ulysses export styles [80] | Every preset needs a light and a dark rendering, each contrast-checked for the provenance colours. Typora's mode switch swaps whole themes, face included [65]; Apple Books keeps light or dark outside only since Sonoma 14 [63]; the tint stays inside the preset in both | No palette bundles. A preset may carry a register and at most a paper tint, authored in both modes; light, dark and system stay in Settings > Appearance |

Recommendation:

1. Rename the More-menu control from a face to a register, and name entries by intent with the face in parentheses, as iA and Craft do [72][58]: Editorial (Serif), Spec (Sans), Mono. Each entry sets face, body size, leading, block gap, heading ladder, and table size and width from the proposal table. Element rules (right-aligned numbers, tabular numerals, loose-list spacing) apply in every register.
2. Add a workspace default register, applied as a read-time fallback: any document with no stored choice takes it, and the per-document choice wins over it. Where it lives is an implementation decision: beside the face in localStorage (per device and reader-side, as today) or in the workspace's daemon-side metadata (follows the folder into the Electron shell and any browser). Obsidian's per-vault configuration folder is the precedent for the folder side [61].
3. Leave Settings > Appearance alone: system, light, dark, per device. Any ported palette (Question 1 of this report) maps colours only and keeps the provenance colours legible; it never sets a face. This is a glosa choice that keeps the two axes clean, not what every tool does: Obsidian and Typora themes can set fonts [64][70].
4. If JSON palettes ever carry a register hint, layer it under the workspace default and the document's choice, the way Obsidian lets a theme set a text font and the user's Appearance setting override it [69][70].
5. Reader preference (one person's fastest font is another's slowest [44]) is a third reason to change the face. The workspace default covers it for now; a per-person default face is a later, separate control, not a theme.
6. The table-or-list and code-font rules are for whoever writes the Markdown [28][29]. If glosa ever ships authoring guidance for agents, they belong there, not in a register or a theme.

### Limits of this evidence

- No study opened measures reading over hours or fatigue, and only Beymer et al. measured comprehension. All used roughly 96 dpi screens at 10 to 14pt over about two pages. On hours of reading at 18px on a high-DPI screen the literature is silent, not null. The "hours of reading" claims rest on practitioner guidance (Butterick, Bringhurst via Rutter, Apple's loose-leading rule).
- The serif studies are small (22, 60, and 24 readers per pair) with no equivalence tests: they failed to detect a difference, they did not show equality.
- Brumberger 2003 is cited for existence only (OpenAlex records; abstracts unreachable). A lead not verified here: Brumberger reportedly found typeface appropriateness had little effect on readers' judgement of a text and none on reading time or comprehension. Open it before citing. Lund 1999 is represented through Poole's summary; the thesis itself was not reachable.
- New York Times, Medium, BBC GEL and FT Origami could not be fetched; the Guardian's open-source tokens stand in for editorial systems, and its sizes are news-column values.
- Apple Books iOS (the six-theme list) and Kindle saved themes were not verifiable from vendor pages; only the Mac guide and the App Store listing loaded. The Mac guide's separate Appearance control applies from Sonoma 14 on.
- The loose vs tight list behaviour was read from CSS, not checked in a rendered page.

### Sources

Only sources that were opened during this study are listed.

1. Poole 2008, Which are more legible: serif or sans serif typefaces? https://alexpoole.info/blog/which-are-more-legible-serif-or-sans-serif-typefaces/
2. Arditi and Cho 2005, Serifs and font legibility, Vision Research 45(23), abstract via Europe PMC. https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:10.1016/j.visres.2005.06.013&resultType=core&format=json
3. Bernard, Lida, Riley, Hackler and Janzen 2002, A comparison of popular online fonts: which size and type is best? Usability News 4(1). SURL original, via the Wayback Machine: http://psychology.wichita.edu/surl/usabilitynews/41/onlinetext.htm. First read at usabilitynews.org, which is now an unrelated site republishing the article without its authors.
4. Ali, Wahid, Samsudin and Idris 2013, Reading on the computer screen: does font type have effects on web text readability? International Education Studies 6(3). http://www.ccsenet.org/journal/index.php/ies/article/view/24169
5. Josephson 2008, Keeping your readers' eyes on the screen, Visual Communication Quarterly 15(1-2), abstract via OpenAlex. https://api.openalex.org/works/https://doi.org/10.1080/15551390801914595
6. Nielsen Norman Group 2012, Serif vs. sans-serif fonts for HD screens. https://www.nngroup.com/articles/serif-vs-sans-serif-fonts-hd-screens/
7. Minakata and Beier 2022, The dispute about sans serif versus serif fonts, Acta Psychologica, abstract via OpenAlex search. https://api.openalex.org/works?search=Knowledge%20construction%20in%20typography%20legibility%20research%20sans%20serif%20typefaces&per_page=3
8. Boyarski, Neuwirth, Forlizzi and Regli 1998, A study of fonts designed for screen display, CHI, abstract via Semantic Scholar. https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/274644.274658?fields=title,abstract,year,venue,authors,citationCount
9. Shaikh, Chaparro and Fox 2006, Perception of fonts: perceived personality traits and uses; Shaikh and Chaparro 2016 chapter in Digital Fonts and Reading, abstracts via OpenAlex; full text of the 2006 paper read during verification. https://api.openalex.org/works?search=Perception%20of%20fonts%20perceived%20personality%20traits%20and%20uses&per_page=3
10. Juni and Gross 2008, Emotional and persuasive perception of fonts, Perceptual and Motor Skills 106(1), abstract via Europe PMC. https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:10.2466/pms.106.1.35-42&resultType=core&format=json
11. Doyle and Bottomley 2006, Dressed for the occasion: font-product congruity, Journal of Consumer Psychology 16(2), abstract via OpenAlex. https://api.openalex.org/works?filter=title.search:dressed%20for%20the%20occasion%20font%20product%20congruity&per_page=3
12. Mackiewicz 2004 and 2005, Journal of Technical Writing and Communication, Crossref records. https://api.crossref.org/works?query.bibliographic=Mackiewicz+how+to+use+five+letterforms+to+gauge+a+typeface+personality&rows=5&select=title,author,container-title,issued,DOI,abstract
13. Brumberger 2003, The rhetoric of typography (two papers), Technical Communication 50(2), OpenAlex citation records only. https://api.openalex.org/works?filter=title.search:rhetoric%20of%20typography,publication_year:2003&per_page=5
14. Butterick, Practical Typography: A brief history of Times New Roman. https://practicaltypography.com/a-brief-history-of-times-new-roman.html
15. GOV.UK Design System, Type scale. https://design-system.service.gov.uk/styles/type-scale/
16. GOV.UK Design System, served stylesheet (GDS Transport; ui-monospace for code on the site). https://design-system.service.gov.uk/stylesheets/main-474eaefb2b0b7a31f2ea78a1079e0727.css
17. Microsoft Fluent 2, Typography. https://fluent2.microsoft.design/typography
18. Microsoft Learn, served site.css (SegoeUI; SFMono-Regular, Consolas, Menlo). https://learn.microsoft.com/static/assets/0.4.03552.8263-7baf7f2d/styles/site.css
19. Apple Human Interface Guidelines, Typography (page data payload). https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json
20. Atlassian Design System, Typography. https://atlassian.design/foundations/typography
21. Stripe docs, served stylesheet (sohne-var; Source Code Pro, Menlo, Consolas). https://b.stripecdn.com/docs-statics-srv/assets/docs.686cbbc8e2c7c5f83d00.css
22. Linear docs, served HTML (InterVariable; --font-monospace). https://linear.app/docs
23. Material 3 type scale tokens, material-web v0.192. https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-typescale.scss
24. Guardian Source design system, generated typography tokens. https://raw.githubusercontent.com/guardian/csnx/main/libs/%40guardian/source/src/foundations/__generated__/typography.ts
25. Butterick, Practical Typography: Body text. https://practicaltypography.com/body-text.html
26. RFC 2119, Key words for use in RFCs to indicate requirement levels. https://www.rfc-editor.org/rfc/rfc2119
27. NASA Systems Engineering Handbook, Appendix C: How to write a good requirement. https://www.nasa.gov/reference/appendix-c-how-to-write-a-good-requirement/
28. Google developer documentation style guide, Code in text. https://developers.google.com/style/code-in-text
29. Google developer documentation style guide, Tables. https://developers.google.com/style/tables
30. Google developer documentation style guide, Lists. https://developers.google.com/style/lists
31. Google developer documentation style guide, Headings and titles. https://developers.google.com/style/headings
32. Microsoft Writing Style Guide, Formatting developer text elements. https://learn.microsoft.com/en-us/style-guide/developer-content/formatting-developer-text-elements
33. Microsoft Writing Style Guide, Formatting common text elements. https://learn.microsoft.com/en-us/style-guide/text-formatting/formatting-common-text-elements
34. GOV.UK Design System, Table component. https://design-system.service.gov.uk/components/table/
35. GOV.UK Design System, Lists. https://design-system.service.gov.uk/styles/lists/
36. GOV.UK Design System, Headings. https://design-system.service.gov.uk/styles/headings/
37. Notion help, Building a product requirement document in Notion. https://www.notion.com/help/guides/building-a-product-requirement-document-in-notion
38. Notion blog, How to write a PRD. https://www.notion.com/blog/how-to-write-a-prd
39. Butterick, Practical Typography: Monospaced fonts. https://practicaltypography.com/monospaced-fonts.html
40. Butterick, Practical Typography: Tables. https://practicaltypography.com/tables.html
41. Butterick, Practical Typography: Line spacing. https://practicaltypography.com/line-spacing.html
42. Butterick, Practical Typography: Point size. https://practicaltypography.com/point-size.html
43. Butterick, Practical Typography: Headings. https://practicaltypography.com/headings.html
44. Wallace et al. 2022, Towards individuated reading experiences, ACM TOCHI, abstract via Semantic Scholar. https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3502222?fields=title,abstract,year,venue,authors,citationCount
45. Dyson 2004, How physical text layout affects reading from screen, Behaviour and Information Technology 23(6), abstract via OpenAlex. https://api.openalex.org/works/https://doi.org/10.1080/01449290410001715714
46. Rutter, The Elements of Typographic Style Applied to the Web, 2.1.2 Choose a comfortable measure. http://webtypography.net/2.1.2
47. Butterick, Practical Typography: Line length. https://practicaltypography.com/line-length.html
48. Notion help, Customize and style your content. https://www.notion.com/help/customize-and-style-your-content
49. Ulysses Style Exchange, Themes. https://styles.ulysses.app/themes
50. Ulysses help, Getting started with styles and themes. https://help.ulysses.app/en_US/styles-themes/customize-ulysses-with-styles-and-themes
51. Ulysses help, Customize the editor. https://help.ulysses.app/en_US/dive-into-editing/editor-customization-guide
52. Bear FAQ, Free and Pro themes. https://bear.app/faq/about-free-and-pro-themes-in-bear/
53. Bear FAQ, Typography options. https://bear.app/faq/typography-options/
54. iA Writer support, Settings. https://ia.net/writer/support/basics/settings
55. Readwise Reader docs, Appearance. https://docs.readwise.io/reader/docs/faqs/appearance
56. Obsidian help, Settings. https://obsidian.md/help/settings
57. Obsidian help, Appearance. https://obsidian.md/help/appearance
58. Craft support, Styling quick guide. https://craft-support.mintlify.app/en/write-and-edit/styling/quick-guide.md
59. Craft support, Default page styles. https://craft-support.mintlify.app/en/write-and-edit/styling/default-styles.md
60. Google Docs help, Change the style of text (default styles). https://support.google.com/docs/answer/1663349
61. Obsidian help, Configuration folder. https://obsidian.md/help/Files+and+folders/Configuration+folder
62. Obsidian help, CSS snippets. https://obsidian.md/help/Extending+Obsidian/CSS+snippets
63. Apple Books User Guide for Mac, Change a book's appearance. https://support.apple.com/guide/books/change-a-books-appearance-ibks8923126d/mac
64. Typora support, About themes. https://support.typora.io/About-Themes/
65. Typora support, Dark mode. https://support.typora.io/Dark-Mode/
66. Typora theme docs, Write custom theme. https://theme.typora.io/doc/Write-Custom-Theme/
67. Craft support, App styles. https://craft-support.mintlify.app/en/write-and-edit/styling/app-styles.md
68. Amazon Kindle on the App Store (GB). https://apps.apple.com/gb/app/amazon-kindle/id302584613
69. Obsidian developer docs, Typography CSS variables. https://docs.obsidian.md/Reference/CSS+variables/Foundations/Typography
70. Obsidian developer docs, Build a theme. https://docs.obsidian.md/Themes/App+themes/Build+a+theme
71. Typora theme gallery, Gothic. https://theme.typora.io/theme/Gothic/
72. iA Writer support, Templates. https://ia.net/writer/support/preview/templates
73. iA Writer support, Custom templates. https://ia.net/writer/support/preview/custom-templates
74. Typora theme gallery, Github. https://theme.typora.io/theme/Github/
75. Typora theme gallery, Newsprint. https://theme.typora.io/theme/Newsprint/
76. Typora theme gallery, Night. https://theme.typora.io/theme/Night/
77. Typora theme gallery, Pixyll. https://theme.typora.io/theme/Pixyll/
78. Typora theme gallery, Whitey. https://theme.typora.io/theme/Whitey/
79. Typora support, Line spacing and paragraph spacing. https://support.typora.io/Line-Spacing/
80. Ulysses Style Exchange, Styles. https://styles.ulysses.app/styles

Added during verification:

81. Bernard, Mills, Peterson and Storrer 2001, Usability News 3(2): twelve fonts at 12pt, 22 readers. Opened as a Wayback Machine copy of the SURL original.
82. Beymer, Russell and Orton 2008, eye-tracking study of serif vs sans reading with comprehension tests, 82 readers, abstract via OpenAlex.
83. Rello, Pielot and Marcos 2016, font size and line spacing on Wikipedia articles, CHI, 104 readers, abstract via OpenAlex.
84. Guardian Source, typography guidance (Text Sans for interactive elements, meta information and paid-content templates). https://github.com/guardian/csnx/blob/main/libs/%40guardian/source/src/foundations/typography/stories/typography.mdx
85. Guardian dotcom-rendering, TextBlockComponent.tsx (Labs body in textSans17, otherwise article17). https://github.com/guardian/dotcom-rendering/blob/main/dotcom-rendering/src/components/TextBlockComponent.tsx
86. GitHub rendered-Markdown stylesheet (`.markdown-body`: sans 16px / 1.5, inline code 85%), read during verification.
87. Fluent UI React v9 tokens, `@fluentui/tokens` global fonts (fontFamilyMonospace "Consolas, 'Courier New', Courier, monospace"; fontSizeBase300 14px; lineHeightBase300 20px), read during verification.
88. Ulysses help, Editor themes (heading sizes small to 4XL, text styles). https://help.ulysses.app/en_US/styles-themes/editor-themes

Verification of this part: 6 confirmed, 2 contested.
