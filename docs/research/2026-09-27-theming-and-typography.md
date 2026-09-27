# glosa theming and typography study

Date: 2026-09-27. Status: recommendations; the decisions are at the end.

Why this study: glosa ships one look (warm paper, Source Serif 4, a per-document face chooser) and no reading control beyond zoom. Before building theming or type controls, the maintainer asked the six questions in the first table.

Companions: [the evidence appendix](2026-09-27-theming-and-typography-evidence.md) and [visual comps](spikes/theming-comps.html), a static page comparing the candidate pairs, proportions, palettes, chat treatments and registers. Open it in a browser.

Reading the references: the evidence holds four parts. Part 1 covers Questions 1 to 3, and one part each covers Questions 4, 5 and 6. "Part 1 #n" means decision n in Part 1's [Decisions left for the maintainer](2026-09-27-theming-and-typography-evidence.md#decisions-left-for-the-maintainer). Sizes are T-shirt complexity estimates, XS to L, not calendar time; no costing pass ran.

## Answer first

| # | Question | Answer |
|---|---|---|
| 1 | Ship editor themes such as One Dark Pro? | No named catalogue. On a prose page without syntax highlighting, only their background, body colour and code background survive. |
| 2 | Are the font pair and proportions right? | Keep Source Serif 4 with Source Sans 3. Raise h4 to body size and give the sans its own measure (line length in characters). Add a text-size control: the 18px body sits at the reading-speed floor with no reserve. |
| 3 | Which theming model do people stay for? | One identity, plus reader comfort controls (size first) and high-contrast variants on a validated theme file. Appearance rarely makes people leave, and then mostly over reading comfort or an unwanted change to a look they had adopted. |
| 4 | Are the hover passage addresses useful? | Keep the `§2.3` labels, shown only while notes are shown, and add a short hover-in delay. Today they serve only the person: the agent session never receives them. |
| 5 | How should the chat set text? | Keep its shape: unboxed serif replies, one bubble for the person, no labels. Fix the type: 16px replies on about 36rem, with the manuscript's prose rules. |
| 6 | Do specs and essays need their own type? | Yes, as registers (a document's typographic dress), an axis separate from appearance. Turn the face chooser into Editorial, Spec and Mono registers with a workspace default. |

Across all six:

- **The model.** Appearance belongs to the device, register to the document, reading comfort to the person, and the conversation style to the chat.
- **Bugs found.** Three bugs (dark danger-button text at 2.79:1, a chat `###` heading at 12px, manuscript code blocks at 11.05px) and one design flaw (chat links in browser blue). Each is a small fix.

## The model: three settings, three owners

A person changes three settings; the chat owns one fixed style.

| Setting | Controls | Owner | Ships today | Add |
|---|---|---|---|---|
| Appearance | The palette: light, dark, high contrast, an imported palette | The device | Use system setting / Light / Dark, applied before first paint | High-contrast light and dark, picked by `prefers-contrast: more` (the OS increase-contrast signal); a validated theme file |
| Register | Face, body size, leading (line spacing), heading ladder, block gap, tables, code, width | Chosen per document, with a workspace default; stored per reader and device today | A per-document face chooser (Default / Sans / Mono) that leaves headings, tables and gaps unchanged | Editorial, Spec and Mono registers; a workspace default |
| Reading comfort | A text-size step; later measure and line spacing | The device, per person | Only browser zoom and the desktop shell's View menu | One step that scales every reading surface |
| Conversation | The chat's replies, the person's turns, the draft | The chat | Serif replies at 15px / 1.7 on 46rem; sans human turn and reply headings | Source Serif 4 at 16px / 1.62 on about 36rem, the same beside every register |

Editor themes cover only the appearance row: they set no face, size or spacing. A register, in turn, does nothing for someone who dislikes warm paper.

## Fix first: defects found while researching

The first four rows were measured in Chrome 154 and WebKit against the shipped stylesheet, then re-measured in Chrome on v0.1.0-alpha.36 after the print rework (#398): unchanged. Three were re-read with their fix injected; the danger-button fix (a new `--on-danger` token) was not. The other rows come from Part 1's code audits.

| Defect | Measured value | Class | Where (main at 8ed3767, v0.1.0-alpha.36) | Fix |
|---|---|---|---|---|
| Danger button text, dark mode | `oklch(0.99 0 0)` (OKLCH: a perceptual colour space) on dark `--danger`: 2.79:1 at 13px, re-measured (the evidence's 2.78:1 predates it). WCAG AA (the usual accessibility bar) needs 4.5:1; light is 7.28:1 | Bug (accessibility) | `packages/spa/src/app.css:4913-4917` | An `--on-danger` token, darker in dark |
| `###` in a chat reply | 12px, weight 600, sans, below the 15px reply: a label rule reaches Markdown headings | Bug | `packages/spa/src/app.css:7389-7394`, `:7457-7461` | Scope the label rule to the row's own label, or size Markdown headings (17.55px once set) |
| Manuscript code blocks | 11.05px, not the 13px in `DESIGN.md:290`: inline code's 0.85em compounds inside `pre` | Bug (minor) | `packages/spa/src/app.css:2768-2792` | `.glosa-content pre code { font-size: inherit }` |
| Links in chat replies | No rule, so browser blue: 9.1:1 light, 7.5:1 dark | Design flaw: off-system, hue near the session's ink | `packages/spa/src/app.css:7442-7461`; manuscript rule `:2834-2838` | Reuse the manuscript rule (17.7:1 light, 14.6:1 dark) |
| Scheme list (which themes are light or dark) | Copied in three files; the preload (the script that applies the theme before first paint) cannot learn a named theme's scheme | Tech debt | `packages/spa/src/appearance.js`, `appearance-preload.js`, `agent-settings.js` | One source, mapped by theme id |
| Dark overrides | Five component rules outside the token block; the diff pane's colour remap applies in dark only | Tech debt | `packages/spa/src/app.css:5090-5141` | Three elevation tokens (shared values for raised surfaces); an unconditional diff remap |
| `html lang` | Hard-coded `en`, so spellcheck and screen readers treat Polish as English | Missing guardrail | `packages/spa/src/shell.html:3` | Set it per document |
| Electron window | No `backgroundColor` and no `nativeTheme.themeSource`, so the window starts white and native dialogs ignore glosa's mode | Tech debt | `packages/shell/src/main.ts:248` | Set both from the resolved theme |
| Marks on Safari 16.4 | Marks paint only via `::highlight()` (a CSS API that paints text ranges without changing the page), which Safari gained at 17.2; the guard returns silently | Missing guardrail | `packages/spa/src/artifact-pane.js:138`; `docs/appendices/A6-cli-platform.md:208` | Raise the floor to 17.2, or a DOM fallback |
| Enlarged browser type | The rail ladder (pane widths where the note rail fits) is fixed in px. Larger type can overrun the page block (`--manuscript-block`, the manuscript column's painted width, fixed at 707px) | Missing guardrail | `packages/spa/src/app.css:176` | Decouple the block from the rail ladder |

## Question 1: editor themes such as One Dark Pro and Monokai

**Do not ship One Dark Pro, Monokai, Dracula and the rest as a named catalogue of glosa themes, either instead of the identity or beside it.**

These themes are syntax palettes: colours keyed to the token names of a code grammar. glosa renders code as plain monospace, so their signature accents have no job. Only the background, body colour and code background survive, and glosa's tokens already model those. Ports of one theme disagree about everything else. Class: a limit of the approach.

| Source | Background | Body | Headings | Links | Bold |
|---|---|---|---|---|---|
| Dracula spec | #282A36 | #F8F8F2 | purple | pink | orange |
| Dracula, Obsidian port | #282a36 | #f8f8f2 | h1 purple, h2 orange, h3 green, h4 red | pink | orange |
| Dracula, Typora port | #282a36 | #b8bfc6 | #dedede, not coloured | #e0e0e0 | inherits |
| One Dark Pro | #282c34 | #abb2bf | red #e06c75 | purple | orange |
| GitHub Markdown CSS | #ffffff | #1f2328 | body colour, weight 600 | #0969da | weight only |
| glosa today | warm paper | warm near-black ink | ink | ink, underlined | weight 600 |

Dracula's spec and two of its ports give three different pages, so a glosa "Dracula" would be glosa's own invention. Colour meaning is the second cost. All ten palette families studied ([evidence Appendix 1c](2026-09-27-theming-and-typography-evidence.md#1c-the-code-editor-themes-code-editor-lane)) have an accent within 1 to 24 hue degrees of glosa's hand hue or session hue. The hand colour marks the person's words (burnt vermilion); the session colour marks a session's (blue-black). A port brings that accent's own meaning: Nord documents its orange as "advanced or dangerous functionality".

Recommendations, in priority order:

1. Decide against a named catalogue (XS).
2. Keep page colour for provenance (who wrote which words) only: headings, bold and links stay ink, as today (XS).
3. If people ask for "a palette I know", add a Base16 importer after the comfort controls (M). Base16 is a 16-slot palette convention with a meaning per slot. Map slots to roles and validate contrast. Refuse a failing palette by name. Name the result for what it does (warm, cool, low-glare), and credit the author.
4. Label anything from GitHub or classic Monokai neutrally, with attribution; never copy Monokai Pro's values (XS).

What verification weakened:

- Hue collision narrowed. glosa colours neither bold nor links, so the risk is borrowed meaning and lost warmth.
- Licensing softened: GitHub's palette and classic Monokai are MIT; only Monokai Pro may not be copied.
- Audience weakened. Bear, Joplin, MarkText and Standard Notes ship editor palettes to note-takers.

Evidence: [Part 1](2026-09-27-theming-and-typography-evidence.md#part-1-editor-themes-the-font-pair-and-its-proportions-and-the-theming-model-questions-1-to-3)

## Question 2: the font pair and its proportions

**Keep Source Serif 4 with Source Sans 3. The proportions are sound: two values need a change (h4 and the sans measure), and body size needs a control. The third change the evidence names, a larger sans, is Decision 1.**

The pair follows the practitioners' same-foundry rule: Source Serif 4 was designed "to complement the Source Sans 3 family". At the sizes glosa renders, their x-heights (height of a lowercase x) are 1.2 percent apart. The one gap is the system mono, 11 to 15 percent taller in x-height than the serif. Today the face is also the only lever for size and leading, so switching faces changes both as a side effect (design flaw).

| Parameter | glosa today | Authoritative range | Verdict |
|---|---|---|---|
| Body, serif | 18px; x-height 8.65px | An x-height of about 0.2 degrees of visual angle (how large text looks at the eye) or more. That is the critical print size, the smallest text read at full speed. Butterick (*Practical Typography*): 15 to 25px | At the floor with no reserve: 0.196 degrees on a 14-inch MacBook at 50 cm, 0.176 on a 27-inch display at 65 cm. Keep 18; add a control up to 24px |
| Body, sans face | 16px; x-height 7.78px | Matching the serif's x-height needs about 17.8px | About 18px for a face swap; Spec: see Decision 1 |
| Line height | 1.62 | Butterick 1.2 to 1.45; WCAG AAA (the strictest accessibility level) 1.5 or more | Fine. Registers keep 1.5 to 1.7; a person's own step may go past it (Question 3) |
| Measure | 68ch (a ch is one zero-glyph width): serif lines average about 74 characters, sans about 79 (88 at most) | Bringhurst (*The Elements of Typographic Style*) 45 to 75; Butterick 45 to 90; WCAG AAA 80 | Serif fine. Sans: about 63 to 64ch; a comfort issue, not a WCAG failure |
| Paragraph gap | 1.2em | Butterick 50 to 100 percent of body | Borderline loose; trial 1.0em |
| h4 to h6 | 17px, 600 | Apple's Headline: body size, bold | Change: a bold run (18px, 600) outranks the subheading today. Minor design flaw |
| Code blocks | 13px documented, 11.05px rendered | No source found | Unrated; with Source Code Pro, 14 to 15px |

Recommendations, in priority order:

1. A text-size control on one reading scale (M; Decisions 4 and 8).
2. h4 never below body size (XS). In Editorial, h4 matches the 18px body; Spec keeps 17px over its 16px body. Weight: 600 (Question 2) or 650 (Question 6); settle it in a mock-up.
3. A sans measure of about 63 to 64ch (XS).
4. Vendor Source Code Pro, about 70 KB (S). Subset Source Sans 3, saving about 185 KB, and record the recipe, which the repo lacks today (tech debt) (S). Then re-tune inline code to 0.95 to 1.0em and code blocks to 14 to 15px.
5. Mock-up trials only: a 1.0em paragraph gap, h1 and h2 at weight 500 to 550, and tables in the manuscript face (XS each).

What verification weakened:

- The body was first called "under" the critical print size. That figure sits in a 0.15 to 0.3 band, and ordinary setups move the body between 0.15 and 0.24. Hence "at the floor", and a control, not a new default.
- Perceived size is not simply x-height; readers matched overall letter height more often. The 18px sans rests on these two faces' matching metrics.

Evidence: [Part 1](2026-09-27-theming-and-typography-evidence.md#part-1-editor-themes-the-font-pair-and-its-proportions-and-the-theming-model-questions-1-to-3)

## Question 3: a theming and font model people stay for

**Keep one identity, add reader comfort controls and high-contrast variants on a validated theme file, and add no theme catalogue.**

Against reading apps, glosa lacks the comfort layer more than page colours. Kindle, Apple Books, Kobo, Firefox and Readwise ship size, line spacing and width; Safari Reader offers size alone, by zoom. glosa's only size lever is zoom: for a reading tool, a design flaw. Looks rarely make people leave these tools, and then mostly over comfort or a change to a look they had adopted. That finding rests on unverified, self-selected reviews.

| Option | Audience fit | Evidence | Effort | Provenance risk | Verdict |
|---|---|---|---|---|---|
| A. One identity, light and dark only | 3 | 2 | none | none | Not enough |
| B. Identity plus comfort controls and accessibility variants | 5 | 4: size has the clearest evidence | M | low | Recommended |
| C. Palette ports with protected provenance colours | 2 | 2: no reading evidence | M to L | medium | Later, as a role-based import |
| D. User theme files and custom fonts | 3 | 2: no reader offers font upload; only Firefox allows custom colours | M | high for raw CSS, low otherwise | Theme file and font folder yes; raw CSS only as unsupported opt-in |
| E. Full editor-theme catalogue | 1 | 1 | L | high | No |

Scores run from 1 (poor) to 5 (strong). Provenance risk is the chance that the hand, pencil (an unsent mark) and session colours stop being distinct.

Recommendations, in priority order:

1. Text size: 5 to 7 steps from 15 to 24px, default 18, per person per device, alongside browser and shell zoom (M). Decision 4 sets its reach.
2. A validated `glosa-theme.json` (16 colour slots plus a light or dark flag) that refuses a failing theme by token and ratio (M). Then high-contrast light and dark, picked by `prefers-contrast: more` (M).
3. A measure control at about 55, 68 and 80 characters, in ch per face (S, after the M decoupling of the page block).
4. Line spacing at 1.45, 1.62 and 1.8, then presets: Default, Compact, Large, Low vision (S each). The evidence states both these steps and a 1.5 to 1.7 range; here the range binds register defaults only. Presets move from second place to last: each bundles size, leading and measure, so those controls come first. After registers, a preset carries comfort values only.
5. Fonts (M): first a user font folder the daemon serves, which works in Safari. Then exact installed-font names through `local()` (a CSS source reading an installed font), in the shell and Chromium only.

The validator gates on WCAG 2 ratios. Ink needs 4.5:1 (7:1 in shipped themes). Hand and session need 4.5:1 as text and 3:1 as a line; pencil needs 4.5:1. APCA (a newer, polarity-aware contrast formula) is advice only. Tokens already reach the manuscript, the chrome and the chat. Five surfaces need their own mechanism: class F (glosa's sandboxed viewer for agent-written HTML documents), the agent-login terminal (where a person signs in to a provider), the diff pane in light mode, print and the Electron window.

What verification weakened:

- A reported 35 percent speed gap between a reader's fastest and slowest font reappeared with font labels shuffled. Face choice rests on comfort and ownership, not speed.

Evidence: [Part 1](2026-09-27-theming-and-typography-evidence.md#part-1-editor-themes-the-font-pair-and-its-proportions-and-the-theming-model-questions-1-to-3)

## Question 4: the passage addresses shown on hover

A passage address is the § label: `§2.3` is the third block under the second heading, derived on every paint and stored nowhere.

**Keep the addresses and the rule that shows them only while notes are shown; add a hover-in delay, and treat sending them to the agent as a product choice.**

The addresses cost almost nothing and do one verified job. They match a margin card, a Go to row (a section in the ⌘K palette) and a block on the page by one name. Headings show theirs by default, body blocks on hover or focus, and nothing shows while notes are hidden or in Edit. Nothing sends them to the agent session or parses them from chat. So the intent in `packages/spa/src/address.js`, "a short name a human and a session can both say", is half built. Class: a design flaw in the record; nothing breaks.

| Option | Reading calm | Finding a note's passage | Agent addressing | Effort | Total |
|---|---|---|---|---|---|
| A. Keep as is | 4 | 3 | 3 | 5 | 15 |
| B. Hover-in delay plus opt-in "Show all addresses" | 5 | 4 | 3 | 3 | 15 |
| C. Margin cards only | 5 | 2 | 2 | 4 | 13 |
| D. Remove | 5 | 1 | 1 | 4 | 11 |

Scores run 1 to 5, best highest; for effort, 5 means least work. B ties A, trading effort for calm and findability. C and D lose the one verified use.

Recommendations, in priority order:

1. Keep the default as shipped (no work). A block beside a session's mark (drawn as a bracket in the margin) still shows no address there; the session's tab carries it instead.
2. A hover-in delay of about 150 to 300 ms, none on hover-out (XS). Hover's real cost is motion: an 11px vermilion label blinks as the cursor tracks each paragraph.
3. Print is settled (no work). Since the print rework (#398), no address or mark prints, whatever the page state.
4. If dense review needs it, an opt-in "Show all addresses" in the More menu, stored like the face chooser (S). A product choice, not an evidence-backed need.
5. A VoiceOver pass before any screen-reader policy (S). The label is in the accessibility tree on every top-level block while notes are shown; whether that helps is untested.

What verification weakened:

- "Prose review numbers every unit" failed. Word and Google Docs offer line numbers as an opt-in, and PLOS requires them only in the submitted file. All three serve reference outside the document; anchored-comment tools keep numbers off.
- The shared-label case is contested. Its studies are human-to-human and do not transfer to a label that renumbers on edit. Coding tools pass the selected text, as glosa does with the quote.
- The WCAG and screen-reader analysis was dropped.

Evidence: [Question 4](2026-09-27-theming-and-typography-evidence.md#question-4-are-the-on-hover-passage-addresses-useful-and-for-whom)

## Question 5: the chat

**Keep the chat's shape and fix the type inside it: a larger serif reply on a narrower column, set with the manuscript's prose rules.**

The shape matches ChatGPT and Perplexity on their live pages, and claude.ai in its stylesheet: unboxed replies, one tinted bubble for the person, no visible labels. Replies are 15px on a 736px column, about 104 to 108 characters per line (design flaw). Reply headings take browser sizes in the chrome sans. Inline code, tables, lists and links fall through to browser defaults (design flaw: no rules were written).

| Peer convention | Who follows it | glosa today | Delta |
|---|---|---|---|
| Reply body 16px, leading 1.5 to 1.625 | claude.ai, ChatGPT, Perplexity, Le Chat, Copilot | serif 15px / 1.7 | One step small, looser |
| The person's turn in the UI sans | claude.ai, Perplexity, VS Code | sans bubble | Matches peers and `DESIGN.md:285` and `:412`; conflicts with the Serif Is Writing rule at `:295`. Design flaw in the record, not drift |
| Reply headings in the reply face at 600, largest about 1.25 to 1.375em | claude.ai, Perplexity, ChatGPT, VS Code | sans at browser sizes (h1 30px); `###` at 12px | Diverges |
| Column about 60 to 65ch | ChatGPT 640px; claude.ai 65ch and a 36rem cap (found in its stylesheet, not seen rendered) | 46rem | Too wide |
| Code and tables a step below body | claude.ai, Perplexity, VS Code, Le Chat | code 12px; tables unstyled | Code small, tables unruled |
| A reply size step or face switch | claude.ai, Perplexity, Le Chat, VS Code, Cursor | none | Missing |

Recommendations, in priority order:

1. Fix the `###` bug and the link rule (XS each; see Fix first).
2. Replies in Source Serif 4 at 16px / 1.62, one step under the manuscript at the same ratio, with a gap of about 0.9em (S). 17px would also do; see Decision 13.
3. Cap reply paragraphs near 36rem (60 to 65ch), in ch or em so a size step keeps it; the composer matches the column (S).
4. One prose rule set for manuscript and chat, scoped to `:is(.glosa-content, .glosa-chat-markdown)` with size, measure and gap as variables (M). Reply headings become serif at 600 to 620, never above the manuscript's 20px h3.
5. One Conversation style in DESIGN.md, serif at 16px / 1.62, for the reply, the person's turn and the draft. It reconciles `DESIGN.md:285`, `:295` and `:412` (S).

What verification weakened:

- The column case narrowed. WCAG 1.4.8 (the AAA rule on line width) does not cap a column the reader can resize. Perplexity's 65ch cap is inert. The case rests on Butterick and Bringhurst.
- The code-block case narrowed. By x-height the 12px block is about 0.92 of the 15px serif, so it should follow the reply size, not grow alone.
- The link-contrast finding was withdrawn: 1.4:1 came from a faulty fixture.

Evidence: [Question 5](2026-09-27-theming-and-typography-evidence.md#question-5-the-chat-experience-a-polished-serif-register-that-stays-clean)

## Question 6: spec and editorial registers

**Register and appearance are separate axes: turn the per-document face chooser into a register chooser with a workspace default, and let palettes touch appearance only.**

"Sans for specs, serif for essays" is convention, not legibility: no controlled study finds a serif effect on reading speed at ordinary screen sizes. Spec is a density and convention choice. Today's Sans face is not a Spec register. It borrows the serif's headings, 3rem h2 margins and 1.2em gap, and its 15px tables are smaller than its body (design flaw).

| Parameter | Ships today | Editorial | Spec |
|---|---|---|---|
| Face | Serif or Sans, per document | Source Serif 4 | Source Sans 3 |
| Body size | serif 18px, sans 16px | 18px | 16px |
| Leading | 1.62 / 1.6 | 1.62 | 1.5 |
| Block gap | 1.2em | 1.2em | 1em |
| Measure | 68ch | 68ch | About 63 to 64ch prose (Decision 1); tables and code may widen, capped near 96ch |
| h1, h2 | 30 to 40px, 650; 24 to 26px, 620 | unchanged | 32px and 24px, both 650 |
| h4 | 17px, 600 | 18px, 650 | 17px, 650 |
| Tables | sans 15px in every face | unchanged | body face at 16px; may widen |
| Code blocks | mono 13px / 1.6 documented, 11.05px rendered | unchanged | mono 14px / 1.5; may widen |

Decision 1 overrides Question 6's finding that line length does not change with register: Spec prose takes Question 2's sans measure. Margin notes stay serif at 15px in every register: notes are the person's writing.

Recommendations, in priority order:

1. Rename the More-menu control to a register: Editorial (Serif), Spec (Sans), Mono (M). Each sets the values above.
2. A workspace default register for documents with no choice; the document's choice wins (S). Storage is Decision 15.
3. Element rules in every register: loose lists get the block gap, and list text gets tabular numerals (equal-width digits) so ids like R-12 align (S).
4. Leave Settings > Appearance as it is; an imported palette never sets a face (XS).
5. Two written rules (XS). Do not infer a register from content now; a session can rewrite the document mid-read. At most, offer a one-time suggestion when a document has neither a register nor a workspace default. A preset may carry a register plus at most a paper tint, authored in both light and dark, never light or dark itself.

What verification weakened:

- The typeface-personality research separates text faces from decorative ones, not specs from essays: serif and sans both read as near neutral.
- "Themes are colours only" holds cleanly for Ulysses and Bear. Obsidian themes set fonts, and iA Writer templates bundle typography, so colour-only palettes are glosa's choice.

Evidence: [Question 6](2026-09-27-theming-and-typography-evidence.md#question-6-two-registers-spec-and-editorial-and-how-register-relates-to-themes)

## Decisions for the maintainer

Rows 1 to 5 resolve conflicts between the parts. Rows marked "unverified" come from Part 1's follow-up pass, which skipped the two checks. A "lean" is this report's own, not the evidence's.

| # | Decision | Options | Recommendation | Why |
|---|---|---|---|---|
| 1 | Sans size once faces become registers | (a) Sans at about 18px, 63 to 64ch, so a face swap keeps x-height (Question 2). (b) Spec at 16px as deliberate density (Question 6) | (b), with Question 2's measure; the size step serves readers who need more. Trade: Spec paints about 10 percent smaller, below the reading floor where the 18px serif sits at it | A register says what the document is; a face swap is comfort |
| 2 | Chat face versus document register | (a) The chat follows the adjacent document's face (Question 5). (b) A Conversation style owned by the chat | (b): serif 16px / 1.62 beside every register, like margin notes. Cost: a Spec page sits beside a serif chat until a per-person face preference exists | A chat is its own pane beside any document, so "the document's register" is undefined for it |
| 3 | The person's chat turn | (a) Serif at reply size (Question 5). (b) Sans, as today and in claude.ai and Perplexity | (a). Lost cue: face no longer separates speakers; alignment and bubble shape carry it, since the tint is about 1.06:1 | One face per author across notes, draft and chat |
| 4 | Size controls | (a) A manuscript control plus a chat small / default / large. (b) One per-device step for every reading surface | (b): it scales manuscript, notes, composer and chat; chrome follows page zoom. Cost: no chat-only enlargement except zoom | One decision per device, and the chat stays one step under the manuscript at any size. claude.ai and Cursor show only that both chat turns scale together, as both options do |
| 5 | The four defects | Fix now, or fold into theming | Fix now; record chat links as a design flaw. Trade: two chat rules are rewritten when the shared prose rules land | Readers stop seeing a 12px heading and off-system links now |
| 6 | Theming model | Options A to E | B, on D's theme file; C later; E never | Readers lack comfort controls, not palettes |
| 7 | Default body size (Part 1 #1) | 18px, or 19 to 20px | Keep 18px; ship the step | No px value clears the floor on every ordinary Mac setup |
| 8 | One reading scale (Part 1 #26, unverified) | Fixed sizes, or one scale | Headings in em, code and rail ladder from one scale | Otherwise a larger body puts h3 below body text |
| 9 | Measure unit (Part 1 #4) | px or rem, or ch per face | ch per face; decouple the page block first | A px measure gives sans lines about 81 characters at 18px |
| 10 | Mono (Part 1 #7, #8) | System mono, or Source Code Pro | Vendor it; subset Source Sans 3 to pay | Completes the family at near-zero net bytes |
| 11 | Safari 16.4 marks (Part 1 #19) | Raise the floor to 17.2 (XS), or a DOM fallback (M) | Lean: raise the floor, unless 16.4 readers matter | A 16.4 reader sees no marks and no warning; raising the floor is the smaller change |
| 12 | Custom fonts (Part 1 #23) | Font folder, installed names, or both | Folder first; installed names in the shell and Chromium | Safari hides installed fonts from all CSS matching |
| 13 | Chat size versus column | 16px or 17px, both capped near 36rem | 16px | A visible step below the 18px manuscript; 17 is one pixel from 18. Cost: 16px sits further under the reading floor (0.178 against 0.188 degrees on a laptop). The 95-character lines of 17px on today's 46rem are the column's fault |
| 14 | Addresses reaching the agent | (a) The daemon derives §2.3 from the source map while building the delivery and adds an `address:` line; nothing is stored. (b) The SPA writes the label it shows into the posted note, kept in the immutable inbox entry. (c) Drop the intent; the label stays human-side | A product choice; the evidence does not pick. With (a) or (b), send address and quote together: the quote stays the anchor (the authoritative locator), the address a hint | (a) keeps "derived, never stored" but duplicates the numbering rule outside the SPA. (b) is cheaper, but a label that renumbers on edit becomes permanent in the record |
| 15 | Where the workspace default register lives | localStorage per device, or daemon-side workspace metadata | Lean: daemon-side. The evidence leaves it open | It follows the folder into the shell and every browser. Cost: a per-reader preference moves into shared metadata, while per-document choices stay per device |
| 16 | Stability of the shipped look (Part 1 #34, unverified) | Retune freely, or protect | No change to provenance hues, faces, body size or measure without an opt-back path (a way back to the old look) and a changelog line. This binds this report's changes too, such as the sans measure and the chat's serif | The clearest cases of leaving follow a change to an adopted look |

Also in the evidence, by Part 1 number:

| Group | Decisions |
|---|---|
| Typography | paragraph gap (#5), heading weights (#6), dark small sizes (#13), manuscript tables (#27) |
| Fonts and controls | second serif (#9), Atkinson Hyperlegible Next (#10), preset names (#11), control placement (#12), sepia (#14) |
| Theme files | theme file format (#15), Base16 (#16), custom CSS (#17) |
| Surfaces | readiness fixes (#18), `html lang` (#22), agent-login terminal (#24), diff fonts (#25), class F (#28 to #30) |
| Rules and tests | tests (#20), hue distances (#21), print (#32), system-setting guard (#33) |

## Build order

Phase 1: bugs, and the token and plumbing debt every later option needs.

- The three bugs and the chat-link flaw (XS each). A new `--on-danger` token fixes the danger bug.
- Theme-readiness, Part 1 #18 (M): an unconditional diff remap, elevation tokens, one scheme list, and the shell's window colour and theme source. The theme source needs a new page-to-shell call, amending A3 §4b (the security appendix's allowed calls).
- `html lang` per document (S); the Safari floor (XS) or a fallback (M).

Phase 2: one reading scale and the size step.

- Tests owed first: 200 percent zoom and the WCAG 1.4.12 text-spacing override (a reader forcing wider spacing) (S).
- One reading scale (M) and the page block decoupled from the rail (M).
- One per-device text-size step for every reading surface (M); h4 never below body (XS).

Phase 3: registers and the conversation.

- One prose rule set for manuscript and chat (M), then the Conversation style (S).
- Editorial, Spec and Mono registers (M) with a workspace default (S).
- Source Code Pro and the Source Sans 3 subset (S each); the hover-in delay (XS).

Phase 4: appearance variants on a validated theme file.

- The theme file loader and validator, with a test that a lowered ink is refused by name (M).
- High-contrast light and dark (M); measure and line-spacing controls, then presets (S each).
- A theme for the agent-login terminal (S). Diff fonts and the shell's blocking page, the light "run this in a terminal" screen (XS).

Phase 5: on request.

- The font folder, then installed-font names (M).
- Literata, the second serif (S), the Base16 importer (M), custom CSS (S), "Show all addresses" (S).
- Agent addressing, sized once Decision 14 picks a route: about M for (a), S for (b).

## Not covered

- **Polish typesetting** (limit of the approach: English-only evidence). Unchecked: one-letter words can end a line. „…” quotes need hanging punctuation (quotes set outside the text edge). Hyphenation needs `lang="pl"`. In a two-line h1, capital acutes may meet the ogonek (the hook under ą and ę) of the line above.
- **Marks and washes across themes** (design flaw in the protection model). Floors protect solid colours only. Today's translucent hand underline composites to about 3.3:1 on paper. A theme whose hand just passes 4.5:1 would drop its line under 3:1.
- **High-contrast values** (a gap in the first release). No token values exist yet. The validator does no gamut mapping (fitting colours into a screen's range) for P3 screens (the wider colour range of Mac displays). macOS Increase contrast is unchecked in the shell and Safari.
- **Gaps in the reading evidence.** No source rates the mono, code blocks or manuscript tables, though engineers are a named audience. No study measures hours of reading; the serif studies are small, on 96 dpi screens. The literature is silent, not null.
- **Probe reach.** Safari was not probed, and surface probes used a stand-in server. A likely font block inside class F is unconfirmed against the daemon.

## How this was researched

- Every source was read directly: product help pages, release notes and stylesheets; the papers themselves; the font files; the token values.
- Every claim a recommendation depends on was checked twice: against its source, and for whether it applies to glosa's readers and constraints. Contested claims appear in their weaker form; a claim failing both checks was dropped.
- Part 1's two follow-up strands, surfaces and user voice, came after a completeness review and did not go through the two checks.
- The four re-measured code defects (see Fix first) override the evidence where it disagrees.
- Code references in both documents are to main at 8ed3767 (v0.1.0-alpha.36), which includes the print rework merged in #398.

| Part | Claims checked | Confirmed | Contested | Dropped |
|---|---|---|---|---|
| Part 1 (Questions 1 to 3) | 16 | 4 | 12 | 0 |
| Question 4 | 8 | 2 | 5 | 1 |
| Question 5 | 10 | 6 | 4 | 0 |
| Question 6 | 8 | 6 | 2 | 0 |
| Code defects, re-measured | 4 | 4 (chat links reclassified: a design flaw, not a bug) | 0 | 0 |
