# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.38] · 2026-10-02

### Added

- OpenAI dictation with a secure API key in Settings, native browser recording, automatic English,
  Polish, German and Spanish transcription, visible-context control and optional cleanup.
  Microphone icon controls serve the four prose composers. Failed or cancelled requests preserve
  drafts. The unused Wispr integration is removed; API contract 2.0 replaces its session route.
- An off-by-default, per-provider Account settings choice for experimental managed Claude and Codex
  chats on supported macOS and Linux hosts. Acceptance is tied to the pinned runtime and recorded
  locally; turning it off stops active work. Native and release qualification remain pending (#435).
- Experimental Linux dictation through Secret Service credentials and per-attempt desktop microphone
  permission. Locked wallets fail without background prompts; cancellation preserves drafts and
  stops capture and transport. Manjaro/KDE and paid-provider qualification remain pending (#434).
- Pinned Claude Code and Codex runtime candidates for Linux x86_64/glibc, with frozen locks,
  platform-specific identities and verified staging before repair. Existing runtime installations
  require explicit reinstall; their directories, account profiles and chat history are preserved.
  Candidates remain unqualified; managed chats require explicit experimental acceptance pending
  native and release checks (#433).
- An unpackaged desktop shell now uses its checkout's CLI and its own Electron profile, so it can
  run beside an installed app without sharing the recorded executable or browser data. The bundled
  CLI offers `glosa install select` to keep that app selected across later terminal CLI runs, and
  `glosa install auto` to return to automatic recording. A switch waits for any foreign daemon to
  be stopped by the person; it never stops one itself.

### Fixed

- A review request from `glosa request-review` could never be approved. Its card at the passage
  offered Send answer and Can't answer, and both resolved the request as changes requested, so
  `request-review --wait` reported changes requested even when the reply said the text was fine.
  The card now offers Request changes and Approve, as the attention tray does, with an optional
  response that goes back with either one. Questions from `glosa_ask` keep Send answer and
  Can't answer.
- A document an agent presented no longer strands its reader after following "Go to" into another
  document. Opening another document now adds a browser history entry, so Back returns to the first
  one and Forward to the second, in place and without reloading, and a document with unsaved edits
  asks before it is replaced. The navigator is available there too, closed until the reader opens it
  from the corner, and remembers that choice apart from the desk's (#455).

## [0.1.0-alpha.37] · 2026-09-29

### Added

#### Reading and appearance

- A note delivered to a session now names its passage the way the page does: an `address: §2.3`
  line beside the quote and an `address` field in the entry's detail. glosa works the label out
  from the document at the moment of delivery and stores it nowhere, so after an edit that
  renumbers the page the next delivery says the new one. The quote stays the anchor. A note whose
  words are gone, a note on an HTML document and a note inside a `%%` comment get no address.
  Managed chats now receive notes the same way, resolved against the document, where before every
  note reached them unresolved. API contract 1.20 (#411).
- A browser that cannot paint marks on a document's words now says so. Every mark (a note's
  underline and wash, a session's question or pointer) is drawn with the CSS Custom Highlight API,
  and without it the page showed no marks and no warning. Such a browser now shows one notice
  across the top of the page, however many documents are open: "This browser can't show marks on
  the page. Use Safari 17.2 or later, or Chrome." Notes still list in the margin (#412).
- A text size for reading, chosen per device: 15, 16, 18, 20, 22 or 24, with 18 the default. It
  sets the document, its margin notes, the composer and the chat together; buttons, menus, tabs
  and the navigator keep following zoom, and ⌘+ and ⌘− stay zoom. It is in each document's More
  menu, under the face, as "Text size" with a − value + stepper and "Reset" whenever it is not 18,
  and in Settings > Appearance, where it changes the same setting. It applies at once, before the
  page first paints on the next visit, and keeps the paragraph you were reading at the top of the
  pane. Headings, code blocks and tables grow with the text, and h3 stays larger than the text at
  every size. Notes sit two steps under the document and the chat one step under, neither below
  15px (#406).
- A folder can have a default style. Choose a style for any document, then "Use as folder default"
  in the same menu: every document in the folder that has no style of its own opens in it, in every
  browser and in the desktop app, and windows already open on the folder change at once. The menu
  then names it, for example "Folder default: Spec", and a document you set otherwise keeps its own
  style, Editorial included. glosa keeps the default for the folder in `~/.glosa/folder-styles.json`, so it
  survives restarting glosa and reopening the folder. A single file opened on its own has no folder
  default. API contract 1.21 (#407).
- High contrast, light and dark: glosa's own palette with stronger ink, marks and edges on the same
  paper, for `prefers-contrast: more`. When the system asks for more contrast (macOS Increase
  Contrast does in Safari and Chrome), glosa's own palette turns into High contrast at once and
  before the page first paints; it is also a palette of its own in Settings > Appearance, which
  holds with or without the system's request. The desktop app follows macOS Increase Contrast too:
  Electron does not pass it to pages, so the app reads it and tells the page, before the first
  paint of every window and reload and again whenever it changes (#425). Paper, surface and
  sunken ground stay glosa's. High contrast light sets ink `oklch(0.16 0.012 60)`, muted
  `oklch(0.4 0.014 60)`, faint `oklch(0.55 0.012 65)`, border `oklch(0.76 0.01 75)`, strong border
  `oklch(0.5 0.014 65)`, the region rule to the ink, the hand `oklch(0.46 0.16 42)`, pencil
  `oklch(0.5 0.01 65)`, session ink `oklch(0.35 0.11 255)`, danger `oklch(0.38 0.15 22)`, warn
  `oklch(0.5 0.1 80)`, ok `oklch(0.41 0.08 150)` and the scrim `oklch(0.16 0.012 60 / 0.4)`. High
  contrast dark sets ink `oklch(0.97 0.008 80)`, muted `oklch(0.8 0.012 75)`, faint
  `oklch(0.62 0.012 65)`, border `oklch(0.44 0.01 60)`, strong border `oklch(0.7 0.012 65)`, the
  region rule `oklch(0.86 0.01 80)`, the hand `oklch(0.77 0.13 45)`, pencil `oklch(0.72 0.01 70)`,
  session ink `oklch(0.84 0.085 250)`, danger `oklch(0.71 0.15 22)`, warn `oklch(0.84 0.1 80)`,
  ok `oklch(0.82 0.09 150)` and the scrim `oklch(0 0 0 / 0.6)`. Ink and muted text reach 7:1 or
  more on every ground they are drawn on, and the marks 4.5:1 or more as lines (#409).
- Every palette glosa paints, its own light, dark and print included, is now a theme file checked
  against contrast floors before it ships: a theme below a floor is refused with the theme, the
  role, the ratio and the floor named, and no colour is corrected. Light, dark and print paint
  exactly the colours they did before, token for token (#409).
- Settings > Appearance chooses a palette. Its choices sit under three labels, Mode (Use system
  setting, Light, Dark), Palette and Text size; each palette is a row with its paper and ink as a
  swatch, its name and a one-line credit, and the chosen one carries a check. When the system's
  request for more contrast is showing High contrast in place of glosa, a line under the rows says
  so. The page's introduction now spells glosa in lowercase (#409).
- Three palettes made by others, each in light and dark, in Settings > Appearance after glosa and
  High contrast: Catppuccin (Latte and Mocha) by the Catppuccin Org, MIT; Gruvbox (light and dark,
  at medium contrast) by Pavel Pertsev, MIT/X11; and Rosé Pine (Dawn and the main Rosé Pine) by
  mvllow, MIT. Each row carries that credit, and "Palette credits" under the rows opens to say where
  each palette comes from and that its licence is in THIRD_PARTY_NOTICES.md. A palette follows the
  mode, so Use system setting moves between its light and dark theme. It sets the paper, ink, the
  marks and the state colours, never a face, and it stays as chosen when the system asks for more
  contrast. glosa keeps each palette's own colours and moves only those under a contrast floor, in
  lightness within their own hue. Catppuccin Latte: ink `#4c4f69` to `#43455f`, strong border
  (overlay2) `#7c7f93` to `#7c7e92`, pencil (subtext0) `#6c6f85` to `#6a6d83`, the hand (peach)
  `#fe640b` to `#ad4102`, session ink (blue) `#1e66f5` to `#155eec`, warn (yellow) `#df8e1d` to
  `#965c00`, ok (green) `#40a02b` to `#1f7a01` and danger (red) `#d20f39` to `#b9012f`. Catppuccin
  Mocha: ink `#cdd6f4` to `#d8e1ff` and danger (red) `#f38ba8` to `#ff98b4`. Gruvbox light: pencil
  (fg4) `#7c6f64` to `#786c61`, the hand (orange) `#af3a03` to `#ae3903`, warn (yellow) `#b57614` to
  `#905c03` and ok (green) `#79740e` to `#6e6900`. Gruvbox dark: danger (red) `#fb4934` to
  `#ff8774`. Rosé Pine Dawn: muted (subtle) `#797593` to `#6b6783`, pencil (muted) `#9893a5` to
  `#736e7f`, the hand (rose) `#d7827e` to `#a25351`, session ink (foam) `#56949f` to `#3b7984`, warn
  (gold) `#ea9d34` to `#9e6400` and danger (love) `#b4637a` to `#994b62`. Rosé Pine: strong border
  (muted) `#6e6a86` to `#706c87`, pencil (muted) `#6e6a86` to `#87839f` and ok (pine) `#31748f` to
  `#4c8eaa`. Every other colour is the palette's own; each theme file records its source and both
  contrast ratios of every move (#410).

#### Files, desk and platforms

- Create, rename, Trash, undo and asset history from the file tree (#443).
- Browser tabs on the desk in the desktop app: web pages open as dock tabs beside documents and
  chats, from a link, ⌘T, Go to, or the new tools at the end of each tab strip. Pages run apart from
  glosa and cannot reach it; restored internet tabs wait for Load page, and typed words are never
  searched. In a plain browser, links open your own browser instead (#440).
- Chat agents can open, move and read web pages in desk browser tabs while they answer you, marked
  on the tab as theirs. Existing workspace permissions are asked for once more (#440).
- The desktop app builds as an x86_64 pacman package for Arch Linux and Manjaro, experimental. It
  carries its own Bun and the command line; pacman installs Git and the libraries it needs, owns
  `/usr/bin/glosa` and every other file it installs, and removes exactly those, leaving `~/.glosa`
  and your workspaces. `glosa doctor` names the install as `pacman`, and `glosa update` and the app's
  Check for Updates… give the pacman command instead of Homebrew's. Built and tested in Arch Linux
  containers; downloads and Manjaro desktop qualification follow in #435 (#432).
- glosa handles an upgrade or removal while it runs, on every install channel. The background
  process used to keep serving the new files with old code until some command restarted it, and
  after a removal it held its port with its files gone. It now serves only what it started with,
  starts nothing from a changed install, and restarts itself through its normal shutdown once it
  is idle; an open window says "glosa was updated. Reload to use the new version." and reloads when
  you click. A `glosa monitor` started before an upgrade keeps delivering instead of retrying
  forever. API contract 1.23 (#432).
- Local images in Markdown, paste/drop and Insert image, plus image tabs with zoom, pan and
  live updates. Imports preserve bytes up to 20 MiB. Remote images stay blocked; missing or
  refused local images show their description and path (#401).
- Experimental Linux x86_64/glibc CLI and daemon support with Bun 1.4.2+, `xdg-open`, headless
  URL output, Linux boot identity and MCP parent observation. Linux core and installed-package
  checks now run in CI and release validation. Linux desktop packaging, native managed chats,
  dictation and Manjaro release qualification remain pending (#431).
- In a chat's composer, `@` picks a workspace file and `/` picks one of the selected agent's own
  skills or commands. A skill shows as `/name` for Claude Code and Codex alike, and each agent
  receives its own syntax. Valid references are highlighted in the draft and in the history, and a
  reference that no longer resolves is held before sending. An account can also be linked to the
  agent's native configuration, its skills, plugins, hooks and MCP servers, after explicit
  permission for that workspace; unlinking never logs out or deletes that configuration (#427).
- A folder's tree also lists the files glosa does not track, each with a lock and a read-only label.
  Opening one shows its text in a read-only source tab with highlighting, line numbers, search,
  wrapping and copy. The list respects workspace exclusions and `.gitignore`, stops at 10,000
  files, and remembers "All files" or "Documents only" and "Show ignored files" per folder (#448).

### Changed

- Reasoning summaries in chats remain collapsed under “Reasoning summary”, but their expanded prose is
  now muted Source Serif 4 without a Surface box. It follows the reading scale two steps under the
  document: 15px by default, 15px at the floor and 20px at the largest setting. Tool output remains
  a 12px monospace Surface box (#426).
- In Review, a paragraph's § address waits until the pointer has rested on it for 200ms before it
  fades in, so moving down the page no longer blinks a label beside every paragraph the pointer
  crosses. It still leaves as soon as the pointer does, keyboard focus still shows it at once, and
  headings still always show theirs. Under reduced motion it appears without the fade (#411).
- The lowest supported Safari rises from 16.4 to 17.2, the first Safari that paints marks through
  the CSS Custom Highlight API. Every macOS glosa supports can run it: Apple ships Safari 17.2 for
  Monterey, Ventura and Sonoma, and later releases come with a newer Safari. The lowest supported
  Chromium stays at 111 (#412).
- In the light appearance, the diff and Version history panes sit on glosa's paper with its rules and
  state colours instead of diff2html's own palette, as the dark appearance already did. Line-number
  gutters and tags go from `#ffffff` to the paper, `#fefbf7` (`--bg`); rules from `#dddddd` and
  `#eeeeee` to `#dbd7d0` (`--border`); line numbers from black at 30% to `#625952` (`--muted`); the
  file header and hunk rows from `#f7f7f7` and `#f8fafd` to `#f7f5f1` (`--surface`), the header's
  rule from `#d8d8d8` to `#867f78` and the hunk rows' from `#d5e4f2` to `#dbd7d0`. An added line's
  bed goes from `#ddffdd` to `#d1dcce` (`--ok` 22% into paper, mixed in OKLab), its changed words
  from `#97f295` to `#b7cab6`, its rule from `#b4e2b4` to `#a4bca4`, its label from `#399839` to
  `#397247`. A deleted line's bed goes from `#fee8e9` to `#f2d5d0` (`--danger` 18%), its changed
  words from `#ffb6ba` to `#e8b8b2`, its rule from `#e9aeae` to `#e0a39d`, its label from `#cc3333`
  to `#a51d2b`. A replaced pair goes from `#fdf2d0` and `#ddeedd` to `#e9dfce` and `#d5dfd1`, its
  label from `#d0b44c` to `#8d6300`; a selected line from `#c8e1ff` to `#d0ccc7`; the moved label
  from `#3572b0` to the ink, `#1a1511` (#405).
- In the dark appearance, the diff's tints are mixed in OKLab instead of OKLCH, so an added and a
  deleted line are told apart by colour again, not only by `+` and `−`. An added line's bed goes
  from `#2e271e` to `#2e352a`, its changed words from `#4b432d` to `#3b4838`, its rule from `#575235`
  to `#445843`; a deleted line's bed from `#2f2219` to `#3b2623`, its changed words from `#553525` to
  `#563330`, its rule from `#6a3f2c` to `#6b3c39`; a replaced pair from `#392c21` and `#372e22` to
  `#372d20` and `#2d3228` (#405).
- The desktop app's window follows glosa's appearance. A window opened while glosa is in Dark
  starts on the dark paper, `#1a1614`, instead of white, `#ffffff`, and in Light on the paper,
  `#fefbf7`; before any window has shown glosa, a new window starts on the paper of macOS's own
  scheme. Native dialogs, menus and the title bar follow glosa's Light or Dark instead of macOS's;
  Use system setting still follows macOS. The Dock icon keeps following macOS (#405).
- h4, h5 and h6 in the default serif go from 17px at weight 600, smaller than the 18px text under
  them and no heavier than bold text, to the text's own 18px at weight 650, in print as well. In
  the Sans and Mono faces they stay 17px at 600 (#406).
- A page set in Sans has a shorter line, 64ch instead of 68ch. The sans fits more letters into a
  `ch`, so at 68ch its lines ran longer than the serif's on the same text (79 characters at most
  against 75, 65 on average against 61); at 64ch they match. Serif and Mono keep 68ch (#406).
- A chat reply goes from 15px to 16px, one step under the document's 18px, and so do the person's
  own messages and the draft (both sans, 15px before). A `###` inside a reply grows with it, from
  17.55px to 18.72px; code blocks in a reply stay 12px at the default size (#406).
- The note rail is laid out around the document column as it paints, not a 707px estimate. At the
  default size in the serif the column is 688px, so the rail opens from a 1186px pane instead of
  1205px, reaches its full 320px at 1344px instead of 1363px, and Review asks a split for 1271px
  instead of 1290px. The Edit column's toolbar and Save row are 688px wide instead of 707px, and
  the note dots beside the text sit 9.5px closer to it (#406).
- In every style, a table with a word too long for any of its columns (a digest, a long path or URL)
  now breaks that word inside its cell, so the table fits the page, on screen and in the editor as it
  already did in print. Before, such a word ran past the line, and past the pane's edge it was cut
  off where nothing could scroll to it. Tables whose words fit keep them whole, as before (#407).
- The "Manuscript face" group in each document's More menu is now "Style", and its rows Default,
  Sans and Mono are now Editorial (Serif), Spec (Sans) and Mono. A style sets the whole page, not
  only its face: size, leading, headings, the gap between blocks, tables, code and line length.
  Editorial and Mono pages otherwise look as they did, and each document keeps the choice it had: Sans is
  Spec, Mono is Mono. Choosing Editorial is now kept as a choice of its own, where choosing Default
  used to leave nothing behind (#407).
- A page set in Sans is now set in Spec, a denser page for specifications, with one heading weight
  and its own ladder; the table below gives each value at the default text size, and every value
  moves with the text size. A wide table or code block now widens past the line to about 96ch,
  centred on the column, but only into room the pane has beyond a full note rail: at the default
  size it starts to widen in a pane about 1230px wide and reaches 96ch at about 1485px. So widening
  never takes it to the rail, and entering Review moves nothing. In a narrower pane it stays on the
  line as before (#407).

| Value | Before (Sans) | After (Spec) |
|---|---|---|
| Leading | 1.6 | 1.5 |
| Gap between blocks | 1.2em (19.2px) | 1em (16px) |
| h1 | 30 to 40px, 650, leading 1.1, 32px below | 32px, 650, leading 1.2, 24px below |
| h2 | 24 to 26px, 620, 48px above and 12px below | 24px, 650, 36px above and 8px below |
| h3 | 20px, 620, 32px above and 8px below | 20px, 650, 28px above and 8px below |
| h4 | 17px, 600, leading 1.4, 24px above and 8px below | 17px, 650, leading 1.35, 24px above and 6px below |
| h5, h6 | 17px, 600 | 16px, 650, spaced as h4 |
| Tables | 15px sans, a 13px muted head at 600 | 16px sans, a 16px ink head at 650 |
| Inline code | 0.85em | 0.9em |
| Code blocks | 13px, leading 1.6 | 14px, leading 1.5 |
| Line length | 64ch | 64ch for prose; a wide table or code block up to about 96ch |

- The chat has one style of its own, Conversation, whatever style the document beside it is in, so a
  Spec page sits beside a serif chat. A reply, your own messages and the draft are all set in the
  serif, and a reply's headings, lists, quotes, code, tables and links take the document's rules.
  The reply's column narrows to 34em of its text, 544px at the default text size, about 72
  characters a line, and the composer, which was wider, now matches it, as does a decision waiting
  on you. Your messages keep to the column's right edge in their bubble, which is how they are told
  apart from a reply now that both are serif. The table below gives each value at the default text size; every value moves with the
  text size, and no heading in a reply is ever larger than the document's h3 (#408).

| Value | Before | After |
|---|---|---|
| Reply text, and a turn's error | Serif 16px / 1.7 | Serif 16px / 1.62 |
| Gap between a reply's blocks | 0.6rem (9.6px) | 0.9em (14.4px) |
| Reply column | 46rem (736px) | 34em of the reply (544px) |
| Composer, and the lines under it | Up to 48rem (768px) | The reply's column |
| A decision waiting on you | Up to 48rem (768px), edge to edge in a narrow chat | The reply's column |
| Your message | Sans 16px / 1.6, bubble up to 36rem (576px) | Serif 16px / 1.62, bubble up to 28em (448px) |
| Draft | Sans 16px / 1.55 | Serif 16px / 1.62 |
| Reply headings | Sans at the browser's sizes, h1 32px, h2 24px, h3 18.72px, h4 16px, h5 and h6 serif 13.28px and 10.72px, all at 700 | Serif, h1 and h2 20px and h3 18px at 620, h4 to h6 16px at 650 |
| Bold in a reply | 700 | 600 |
| Inline code | The browser's monospace at 16px, no background | Mono at 0.85em (13.6px) on `--surface` |
| Code blocks | 12px on `--surface-sunken`, 5px corners | 13px on the document's code bed: `--surface`, a hairline edge, 8px corners |
| Tables | Unruled: serif 16px, a bold head, any word broken where a column squeezed | Ruled, sans 14px, a 13px muted head at 600; a word breaks only when it is too long for any column |
| Lists and quotes | The browser's 40px indents; quotes upright in ink | Lists indented 1.5rem with muted markers; quotes on a rule, in muted italic |
| A `---` rule | The browser's full-width line | The document's short centred rule |
| The chat's scrollbar | The browser's, on the right only | Thin, in the desk's colours, with the same room kept on both sides so the column stays centred over the composer |

- The primary action's hover (Send, Save, Approve) is now the theme's own ink moved toward its own
  paper, 18% in light and 12% in dark, mixed in OKLab, instead of one fixed colour per scheme. Under
  a palette the button keeps its ink's colour when hovered and always visibly changes; Gruvbox
  light's did not change at all. glosa light goes from `oklch(0.34 0.012 60)` to about
  `oklch(0.342 0.011 63)`, glosa dark from `oklch(0.84 0.01 80)` to about `oklch(0.843 0.01 78)`,
  High contrast light from `oklch(0.34 0.012 60)` to about `oklch(0.309 0.011 63)` and High
  contrast dark from `oklch(0.84 0.01 80)` to about `oklch(0.878 0.008 78)` (#410).
- In the dark appearance, a destructive action's hover lifts its crimson 12% toward white instead
  of darkening it 12% toward black, so its dark-paper label gains contrast under the pointer rather
  than losing it: 4.6:1 to 7.2:1 in glosa dark and 4.7:1 to 7.5:1 in High contrast dark, where
  Rosé Pine's would have fallen to 4.4:1. The light appearance is unchanged (#410).
- The desktop app's Check for Updates… now checks, and has moved from the Help menu to the glosa
  menu, under About glosa. A click asks GitHub once for glosa's releases and says in a dialog either
  "glosa 0.1.0-alpha.37 is available. You have 0.1.0-alpha.36." with Open Release Page, Copy
  Upgrade Command (which copies `brew upgrade --cask glosa`) and Later, or that you have the newest
  version, or that the check could not complete, with Open Release Page. A release counts only once
  the app for your Mac's architecture is uploaded to it. Nothing is checked at launch or in the
  background, the request carries neither glosa's version nor anything about your machine, and
  nothing is saved. The app still installs no update itself (#424).

### Fixed

- A document's More menu stayed open after its tab was left, so switching back showed the menu
  still open. Leaving by Ctrl+Tab or Ctrl+Shift+Tab did it everywhere, and so did pressing another
  tab in Safari. The menu now closes whenever its tab is left, however that happens.
- With Reduce Motion on, the notes tray at the foot of a narrow document still slid open and
  its chevron still turned. Both now change at once, like the rest of glosa under that setting;
  colour fades on hover stay, since they do not move anything.
- In the dark appearance, the button that confirms a destructive action (Delete chat, Discard
  edits, Restore version) set its label in near-white on the lifted crimson at 2.8:1, below the
  4.5:1 WCAG AA asks of a 13px label. It now uses the dark paper colour: 6.3:1 at rest and 7.2:1
  while hovered. The light appearance is unchanged at 7.3:1.
- A `###` heading inside a chat reply rendered at 12px, smaller than the reply's 15px text, because
  the style for the label above each message also reached headings inside the reply. It now renders
  at 17.55px, larger than the text it heads.
- Code in a fenced code block rendered at 11.05px, 0.85 of the block's 13px, instead of the 13px the
  design system sets for code blocks. It now renders at 13px. Code inside a line of prose keeps its
  0.85em.
- Links in a chat reply used the browser's default blue, rgb(0, 0, 238) in light and
  rgb(158, 158, 255) in dark. They now take the page's ink with the same muted underline as links in
  a document.
- With the browser's default font size at 20px, the note rail covered the right edge of the
  document by about 58px in every pane from 1205px to 1363px wide, and by less up to about 1480px,
  and the note dots sat inside the text: the column paints 843px there, and the rail was placed
  around 707px. The rail now opens only once the pane holds it beside the column, from 1341px at
  that font size, and the dots ride the column's real edge (#406).

## [0.1.0-alpha.36] · 2026-09-27

### Fixed

- Print / Save as PDF includes the complete Markdown manuscript across pages, without clipping
  to the docked pane’s screen dimensions. It preserves the selected reading font on white paper,
  uses 12 pt body, code and table text, and adds a clear heading scale, wrapping code, repeating
  table headers and page numbers. Chromium’s automatic date, title and workspace URL decorations
  are suppressed. The print layout has been checked against a reusable synthetic Markdown specimen
  in all three fonts, both themes and A4/Letter paper (#340).

## [0.1.0-alpha.35] — 2026-09-27

### Added

- The desktop app has a Dock badge and notifications. The badge counts what waits on you across every
  workspace: attention requests and chats waiting on a decision. While the app is not in front, it
  notifies you when an agent asks a question, a review or an approval, when a chat starts waiting on
  a decision, and on a desk window when a chat reply finishes. Clicking a notification brings its
  window back; the same event is never shown twice (#391).
- The desktop app can reveal a document in Finder: File, Reveal in Finder (⌥⌘R), or a document
  pane's More menu. The page sends no path; the app works out the file from its own window and
  refuses anything that resolves outside the workspace folder. The window's folder is now the
  workspace's own folder from `glosa open`, so the title bar's proxy icon is right for a relative or
  single-file target and after the window switches workspace (#160).
- The daemon reports attention across every workspace, for the desktop app's Dock badge and
  notifications. `GET /api/workspaces` rows carry `attention_count`, the same number that
  workspace's attention tray shows, and `decision_count`, its chats waiting on a decision. Every
  workspace stream now also says when any workspace's attention changes (`attention_changed`), and
  `chats_changed` names the workspaces whose chats changed. API contract 1.19 (#389).
- The desktop app answers `glosa://open?path=…` links, and `glosa open --json` and `glosa_present`
  now return the same open as `app_url`. A link carries a folder, an optional document, the surface
  kind and the mode, never a token: the app mints its own. It asks before opening a folder no window
  shows, and a companion link beside a desk window on the same folder opens its own window (#392).

### Fixed

- The desktop app's install instructions (the cask caveats, the README and `docs/release.md`) now
  say what to do when `xattr -dr com.apple.quarantine /Applications/glosa.app` answers "Operation
  not permitted": macOS's App Management protection needs the terminal allowed to change apps, under
  System Settings, Privacy & Security, App Management (#371).

## [0.1.0-alpha.34] — 2026-09-26

### Fixed

- The desktop app's Intel build is now smoke-tested where it can run. Bun's x64 build for macOS
  needs AVX, and Bun publishes no build without it; the release job ran the Intel app under Rosetta on
  a macOS 14 runner, which cannot execute AVX, and it crashed with "CPU lacks AVX support". The app
  build and its smoke now run on macOS 15, whose Rosetta can, and pull requests that shape the bundle
  smoke both architectures instead of arm64 alone. Every Intel Mac that runs macOS 13 has AVX, so the
  Intel app itself was never the problem. v0.1.0-alpha.33 reached npm, but that crash stopped its app
  build, so it carries no desktop app either (#371).

## [0.1.0-alpha.33] — 2026-09-26

### Fixed

- The release build of the desktop app no longer depends on Electron having been launched first.
  Bun can restore Electron from its install cache without running Electron's postinstall, which
  downloads the Electron binary, so `packages/shell/scripts/package-app.ts` now runs Electron's
  installer itself when the binary is missing. v0.1.0-alpha.32 reached npm, but its app build
  stopped on the missing binary, so that release carries no desktop app (#371).

## [0.1.0-alpha.32] — 2026-09-26

### Added

- `glosa update` recognises an install made by a Homebrew formula (`homebrew`, anything under
  `Cellar/glosa/`) and answers with `brew upgrade glosa` instead of rewriting files inside brew's keg
  (#371).
- The Homebrew tap gains a `glosa` formula next to the cask: `brew install davebream/tap/glosa`
  installs the command line alone, on Homebrew's Bun, with a wrapper that keeps it working on a bare
  `PATH`. `scripts/cask-bump.ts` renders both files from one release and commits them to the tap with a deploy key;
  `--dry-run --formula` prints the formula. Install the cask or the formula, not both: each links
  `glosa` (#371).
- A tagged release builds the desktop app for Apple Silicon and Intel, smoke-tests it, and uploads a
  DMG and a zip per architecture plus `SHA256SUMS` to the GitHub release, then updates the Homebrew
  tap. Without Developer ID secrets the app is signed ad hoc: it works, and macOS asks
  each person to allow it once after install and each upgrade, which the cask caveats and the README
  explain. With the secrets it is signed and notarized. The `released` gate now fails a tag whose app
  did not build. `docs/release.md` lists the secrets, the one-time Developer ID setup, the signing switch
  and how to check a shipped build (#371).
- `scripts/cask-bump.ts` renders the Homebrew cask for a desktop-app release from the
  release's `SHA256SUMS` and commits it to the `davebream/homebrew-tap` tap. The
  cask links the CLI the app carries, never writes into agent configuration and never removes
  `~/.glosa`. `docs/release.md` describes the tap, the `HOMEBREW_TAP_DEPLOY_KEY` secret and the manual
  fallback (#371).
- The desktop app can be packaged: `bun run --cwd packages/shell package` builds `glosa.app`, a
  DMG and a zip per architecture. The app carries Bun at the repository's pin, the CLI, the daemon
  and the SPA exactly as npm publishes them, and their production dependencies, so it needs nothing
  else installed (#371). Pull requests that change what the bundle is made of build it unsigned in
  CI and smoke-test it from a copy outside the checkout with no Bun on `PATH`. No signed build is
  published yet: that needs a Developer ID.
- The desktop app finds its CLI in a fixed order: `GLOSA_SHELL_CLI`, the recorded executable under
  `GLOSA_HOME` (or `~/.glosa`), the CLI a packaged app carries, then the well-known bin
  directories. A terminal install keeps ownership; a packaged app on a machine with nothing
  recorded runs the CLI it ships with (#371).
- `glosa doctor` gains an `install` row: which install this CLI is, which one is recorded at
  `~/.glosa/bin/glosa` (the one the Claude Code plugin and the desktop app run), and every other
  glosa it can see. It warns when another install is recorded or nothing is, and never fails
  (#371).
- `glosa update` recognises a CLI running inside the desktop app (`app-bundle`) and answers with
  `brew upgrade --cask glosa` instead of trying to upgrade brew's tree. That CLI records itself as
  the machine's glosa at `~/.glosa/bin/glosa` only when no install is recorded yet, so a terminal
  install keeps ownership, and it records the app's own launcher rather than a script that needs
  `bun` on `PATH` (#371).
- The desktop app is called glosa everywhere the system shows a name: the Dock, the app switcher, the
  menu bar and the About panel. Unpackaged runs get this from a post-install step that rebrands
  Electron's own bundle; packaged builds from the product name.
- **Desk and companion are different surfaces.** A link now says which kind of surface it opens
  (`kind=desk` from a plain `glosa open` or the desktop app's folder picker, `kind=companion` from
  `glosa open --bind` and `glosa_present`). A companion surface shows the terminal agent's
  connection, the margin and the inbox; a desk surface shows chats, stars and projects and no
  connect control. A link without the parameter opens a companion surface, as every older link did.
- Folder rows in the document tree carry a folder glyph, closed or open, instead of a chevron.
- The desktop app's Dock icon follows the system appearance and the comma sits at 37% of the
  squircle, centred.
- `GLOSA_MANAGED_PREVIEW=1` in a daemon's environment opens managed chats for that daemon only, so
  a maintainer can produce the attended evidence the release gates require. The public default is
  unchanged.
- **Desktop shell skeleton** (`packages/shell`, #160): an Electron window on the daemon-served SPA
  with a native folder picker, pairing over a preload bridge instead of the URL fragment, a
  loopback-only egress gate and a denied-by-default top frame. Unpackaged and unpublished; not a
  root workspace member, so nothing else pulls Electron in. The SPA asks that bridge for a
  presentation token only when it has none and is not already paired.
- **Chats have their own workspace list and content tabs.** Existing terminal sessions open as
  explicitly selected external chats; pending message IDs survive the navigation migration.
- **Managed Claude and Codex integration is implemented behind a closed release gate.** It includes
  private account profiles, pinned runtime installation, native login terminals, durable chat
  history and drafts, tool decisions, workspace feedback and MCP configuration. Public managed
  execution remains unavailable until both providers pass native account-isolation and lifecycle
  qualification and the Claude subscription-integration release determination is recorded.

### Changed

- The desktop shell's version and its minimum daemon version are release-synced sites: a tag bumps
  both to the release version, because a packaged app will carry the CLI and daemon of its own
  release (#371). The contract for that bundle is recorded in `docs/decisions.md`: the recorded
  executable stays the install of truth, and the app's own CLI records itself only when nothing is
  recorded.
- **The navigator's sections are one construction.** Artifacts, Chats and Starred share the tree's
  drawn chevron in the same slot at the same x, one label style and one hover; the Chats header no
  longer borrows the chat pane's bordered button, and its menu and New chat controls are drawn at the
  star's size. The Chats rule sits directly under the tree with its heading on it, Settings rides the
  foot strip beside the navigator's toggle, tree rows drop their file and folder glyphs and indent
  12px per depth so long names keep more of the column, chat rows take the tree row's shape, and a
  failed chat action says what it was doing before the reason.

### Fixed

- **A glosa process that outlived a source change no longer evicts every daemon it spawns.** A
  monitor or MCP server started before a merge kept the build id it computed at start, saw each
  freshly spawned daemon as a different build, restarted it, and failed after its one spawn attempt.
  The tree on disk now breaks the tie: a daemon that matches the install is used, and the stale
  client says so once in the daemon log. (#360)
- **A hand-wrapped paragraph keeps its shape when it becomes editable.** The rich face keeps a
  source line break inside a paragraph as a newline so the file's wrapping survives a save, but the
  editor drew that newline as a line, so a paragraph wrapped at eighty columns re-wrapped at every
  source break the moment it opened for editing and pushed the rest of the page down. The break is
  now drawn as the space Preview shows, and typing or deleting beside it no longer lets the browser
  turn it into a space.
- **Fresh managed accounts reach the sign-in state.** Claude's valid signed-out response is
  recognized even when its CLI exits with status 1. Codex accepts the pinned runtime's exact
  serialized defaults while rejecting changed endpoints and inherited configuration overrides.
- **An artifact whose name has a space, an accent, or a character such as `+`, `#` or `%` now
  opens.** Clicking it in the tree, or opening the link glosa prints for it, answered "This
  artifact couldn't be opened", because the daemon never undid the escaping the app applied to the
  name. That covered every such path, including any non-ASCII name. A Markdown or text file with
  one of these names now also saves from Edit mode, and a rendered HTML preview embeds.
- **A file with more than one hard link opens under the name you gave it.** macOS sometimes
  reports a hard-linked file by one of its other names, possibly in another directory. `glosa open`
  then registered or focused that other path, and `glosa open <dir> <file>` could refuse the file
  as outside the workspace. glosa now takes the directory from the path you opened and keeps the
  file's own name in it.

## [0.1.0-alpha.31] — 2026-09-23

### Added

- **Two agents can work on two different files in one workspace at the same time.** A workspace
  allowed one agent to apply a change at a time, whatever it was touching, so a second agent on an
  unrelated file waited for nothing. An agent now claims the entry or the file it is working on, and
  only an agent reaching for the same file is refused. `glosa claim` and `glosa release` (and the
  `glosa_claim`/`glosa_release` MCP tools) take and give up a claim directly; `apply-begin` still
  works and claims the one entry.
- **An agent that is refused is told who got there first.** It used to learn only that "an
  apply-lease is already active". The refusal now names the session holding the file, since when, and
  until when, and an entry delivered to a second agent says the same thing before it tries.
  `glosa inbox list` shows who holds each entry.
- **An agent learns right away when a person takes its file over.** When your save or dismiss
  overrides an agent's claim, that agent gets a notice through its Claude monitor or Codex thread, or
  with its next `glosa_inbox_pull`. It no longer finds out only when its resolve is refused. Other
  agents on the workspace are told when a claim is taken or given up. `glosa_signal_ack` acknowledges
  a notice pulled over MCP.
- **The workbench shows which agent is working on a file.** A tab whose file an agent has claimed
  carries a badge naming the session and since when. The paused Edit button and the card of a note
  an agent is applying say the same.

### Changed

- **At desktop width the rail holds only notes that still sit beside their words.** Notes a
  session applied, closed or dismissed, and open notes whose passage is gone, now live in a drawer
  at the foot of the rail. Its strip counts them ("1 lost its place · 3 resolved"), and "N applied"
  in the line under the page opens it. "Clear all" clears the settled ones at once. A question
  from a session now sits beside the passage it asks about, and can be clicked there.
- **Your save wins over an agent's claim.** Saving a file an agent was in the middle of changing used
  to be refused, which left you unable to save your own document until the agent finished. The save
  now goes through: what the agent had left on disk is recorded as a change nobody can be credited
  for, you are credited with exactly what you typed, and the agent is told a person took over.
  Dismissing an entry an agent is working on does the same. If another program writes the file in the
  instant you save, you now get the Keep mine / Take disk / Compare choice again instead of a save
  that no longer matches the file.
- **A claim ends when its agent goes away.** An abandoned apply blocked its files for fifteen
  minutes. A claim now also ends two minutes after its session stops responding, and the journal
  names the session that abandoned it.
- **Only the file an agent is working on pauses editing.** The editor paused every open file while
  any agent applied a change; it now pauses the files that agent claimed.
- **The kind of change a note asks for is now a set of radio buttons.** "Change the words", "Wrong
  label or split" and "Fix how it looks" were three outlined pills, which look like tags you can
  pick several of. The chosen one differed only by a darker outline and bolder text, and the bolder
  text was wider, so the row shifted every time you picked. They are now radios in one row: one
  filled dot says which is chosen, and nothing moves. The keyboard gets one stop instead of three,
  the arrow keys move between the choices, and a screen reader announces "1 of 3, checked".
- **A session's question is marked beside its paragraph, and its words are highlighted.** The mark
  was an outline squeezed around the exact words. It ran into your underline on the line above,
  its "asks" label covered that line's words, and the answer box opened over the rest of the
  paragraph. Now a bracket in the left margin spans the paragraph, a tab on it sits at the line the
  question starts, and the words themselves are highlighted in the session's colour (a dotted
  underline when it only points). The "Claude Code asks" label sits in the page margin when there
  is room. The answer box opens under the paragraph instead of over it.

### Fixed

- **The margin rail no longer paints its "Resolved" heading over the first note, or stacks
  notes on top of each other.** The heading sat in the page flow while every note was placed by
  position, and a note that gained its "Lost its place" line was measured before it grew.
- **A note the session applied no longer warns "Lost its place".** Applying a "Change the words"
  note removes the words it quoted, so every success showed the warning. It now says "Applied.
  The passage now reads differently." in grey, and "nudged ×N" is gone once a note is finished.
- **A Clear that fails no longer turns a finished note back into open work.** It keeps its state
  and says "Couldn't clear — try again".
- **The dictation button now appears when you open a note.** With Wispr Flow configured and the
  provider reporting ready, no dictate control was ever drawn — in the note composer, the
  conversation composer, an agent question's answer, or the attention tray. The control is created
  for a field the moment that field is built, and it was being discarded in the same breath: the
  code that clears away controls whose field has left the page could not tell "gone" from "not added
  yet", and a composer builds its form before putting it on the page. Nothing was wrong with your
  configuration; the button was removed a fraction of a second after it was made.
- **A second agent resolving an entry someone already closed is refused instead of silently
  ignored.** It used to get a success for a change that was discarded, after taking a checkpoint
  credited to it. It is now told the entry is closed and by whom, and nothing is written. An agent
  repeating its own resolve gets its original answer back.
- **Changes are attributed file by file.** An agent's apply recorded everything that changed in the
  workspace while it held the lease, including other files other programs touched. It now records
  only the files it claimed, and marks its change as unattributable if something else wrote those
  files in the middle.
- **Passage numbers no longer run off the edge of a narrow pane.** In a window 640px wide or less,
  the page's side margins were cut from 2rem to 1rem. The margins are where the page's marks sit:
  the § addresses and a session's tab on the left, the note dots on the right. So the addresses
  landed past the pane's edge and showed as a stray digit. The margins now keep their full width,
  and the title and section headings shrink with the pane, so a short title no longer breaks into
  three lines of display type. Two other fixes land at the foot of the page. The provenance line
  under it now spans the same width as the text, where before it sat in a narrower column set in
  from both edges. And when the notes tray is showing, the page's last line scrolls clear of it.
- **The folder and file name above the page read as one path again.** For a file one folder deep,
  the folder name sat higher than the file name, and a gap after its slash split the path in two.
- **A note now reaches a running session as soon as you write it, instead of up to a minute later.**
  The connection a Claude Code session holds open for notes was closed by the daemon's local socket
  after ten seconds of quiet, every time. The session reconnected, waited longer after each close,
  and settled on trying again once a minute. A note written just after a close waited that long, and
  `glosa status` reported the session as having no push connection for most of every minute while
  push was in fact working, slowly. Held reads over the same socket ended the same way: anything an
  agent waited on for more than ten seconds, `glosa_ask` and the file watch included, failed with
  "the socket connection was closed unexpectedly" instead of waiting the time it asked for.
- **A note's card no longer holds a verdict from before the session wrote the file.** The underline
  under a passage and the dot in the gutter were worked out again every time the manuscript changed
  underneath them; the cards in the margin were not. So a note whose sentence a session had just
  rewritten went on looking attached, and a note whose words a session had put back went on saying
  "Lost its place" — each until a mode toggle, a new note or a reload happened to rebuild the
  margin. The card is now worked out in the same pass as the marks beside it, and the passage
  number on it follows the page when a session adds or removes a block above it.
- **Editing can now be done from the keyboard.** Pressing Edit gave you a document with nothing to
  tab to and no key that opened a passage, so the one state that writes your files could be entered
  and then not used at all. Up and Down step between passages there now, as they already did with
  notes shown, and Enter or Space opens the one you are on. The formatting actions were reachable
  only with a pointer too: every button ignored Enter and Space, and only bold and italic had a
  shortcut. All eleven have one now, each announced and shown in the button's tooltip.
- **A passage no longer swallows the blank line below it while you write in it.** Clicking a
  paragraph closed the gap under it, so it and the paragraph beneath ran together as one while the
  caret was in them; clicking a heading moved the heading out from under the pointer that opened it.
  The page now stays exactly where it was when a passage becomes editable, which is what it was
  always meant to do.
- **A save now says whether it worked.** "Saved.", and every reason a write could fail — including
  the file changing underneath you — were written into a part of the page that is hidden while you
  edit a passage in place, which is the ordinary way to edit. Nothing was shown and nothing was
  announced, so a write that failed looked exactly like one that worked. The line now sits under the
  manuscript where the rest of the page's statements about your file are.
- **Undo says where it went.** Saving clears what Cmd-Z can reverse, because going further back is
  History's job — but nothing said so, so the key simply stopped working a second after you stopped
  typing. It now points at History instead of doing nothing, and stays quiet on a passage you have
  not touched.
- **The passage you are writing in is marked in your own colour.** The rule beside an open passage
  was drawn in the ink the application uses for its own buttons rather than the vermilion that means
  you, a few pixels from a caret that was already vermilion. It is now the same mark as everything
  else you make on the page, at the width the page draws its other edges.

## [0.1.0-alpha.30] — 2026-09-22

### Fixed

- **A note no longer reads "Lost its place" when its sentence only moved across a line break.**
  Re-wrapping a paragraph in your editor, or letting a doubled space in, left the rendered words
  untouched and still emptied the margin of every note on that passage — while the session kept
  receiving them, because the daemon has always ignored that kind of difference when it looks a
  passage up. The page now looks it up the same way, and still refuses to choose when the quoted
  words fit two places.
- **The history panel no longer says a comparison opened when nothing did.** Picking two versions
  and comparing them always reported "Comparison opened in a new tab", including on a presented
  document, which shows a single document and has no tabs to open one in. It says so only when the
  comparison is really there.

## [0.1.0-alpha.29] — 2026-09-22

### Security

- **The daemon's API for glosa's own commands moved off the network onto a local socket only you can
  open.** The CLI, the MCP server, the Claude Code monitor and the Codex attachment now reach the
  daemon through `~/.glosa/run/api.sock` instead of `127.0.0.1:4646`. Before, each of them worked
  out the port once and then sent your pairing token there for as long as it ran — minutes for a
  question waiting on an answer, the whole session for a live agent connection. A port is not an
  identity: once the daemon stops, anything else on the machine can take it, and because the file
  the daemon leaves behind is readable by everyone while the token beside it is not, a program
  running as a different user could have learned enough to look like the daemon and been handed a
  credential it could never have read from disk. File permissions now answer the question instead —
  the socket is owner-only inside an owner-only directory, and the operating system refuses anyone
  else before anything is sent. There is deliberately no falling back to the port, so a daemon too
  old to serve the socket is reported as unreachable rather than quietly reached the old way.
  Nothing changes for the browser, which cannot use a socket and keeps the same address as before.
- **The link `glosa open` hands your browser no longer carries your durable credential.** It now
  carries a single-use one that expires in a minute, the same kind `glosa_present` has always used.
  The browser has to use the port, so this is the one place the socket cannot protect; a single-use
  token means anything that intercepts it gets something that expires and redeems to nothing.

### Added

- Opt-in Wispr Flow dictation is available in the annotation request, agent answer, attention
  response, and conversation composers. Configuration records versioned consent, keeps the
  organization key in macOS Keychain, and makes no provider request until the user clicks Dictate.
  Audio and bounded visible plaintext stream directly from the browser; only a final transcript is
  inserted into the draft, and it is never submitted automatically.

### Changed

- An agent's question now shows you where it is, and glosa no longer moves you to it. The passage a
  session asks about is outlined in the document with a band around the exact words, a printed
  "… asks" label and a "?" tab in the gutter, in a blue-black ink that belongs to sessions. A
  pointer without a question gets the outline and an arrow tab. When a question's passage is off
  screen, a notice under the artifact bar says so and offers **Go to it**; afterwards **Back to where
  you were** returns you to your place. Below the width where the margin rail fits, the question and
  its answer controls open at the passage instead of only in the tray. Before this, the mark was a
  2px grey rule that was easy to miss, glosa scrolled to a new question by itself once you paused
  typing, and questions already open when the page loaded got no help at all.

### Fixed

- **A coding agent no longer turns whatever directory it started in into a glosa workspace.**
  Starting one in your home directory registered your whole home as a workspace, wrote a `.glosa`
  directory into it, and from then on matched every file you own. Starting one in a subdirectory of
  a project you had already opened gave that subdirectory a second workspace with its own inbox, so
  notes you left went to one and the agent watched the other. Now a session inside a project joins
  that project, a session in your home registers nothing at all and still works over pull, and a
  session whose workspace is part-way through `glosa forget` is told so instead of quietly
  resurrecting it.
- **Connecting a Claude Code session now tells you whether your notes can actually reach it.**
  Binding a session and being able to push to it were different things, and nothing said which you
  had. A session could bind, open the document, and show as connected while no monitor was running
  anywhere — so margin notes queued against a workspace nothing was listening to, silently, until
  someone thought to pull them. `glosa-connect` now says in one line whether delivery is live, and
  what happens to notes if it is not. `glosa doctor` answers the same question instead of shrugging
  at it, and `glosa status --json` reports it per session.
- **A session that installed the plugin mid-conversation gets delivery without restarting.** The
  monitor only ever started at session start, so installing glosa partway through a session left
  push off until the next one. Running `glosa-connect` now starts it. Whichever way it starts, a
  session runs exactly one monitor: before, two could race, and the loser's replacement re-sent an
  entry the first had already shown you — the same margin note twice.
- **`glosa-connect` stops improvising when a workspace is half-deleted.** An interrupted
  `glosa forget` leaves a workspace that refuses to bind, and the skill knew one failure and
  guessed at the rest — it would quietly open the document somewhere else and never mention that a
  workspace of yours is stuck mid-deletion. It now names the state and prints the command that
  finishes the removal, and refuses anything it cannot do honestly rather than opening a document
  that looks connected and is not.
- Errors from glosa's MCP tools carry the daemon's own remedy and a stable error code, instead of a
  bare sentence an agent could only guess at.
- Live file updates now follow the work you are actually doing when more than 64 workspaces are
  registered. The daemon used to give its bounded watcher slots to the first workspaces encountered
  during warm-up, so an old registration could stay live while the workspace with your current
  session fell back to delayed catch-up. It now prefers workspaces with live sessions, then the most
  recently seen, with a stable tie-break independent of registry order. `glosa status` reports each
  workspace's live-update state, and `glosa doctor` explains when the selected workspace is using
  offline catch-up and why. The 64-workspace safety ceiling remains: whole-daemon measurements were
  already close to the v1 idle-memory limit there.
- The Claude Code plugin loads. `monitors/monitors.json` wrapped its entry in an object, and Claude
  Code requires a bare array, so the plugin installed and then failed to load: its session monitor
  never started, and a note written in glosa's margin was never pushed into the session. Nothing said
  so, because the MCP tools still registered and binding a session still succeeded. This had been
  true since the monitor was added. Because Claude Code caches a plugin by version, anyone who
  installed the earlier copy keeps it until they update the plugin.
- The plugin manifest no longer drifts from the release it ships in. It had stayed at
  `0.1.0-alpha.21` for seven releases while the CLI moved on, so `/plugin install` advertised a
  version that was never published. Every place the version appears is now derived from one source
  and checked when you commit, when a release is tagged, and against the bytes in the published
  tarball.
- Interrupting a `glosa_ask` call now ends the wait immediately and withdraws the question from the
  margin. Before, an agent whose question was interrupted kept waiting out its own clock — up to
  fifteen minutes — while the reader was still offered "Send answer" on a question nobody was
  listening to, and the only way to clear it was to answer it. A wait that simply runs out still
  leaves the question in place, so a later answer reaches the agent through the inbox as before.
- Every open pane now comes back in the state it was left in. After a reload only the pane named in
  the address bar kept its state; the others reopened in whatever state they were first opened with,
  so a companion document left with its notes hidden came back showing them again.
- A paired tab stays paired. Reloading it, opening a second tab on the same address, or using a
  terminal or editor that rebuilds its web view used to land on "not paired", with no way back except
  another `glosa open` — the browser kept the pairing token only for the lifetime of the one tab that
  received it. It now keeps it for the address, so all three stay paired. The token is still never put
  in the URL or in browser history, and glosa still sets no cookies. `glosa token rotate` and
  `glosa token revoke` remain the way to end a pairing, and either one now drops it from every tab on
  that address at once.
- Typing in the full-page source editor within the first moment of opening a file is no longer
  taken back. The pane filled the editor as soon as the file arrived and then filled it again once
  the annotations had loaded, so anything typed between those two moments was replaced by the file
  as saved, with nothing said. Whichever answer was slow decided whether a writer saw it.
- `glosa open <file>` no longer wedges the daemon once the workspace registry has accumulated many
  large workspaces. Opening a file used to answer "does any registration already track this inode?"
  by walking every registered tree's complete file list synchronously — with a few workspaces of
  20,000 files each, that alone could stall the event loop long enough for the daemon's own stall
  watchdog to SIGKILL it. Whether a file belongs to its owning directory, an enclosing repository, or
  an adoption candidate is now answered by checking that one path against the registration's matcher,
  never by listing the whole tree. The one remaining full-registry case — finding a second hardlink to
  the same file elsewhere in the registry, needed only when the file's link count is above one — now
  runs off the main thread with one overall bounded deadline across retries, so it can no longer
  block the daemon; if it can't finish or verify its answer in time, the open fails with a retryable
  error instead of guessing. Complete watcher and first-reconciliation snapshots also run off-thread,
  and shadow initialization/checkpointing—including adoption's staging bus—reuse that boundary rather
  than walking the tree again. Restored loose registrations restart their daemon-lifetime watcher,
  and every hardlink/exact-reuse identity decision uses a non-following regular-file snapshot.
- Opening a document whose bytes are not valid UTF-8 no longer risks losing them. glosa read such a
  file by replacing every byte it could not decode with `�` and saying nothing, so the editor held
  a copy that differed from the file and an ordinary save wrote that copy back — no conflict, no
  warning. These documents are now shown but not edited: the pane says why, offers no Edit, and the
  daemon refuses the write itself, so nothing writing through the API can do the damage either.

## [0.1.0-alpha.28] — 2026-09-18

### Changed

- **Two states, Note and Edit, that turn each other off.** The control is two buttons now. **Note**
  opens the annotation margin, where a click reaches a passage to comment on. **Edit** makes the page
  writable, where a click puts a caret in a paragraph. With neither pressed you are just reading.
  alpha.27 had both gestures live at once with nothing on the page saying so. The full-page
  editor, rich or byte-exact source, stays in the pane's **More** menu for what a single block cannot
  hold. `mode=` links, `glosa open` and `glosa_present` are unchanged.
- **The document can grow.** Clicking below the last paragraph opens somewhere to write, and an empty
  document has somewhere to start. Nothing is written until you type, so a misclick leaves no blank
  line behind. The arrow keys move the caret out of a block instead of stopping at its edge, and
  Backspace at the start of a block or Delete at its end joins it with its neighbour.
- **Formatting controls appear over a selection.** Select words and eight actions float above them:
  bold, italic, strikethrough, inline code, H2, H3, bullet list and blockquote. Collapse the caret and
  they are gone, so nothing is painted while you type. `# `, `> `, `- ` and `1. ` typed at a line
  start still work.
- An open block is marked with a graphite rule down its left, as annotated passages already are,
  instead of a 2px accent focus ring, and it is as tall as its contents rather than 224px.

### Fixed

- A block edit is written to the file. Since alpha.27 none was: the sentence appeared on the page and
  the tab showed unsaved work, but the save saw nothing dirty and a reload lost it. Opening another
  artifact straight after typing also discarded the edit, and closing the pane now writes a pending
  one first.
- A session writing the artifact no longer destroys an open block editor. The update is held until
  the block closes, and painted then only if nothing is unsaved; with edits pending, the two versions
  meet at the save's conflict dialog. The changed-on-disk notice now shows whenever you have unsaved
  work, not only in the full-page editor.
- Code blocks, indented code, horizontal rules and raw HTML blocks can be opened for editing and
  annotated. They were never stamped with their source line, so nothing could address them.
- In Edit, a session's write repaints the page, and the changed-on-disk notice is kept for unsaved
  work rather than shown to anyone who pressed Edit and only read.


## [0.1.0-alpha.27] — 2026-09-17

### Changed

- **A block is editable by clicking it.** Pressing **Edit** used to replace the whole document with
  a separate editor: the page flashed, every annotation and passage address disappeared, the scroll
  position landed somewhere near where you left it, and the caret went to the button that stops
  editing. Now clicking a paragraph puts a caret in that paragraph. The page is never replaced, so
  your notes stay on screen, the margin stays where it was, and nothing moves. Click away and only
  that paragraph repaints; your typing reaches disk once the page has been quiet for a moment.
  `Cmd-Z` works inside the block you are in, and outside one it takes back the last block you
  changed. `Esc` closes a block and puts you back on it.
- **The mode control is just the notes toggle now.** There is no Edit button and no Done button,
  because there is no longer a state the whole page enters. The byte-exact source editor is in the
  pane's **More** menu as **Edit source**, which is what it is for: front matter, a table you would
  rather type by hand, a block that will not parse. Everything it does — saving, conflict handling,
  telling you when a re-serialization would change markup you did not touch — is unchanged.

### Fixed

- The daemon now serves `run-spans.js`. It was missing from the module allowlist, which would have
  taken the workbench down in a browser while every unit test passed; a test now holds the allowlist
  against the source directory so the next missing module is caught when it is added.

## [0.1.0-alpha.26] — 2026-09-17

### Fixed

- Read and Edit now describe the same document. The daemon's renderer and the editor's parser were
  built from two different markdown-it presets, so a pipe table rendered as a table while reading
  and as literal pipe characters the moment you pressed **Edit**, and `~~struck~~` likewise. Both
  sides now construct from one shared configuration, and the editor has gained table nodes and a
  strikethrough mark so it can hold everything the reader is shown. An untouched table still saves
  byte-for-byte; an edited one writes back as `|---|---|`.

### Changed

- The vendored ProseMirror bundle re-exports `Plugin`, `PluginKey`, `Decoration`, `DecorationSet`
  and `TextSelection`, and now carries `prosemirror-tables`. No new runtime behaviour on its own —
  these are what a future per-block editing surface decorates a focused block with.

## [0.1.0-alpha.25] — 2026-09-17

### Added

- Starred workspaces. The star beside **Artifacts** stars the current folder, and starred folders
  sit in a **Starred** section at the foot of the navigator, where a folder glosa is not serving
  can be reopened with one click. Go to (⌘K) lists every open workspace; `@` narrows it to them.
  The Workspaces switcher above the artifact tree is gone, and with several workspaces open the page
  lands on the one this browser used last.

### Fixed

- The first `glosa` command after an upgrade could fail with "stale glosa daemon did not release
  its lock within 5000ms". The old daemon was closing every file watch one at a time before it
  released its lock, and with many watched workspaces that took 30 seconds or more, with the daemon
  frozen for the whole time. A daemon that is exiting now leaves its file watches for the system
  to release, and stops starting new ones, so it hands over in well under a second.
- A glosa command could start a second daemon while the previous one was still shutting down: with
  the old daemon's port already closed but its lock still held, the lock looked abandoned. A command
  now waits for a daemon that is still exiting, and if it takes too long, stops with a message that
  names the process instead of starting another daemon beside it.
- A daemon could stop answering for a minute or more after it started, and `glosa open` took seconds
  per workspace, while it set up live updates for registered workspaces. It watched every tracked
  file separately, which gets very slow on Bun once there are a few thousand. Each workspace is now
  watched with a single recursive watch, which starts in milliseconds however many files it holds.
  Workspaces are also no longer refused live updates because other workspaces used up a shared
  watch budget; only the limits of 4,096 tracked files per workspace and 64 watched workspaces
  remain.

## [0.1.0-alpha.24] — 2026-09-16

### Changed

- A document now opens as one page with your notes shown, so you can select text and leave a note
  without switching modes first. **Notes** hides or shows the margin, and **Edit** (⌘E) turns the
  same page into an editor; **Done** returns to the view you left. Editing keeps your place on the
  page instead of jumping to the top, and the formatting toolbar and Save stay in reach while you
  scroll. Links, `glosa open` and `glosa_present` still accept `read`, `review` and `edit`; a link
  that names no mode, and `glosa open` without `--read`, now opens with notes shown.
- Edit is paused while an agent session is applying a change to the workspace, so a save cannot
  race the session's write. A draft you already have open stays open and says why to wait.
- The document's path in the top bar is now the way into Go to (⌘K). Go to also lists what you can
  do to the page right now, such as hiding notes or editing; type `>` to show only those.

### Fixed

- A pane that loaded its notes before its first real width measurement kept them in the collapsed
  tray at the foot of the page, with an empty margin column, even at widths where the margin column
  should show. The notes now move into the margin column as soon as the pane is measured wide enough.
- Notes in the margin column were stacked in the order they were written, so a note added later about
  an earlier passage was pushed below every other note and far from its words. They are now stacked
  in page order.
- Checkboxes and other native controls use the page's ink instead of the browser's default blue.

## [0.1.0-alpha.23] — 2026-09-16

### Changed

- The workspace has a new look meant for calm, long writing sessions: warm paper instead of grey
  panels, near-black ink hairlines between regions, and burnt vermilion for everything you mark
  (underlines, margin notes, § addresses, caret, focus and the logo). Documents are set in
  Source Serif 4 by default, with serif headings and serif margin notes; the chrome uses its
  companion, Source Sans 3. Both faces ship with glosa and load from the daemon, so nothing is
  fetched from a font service. The Read / Review / Edit control is now an ink outline with the
  current mode filled in. Layout and behaviour are unchanged.
- The per-document face menu is now Default (serif), Sans and Mono. A document you had switched
  to Serif opens in Default, which is the same serif.
- A new note's draft now opens directly under the words you selected at every window width,
  instead of in the margin column at wide ones, where it was easy to miss. When you send it, the
  note glides into its place in the margin.
- Edit's Source view is centred in the pane, under the mode control, instead of hugging the left.

### Fixed

- Hovering a marked passage in a narrower pane showed your note with the page's text bleeding
  through it. The note now sits on its own paper.

- A file opened straight into Edit could show an empty rich editor instead of its content when the
  editor module finished loading before the file's annotations did. The editor now waits for the
  file to finish loading before it mounts.

## [0.1.0-alpha.22] — 2026-09-16

### Removed

- `glosa init`, its ownership manifest and backups, `glosa open --init/--no-init`, the
  `not-initialized`/`init-drifted` warnings, the daemon's `GET /w/:slug/wiring` and
  `POST /w/:slug/init` routes, the SPA's "wire it now" dialog and "feedback off" badge state, and
  the `wiring` field on `GET /api/status`. The plugin is the only Claude Code install path and
  `codex mcp add glosa -- glosa mcp` the only Codex one; glosa writes nothing into agent
  configuration. (#152)
- Claude Code Channels (`claude/channel`, the `push-stream` route, `glosa_conversation_ack` and the
  conversation acknowledgement route), the `asyncRewake` watcher, and every hook rail
  (`SessionStart`/`SessionEnd`/`UserPromptSubmit`/`Stop`/`Notification`, the blocking gate and
  turn-boundary drain). The delivery ladder is `push → mcp_pull`; provider capabilities are
  `{ push, mcpPull }`, evaluated per session; `delivery_attempt.via` is `monitor`,
  `codex_app_server` or `mcp_pull`, and the drain route refuses any other value. Attention state now
  comes only from glosa's own `attention_request` entries. `glosa hook <event>` remains for one
  release as a silent exit-0 stub so old hook entries never fail on every prompt; `glosa doctor`
  gains a `legacy-config` line naming leftover entries that can be deleted and drops the
  `hooks`/`mcp`/`mcp-enabled` checks. (#152)

### Added

- `glosa open` and `glosa_present` now link to `http://glosa.localhost:4646` instead of
  `http://127.0.0.1:4646`. The daemon accepts exactly those two Host names on the SPA/API port and
  keeps the class-F viewer on the IP. Browsers and the macOS resolver answer `.localhost` on the
  machine, so the name adds no DNS query and no rebinding surface; a page's Origin must match the
  name its request was addressed to. Tabs already open on `127.0.0.1` keep working, and
  `GLOSA_OPEN_HOST=127.0.0.1` restores the old link. (#159)
- Codex sessions can attach to a separately running local app-server control socket after an exact
  MCP bind. Glosa sends bounded feedback as user input with `turn/steer` or `turn/start`, records
  transport acceptance separately from agent acknowledgement, retries first-rollout and disconnect
  failures, and closes the socket with the MCP process. The app-server remains user-owned and MCP
  pull remains the fallback when it is absent. (#161)
- Claude Code now installs through the repository's official plugin marketplace. The plugin carries
  glosa's MCP server, `glosa-connect` skill, and a per-session monitor that streams parked and live
  inbox entries without starting the daemon. The launcher uses only explicit or recorded local glosa
  paths, and `glosa doctor` explains when Claude's telemetry settings suppress monitors. (#151)
- A session can now opt in to being nudged by its own `external_edit`s: `glosa_watch` (MCP) and
  `GET /w/:slug/watch` (HTTP) block for up to 15 minutes on an in-scope, not-yet-seen external edit
  and return it the moment the daemon-lifetime watcher's quiet window closes, rather than requiring
  the session to keep asking. The mark is per session only — no other session's stream, MCP pull,
  badge count, or inbox listing changes — and self-echo is not filtered, so a returned entry may be
  the watching session's own un-leased write. Fixes the same held-request defect for both this route
  and the existing `entry-status` route: Bun's default idle-connection close was cutting a long hold
  at roughly ten seconds regardless of the caller's own `wait_ms`. (#153)

### Changed

- The workbench has a new look built around two hands. Neutrals carry no hue; the human reviewer's
  marks, caret, selection and unsaved work take a deep teal "hand" colour, an unsent note is in
  "pencil", and anything a session writes is printed in ink. Annotations in the margin read as
  entries on the page rather than cards, with the passage's address (`§1.2.3`, derived from the
  document's headings and never stored in it) on the entry and in the gutter. A
  provenance line under the manuscript states your open marks, what the session applied, and
  whether the file changed outside glosa. Each artifact can be read in the default sans, a serif
  or a mono face from the pane's More menu, remembered per workspace and path. `DESIGN.md` now
  describes this system.
- ⌘K / Ctrl+K opens a Go to palette listing the active document's sections and then every file in
  the workspace (`#` narrows to sections, `/` to files). It replaces the hover outline rail at the
  pane's left edge. The top bar centres the active artifact's path, the navigator toggle sits in
  the navigator's bottom-left corner, folders sort before files by natural name order, and the
  active tab no longer changes width when its label turns bold.

### Fixed

- Keep mine on a stale save now merges the writer's edit with disk's own change instead of
  discarding whichever one the writer did not directly touch: a region only the writer edited keeps
  the writer's bytes, a region only disk changed keeps disk's bytes, and a region both changed
  differently is a conflict the writer's version wins, named in the stale-save preview before the
  write happens. A region is a block, the source between two blocks, or the source above the first
  and below the last, so a link-reference definition or a deliberate blank-line run is preserved
  like any other content; anything that cannot be carried is reported rather than dropped quietly. The preview no longer needs a checkpoint to exist. The source face's Keep mine
  runs the same merge instead of writing the whole textarea over disk's version. The daemon's save
  route now checkpoints any pending disk drift before writing the human's own edit, so that edit's
  recorded diff never absorbs bytes the human did not write. (#182)
- Document links now switch an existing tab to the requested file and surface, including browser
  back/forward navigation. Unsaved editor changes require discard confirmation; cancelling keeps
  the draft and current URL. Document visits preserve the saved workspace tab layout. (#145)
- CI and release tests use Bun 1.4.2 to avoid a JUnit reporter abort on passing tests.
  Older runtimes receive an explicit test-runner version error; report completeness and
  failure/skip checks remain enforced. The application runtime floor is unchanged. (#230)
- Missing shadow checkpoint objects now cause a named refusal. Doctor diagnoses the active
  baseline and counts affected inbox entries; explicit `doctor --workspace <slug> --repair-baseline`
  starts new history without changing documents or removing surviving history. Later saves and
  interrupted external-edit capture resume from that baseline. (#226)
- Read/Review and the outline now hide document metadata and paired `%%` authoring notes,
  including inline notes in headings and prose. Rich Edit labels those regions and preserves
  their source spelling, including mixed line endings and nested list/blockquote notes. (#175)
- Two live push connections for the same session no longer ping-pong ownership forever. The daemon
  now signals a displaced `GET /api/sessions/:id/stream` connection with a terminal
  `event: superseded` frame (daemon shutdown, token revocation/rotation, cancel and send failure
  still close with plain EOF) and exposes a read-only `GET /api/sessions/:id/stream/status`
  ownership probe. The Claude plugin monitor and the Codex app-server attachment stop reconnecting
  on supersession, park, and poll that probe every 15-18 seconds. They take the stream back only
  after two probes in a row report the session free, so an owner that is merely between two
  connections is not displaced; no daemon restart is needed. (#206)

## [0.1.0-alpha.21] — 2026-09-14

### Fixed

- The daemon could stop answering shortly after starting, on a machine with large registered
  workspaces. Deciding whether a workspace fits the live-update budget meant walking its whole file
  tree first, on the daemon's only thread — and a workspace of a hundred thousand files takes tens
  of seconds to walk to reach a conclusion that was settled a few thousand files in. The walk now
  stops once the answer is decided. Everything that needs the complete list of a workspace's files —
  the sidebar, `glosa doctor`, reconciliation — still gets it.
- A workspace registered at your home directory, or above it, is no longer watched. glosa stopped
  *creating* such registrations a few releases ago, but one recorded before that was still in the
  index, and the daemon would begin walking your entire home directory on startup because of it.

## [0.1.0-alpha.20] — 2026-09-12

### Fixed

- alpha.19 could exhaust a machine's memory and take it down. Watching every registered workspace
  for the daemon's lifetime — new in alpha.19 — was capped two ways that never multiplied: 4,096
  watch entries per workspace and 64 watched workspaces, so a machine with an accumulated workspace
  list could open a quarter of a million filesystem watches. There is now a single ceiling on watch
  entries summed across every workspace, which is the thing that actually runs out; a workspace that
  does not fit under it stops receiving live updates, exactly as one over the per-workspace cap
  already did, and its changes are still captured by offline catch-up on the next reconcile.
- On a machine with many registered workspaces, alpha.19's daemon never finished starting: it walked
  every workspace's file tree before it began accepting connections, so `glosa open` timed out while
  the daemon was still working. Watching now begins after the daemon is serving rather than before,
  yields between workspaces so a long warm-up cannot stall it, and skips registered workspaces whose
  directory no longer exists.

## [0.1.0-alpha.19] — 2026-09-11

### Added

- Edit a tracked file in your own editor — Typora, vim, anything — and glosa now records what
  changed, as an **external edit**: the artifact, the diff, the checkpoint it changed since, and
  that nobody is credited for it. It is a note, not a task. No agent is nudged with one, it never
  counts toward the "N queued" badge, and there is nothing to apply because the change is already
  in your file. It simply sits in your inbox until `glosa inbox dismiss` closes it — and until you
  do, glosa treats the workspace as still holding your work and will not garbage-collect it.
  Watching is no longer tied to having a glosa tab open: the daemon watches every registered
  workspace, so the external-editor-plus-agent workflow works with no browser involved. Saves are
  coalesced over a two-second quiet window, so one editing burst produces one entry rather than one
  per keystroke-triggered autosave (#153).

### Fixed

- A file you changed outside glosa was reported to your agent as a **human edit you made in
  glosa's editor**. The storage side was always honest — such a change is committed to the shadow
  history attributed to nobody — but the inbox entry built from it had no kind of its own, so it
  reached the agent wearing the one kind that means "a person typed this here". It now arrives as
  an external edit, saying only what glosa can actually show: which file changed, between which two
  checkpoints, and that the author is unknown (#144).
- Relatedly, a drift checkpoint taken while an agent held an apply lease could silently steal that
  lease's attribution: because checkpointing is idempotent, the lease's own closing checkpoint found
  nothing left to record and reused the earlier commit, so the journal credited the session for a
  commit marked "unknown". No checkpoint is taken inside a lease window now; the lease's own before
  and after pair brackets it, as offline catch-up already did.
- On a machine whose home directory is itself a git checkout (a dotfiles repo), glosa could adopt
  the entire home directory as a workspace — bus at `~/.glosa`, shadow store at
  `~/.glosa/shadow.git`, and the matcher pointed at every `.md`, `.html` and `.txt` under home —
  because the walk that picks a workspace root had no boundary and simply climbed to the first
  enclosing repository, wherever that was. Workspace resolution now refuses to land on the user's
  home directory or any ancestor of it: `glosa init`/`glosa doctor` fall back to the working
  directory instead, `glosa open` tracks just the one file rather than promoting to a directory
  workspace, an explicit `--dir` naming home is refused the same way a temp directory is (clearable
  with `--force`), and a `directory` workspace already registered at home from before this fix is
  never silently reused — it is surfaced by slug with remediation instead. A repository that is
  merely a subdirectory of home is unaffected. `glosa doctor` now also names the resolved workspace
  root directly, so this is visible rather than inferred from an unusual shadow-store path (#146).
- A save could write markup you never typed without saying so. Once a document had a `---` metadata
  header, two paths — starting a file from empty, and *Keep mine* after the file moved underneath
  you — wrote the serializer's bracket escaping into your prose and reported nothing, so `See [r]`
  landed as `See \[r\]` silently. Both now show you the change and ask, the way every other save
  that cannot be written back exactly already did. What gets written is unchanged; being told about
  it is the fix.
- A hand-wrapped paragraph or a callout's second line lost the break it already had the moment a
  keypress landed inside it, before any save ran — the browser's own change-reading path folded the
  newline to a space first, silently, and #174 having removed the dialog that used to catch
  unrelated damage on the same saves meant nothing was left to notice it. A keypress anywhere in
  such a block now keeps its break.
- `glosa mcp` shims outlived the agent sessions that spawned them: a host that exited without
  closing the shim's stdin left it running indefinitely. The shim now also exits on SIGHUP and when
  its real parent process is gone, and every shutdown path — stdin EOF, SIGHUP, or an orphaned
  parent — closes its transports and cancels in-flight daemon and API calls under one total
  deadline, so no path can outlive it. Shutdown deliberately sends nothing to the daemon: the
  session is cleaned up by its lease expiring, because a request at that point would carry the
  current credential to an endpoint resolved when the session first registered (#140).
- A generic `glosa_inbox_pull` (no bound host session, no explicit `session_id`) could drain under
  a *different* concurrent pull's workspace. Every generic pull on one shim process shares a single
  synthetic session id, and nothing stopped a second pull's registration from overwriting the first
  pull's `cwd` on that one registry row before the first pull's own drain resolved which workspaces
  it could reach — the daemon re-read that row live, inside the drain, not once at the route's
  entry. A pull's drain request now carries the workspace it was asked for (canonicalised the same
  way registration already is, and refused with 400 rather than silently falling back to row-derived
  scope if it names no real directory), and the daemon captures that scope once, at admission, for
  the whole drain: a registration or bind that moves the row afterward cannot redirect an admitted
  drain to a different workspace, and — found by a second, independent review after the first fix
  shipped — the requesting session deregistering or its lease expiring after admission cannot
  *suppress* one either; the drain completes on its captured scope regardless, and its acknowledgement
  succeeds even though the row is gone. The four hook transports (`gate`/`stop`/`userprompt`/
  `asyncRewake`) are unaffected and keep resolving scope from the row exactly as before. This grants
  no new capability — the same bearer could already register with any `cwd` and then drain (#205).

## [0.1.0-alpha.18] - 2026-09-09

The loop works again. A wedged daemon no longer takes every client down with it, a live session
survives a daemon restart without needing one of its own, and the inbox can be read and cleared
from the CLI without a session to hand.

Edit mode stops inventing changes. A save now rewrites only the block you edited and writes it
back in the spelling your file already had, so what reaches the agent is your edit rather than
the serializer's opinion of it. A file that changed underneath you is refused rather than
silently overwritten, and a workspace can be deleted outright when you want it gone.

### Added

- `glosa inbox list [--all] [--workspace <path>]` lists inbox entries — id, kind, status, age, and
  target path — from the same journal fold `status` already reads, flagging one whose payload has
  gone missing with `[no payload]`.
- `glosa inbox dismiss <id> [--note] [--workspace <path>]` closes an entry without opening a
  session, for when there is nothing left to act on. It lands on a new terminal status,
  `dismissed`, kept apart from a session's own `rejected`. A daemon from before this release
  doesn't recognize `dismissed` and folds it as a no-op on replay, leaving the entry reading as
  pending rather than failing — degrading gracefully, never corrupting the fold.
- `glosa forget <workspace> [--yes] [--json]` permanently deletes a workspace's registration and
  its whole bus — journal, inbox, and shadow-git history, including any historical loose-file
  source sealed into a directory workspace by adoption — while never touching work-tree files.
  Naming a historical source directly resolves to the workspace it was adopted into and forgets
  the complete unit; a source is never an independent deletion target. It refuses before any
  deletion when the workspace has a live bound session, an unexpired apply lease, or an adoption
  already in progress, naming what's blocking it — and neither an adoption nor a new session can
  start on a workspace `forget` has already committed to deleting, either (they share the same
  per-workspace lock). Interactive use previews the exact paths that would be removed and asks
  once; if the previewed set changes before you confirm (an adoption completing while the prompt
  is up, for example), the confirmation is refused rather than silently deleting a different set
  than the one you saw. `--yes` skips the prompt; a non-interactive caller without `--yes` gets a
  usage error rather than a silent guess. `glosa doctor`/`glosa status` name an interrupted
  deletion explicitly, with the exact command to resume it, even once the workspace's own
  directory is gone or its registration has been fully removed. An interruption partway through —
  a crashed daemon, a killed CLI — leaves durable state a later `glosa forget` of the same
  workspace resumes and completes, reporting the full original set of removed paths even if some
  were already gone, rather than leaving orphaned bus files behind or a partial report. (Daemon API
  contract 1.8: `POST /api/workspaces/forget` and the `lifecycle` status field, documented in A1.)

### Fixed

- Saving from Edit mode no longer rewrites the whole file. A save now re-serializes only the blocks
  you actually changed and leaves everything else byte for byte as you wrote it, so YAML front
  matter, `> [!info]` callouts, `%% ... %%` comments, line breaks inside paragraphs and bracketed
  text all survive a save that happened somewhere else in the document. This was worse than a
  formatting annoyance: every rewritten region reached the agent as your own edit, so a session
  could not tell what you had changed from what the editor had invented, and each further save
  fabricated a fresh diff on top.
- A line break inside a paragraph now survives being edited, rather than being folded into a space.
  Editing a hand-wrapped paragraph or list item was the most common way to trip the save dialog, and
  the only kind of damage that could not be undone afterwards: once the joined line was on disk,
  nothing could tell where the break had been. Editing a `%% ... %%` comment or the second line of a
  callout no longer disturbs them either, since that damage was collapsed line breaks as well. On
  this repo's own documents the dialog now comes up on about one edited block in a hundred, down
  from one in nine.
- Where writing an edited block back would still change markup you did not touch — glosa's markdown
  editor has no notion of a callout marker yet — the save shows you those exact
  bytes and asks, offering to save anyway or to hand your edit to the source face so you can fix it
  by hand. Nothing is written until you choose.
- A final approval that saves your pending edits first no longer records the approval when that save
  did not happen. Declining the save leaves the request open and says so.
- Running Claude and Codex sessions recover registration on their next MCP tool call after a daemon
  restart. Explicit binding also registers unknown sessions and refreshes expired ones; no agent
  restart is needed. Re-registration preserves existing binding and transcript metadata.
- Open session streams refresh the shared liveness lease and clean up on disconnect, replacement,
  token revocation, or shutdown. Stream closure lets the lease expire normally.
- Providers discover transcripts by exact session identity within their allowed roots, failing soft
  when files are missing or ambiguous. Unknown-session HTTP errors now report registration recovery
  guidance instead of incorrectly claiming the daemon is unreachable.

- A daemon that stops running takes the port with it instead of taking the machine down. When a
  daemon's event loop stalls it keeps its listening socket, answers no handshake, cannot repair its
  ownership record, and cannot honour SIGTERM — and once the connections glosa's own discovery keeps
  opening fill the kernel's accept queue, that live daemon starts refusing connections. A client
  read those refusals as "the port is free", deleted the ownership record of a daemon that was very
  much alive, and then could neither reach it nor replace it, with `kill -9` as the only way out.
  Clients now prove a port is free by binding it rather than by failing to connect to it, so a live
  owner is never mistaken for an absent one.
- A daemon in that state now ends itself. A watchdog on its own thread notices the main loop has
  stopped, releases the ownership lock, and stops the process, so the next glosa command starts a
  replacement instead of a person hunting for a PID. `GLOSA_STALL_WATCHDOG_MS` sets the threshold
  (default 30 s) or disables it with `0`. A shutdown that has already begun is bounded too: past
  8 seconds the daemon releases its lock and exits rather than hanging with every later signal
  suppressed.
- The error a user actually meets says what happened. A held port with nothing answering on it is
  reported as exactly that, with the PID and the way out, instead of being replaced by "daemon
  discovery exceeded its budget" whenever waiting for the handshake used up the time. Recovery text
  for an unresponsive daemon names SIGKILL, because a wedged daemon cannot run its own SIGTERM
  handler. `glosa doctor` names the state too, distinguishing a wedged daemon from a stale lock,
  an occupied port, and no daemon at all.
- `glosa doctor` now names a journal entry whose inbox payload has gone missing — moved or deleted
  by hand — instead of letting the pending count sit there unexplained. `glosa inbox dismiss <id>`
  is the fix it points you at.
- Opening one of those entries for its actionable presentation no longer returns an unhelpful 422;
  it returns a placeholder page naming `glosa inbox dismiss <id>` as the way to close it.
- Saving in Edit mode could silently overwrite a change that landed on disk while you were still
  editing — an agent applying an annotation, or a save from elsewhere — with no refusal and no
  warning. A save now always writes against the version you actually opened rather than whatever
  the pane's live preview last showed, so a stale save is refused instead of silently winning.
- The pane now tells you when the open file changed on disk while you were editing it — naming who
  changed it when a checkpoint proves it, and admitting plainly when none does — instead of leaving
  you to find out the hard way. A save that arrives to find the file already changed opens a choice
  instead of failing or overwriting silently: keep your edit and re-apply it onto the new file, take
  the file as it is on disk, or compare the two first.

- Editing one word in a block no longer respells the rest of it. A save used to write the editor's
  own spelling of everything in the block it re-serialized: a bare `[` came back escaped, `&amp;`
  came back decoded, a link written as `[Unreleased]` came back with its target inlined, and an
  indented continuation line came back flush left. None of that was your change, and all of it
  reached the agent as though it were. A block glosa's editor models is now written back in the
  spelling it was read in, with only your own edit different.
- Editing a value in a document's `---` header no longer rewrites the whole file. The header is
  carried through a save exactly as you wrote it, and a one-word change to it now reaches the agent
  as a one-line edit rather than as a rewrite of everything.
- Editing a word or whitespace anywhere near a fenced code block inside a tight list item no longer
  inserts a blank line before and after the fence, which used to turn the whole list loose on
  reparse (or, for edits at the fence's own boundary, fall back to rewriting the whole file) for a
  change that never touched its spacing.
- `glosa hook` no longer blocks a prompt in an agent that is not Claude Code or Codex. Some hosts,
  such as an editor plugin or a wrapper CLI, reuse Claude Code's hook wiring but send a payload of
  their own shape, carrying none of the fields glosa reads to tell which session a hook came from.
  Every `glosa hook` event treated that as a usage error, which stopped the prompt. A payload
  carrying none of those fields now exits quietly and does not go looking for the daemon. One that
  carries some of them but not enough to identify a session, and an empty payload, are both still
  errors — those are a malformed Claude or Codex hook rather than a different host, and staying
  silent about them would hide a real problem.

## [0.1.0-alpha.17] - 2026-09-05

The release gives an agent a way to ask the person reading its work a question about a
particular passage, and to wait for the answer — in the margin, beside the words it is about,
rather than in a terminal the reader is not looking at.

### Added

- An agent can point at a passage and ask about it, and wait for the answer. The question appears in
  the margin beside the words it concerns, with a mark on the passage; the human answers there and
  the agent's turn resumes. The new `glosa_ask` MCP tool blocks on a held request rather than a poll
  loop, so a turn resumes the moment the answer is sent. Omitting the question makes it a pointer,
  which returns immediately.
- An agent may offer answer options in its own vocabulary. glosa always adds a free-text field
  beside them, so offering options never stops a human answering something the agent did not
  anticipate.

### Changed

- The artifact modes are now **Read**, **Review** and **Edit**, named for what the human is doing
  rather than for who the counterparty is. Review is the anchored two-way margin: the reviewer's own
  comments and a session's questions about a passage, answered where the words are. The former names
  remain valid on the wire — `mode=preview`, `mode=annotate`, `lock=preview`, `--preview` and
  `glosa_present`'s enum all normalize to the new vocabulary.
- Leaving Edit with unsaved source no longer discards it. Drafts and half-written margin notes are
  kept across mode switches, including one an agent causes, and the Edit control shows that held
  work exists. Closing a pane still asks before discarding.
- The Attention tray sends the reader to the artifact a request concerns rather than offering a
  second place to answer it. A request with no artifact keeps its inline answer.

### Fixed

- A session's question is reachable in a narrow pane. The compact tray counted annotations only,
  so a question with nothing else in the margin left the tray's toggle disabled and its list
  collapsed — the question was on the page and no reviewer could open it, while the agent's turn
  sat blocked on the answer.
- A session's mark sits beside the words it points at. It was placed against the content box
  rather than the text column, which put it 45px out and made it read as furniture instead of a
  mark on those lines.
- Answer options are distinguishable in dark appearance. A native radio renders from
  `color-scheme`, and an unchecked one was painted as a solid light disc on the dark ground, so
  every option looked like the chosen one.

## 0.1.0-alpha.16 - 2026-09-05

**Never published.** The tag was placed on the wrong commit, the release refused to publish a
version that disagreed with it, and by then the next release was ready. Everything below shipped in
0.1.0-alpha.17 instead; there is no 0.1.0-alpha.16 on npm and no tag to compare against. The section
stays because it records when these changes actually landed.

The release makes an annotation something the workspace holds rather than something one browser tab
remembers, and makes the apply-lease behind it work at all outside a lab.

### Fixed

- An annotation now survives closing the tab. Reload the page, open the same manuscript in a second
  pane, or come back tomorrow, and the cards, the underline under each annotated passage, the
  gutter dots and the offer to undo an applied change are all still there. The entries were always
  durable — journal lines, still queued for the session — but the pane held them only in memory, so
  a reload showed an untouched document with work still pending on it.
- Undo appears on an applied annotation. It never did: the offer was looked up in the checkpoint
  list, and a lease taken against a clean worktree writes no checkpoint at all, so there was nothing
  to find. The rollback target now comes from `apply_end`, the one event that states it, and the
  fold carries it onto the entry so it outlives the tab that watched the lease close.
- `glosa apply-begin` and `glosa resolve` accept `--workspace`, so an agent working in one directory
  can act on a review of a document in another. They previously read the current working directory
  and nothing else, which made a lease impossible to take from anywhere but the workspace itself.
- A matched artifact the project gitignores no longer kills every checkpoint in the workspace. `git
  add` exits non-zero on an ignored pathspec unless forced, and the whole apply-lease mechanism is
  built on checkpoints, so one ignored file — a `tmp/` note, a generated report — silently stopped
  proven attribution for that workspace and surfaced only as "internal error".
- `glosa apply-begin` refuses an entry the workspace does not own, with a 404 naming the reason,
  instead of taking the one lease slot for the full TTL on a misrouted id. A lease proves "this
  session changed this workspace because of THIS entry", so a foreign id makes the proof
  meaningless.
- The tab strip no longer grows a vertical scrollbar. Its horizontal scrollbar lane was drawn inside
  the strip's own height, which made a full-height row of tabs too tall for its box and produced a
  second scrollbar beside a single row. It was also taking 11 of the strip's 36 pixels.

### Added

- `GET /w/:slug/annotations` (A1 §5.6a) lists a workspace's annotations, optionally scoped to one
  artifact, each with the payload it was written with, its status, its delivery-attempt count and
  the commit an undo would restore to. Notes withdrawn in glosa are not listed; the journal keeps
  them, but a removed card must not come back on the next page load.
- A withdrawal is recorded as `detail.withdrawn` on its transition. A human taking a note back and a
  session declining one both land on the terminal `rejected`, and only one of them should reappear
  on the page.
- The presentation an agent receives for an annotation now spells out the apply-lease protocol —
  take the lease before editing, resolve after — so a session that has never seen glosa before
  attributes its own work instead of leaving it `unknown`.

## [0.1.0-alpha.15] - 2026-09-05

### Fixed

- A glosa install no longer stops a daemon another install started. Daemons publish an `install_id`
  (a hash of their package root) in the lock and handshake, and a client that finds a divergent
  build refuses to signal it unless identity proves the daemon is its own. Two installs on one
  machine — typically a source checkout beside a published install — previously evicted each other
  on every command, producing a continuous spawn-and-kill storm on port 4646. An upgrade still
  replaces an older daemon, including one that predates the field.
- Running glosa from a source checkout no longer shares `~/.glosa` or port 4646 with a published
  install. A checkout derives `GLOSA_HOME=~/.glosa-dev/<install-id>` and a deterministic port in
  60000-65498; an explicit `GLOSA_HOME`, `GLOSA_PORT` or `--port` still wins, and the CLI reports
  the derived values once on an interactive terminal. **A checkout will no longer see workspaces
  registered in `~/.glosa`** — set `GLOSA_HOME=~/.glosa` to keep the previous behaviour.
- A browser tab no longer loses its pairing for good when a different glosa install takes the port.
  A 401 is now attributed before anything is discarded: if the daemon answering is not the one that
  issued the tab's credential, the tab keeps it, stops sending it, waits on the tokenless handshake,
  and resumes on its own once its daemon is back. A genuine revocation still clears the credential
  exactly as before. Previously any 401 wiped `sessionStorage` and reloaded, and since the pairing
  token had already been stripped from the URL there was no way back short of `glosa open`.
- `glosa init --scope user` now targets `$CLAUDE_CONFIG_DIR` when Claude Code's configuration has
  been relocated — which is what account switchers do to give each account its own root. It
  previously always wrote `~/.claude/settings.json`, a file the asking session never reads, and
  reported success.
- Conversation transcripts from a session under a non-default Claude config root are no longer
  refused. The daemon is a singleton and inherits one `CLAUDE_CONFIG_DIR` while serving sessions
  from all of them, so single-root confinement rejected those paths with a 400 and the conversation
  view was dead for them. Confinement now accepts any of the discovered roots, each realpath-confined
  exactly as before.
- "A process is bound to this port but is not answering the handshake" now names the PID and prints
  the `lsof` and `kill -TERM` commands that clear it, instead of leaving the user to find the
  process themselves.

### Added

- The daemon records rejected requests in `daemon.log` by reason (`no-token-on-daemon`,
  `bearer-mismatch`, `credential-rotated`), throttled to one line per reason per minute with a
  suppressed count. It records no request path and no credential, so a caller cannot use it to grow
  the log or inject a line. Without this, a report of a browser tab losing its pairing could not be
  diagnosed after the fact.
- `glosa doctor` reports every Claude Code config root it can find and which are not wired. An
  account switcher gives each account its own root, and user-scope wiring reaches only the active
  one; the check names the others instead of leaving the gap silent.

## [0.1.0-alpha.14] - 2026-09-05

### Fixed

- Annotating in a pane too narrow for the side rail works. The composer opens under the passage
  it is attached to and travels with it while you scroll, instead of being pinned inside the
  scroll container where it sat one screen above the visible area for anyone reading past the
  first screenful.
- Annotated passages carry their mark again. Since 0.1.0-alpha.12 each pane registered its
  highlights under a per-pane key that no stylesheet rule could match, so the passage underline,
  the hover wash and the composer's selection wash had all been invisible: a heavily annotated
  manuscript read as untouched. The keys are shared now, with each pane contributing and
  withdrawing only its own ranges.
- Saved annotations no longer flow off the end of the manuscript. They live in a collapsible tray
  on the pane, which states its count while collapsed.
- Gutter dots for several notes on one line no longer stack on top of each other, and each names
  its own note for assistive technology.
- Edit keeps the manuscript's measure. The editor column was derived from `68ch` resolved in the
  chrome's sans face rather than the manuscript's serif, so it came out 86px narrower than the
  text it was editing; switching modes now moves the first line by about a pixel.

### Added

- A session that applies an annotation is told how to prove it. Every delivered annotation now
  carries the apply-lease protocol — `glosa apply-begin` before editing, `glosa resolve` after —
  which is what attributes the change to that session and leaves a checkpoint to return to.
  Both commands already existed; nothing had ever told an agent to use them, so annotations
  stayed pending however faithfully they were acted on and every edit was attributed to nobody.
- An applied annotation can be undone. Resolved notes group under their own heading, and one an
  agent applied offers a rollback to the artifact as it read before that change, through the same
  dirty-worktree guard the history pane uses. Where no lease was taken there is no checkpoint to
  return to, and no offer is made.
- Annotations can be revised. Editing one reopens the composer on the same passage; because the
  journal is append-only, sending posts a new entry and then withdraws the original, and the
  composer says so before you send.
- Hovering an annotated passage shows what was written there, with the options to edit or remove
  it, without leaving the text.

## [0.1.0-alpha.13] - 2026-09-05

### Changed

- The workbench chrome is quieter and better proportioned. Tabs read as an index tab on the
  sheet: the active tab's paper runs into the manuscript, resting tabs are separated by a short
  hairline instead of a full-height wall, and every tab label clears AA contrast. The filled
  toolbar above each manuscript is gone; the directory, the mode control on its own segmented
  track, History and More sit on a transparent row at the manuscript's width. The navigator's
  first heading shares the tab strip's line, and a file open in a pane is marked by a dot in the
  disclosure slot instead of a bar that pushed its icon out of line.
- The rendered manuscript is set more like a typeset page: a larger title, more air above each
  section, subheads closed up under their section, semibold rather than bold emphasis, muted
  list markers, a short section rule, a hairline beside quotations, and tables ruled horizontally.
  Iowan Old Style is now named first in the serif stack so Safari and Chromium render the same
  face and the same measure.
- Radii and shadows are tokens; nested corners follow their container's radius, menus and trays
  share one lift, and the caret and any visible scrollbar take the palette.

## [0.1.0-alpha.12] - 2026-09-04

### Added

- Several artifacts can be open at once. Open them as tabs, drag a tab to a pane edge to read two
  side by side, and the arrangement comes back on the next visit. Each pane carries its own mode,
  its own annotations and its own version history, so one bar no longer speaks for two documents.
- A comparison between two saved versions opens as its own pane, so it can stay on screen beside
  the manuscript it describes.
- Every way of dragging a tab has a single-pointer equivalent in the pane's More menu, and a
  direction that would do nothing is shown as unavailable rather than silently doing nothing.
- New keys: Ctrl+Tab and Ctrl+Shift+Tab step through a pane's tabs, Command/Ctrl+Option+Left/Right
  move between panes, Command/Ctrl+\ moves the active tab into a new split, and Command/Ctrl+W
  closes it. The keyboard sheet lists all of them.

### Changed

- The navigator is a column at every width, replacing the drawer that alpha.11 kept under 1024px.
  A narrow window keeps the navigator and every pane at their own minimum width and clips, the way
  a desktop editor does, instead of covering the work with an overlay exactly when you are moving
  between two documents. A single presented document still has no navigator at all.
- Entering Annotate no longer shifts the manuscript sideways. The annotation rail is placed in
  whitespace the manuscript was never using, measured from the pane rather than the window, or it
  is not placed at all.
- Annotating in a split pane works. The rail needs about 1200px and an even split never has that
  on any ordinary display, so entering Annotate borrows width from the pane beside it and gives it
  back on the way out.
- Underlines and gutter marks on annotated passages survive every mode. Leaving Annotate used to
  erase them, so a heavily reviewed document read as untouched in Preview.
- Editing markdown source takes the width of the pane up to a 100-character measure. Tables,
  fenced code and long URLs were being wrapped at the 68-character measure meant for prose.
- The artifact bar sits above the manuscript at the manuscript's own width, and names only the
  directory the tab has no room for. The filename is on the tab; it is not repeated underneath.

## [0.1.0-alpha.11] - 2026-09-04

### Changed

- The navigator is a column beside the manuscript at 1024px and wider instead of an overlay that
  every artifact you opened dismissed. The top-bar control shows and hides it in every mode, and
  that choice is remembered per browser. Under 1024px it stays the drawer it was.
- The workspace switcher is a disclosure that collapses out of the artifact tree's way, and
  remembers whether it was left open.

### Fixed

- A live daemon now repairs a deleted ownership lock without waiting for a handshake, while clients
  use stable port observations and one overall deadline before reclaiming or spawning. Hook-side
  discovery yields quietly inside its host timeout instead of creating repeated EADDRINUSE
  contenders or delaying unrelated prompts.

## [0.1.0-alpha.10] - 2026-09-03

### Fixed

- The browser workspace now serves every module in the SPA import graph, fixing the blank page
  introduced by the alpha.9 viewer decomposition.

## [0.1.0-alpha.9] - 2026-09-03

### Added

- `glosa doctor` now reports journal byte and physical-line growth so operators can distinguish
  ordinary queue depth from a journal that needs attention.

### Changed

- The daemon now separates application routes and services from transport, security, and process
  lifecycle modules; the SPA viewer lifecycle is likewise split into transport-free components.
- The deterministic T8 gate names its acceptance set explicitly and exercises browser security,
  provider delivery, and daemon lifecycle behavior across real process boundaries.

### Fixed

- Expired apply leases, stale shadow indexes, and approval replay can no longer assign unproven
  session provenance or lose the durable approval identity recorded in the journal.
- Workspace registration, adoption, fallback leases, lock reclamation, journal tails, and approval
  uniqueness now fail closed under ambiguous or concurrent state instead of risking lost updates.
- Provider setup remains generic, transcript selection rejects ambiguity, descendant workspaces
  drain correctly, and the SPA offers honest recovery when more than one session could be selected.
- CLI uninstall preserves foreign configuration and indentation, request-review failures retain
  their real category, and durable-install recovery guidance is restored.
- Daemon startup fails promptly when its spawned child exits before handshake, while interrupted
  test runners reliably reap their isolated daemon children.

### Security

- Every CLI-spawned child environment scrubs `ANTHROPIC_API_KEY`, browser token storage is covered
  by the real-engine security gate, and stale git locks are removed only with proven ownership.

## [0.1.0-alpha.8] - 2026-08-10

### Fixed

- Explicitly opening a regular non-symlink artifact now succeeds even when an already-registered
  parent workspace excludes it: glosa creates or reuses a bounded loose-file registration while
  leaving the parent's tracked list unchanged. Repeated paths and hardlink aliases retain one
  history, and strict directory-focus and symlink behavior are unchanged.
- A current daemon now recreates its own lock if that coordination file disappears after startup,
  allowing hooks and CLI commands to recover silently after verifying the repaired lock/handshake
  pair. Corrupt or mismatched locks remain fail-closed, and older lockless daemons receive exact
  manual recovery guidance without being signalled automatically.

## [0.1.0-alpha.7] - 2026-08-07

### Added

- The SPA now has one compact, accessible Agent feedback control that reports explicit session
  connection as connected, stale, or unbound while retaining queued-entry and feedback-off state.
  Stale and unbound workspaces expose provider-owned, copyable reconnect prompts with a generic CLI
  fallback; clipboard denial selects the prompt for manual copying.
- Providers now supply current-session reconnect guidance through `connectPrompt`, and
  `GET /api/status` exposes those additive prompts without changing binding persistence. The HTTP
  contract is now 1.5 with same-major N-1 tolerance.
- Real HTTP integration coverage proves `glosa open --bind <own-session-id>` registers and binds a
  live session in one operation while preserving the existing nonfatal unknown-session behavior.

### Changed

- Agent feedback status refreshes on workspace selection, existing workspace-stream activity and
  reconnect, window focus, and the 15-second poll. A failed status fetch clears any prior connected
  claim rather than leaving stale green UI.
- `glosa open` resolves an unowned file inside a git repository to the repo root as a directory
  workspace instead of registering a loose file over the file's containing directory, so `open`,
  `doctor`, and `init` now agree on one workspace root; `open`'s wiring probe reads the same
  scoped manifest `doctor` does, so a correctly-wired workspace no longer reports
  `not-initialized`; and a `loose-file` registration's un-wired hint no longer suggests running
  `glosa init` on its (possibly temp-directory or multi-repo-parent) worktree. `glosa init`/`glosa
  doctor` resolve a bare cwd invocation to the enclosing git repository, and `glosa init` refuses
  to write configuration into a temp directory or a bare multi-repo parent unless `--force` or an
  interactive confirmation. `glosa init --print` now shows a real hunk-level diff instead of
  rendering every change as a whole-file replacement, and reports "already up to date" rather than
  printing nothing when there is nothing to change. (#96)

## [0.1.0-alpha.6] - 2026-07-27

### Added

- The workbench top bar now shows an ambient wiring badge: `Live → session` when annotations
  will be delivered, `Wired — no session bound` when the integration is installed but no session
  is listening (restart/resume needed), and `Off — annotations stay local` when `glosa init`
  never ran — with a queued-entry count when work is waiting. The badge stays hidden until the
  state is actually observed and never claims a connection it hasn't seen.
- The first annotation in an un-wired workspace offers to set up agent feedback in place: one
  explicit click runs `glosa init` through the daemon and a follow-up notice states the remaining
  restart/resume step. Declining — or the setup failing — never blocks the annotation: it is
  saved locally either way, and the fallback notice shows the terminal command.

- Per-workspace wiring status API (`GET /w/:slug/wiring`): a three-state signal — `live`
  (delivery would reach a session), `wired` (init installed, restart/resume needed), `unwired`
  (init never ran) — plus pending-entry count, with the same value surfaced on `GET /api/status`.
- Consent-gated init trigger (`POST /w/:slug/init`): on an explicit client request the daemon
  runs `glosa init` for a registered directory workspace (CSRF-protected state-changing route;
  scrubbed child env, 30s timeout, single-flighted per workspace) and reports whether a session
  restart is still required. API contract bumped to 1.4 (additive).

### Fixed

- `glosa open` now resolves relative targets against the invoking client's working directory
  before contacting the daemon, preventing an existing daemon from silently registering the same
  relative path beneath its own unrelated working directory.
- Artifact watching now uses one bounded, shared watcher per workspace instead of one recursive
  workspace-root watcher per SSE connection. Canonical pruning keeps `node_modules`, `.git`,
  dot-worktrees, symlinks, and unrelated files out of the watch set; oversized workspaces degrade
  safely instead of driving the singleton daemon into an error, memory-growth, and respawn loop.
- Workspace garbage collection can no longer remove a registration whose bus still holds pending
  (undelivered) entries — parked annotations now block removal indefinitely, and an unreadable
  journal counts as pending rather than removable. `glosa forget` remains an explicit override.

- `GET /api/status` reports `orphaned_state`: home-state buses (`~/.glosa/state/<id>`) holding
  pending entries with no live registration. `glosa doctor` gained matching `pending-delivery`
  and `orphaned-state` checks that warn when annotations are queued without delivery wiring or
  stranded in an orphaned state dir, with the recovery hint (re-open the original path — the
  deterministic registration id reclaims the surviving bus).

### Added

- `glosa open` now tells you when a workspace is not wired for agent feedback: an un-init'd
  workspace gets a `not-initialized` warning (drifted config gets `init-drifted`) naming the exact
  fix and the session-restart step, and on a TTY `open` offers to run `glosa init` after a single
  explicit yes (`--init` runs it without asking, `--no-init` silences the offer). Exit codes and
  the init-free SPA-only contract are unchanged.
- `glosa doctor` gained an `mcp-enabled` check that catches the enabled-but-undefined trap: a
  `.claude/settings*.json` layer force-enabling an MCP server named `glosa` that `.mcp.json` never
  defines.

### Changed

- `glosa init` success output now states the remaining step explicitly: restart or `/resume` the
  Claude Code session so it loads glosa — until then annotations are queued, not delivered.

## [0.1.0-alpha.5] - 2026-07-25

### Changed

- Collapsed the wide top bar so secondary actions (Attention, History, Conversation, Copy source,
  Print / Save as PDF, Appearance, Keyboard shortcuts) live behind the More menu at every width,
  matching the Preview Boundary Rule in `DESIGN.md`.

## [0.1.0-alpha.4] - 2026-07-25

### Added

- `glosa update` upgrades an existing installation in place. It resolves and verifies the release
  independently of local npm or bun registry configuration, so a private scope mapping no longer
  breaks the upgrade path. `glosa update --check` reports what would change without installing.

### Fixed

- Corrected the install command in the README and in `glosa init`'s durable-install hint. Both
  recommended a `--registry` flag that a scope-level `.npmrc` mapping silently overrides, so the
  documented workaround failed in exactly the situation it claimed to fix.
- Detected package-runner caches under a custom `BUN_INSTALL` root, which were previously mistaken
  for durable installs.
- Pinned the transitive `brace-expansion` dependency to clear the OSV release-security advisory.

## [0.1.0-alpha.3] - 2026-07-24

### Fixed

- Prevented daemon startup failures and repeated contender spawns when a genuine daemon answers the configured port but its lock file is missing or malformed.
- Retried daemon discovery when another client replaces the daemon between lock inspection and handshake, avoiding false ownership-mismatch failures.
- Updated the locked `tar` dependency to resolve the release security advisory.

## [0.1.0-alpha.2] - 2026-07-24

### Added

- Durable loose-file-to-directory workspace adoption with preserved historical lineages.
- Read-only presentation surfaces, including source copy, print, and session-independent preview actions.
- Revision-bound artifact approval and canonical URL focus for review workflows.

### Changed

- Made Preview a reading-only canvas and improved responsive workspace review behavior.
- Consolidated provider naming and legacy integration traces around the generic provider boundary.

### Fixed

- Completed open-surface lifecycle handling and annotation-flow reliability.

## [0.1.0-alpha.1] - 2026-07-23

### Added

- Public, maintainer-owned roadmap backed by a live GitHub Project and release milestone.
- Durable `WorkspaceMetadataDescriptor` v1 registration through HTTP, CLI, and MCP.
- Explicit CLI/MCP session binding and an action-aware attention badge/tray with structured results.
- Local bearer-token rotation and revocation with immediate invalidation in the running daemon,
  stale-tab unpairing, and a documented `glosa open` re-pairing path. Token commands never print
  credential material.

### Changed

- Archived the completed autonomous v1 build records and documented AI-assisted contribution
  disclosure and ownership requirements.
- Bumped the additive HTTP contract to v1.1 and made Claude Channels explicitly optional when the
  audited hook/MCP fallback succeeds.
- Replaced live domain-specific integration guidance with the declarative public boundary.
- Migrated `glosa mcp` to the official TypeScript MCP SDK with strict Zod schemas and
  SDK-native protocol negotiation, validation, and error framing.

## [0.1.0-alpha.0] - 2026-07-21

### Added

- Experimental macOS CLI for opening the local writing and review workspace.
- Local daemon, browser workspace, and Claude Code and Codex provider integrations.
- Public release documentation, security policy, and automated release gates.

### Security

- Loopback-only daemon access with capability tokens and confined workspace paths.

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.38...HEAD
[0.1.0-alpha.38]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.37...v0.1.0-alpha.38
[0.1.0-alpha.37]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.36...v0.1.0-alpha.37
[0.1.0-alpha.36]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.35...v0.1.0-alpha.36
[0.1.0-alpha.35]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.34...v0.1.0-alpha.35
[0.1.0-alpha.34]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.33...v0.1.0-alpha.34
[0.1.0-alpha.33]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.32...v0.1.0-alpha.33
[0.1.0-alpha.32]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.31...v0.1.0-alpha.32
[0.1.0-alpha.31]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.30...v0.1.0-alpha.31
[0.1.0-alpha.30]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.29...v0.1.0-alpha.30
[0.1.0-alpha.29]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.28...v0.1.0-alpha.29
[0.1.0-alpha.28]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.27...v0.1.0-alpha.28
[0.1.0-alpha.27]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.26...v0.1.0-alpha.27
[0.1.0-alpha.26]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.25...v0.1.0-alpha.26
[0.1.0-alpha.25]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.24...v0.1.0-alpha.25
[0.1.0-alpha.24]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.23...v0.1.0-alpha.24
[0.1.0-alpha.23]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.22...v0.1.0-alpha.23
[0.1.0-alpha.18]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.17...v0.1.0-alpha.18
[0.1.0-alpha.17]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.15...v0.1.0-alpha.17
[0.1.0-alpha.15]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.14...v0.1.0-alpha.15
[0.1.0-alpha.14]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.13...v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.12...v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.11...v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.10...v0.1.0-alpha.11
[0.1.0-alpha.10]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.9...v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.8...v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.7...v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.6...v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.5...v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.4...v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.0
