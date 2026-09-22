# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A note's card no longer holds a verdict from before the session wrote the file.** The underline
  under a passage and the dot in the gutter were worked out again every time the manuscript changed
  underneath them; the cards in the margin were not. So a note whose sentence a session had just
  rewritten went on looking attached, and a note whose words a session had put back went on saying
  "Lost its place" — each until a mode toggle, a new note or a reload happened to rebuild the
  margin. The card is now worked out in the same pass as the marks beside it, and the passage
  number on it follows the page when a session adds or removes a block above it.

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

[Unreleased]: https://github.com/davebream/glosa/compare/v0.1.0-alpha.30...HEAD
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
