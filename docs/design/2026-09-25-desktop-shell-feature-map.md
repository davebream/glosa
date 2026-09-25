# Desktop shell: feature map by topology

Companion to issue #160. Inventory drawn from the SPA modules (`packages/spa/src`), the route
catalog (A1 §5), the CLI table (A6), the plugin MCP tools, and the "Launching sessions (2026-09-23)"
decision. Status: proposal, no implementation. Decisions 1 and 2 in §4 are turned into a contract
by `2026-09-25-daemon-ownership-and-pairing-under-a-shell.md`; the state of all eight after the
Electron spike is in `docs/research/2026-09-25-desktop-shell-readiness.md` §5.

## 1. The rule

The shell is not a second product. The axis that decides what a surface shows is **who brought
the agent to that surface**, not which window renders it and not which folder it is:

```
presented by an agent  -->  companion surface   (terminal owns the conversation; glosa is margin + inbox)
opened by the human    -->  desk surface        (glosa owns the conversation; managed chat)
```

- The kind is a **per-surface** property, fixed when the tab or window opens and carried in its
  link (`kind=companion` from `glosa open --bind` and `glosa_present`, `kind=desk` from a plain
  `glosa open` and the app's folder picker; absent means companion). Nothing is recorded on the
  folder, and the kind is never inferred from whether a session is bound (decision 2026-09-25,
  revised the same day: "companion and desk are inherently different surfaces, they should not
  co-exist in a single electron app window").
- One folder may be open on a desk surface and a companion surface at once, each with its own
  agent. Claims, the journal and human-save-wins reconcile the bytes; each surface shows only its
  own agent. In the app that means two windows, never two tabs of different kinds in one window.
- Browser and Electron render the same SPA against the same singleton daemon (R1). Electron adds
  OS affordances only. It forks no feature.
- Crossing kinds is an explicit act with its own ceremony (account, consent), never a default.

## 2. Feature inventory

Legend: **Both** = identical in either face. **Companion** = only on a surface a session
presented. **Desk** = only on a surface the human opened. **Shell** = needs the Electron main process.

### Reading and annotating (the core act)

| Feature | Where in code | Face | Notes |
|---|---|---|---|
| Review / Read / Edit states per pane | `artifact-pane.js`, R6 | Both | Unchanged. |
| Margin annotations, W3C records, intent (change words / fix look / wrong label) | `annotate.js`, `artifact-pane.js` | Both | Routed to whichever session owns the workspace: external session or managed chat. |
| Class-R markdown viewer, idiomorph live updates | `viewer.js` | Both | |
| Class-F foreign HTML viewer on port 4647 | `classf-viewer.js` | Both | Stays an iframe inside the shell; same origin split. |
| Rich editor + source toggle, source-preserving saves, three-way merge | `rich-editor.js`, `merge-markdown.js` | Both | |
| Version history, compare, restore | `history.js`, `diff-pane.js` | Both | |
| Outline | `outline.js` | Both | |
| Non-manuscript regions hidden | `markdown-non-manuscript.js` | Both | |
| Print / Save as PDF (#340) | CSS | Both | Shell can use native `printToPDF`; fix CSS first so both agree. |

### Navigation and layout

| Feature | Where in code | Face | Notes |
|---|---|---|---|
| Artifact tree | `artifact-tree.js`, `viewer-navigator.js` | Both | |
| Dock: tabs, groups, move, saved layout per workspace | `dock.js`, `panel-identity.js` | Both | **Latent bug:** two windows on one workspace fight over the saved layout. Decide per-window layout before the shell ships. |
| Go to (⌘K): files, chats, workspaces, commands | `palette.js` | Both | Workspace group is the only switcher a companion tab needs. |
| Deep links `surface=document`, `mode=` | `address.js`, `bootstrap.js` | Both | Shell registers a `glosa://` handler that maps onto the same fragments. |
| Last-selected workspace landing (`localStorage`) | `viewer.js` | Both | Per origin; the shell must load `glosa.localhost:4646` to share it with `glosa open`. |
| Starred workspaces (star, unstar, reopen by id) | `viewer.js`, `data-access.js`, A3 §4 | **Desk** | Built in PR #266 as the browser's path-free reopen. Keep the routes and `stars.json`; move the affordance to the desk face (Projects surface). No star control in a presented tab. |
| Projects surface: pinned + recent + Open… | new | **Desk** | Recent comes free from `workspaces.json`. Open… is native in the shell; in the browser it shows the `glosa open <path>` command to copy. |

### Sessions, delivery, provenance (companion machinery)

| Feature | Where in code | Face | Notes |
|---|---|---|---|
| Session binding, presence | `POST /w/:slug/session-binding`, `glosa_session_bind` | Companion | Managed chats register their own logical session; the human never binds by hand. |
| Inbox: pull, get, delivery ack, seen, response | A1 §5.9–5.15, `glosa_inbox_*` | Both | Same journal; the consumer differs (external monitor vs owned runtime). |
| Attention tray, attention requests, approval mode | `attention-tray.js`, `request-review` | Both | Daemon-wide. Shell adds an OS notification and dock badge. |
| Claims, signals, exclusive/presence, Edit paused under claim | A1 §5.11f/g, `glosa_claim` | Both | Also protects a desk workspace from a stray companion session. |
| Provenance labels human / session / unknown | `artifact-pane.js` | Both | |
| External-session conversation panel (`external-chat`) | `conversation.js`, `panel-identity.js` | Companion | A read-only receipt of the terminal conversation. Not a chat; keep it visibly a receipt. |
| Transcript stream | `GET /w/:slug/transcript/stream` | Companion | |
| Held `external_edit` watch + acks (#153) | A1 §5.11b–d | Both | Scoped to "exactly the session that asks", any explicitly bound session. A managed chat's runtime needs it just as much when the human edits in another editor. |
| Session question at its passage, answer inline | `artifact-pane.js` | Both | Asked by an external session or a managed chat alike. |
| Workspace metadata v1 | `glosa_metadata_*`, `glosa metadata` | Both | Content adapters are face-agnostic. |

### Managed chats (desk machinery)

| Feature | Where in code | Face | Notes |
|---|---|---|---|
| New chat, chat list, pin, archive, delete, export | `viewer.js`, `chat-pane.js` | **Desk** | Absent from a presented tab, including the empty-state prompt. |
| Account choice per chat, subscription, model, effort | `agent-ui.js`, `chat-pane.js` | Desk | |
| Send, stop, queued / held messages, attachments | `chat-pane.js` | Desk | |
| Workspace access consent, revoke | `chat-pane.js` | Desk | The consent moment is the face crossing when a companion workspace continues in a chat. |
| Attach previous conversation / frozen transcript | `chat-pane.js` | Desk | This is the bridge from a finished companion session; keep it explicit. |
| Agents & accounts settings, native login, MCP servers per account | `agent-settings.js`, `agent-login.js`, `agent-mcp-settings.js` | Desk | Settings panel stays reachable everywhere; its Agents section only matters on the desk face. |
| Owned native runtime (PTY via Bun) | daemon providers | Desk | Decision log: no Electron needed. |

### Input and settings

| Feature | Where in code | Face | Notes |
|---|---|---|---|
| Consent-gated dictation | `dictation.js`, A1 §5.22 | Both | |
| Appearance (theme, per device) | `appearance.js` | Both | Shell follows OS theme through the same setting. |
| Pairing token, rotate / revoke, unpaired screen | `security/token.ts`, `glosa token` | Both | **Shell:** main process re-pairs from the 0600 token; the app never shows the unpaired screen. |
| `glosa forget` | `POST /api/workspaces/forget` | Both | CLI-driven today; the desk face may expose it from Projects. |
| `glosa doctor`, `status`, `update` | A6 | Both | `update` stays the only network call; the shell adds no auto-update. |

## 3. What only the shell adds

| Capability | Mechanism | Why the browser cannot |
|---|---|---|
| Open a folder, drop a folder on the dock | Main process runs `glosa open <path> --url` and navigates | A3: no path from a page, ever |
| Self-pairing | Main reads the token, injects via fragment | Page has no file access |
| Ensure a daemon | Spawn detached `glosa __daemon` if none answers, then act as a client | Tab cannot spawn |
| OS notifications, dock badge, menu bar, `glosa://` | Electron APIs | |
| Native print to PDF | `webContents.printToPDF` | |

Preload exposes at most `openFolder()`, `notify()`, `revealInFinder()`. No daemon route gains a path.

## 4. Decisions before the shell exists

1. **Install of truth.** Recommend: the CLI installs the daemon; the app requires it and spawns it
   when absent. One version on the machine, one update path (A6 §F30 never downgrades).
2. **Daemon outlives the app.** The app never kills a daemon it did not spawn, and never one with
   a bound session. Replaces "kill children on quit" in #160.
3. **Layout per window, not per workspace,** or the second window opens with a read-only layout.
4. **Attention is daemon-wide;** the current workspace is window-scoped by fragment.
5. **Kind at open, not at registration** (decided 2026-09-25): the link carries `kind=`, the SPA
   gates chats, stars and the connection chip on it, and no workspace row or index field exists for
   it. The shell keeps one kind per window; a presentation arriving for a folder a desk window shows
   opens a second, companion window (the `glosa://` handler, not yet built).
6. **Origin:** the shell loads `http://glosa.localhost:4646`, same as `glosa open` (#255).
7. **No build step exception** is scoped to the shell package only; SPA and daemon stay served
   unbundled by the daemon so the two modes cannot drift.
8. **Keyboard ownership:** native menu chords vs the accessibility matrix (⌘W, ⌘N, ⌘P).

## 5. Shapes considered

| Shape | What it is | Verdict |
|---|---|---|
| A. Window mode | Pure shell: folder picker, self-pairing, notifications, no browser chrome | First |
| B. Desk defaults | A plus Projects surface and chat-first empty state on human-opened workspaces | Layer on A; already implied by the face rule |
| C. Separate thing | Own daemon and home, managed agents only | Rejected: breaks R1, duplicates state, kills the cmux flow |
