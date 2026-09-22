// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — one artifact, in one pane. Everything artifact-scoped that used to live in
// mountApp's single closure lives here instead, once per open tab: the artifact bar, the
// Preview/Annotate/Edit state machine, the manuscript, the contextual margin and its composer,
// both editor faces, the approval strip, the class-F frame, and this artifact's version history.
//
// Design brief: docs/design/2026-09-04-multi-artifact-workbench-brief.md. Its §3 thesis is the
// reason this module exists — one top bar cannot honestly speak for two documents, so every
// control that describes a particular artifact moved inside the pane that holds it.
//
// Two width rules follow from that and are implemented here rather than in app.css alone:
//   * §7 The Manuscript Never Moves. The margin is placed in whitespace the manuscript was never
//     using, or not placed at all. Nothing reserves space on mode entry. The ladder is keyed on
//     PANE inline size (container queries in app.css; a ResizeObserver here for the JS half),
//     never on the viewport — a pane changes width when a sash moves and the window does not.
//   * §8 The editor measure follows the face. Prose keeps the 68ch reading measure; markdown
//     source is not prose and takes the pane up to a 100-character cap.
//
// Talks to the daemon ONLY through the injected data-access instance (R6's ONE data-access
// module) — never `fetch` directly (see test/import-boundary.test.ts).

import { addressBlocks, addressForRange } from "./address.js";
import {
  agentIdentity,
  agentRequestSummary,
  bandPath,
  isQuestion,
  lineBoxes,
  locateQuote,
  openQuestions,
  requestsForArtifact,
} from "./agent-request.js";
import { buildAnnotationRecordFromSelection, foldQuote, locateFoldedQuote } from "./annotate.js";
import { mountClassFViewer } from "./classf-viewer.js";
import { choiceDialog, confirmDialog } from "./dialog.js";
import { faceKey, mountFaceControl } from "./face.js";
import {
  collectRenderedHeadings,
  currentHeadingIndex,
  measureTextareaOffsets,
  outlineDepths,
  scrollToOffset,
} from "./outline.js";
import { runAtLine, runsFrom, spliceRun, widenToNext, widenToPrevious } from "./run-spans.js";
import { Idiomorph } from "./vendor/idiomorph.js";
import { createElement as el } from "./viewer-shell.js";

/**
 * What `saveCurrentArtifact` returns when the writer was asked about a save that would change
 * bytes they did not type, and answered anything other than "save anyway".
 *
 * Distinct from both the saved artifact and a thrown error, because a caller that acts on a save —
 * the approval flow attaches its verdict to the revision the save produced — must not treat a
 * declined save as a completed one and approve the bytes still sitting unsaved on screen.
 */
export const SAVE_DECLINED = Symbol("glosa.save-declined");

// The one 409 that means "the file moved under this draft" — routes/artifact.ts's `mapError`
// names it separately from the daemon's generic `conflict` slug precisely so a caller never has
// to guess from a bare status code (D5). A `workspace-adopting` 409 reaches the same route and
// must NOT open this dialog.
const SOURCE_CHANGED = "https://glosa.local/errors/source-changed";

export const MODES = ["read", "review", "edit"];

// Writer-register labels for R3's annotation `intent` enum (2026-07-21 brief §7.5): the wire
// value is the enum, the label is what the reviewer reads. Order = the enum's declaration order.
export const INTENTS = [
  { value: "content", label: "Change the words" },
  { value: "classification", label: "Wrong label or split" },
  { value: "style", label: "Fix how it looks" },
];

// Writer-register labels for every status the journal can hand us (2026-07-21 brief §7.5).
// `waiting` is the SPA's own name for the wire's initial `pending`.
const STATE_LABELS = {
  waiting: "Waiting for a session",
  delivered: "Sent to session",
  applied: "Done",
  rejected: "Closed",
  stale: "Out of date",
  dismissed: "Dismissed",
};

// ---------- the document-global highlight registry ----------
//
// `CSS.highlights` is keyed by NAME across the whole document, and a static stylesheet can only
// style a name it can spell. Panes therefore cannot each own a private key: giving every pane a
// random suffix (`glosa-anchors-k3f9x2`) did stop panes from overwriting each other, but it also
// meant no `::highlight()` rule in app.css ever matched, so the annotation underline, the anchor
// wash and the composer's selection wash silently stopped painting for every artifact.
//
// The registry is global, so it is coordinated globally. Every pane contributes its ranges under
// the SAME three names, and the union is rewritten whenever any pane's contribution changes. A
// `Highlight` holds any number of ranges and ranges are document-scoped, so panes coexist inside
// one key instead of fighting over it. Keep these three names in step with app.css §10.
/** How much of a conflicting block's disk text the stale-save preview quotes (#182 D9). Long
 * enough to recognise the passage, short enough that several conflicts stay readable in a dialog. */
const CONFLICT_EXCERPT_CHARS = 80;
const HL_ANCHORS = "glosa-anchors";
const HL_ANCHOR = "glosa-anchor";
const HL_COMPOSER = "glosa-composer-selection";

const highlightsAvailable = () => typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

/** name -> (pane token -> that pane's ranges). A Map keyed by object identity so a torn-down
 * pane's contribution is dropped with it and never leaks into another artifact's marks. */
const highlightContributions = new Map();

/** Replaces one pane's ranges under `name` and repaints the union. An empty array withdraws this
 * pane's contribution; the key itself is deleted only once no pane contributes to it. */
function contributeHighlight(name, token, ranges) {
  if (!highlightsAvailable()) return;
  let byPane = highlightContributions.get(name);
  if (!byPane) highlightContributions.set(name, (byPane = new Map()));
  if (ranges.length) byPane.set(token, ranges);
  else byPane.delete(token);
  const all = [...byPane.values()].flat();
  if (all.length) CSS.highlights.set(name, new Highlight(...all));
  else CSS.highlights.delete(name);
}

// The pane inline size at which the right-hand whitespace beside the manuscript stops holding a
// 240px annotation rail (§7). Below it the compact bottom tray is the honest answer.
//
// The brief derives 1130px from a 642px manuscript block. The built manuscript measures 707px —
// `68ch` at the shipped serif face is wider than the estimate — and the pane's scrollbar takes
// another ~8px the arithmetic has to allow for, so the floor moves with both: 707 + 2 x (240 + 8)
// = 1203, rounded to 1205. Keeping the brief's number instead would have let the rail cross the
// manuscript through the whole 1130–1203 band. Paired with app.css's
// `@container pane (min-width: 1205px)` ladder and `--manuscript-block` — change all three
// together, and re-measure `.glosa-content`'s painted width if `--measure` ever moves.
export const MARGIN_RAIL_FLOOR = 1205;

// What Annotate asks a split for. Deliberately NOT the floor: a pane handed exactly 1205px lands
// on 1204.5 after the grid's own rounding and the rail silently fails to engage — balancing on a
// threshold is fragile by construction. This is clear of it, and buys a ~280px rail rather than
// the bare 240px minimum. It is also deliberately short of the 1363px the rail saturates at,
// which would take the companion pane all the way down to its 360px floor: the reader split the
// workbench to keep two documents legible, and annotating one of them should not cost the other
// its legibility.
export const MARGIN_RAIL_COMFORT = 1290;

/** How far into the gutter a session's tab sits from the text column: the tab's own 20px plus a
 * gap that keeps it clear of the band's left edge. Inside the manuscript's 2rem gutter, so it never
 * leaves the painted page. */
const BAND_TAB_OFFSET = 30;
/** How long a newly arrived mark plays its one draw-in (app.css `glosa-band-arrive`). */
const BAND_ARRIVE_MS = 1300;
/** A passage counts as on screen only when this much of the pane shows past its edge — a band whose
 * last pixel peeks over the top is not something the reader can be said to be looking at. */
const PASSAGE_VISIBLE_INSET = 24;
const SVG_NS = "http://www.w3.org/2000/svg";

export function initialModeState(mode = "read") {
  return { mode: MODES.includes(mode) ? mode : "read", dirty: false };
}

/**
 * Pure Read↔Review↔Edit transition reducer. Every transition is legal and none of them costs
 * work: leaving Edit with unsaved source PARKS the draft rather than discarding it, so `dirty`
 * survives the switch and re-entering Edit finds the text exactly as it was left.
 *
 * That is what removed the old "Discard unsaved edits?" prompt from mode switching. The prompt
 * existed only because the switch destroyed the draft; a switch that keeps it has nothing to ask
 * about. Closing a pane still asks, because closing really does end the draft's life — see
 * `confirmClose`. `discard` therefore remains, for the one caller that still means it.
 *
 * A parked draft is `dirty && mode !== "edit"` — derived, never stored, so the two can never
 * disagree about whether unsaved work exists.
 */
export function modeReducer(state, action) {
  switch (action.type) {
    case "set_mode": {
      if (!MODES.includes(action.mode)) return state;
      return { ...state, mode: action.mode };
    }
    case "edited":
      return state.mode === "edit" ? { ...state, dirty: true } : state;
    case "saved":
      return { ...state, dirty: false };
    case "discard":
      return { ...state, dirty: false };
    default:
      return state;
  }
}

/** True when unsaved source exists but is not the thing currently on screen. The mode bar says so
 * out loud, because otherwise the only evidence of parked work is its absence. */
export function isParked(state) {
  return Boolean(state.dirty) && state.mode !== "edit";
}

/** Morphs `container`'s content into `newHtml` via idiomorph, preserving unchanged nodes (and
 * therefore scroll position/any live selection within them) instead of a destructive
 * `innerHTML = newHtml` replace. The one thing every re-render of a rendered artifact — a live
 * SSE-driven update or this pane's own post-save re-render — goes through. */
export function morphArtifactContent(container, newHtml) {
  Idiomorph.morph(container, newHtml, { morphStyle: "innerHTML" });
}

/** Splits an artifact path into {dir, name} for the artifact bar — the filename leads, the
 * directory is quiet mono metadata beside it. */
export function splitPath(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { dir: "", name: path } : { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * The leading part of `path` that `tabLabel` does not already show. A tab labelled `chapter-3.md`
 * for `drafts/chapter-3.md` leaves `drafts/`; a tab that had to grow to `drafts/index.md` leaves
 * nothing, because it is already the whole path.
 */
export function residualPath(path, tabLabel) {
  if (!tabLabel || !path.endsWith(tabLabel)) return path.slice(0, path.lastIndexOf("/") + 1);
  return path.slice(0, path.length - tabLabel.length);
}

/**
 * Splits a directory into the part that may be ellipsized and the part that never is, so the
 * artifact bar truncates a long path from the MIDDLE (§6) rather than from an end. The segment
 * immediately before the filename is the one a reader is actually using to tell two `index.md`s
 * apart, so it is the part that survives.
 *
 * `docs/design/drafts/` → `{ head: "docs/design/", tail: "drafts/" }`
 */
export function splitDirectory(dir) {
  if (!dir) return { head: "", tail: "" };
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return { head: "", tail: `${trimmed}/` };
  return { head: `${trimmed.slice(0, idx)}/`, tail: `${trimmed.slice(idx + 1)}/` };
}

const MODE_ICONS = {
  // Drawn to the chrome icon set's own spec: 20x20 box, 1.6 stroke, round caps and joins, no
  // fill. Unicode glyphs would not sit on the same grid as the navigator and history marks.
  read: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.8 10S4.7 4.8 10 4.8 18.2 10 18.2 10 15.3 15.2 10 15.2 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.4"/></svg>',
  review:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.2h8M3 8h8M3 11.8h5"/><path d="M17 3.4 13 7.4l-.6 2.4 2.4-.6 4-4a1.3 1.3 0 0 0-1.8-1.8Z"/></svg>',
  edit: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M9.5 3.5H4.6A1.6 1.6 0 0 0 3 5.1v10.3A1.6 1.6 0 0 0 4.6 17h10.3a1.6 1.6 0 0 0 1.6-1.6v-4.9"/><path d="M15.1 2.9a1.7 1.7 0 0 1 2.4 2.4L11 11.8l-3.2.8.8-3.2Z"/></svg>',
  done: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.4 8 14.2 16 5.8"/></svg>',
};

const ICONS = {
  history:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5V2.8M3.5 5.5h2.7M3.7 5.3A7 7 0 1 1 3 12M10 6.2V10l2.7 1.7"/></svg>',
  more: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/><path d="M4.5 12.5H4A1.5 1.5 0 0 1 2.5 11V4A1.5 1.5 0 0 1 4 2.5h7A1.5 1.5 0 0 1 12.5 4v.5"/></svg>',
  print:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 7.5v-4h8v4M6 14.5H4.5A1.5 1.5 0 0 1 3 13V9a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 9v4a1.5 1.5 0 0 1-1.5 1.5H14"/><rect x="6" y="12" width="8" height="5" rx="1"/></svg>',
  compare:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3.5H4.4A1.4 1.4 0 0 0 3 4.9v10.2a1.4 1.4 0 0 0 1.4 1.4H7M13 3.5h2.6A1.4 1.4 0 0 1 17 4.9v10.2a1.4 1.4 0 0 1-1.4 1.4H13M10 2v16"/></svg>',
  move: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="1.5"/><path d="M11.5 4v12"/></svg>',
};

/**
 * Mounts one artifact pane into `host`. Every dependency is injected — this module never
 * constructs a data-access instance, never reads the workspace list, and never touches the top
 * bar, so a pane is the same component whether it is the only one or one of six.
 */
let mergeModulePromise = null;
/** The Keep-mine merge, fetched on demand and remembered.
 *
 * NOT a module-scope import: the merge reaches the parser and block aligner in `rich-editor.js`,
 * which carries the vendored ProseMirror bundle, so importing it eagerly pulls that bundle into
 * `viewer.js`'s graph and undoes the lazy loading the editor surfaces sit behind
 * (`import-boundary.test.ts` pins exactly that).
 *
 * Warmed when a pane enters Edit, not when Keep mine is clicked. Entering Edit is where a stale
 * save becomes possible, and it is human time ahead of one — so the conflict dialog never waits on
 * a fetch at the moment it has something to say. Readers who never edit still never fetch it. */
function loadMergeModule() {
  mergeModulePromise ??= import("./merge-markdown.js").then((module) => module.threeWayMerge);
  return mergeModulePromise;
}

export function createArtifactPane(host, deps) {
  const {
    dataAccess,
    slug,
    path,
    initialMode = "read",
    readLock = false,
    loadHistoryPane,
    loadRichEditor,
    getAttentionEntries = () => [],
    /** Proven half of a session's identity. Supplied by the viewer from the workspace's own
     * provider record — never guessed here, and never taken from the request payload. */
    getProviderName = () => "An agent session",
    refreshAttention = () => Promise.resolve(),
    /** Whether some pane already shows this artifact. A question about a document nobody has open
     * has no pane of its own to raise a notice in, so the active pane raises it (#308). */
    isArtifactOpen = () => true,
    /** Opens another artifact in Review and takes the reader to a request in it. Only ever called
     * from the reader's own "Go to it". */
    goToRequestElsewhere = () => Promise.resolve(false),
    openArtifactInThisPane = () => Promise.resolve(false),
    openDiffTab = null,
    // How a pane asks the dock for room. Entering Annotate in a pane too narrow for the rail
    // borrows width from its siblings and gives it back on the way out; with no siblings, or no
    // room to borrow, both are no-ops and the compact tray stays the honest answer.
    claimWidth = () => {},
    releaseWidth = () => {},
    onStateChange = () => {},
    paneCommands = [],
    // What this artifact's tab already says. The bar shows only the remainder, so a filename is
    // never printed twice in two adjacent rows. `null` means there is no tab strip at all (the
    // presented-document surface), and the bar carries the whole identity itself.
    getTabLabel = () => null,
    // The writer's per-artifact face (face.js). Optional: a pane without a store reads in the
    // default serif and offers no control.
    faceStore = null,
    dictationController = null,
  } = deps;

  let currentArtifact = null; // {source_path, content, rendered_html, source_sha256, class, derived_from?, valid_utf8?}
  // The sha of the bytes the editor face was FILLED FROM — separate from currentArtifact, which
  // keeps tracking the file for display. A refresh never moves this, so a save can stay honest
  // about what it would overwrite even while the pane's display races ahead of it.
  let baselineSha = null;
  // `currentArtifact.content` from the SAME read that set `baselineSha` (#182 D2/R1) — one atomic
  // pair, only ever advanced together through `setBaseline` below. This is the "base" a three-way
  // Keep-mine merge splices onto; never read `currentArtifact.content` for that purpose instead,
  // since a plain SSE refresh moves it out from under an open, unrelated editor session.
  let baselineContent = null;
  // Pinned when an edit session begins: {openedCheckpointId, attributionCursor}. Compare's `from`
  // and the disk-change attribution walk's origin (later tasks in this epic).
  let editSession = null;
  // An observed disk state that differs from `baselineSha`: {seenAt, at, attribution, acknowledged}.
  // Recorded in `refreshArtifact`, cleared on a completed save, a discard, or a fresh `loadArtifact`.
  let diskChange = null;
  let loading = true;
  let modeState = initialModeState(readLock ? "read" : initialMode);
  /** The view Edit returns to: the page with notes shown or hidden, whichever the reader left. */
  let lastViewMode = modeState.mode === "edit" ? "review" : modeState.mode;
  /** The active apply lease the workbench last heard about, or null. While a session holds one,
   * Edit is paused (see renderModeBar). */
  let applyPause = null;
  /** The page's scroll position when Edit was entered or left, restored once the new face mounts,
   * so switching states keeps the reader's place instead of jumping to the top. */
  let pendingScrollTop = null;
  /** ---- per-block editing (#271) ----
   *
   * One run of the manuscript is writable at a time. `openRun` holds it while it is open:
   * `{ run, host, block, editor, address }` — the source span, the element the editor mounted into,
   * the rendered block it replaced, the editor itself, and the passage address for its accessible
   * name. Null whenever the page is simply being read, which is most of the time. */
  let openRun = null;
  /** The pane's source INCLUDING run edits that have not reached disk yet.
   *
   * Null means "no local edits" and the artifact's own `content` is the truth. Once a run commits,
   * this holds the spliced document and every later run measures against it, so two edits in a row
   * do not both splice against the stale original. */
  let workingSource = null;
  /** Committed runs, newest last: `{ start, end, before, after }`.
   *
   * A run's ProseMirror history dies with its view on blur, so without this Cmd-Z would stop
   * working the moment the writer clicks away — a reflex trained and then broken, which is worse
   * than no undo. With the caret inside a run, Cmd-Z is ProseMirror's; outside one, it reverts the
   * last committed run from here. */
  let runUndo = [];
  /** The pending debounced write, so a second edit inside the window replaces it rather than
   * queueing a second save. */
  let saveTimer = null;
  /** An external change that arrived while a run was open and was held rather than painted.
   *
   * `refreshArtifact` refuses to morph the manuscript out from under an open editor, so the frame
   * it declined has to be taken once the run closes — otherwise the page would keep showing the
   * document as it was before the session wrote, indefinitely and silently. */
  let heldExternalRefresh = false;
  /** Lazily fetched editor module namespace: `mountRichEditor`, `blockLayout`, `renderMarkdown`.
   * A dynamic import, so the Read/Review static graph still cannot reach the ProseMirror bundle
   * (import-boundary.test.ts pins exactly that). */
  let editorKitPromise = null;
  let sourceFace = false; // within the full-page editor: rich (default) or byte-exact source
  /** Whether the full-page editor is showing instead of the manuscript.
   *
   * False is the ordinary state of Edit: the page you were reading, with a caret available in any
   * block you click. True is the tool — front matter, a table you would rather type by hand, a block
   * that will not parse — and it is reached deliberately from More, never by entering Edit. */
  let fullPageEditor = false;
  let richEditor = null; // {getSave, getMarkdown, isDirty, focus, destroy} while the rich face is mounted
  let richMountRequest = 0;
  /** Unsaved source, kept across mode switches. `{path, text}` — see `parkDrafts`. */
  let parkedSource = null;
  /** The artifact path whose full-page source face holds text the writer typed and has not saved.
   * Path-scoped rather than a bare flag because `modeState.dirty` survives opening a different
   * artifact (see the note above `setBaseline`), and a face filled for another file must still
   * follow the file it is showing. */
  let unsavedFacePath = null;
  /**
   * A splice report that outlived the editor that produced it, `{text, report}`.
   *
   * The save gate would otherwise have two holes, both of which end with unconsented bytes on disk
   * and no dialog. Switching Rich → Source and saving from there takes the source face's branch,
   * which never calls `getSave()`. And parking a draft across a mode switch re-mounts the rich
   * face over the SPLICED text, making it the new baseline — after which the editor is clean and
   * has nothing to report, even though nobody ever agreed to it.
   *
   * So the report travels with the text, and applies for exactly as long as the text is still
   * unchanged. Once the writer types, the bytes are theirs and nothing needs consenting to.
   */
  let pendingReport = null;
  /** A half-written margin note, kept the same way. `{path, state}`. */
  let parkedComposer = null;
  /** The session request the reader is currently on, if any — drives the focused band and, where
   * the rail has no room, which question's card floats at its passage. */
  let focusedRequestId = null;
  /** Notices the reader waved away. Per pane and per visit: a dismissed notice is not an answered
   * question, so the band, the card and the tray row all stay. */
  const dismissedNotices = new Set();
  /** Where the reader was before "Go to it" took them to a passage: `{top, focus}`. glosa never
   * moves the reader on its own, and when THEY ask to be moved it owes them the way back. */
  let returnPlace = null;
  /** True between an answer being sent and the reader going back or waving the notice away. */
  let answerJustSent = false;
  /** Marks that arrived since the last look and still owe their one draw-in. */
  const arrivedRequestIds = new Set();
  /** What the notice currently shows, as a string. Scrolling re-evaluates the notice every frame;
   * rebuilding its DOM each time would take the focus ring off a button mid-Tab. */
  let noticeKey = "";
  /** Half-written answers, by entry id. The rail is rebuilt on every journal event, so an
   * answer held only in the card's DOM would be erased by an unrelated session's activity. */
  const answerDrafts = new Map();
  let richEditorLoading = false;
  /** The most recent bytes any caller asked the rich face to mount, including ones that arrived
   * while the editor module was still loading. See `mountRichFace`. */
  let pendingRichMarkdown = null;
  let annotations = []; // [{record, id, state, attempts?, error?}] for THIS pane's one artifact
  let composer = null; // {record, replacing?, ...} while the annotation composer is open
  let trayOpen = false; // the compact collection tray: collapsed to its count strip by default
  // entry id -> the shadow-git sha the artifact was at when a session took the apply-lease for it
  // (`apply_end.detail.pre_sha`, A4 F05). That is the state immediately BEFORE the annotation was
  // acted on, so it is exactly what "undo this" restores to.
  //
  // Read from the lease-closing journal event, because that is the only place it is stated. The
  // first version of this scanned the checkpoint list for a `pre_apply` commit carrying the entry
  // and found nothing in the ordinary case: `checkpoint()` is idempotent, so a lease taken while
  // the worktree is clean writes no commit, and `pre_sha` is just the existing HEAD — a
  // `baseline`, or the `post_apply` of an earlier cycle. Undo silently never appeared.
  //
  // Filled from two places, which must agree: `hydrateAnnotations` reads the points the journal
  // already holds when the artifact opens, and the live `apply_end` frame adds the one that was
  // just proven. Cleared with the cards whenever the pane loads a different artifact.
  const rollbackPoints = new Map();
  let previewItem = null; // the annotation whose passage the pointer is currently over
  let previewCloseTimer = null;
  let blockTargetFocusIndex = 0;
  let stopClassFViewer = null;
  let classFInteractive = false;
  let approvalBusy = false;
  let approvalError = "";
  let approvalResult = null;
  let toolsStatusArtifactPath = null;
  let destroyed = false;
  /** @type {typeof import("./markdown-parser.js").collectSourceHeadings | null} */
  let sourceHeadingCollector = null;
  /** @type {Promise<void> | null} */
  let sourceHeadingLoad = null;
  // Pane inline size, kept by the ResizeObserver below. `layoutMargin` and the composer's
  // scroll-into-view both need it, and a pane's width is not the window's.
  let paneWidth = 0;
  let historyVisible = false;
  let refreshHistory = null;

  // ---------- artifact bar (§6) ----------

  const artifactDirHeadEl = el("span", { className: "glosa-artifact-dir-head" });
  const artifactDirTailEl = el("span", { className: "glosa-artifact-dir-tail" });
  const artifactDirEl = el("span", { className: "glosa-artifact-dir" }, [artifactDirHeadEl, artifactDirTailEl]);
  const artifactNameEl = el("span", { className: "glosa-artifact-name" });
  const artifactIdEl = el("div", { className: "glosa-artifact-id" }, [artifactDirEl, artifactNameEl]);
  const modeBar = el("div", { className: "glosa-modebar", role: "group", "aria-label": "Page" });

  const historyToggle = el("button", {
    className: "glosa-history-toggle",
    type: "button",
    "aria-label": "Version history",
    "aria-expanded": "false",
  });
  historyToggle.innerHTML = `${ICONS.history}<span class="glosa-control-label">History</span>`;

  const toolsTrigger = el("button", {
    className: "glosa-tools-trigger",
    type: "button",
    title: "More",
    "aria-label": "More",
    "aria-expanded": "false",
  });
  toolsTrigger.innerHTML = `${ICONS.more}<span class="glosa-visually-hidden">More</span>`;

  function menuItem(className, icon, label, onClick) {
    const button = el("button", { className: `glosa-pane-menu-item ${className}`, type: "button", onClick });
    button.innerHTML = `${icon}<span></span>`;
    button.querySelector("span").textContent = label;
    return button;
  }

  // History has its own control in the bar at comfortable pane widths; below ~400cqi that control
  // folds away and this row is where it lives instead (§6's collapse order).
  const historyMenuItem = menuItem("glosa-pane-menu-history", ICONS.history, "Version history", () => {
    setToolsOpen(false);
    toggleHistory();
  });
  const copySourceButton = menuItem("glosa-tools-copy-source", ICONS.copy, "Copy source", () => {
    setToolsOpen(false, { restoreFocus: true });
    void copyArtifactSource();
  });
  const printArtifactButton = menuItem("glosa-tools-print", ICONS.print, "Print / Save as PDF", () => {
    setToolsOpen(false, { restoreFocus: true });
    printArtifact();
  });
  // Named for exactly what one click does. "Compare versions" would promise a version picker;
  // that picker is the History surface, one row above.
  const compareButton = menuItem("glosa-tools-compare", ICONS.compare, "Compare with last saved version", () => {
    setToolsOpen(false, { restoreFocus: true });
    void compareWithLastSaved();
  });
  /** The byte-exact editor, as a document-level view rather than a mode of the page (#271).
   *
   * Since a block is editable by clicking it, a full-page editor is no longer how you change a
   * word — it is what you reach for when CommonMark cannot hold what the file says: front matter,
   * a table you would rather type by hand, a block that will not parse. That is a tool, so it lives
   * among the artifact's other tools instead of taking half the mode control. */
  const editSourceButton = menuItem("glosa-tools-edit-source", MODE_ICONS.edit, "Edit source", () => {
    setToolsOpen(false, { restoreFocus: true });
    if (fullPageEditor) {
      fullPageEditor = false;
      renderArtifactTools();
      renderContent();
      return;
    }
    fullPageEditor = true;
    // Edit mode is what the full-page editor is a face OF, so asking for the source from Read or
    // Note enters Edit as well rather than opening a writable surface the mode control denies.
    if (modeState.mode === "edit") {
      renderArtifactTools();
      renderContent();
      return;
    }
    setMode("edit");
  });
  const toolsStatus = el("p", { className: "glosa-tools-status", role: "status", "aria-live": "polite", hidden: true });

  const moveGroup = el("div", { className: "glosa-pane-menu-group", role: "group", "aria-label": "Move tab to" });
  const moveItems = [];
  if (paneCommands.length) {
    moveGroup.append(el("p", { className: "glosa-pane-menu-heading", textContent: "Move tab to" }));
    for (const command of paneCommands) {
      const item = menuItem("glosa-pane-menu-move", ICONS.move, command.label, () => {
        setToolsOpen(false);
        command.run();
      });
      item.setAttribute("data-direction", command.id);
      moveItems.push({ item, command });
      moveGroup.append(item);
    }
  }

  /** Which directions mean anything depends on a layout that changes between one opening of this
   * menu and the next, so it is answered when the menu opens rather than when it was built. */
  function refreshMoveCommands() {
    let available = 0;
    for (const { item, command } of moveItems) {
      const enabled = command.isEnabled ? command.isEnabled() : true;
      item.disabled = !enabled;
      item.title = enabled ? "" : "There is no pane that way, and this tab already has a pane to itself.";
      if (enabled) available += 1;
    }
    // A heading over five dead rows is noise. With nothing to move to, the section stands down.
    moveGroup.hidden = moveItems.length > 0 && available === 0;
  }

  // The writer's face for this artifact lives here, among the artifact's other settings, not in
  // the bar: a reading preference is chosen once and then left alone (face.js fills the group).
  const faceGroup = el("div", { className: "glosa-face-group" });
  const toolsMenu = el("div", { className: "glosa-pane-menu", role: "group", "aria-label": "Artifact tools" }, [
    historyMenuItem,
    editSourceButton,
    copySourceButton,
    printArtifactButton,
    compareButton,
    faceGroup,
    moveGroup,
    toolsStatus,
  ]);
  const tools = el("div", { className: "glosa-pane-tools", "data-open": "false" }, [toolsTrigger, toolsMenu]);

  // What an unfocused pane shows instead of a live mode control. Two segmented switchers on one
  // screen read as two offers when only one of them is the one ⌘1/2/3 and the keyboard address —
  // but a pane in Preview and a pane in Annotate with nothing annotated yet look identical, so
  // the state still has to be legible. A quiet label states it without offering it.
  const modeLabel = el("span", { className: "glosa-pane-mode-label" });
  // Three columns: the path at the left, the mode control centred over the manuscript (which is
  // itself centred in the pane), the artifact's own actions at the right.
  const artifactBar = el("div", { className: "glosa-artifact-bar" }, [
    artifactIdEl,
    modeLabel,
    modeBar,
    el("div", { className: "glosa-artifact-actions" }, [historyToggle, tools]),
  ]);

  // ---------- pane body ----------

  const approvalStrip = el("section", {
    className: "glosa-approval-strip",
    hidden: true,
    "aria-label": "Final approval",
  });
  // Previews what a stale save would refuse — never steals focus (`role="status"`, the pattern
  // `emptyEl` already uses) and renders only in Edit (D7: outside Edit, `.glosa-pane-main` is
  // itself the scroller, and a flex sibling above `contentEl` would move the manuscript under an
  // unchanged scrollTop).
  const diskChangeCopyEl = el("p", { className: "glosa-disk-change-copy" });
  const diskChangeKeepBtn = el("button", {
    // `.glosa-btn` is the shared reusable button base (§9); the second class is a JS/test hook
    // only, with no CSS rule of its own — reusing the base avoids a parallel button styling.
    className: "glosa-btn glosa-disk-change-keep",
    type: "button",
    textContent: "Keep editing",
    onClick: () => acknowledgeDiskChange(),
  });
  const diskChangeReloadBtn = el("button", {
    // Quieter than `.glosa-btn` (`glosa-btn-ghost`, the same class Cancel wears in confirmDialog):
    // Reload is the less common, not-yet-fully-implemented action — see `takeDisk`'s STUB note.
    className: "glosa-btn glosa-btn-ghost glosa-disk-change-reload",
    type: "button",
    textContent: "Reload",
    onClick: () => void takeDisk(currentArtifact),
  });
  const diskChangeActionsEl = el("div", { className: "glosa-disk-change-actions" }, [
    diskChangeKeepBtn,
    diskChangeReloadBtn,
  ]);
  const diskChangeEl = el(
    "section",
    { className: "glosa-disk-change", hidden: true, role: "status", "aria-live": "polite" },
    [diskChangeCopyEl, diskChangeActionsEl],
  );
  // Why Edit is not on offer for this artifact (#250). In the flow rather than floating, and the
  // opposite call from `diskChangeEl` above for the opposite reason: a disk change ARRIVES while
  // someone is reading, so a row appearing in the flow would move the manuscript under an
  // unchanged scrollTop; this fact is true from the first paint, so there is no reading position
  // for it to disturb and a floating card over the paper would be the intrusive choice.
  const encodingNoticeEl = el(
    "section",
    { className: "glosa-encoding-notice", hidden: true, role: "status", "aria-live": "polite" },
    [
      el("p", {
        textContent:
          "This file is not valid UTF-8. glosa can show it but will not edit it: saving would rewrite the bytes it cannot read.",
      }),
    ],
  );
  // What Enter does to the focused passage is the whole difference between the two states, so the
  // sentence that teaches it cannot be one fixed string. `updateBlockTargets` sets it per mode.
  const BLOCK_TARGET_HELP = {
    review: "Use Up and Down arrow keys to move between passages. Press Enter or Space to annotate.",
    edit: "Use Up and Down arrow keys to move between passages. Press Enter or Space to edit one.",
  };
  const blockTargetInstructions = el("p", {
    className: "glosa-visually-hidden",
    hidden: true,
  });
  blockTargetInstructions.id = `glosa-block-instructions-${Math.random().toString(36).slice(2, 9)}`;
  const contentEl = el("div", { className: "glosa-content", role: "region", "aria-label": "Artifact preview" });
  const emptyEl = el("div", { className: "glosa-empty", hidden: true, role: "status", "aria-live": "polite" });
  const skeletonEl = el("div", { className: "glosa-skeleton", hidden: true, "aria-hidden": "true" });
  for (let i = 0; i < 8; i++) skeletonEl.append(el("i"));
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true, "aria-label": "Artifact source" });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  // What the page says about the write, and it sits under the MANUSCRIPT rather than inside
  // `editWrap`.
  //
  // It lived in the Save row, which `renderArtifact` hides whenever the full-page face is not
  // showing — so per-block editing, the way a writer normally edits, wrote "Saving…", "Saved." and
  // every error into a hidden element. `hidden` also takes a node out of the accessibility tree, so
  // the `aria-live` region announced none of it either. The result was a surface that writes to a
  // real file and creates an inbox entry an agent acts on, and reports neither that it worked nor
  // that it did not: a writer whose save failed kept typing into a document they believed was
  // saved. The tab's unsaved dot says something is pending; nothing said it landed.
  const editStatus = el("p", {
    className: "glosa-edit-status",
    role: "status",
    "aria-live": "polite",
    hidden: true,
  });

  /** The one way this line is written, so "shown" and "says something" cannot come apart.
   *
   * Emptying it hides it: a status line is not a slot that is always there and usually blank, it is
   * a sentence that exists when there is one to say. */
  function setEditStatus(text, { error = false } = {}) {
    editStatus.textContent = text;
    if (error) editStatus.setAttribute("data-error", "true");
    else editStatus.removeAttribute("data-error");
    editStatus.hidden = !text;
  }
  const richEl = el("div", { className: "glosa-rich", hidden: true });
  const faceRichBtn = el("button", { className: "glosa-face-rich", type: "button", textContent: "Rich" });
  const faceSourceBtn = el("button", { className: "glosa-face-source", type: "button", textContent: "Source" });
  const faceToggle = el("div", { className: "glosa-editor-face", role: "group", "aria-label": "Editor mode" }, [
    faceRichBtn,
    faceSourceBtn,
  ]);
  const editWrap = el("div", { className: "glosa-edit-wrap", hidden: true }, [
    el("div", { className: "glosa-edit-topbar" }, [faceToggle]),
    richEl,
    editArea,
    el("div", { className: "glosa-edit-actions" }, [saveButton]),
  ]);
  const classFEl = el("div", {
    className: "glosa-classf",
    hidden: true,
    role: "region",
    "aria-label": "Artifact preview",
  });
  const marginEl = el("aside", { className: "glosa-margin", "aria-label": "Annotations" });
  const markersEl = el("div", { className: "glosa-markers", "aria-hidden": "true" });
  // A session's mark is a band drawn AROUND the words, in session ink, in its own layer (#308).
  // The human's marks stay on the words themselves — wash and underline — so the two never share a
  // channel: one colours the text, the other outlines it, and a sentence carrying both still reads.
  // The layer is not aria-hidden: each band's gutter tab is a real button.
  const bandsEl = el("div", { className: "glosa-bands" });
  // At widths with no rail, the question the reader is on floats at its passage, the way an open
  // draft does. The tray keeps the list; this keeps the question beside the words it is about.
  const askLayerEl = el("div", { className: "glosa-ask-layer" });
  // The one thing that tells the reader a session is waiting on a passage they cannot see. Outside
  // the scroll container, so it holds still while the manuscript moves under it.
  const noticeEl = el("div", {
    className: "glosa-ask-notice",
    hidden: true,
    role: "region",
    "aria-label": "A session's question",
  });
  const previewEl = el("div", { className: "glosa-annotation-preview", hidden: true });
  // The open draft floats at its passage at every width. A draft stacked into the rail beside the
  // saved notes opened hundreds of pixels from the words just selected and was easy to miss; the
  // passage is where the reader's eyes already are. Once sent, the new entry glides from here to
  // its place in the rail (`settleIntoMargin`).
  const composerLayerEl = el("div", { className: "glosa-composer-layer" });
  const historyEl = el("section", { className: "glosa-history", hidden: true, "aria-label": "Version history" });

  // The collection, at compact widths. The composer goes to the passage; the SET of annotations
  // on this artifact needs somewhere permanent to live, and the end of a 4000px manuscript is not
  // it. A tray on the PANE — not inside its scroll container, and not the window (§7: with two
  // artifacts open, a viewport-bound tray lies about which document it belongs to).
  const trayCountEl = el("span", { className: "glosa-tray-count" });
  const trayToggle = el("button", {
    className: "glosa-tray-toggle",
    type: "button",
    onClick: () => setTrayOpen(!trayOpen),
  });
  trayToggle.append(el("span", { className: "glosa-tray-chevron", "aria-hidden": "true" }), trayCountEl);
  const trayListEl = el("div", { className: "glosa-tray-list" });
  const trayEl = el("aside", {
    className: "glosa-annotations-tray",
    hidden: true,
    "aria-label": "Annotations on this artifact",
  });
  trayEl.append(trayToggle, trayListEl);

  // The provenance line: written, changed, outside glosa, approval — stated on the page, under the
  // manuscript, from what this pane can prove (invariant 3). Never a badge, never "synced".
  const provenanceEl = el("dl", { className: "glosa-provenance", "aria-label": "Provenance", hidden: true });
  const paneMain = el("main", { className: "glosa-pane-main" }, [
    approvalStrip,
    diskChangeEl,
    encodingNoticeEl,
    blockTargetInstructions,
    emptyEl,
    skeletonEl,
    contentEl,
    editStatus,
    provenanceEl,
    classFEl,
    editWrap,
    marginEl,
    markersEl,
    bandsEl,
    previewEl,
    composerLayerEl,
    askLayerEl,
  ]);
  const paneEl = el("section", { className: "glosa-pane", "aria-label": "Artifact" }, [
    artifactBar,
    noticeEl,
    paneMain,
    trayEl,
    historyEl,
  ]);
  paneEl.setAttribute("data-mode", modeState.mode);
  paneEl.setAttribute("data-editor-face", "rich");
  host.append(paneEl);

  // The writer's face for this artifact, stamped on the pane so every manuscript surface in it —
  // rendered, rich editor, the quotes that echo it — reads one variable (app.css §1).
  const faceControl = faceStore
    ? mountFaceControl(faceGroup, faceStore, {
        getKey: () => {
          const facePath = currentArtifact?.source_path ?? path;
          return facePath ? faceKey(slug, facePath) : null;
        },
        onChange: (face) => {
          if (face === "default") paneEl.removeAttribute("data-face");
          else paneEl.setAttribute("data-face", face);
        },
        onPick: () => setToolsOpen(false, { restoreFocus: true }),
      })
    : null;
  if (!faceStore) faceGroup.hidden = true;

  // ---------- the outline, as data ----------
  //
  // The pane knows which surface is showing, so it collects the headings and owns the jumps; the
  // workspace's Go to palette (⌘K) is where a reader asks for them. Nothing is painted here.

  /** @type {import("./outline.js").OutlineEntry[]} */
  let outlineEntries = [];
  /** Index into `outlineEntries` of the section the reader is standing in, or -1. */
  let outlineCurrent = -1;
  const outline = {
    /** @param {import("./outline.js").OutlineEntry[]} next */
    setEntries(next) {
      outlineEntries = Array.isArray(next) ? next : [];
      if (outlineCurrent >= outlineEntries.length) outlineCurrent = -1;
    },
    /** @param {number} index */
    setCurrent(index) {
      outlineCurrent = Number.isInteger(index) && index >= 0 && index < outlineEntries.length ? index : -1;
    },
  };
  /** Heading offsets inside the CURRENT surface's scroll content, in document order. Kept beside
   * the entries because tracking the reading position on every scroll frame must not re-measure
   * the document. */
  let outlineTops = [];
  /** What the source-face outline was last computed from. Mirroring a textarea to measure wrapped
   * line positions costs a layout flush per heading, so it runs when the text actually changed,
   * not on every render. */
  let outlineSourceKey = "";
  let outlineFrame = 0;
  let outlineSourceTimer = null;

  /** Which surface the outline is describing, and where scrolling happens in it.
   *
   * Read and Review navigate the rendered manuscript. Edit navigates whichever FACE is mounted —
   * the rich editor paints real headings, the source textarea has none and is parsed instead.
   * An outline that describes the page the reader is not looking at is worse than no outline. */
  function outlineSurface() {
    if (!currentArtifact || currentArtifact.class === "F") return null;
    if (!editWrap.hidden) {
      if (!richEl.hidden && richEditor) {
        const surface = richEl.querySelector(".glosa-rich-surface");
        return surface ? { kind: "rich", root: surface, scroller: paneMain, block: editWrap } : null;
      }
      if (!editArea.hidden) return { kind: "source", root: editArea, scroller: paneMain, block: editWrap };
      return null;
    }
    if (contentEl.hidden) return null;
    return { kind: "rendered", root: contentEl, scroller: paneMain, block: contentEl };
  }

  function syncOutlineCurrent() {
    const surface = outlineSurface();
    if (!surface || !outlineTops.length) {
      outline.setCurrent(-1);
      return;
    }
    outline.setCurrent(currentHeadingIndex(outlineTops, surface.scroller.scrollTop));
  }

  function refreshOutline() {
    const surface = outlineSurface();
    if (!surface) {
      outlineTops = [];
      outlineSourceKey = "";
      outline.setEntries([]);
      renderArtifactTools();
      return;
    }

    if (surface.kind === "source") {
      if (!sourceHeadingCollector) {
        outlineTops = [];
        outline.setEntries([]);
        sourceHeadingLoad ??= import("./markdown-parser.js")
          .then((module) => {
            sourceHeadingCollector = module.collectSourceHeadings;
            // Read the current face and text after loading: the user may have switched meanwhile.
            if (!destroyed) refreshOutline();
          })
          .catch(() => {
            sourceHeadingLoad = null;
          });
        return;
      }
      const text = editArea.value ?? "";
      const key = `${currentArtifact.source_path}:${editArea.clientWidth}:${text.length}:${text}`;
      if (key === outlineSourceKey) return;
      outlineSourceKey = key;
      const headings = sourceHeadingCollector(text);
      const depths = outlineDepths(headings);
      // The page scrolls in Edit, not the textarea, so each heading's top inside the textarea is
      // shifted by where the textarea itself sits in the page.
      const areaTop = editArea.getBoundingClientRect().top - paneMain.getBoundingClientRect().top + paneMain.scrollTop;
      const tops = measureTextareaOffsets(
        editArea,
        headings.map((heading) => heading.offset),
      ).map((top) => top + areaTop);
      outlineTops = tops;
      outline.setEntries(
        headings.map((heading, index) => ({
          level: heading.level,
          depth: depths[index],
          text: heading.text,
          // Jumping in the source face moves the CARET too: the reader opened the outline to get
          // somewhere in order to type there.
          jump: () => {
            editArea.focus({ preventScroll: true });
            editArea.setSelectionRange(heading.offset, heading.offset);
            scrollToOffset(paneMain, tops[index]);
          },
        })),
      );
      syncOutlineCurrent();
      renderArtifactTools();
      return;
    }

    outlineSourceKey = "";
    if (surface.kind === "rendered") stampAddresses();
    const headings = collectRenderedHeadings(surface.root);
    const depths = outlineDepths(headings);
    const scrollTop = surface.scroller.scrollTop;
    const base = surface.scroller.getBoundingClientRect().top;
    const tops = headings.map((heading) => heading.el.getBoundingClientRect().top - base + scrollTop);
    outlineTops = tops;
    outline.setEntries(
      headings.map((heading, index) => ({
        level: heading.level,
        depth: depths[index],
        text: heading.text,
        // The § the heading carries on the page (rendered surface only; the rich editor's headings
        // are not addressed, and the source face has no page to be addressed on).
        address: surface.kind === "rendered" ? (heading.el.getAttribute?.("data-address") ?? null) : null,
        jump: () => {
          scrollToOffset(surface.scroller, tops[index]);
          // Scrolling alone leaves a keyboard reader where they were. Focus follows the jump, on
          // the same borrowed-tabindex pattern `focusPreview` uses, so the heading is not left
          // permanently tabbable.
          const target = heading.el;
          if (!(target instanceof HTMLElement)) return;
          const borrowed = !target.hasAttribute("tabindex");
          if (borrowed) target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
          if (borrowed) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
        },
      })),
    );
    syncOutlineCurrent();
    renderArtifactTools();
  }

  /** Scroll events do not bubble, but they DO capture — one listener on the pane therefore tracks
   * the manuscript, the rich surface, and the source textarea without caring which is mounted. */
  function onPaneScroll() {
    if (outlineFrame) return;
    outlineFrame = requestAnimationFrame(() => {
      outlineFrame = 0;
      syncOutlineCurrent();
      // Whether a question needs its notice depends on whether its passage is on screen.
      renderNotice();
    });
  }
  paneEl.addEventListener("scroll", onPaneScroll, { capture: true, passive: true });

  /** Typing in the source face changes the outline. Debounced, because re-measuring a mirrored
   * textarea on every keystroke would be felt. */
  function onSourceInputForOutline() {
    if (outlineSourceTimer) clearTimeout(outlineSourceTimer);
    outlineSourceTimer = setTimeout(() => {
      outlineSourceTimer = null;
      refreshOutline();
    }, 400);
  }
  editArea.addEventListener("input", onSourceInputForOutline);

  // ---------- artifact bar behavior ----------

  function paneMenuControls() {
    return [
      historyMenuItem,
      copySourceButton,
      printArtifactButton,
      compareButton,
      ...moveGroup.querySelectorAll("button"),
    ].filter((control) => control && !control.disabled && !control.hidden);
  }

  function setToolsOpen(open, { restoreFocus = false } = {}) {
    if (open) refreshMoveCommands();
    tools.setAttribute("data-open", String(open));
    toolsTrigger.setAttribute("aria-expanded", String(open));
    if (open) queueMicrotask(() => paneMenuControls()[0]?.focus({ preventScroll: true }));
    else if (restoreFocus) queueMicrotask(() => toolsTrigger.focus({ preventScroll: true }));
  }

  toolsTrigger.addEventListener("click", () =>
    setToolsOpen(tools.getAttribute("data-open") !== "true", { restoreFocus: true }),
  );
  toolsMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setToolsOpen(false, { restoreFocus: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = paneMenuControls();
    if (controls.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, controls.indexOf(document.activeElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next].focus();
  });

  const onDocumentClick = (event) => {
    if (tools.getAttribute("data-open") !== "true") return;
    if (event.target instanceof Node && tools.contains(event.target)) return;
    setToolsOpen(false);
  };
  document.addEventListener("click", onDocumentClick);

  function setToolsStatus(message, { error = false } = {}) {
    toolsStatus.hidden = !message;
    toolsStatus.textContent = message;
    if (error) toolsStatus.setAttribute("data-error", "true");
    else toolsStatus.removeAttribute("data-error");
  }

  function renderArtifactTools() {
    const artifactPath = currentArtifact?.class === "R" ? currentArtifact.source_path : null;
    const available = artifactPath !== null;
    copySourceButton.hidden = !available;
    printArtifactButton.hidden = !available;
    compareButton.hidden = !available || !openDiffTab;
    // The source editor, and the reason it is unavailable when it is. The apply-lease pause used to
    // live on the mode control's Edit button; with that button gone (#271) it has to be stated
    // here, or a writer whose editing has been paused by a session would simply find a row that
    // quietly did nothing.
    const editable = available && canEdit(currentArtifact) && !readLock;
    editSourceButton.hidden = !editable;
    editSourceButton.disabled = Boolean(applyPause) && !fullPageEditor;
    editSourceButton.title = editSourceButton.disabled ? "A session is applying a change. Edit when it finishes." : "";
    const leaving = fullPageEditor;
    editSourceButton.querySelector("span").textContent = leaving ? "Done editing source" : "Edit source";
    editSourceButton.setAttribute(
      "aria-label",
      editSourceButton.disabled
        ? "Edit source, paused while a session applies a change"
        : isParked(modeState)
          ? "Edit source, unsaved draft kept"
          : leaving
            ? "Done editing source"
            : "Edit source",
    );
    editSourceButton.toggleAttribute("data-parked", isParked(modeState));
    if (toolsStatusArtifactPath !== artifactPath) {
      toolsStatusArtifactPath = artifactPath;
      setToolsStatus("");
    }
  }

  /** Shown exactly when the daemon said the bytes are not decodable. `!== false` rather than a
   * truthiness test for the same reason `canEdit` uses it: an N-1 daemon sends no field, and that
   * silence is not a claim that the file is broken. */
  function renderEncodingNotice() {
    encodingNoticeEl.hidden = loading || currentArtifact?.valid_utf8 !== false;
  }

  async function copyArtifactSource() {
    if (currentArtifact?.class !== "R") return;
    try {
      const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard access isn't available in this browser.");
      await clipboard.writeText(currentArtifact.content ?? "");
      setToolsStatus("Source copied.");
    } catch {
      setToolsStatus("Couldn't copy source. Try again while this tab is focused.", { error: true });
    }
  }

  function printArtifact() {
    if (currentArtifact?.class !== "R") return;
    // Edit mode hides the manuscript canvas, so materialize the current rendered snapshot before
    // the print stylesheet reveals it. Unsaved source edits intentionally do not enter the export.
    if (contentEl.getAttribute("data-path") !== currentArtifact.source_path) {
      contentEl.innerHTML = currentArtifact.rendered_html ?? "";
      contentEl.setAttribute("data-path", currentArtifact.source_path);
    }
    // The print stylesheet reveals exactly one pane: the one that asked. Marking it here rather
    // than in the print rules keeps "which document am I printing" unambiguous with six open.
    paneEl.setAttribute("data-printing", "true");
    const clear = () => paneEl.removeAttribute("data-printing");
    if (typeof window.print !== "function") {
      clear();
      setToolsStatus("Printing isn't available in this browser.", { error: true });
      return;
    }
    window.addEventListener("afterprint", clear, { once: true });
    window.print();
    // Safari has historically skipped `afterprint`; a microtask-deferred clear cannot fire before
    // the modal print sheet closes, so the timeout is the honest belt to that braces.
    setTimeout(clear, 2000);
  }

  /** Opens this artifact's newest saved version against the working file as a diff tab. The
   * History surface remains the place to compare an arbitrary pair. */
  async function compareWithLastSaved() {
    if (!openDiffTab || currentArtifact?.class !== "R") return;
    setToolsStatus("Loading versions…");
    try {
      const rows = await dataAccess.getCheckpoints(slug, { limit: 1 });
      const latest = rows?.[0]?.checkpoint_id;
      if (!latest) {
        setToolsStatus("This artifact has no saved versions to compare with yet.");
        return;
      }
      setToolsStatus("");
      openDiffTab({ path: currentArtifact.source_path, from: latest, to: "working" });
    } catch (error) {
      setToolsStatus(
        error instanceof Error ? `Couldn't load versions: ${error.message}` : "Couldn't load versions. Try again.",
        { error: true },
      );
    }
  }

  // ---------- history, per pane (§6: history.js keys on slug AND path) ----------

  function toggleHistory() {
    historyVisible = !historyVisible;
    historyEl.hidden = !historyVisible;
    historyToggle.setAttribute("aria-expanded", String(historyVisible));
    historyMenuItem.setAttribute("aria-expanded", String(historyVisible));
    if (historyVisible) void renderHistory();
    else refreshHistory = null;
  }

  historyToggle.addEventListener("click", toggleHistory);

  async function renderHistory() {
    if (!historyVisible || !slug) return;
    const artifactPath = currentArtifact?.source_path;
    try {
      const mountHistoryPane = await loadHistoryPane();
      if (destroyed || !historyVisible || currentArtifact?.source_path !== artifactPath) return;
      refreshHistory = mountHistoryPane(historyEl, {
        dataAccess,
        slug,
        path: artifactPath,
        canRestore: modeState.mode === "edit",
        onCompare: openDiffTab ? (range) => openDiffTab({ path: artifactPath, ...range }) : undefined,
        onClose: () => {
          historyVisible = false;
          historyEl.hidden = true;
          historyToggle.setAttribute("aria-expanded", "false");
          historyMenuItem.setAttribute("aria-expanded", "false");
          refreshHistory = null;
          historyToggle.focus({ preventScroll: true });
        },
      });
      queueMicrotask(() => historyEl.querySelector("h3")?.focus({ preventScroll: true }));
    } catch {
      if (destroyed || !historyVisible) return;
      historyEl.setAttribute("role", "alert");
      historyEl.textContent = "History couldn't be loaded. Close this panel and try again.";
    }
  }

  // ---------- approval strip (§6: moves into the pane, sticky above the manuscript) ----------

  function matchingApprovalRequest() {
    const artifactPath = currentArtifact?.source_path;
    if (!artifactPath) return null;
    return (
      getAttentionEntries().find(
        (entry) => entry.approval_mode === true && (entry.target_path ?? entry.target) === artifactPath,
      ) ?? null
    );
  }

  function renderApprovalStrip() {
    approvalStrip.textContent = "";
    const currentPath = currentArtifact?.source_path;
    if (approvalResult && approvalResult.path === currentPath) {
      approvalStrip.hidden = false;
      approvalStrip.setAttribute("data-state", "success");
      approvalStrip.append(
        el("div", { className: "glosa-approval-copy" }, [
          el("strong", { textContent: "Revision approved" }),
          el("span", {
            textContent: `Revision ${approvalResult.revisionId.slice(0, 12)} is approved. Later edits do not change that verdict.`,
          }),
        ]),
      );
      return;
    }

    const request = matchingApprovalRequest();
    if (!request) {
      approvalStrip.hidden = true;
      approvalStrip.removeAttribute("data-state");
      return;
    }

    approvalStrip.hidden = false;
    approvalStrip.setAttribute("data-state", approvalError ? "error" : approvalBusy ? "loading" : "ready");
    const supportingText =
      request.message ||
      (request.action && request.action !== "review"
        ? `Requested check: ${request.action}`
        : "Review this artifact before approving its saved revision.");
    const copy = el("div", { className: "glosa-approval-copy" }, [
      el("strong", { textContent: "Final approval requested" }),
      el("span", { textContent: supportingText }),
    ]);
    const status = el("p", {
      className: "glosa-approval-status",
      role: approvalError ? "alert" : "status",
      "aria-live": "polite",
      textContent: approvalError || (approvalBusy ? "Saving and approving…" : ""),
      hidden: !approvalError && !approvalBusy,
    });
    const button = el("button", {
      className: "glosa-approval-button",
      type: "button",
      textContent: approvalBusy ? "Approving…" : "Final approval",
      onClick: () => void approveCurrentArtifact(request),
    });
    button.disabled = approvalBusy;
    approvalStrip.append(copy, el("div", { className: "glosa-approval-actions" }, [status, button]));
  }

  async function approveCurrentArtifact(request) {
    if (approvalBusy || !currentArtifact || request !== matchingApprovalRequest()) return;
    if (composer?.submitting || composer?.draft?.trim()) {
      approvalError = "Send or cancel the annotation draft before final approval.";
      if (composer) composer.error = approvalError;
      renderMargin();
      renderApprovalStrip();
      queueMicrotask(() => composerLayerEl.querySelector(".glosa-composer-input")?.focus({ preventScroll: true }));
      return;
    }

    approvalError = "";
    const dirty = currentArtifact.class === "R" && (modeState.dirty || Boolean(richEditor?.isDirty()));
    const confirmed = await confirmDialog({
      title: "Approve this revision?",
      body: dirty
        ? "Your pending edits will be saved first. This approves that exact saved revision; later edits will not change the approval."
        : "This approves the current saved revision. Later edits will not change the approval.",
      confirmLabel: "Approve revision",
    });
    if (!confirmed || request !== matchingApprovalRequest()) return;

    approvalBusy = true;
    renderApprovalStrip();
    try {
      if (dirty && (await saveCurrentArtifact({ onlyIfDirty: true })) === SAVE_DECLINED) {
        // The reader was told "your pending edits will be saved first" and then declined the save.
        // Approving now would attach the verdict to the revision on disk, not the one on screen.
        approvalError = "Nothing was approved: your edits were not saved. Save them, then approve.";
        return;
      }
      const revisionId = currentArtifact?.source_sha256;
      if (!revisionId) throw new Error("The saved artifact has no revision identifier.");
      const result = await dataAccess.respondToAttention(slug, request.id, { outcome: "approved", revisionId });
      const verdict = result?.detail ?? {};
      approvalResult = { path: currentArtifact.source_path, revisionId: verdict.revision_id ?? revisionId };
      approvalError = "";
      void refreshAttention();
    } catch (error) {
      const revisionChanged = String(error?.problem?.type ?? "").includes("artifact-revision-changed");
      approvalError = revisionChanged
        ? "The artifact changed before approval. Review the latest revision and try again."
        : error instanceof Error
          ? `Couldn’t approve this revision: ${error.message}`
          : "Couldn’t approve this revision. Try again.";
    } finally {
      approvalBusy = false;
      renderApprovalStrip();
    }
  }

  // ---------- mode control ----------

  // R6/A5 §F11: class-F Edit follows the generic derived-from edge — enabled only when the
  // artifact metadata carries a `derived_from` path (supplied by a content adapter, P6.1; the
  // core itself never invents one). With no edge, class F is opaque: Preview + Annotate only.
  //
  // `valid_utf8: false` (#250) joins the same predicate rather than getting a branch of its own:
  // the file's bytes cannot be decoded, so the string this pane holds is a replacement-character
  // copy and an ordinary save would write it back over what it could not read. Refusing to edit is
  // the honest answer; the preview stays, and `renderEncodingNotice` says why. Compared with
  // `!== false`, not falsily — an N-1 daemon sends no such field, and an absent field must mean
  // "no claim made", never "not valid".
  function canEdit(artifact) {
    return (artifact?.class !== "F" || Boolean(artifact.derived_from)) && artifact?.valid_utf8 !== false;
  }

  function renderModeBar() {
    const restoreModeFocus = modeBar.contains(document.activeElement);
    modeBar.textContent = "";
    // One page, two states. Reading and reviewing are the same page with the margin shown or
    // hidden, so they share one Notes toggle; Edit is a deliberate state of that page with Done
    // to leave it. The three states underneath (read / review / edit) are unchanged, because links,
    // `glosa open` and `glosa_present` name them. Every button carries the `data-mode` it moves to.
    //
    // A read lock is a UI affordance expressing intent ("not for review"), not authorization — the
    // Notes and Edit controls and their shortcuts are omitted for this visit; the annotation API
    // still accepts authenticated POSTs.
    // TWO STATES, EITHER OR NEITHER. Note and Edit are the two things a reader can turn on, and
    // they turn each other off, because they claim the same gesture and mean opposite things by it:
    // in Note a click reaches a passage to comment on, in Edit it puts a caret in one. Neither
    // pressed is the manuscript and nothing else — the state a reader who only wants to read should
    // be able to get back to, and the reason this is two buttons rather than a three-way control
    // that would cost a third more width in a bar that already collapses to icons.
    //
    // It is also the only thing on the page that says editing exists. Click-to-edit shipped with no
    // affordance at all: a paragraph looked exactly as it had before, and nothing invited the click.
    if (!readLock) {
      const noting = modeState.mode === "review";
      const editing = modeState.mode === "edit";
      const note = modeButton(noting ? "read" : "review", "review", "Note");
      note.setAttribute("aria-label", noting ? "Hide notes" : "Show notes");
      note.setAttribute("aria-pressed", String(noting));
      note.setAttribute("data-control", "notes");
      modeBar.append(note);
      // Absent, not disabled, when this artifact cannot be written to: a control that is there and
      // does nothing is a worse answer than one that is honestly not offered. `canEdit` covers the
      // artifact; the apply lease is a moment, not a property, so it disables rather than removes.
      if (!currentArtifact || canEdit(currentArtifact)) {
        const edit = modeButton(editing ? "read" : "edit", "edit", "Edit");
        edit.setAttribute("aria-label", editing ? "Stop editing" : "Edit this document");
        edit.setAttribute("aria-pressed", String(editing));
        edit.setAttribute("data-control", "edit");
        if (applyPause && !editing) {
          edit.disabled = true;
          edit.title = "A session is applying a change. Edit when it finishes.";
        }
        modeBar.append(edit);
      }
      // The state the reader cannot see: a draft parked off screen says so on whichever control
      // would take them back to it.
      if (isParked(modeState)) {
        const parkedOn = modeBar.querySelector('[data-control="edit"]') ?? note;
        parkedOn.setAttribute("data-parked", "true");
        parkedOn.setAttribute("aria-label", `${parkedOn.getAttribute("aria-label")}, unsaved draft kept`);
      }
    }
    for (const btn of modeBar.querySelectorAll("button")) {
      if (!currentArtifact) btn.disabled = true;
    }
    modeLabel.textContent = modeState.mode;
    if (restoreModeFocus) {
      queueMicrotask(() =>
        (modeBar.querySelector("button:not(:disabled)") ?? modeBar)?.focus?.({ preventScroll: true }),
      );
    }
  }

  function modeButton(target, icon, label) {
    const btn = el("button", { type: "button", "data-mode": target, onClick: () => setMode(target) });
    // Icon plus label: the label is what a comfortable pane shows, the icon is what survives
    // §6's collapse ladder. The accessible name never depends on which one is painted.
    btn.innerHTML = `${MODE_ICONS[icon]}<span class="glosa-control-label"></span>`;
    btn.querySelector(".glosa-control-label").textContent = label;
    return btn;
  }

  function setEmpty(title, hint) {
    emptyEl.textContent = "";
    emptyEl.append(el("p", { className: "glosa-empty-title", textContent: title }));
    if (hint) emptyEl.append(hint);
  }

  function renderTitle() {
    const artifactPath = currentArtifact?.source_path ?? path;
    const { dir, name } = splitPath(artifactPath);
    const tabLabel = getTabLabel();
    // The tab is the name; the bar is the address. Printing the filename in both rows is the
    // clutter this split removes — so the bar renders exactly the leading path segments the tab
    // had no room for, and disappears when the tab already said everything.
    const context = tabLabel === null ? dir : residualPath(artifactPath, tabLabel);
    const { head, tail } = splitDirectory(context);
    artifactDirHeadEl.textContent = head;
    artifactDirTailEl.textContent = tail;
    artifactDirEl.hidden = !context;
    artifactNameEl.textContent = tabLabel === null ? name : "";
    artifactNameEl.hidden = tabLabel !== null;
    // The identity slot keeps its place in the row even with nothing to say, so the control
    // cluster sits at the same edge whether or not this artifact happens to live in a
    // subdirectory. Its tooltip still carries the full path, so the empty space is hoverable.
    artifactIdEl.setAttribute("data-empty", String(!context && tabLabel !== null));
    // The tooltip always carries the full path, whatever the bar had room to paint (§5), and the
    // pane names itself for assistive technology even when it paints nothing.
    artifactIdEl.title = artifactPath;
    paneEl.setAttribute("aria-label", artifactPath);
  }

  // ---------- editor faces (§8) ----------

  /** Mounts the rich face over `markdown`. A DOM that can't host a ProseMirror view (or any
   * other mount failure) falls back to the source textarea rather than a broken editor. */
  async function mountRichFace(markdown) {
    if (richEditorLoading) {
      // A newer mount request arrived while the editor module was still loading. Dropping it
      // mounts whatever the FIRST caller happened to hold, and the first call can happen before
      // the baseline pair has arrived — so the face came up EMPTY. Invisible while the module was
      // already in the page (the load resolved in the same tick), and immediate once it is fetched
      // lazily, which is how `import-boundary.test.ts` and the browser round-trip ended up
      // demanding opposite things. Hand the in-flight mount the newer bytes instead of discarding
      // them; both callers pass the same held-baseline expression, so the later evaluation is the
      // one that actually has it.
      pendingRichMarkdown = markdown;
      return;
    }
    richEditorLoading = true;
    pendingRichMarkdown = markdown;
    const request = ++richMountRequest;
    try {
      const mountRichEditor = await loadRichEditor();
      if (request !== richMountRequest || sourceFace || modeState.mode !== "edit" || !currentArtifact) return;
      richEditor = mountRichEditor(richEl, {
        markdown: pendingRichMarkdown ?? markdown,
        onDirty: () => {
          modeState = modeReducer(modeState, { type: "edited" });
          setEditStatus("");
          onStateChange();
        },
      });
      renderContent();
    } catch {
      if (request !== richMountRequest) return;
      richEditor = null;
      sourceFace = true;
      renderContent();
      // #182 F-8: `renderContent()`'s own fallback fills the textarea from
      // `currentArtifact.content`, which an SSE refresh landing WHILE `loadRichEditor()` was
      // still pending can have advanced past the held baseline pair — a later Keep-mine merge
      // would then run against text the writer never actually saw mounted. Fill from the exact
      // bytes THIS mount was asked to render instead (consistent with whatever baseline pair was
      // current when `mountRichFace` was called), unless a parked draft still outranks it — the
      // same precedence `renderContent()` already applies, restated here because it runs after.
      editArea.value = parkedSourceFor(currentArtifact) ?? pendingRichMarkdown ?? markdown;
    } finally {
      if (request === richMountRequest) {
        richEditorLoading = false;
        pendingRichMarkdown = null;
      }
    }
  }

  function teardownRichFace() {
    richMountRequest += 1;
    richEditorLoading = false;
    pendingRichMarkdown = null;
    richEditor?.destroy();
    richEditor = null;
  }

  /**
   * Captures unsaved work so a mode switch — including one the agent causes — costs nothing.
   *
   * Two drafts can be in flight, and they are parked separately because they have different
   * lifetimes: source text belongs to an artifact and survives switching away to another file and
   * back, so it is keyed by path; a half-written margin note belongs to a passage in the artifact
   * currently open, so it rides in a single slot.
   *
   * Reads only. Restoring is `restoreParkedSource`'s job and clearing is `clearParkedSource`'s, so
   * a park can never be the thing that loses the text.
   */
  function parkDrafts() {
    if (currentArtifact && (modeState.dirty || richEditor?.isDirty())) {
      const save = !sourceFace && richEditor ? richEditor.getSave() : null;
      const text = save ? save.markdown : editArea.value;
      if (typeof text === "string") {
        parkedSource = { path: currentArtifact.source_path, text };
        // Re-mounting the rich face over this text makes it the baseline, so anything still
        // needing the writer's say-so has to survive the round trip rather than being parked away.
        pendingReport = reportToCarry(save, text) ?? (pendingReport?.text === text ? pendingReport : null);
      }
    }
    if (composer) {
      const input = composerLayerEl.querySelector(".glosa-composer-input");
      parkedComposer = {
        path: currentArtifact?.source_path ?? null,
        state: { ...composer, draft: input instanceof HTMLTextAreaElement ? input.value : composer.draft },
      };
    }
  }

  /** The parked source for the artifact on screen, or null. Path-keyed so a draft never lands in
   * a different file — the one way parking could do real damage. */
  function parkedSourceFor(artifact) {
    return parkedSource && artifact && parkedSource.path === artifact.source_path ? parkedSource.text : null;
  }

  function clearParkedSource() {
    parkedSource = null;
  }

  /**
   * Pins `baselineSha` to the bytes a face is about to be filled from. Called from `setMode`'s
   * Edit-entry transition and from `loadArtifact`'s tail when the pane opens directly in Edit.
   *
   * Gated on a parked draft for THIS path, not on `isDirty()`: `isDirty()` folds in
   * `richEditor?.isDirty()`, so it would depend on whether the async `mountRichFace` had landed
   * yet, and `modeState.dirty` survives opening a DIFFERENT artifact in this pane — neither is the
   * question "is there already a live draft for the file about to fill this face".
   */
  /** The one place `{baselineSha, baselineContent}` moves, always together, from the SAME read
   * (#182 R1). Every other assignment site below calls this rather than touching either field. */
  function setBaseline(sha, content) {
    baselineSha = sha;
    baselineContent = content;
  }

  function beginEditSession() {
    if (currentArtifact?.class !== "R" || parkedSourceFor(currentArtifact) !== null) return;
    setBaseline(currentArtifact.source_sha256, currentArtifact.content ?? "");
    // The baseline just caught up to this sha, so any earlier "changed on disk" fact — recorded
    // against the OLD baseline — no longer describes what a save would refuse. Without this, a
    // clean pane that leaves Edit and returns would keep showing a banner the file has already
    // caught up to.
    clearDiskChange();
    void pinEditSession();
  }

  /**
   * D4: `editSession` is pinned once per draft, not once per mode switch. `openedCheckpointId` is
   * Compare's `from` (§3.7, later in this epic); `attributionCursor` starts there and is what
   * `resolveDiskAttribution` advances. Fired as `void` from `beginEditSession` — a slow or failed
   * lookup must never hold up the face it was called from.
   *
   * The pin need not be a checkpoint OF this artifact: shadow-git checkpoints are whole-worktree
   * commits, so any one is a valid tree to diff a single file against.
   */
  async function pinEditSession() {
    const pinnedBaseline = baselineSha;
    let rows;
    try {
      rows = await dataAccess.getCheckpoints(slug, { limit: 1 });
    } catch {
      return; // failure leaves the pin null; Compare degrades to compareWithLastSaved's behaviour
    }
    // The draft this was pinning for already ended (a save, a discard, or a fresh load) before the
    // lookup came back — landing it now would resurrect a session nothing is tracking anymore.
    if (baselineSha !== pinnedBaseline) return;
    const checkpointId = rows[0]?.checkpoint_id ?? null;
    editSession = { openedCheckpointId: checkpointId, attributionCursor: checkpointId };
  }

  function endEditSession() {
    editSession = null;
  }

  /** Puts a parked margin note back when Review is re-entered on the artifact it was written
   * against. A note parked against a different file stays parked rather than reopening somewhere
   * it does not belong. */
  function restoreParkedComposer() {
    if (!parkedComposer || composer || modeState.mode !== "review") return;
    if (!currentArtifact || parkedComposer.path !== currentArtifact.source_path) return;
    composer = parkedComposer.state;
    parkedComposer = null;
  }

  function renderFaceToggle() {
    faceRichBtn.setAttribute("aria-pressed", String(!sourceFace));
    faceSourceBtn.setAttribute("aria-pressed", String(sourceFace));
    // §8: the measure follows the face, not the mode. app.css reads this attribute.
    paneEl.setAttribute("data-editor-face", sourceFace ? "source" : "rich");
  }

  // ---------- manuscript ----------

  /** Makes every top-level rendered block a focus target, in whichever state claims the passage.
   *
   * BOTH STATES, NOT JUST REVIEW. This was Review-only, and the consequence was that Edit — the
   * one state that writes the user's files — could not be entered from a keyboard at all. A reader
   * could tab to the Edit control, press it, and then face a document with no focusable blocks and
   * no key that opened one; the roving tabindex they had a moment earlier in Review was taken away
   * by the very switch that was supposed to let them write. Everything inside an open run is
   * already keyboard-complete (arrows cross the seam, Backspace merges), so the gap was the door,
   * not the room.
   *
   * What Enter means differs — annotate in Review, put a caret in it in Edit — and that belongs in
   * the keydown handler. The reachability is the same question in both, so it is answered once. */
  function updateBlockTargets() {
    for (const block of contentEl.querySelectorAll(".glosa-block-target")) {
      block.classList.remove("glosa-block-target");
      block.removeAttribute("tabindex");
      block.removeAttribute("aria-describedby");
    }
    blockTargetInstructions.hidden = true;
    contentEl.removeAttribute("aria-describedby");
    const reachable = modeState.mode === "review" || (modeState.mode === "edit" && runEditingAvailable());
    if (loading || !reachable || !currentArtifact || currentArtifact.class === "F") return;
    blockTargetInstructions.textContent = BLOCK_TARGET_HELP[modeState.mode];
    blockTargetInstructions.hidden = false;
    contentEl.setAttribute("aria-describedby", blockTargetInstructions.id);
    const blocks = Array.from(contentEl.querySelectorAll(":scope > [data-line]")).filter((block) =>
      block.textContent.trim(),
    );
    const focusedIndex = blocks.indexOf(document.activeElement);
    if (focusedIndex >= 0) blockTargetFocusIndex = focusedIndex;
    blockTargetFocusIndex = Math.min(blockTargetFocusIndex, Math.max(0, blocks.length - 1));
    for (const [index, block] of blocks.entries()) {
      block.classList.add("glosa-block-target");
      block.setAttribute("tabindex", index === blockTargetFocusIndex ? "0" : "-1");
    }
  }

  /** The source face grows with its text so the page, not the textarea, is what scrolls in Edit:
   * one scrollbar for the whole page, and the reader's place survives entering and leaving it. */
  function fitSourceArea() {
    if (editArea.hidden) return;
    editArea.style.height = "auto";
    editArea.style.height = `${editArea.scrollHeight + 2}px`;
  }
  editArea.addEventListener("input", fitSourceArea);

  // ---------- per-block editing (#271) ----------

  /** How long the page stays quiet before an edited run reaches disk.
   *
   * Every write captures a `checkpoint_before`/`checkpoint_after` pair, so nothing here is
   * unrecoverable — but every write ALSO creates one inbox entry the agent sees. Writing on each
   * blur would send a session of edits as one entry per paragraph; coalescing sends one per burst
   * of work. Long enough to gather a train of thought, short enough that leaving the desk does not
   * leave the file behind. */
  const RUN_SAVE_DELAY = 1200;

  /** The editor module, fetched once and remembered.
   *
   * A dynamic import on purpose: `import-boundary.test.ts` pins that the Read/Review static graph
   * cannot reach `vendor/prosemirror.js`, and a static import here would drag 400 KB into the first
   * paint of a document nobody may ever edit. Warmed when an editable artifact opens rather than on
   * the first click, so the reader does not wait for a fetch at the moment they meant to type. */
  function loadEditorKit() {
    editorKitPromise ??= import("./rich-editor.js").then(async (editor) => ({
      ...editor,
      renderMarkdown: (await import("./markdown-parser.js")).renderMarkdown,
    }));
    return editorKitPromise;
  }

  /** The source every run measures against: local edits when there are any, the file otherwise. */
  function currentSource() {
    return workingSource ?? currentArtifact?.content ?? "";
  }

  /** Whether this artifact can be written to at all, right now.
   *
   * ONLY IN EDIT. Note and Edit claim the same click and mean opposite things by it — reaching a
   * passage to comment on, and putting a caret in one — so the page is in exactly one of them, and
   * in neither it is only words. */
  function runEditingAvailable() {
    if (readLock || applyPause || loading) return false;
    if (modeState.mode !== "edit") return false;
    return Boolean(currentArtifact) && currentArtifact.class === "R" && canEdit(currentArtifact);
  }

  /** The run a rendered block stands for, or null when the click did not land on one.
   *
   * Matched on `data-line` rather than on the block's position among its siblings, because the
   * renderer hides front matter and `%%` comments: those produce a source span but no element, so
   * the first rendered block is not always the first run. */
  async function runForBlock(blockEl) {
    const line = Number(blockEl?.getAttribute?.("data-line"));
    if (!Number.isInteger(line)) return null;
    const kit = await loadEditorKit();
    const source = currentSource();
    const runs = runsFrom(source, kit.blockLayout(source).blocks);
    return runAtLine(runs, line);
  }

  /** Opens `blockEl` for editing, with the caret where the reader clicked. */
  async function openRunEditor(blockEl, coords) {
    if (!runEditingAvailable() || openRun) return;
    const run = await runForBlock(blockEl);
    // Re-checked after the await: a session can take the apply lease, or the pane can change
    // artifact, while the editor module is still being fetched.
    if (!run || !runEditingAvailable() || openRun || !contentEl.contains(blockEl)) return;
    const kit = await loadEditorKit();
    if (!runEditingAvailable() || openRun || !contentEl.contains(blockEl)) return;

    const address = blockEl.getAttribute("data-address");
    const host = el("div", { className: "glosa-run-editor" });
    if (address) host.setAttribute("data-address", address);
    // Geometry cancellation, measured rather than guessed. `.glosa-content` spaces its blocks
    // asymmetrically on purpose — 3rem above an h2 against 0.75rem below it — so a host with one
    // fixed margin would be right for prose and wrong for everything else, and a tag -> spacing
    // table here would be a second copy of the manuscript's scale, free to drift from it. Reading
    // the used values off the element while it is still in flow costs one layout read and cannot
    // disagree with the stylesheet, because it IS the stylesheet's answer.
    //
    // Prose no longer depends on this: app.css gives paragraphs, lists and code blocks a gap on
    // both edges, so a neighbour holds up its own side of the space whatever happens here. This is
    // what covers the blocks whose spacing is genuinely their own.
    const { marginTop, marginBottom } = getComputedStyle(blockEl);
    host.style.marginBlock = `${marginTop} ${marginBottom}`;
    // The one thing a margin cannot carry across the swap. A heading closes the gap under itself
    // through `heading + prose`, and that selector stops matching the instant the heading leaves
    // the flow — so the paragraph below would spring open by its own leading gap. One flag keeps
    // the rule matching; the spacing itself still comes from the measurement above.
    if (/^H[1-6]$/.test(blockEl.tagName)) host.setAttribute("data-heading", "");
    blockEl.replaceWith(host);
    let editor;
    try {
      editor = kit.mountRichEditor(host, {
        markdown: currentSource().slice(run.start, run.end),
        toolbar: false,
        label: address ? `Editing ${address}` : "Editing this passage",
        onDirty: () => {
          host.setAttribute("data-dirty", "true");
          onStateChange();
        },
        onBoundary: (edge) => onRunBoundary(edge),
        selectionToolbar: true,
      });
    } catch {
      // A DOM that cannot host a ProseMirror view. Put the block back and leave the page as it was
      // rather than stranding the reader on an empty host.
      host.replaceWith(blockEl);
      return;
    }
    openRun = { run, host, block: blockEl, editor, address, prefix: "" };
    editor.focusAt(coords);
    onStateChange();
  }

  /** Opens an editor past the end of the document, for writing something that is not there yet.
   *
   * The gap the per-block redesign shipped with: every gesture it understood named an existing
   * block, so a document could be changed word by word and never GROW. Clicking the space under the
   * last paragraph is how a writer says "more", and on an empty document it is the only thing there
   * is to click.
   *
   * Nothing is written to open it. The run is an empty span at the end of the source, so a click
   * that turns out to be a misclick closes over an unchanged document and leaves no blank line
   * behind — which is what lets this be a click rather than a decision.
   */
  async function openAppendEditor() {
    if (!runEditingAvailable() || openRun) return;
    const kit = await loadEditorKit();
    if (!runEditingAvailable() || openRun) return;
    const source = currentSource();
    const end = source.length;
    // Exactly enough newlines to make what follows a block of its own, and none when the file
    // already ends with a blank line or has no bytes at all.
    const prefix = end === 0 ? "" : source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    const host = el("div", { className: "glosa-run-editor", "data-appended": "true" });
    contentEl.append(host);
    let editor;
    try {
      editor = kit.mountRichEditor(host, {
        markdown: "",
        toolbar: false,
        label: "Writing a new passage",
        onDirty: () => {
          host.setAttribute("data-dirty", "true");
          onStateChange();
        },
        onBoundary: (edge) => onRunBoundary(edge),
        selectionToolbar: true,
      });
    } catch {
      host.remove();
      return;
    }
    openRun = { run: { start: end, end, index: -1, line: -1 }, host, block: null, editor, address: null, prefix };
    editor.focus();
    onStateChange();
  }

  /** A keystroke that would carry the caret out of the open run, answered across the seam.
   *
   * Returning false leaves the key to the editor, which is what happens at the real edges of the
   * document — Backspace at the very first character has nothing above it to join, and the honest
   * answer there is the one every editor gives: nothing.
   * @param {"up" | "down" | "backspace" | "delete"} edge */
  function onRunBoundary(edge) {
    if (!openRun) return false;
    if (edge === "up" || edge === "down") {
      void stepToNeighbour(edge === "up" ? -1 : 1);
      return true;
    }
    void mergeAcross(edge === "backspace" ? -1 : 1);
    return true;
  }

  /** Closes the open run and opens the one beside it, caret at the edge the reader arrived from.
   *
   * Everything here re-measures AFTER the close, and finds the run again by its START OFFSET rather
   * than by its line or its index. Closing can rewrite the run's own bytes, which moves every line
   * below it — so a line number read before the close names a different passage after it. A splice
   * copies everything before the run untouched, so the offset it begins at is the one thing the
   * close cannot move. */
  async function stepToNeighbour(direction) {
    const from = openRun.run.start;
    await closeRunEditor();
    const neighbour = await runBeside(from, direction);
    if (!neighbour) return;
    const block = contentEl.querySelector(`:scope > [data-line="${neighbour.line}"]`);
    if (!(block instanceof HTMLElement)) return;
    await openRunEditor(block, null);
    // Arriving from below means the caret belongs at the end of what it just entered, and from
    // above at the start — the caret keeps travelling the way it was already travelling.
    if (direction < 0) openRun?.editor?.focusAtOffset?.(neighbour.end - neighbour.start);
  }

  /** Joins the open run with the one beside it and reopens the pair as one passage.
   *
   * Backspace at the head of a paragraph means "this belongs to the one above", and until now it
   * meant nothing at all, because a block editor could not reach past its own bytes. The join is a
   * splice like every other write here: what goes is the separator between the two blocks. */
  async function mergeAcross(direction) {
    const from = openRun.run.start;
    await closeRunEditor();
    const source = currentSource();
    const kit = await loadEditorKit();
    const runs = runsFrom(source, kit.blockLayout(source).blocks);
    const current = runs.find((run) => run.start === from);
    if (!current) return;
    const other = runs[current.index + direction];
    if (!other) return; // the top or the foot of the document: nothing to join to, and nothing happens
    const first = direction < 0 ? other : current;
    const second = direction < 0 ? current : other;
    const joined = source.slice(first.start, first.end) + source.slice(second.start, second.end);
    const span = { start: first.start, end: second.end };
    workingSource = spliceRun(source, span, joined);
    runUndo.push({
      start: first.start,
      end: first.start + joined.length,
      before: source.slice(span.start, span.end),
      after: joined,
    });
    await repaintFromWorkingSource();
    scheduleRunSave();
    const block = contentEl.querySelector(`:scope > [data-line="${first.line}"]`);
    if (!(block instanceof HTMLElement)) return;
    await openRunEditor(block, null);
    // At the join, which is where the caret was: the two halves met at the end of the first.
    openRun?.editor?.focusAtOffset?.(first.end - first.start);
  }

  /** The run before or after the one beginning at `from`, measured against the source as it stands.
   * Null at the document's edges, which is what makes those keystrokes do nothing there. */
  async function runBeside(from, direction) {
    const kit = await loadEditorKit();
    const source = currentSource();
    const runs = runsFrom(source, kit.blockLayout(source).blocks);
    const current = runs.find((run) => run.start === from);
    if (!current) return null;
    // Asked through `widenToPrevious`/`widenToNext` rather than by indexing, so "is there one
    // beside it" is answered by the same pure function the splice contract already uses, in one
    // place, rather than by two off-by-one-prone comparisons here.
    const widened = direction < 0 ? widenToPrevious(runs, current) : widenToNext(runs, current);
    if (widened.start === current.start && widened.end === current.end) return null;
    return runs[current.index + direction] ?? null;
  }

  /** Commits the open run and puts the rendered page back.
   *
   * The whole point of the design lives here: the page is never replaced, so closing a run repaints
   * exactly the blocks whose bytes changed and leaves every other element — and the reader's scroll
   * position with it — untouched. */
  async function closeRunEditor({ save = true } = {}) {
    if (!openRun) return;
    const { run, host, block, editor, prefix } = openRun;
    openRun = null;
    const before = currentSource().slice(run.start, run.end);
    const after = save ? editor.getMarkdown() : before;
    editor.destroy();

    if (after === before) {
      // Nothing changed: restore the element that was there rather than re-rendering the document,
      // so an accidental click costs no repaint and no journal entry. An appended run has no
      // element to restore — it stood for bytes that were never written — so it simply goes.
      if (block) host.replaceWith(block);
      else host.remove();
      onStateChange();
      await settleHeldRefresh();
      return;
    }

    // `prefix` is the blank line an appended passage needs to be a block of its own rather than
    // more of the last one. Nothing when the run replaces existing bytes, and nothing when the
    // writer typed nothing, so an abandoned append leaves no trailing whitespace behind.
    const written = after && prefix ? prefix + after : after;
    workingSource = spliceRun(currentSource(), run, written);
    runUndo.push({ start: run.start, end: run.start + written.length, before, after: written });
    host.remove();
    await repaintFromWorkingSource();
    scheduleRunSave();
    await settleHeldRefresh();
  }

  /** Takes an external frame that arrived while a run was open — but only when the writer has
   * nothing unsaved.
   *
   * With local edits pending, the page keeps showing THEIR document: painting the session's version
   * over it would be the same silent loss this whole change removes, moved a second later. The two
   * versions meet where they were always meant to, at the save, where `If-Match` refuses a stale
   * write and the conflict dialog asks whose version of each block to keep. Until then the
   * disk-change notice is what says the file moved. */
  async function settleHeldRefresh() {
    if (!heldExternalRefresh) return;
    heldExternalRefresh = false;
    if (isDirty()) return;
    await refreshArtifact();
  }

  /** Repaints the manuscript from the local source and re-applies everything painted on top of it.
   *
   * Idiomorph rather than `innerHTML`, so unchanged blocks keep their identity — which is what
   * keeps the reader's scroll position, and what stops the annotation highlights from being
   * rebuilt against nodes that were thrown away. */
  async function repaintFromWorkingSource() {
    const kit = await loadEditorKit();
    morphArtifactContent(contentEl, kit.renderMarkdown(currentSource()));
    contentEl.setAttribute("data-path", currentArtifact?.source_path ?? "");
    updateBlockTargets();
    renderMargin();
    refreshOutline();
    onStateChange();
  }

  /** Reverts the last committed run. Cmd-Z outside an open editor. */
  async function undoLastRun() {
    const entry = runUndo.pop();
    if (!entry) return false;
    workingSource = `${currentSource().slice(0, entry.start)}${entry.before}${currentSource().slice(entry.end)}`;
    await repaintFromWorkingSource();
    scheduleRunSave();
    return true;
  }

  /** Writes the working source after the page has been quiet for `RUN_SAVE_DELAY`. */
  function scheduleRunSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // Caught, not floated. `saveCurrentArtifact` rethrows anything that is not a 409, so a downed
      // daemon or a file that went read-only left an unhandled rejection and nothing else — no
      // dialog, no line on the page, and a writer who goes on typing into a document they believe
      // is on disk. Nobody is awaiting this call, so the catch is the only place it can be said.
      saveCurrentArtifact({ onlyIfDirty: true }).catch((error) => {
        setEditStatus(
          error instanceof Error ? `Couldn't save this passage: ${error.message}` : "Couldn't save this passage.",
          { error: true },
        );
      });
    }, RUN_SAVE_DELAY);
  }

  /** Writes now rather than on the timer — for leaving the tab, or closing the pane. */
  async function flushRunSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveCurrentArtifact({ onlyIfDirty: true });
  }

  /** A click in the manuscript opens the block it landed on.
   *
   * A click that produced a SELECTION is left alone: dragging across words means annotate, and it
   * is the one gesture that would otherwise be stolen by opening an editor under the reader's
   * hand. Modified clicks are left alone too, so a link stays a link.
   */
  function onManuscriptClick(event) {
    if (openRun || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target?.closest?.("a, button, input, textarea, summary")) return;
    // A selection that exists and spans characters means the reader dragged across words, which is
    // the annotate gesture. No selection object at all is a plain click, not a drag.
    const selection = window.getSelection?.();
    if (selection && selection.isCollapsed === false) return;
    if (!runEditingAvailable()) return;
    const block = blockAncestor(event.target);
    if (block) {
      void openRunEditor(block, { left: event.clientX, top: event.clientY });
      return;
    }
    // Not on a block: the page itself. Below the last one that means "keep writing", and on a
    // document with no blocks at all it is the only place there is to click. Above the first block
    // it means nothing — a click in the manuscript's top margin is not a request to write.
    if (event.target === contentEl && belowLastBlock(event.clientY)) void openAppendEditor();
  }

  /** Whether `clientY` falls under the last rendered block, in the page's own trailing space. */
  function belowLastBlock(clientY) {
    const blocks = contentEl.querySelectorAll(":scope > [data-line]");
    const last = blocks[blocks.length - 1];
    if (!last) return true; // nothing rendered: the whole page is the place to start
    return clientY > last.getBoundingClientRect().bottom;
  }

  /** The top-level rendered block containing `node`, or null. */
  function blockAncestor(node) {
    let current = node instanceof Element ? node : node?.parentElement;
    while (current && current.parentElement !== contentEl) current = current.parentElement;
    return current?.hasAttribute?.("data-line") ? current : null;
  }

  contentEl.addEventListener("click", onManuscriptClick);
  contentEl.addEventListener("focusout", (event) => {
    // Only when focus actually left the open run — moving between nodes inside the editor fires
    // focusout too, and closing on that would end the edit on the first keystroke that moves the
    // caret across a node boundary.
    if (!openRun) return;
    if (openRun.host.contains(event.relatedTarget)) return;
    void closeRunEditor();
  });
  contentEl.addEventListener("keydown", (event) => {
    if (!openRun) {
      if ((event.metaKey || event.ctrlKey) && event.key === "z" && runUndo.length) {
        event.preventDefault();
        void undoLastRun();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const block = openRun.block;
      void closeRunEditor().then(() => {
        // Focus goes back to the block, not to nowhere: a keyboard reader who pressed Escape has
        // to land somewhere, and the passage they were editing is the only honest place.
        const target = contentEl.querySelector(`[data-line="${block.getAttribute("data-line")}"]`);
        if (!(target instanceof HTMLElement)) return;
        const borrowed = !target.hasAttribute("tabindex");
        if (borrowed) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        if (borrowed) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
      });
    }
  });

  function renderContent() {
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(fitSourceArea);
    paneEl.setAttribute("data-mode", modeState.mode);
    const isClassF = currentArtifact?.class === "F";
    paneEl.setAttribute("data-class", currentArtifact?.class ?? "");
    renderArtifactTools();
    renderEncodingNotice();
    const isEdit = modeState.mode === "edit" && !isClassF;
    // EDIT IS THE PAGE NOW. Its default face is the manuscript itself, writable a block at a time —
    // so entering Edit changes what a click DOES, not what the reader is looking at. The full-page
    // editor is a tool reached from More, for the things CommonMark cannot hold, and `fullPage` is
    // the one flag that says it is showing. Everything else keyed on Edit — the held baseline, the
    // disk-change notice, parking, the save and its conflict — stays keyed on the MODE, because
    // those describe a writing session on this artifact and a block edit is one.
    const fullPage = isEdit && fullPageEditor;
    // Entering Edit is where a stale save becomes possible, so start fetching the merge now
    // rather than when the conflict dialog needs it.
    if (isEdit) void loadMergeModule();
    if (fullPage && !sourceFace && !richEditor && !loading) {
      // #182 R1: a late/first mount fills from the held baseline pair, never from
      // `currentArtifact.content` — an SSE refresh between Edit entry and this mount landing must
      // not hand the rich face bytes newer than the `baselineSha` a Keep-mine merge will verify
      // against.
      // Not while `loadArtifact` is still fetching: the baseline pair is not this file's yet, and
      // a mount begun now captures that stale or empty text. If the module then resolved while
      // `hydrateAnnotations` was still waiting, nothing handed the mount the arrived file, so the
      // face came up empty over a file with content. `loadArtifact` renders again once it is in.
      void mountRichFace(parkedSourceFor(currentArtifact) ?? baselineContent ?? "");
    }
    if (!fullPage) teardownRichFace();
    const richShown = fullPage && !sourceFace && Boolean(richEditor);
    richEl.hidden = !richShown;
    editArea.hidden = !fullPage || richShown;
    editWrap.hidden = !fullPage;
    saveButton.hidden = !isEdit;
    renderFaceToggle();
    skeletonEl.hidden = !loading;
    emptyEl.hidden = Boolean(currentArtifact) || loading;
    contentEl.hidden = fullPage || isClassF || !currentArtifact || loading;
    classFEl.hidden = !isClassF;
    renderTitle();
    renderApprovalStrip();

    if (!currentArtifact) {
      updateBlockTargets();
      renderMargin();
      refreshOutline();
      return;
    }
    if (isClassF) {
      updateBlockTargets();
      mountClassFArtifact();
      renderMargin();
      // Class F is an iframe glosa deliberately cannot read into, so there is no outline to draw
      // and the instrument says so by not being there.
      refreshOutline();
      return;
    }
    // Leaving class F (a different artifact was opened into this pane) tears down any
    // still-mounted iframe — it must not keep running invisibly behind `classFEl.hidden`.
    if (stopClassFViewer) {
      stopClassFViewer();
      stopClassFViewer = null;
      classFEl.removeAttribute("data-path");
    }
    if (fullPage) {
      // A parked draft outranks the file: re-entering Edit after the agent pulled the pane into
      // Review must find the sentence the reviewer was halfway through, not the saved version.
      const parked = parkedSourceFor(currentArtifact);
      // Unsaved typing outranks both. `loadArtifact` fills this face as soon as the artifact
      // arrives and then renders AGAIN once annotations hydrate, so re-reading the file here took
      // back every keystroke made in between — a window that is invisible when the daemon answers
      // fast and wide open when it does not.
      if (unsavedFacePath !== currentArtifact?.source_path) editArea.value = parked ?? currentArtifact.content ?? "";
    } else {
      // First paint sets innerHTML directly (nothing to morph FROM yet); every later re-render
      // goes through morphArtifactContent instead.
      if (contentEl.getAttribute("data-path") !== currentArtifact.source_path) {
        contentEl.innerHTML = currentArtifact.rendered_html ?? "";
        contentEl.setAttribute("data-path", currentArtifact.source_path);
      }
    }
    updateBlockTargets();
    renderMargin();
    refreshOutline();
  }

  /** Mounts (or re-mounts, on a path change) the class-F viewer — P4.1. A fresh capability is
   * minted on every mount, per A1 §7's "fresh mint per iframe open/reload": `force` re-mints even
   * for the SAME path, discarding the old iframe rather than trying to reuse it.
   *
   * §11: a LAYOUT move does not remount. dockview's `renderer: "always"` keeps a panel's content
   * in a render overlay under the dock root, and with floating groups and popouts disabled
   * nothing in the dock's move paths detaches it — so a tab switch, a tab move and a whole-group
   * merge all keep the same iframe, with no second `load` and no fresh mint. That matters beyond
   * speed: `classf-viewer.js` reads a second `load` on one element as the document navigating
   * itself and tears the frame down, so reparenting an interactive preview would look like an
   * attack. Pinned in test/acceptance/workbench-real-engine.test.ts (switch and move) and
   * packages/spa/test/dock.test.ts (whole-group merge). */
  function mountClassFArtifact(force = false) {
    if (!force && classFEl.getAttribute("data-path") === currentArtifact.source_path && stopClassFViewer) return;
    stopClassFViewer?.();
    classFEl.setAttribute("data-path", currentArtifact.source_path);
    classFEl.textContent = "";
    const interactive = modeState.mode !== "read" || classFInteractive;
    const frameHost = el("div", { className: "glosa-classf-frame" });
    const status = el("p", {
      className: "glosa-classf-status",
      role: "status",
      textContent: interactive ? "Interactive preview" : "Reading-only preview of external content",
    });
    const openInteractive = el("button", {
      className: "glosa-classf-interactive",
      type: "button",
      textContent: "Open interactive preview",
      hidden: interactive,
      onClick: () => {
        classFInteractive = true;
        mountClassFArtifact(true);
      },
    });
    classFEl.append(status, openInteractive, frameHost);
    stopClassFViewer = mountClassFViewer(frameHost, {
      dataAccess,
      slug,
      artifactPath: currentArtifact.source_path,
      interactive,
      onSelection: (target) => {
        if (modeState.mode !== "review") return;
        openComposer({ body: "", intent: "content", target });
      },
      onError: (message) => {
        status.setAttribute("data-error", "true");
        status.textContent = `This preview couldn't be opened. ${message}`;
        openInteractive.hidden = interactive;
      },
    });
  }

  // --- annotation composer: selection → composer → intent + comment → post. ONE component,
  // two placements: a card in the side rail when the pane is wide enough for one, and a popover
  // anchored under its own passage when it is not. Both put the draft beside the words it is
  // about; neither is a bar at the bottom of the window pretending to belong to a passage 3000px
  // above it. ---

  function openComposer(record, { returnFocus = null, replacing = null, draft = "" } = {}) {
    closePreview();
    composer = { record, returnFocus, replacing, draft, error: "", submitting: false };
    // The composer opens AT the passage, so the passage has to be on screen for it to have
    // anywhere to open. A selection the reader just dragged already is; a revision opened from a
    // rail card may not be, so centre it then, which also leaves room for the draft below it.
    const openBox = anchorBox(record?.target);
    const onScreen =
      openBox &&
      openBox.top >= paneMain.scrollTop &&
      openBox.bottom <= paneMain.scrollTop + paneMain.clientHeight - 120;
    if (!onScreen) {
      const box = openBox;
      if (box) {
        const centred = box.top - Math.max(0, (paneMain.clientHeight - (box.bottom - box.top)) / 2 - 40);
        paneMain.scrollTop = Math.max(0, centred);
      } else {
        const anchorNode = window.getSelection()?.anchorNode;
        const anchorEl = anchorNode && (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement);
        anchorEl?.scrollIntoView?.({ block: "center" });
      }
    }
    // Moving focus into the composer ends the browser's transient selection paint. Keep the
    // captured range visibly marked for the whole composition step, so the reviewer can still
    // see exactly what their feedback will attach to.
    paintComposerSelection();
    renderMargin();
    // Native focus normally scrolls the nearest scroll container until the newly inserted control
    // is visible; for a long artifact that would undo the anchor scroll above. Keep keyboard focus
    // moving into the composer, but leave the manuscript exactly where this put it.
    composerLayerEl.querySelector(".glosa-composer-input")?.focus({ preventScroll: true });
  }

  function closeComposer() {
    const returnFocus = composer?.returnFocus;
    composer = null;
    paintComposerSelection();
    renderMargin();
    queueMicrotask(() => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    });
  }

  async function submitComposer(input) {
    const body = input.value.trim();
    if (!body || !slug || !currentArtifact || composer?.submitting) return;
    composer.draft = input.value;
    composer.error = "";
    composer.submitting = true;
    const record = {
      ...composer.record,
      body,
      artifact_path: currentArtifact.source_path,
      ...(currentArtifact.rendered_sha256 ? { captured_rendered_sha256: currentArtifact.rendered_sha256 } : {}),
    };
    const replacing = composer.replacing;
    try {
      const result = await dataAccess.postAnnotation(slug, record);
      // Delivery is a separate axis from status (R3): the POST response only picks the honest
      // initial label — "Sent to session" vs "Waiting for a session". `id` is kept so the card's
      // Remove action can withdraw the entry later.
      annotations.push({
        record,
        id: result?.id ?? null,
        state: result?.status === "delivered" ? "delivered" : "waiting",
      });
      // A revision is complete only once the superseded entry is withdrawn. It runs AFTER the new
      // entry exists, so a failure here leaves two visible notes rather than none; the old card
      // stays with an honest label instead of quietly vanishing while still queued for delivery.
      if (replacing) await removeAnnotation(replacing, { failureLabel: "Still queued — remove it by hand" });
      const draftBox = composerLayerEl.querySelector(".glosa-composer")?.getBoundingClientRect() ?? null;
      closeComposer();
      settleIntoMargin(annotations.at(-1), draftBox);
      onStateChange();
    } catch (error) {
      composer.submitting = false;
      composer.error =
        error instanceof Error
          ? `Couldn't send this annotation: ${error.message}`
          : "Couldn't send this annotation. Try again.";
      renderMargin();
      queueMicrotask(() => composerLayerEl.querySelector(".glosa-composer-input")?.focus());
    }
  }

  function buildComposer() {
    const { record, replacing } = composer;
    const form = el("form", {
      className: "glosa-composer",
      "aria-label": replacing ? "Edit annotation" : "New annotation",
    });
    if (replacing) form.setAttribute("data-editing", "true");
    // Pencil, not ink: this entry is not sent yet, and its header says so beside its address.
    form.append(
      el("p", { className: "glosa-annotation-head" }, [
        el("span", { className: "glosa-address", textContent: addressForTarget(record.target) ?? "" }),
        el("span", { className: "glosa-annotation-who", textContent: "You · not sent yet" }),
      ]),
    );
    if (record.target?.quote?.exact) {
      // Inner span so the anchor wash hugs the quoted words instead of striping the whole card.
      form.append(
        el("p", { className: "glosa-composer-quote" }, [el("span", { textContent: record.target.quote.exact })]),
      );
    }
    const intents = el("div", { className: "glosa-composer-intents", role: "group", "aria-label": "Feedback intent" });
    for (const intent of INTENTS) {
      const btn = el("button", {
        type: "button",
        textContent: intent.label,
        onClick: () => {
          record.intent = intent.value;
          for (const b of intents.children) b.setAttribute("aria-pressed", String(b === btn));
        },
      });
      btn.setAttribute("aria-pressed", String(record.intent === intent.value));
      intents.append(btn);
    }
    const input = el("textarea", {
      className: "glosa-composer-input",
      placeholder: "What should change here?",
      "aria-label": "Annotation",
      name: "annotation",
    });
    input.value = composer.draft ?? "";
    input.addEventListener("input", () => {
      if (composer) composer.draft = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeComposer();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submitComposer(input);
      }
    });
    const cancel = el("button", {
      className: "glosa-btn glosa-btn-ghost",
      type: "button",
      textContent: "Cancel",
      onClick: closeComposer,
    });
    const send = el("button", {
      className: "glosa-composer-send",
      type: "button",
      textContent: replacing ? "Replace" : "Send to session",
      onClick: () => void submitComposer(input),
    });
    send.disabled = Boolean(composer.submitting);
    const status = el("p", {
      className: "glosa-composer-status",
      role: "status",
      "aria-live": "polite",
      textContent: composer.error || (composer.submitting ? "Sending annotation…" : ""),
    });
    if (composer.error) status.setAttribute("data-error", "true");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.append(intents, input, status, el("div", { className: "glosa-composer-actions" }, [cancel, send]));
    dictationController?.attachField(input, {
      controls: () => [cancel, send, ...intents.querySelectorAll("button")],
      getContext: () => ({
        surfaceBlocks: [record.target?.quote?.exact, contentEl.innerText],
      }),
    });
    // The journal never rewrites an entry, so say what "Replace" actually does — and say the
    // extra part out loud when the session has already been handed the note being replaced.
    if (replacing) {
      form.insertBefore(
        el("p", {
          className: "glosa-composer-note",
          textContent:
            replacing.state === "delivered" || replacing.state === "seen"
              ? "Replaces a note the session already has: it will be withdrawn and this one sent in its place."
              : "Replaces the note on this passage. The original is withdrawn.",
        }),
        intents,
      );
    }
    return form;
  }

  /** Live status: an SSE `journal` frame whose entry id matches a card updates it in place —
   * `transition_committed` moves the state, `delivery_attempt` counts re-nudges (a separate axis
   * that never changes status, R3). Returns true when this pane owned the entry. */
  function applyJournalEvent(event) {
    if (!event?.entry) return false;
    const item = annotations.find((i) => i.id === event.entry);
    if (!item) return false;
    if (event.event === "transition_committed" && typeof event.detail?.to === "string") {
      item.state = event.detail.to === "pending" ? "waiting" : event.detail.to;
    } else if (event.event === "apply_end" && typeof event.detail?.pre_sha === "string") {
      // The lease closing is the ONLY place the rollback target is stated. It is notified just
      // before the `transition_committed` that flips this card to `applied`, so by the time the
      // card re-renders and asks whether to offer Undo, the answer is already here.
      rollbackPoints.set(event.entry, event.detail.pre_sha);
    } else if (event.event === "delivery_attempt") {
      item.attempts = (item.attempts ?? 0) + 1;
    } else {
      return false;
    }
    renderMargin();
    onStateChange();
    return true;
  }

  /** Withdraws the entry (terminal `rejected` — the journal keeps it, delivery stops) and drops
   * the card. A 404/409 means the entry is already gone or closed daemon-side, so dropping the
   * card is still honest; any other failure keeps the card and says so. */
  async function removeAnnotation(item, { failureLabel = "Couldn't remove — try again" } = {}) {
    closePreview();
    try {
      if (item.id) await dataAccess.withdrawAnnotation(slug, item.id);
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 409) {
        item.state = "waiting";
        item.error = failureLabel;
        renderMargin();
        return;
      }
    }
    const idx = annotations.indexOf(item);
    if (idx !== -1) annotations.splice(idx, 1);
    renderMargin();
    onStateChange();
  }

  /** Turns a (start, end) UTF-16 offset pair into a live DOM Range inside the rendered content
   * (inverse of annotate.js's offset mapping). Null when the offsets don't fit. */
  function offsetsToRange(start, end) {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let total = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent.length;
      if (!startNode && start <= total + len) {
        startNode = node;
        startOffset = start - total;
      }
      if (end <= total + len) {
        endNode = node;
        endOffset = end - total;
        break;
      }
      total += len;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch {
      return null;
    }
    return range;
  }

  /** Resolves an annotation target against the CURRENT rendered text — the client-side echo of
   * the daemon's anchoring cascade (A5 §F10): (1) stored offsets, accepted only if the text there
   * still IS the quoted text, up to the fold; (2) re-find the quote by its prefix+exact+suffix
   * context; (3) exact quote alone when it's unambiguous; (4) the quote under the fixed
   * normalization, again only when it's unambiguous; else null — unanchored, and the card says
   * so. Rung (4) is why a re-wrapped paragraph keeps its notes: the daemon has always folded
   * before searching, so without it the page could call a note lost that the session still gets. */
  function rangeForTarget(target) {
    const pos = target?.position;
    const exact = target?.quote?.exact;
    if (pos && typeof pos.start === "number" && typeof pos.end === "number") {
      const range = offsetsToRange(pos.start, pos.end);
      // A re-wrap swaps a space for a newline in place, so the stored offsets still hold and only
      // the whitespace differs — the same words, and no search needed to say so.
      if (range && (!exact || range.toString() === exact || foldQuote(range.toString()) === foldQuote(exact))) {
        return range;
      }
    }
    if (!exact) return null;
    const text = contentEl.textContent;
    const prefix = target.quote.prefix ?? "";
    const suffix = target.quote.suffix ?? "";
    const contextIdx = prefix || suffix ? text.indexOf(prefix + exact + suffix) : -1;
    if (contextIdx !== -1) return offsetsToRange(contextIdx + prefix.length, contextIdx + prefix.length + exact.length);
    const first = text.indexOf(exact);
    if (first !== -1 && text.indexOf(exact, first + 1) === -1) return offsetsToRange(first, first + exact.length);
    const folded = locateFoldedQuote(text, exact);
    return folded ? offsetsToRange(folded.start, folded.end) : null;
  }

  /** True when the margin is the anchor-aligned side rail rather than the in-flow block under the
   * manuscript. Keyed on THIS PANE's inline size (§7), never the viewport: a pane changes width
   * when a sash moves and the window does not. */
  function isSideMargin() {
    return modeState.mode === "review" && paneWidth >= MARGIN_RAIL_FLOOR;
  }

  /** A terminal entry has left the state machine for good (A5's `applied`/`rejected`/`stale`/
   * `dismissed`), so there is nothing left to withdraw and nothing to revise. */
  const isTerminalState = (state) =>
    state === "applied" || state === "rejected" || state === "stale" || state === "dismissed";

  /** Restores the artifact to the state it was in before an agent applied this annotation. Same
   * machinery, guard and force-confirmation as the history pane's restore — an undo is a restore
   * to a particular checkpoint, not a second, weaker mechanism that could disagree with it. */
  async function undoApplied(item, { force = false } = {}) {
    const to = rollbackPoints.get(item.id);
    if (!to || !currentArtifact) return;
    if (!force) {
      const proceed = await confirmDialog({
        title: "Undo this change?",
        body: "Restores this artifact to how it read before the session applied this annotation. Anything written since is replaced.",
        confirmLabel: "Undo the change",
        danger: true,
      });
      if (!proceed) return;
    }
    try {
      await dataAccess.restore(slug, { path: currentArtifact.source_path, to, force });
      item.error = "";
      onStateChange();
    } catch (err) {
      if (err?.status === 409 && err.problem?.would_be_lost_diff) {
        // The dirty-worktree guard (A6 §F31). The reader is told what is at stake in their own
        // words before a second, explicit confirmation — never a silent overwrite.
        const proceed = await confirmDialog({
          title: "This artifact has unsaved changes",
          body: "It changed since its last saved version. Undoing now throws those changes away.",
          confirmLabel: "Undo anyway",
          danger: true,
        });
        if (proceed) await undoApplied(item, { force: true });
        return;
      }
      item.error = err instanceof Error ? `Couldn't undo: ${err.message}` : "Couldn't undo — try again";
      renderMargin();
    }
  }

  /** An anchor's box in the SAME scroll space `layoutMargin` and `renderMarkers` already use:
   * offsets inside `.glosa-pane-main`'s scrollable content, so a card placed at these coordinates
   * scrolls glued to the words it points at. */
  function anchorBox(target) {
    const range = rangeForTarget(target);
    const rects = range ? [...range.getClientRects()] : [];
    if (!rects.length) return null;
    const main = paneMain.getBoundingClientRect();
    return {
      top: Math.min(...rects.map((r) => r.top)) - main.top + paneMain.scrollTop,
      bottom: Math.max(...rects.map((r) => r.bottom)) - main.top + paneMain.scrollTop,
      // Where the selection starts on its first line, so a draft can open under its first word.
      left: rects[0].left - main.left,
    };
  }

  /** Places a floating surface directly under the passage it belongs to, flipping above when the
   * space below is too tight, and clamped into the pane's visible band so it can never open
   * off-screen. Positioned in scroll space, so it travels with the passage as the reader scrolls
   * — the popover IS at the text, which is the whole contract. */
  function placeAtAnchor(node, target, { gap = 10, alignToSelection = false } = {}) {
    const box = anchorBox(target);
    if (alignToSelection) {
      // Under the selection's first word, pulled back inside the manuscript column (or the pane,
      // when the pane is narrower than the column) so the draft never hangs off either edge.
      const width = node.offsetWidth;
      const column = contentEl.getBoundingClientRect();
      const main = paneMain.getBoundingClientRect();
      const minLeft = Math.max(16, column.left - main.left);
      const maxLeft = Math.min(paneMain.clientWidth - 16, column.right - main.left) - width;
      const wanted = box ? box.left - 16 : minLeft;
      node.style.left = `${Math.round(Math.max(minLeft, Math.min(wanted, Math.max(minLeft, maxLeft))))}px`;
    }
    const height = node.offsetHeight;
    const viewTop = paneMain.scrollTop;
    const viewBottom = viewTop + paneMain.clientHeight;
    // No live anchor (the passage was edited away): park it in the visible band rather than at a
    // stale offset, so an orphaned draft is still reachable instead of scrolled into nowhere.
    let top = box ? box.bottom + gap : viewTop + gap;
    if (box && top + height > viewBottom - gap && box.top - gap - height >= viewTop) top = box.top - gap - height;
    top = Math.max(viewTop + gap, Math.min(top, Math.max(viewTop + gap, viewBottom - height - gap)));
    node.style.top = `${Math.round(top)}px`;
  }

  // ---------- the compact collection tray ----------

  function setTrayOpen(open) {
    trayOpen = open;
    renderTray();
    // No focus move. This is a disclosure, not a dialog: the cards follow their toggle in DOM
    // order, so Tab reaches them anyway, and stealing focus on a click paints a focus ring on a
    // control the pointer user never asked for.
  }

  /** The tray states its count even when collapsed — the one honest thing a reader scrolling a
   * long manuscript needs from it — and only becomes a scrollable sheet when asked. */
  function renderTray() {
    const show = modeState.mode === "review" && Boolean(currentArtifact) && !isSideMargin();
    trayEl.hidden = !show;
    if (!show) {
      trayOpen = false;
      trayEl.removeAttribute("data-open");
      return;
    }
    // The tray holds everything the rail would have held, so it must COUNT everything the rail
    // holds. Counting annotations alone disabled the toggle whenever a session's question was the
    // only thing in the margin, which at compact widths made that question unreachable while a
    // turn sat blocked on the answer.
    const requests = agentRequests();
    const requestCount = requests.length;
    const notes = annotations.length;
    const count = requestCount + notes;
    const requestLabel = agentRequestSummary(requests);
    const notesLabel = notes === 1 ? "1 annotation" : `${notes} annotations`;
    trayCountEl.textContent =
      count === 0
        ? "No annotations yet"
        : requestCount === 0
          ? notesLabel
          : notes === 0
            ? requestLabel
            : `${requestLabel} · ${notesLabel}`;
    trayToggle.setAttribute("aria-expanded", String(trayOpen && count > 0));
    trayToggle.disabled = count === 0;
    trayEl.toggleAttribute("data-open", trayOpen && count > 0);
  }

  // ---------- the passage's own preview ----------

  function scheduleClosePreview() {
    if (previewCloseTimer) clearTimeout(previewCloseTimer);
    // Long enough to cross the gap between the passage and the card that describes it.
    previewCloseTimer = setTimeout(closePreview, 260);
  }

  function closePreview() {
    if (previewCloseTimer) clearTimeout(previewCloseTimer);
    previewCloseTimer = null;
    previewItem = null;
    previewEl.hidden = true;
    previewEl.textContent = "";
  }

  /** Hovering an annotated passage shows what was written there, without leaving the text. Only
   * in Annotate: the Preview Boundary Rule keeps anything that sends or changes feedback behind
   * an explicit mode transition, and the gutter dot is how a reader in Preview gets here. */
  function openAnnotationPreview(item) {
    if (modeState.mode !== "review" || composer) return;
    if (previewCloseTimer) clearTimeout(previewCloseTimer);
    previewCloseTimer = null;
    if (previewItem === item && !previewEl.hidden) return;
    previewItem = item;
    previewEl.textContent = "";
    previewEl.append(buildAnnotationCard(item));
    previewEl.hidden = false;
    placeAtAnchor(previewEl, item.record?.target, { gap: 8 });
  }

  previewEl.addEventListener("mouseenter", () => {
    if (previewCloseTimer) clearTimeout(previewCloseTimer);
    previewCloseTimer = null;
  });
  previewEl.addEventListener("mouseleave", scheduleClosePreview);

  /** Revise an annotation. The journal is append-only (invariant 2) and the API has no patch, so
   * this is honestly a withdraw-and-rewrite: the composer reopens on the same passage carrying
   * the old wording, and sending posts a NEW entry before withdrawing the old one. Posting first
   * means the worst failure is a visible duplicate the reader can remove, never a lost note. */
  function editAnnotation(item) {
    closePreview();
    openComposer(
      { ...item.record, target: item.record.target, intent: item.record.intent },
      { replacing: item, draft: item.record.body },
    );
  }

  /** The send moment: the entry that was just written glides from where its draft stood to its
   * place in the rail, so the reader sees where the note went instead of watching it vanish from
   * the passage. Rail widths only (the compact tray is collapsed), never under reduced motion,
   * and purely decorative: the card is already in place when the animation starts. */
  function settleIntoMargin(item, fromBox) {
    if (!item || !fromBox || !isSideMargin()) return;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof requestAnimationFrame === "undefined") return;
    const cardFor = () => [...marginEl.querySelectorAll(".glosa-annotation")].find((c) => c._glosaItem === item);
    const run = () => {
      const cardEl = cardFor();
      if (!cardEl || typeof cardEl.animate !== "function") return;
      // A copy travels, not the card: the send also triggers state and journal re-renders that
      // replace the rail's nodes, and an animation on a replaced node simply stops. The copy is
      // outside the pane's render tree, so nothing can pull it out from under the motion.
      const to = cardEl.getBoundingClientRect();
      const ghost = cardEl.cloneNode(true);
      ghost.classList.add("glosa-annotation-ghost");
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        position: "fixed",
        top: `${to.top}px`,
        left: `${to.left}px`,
        width: `${to.width}px`,
        right: "auto",
        margin: "0",
      });
      document.body.append(ghost);
      cardEl.style.opacity = "0";
      const done = () => {
        ghost.remove();
        const current = cardFor();
        if (current) current.style.opacity = "";
      };
      const motion = ghost.animate(
        [
          { transform: `translate(${fromBox.left - to.left}px, ${fromBox.top - to.top}px)`, opacity: 0.4 },
          { transform: "translate(0, 0)", opacity: 1 },
        ],
        { duration: 280, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
      motion.onfinish = done;
      motion.oncancel = done;
    };
    // renderMargin aligns the rail on the next frame; measure the card's resting place after it.
    requestAnimationFrame(() => requestAnimationFrame(run));
  }

  /** Aligns each margin card beside its anchor, and the open composer under its passage: anchor rect → offset in
   * the shared scroll space → absolute top, collision-stacked downward so cards never overlap.
   * No-op in compact, where CSS lays the margin out in flow. */
  function layoutMargin() {
    // FROZEN WHILE A RUN IS OPEN, deliberately. Cards are positioned by measuring each anchor's
    // rect in the pane's scroll space and stacking them out of each other's way; an editor changes
    // its block's height on every keystroke, so re-running this per keypress would cost a
    // `getBoundingClientRect` per card AND visibly jitter the whole rail while the writer types.
    // Reserving the run's height instead would move the manuscript, which "the margin is painted,
    // never reserved" forbids. So the cards hold their places and re-settle when the run closes —
    // `closeRunEditor` repaints, which calls back through here.
    if (openRun) return;
    const side = isSideMargin();
    marginEl.classList.toggle("glosa-margin-side", side);
    // Compact: the margin is not a block under the manuscript any more, it is the coordinate
    // space the open composer floats in beside its own passage.
    marginEl.classList.toggle("glosa-margin-anchored", !side && modeState.mode === "review");
    const positioned = [...marginEl.querySelectorAll(".glosa-annotation")];
    const form = composerLayerEl.querySelector(".glosa-composer");
    if (form && composer) placeAtAnchor(form, composer.record?.target, { alignToSelection: true });
    const floatingAsk = askLayerEl.querySelector(".glosa-agent-card");
    if (floatingAsk) {
      const asked = agentRequests().find((r) => r.id === floatingAsk.getAttribute("data-entry"));
      const range = asked ? rangeForPassage(asked.passage) : null;
      if (range) placeAskCard(floatingAsk, range);
    }
    if (!side) {
      for (const cardEl of positioned) cardEl.style.top = "";
      return;
    }
    const mainTop = paneMain.getBoundingClientRect().top;
    // Stack in PAGE order, not in the order the cards were written: a note added later about an
    // earlier passage must not be pushed below every card after it and out of reach of its words.
    // Cards whose passage is gone keep their relative order after the anchored ones.
    const measured = positioned.map((cardEl, index) => {
      const item = cardEl._glosaItem;
      const range = item ? rangeForTarget(item.record?.target ?? item.target) : null;
      const anchorTop = range ? range.getBoundingClientRect().top - mainTop + paneMain.scrollTop : null;
      return { cardEl, anchorTop, index };
    });
    measured.sort((a, b) => {
      if (a.anchorTop === null || b.anchorTop === null) {
        return a.anchorTop === b.anchorTop ? a.index - b.index : a.anchorTop === null ? 1 : -1;
      }
      return a.anchorTop - b.anchorTop || a.index - b.index;
    });
    let prevBottom = 0;
    for (const { cardEl, anchorTop } of measured) {
      const top = Math.max(anchorTop ?? prevBottom + 8, prevBottom + (prevBottom ? 8 : 0));
      cardEl.style.top = `${Math.round(top)}px`;
      prevBottom = top + cardEl.offsetHeight;
    }
  }

  /** Gutter dots: one per annotation at its anchor's height, whenever the cards are NOT already
   * beside their passages. Like the underlines, they are not an Annotate affordance — they are
   * how a reader in any mode can tell that a passage carries feedback, and reach it. */
  function renderMarkers() {
    markersEl.textContent = "";
    if (!currentArtifact || isSideMargin()) return;
    const mainTop = paneMain.getBoundingClientRect().top;
    // Anchors are per-SELECTION, not per-block: five words carry their own mark, and a paragraph
    // can hold as many as the reader cares to write. Several of them landing on one rendered line
    // therefore produce dots at the same height — stacked exactly, so seven notes read as one.
    // Measure every dot first, order them down the page, then push each clear of the one above:
    // the gutter shows a countable run instead of a single dot hiding a pile.
    const DOT_STEP = 12; // the 10px dot plus 2px of air
    const addresses = addressBlocks(contentEl);
    const placed = [];
    for (const item of annotations) {
      const range = rangeForTarget(item.record?.target);
      if (!range) continue;
      placed.push({ item, top: range.getBoundingClientRect().top - mainTop + paneMain.scrollTop });
    }
    placed.sort((a, b) => a.top - b.top);
    let prev = -Infinity;
    for (const entry of placed) {
      entry.top = prev + DOT_STEP > entry.top ? prev + DOT_STEP : entry.top;
      prev = entry.top;
    }
    for (const { item, top } of placed) {
      // Several dots in one gutter are only useful if they say which note each one is. Screen
      // readers get the note itself, not seven identical "Go to annotation" buttons.
      const gist = (item.record?.body ?? "").trim();
      const address = addressForTarget(item.record?.target, addresses);
      const dot = el("button", {
        className: "glosa-marker",
        type: "button",
        "aria-label": `${address ? `${address} · ` : ""}${
          gist ? `Go to annotation: ${gist.length > 60 ? `${gist.slice(0, 60)}…` : gist}` : "Go to annotation"
        }`,
        onClick: () => {
          // Outside Annotate there is no card to jump to yet, so the dot's job is to get the
          // reader to one: it opens the mode that has them, then reveals its own.
          if (modeState.mode !== "review") setMode("review");
          // The cards are in the rail at wide widths and in the collection tray at compact ones,
          // and the tray may be collapsed — open it before trying to scroll a card into view.
          if (!isSideMargin()) setTrayOpen(true);
          const reveal = () => {
            const cardEl = [
              ...marginEl.querySelectorAll(".glosa-annotation"),
              ...trayListEl.querySelectorAll(".glosa-annotation"),
            ].find((c) => c._glosaItem === item);
            const reducedMotion =
              typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
            cardEl?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
            cardEl?.classList.add("glosa-annotation-flash");
            setTimeout(() => cardEl?.classList.remove("glosa-annotation-flash"), 1200);
          };
          if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(reveal);
          else reveal();
        },
      });
      dot.style.top = `${Math.round(top)}px`;
      markersEl.append(dot);
    }
  }

  const paneHighlightToken = {}; // this pane's identity in the document-global highlight registry

  /** The open composer owns a temporary, persistent selection wash. It deliberately lives in a
   * separate highlight from saved annotation underlines, so closing/sending a draft cannot erase
   * the durable annotation state. */
  function paintComposerSelection() {
    const range = composer ? rangeForTarget(composer.record?.target) : null;
    contributeHighlight(HL_COMPOSER, paneHighlightToken, range ? [range] : []);
  }

  let anchoredRanges = []; // [{item, range}] cache from the last underline pass — hit-testing reuses it

  /** Every annotated passage carries a permanent quiet underline — the pencil line that says
   * "someone wrote in this margin" — in EVERY mode, not only Annotate.
   *
   * It used to be an Annotate affordance, which meant leaving Annotate erased every trace that a
   * passage had ever been marked: a heavily reviewed chapter read as untouched in Preview. Cards
   * need width and can honestly fall back to a tray or disappear; a 2px underline and a gutter dot
   * need none, so they stay. That is also what makes a narrow companion pane worth having beside
   * a wide one — it can still show you where the marks are. */
  function paintAnchorUnderlines() {
    anchoredRanges = [];
    if (currentArtifact) {
      for (const item of annotations) {
        const range = rangeForTarget(item.record?.target);
        if (range) anchoredRanges.push({ item, range });
      }
    }
    contributeHighlight(
      HL_ANCHORS,
      paneHighlightToken,
      anchoredRanges.map((a) => a.range),
    );
  }

  // ---------- the agent's half of the margin ----------

  /** The session requests that belong beside the open artifact. Derived on every read rather than
   * cached: the inbox is refreshed by the same journal events that repaint everything else, and a
   * second copy of this list is a second thing that can be stale. */
  function providerDisplayName() {
    const name = getProviderName();
    return typeof name === "string" && name.trim().length > 0 ? name : "An agent session";
  }

  function agentRequests() {
    return requestsForArtifact(getAttentionEntries(), currentArtifact?.source_path ?? null);
  }

  /** A DOM range for a session's quote, or null when the passage cannot be proven unique. The
   * quote is resolved against the rendered text because that is what the reader is looking at;
   * `locateQuote` owns the source→rendered ladder and the refusal to guess. */
  function rangeForPassage(passage) {
    if (!passage?.quote || !currentArtifact) return null;
    const found = locateQuote(contentEl.textContent, passage.quote);
    return found ? offsetsToRange(found.start, found.end) : null;
  }

  function rangesOverlap(a, b) {
    try {
      return a.compareBoundaryPoints(Range.START_TO_END, b) > 0 && a.compareBoundaryPoints(Range.END_TO_START, b) < 0;
    } catch {
      return false;
    }
  }

  /** Is this passage where the reader can see it? Measured against the pane's own scroll viewport,
   * never the window: with two artifacts open, "on screen" means on THIS pane's screen. */
  function passageVisible(range) {
    if (!range) return false;
    const rect = range.getBoundingClientRect();
    const main = paneMain.getBoundingClientRect();
    return rect.bottom > main.top + PASSAGE_VISIBLE_INSET && rect.top < main.bottom - PASSAGE_VISIBLE_INSET;
  }

  /**
   * Draws one band per located request: an outline around the exact words, shaped the way a text
   * selection is shaped, with a tab in the gutter. A question is filled and labelled; a pointer is
   * the outline alone. `bandPath` owns the geometry; this owns measuring and the DOM.
   *
   * Nothing is drawn for a passage that cannot be proven unique — `rangeForPassage` returns null
   * and the card says so. A band around a guess would be a confident lie in session ink.
   */
  function paintAgentBands() {
    bandsEl.textContent = "";
    for (const block of contentEl.querySelectorAll("[data-session-mark]")) block.removeAttribute("data-session-mark");
    if (!currentArtifact || modeState.mode === "edit") {
      renderNotice();
      return;
    }
    const main = paneMain.getBoundingClientRect();
    const dx = paneMain.scrollLeft - main.left;
    const dy = paneMain.scrollTop - main.top;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "glosa-band-svg");
    svg.setAttribute("aria-hidden", "true");
    bandsEl.append(svg);
    const provider = providerDisplayName();
    const filledRanges = [];
    // Oldest first (`requestsForArtifact` sorts), which is what lets an older question keep its
    // fill when a newer one lands on the same words.
    for (const request of agentRequests()) {
      const range = rangeForPassage(request.passage);
      if (!range) continue;
      const question = isQuestion(request);
      let lines = lineBoxes([...(range.getClientRects?.() ?? [])]);
      if (lines.length === 0) {
        // No per-line rects (a collapsed layout, or an engine that reports none): fall back to the
        // union box, which is still the passage, only without its steps.
        const box = range.getBoundingClientRect();
        lines = [{ left: box.left, right: box.right, top: box.top, bottom: Math.max(box.bottom, box.top + 12) }];
      }
      lines = lines.map((l) => ({ left: l.left + dx, right: l.right + dx, top: l.top + dy, bottom: l.bottom + dy }));
      const startNode = range.startContainer;
      const startEl = startNode.nodeType === 1 ? startNode : startNode.parentElement;
      const block = startEl?.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, pre") ?? contentEl;
      const blockRect = block.getBoundingClientRect();
      const column = { left: blockRect.left + dx, right: blockRect.right + dx };
      // 3px, not more: a band that starts mid-line opens in the word space after the previous
      // sentence, and a wider pad puts its edge through that sentence's full stop.
      const d = bandPath(lines, column, { padX: 3 });
      if (!d) continue;
      const overlapped = question && filledRanges.some((other) => rangesOverlap(range, other));
      if (question && !overlapped) filledRanges.push(range);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "glosa-band");
      path.setAttribute("d", d);
      path.setAttribute("data-entry", request.id);
      path.setAttribute("data-kind", question ? "question" : "pointer");
      if (overlapped) path.setAttribute("data-overlapped", "true");
      if (focusedRequestId === request.id) path.setAttribute("data-focused", "true");
      if (arrivedRequestIds.has(request.id)) path.setAttribute("data-arrived", "true");
      svg.append(path);

      // The gutter shows a hovered block's address where the tab now sits; the tab says the same
      // thing in its accessible name, so the label gives way. An attribute, never a node.
      if (block !== contentEl) block.setAttribute("data-session-mark", "true");
      const address = addressForRange(contentEl, range) ?? "";
      const first = lines[0];
      const tab = el("button", {
        className: "glosa-band-tab",
        type: "button",
        "data-entry": request.id,
        "data-kind": question ? "question" : "pointer",
        "aria-label": `${address ? `${address} · ` : ""}${question ? "Question" : "Pointer"} from ${provider}. Go to its card.`,
        onClick: () => goToRequest(request),
      });
      if (arrivedRequestIds.has(request.id)) tab.setAttribute("data-arrived", "true");
      tab.append(question ? el("span", { textContent: "?", "aria-hidden": "true" }) : pointerGlyph());
      tab.style.left = `${Math.max(0, Math.round(column.left - BAND_TAB_OFFSET))}px`;
      tab.style.top = `${Math.round(first.top + 3)}px`;
      bandsEl.append(tab);

      if (question) {
        // Printed on the band's top edge, so the mark names its author before the card is read.
        const label = el("span", {
          className: "glosa-band-label",
          "aria-hidden": "true",
          textContent: `${provider} asks`,
        });
        const multi = lines.length > 1;
        label.style.top = `${Math.round(first.top - 1)}px`;
        label.style.left = `${Math.round(multi ? Math.max(column.right, ...lines.map((l) => l.right)) : first.left)}px`;
        if (multi) label.setAttribute("data-align", "end");
        bandsEl.append(label);
      }
    }
    renderNotice();
  }

  /** The pointer's tab glyph, drawn rather than typed: an arrow character takes its weight and
   * baseline from whatever face the platform substitutes, a path does not. */
  function pointerGlyph() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M2 6h7.5M6.5 2.5 10 6l-3.5 3.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  /** Marks that arrived since the last look draw themselves in once, then are ordinary marks. */
  function markArrived(ids) {
    for (const id of ids ?? []) arrivedRequestIds.add(id);
    if (arrivedRequestIds.size === 0) return;
    setTimeout(() => {
      for (const id of ids ?? []) arrivedRequestIds.delete(id);
      for (const node of bandsEl.querySelectorAll("[data-arrived]")) node.removeAttribute("data-arrived");
    }, BAND_ARRIVE_MS);
  }

  function prefersReducedMotion() {
    return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }

  function scrollPaneTo(top) {
    const target = Math.max(0, Math.round(top));
    if (typeof paneMain.scrollTo === "function") {
      paneMain.scrollTo({ top: target, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } else {
      paneMain.scrollTop = target;
    }
  }

  /** The card for a request, wherever it currently lives: floating at its passage, in the rail, or
   * in the tray. */
  function cardForRequest(id) {
    const match = (root) =>
      [...root.querySelectorAll(".glosa-agent-card")].find((c) => c.getAttribute("data-entry") === id);
    return match(askLayerEl) ?? match(marginEl) ?? match(trayListEl) ?? null;
  }

  /**
   * Takes the reader to a session's request — because they asked to be taken.
   *
   * This is the only path that moves the page for a request, and every caller is a control the
   * reader pressed: the notice's "Go to it", a band's tab, a tray row, a card's quote. Nothing
   * calls it on arrival (#308). It remembers where they were first, so the way back exists before
   * the move happens, and it parks unsaved work by way of `setMode`, which always parks.
   */
  function goToRequest(request, { focusCard = true } = {}) {
    if (!returnPlace) {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      returnPlace = { top: paneMain.scrollTop, focus: active && paneEl.contains(active) ? active : null };
    }
    if (modeState.mode !== "review") {
      setMode("review");
      // Leaving Edit restores the scroll position it was entered from, over the next two frames.
      // The reader just asked to go somewhere else; that restore must not drag them back.
      pendingScrollTop = null;
    }
    focusedRequestId = request.id;
    dismissedNotices.delete(request.id);
    renderMargin();
    const arrive = () => {
      const range = rangeForPassage(request.passage);
      if (range) {
        const rect = range.getBoundingClientRect();
        const top = rect.top - paneMain.getBoundingClientRect().top + paneMain.scrollTop;
        // With a rail the passage lands in the reading band, a third of the way down. Without one
        // its card opens underneath it, so it lands higher and leaves the card the room.
        scrollPaneTo(top - paneMain.clientHeight / (isSideMargin() ? 3 : 8));
      } else if (!isSideMargin()) {
        // No passage to go to, so the question itself is the destination, and at this width it
        // lives in the tray.
        setTrayOpen(true);
      }
      paintAgentBands();
      if (!focusCard) return;
      const card = cardForRequest(request.id);
      if (!range) card?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      // The reader pressed a control to get here, so focus follows them to the thing they came
      // for. `preventScroll`: the scroll above is the one they should see, not a second jump.
      (card?.querySelector(".glosa-agent-options input, .glosa-agent-input") ?? card)?.focus?.({ preventScroll: true });
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(arrive);
    else arrive();
  }

  /** Steps off the question the reader was on without answering it: the floating card closes, the
   * band and the tray row stay, and focus goes back to the band's tab so the keyboard is not
   * stranded on a node that no longer exists. */
  function leaveRequest() {
    const id = focusedRequestId;
    if (!id) return;
    focusedRequestId = null;
    renderMargin();
    const back = () => {
      paintAgentBands();
      [...bandsEl.querySelectorAll(".glosa-band-tab")].find((t) => t.getAttribute("data-entry") === id)?.focus?.();
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(back);
    else back();
  }

  function goBack() {
    const place = returnPlace;
    returnPlace = null;
    answerJustSent = false;
    if (place) {
      scrollPaneTo(place.top);
      if (place.focus?.isConnected) place.focus.focus?.({ preventScroll: true });
    }
    renderNotice();
  }

  /**
   * Which question, if any, the notice should offer.
   *
   * A question earns the notice when the reader cannot currently see it beside its words: the
   * passage is off screen, or the pane is not in Review (so no card is shown), or the pane has no
   * rail and the question's card is not the one floating. It is derived from what is open and
   * where the reader is — not from "what just arrived" — which is why questions already waiting on
   * the first load get one too. That was the case that silently got nothing before.
   *
   * Questions about artifacts no pane has open are offered by the ACTIVE pane only; otherwise every
   * pane in a split would raise the same notice.
   */
  function noticeCandidate() {
    const all = openQuestions(getAttentionEntries());
    const mine = currentArtifact?.source_path ?? null;
    const active = paneEl.getAttribute("data-active") !== "false";
    for (const request of all) {
      if (dismissedNotices.has(request.id)) continue;
      const target = request.target_path ?? request.target;
      if (target === mine) {
        const range = rangeForPassage(request.passage);
        const beside =
          modeState.mode === "review" &&
          (range ? passageVisible(range) : focusedRequestId === request.id) &&
          (isSideMargin() || focusedRequestId === request.id || !range);
        if (beside && range) continue;
        if (beside && !range && focusedRequestId === request.id) continue;
        return { request, range, foreign: false, index: all.indexOf(request) + 1, total: all.length };
      }
      if (active && typeof target === "string" && !isArtifactOpen(target)) {
        return { request, range: null, foreign: true, index: all.indexOf(request) + 1, total: all.length };
      }
    }
    return null;
  }

  function renderNotice() {
    const candidate = currentArtifact ? noticeCandidate() : null;
    const showBack = Boolean(returnPlace);
    const lost = candidate && !candidate.foreign && candidate.request.passage && !candidate.range;
    const key = candidate
      ? `q:${candidate.request.id}:${candidate.index}/${candidate.total}:${lost ? "lost" : "ok"}:${showBack}`
      : showBack
        ? `back:${answerJustSent}`
        : "";
    if (key === noticeKey) return;
    noticeKey = key;
    noticeEl.textContent = "";
    noticeEl.hidden = key === "";
    if (key === "") return;

    const back = showBack
      ? el("button", {
          className: "glosa-secondary-button glosa-ask-notice-back",
          type: "button",
          textContent: "Back to where you were",
          onClick: goBack,
        })
      : null;

    if (!candidate) {
      noticeEl.removeAttribute("data-kind");
      noticeEl.append(
        el("p", {
          className: "glosa-ask-notice-text",
          textContent: answerJustSent ? "Answer sent." : "You are at the passage a session asked about.",
        }),
        el("span", { className: "glosa-ask-notice-gap" }),
        back,
        dismissButton(() => {
          returnPlace = null;
          answerJustSent = false;
          renderNotice();
        }),
      );
      return;
    }

    const { request, range, foreign } = candidate;
    noticeEl.setAttribute("data-kind", "question");
    const file = String(request.target_path ?? request.target ?? "")
      .split("/")
      .pop();
    const text = el("p", { className: "glosa-ask-notice-text" }, [
      el("span", { className: "glosa-ask-notice-provider", textContent: providerDisplayName() }),
      // Says what is true and no more. A passage that cannot be located is not "a passage" the
      // reader can be taken to, and the notice must not promise one.
      document.createTextNode(
        lost
          ? " is asking about a passage that could not be located in the current text"
          : foreign
            ? ` is asking about a passage in ${file}`
            : " is asking about a passage",
      ),
    ]);
    const address = range ? (addressForRange(contentEl, range) ?? "") : "";
    noticeEl.append(
      el("span", { className: "glosa-ask-notice-glyph", "aria-hidden": "true", textContent: "?" }),
      text,
      ...(address ? [el("span", { className: "glosa-address glosa-ask-notice-address", textContent: address })] : []),
      el("span", { className: "glosa-ask-notice-gap" }),
      ...(candidate.total > 1
        ? [el("span", { className: "glosa-ask-notice-count", textContent: `${candidate.index} of ${candidate.total}` })]
        : []),
      ...(back ? [back] : []),
      el("button", {
        className: "glosa-primary-button glosa-ask-notice-go",
        type: "button",
        textContent: lost ? "Show the question" : "Go to it",
        onClick: () => {
          if (foreign) void goToRequestElsewhere(request);
          else goToRequest(request);
        },
      }),
      dismissButton(() => {
        dismissedNotices.add(request.id);
        renderNotice();
      }),
    );
  }

  function dismissButton(onClick) {
    const button = el("button", {
      className: "glosa-ask-notice-dismiss",
      type: "button",
      "aria-label": "Dismiss this notice",
      onClick,
    });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M2.5 2.5l7 7M9.5 2.5l-7 7");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    button.append(svg);
    return button;
  }

  /** Places the floating question card at its passage: under it, aligned to its first word and
   * held inside the manuscript column, above it when there is no room below. Unlike the composer
   * it is NOT clamped into the visible band — a draft follows its writer, but a question belongs
   * to its words, and the notice is what reaches a reader who has scrolled away. */
  function placeAskCard(node, range, { gap = 12 } = {}) {
    const main = paneMain.getBoundingClientRect();
    const column = contentEl.getBoundingClientRect();
    const rects = lineBoxes([...(range.getClientRects?.() ?? [])]);
    const first = rects[0] ?? range.getBoundingClientRect();
    const box = range.getBoundingClientRect();
    const width = node.offsetWidth;
    const minLeft = Math.max(16, column.left - main.left);
    const maxLeft = Math.min(paneMain.clientWidth - 16, column.right - main.left) - width;
    // Under a one-line passage, align to its first word, as a draft does. A passage that wraps runs
    // on from the column's left edge, so that edge is where the eye returns to and the card starts.
    const wanted = rects.length > 1 ? minLeft : first.left - main.left - 16;
    node.style.left = `${Math.round(Math.max(minLeft, Math.min(wanted, Math.max(minLeft, maxLeft))))}px`;
    const below = box.bottom - main.top + paneMain.scrollTop + gap;
    const above = box.top - main.top + paneMain.scrollTop - gap - node.offsetHeight;
    // The tray lies over the pane's foot at this width; room under it is not room.
    const viewBottom = paneMain.scrollTop + paneMain.clientHeight - (trayEl.hidden ? 0 : trayEl.offsetHeight);
    const fitsBelow = below + node.offsetHeight <= viewBottom - gap;
    node.style.top = `${Math.round(!fitsBelow && above >= paneMain.scrollTop + gap ? above : below)}px`;
  }

  async function submitAnswer(request, card, { outcome, response, chose }) {
    const controls = [...card.querySelectorAll("button, textarea, input")];
    for (const control of controls) control.disabled = true;
    const status = card.querySelector(".glosa-agent-status");
    status.hidden = false;
    status.textContent = "Sending your answer…";
    try {
      await dataAccess.respondToAttention(slug, request.id, { outcome, response, chose });
      answerDrafts.delete(request.id);
      if (focusedRequestId === request.id) focusedRequestId = null;
      answerJustSent = true;
      // The entry is terminal now, so the next inbox refresh drops the card. Ask for that refresh
      // rather than removing the card here: the journal decides what is open, not this view.
      await refreshAttention();
      renderNotice();
      // The card the reader was typing in is gone. Focus goes to the notice when it has something
      // to offer (the next question, or the way back) rather than falling to the document body.
      if (!noticeEl.hidden) noticeEl.querySelector(".glosa-ask-notice-go, .glosa-ask-notice-back")?.focus?.();
    } catch (error) {
      for (const control of controls) control.disabled = false;
      status.textContent = error instanceof Error ? error.message : "The answer could not be sent.";
      status.setAttribute("role", "alert");
      card.querySelector(".glosa-agent-input")?.focus();
    }
  }

  /** A located question as the tray lists it: who, which words, what is asked, and one button that
   * does what the notice's "Go to it" does. The answer form lives at the passage. */
  function buildAgentRow(request) {
    const identity = agentIdentity(request, { providerName: providerDisplayName() });
    const row = el("div", {
      className: "glosa-agent-card glosa-agent-row",
      "data-entry": request.id,
      "data-anchored": "true",
    });
    row.append(
      el("p", { className: "glosa-agent-who" }, [
        el("span", { className: "glosa-agent-provider", textContent: identity.provider }),
        ...(identity.claimed
          ? [
              el("span", {
                className: "glosa-agent-claimed",
                textContent: identity.claimed,
                title: "Name this session gave itself",
              }),
            ]
          : []),
      ]),
      el("p", { className: "glosa-agent-quote" }, [el("span", { textContent: request.passage.quote.exact })]),
      el("p", { className: "glosa-agent-message", textContent: request.message }),
      el("div", { className: "glosa-agent-actions" }, [
        el("button", {
          className: "glosa-secondary-button",
          type: "button",
          textContent: "Answer at the passage",
          onClick: () => {
            setTrayOpen(false);
            goToRequest(request);
          },
        }),
      ]),
    );
    return row;
  }

  /**
   * One card for one session request.
   *
   * The identity line keeps the provider and the session's own label visually distinct because
   * they carry different weight — the first is derived from a binding glosa verified, the second
   * is a string the session sent about itself (invariant 3). A card that ran them together would
   * be presenting a claim as a fact.
   */
  function buildAgentCard(request, { floating = false } = {}) {
    const identity = agentIdentity(request, { providerName: providerDisplayName() });
    const anchored = Boolean(request.passage) && Boolean(rangeForPassage(request.passage));
    const card = el("div", {
      className: "glosa-agent-card",
      "data-entry": request.id,
      "data-anchored": String(anchored),
      ...(floating ? { "data-floating": "true", role: "group", "aria-label": "Question at its passage" } : {}),
    });
    // The thread between a card and its band, both ways: the card deepens its band on hover and
    // focus, the way a note lights its passage.
    const thread = (on) => () => {
      for (const node of bandsEl.querySelectorAll(".glosa-band")) {
        if (node.getAttribute("data-entry") === request.id) node.toggleAttribute("data-hover", on);
      }
    };
    card.addEventListener("mouseenter", thread(true));
    card.addEventListener("mouseleave", thread(false));
    card.addEventListener("focusin", thread(true));
    card.addEventListener("focusout", thread(false));
    if (floating) {
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        leaveRequest();
      });
    }

    const who = el("p", { className: "glosa-agent-who" }, [
      el("span", { className: "glosa-agent-provider", textContent: identity.provider }),
      ...(identity.claimed
        ? [
            el("span", {
              className: "glosa-agent-claimed",
              textContent: identity.claimed,
              title: "Name this session gave itself",
            }),
          ]
        : []),
    ]);
    if (floating) {
      // The one card over the manuscript needs a way out that is not "answer it".
      const close = dismissButton(leaveRequest);
      close.className = "glosa-ask-notice-dismiss glosa-agent-close";
      close.setAttribute("aria-label", "Close this question; it stays open in the list");
      who.append(el("span", { className: "glosa-ask-notice-gap" }), close);
    }
    card.append(who);

    // Floating, the card sits directly under the banded words: quoting them again would push the
    // question further from the passage it is about.
    if (request.passage?.quote?.exact && !floating) {
      const quote = el("p", { className: "glosa-agent-quote" }, [
        el("span", { textContent: request.passage.quote.exact }),
      ]);
      if (anchored) {
        quote.tabIndex = 0;
        quote.setAttribute("role", "button");
        quote.setAttribute("aria-label", "Go to this passage");
        quote.addEventListener("click", () => goToRequest(request));
        quote.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            goToRequest(request);
          }
        });
      }
      card.append(quote);
      if (!anchored) {
        // Same honesty the annotation card keeps: the quote stays, the claim to a location does
        // not. A session may have quoted text the artifact no longer contains, or text that
        // occurs twice — either way this card must not underline a guess.
        card.append(
          el("p", {
            className: "glosa-agent-lost",
            textContent: "This passage could not be located in the current text.",
          }),
        );
      }
    }

    if (request.message) card.append(el("p", { className: "glosa-agent-message", textContent: request.message }));

    // A pointer with no question is complete as it stands — it says "look here", and the only
    // thing left to do is acknowledge it. A question gets an answer surface.
    const options = Array.isArray(request.answer_options) ? request.answer_options : [];
    const group = el("div", { className: "glosa-agent-answer" });
    const draft = answerDrafts.get(request.id) ?? { text: "", chose: null };
    answerDrafts.set(request.id, draft);
    if (options.length > 0) {
      const name = `glosa-agent-choice-${request.id}${floating ? "-at-passage" : ""}`;
      const list = el("div", { className: "glosa-agent-options", role: "radiogroup", "aria-label": "Answer" });
      for (const option of options) {
        const id = `${name}-${list.childElementCount}`;
        const input = el("input", { type: "radio", name, id, value: option });
        input.checked = draft.chose === option;
        input.addEventListener("change", () => {
          draft.chose = option;
        });
        list.append(
          el("label", { className: "glosa-agent-option", htmlFor: id }, [input, el("span", { textContent: option })]),
        );
      }
      group.append(list);
    }
    const input = el("textarea", {
      className: "glosa-agent-input",
      rows: 3,
      maxLength: 4096,
      // The escape hatch is unconditional. A session supplies its own words; it never gets to
      // close the reviewer's. That guarantee is glosa's, not the session's, so this field is
      // present whether or not options were offered.
      placeholder: options.length > 0 ? "Or answer in your own words…" : "Your answer…",
      "aria-label": "Your answer",
    });
    input.value = draft.text;
    input.addEventListener("input", () => {
      draft.text = input.value;
    });
    group.append(input);

    const status = el("p", { className: "glosa-agent-status", hidden: true, role: "status", "aria-live": "polite" });
    const send = el("button", {
      className: "glosa-primary-button",
      type: "button",
      textContent: "Send answer",
      onClick: () =>
        void submitAnswer(request, card, {
          outcome: request.action === "review" ? "changes_requested" : "done",
          response: input.value,
          ...(draft.chose ? { chose: draft.chose } : {}),
        }),
    });
    const decline = el("button", {
      className: "glosa-secondary-button",
      type: "button",
      // Names what it does to the waiting session, not how the reviewer feels about it: the turn
      // resumes with no answer rather than staying blocked.
      textContent: "Can't answer",
      onClick: () =>
        void submitAnswer(request, card, {
          outcome: request.action === "review" ? "changes_requested" : "done",
          response: "",
        }),
    });
    card.append(group, el("div", { className: "glosa-agent-actions" }, [decline, send]), status);
    dictationController?.attachField(input, {
      controls: () => [decline, send, ...group.querySelectorAll("input")],
      getContext: () => ({
        surfaceBlocks: [request.message, request.target?.quote?.exact, contentEl.innerText],
      }),
    });
    return card;
  }

  /** The reverse thread: hovering an underlined passage in the text highlights its card (and
   * deepens its own wash). Hit-tests the pointer against the cached anchor rects, rAF-throttled. */
  let hoverRafPending = false;
  let hoveredItem = null;

  function setHoveredItem(item) {
    if (item === hoveredItem) return;
    hoveredItem = item;
    for (const cardEl of marginEl.querySelectorAll(".glosa-annotation")) {
      cardEl.classList.toggle("glosa-annotation-hover", Boolean(item) && cardEl._glosaItem === item);
    }
    const hit = item ? anchoredRanges.find((a) => a.item === item) : null;
    contributeHighlight(HL_ANCHOR, paneHighlightToken, hit ? [hit.range] : []);
    // The pointer thread's other half: the passage itself offers what the rail would have shown
    // beside it — the note, its delivery state, and the two things you can still do to it.
    if (item) openAnnotationPreview(item);
    else scheduleClosePreview();
  }

  contentEl.addEventListener("mousemove", (e) => {
    if (anchoredRanges.length === 0 || hoverRafPending) return;
    hoverRafPending = true;
    const { clientX, clientY } = e;
    const hitTest = () => {
      hoverRafPending = false;
      for (const { item, range } of anchoredRanges) {
        for (const rect of range.getClientRects()) {
          if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
            setHoveredItem(item);
            return;
          }
        }
      }
      setHoveredItem(null);
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(hitTest);
    else hitTest();
  });

  contentEl.addEventListener("mouseleave", () => setHoveredItem(null));

  // Escape dismisses the passage preview wherever focus happens to be; the composer's own input
  // handles its own Escape, and a preview is never open at the same time as one.
  paneEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewItem) closePreview();
  });

  /** Hover/focus on a card washes its own anchor fully — the thread from margin back to text. */
  function connectAnchorHighlight(cardEl, item) {
    const on = () => {
      const range = rangeForTarget(item.record?.target ?? item.target);
      contributeHighlight(HL_ANCHOR, paneHighlightToken, range ? [range] : []);
    };
    const off = () => contributeHighlight(HL_ANCHOR, paneHighlightToken, []);
    cardEl.addEventListener("mouseenter", on);
    cardEl.addEventListener("mouseleave", off);
    cardEl.addEventListener("focusin", on);
    cardEl.addEventListener("focusout", off);
  }

  /** The passage's address (address.js): "§2.3", derived from the rendered structure on every
   * call, so it is always the label the reader currently sees in the outline. Null when the
   * passage is not on the page (lost, or a class-F artifact). */
  function addressForTarget(target, map) {
    const range = rangeForTarget(target);
    return range ? addressForRange(contentEl, range, map) : null;
  }

  /** Everything on a card that is derived from the CURRENT text: whether the passage is still
   * there, and what it is called. Honest anchoring — if the quoted passage no longer exists (edited
   * away, rewritten), the card says "Lost its place" and keeps the original quote; it never
   * underlines different words (client echo of A5 §F10; the daemon's resolver is the authority at
   * delivery time).
   *
   * In place, on a card that may already be on the page, rather than by rebuilding it. The verdict
   * has to follow the manuscript — a session's write moves the text under a card that nothing else
   * is going to rebuild — and rebuilding the rail on every external frame would take the reader's
   * focus, their hover and any open draft with it. */
  function applyAnchorVerdict(card, addresses) {
    const item = card._glosaItem;
    const target = item?.record?.target ?? item?.target ?? null;
    const range = target ? rangeForTarget(target) : null;
    card.setAttribute("data-anchored", String(Boolean(range)));
    const addressEl = card.querySelector(".glosa-address");
    if (addressEl) addressEl.textContent = (range ? addressForRange(contentEl, range, addresses) : null) ?? "";
    const lost = card.querySelector(".glosa-annotation-lost");
    if (range) {
      lost?.remove();
      return;
    }
    if (lost) return;
    // Between the quote and the body, which is where it was built: the reader reads the words that
    // were marked, then that they are gone, then what was said about them.
    card.insertBefore(
      el("p", {
        className: "glosa-annotation-lost",
        textContent: "Lost its place — the passage changed since this was written.",
      }),
      card.querySelector(".glosa-annotation-body"),
    );
  }

  /** Re-derives every card's verdict against the text as it stands now. Called from the same paint
   * as the underlines and the dots, because those three answer one question and a reader who sees
   * them disagree cannot tell which one is lying. */
  function repaintAnchorVerdicts() {
    const addresses = addressBlocks(contentEl);
    for (const card of paneEl.querySelectorAll(".glosa-annotation")) applyAnchorVerdict(card, addresses);
  }

  /** One margin entry. The same component in the side rail, in the compact collection tray,
   * and inside the passage's hover preview — only its container changes. */
  function buildAnnotationCard(item, { actions = true, addresses } = {}) {
    const { record, state } = item;
    const intentLabel = INTENTS.find((i) => i.value === record.intent)?.label ?? record.intent;
    const card = el("div", { className: "glosa-annotation", "data-state": state });
    // The entry's header: its address in the hand, then who wrote it. "You" is honest here — every
    // entry in this list was written in glosa's own composer (invariant 3). The address is left
    // empty and filled by `applyAnchorVerdict` below, which owns everything on this card that is
    // derived from the current text.
    card.append(
      el("p", { className: "glosa-annotation-head" }, [
        el("span", { className: "glosa-address" }),
        el("span", { className: "glosa-annotation-who", textContent: "You" }),
      ]),
    );
    if (record.target?.quote?.exact) {
      card.append(
        el("p", { className: "glosa-annotation-quote" }, [el("span", { textContent: record.target.quote.exact })]),
      );
    }
    const stateRow = el("p", { className: "glosa-annotation-state" }, [
      el("span", { className: "glosa-state-dot", "aria-hidden": "true" }),
      el("span", {
        role: "status",
        "aria-live": "polite",
        textContent:
          item.error || (STATE_LABELS[state] ?? state) + (item.attempts > 1 ? ` · nudged ×${item.attempts}` : ""),
      }),
      el("span", { className: "glosa-annotation-intent", textContent: intentLabel }),
    ]);
    if (actions) {
      // The verbs sit in their own group so the state and intent read as one metadata run and the
      // actions as another, instead of "Change the words Edit Remove" running together.
      const actionGroup = el("span", { className: "glosa-annotation-actions" });
      // Revising is withdraw-then-write, never an in-place patch: the journal is append-only
      // (invariant 2), so a terminal entry has nothing left to revise and offers no Edit.
      if (!isTerminalState(state)) {
        actionGroup.append(
          el("button", {
            className: "glosa-annotation-edit",
            type: "button",
            textContent: "Edit",
            "aria-label": "Edit this annotation",
            onClick: () => editAnnotation(item),
          }),
        );
      }
      // An applied annotation is history, not a task — but history a reader can still walk back.
      // The offer appears only when a closed lease actually stated the sha to return to, so glosa
      // never promises an undo it cannot perform: a session that edited without taking a lease
      // proves no "before", and the card stays honestly silent about it.
      if (state === "applied" && rollbackPoints.has(item.id)) {
        actionGroup.append(
          el("button", {
            className: "glosa-annotation-undo",
            type: "button",
            textContent: "Undo",
            "aria-label": "Undo the change this annotation asked for",
            onClick: () => void undoApplied(item),
          }),
        );
      }
      // On a live entry this really withdraws it (terminal `rejected`, delivery stops). On a
      // settled one there is nothing left to withdraw — the journal is append-only and the entry
      // has already left the state machine — so the verb says what it actually does: it clears the
      // card from this view and the record stays in the journal. Same action, honest label. It used
      // to say "Dismiss" here, but `dismissed` is now a real wire terminal a human reaches through
      // `glosa inbox dismiss` — reusing the word for a button that writes nothing would put the one
      // honest state-machine transition and this local, view-only clear behind the same label.
      const settled = isTerminalState(state);
      actionGroup.append(
        el("button", {
          className: "glosa-annotation-remove",
          type: "button",
          textContent: settled ? "Clear" : "Remove",
          "aria-label": settled ? "Clear this annotation from the list" : "Remove this annotation",
          onClick: () => void removeAnnotation(item),
        }),
      );
      stateRow.append(actionGroup);
    }
    card.append(el("p", { className: "glosa-annotation-body", textContent: record.body }), stateRow);
    card._glosaItem = item;
    applyAnchorVerdict(card, addresses);
    connectAnchorHighlight(card, item);
    return card;
  }

  /** One quiet line of facts under the manuscript. Each fact is something this pane can prove:
   * marks are the entries in its own journal view; "answered" is a session's proven apply lease;
   * "outside glosa" is a disk change the pane observed against its baseline; approval is the
   * recorded verdict or the open request. Nothing here is inferred from a session's say-so. */
  function renderProvenance() {
    provenanceEl.textContent = "";
    const shown = Boolean(currentArtifact) && !loading && currentArtifact.class !== "F" && modeState.mode !== "edit";
    provenanceEl.hidden = !shown;
    if (!shown) return;
    const open = annotations.filter((item) => !isTerminalState(item.state)).length;
    const applied = annotations.filter((item) => item.state === "applied").length;
    const total = annotations.length;
    const fact = (term, detail) =>
      provenanceEl.append(
        el("div", { className: "glosa-provenance-fact" }, [
          el("dt", { textContent: term }),
          el("dd", { textContent: detail }),
        ]),
      );
    fact(
      "You",
      total === 0 ? "no marks" : `${total} ${total === 1 ? "mark" : "marks"}${open ? ` · ${open} open` : ""}`,
    );
    fact(getProviderName(), applied === 0 ? "nothing applied" : `${applied} applied`);
    fact("Outside glosa", diskChange ? "changed on disk" : "no changes");
    const approved = approvalResult && approvalResult.path === currentArtifact.source_path;
    fact(
      "Approval",
      approved
        ? `approved · ${approvalResult.revisionId.slice(0, 8)}`
        : matchingApprovalRequest()
          ? "requested"
          : "not requested",
    );
  }

  function renderMargin() {
    renderProvenance();
    marginEl.textContent = "";
    trayListEl.textContent = "";
    composerLayerEl.textContent = "";
    if (modeState.mode !== "review" || !currentArtifact) {
      if (composer) composer = null;
      closePreview();
      paintComposerSelection();
      renderTray();
      // The cards are gone; the marks they point at are not. layoutMargin also runs so the rail
      // class does not linger on an empty margin after leaving Annotate.
      const marks = () => {
        layoutMargin();
        paintAnnotationMarks();
      };
      if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(marks);
      else marks();
      return;
    }
    restoreParkedComposer();
    // Where the SET of cards lives. Beside their passages when the rail has room; in the pane's
    // own collection tray when it does not. The composer stays in the margin either way — it is
    // anchored to one passage, which is the whole point of it.
    const cardHost = isSideMargin() ? marginEl : trayListEl;
    // Synchronously, not on the next frame: the layout class decides whether the margin is an
    // in-flow block at the end of a 4000px document or the anchored layer, and a frame spent in
    // the wrong one is a visible jump.
    marginEl.classList.toggle("glosa-margin-side", cardHost === marginEl);
    marginEl.classList.toggle("glosa-margin-anchored", cardHost !== marginEl);
    marginEl.append(el("p", { className: "glosa-margin-title", textContent: "Annotations" }));
    if (composer) {
      const form = buildComposer();
      form._glosaItem = composer.record ? { record: composer.record } : null;
      composerLayerEl.append(form);
    }
    // Open work first, settled work after it under its own heading. An annotation a session has
    // already applied is a record of what happened, not something still asking to be read — but it
    // stays on the page, because "what did we change and can I take it back" is the question this
    // surface exists to answer.
    // The session's asks come first. Something is blocked on them; the reviewer's own notes are
    // not. Under their own heading, so a rail holding both never reads as one undifferentiated
    // stack of cards.
    const requests = agentRequests();
    if (requests.length > 0) {
      cardHost.append(
        el("p", {
          className: "glosa-margin-subhead",
          textContent: agentRequestSummary(requests),
        }),
      );
      for (const request of requests) {
        // With no rail, a question whose passage is located is answered AT the passage, in the
        // floating card; the tray lists it. Two live copies of one answer form would let a reader
        // type in one and send the other. A pointer, and a question with nowhere to float, keep
        // their whole card here.
        const atPassage = cardHost === trayListEl && isQuestion(request) && Boolean(rangeForPassage(request.passage));
        cardHost.append(atPassage ? buildAgentRow(request) : buildAgentCard(request));
      }
    }
    askLayerEl.textContent = "";
    if (!isSideMargin() && focusedRequestId) {
      const focused = requests.find((r) => r.id === focusedRequestId);
      if (focused && isQuestion(focused) && rangeForPassage(focused.passage)) {
        askLayerEl.append(buildAgentCard(focused, { floating: true }));
      }
    }
    const open = annotations.filter((item) => !isTerminalState(item.state));
    const resolved = annotations.filter((item) => isTerminalState(item.state));
    const addresses = addressBlocks(contentEl); // numbered once per render, not once per entry
    for (const item of open) cardHost.append(buildAnnotationCard(item, { addresses }));
    if (resolved.length) {
      // Named even when it is the whole list: "Resolved" is the state of the work, and a reader
      // opening a tray of settled cards should not have to infer that from the dots.
      cardHost.append(el("p", { className: "glosa-margin-subhead", textContent: "Resolved" }));
      for (const item of resolved) cardHost.append(buildAnnotationCard(item, { addresses }));
    }
    renderTray();
    if (!composer && annotations.length === 0 && requests.length === 0 && cardHost === marginEl) {
      marginEl.append(
        el("p", {
          className: "glosa-margin-empty",
          textContent: "Select any passage in the manuscript to attach feedback.",
        }),
      );
    }
    // Absolute positioning needs painted card heights — align on the next frame.
    const align = () => {
      layoutMargin();
      paintAnnotationMarks();
      paintComposerSelection();
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(align);
    else align();
  }

  /** The underlines and gutter dots, repainted. Called from every render and every content
   * change, in every mode — not from renderMargin, which returns early outside Annotate. */
  /** Stamps every top-level block with its address (address.js) so the page can show the label a
   * margin entry names. An attribute, never a node: the quote-and-offset anchors and the highlight
   * ranges read text and stay untouched. Re-run on every render, because the numbering is derived
   * from the current structure and a morph may have replaced a block. */
  function stampAddresses() {
    if (!currentArtifact || currentArtifact.class === "F") return;
    for (const [block, address] of addressBlocks(contentEl)) {
      if (block.getAttribute("data-address") !== address) block.setAttribute("data-address", address);
    }
  }

  function paintAnnotationMarks() {
    stampAddresses();
    repaintAnchorVerdicts();
    paintAnchorUnderlines();
    renderMarkers();
    paintAgentBands();
  }

  function setMode(mode) {
    if (readLock && mode !== "read") return;
    // Class-F Edit follows the derived-from edge (R6/R7) rather than switching THIS artifact into
    // edit mode: with an edge, open the source (class-R) artifact and edit that; with none, Edit
    // is absent from the mode control entirely — a programmatic call is a no-op.
    if (mode === "edit" && currentArtifact?.class === "F") {
      if (currentArtifact.derived_from) void openArtifactInThisPane(currentArtifact.derived_from);
      return;
    }
    // The mode control already omits Edit for an artifact that cannot be written to, but a
    // programmatic call reaches this from elsewhere — `viewer.js`'s `pane.setMode(mode)` on a deep
    // link into an ALREADY-OPEN pane, and `replacePanel` — neither of which consults the bar.
    if (mode === "edit" && currentArtifact && !canEdit(currentArtifact)) return;

    // An open block belongs to the state being left. Leaving it mounted was how the page ended up
    // with two writable faces over the same bytes at once — the source editor in front, a live
    // block editor still holding a stale span behind it — and how showing the notes left a caret
    // sitting in the middle of the passage a reader was trying to annotate. Committed, not
    // discarded: switching state is not a reason to lose a sentence.
    void closeRunEditor();

    const previousMode = modeState.mode;
    if (mode === "edit" && previousMode !== "edit" && applyPause) return;
    if (previousMode !== "edit" && mode === "edit") lastViewMode = previousMode;
    if (mode !== "edit") lastViewMode = mode;
    if ((mode === "edit") !== (previousMode === "edit")) pendingScrollTop = paneMain.scrollTop;
    // Park before the switch, while the editor that holds the draft is still mounted. Nothing
    // here can fail in a way that costs the text: `parkDrafts` reads, it never clears.
    if (previousMode !== mode) parkDrafts();
    modeState = modeReducer(modeState, { type: "set_mode", mode });
    if (modeState.mode !== "read") classFInteractive = true;
    // §7's rail needs about 1200px, and an evenly split pane never has it on any display anyone
    // owns. So Review takes the room it needs from its siblings rather than silently degrading
    // to the tray — the focus is expressed as WIDTH, not as depth: nothing floats, nothing covers
    // the other document, and the arrangement comes back when Review is left.
    if (modeState.mode === "review" && previousMode !== "review") claimWidth(MARGIN_RAIL_COMFORT);
    else if (previousMode === "review" && modeState.mode !== "review") releaseWidth();
    // Before renderContent, not after (#182 R1): the first mount inside renderContent reads
    // `baselineContent`, which this call is what sets for a fresh Edit entry.
    if (modeState.mode === "edit" && previousMode !== "edit") beginEditSession();
    renderModeBar();
    renderContent();
    // The fact survives the switch (D7); only whether it is SHOWN depends on the mode just
    // entered, so this has to re-run on every transition, not only when a new fact is recorded.
    renderDiskChange();
    void renderHistory();
    onStateChange();
    restorePendingScroll();
  }

  /** Puts the page back where the reader was before the state changed. Runs now and again on the
   * next frames, because the rich editor and the re-rendered manuscript mount asynchronously and
   * the page is shorter than the saved position until they do. */
  function restorePendingScroll() {
    if (pendingScrollTop === null) return;
    const target = pendingScrollTop;
    const apply = () => {
      if (pendingScrollTop !== target) return;
      paneMain.scrollTop = target;
    };
    apply();
    if (typeof requestAnimationFrame === "undefined") {
      pendingScrollTop = null;
      return;
    }
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(() => {
        apply();
        if (pendingScrollTop === target) pendingScrollTop = null;
      });
    });
  }

  editArea.addEventListener("input", () => {
    if (pendingReport && editArea.value !== pendingReport.text) pendingReport = null;
    unsavedFacePath = currentArtifact?.source_path ?? null;
    modeState = modeReducer(modeState, { type: "edited" });
    setEditStatus("");
    onStateChange();
  });

  // Face switching. Rich → Source hands over the honest text: the serialized doc only when the
  // rich editor actually changed it, the artifact's own bytes otherwise (never reformat an
  // untouched file). Source → Rich parses whatever the textarea holds right now.
  faceSourceBtn.addEventListener("click", () => {
    if (sourceFace || modeState.mode !== "edit") {
      sourceFace = true;
      renderContent();
      return;
    }
    // #182 R1: always ask the mounted editor, even when clean — its splice against its OWN mount
    // source returns that source verbatim when nothing changed, which is the baseline pair's own
    // bytes. Falling back to `currentArtifact.content` here (an SSE refresh can have moved it past
    // the pair) is exactly the coherence bug R1 names: a clean Rich→Source switch would otherwise
    // fill the source face from bytes newer than what a later Keep-mine merge verifies as `base`.
    const save = richEditor ? richEditor.getSave() : null;
    const carried = save ? save.markdown : (baselineContent ?? "");
    teardownRichFace();
    sourceFace = true;
    renderContent();
    editArea.value = carried; // after renderContent, so the artifact snapshot doesn't clobber it
    if (carried !== (baselineContent ?? "")) unsavedFacePath = currentArtifact?.source_path ?? null;
    refreshOutline(); // programmatic text assignment emits no input event
    // The report rides along: this text is still the rich face's splice until the writer edits it.
    pendingReport = reportToCarry(save, carried);
  });

  faceRichBtn.addEventListener("click", () => {
    if (!sourceFace || modeState.mode !== "edit") {
      sourceFace = false;
      renderContent();
      return;
    }
    const carried = editArea.value;
    // The rich face re-splices from this text, so it becomes the new baseline — which is exactly
    // when a report has to outlive its editor rather than being dropped.
    if (pendingReport?.text !== carried) pendingReport = null;
    sourceFace = false;
    teardownRichFace();
    renderFaceToggle();
    void mountRichFace(carried);
  });

  /**
   * What a save would write, and what it would cost: `{content, report}`.
   *
   * The rich face answers both at once — its splice re-serializes only the blocks whose tree
   * changed, so a clean editor returns the artifact's own bytes by construction rather than by a
   * caller remembering to check `isDirty()` first. The source face is byte-exact and answers only
   * with its text. Either way, a report that outlived its editor still applies while the text it
   * was made for is untouched (see `pendingReport`).
   */
  function pendingSave() {
    if (!currentArtifact) return { content: "", report: null };
    // Per-block edits come first: they are the whole document with committed runs spliced in, and
    // they exist in Read and Review where no full-page editor is mounted at all. The rich face's
    // own report still wins when Edit is open, because there the writer is holding the document.
    if (workingSource !== null && !richEditor && !sourceFace) {
      return { content: workingSource, report: null };
    }
    const live = !sourceFace && richEditor ? richEditor.getSave() : null;
    const content = live ? live.markdown : editArea.value;
    if (live && (live.collateral.length || live.degraded)) return { content, report: live };
    return { content, report: pendingReport?.text === content ? pendingReport.report : null };
  }

  /** A report worth carrying is one with something to consent to; anything else is just noise. */
  function reportToCarry(report, text) {
    return report && (report.collateral.length || report.degraded) ? { text, report } : null;
  }

  /** The lines a re-serialization would change that the writer did not, shown verbatim so they can
   * judge for themselves rather than take our word for it. */
  function collateralDetail(report) {
    if (report.degraded) return null;
    return report.collateral
      .slice(0, 3)
      .map(({ original, faithful }) => `${original}\n\n    becomes\n\n${faithful}`)
      .join("\n\n\u2014\u2014\n\n")
      .concat(report.collateral.length > 3 ? `\n\n\u2026and ${report.collateral.length - 3} more.` : "");
  }

  /**
   * Asks before a save that would change bytes the writer did not touch. Resolves to what to do:
   * `"save"`, `"source"` (hand the text to the byte-exact textarea and let them fix it), or `null`
   * for don't. A save is never allowed to invent an edit silently — every region this writes
   * reaches the agent as a `human_edit`, where a fabricated change is indistinguishable from a
   * real one.
   */
  function consentToCollateral(report) {
    if (!report || (!report.collateral.length && !report.degraded)) return Promise.resolve("save");
    const blocks = report.collateral.length;
    return choiceDialog({
      title: "This save would change words you didn't type",
      body: report.degraded
        ? "Glosa can't work out which parts of this file you changed, so saving rewrites the whole thing in its own formatting. Your words are kept; the layout around them may not be."
        : blocks === 1
          ? "The block you edited can't be written back exactly as it stands — re-writing it changes the markup shown below. Everything outside that block is untouched either way."
          : `${blocks} of the blocks you edited can't be written back exactly as they stand. Everything outside them is untouched either way.`,
      detail: collateralDetail(report) ?? undefined,
      choices: [
        { id: "source", label: "Edit as source" },
        { id: "save", label: "Save anyway" },
      ],
    });
  }

  /**
   * The only place a save writes to disk and settles the pane afterward — a retry from the
   * stale-save dialog (Keep mine) goes through here too, so none of these transitions can be
   * skipped by a path that isn't the ordinary Save button.
   */
  async function writeAndSettle(artifact, content, ifMatch) {
    saveButton.disabled = true;
    setEditStatus("Saving…");
    try {
      const saved = await dataAccess.putArtifact(slug, artifact.source_path, content, { ifMatch });
      currentArtifact = { ...artifact, content, ...saved };
      unsavedFacePath = null; // on disk now: the face follows the file again
      modeState = modeReducer(modeState, { type: "saved" });
      // The working source IS what was just written, so it stops being a local edit; keeping it
      // would make `isDirty()` lie and schedule a second save of bytes already on disk. The undo
      // stack goes with it: the checkpoint pair the write captured is what reverts a saved run now,
      // through History, and a stack that outlived its source would splice against moved offsets.
      workingSource = null;
      runUndo = [];
      clearParkedSource(); // the parked copy is now behind the file it was parked against
      pendingReport = null;
      clearDiskChange(); // the write that just landed is exactly what the banner was warning about
      // Re-render (fetch ?render=html) rather than trust `saved.rendered_html` blindly.
      const fresh = await dataAccess.getArtifact(slug, currentArtifact.source_path, { render: "html" });
      currentArtifact = fresh;
      setBaseline(fresh.source_sha256, fresh.content ?? ""); // the post-save re-read fills the face anew
      endEditSession();
      contentEl.removeAttribute("data-path"); // force the next renderContent to repaint from scratch
      teardownRichFace(); // remount the rich face from the freshly saved content
      setEditStatus("Saved.");
      renderModeBar();
      renderContent();
      onStateChange();
      void refreshHistory?.();
      return currentArtifact;
    } catch (error) {
      setEditStatus(
        error instanceof Error
          ? `Couldn't save this artifact: ${error.message}`
          : "Couldn't save this artifact. Try again.",
        { error: true },
      );
      throw error;
    } finally {
      saveButton.disabled = false;
    }
  }

  /**
   * Writes the artifact. Returns the saved artifact, or `SAVE_DECLINED` when the writer was asked
   * about collateral and said no — callers that act on a save (the approval flow) must check,
   * because "nothing was written" is not the same as "nothing needed writing".
   */
  async function saveCurrentArtifact({ onlyIfDirty = false } = {}) {
    if (!slug || !currentArtifact || currentArtifact.class !== "R") return currentArtifact;
    // `workingSource` is the third way this pane can be holding unwritten bytes, and leaving it out
    // is why the debounced write after a block edit did nothing at all: `scheduleRunSave` fired,
    // `saveCurrentArtifact` asked whether anything was dirty, and the one kind of edit it was
    // scheduled BY was the one kind this line could not see. `isDirty()` has counted it since the
    // day it was added; this did not, and the two have to agree or the save is a no-op that looks
    // like a save.
    const dirty = modeState.dirty || Boolean(richEditor?.isDirty()) || workingSource !== null;
    if (onlyIfDirty && !dirty) return currentArtifact;

    // Everything the write needs, captured before any await: asking about collateral suspends
    // this function, and an agent-driven reveal can swap the pane's artifact while a modal is up.
    const artifact = currentArtifact;
    const { content, report } = pendingSave();
    const consent = await consentToCollateral(report);
    // Path, not identity: refreshArtifact assigns a NEW object for the SAME path on every frame,
    // so identity would decline a save whenever the file merely refreshed under an open modal —
    // exactly the moment the write is optimistic against `baselineSha` and can safely proceed into
    // the 409 check instead. The optional chain keeps a markMissing-nulled currentArtifact declining.
    if (artifact.source_path !== currentArtifact?.source_path) return SAVE_DECLINED;
    if (consent !== "save") {
      // "Edit as source" keeps the edit and hands it to the byte-exact face, where the writer can
      // fix the collateral by hand; nothing reaches disk either way.
      if (consent === "source" && !sourceFace) {
        teardownRichFace();
        sourceFace = true;
        renderContent();
        editArea.value = content;
        unsavedFacePath = currentArtifact?.source_path ?? null; // unsaved bytes the writer now owns
        pendingReport = null; // they were shown the cost and chose to own these bytes
        modeState = modeReducer(modeState, { type: "edited" });
        editArea.focus();
        onStateChange();
      }
      return SAVE_DECLINED;
    }

    try {
      return await writeAndSettle(artifact, content, baselineSha ?? artifact.source_sha256);
    } catch (error) {
      if (error?.status === 409 && error.problem?.type === SOURCE_CHANGED) return staleSave(artifact);
      throw error;
    }
  }

  /** A5 §F10's own formula (the daemon's `sourceSha256`), computed client-side with Web Crypto so
   * the pane can hold `baselineSha` to its word before trusting `baselineContent` as a merge base
   * (#182 D2/D3): SHA256 of the UTF-8 bytes after `\r\n` → `\n`, hex-encoded. */
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /** The base a Keep-mine merge may trust, or `null` when there isn't one (D3): no baseline yet,
   * or `baselineContent` no longer hashes to `baselineSha` — the one check that stands between a
   * merge and silently treating some OTHER text as "the version the writer opened". */
  async function verifiedBaseline() {
    if (baselineSha === null || baselineContent === null) return null;
    return (await sha256Hex(baselineContent)) === baselineSha ? baselineContent : null;
  }

  /** What Keep mine would write against `fresh`, computed once and shared by the overwrite
   * preview and the write itself (D9: the preview is exactly the merge Keep mine would perform,
   * not a separate approximation of it). `pendingSave()` already answers "what would an ordinary
   * save write" for either face; the only thing added here is the disk side and the base. */
  async function keepMineMerge(fresh) {
    const threeWayMerge = await loadMergeModule();
    const { content: mine, report } = pendingSave();
    const base = await verifiedBaseline();
    return threeWayMerge(base, mine, fresh.content ?? "", report ?? { collateral: [], degraded: false });
  }

  /**
   * What a stale save would overwrite, computed client-side from the merge itself (D9) — no
   * checkpoint pin needed, so this shows even on a draft with no saved history yet. Degrades to a
   * base-unavailable notice rather than blocking (Step 5 still opens the dialog).
   */
  /** One readable line per conflict: where it is, and a bounded excerpt of the disk text Keep mine
   * is about to win over. A separator conflict names the boundary rather than a block, because
   * that is what it is. */
  function conflictLine(conflict) {
    const excerpt = (text) => {
      if (typeof text !== "string" || text === "") return "nothing";
      const flattened = text.replace(/\s+/g, " ").trim();
      return flattened.length > CONFLICT_EXCERPT_CHARS
        ? `“${flattened.slice(0, CONFLICT_EXCERPT_CHARS)}…”`
        : `“${flattened}”`;
    };
    const nameless = conflict.index === null || conflict.index === undefined;
    // A region between or around blocks is not always whitespace — a link-reference definition or
    // a stray line lives there too — so it is described as source, never as "spacing" (review
    // round 6).
    const where =
      conflict.region === "separator"
        ? nameless
          ? "The source between two blocks"
          : `The source after block ${conflict.index + 1}`
        : conflict.region === "leading"
          ? "The source above the first block"
          : conflict.region === "trailing"
            ? "The source below the last block"
            : conflict.region === "document"
              ? "The whole file, which has no blocks to align"
              : nameless
                ? "A block whose identity glosa could not prove"
                : `Block ${conflict.index + 1}`;
    // A `carried: false` entry is not a conflict the writer's version wins — it is the one case
    // where their bytes do NOT survive, and saying "your version wins there" about it would be
    // false (review round 8).
    if (conflict.carried === false) {
      const whose = conflict.side === "mine" ? "your" : "disk's";
      return `• ${where}: ${whose} version of it is NOT kept — ${excerpt(conflict.dropped)} is dropped.`;
    }
    if (conflict.reason === "unprovable-separator") return `• ${where}: glosa could not tell whose source to keep.`;
    if (conflict.reason === "unprovable-identity") return `• ${where}: your whole version is kept.`;
    return `• ${where}: on disk ${excerpt(conflict.theirs)}.`;
  }

  async function overwritePreview(fresh) {
    const result = await keepMineMerge(fresh);
    if (!result.baseAvailable) {
      const lines = [
        "Glosa can't verify the version you opened, so every change on both sides is treated as a conflict — Keep mine will use your version everywhere and none of the disk change shown below.",
        ...result.conflicts.map(conflictLine),
      ];
      return lines.join("\n");
    }
    const lines = [];
    // Only disk-originated entries — the writer already knows about their own edit, so the
    // preview describes what Keep mine does TO DISK's version, not a recap of theirs.
    const keptFromDisk = result.merged.filter(
      (entry) => entry.kind === "theirs-changed" || entry.kind === "theirs-inserted",
    );
    if (keptFromDisk.length) {
      lines.push(`${keptFromDisk.length} change${keptFromDisk.length === 1 ? "" : "s"} from disk will be kept.`);
    }
    if (result.conflicts.length) {
      // "blocks" would be a lie for a conflict in the source between them, and the writer should
      // not have to decode which kind each line is from its wording alone (review rounds 5 and 6).
      const lost = result.conflicts.filter((conflict) => conflict.carried === false);
      // `carried: null` is neither: glosa could not attribute the bytes at that boundary, so it
      // must not be announced as a win for the writer (review round 9).
      const unattributed = result.conflicts.filter((conflict) => conflict.carried === null);
      const contested = result.conflicts.filter((conflict) => conflict.carried === undefined);
      const blockCount = contested.filter((conflict) => !conflict.region).length;
      const regionCount = contested.length - blockCount;
      const parts = [];
      if (blockCount) parts.push(`${blockCount} block${blockCount === 1 ? "" : "s"}`);
      if (regionCount) parts.push(`${regionCount} other source region${regionCount === 1 ? "" : "s"}`);
      if (parts.length) {
        lines.push(`${parts.join(" and ")} changed on both sides — your version wins there:`);
      }
      // D6/D9: a count tells the writer that something collided, not what. Name each one and show
      // the disk text their version is about to win over, bounded so a large block cannot push the
      // dialog past reading length.
      lines.push(...contested.map(conflictLine));
      if (lost.length) {
        lines.push(`${lost.length} change${lost.length === 1 ? "" : "s"} cannot be carried into the merge:`);
        lines.push(...lost.map(conflictLine));
      }
      if (unattributed.length) {
        lines.push(
          `${unattributed.length} boundar${unattributed.length === 1 ? "y" : "ies"} glosa could not attribute to either side:`,
        );
        lines.push(...unattributed.map(conflictLine));
      }
    }
    return lines.length ? lines.join("\n") : undefined;
  }

  /**
   * *Keep mine* — a three-way merge of the base the writer opened, the writer's current text, and
   * the fresh disk bytes (#182): a block only the writer touched keeps the writer's bytes, a block
   * only disk touched keeps disk's bytes, and a block both touched is a conflict the writer's
   * version wins (D6) — the preview above already showed which. `consentToCollateral` still runs
   * on the result (R4): the merge carries mine's own splice report through untouched, so #186's
   * consent for a re-serialized block of the writer's OWN edit is unaffected by the merge.
   *
   * The retry is guarded (D9/AC-19): a second 409 here means the file changed AGAIN while the
   * writer was deciding — reopening the dialog would ask the same question about a version that
   * has already moved on, so this reports and declines instead.
   */
  async function keepMine(artifact, fresh) {
    const result = await keepMineMerge(fresh);
    if ((await consentToCollateral(result)) !== "save") return SAVE_DECLINED;
    try {
      return await writeAndSettle(artifact, result.text, fresh.source_sha256);
    } catch (error) {
      if (error?.status === 409) {
        setEditStatus("Not saved — this file changed again while you were deciding.", { error: true });
        return SAVE_DECLINED;
      }
      throw error;
    }
  }

  /**
   * Opens when a save's `If-Match` is refused because the file moved under the draft (D5, D9).
   * Every non-write outcome returns `SAVE_DECLINED` (C3.2) — Cancel, Esc and the backdrop all
   * resolve `choiceDialog` to `null` here, so one `if` chain covers all three.
   */
  async function staleSave(artifact) {
    setEditStatus("Checking what changed…");
    const fresh = await dataAccess.getArtifact(slug, artifact.source_path, { render: "html" });
    // Whatever landed on disk is not decodable any more, so there is no version of this dialog
    // worth opening: every choice in it writes a replacement-character decode back. Take disk
    // would fill the editor from one, and Keep mine would splice onto it as a merge base.
    if (fresh.valid_utf8 === false) {
      setEditStatus(
        "Not saved — this file is no longer valid UTF-8 on disk. glosa won't overwrite bytes it can't read.",
        { error: true },
      );
      return SAVE_DECLINED;
    }
    const choice = await choiceDialog({
      title: "This file changed while you were editing",
      body: `${artifact.source_path} was written after you started. Saving now replaces that version with yours.`,
      detail: await overwritePreview(fresh),
      choices: [
        { id: "take-disk", label: "Take disk", danger: true },
        { id: "compare", label: "Compare" },
        { id: "keep-mine", label: "Keep mine" },
      ],
    });
    if (choice === "take-disk") return await takeDisk(fresh);
    if (choice === "compare") {
      await compareStaleSave(artifact);
      return SAVE_DECLINED;
    }
    if (choice === "keep-mine") return await keepMine(artifact, fresh);
    return SAVE_DECLINED; // Cancel / Esc / backdrop
  }

  saveButton.addEventListener("click", async () => {
    if (!slug || !currentArtifact || saveButton.disabled) return;
    try {
      await saveCurrentArtifact();
    } catch {
      // saveCurrentArtifact keeps the user's source intact and renders the actionable error.
    }
  });

  // Annotate mode: a text selection inside the rendered content opens the composer with the
  // selected quote; the record is only posted when the reviewer submits.
  contentEl.addEventListener("mouseup", () => {
    if (modeState.mode !== "review" || !slug || !currentArtifact) return;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (!record) return;
    let returnFocus =
      selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    while (returnFocus?.parentElement && returnFocus.parentElement !== contentEl)
      returnFocus = returnFocus.parentElement;
    openComposer(record, { returnFocus: returnFocus instanceof HTMLElement ? returnFocus : contentEl });
  });

  // The keyboard equivalent of reaching a passage with the pointer. Each top-level rendered block
  // is a focus target, and Enter or Space does to the focused one exactly what a click would do:
  // in Review it selects the block and opens the same composer a drag-selection opens, so
  // annotating never depends on dragging; in Edit it opens the run editor with the caret in it,
  // so writing never depends on clicking.
  contentEl.addEventListener("keydown", (event) => {
    const block = event.target;
    if (!(block instanceof HTMLElement) || !block.classList.contains("glosa-block-target")) return;
    if (modeState.mode !== "review" && modeState.mode !== "edit") return;
    const blocks = Array.from(contentEl.querySelectorAll(".glosa-block-target"));
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const current = Math.max(0, blocks.indexOf(block));
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? blocks.length - 1
            : Math.min(blocks.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
      blockTargetFocusIndex = next;
      for (const [index, candidate] of blocks.entries())
        candidate.setAttribute("tabindex", index === next ? "0" : "-1");
      blocks[next]?.focus();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    // No coordinates to hand it: a key names the passage, not a point inside it, so the caret goes
    // where `focusAt` puts it with nothing to aim at rather than under a pointer that was never here.
    if (modeState.mode === "edit") {
      void openRunEditor(block, null);
      return;
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let textNode = walker.nextNode();
    while (textNode) {
      textNodes.push(textNode);
      textNode = walker.nextNode();
    }
    if (textNodes.length === 0) return;
    const range = document.createRange();
    range.setStart(textNodes[0], 0);
    const lastTextNode = textNodes[textNodes.length - 1];
    range.setEnd(lastTextNode, lastTextNode.textContent.length);
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    selection?.removeAllRanges();
    selection?.addRange(range);
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (record) openComposer(record, { returnFocus: block });
  });

  contentEl.addEventListener("focusin", (event) => {
    const block = event.target;
    if (!(block instanceof HTMLElement) || !block.classList.contains("glosa-block-target")) return;
    const blocks = Array.from(contentEl.querySelectorAll(".glosa-block-target"));
    blockTargetFocusIndex = Math.max(0, blocks.indexOf(block));
    for (const [index, candidate] of blocks.entries())
      candidate.setAttribute("tabindex", index === blockTargetFocusIndex ? "0" : "-1");
  });

  // §7: `layoutMargin`'s anchor measurement observes the PANE, not the window — a pane changes
  // width when a sash moves and the window does not. The observer is also what feeds
  // `isSideMargin`, so the rail/tray decision follows the same single source of truth.
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? paneEl.clientWidth;
          if (Math.round(width) === Math.round(paneWidth)) return;
          applyPaneWidth(width);
          paintAnnotationMarks();
          // A narrower pane re-wraps the source face, which moves every heading in it.
          outlineSourceKey = "";
          refreshOutline();
        });
  observer?.observe(paneEl);
  paneWidth = paneEl.clientWidth;

  /** A new pane width. Crossing the rail floor changes WHERE the cards live (the rail beside their
   * passages, or the collection tray), which only renderMargin decides; a width that stays on the
   * same side of the floor only needs the cards re-aligned. Re-laying out alone left a pane that
   * loaded its notes before its first real measurement with an empty rail and a full tray. */
  function applyPaneWidth(width) {
    const wasSide = isSideMargin();
    paneWidth = width;
    if (isSideMargin() !== wasSide) renderMargin();
    else layoutMargin();
  }

  // ---------- artifact loading ----------

  /** Puts back everything about this artifact's annotations that outlives the tab: the cards, the
   * underline under each annotated passage, the gutter dots, and the offer to undo a change a
   * session already applied.
   *
   * Without this the pane's annotation state lived only in the browser tab that created it. The
   * notes were durable — they are journal entries, and the session still had them queued — but
   * reloading the page, or opening the same manuscript in a second pane, showed an untouched
   * document. The reader had no way to see what they had already asked for.
   *
   * Best-effort by construction: a daemon that cannot answer (an older build, a transient
   * failure) still gets the artifact opened, with exactly the capability the pane had before this
   * existed. And because `loadArtifact` can be re-entered while this is in flight, the result is
   * dropped unless the pane is still showing the artifact it was fetched for. */
  async function hydrateAnnotations(artifactPath) {
    let listed;
    try {
      listed = await dataAccess.getAnnotations(slug, artifactPath);
    } catch {
      return;
    }
    if (destroyed || currentArtifact?.source_path !== artifactPath) return;
    for (const row of listed?.annotations ?? []) {
      if (!row?.id) continue;
      annotations.push({
        record: {
          kind: "annotation",
          artifact_path: row.artifact_path,
          body: row.body ?? "",
          intent: row.intent,
          target: row.target,
          ...(row.captured_rendered_sha256 ? { captured_rendered_sha256: row.captured_rendered_sha256 } : {}),
        },
        id: row.id,
        // `waiting` is the SPA's name for the wire's initial `pending` — same remap the POST
        // response and the live journal frames go through, so a hydrated card and a just-sent one
        // are indistinguishable from here on.
        state: row.status === "pending" ? "waiting" : row.status,
        ...(row.attempts ? { attempts: row.attempts } : {}),
      });
      if (row.rollback_pre_sha) rollbackPoints.set(row.id, row.rollback_pre_sha);
    }
  }

  async function loadArtifact(artifactPath) {
    loading = true;
    classFInteractive = false;
    // A different file is a different document: an open run belongs to the one being left, and its
    // working source and undo stack are spans into bytes that are about to stop being on screen.
    // Committed and WRITTEN before they are forgotten — this used to close with `save: false` and
    // then null the working source, so opening another artifact inside the debounce window threw
    // away whatever had just been typed, with nothing said.
    await closeRunEditor();
    await flushRunSave();
    workingSource = null;
    runUndo = [];
    composer = null;
    focusedRequestId = null;
    returnPlace = null;
    answerJustSent = false;
    noticeKey = "\u0000"; // force the next renderNotice to rebuild for the new artifact
    annotations = [];
    rollbackPoints.clear();
    approvalResult = null;
    approvalError = "";
    teardownRichFace();
    renderContent();
    try {
      currentArtifact = await dataAccess.getArtifact(slug, artifactPath, { render: "html" });
      // A `mode=edit` deep link onto an artifact that cannot be written to lands in Read, here,
      // BEFORE the first manuscript paint and before `beginEditSession()` below — so no editor is
      // ever mounted over bytes this pane would refuse to save, and `onStateChange` writes
      // `mode=read` back to the hash. Scoped to class R: class F's own `mode=edit` handling is the
      // derived-from hop in `setMode`, which this must not intercept.
      if (modeState.mode === "edit" && currentArtifact.class === "R" && !canEdit(currentArtifact)) {
        modeState = modeReducer(modeState, { type: "set_mode", mode: "read" });
        lastViewMode = "read";
      }
      // Warm the editor while the reader is still reading. Fetching it on the first click would put
      // a 400 KB download between the click and the caret — the delay this redesign exists to
      // remove, moved rather than fixed. `loadMergeModule` warms itself on the same reasoning.
      if (runEditingAvailable()) void loadEditorKit();
      setBaseline(currentArtifact.source_sha256, currentArtifact.content ?? ""); // a newly loaded artifact fills the face
      faceControl?.refresh();
    } catch (err) {
      loading = false;
      currentArtifact = null;
      setEmpty(
        "This artifact couldn't be opened.",
        el("p", { className: "glosa-empty-hint", textContent: err?.message ?? "Try again, or pick another artifact." }),
      );
      renderModeBar();
      renderContent();
      onStateChange();
      return false;
    }
    loading = false;
    // Before the render, not after: the cards, underlines and dots then appear with the
    // manuscript instead of arriving as a second, visible repaint a beat later.
    await hydrateAnnotations(artifactPath);
    if (destroyed) return false;
    contentEl.removeAttribute("data-path");
    renderModeBar();
    renderContent();
    // A pane opened directly in Edit fills its face here rather than through setMode's transition.
    if (modeState.mode === "edit") beginEditSession();
    void renderHistory();
    onStateChange();
    return true;
  }

  // ---------- disk-change banner (REQ-2) ----------

  /** A disk change that differs from `baselineSha` — the file this pane opened has moved under
   * the draft. Recorded immediately with `seenAt`; a save is not blocked on anything here. `sha`
   * is what the caller compares against to decide whether a later frame is the same fact repeated
   * (no-op) or a genuinely new one (rebuilds this, resetting `acknowledged`). */
  function noteDiskChange(sha) {
    diskChange = { sha, seenAt: new Date(), at: null, attribution: null, acknowledged: false };
    renderDiskChange();
    void resolveDiskAttribution();
  }

  function clearDiskChange() {
    diskChange = null;
    renderDiskChange();
  }

  /** *Keep editing* — dismisses the banner without discarding anything. A later disk change
   * builds a fresh `diskChange` object (`noteDiskChange`), so `acknowledged` resets by
   * construction rather than needing to be cleared anywhere else. */
  function acknowledgeDiskChange() {
    if (diskChange) diskChange.acknowledged = true;
    renderDiskChange();
  }

  function formatClockTime(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /**
   * D2: a writer is named ONLY when a path-matched diff hunk proves it — never from the mere fact
   * that something was checkpointed. `attribution` is a git commit trailer and can only ever be
   * `"human"`, `"session:<id>"` or `"unknown"` (AGENTS.md invariant 3 / A4 §F05); this stores
   * whatever the daemon returns for a MATCHED path verbatim and never substitutes a guess.
   *
   * Never blocks anything already on screen — the banner already reads `seenAt` before this is
   * called. A rejected call, an empty cursor, or an unmatched path all leave it that way.
   */
  async function resolveDiskAttribution() {
    const cursor = editSession?.attributionCursor;
    if (!cursor) return; // no pin to walk forward from — stays unattributed
    const changeAtCall = diskChange;
    let rows;
    try {
      rows = await dataAccess.getCheckpoints(slug, { since: cursor, limit: 1 });
    } catch {
      return;
    }
    if (!rows?.length) return; // nothing checkpointed since the cursor
    const newCursor = rows[0].checkpoint_id;
    let hunks;
    try {
      hunks = (await dataAccess.getDiff(slug, { from: cursor, to: newCursor })).hunks;
    } catch {
      return;
    }
    // Advances regardless of whether this range happened to touch the artifact's own path — the
    // range up to `newCursor` has been considered either way, and re-walking it on the next call
    // would only repeat this same answer.
    if (editSession) editSession.attributionCursor = newCursor;
    const hunk = hunks?.find((candidate) => candidate.path === currentArtifact?.source_path);
    if (!hunk) return; // checkpoints landed; none of them touched THIS file — still unattributed
    // The banner this was resolving for may have already been superseded by a newer disk change
    // (or cleared) while the lookup was in flight — landing a stale answer on the current one
    // would attribute the wrong fact.
    if (diskChange !== changeAtCall) return;
    diskChange.attribution = hunk.attribution;
    diskChange.at = rows[0].at;
    renderDiskChange();
  }

  /** Honest by construction: a writer is named only when `resolveDiskAttribution` found a
   * path-matched hunk. Everything else — no hunk, an unmatched path, an "unknown" trailer, a
   * rejected lookup — reads the same honest default rather than inventing a name for any of them. */
  function diskChangeCopy(change) {
    if (change.attribution === "human") {
      return `Changed on disk — last recorded change was an edit in glosa at ${formatClockTime(new Date(change.at))}.`;
    }
    if (typeof change.attribution === "string" && change.attribution.startsWith("session:")) {
      const shortId = change.attribution.slice("session:".length).slice(0, 12);
      return `Changed on disk — last recorded change by session ${shortId} at ${formatClockTime(new Date(change.at))}.`;
    }
    return `Changed on disk, seen at ${formatClockTime(change.seenAt)} — no checkpoint records who changed it.`;
  }

  /** Scoped to Edit (D7): outside Edit, `.glosa-pane-main` is itself the scroller, and inserting a
   * flex sibling above `contentEl` would move the manuscript under an unchanged `scrollTop`. The
   * fact survives a mode switch even though the banner does not render outside Edit — hence this
   * runs from every mode transition, not only from a fresh disk change. */
  function renderDiskChange() {
    // WHENEVER THERE IS UNSAVED WORK, and whenever the full-page editor is open holding a document.
    // Not "whenever the pane is in Edit": since Edit became the page being writable rather than a
    // textarea full of a draft, that would put a banner in front of every reader who pressed Edit
    // and then typed nothing. A session writing a document nobody has changed is the system
    // working, not an event.
    const unsaved = isDirty();
    const visible = Boolean(diskChange) && !diskChange.acknowledged && (fullPageEditor || unsaved);
    diskChangeEl.hidden = !visible;
    // In Edit the notice is a row in the flex column above the source face. Outside Edit,
    // `.glosa-pane-main` is itself the scroller, so a row here would push the manuscript down
    // under an unchanged `scrollTop` and move the reader's place — which is the move this whole
    // redesign exists to stop. So it floats clear of the flow instead.
    diskChangeEl.toggleAttribute("data-floating", visible && !fullPageEditor);
    if (!visible) return;
    diskChangeCopyEl.textContent = diskChangeCopy(diskChange);
  }

  /** The one prompt for discarding unsaved work, shared by the pane's own close guard and
   * *Reload* — never a second, differently-worded prompt for the same act. Self-skips when clean,
   * so Reload on a clean stale editor is a single click. */
  async function confirmDiscard() {
    if (!isDirty()) return true;
    const discard = await confirmDialog({
      title: "Discard unsaved edits?",
      // Says "this tab" rather than "leaving Edit": mode switches park drafts now, so closing
      // is the only remaining way to actually lose one, and the prompt should not imply
      // otherwise.
      body: "This artifact has changes that haven't been saved. Closing this tab throws them away.",
      confirmLabel: "Discard edits",
      danger: true,
    });
    return discard;
  }

  /**
   * *Reload* (REQ-4) — takes the file from disk instead of saving over it: discards the draft
   * and remounts the editor over the fresh disk bytes, writing nothing (no write, no checkpoint).
   * Reuses `confirmDiscard()` verbatim (C5) — never a second discard prompt. Declining changes
   * nothing; `confirmDiscard` itself self-skips when the pane is clean, which is what makes Reload
   * on a clean stale editor a single click. The banner's Reload button delegates here too.
   */
  async function takeDisk(fresh) {
    if (!(await confirmDiscard())) return SAVE_DECLINED;
    modeState = modeReducer(modeState, { type: "discard" });
    clearParkedSource();
    pendingReport = null;
    clearDiskChange();
    endEditSession();
    setBaseline(fresh.source_sha256, fresh.content ?? "");
    // `fresh` may be a re-read staleSave fetched separately from currentArtifact (the stale-save
    // dialog's path) — without this, the reload sequence below would remount over the STALE
    // content that just failed to save, defeating the whole point of "take disk".
    currentArtifact = fresh;
    contentEl.removeAttribute("data-path");
    teardownRichFace();
    // The discard above already happened — the writer consented to it. What is left is where to
    // land, and the disk bytes may be ones no save could reach (#250): leave Edit rather than
    // remount a face over them. `setMode` does the renders this branch would otherwise do.
    if (!canEdit(fresh)) {
      setMode("read");
      return SAVE_DECLINED;
    }
    renderModeBar();
    renderContent();
    onStateChange();
    return SAVE_DECLINED;
  }

  /**
   * *Compare* (REQ-5) — opens a diff tab from the checkpoint pinned at Edit entry to the working
   * file; writes nothing, and the editor stays exactly as dirty as it was. When the pin is null,
   * falls back to the newest checkpoint (`compareWithLastSaved`'s own behaviour) and reuses its
   * message when there isn't one.
   */
  async function compareStaleSave(artifact) {
    if (!openDiffTab) return;
    let from = editSession?.openedCheckpointId;
    if (!from) {
      try {
        const rows = await dataAccess.getCheckpoints(slug, { limit: 1 });
        from = rows?.[0]?.checkpoint_id;
      } catch {
        from = undefined;
      }
      if (!from) {
        setEditStatus("This artifact has no saved versions to compare with yet.");
        return;
      }
    }
    openDiffTab({ path: artifact.source_path, from, to: "working" });
  }

  async function refreshArtifact() {
    if (!currentArtifact) return;
    const fresh = await dataAccess.getArtifact(slug, currentArtifact.source_path, { render: "html" });
    // NOTHING LANDS UNDER AN OPEN BLOCK. A session writing the file used to take the editor with
    // it: the morph below replaced the manuscript, the open run's host went with it, and whatever
    // had been typed was gone with no notice — while `openRun` kept holding byte offsets into a
    // document that had moved. So an external change arriving mid-edit is RECORDED and HELD. The
    // writer keeps their words and their caret; the notice says the file moved; the write is
    // already protected, because the save carries `If-Match` against the sha this pane opened and
    // the daemon refuses a stale one into the conflict path that exists for exactly this.
    if (openRun) {
      if (fresh.source_sha256 !== baselineSha && (!diskChange || diskChange.sha !== fresh.source_sha256)) {
        noteDiskChange(fresh.source_sha256);
      }
      heldExternalRefresh = true;
      return;
    }
    currentArtifact = fresh;
    renderEncodingNotice();
    // The file became undecodable under an open pane. With nothing typed, leave Edit — the Edit
    // button is already gone from the bar and the tools row, and staying would leave the page
    // writable with no way back to it. With a draft open, STAY: the disk-change banner already
    // says the file moved, the daemon refuses the save either way, and dropping to Read would park
    // the draft behind a button that no longer exists.
    if (fresh.valid_utf8 === false && modeState.mode === "edit" && !isDirty()) {
      setMode("read");
      return;
    }
    if (fresh.class === "F") {
      // A1 §7: "fresh mint per iframe open/reload" — an SSE-driven re-render discards the old
      // iframe and mints a brand new capability rather than trying to reuse the expiring one.
      mountClassFArtifact(true);
      return;
    }
    if (fresh.class === "R" && baselineSha) {
      if (fresh.source_sha256 === baselineSha) {
        // The other writer's change is gone — undone, or this pane's own baseline caught up to
        // it — so the fact this banner was warning about no longer holds.
        if (diskChange) clearDiskChange();
      } else if (modeState.mode === "edit" || isDirty()) {
        // Comparing against the sha the CURRENT diskChange already represents, not just against
        // baseline: baseline never moves on a refresh, so a bare `!== baselineSha` check would
        // rebuild `diskChange` — and reset `acknowledged` — on every repeated frame carrying the
        // same disk state, undoing "Keep editing" the moment the next identical frame arrived.
        if (!diskChange || diskChange.sha !== fresh.source_sha256) noteDiskChange(fresh.source_sha256);
      }
    }
    // WHETHER THE MANUSCRIPT IS ON SCREEN, not whether the pane is in Edit. Those were the same
    // question while Edit meant a textarea in front of the page; now Edit IS the page, and asking
    // the old one left the manuscript showing a document the file no longer contained for as long
    // as the writer stayed in Edit.
    if (!fullPageEditor) {
      morphArtifactContent(contentEl, fresh.rendered_html ?? "");
      // Stamp ONLY after actually morphing — stamping while the full-page editor skips the morph
      // would make the next renderContent believe the stale DOM is current and never repaint it.
      contentEl.setAttribute("data-path", currentArtifact.source_path);
    } else {
      contentEl.removeAttribute("data-path"); // repaint from fresh rendered_html when it closes
    }
    layoutMargin(); // anchors may have moved with the new content
    paintAnnotationMarks();
    refreshOutline(); // a session's edit can add or remove a section
  }

  /** The artifact this pane holds was deleted while the tab was open (§11). The tab dims and the
   * pane says so; glosa never closes a tab the reader opened, because that silently destroys the
   * layout they built. */
  function markMissing() {
    currentArtifact = null;
    loading = false;
    paneEl.setAttribute("data-missing", "true");
    setEmpty(
      "This artifact is gone.",
      el("p", {
        className: "glosa-empty-hint",
        textContent:
          "It was deleted or moved outside glosa. Close this tab, or restore the file and it reappears here.",
      }),
    );
    renderModeBar();
    renderContent();
    onStateChange();
  }

  function isDirty() {
    // An open run whose text has been touched is unsaved work exactly as much as a parked draft is.
    // Leaving it out is what let a disk change arrive unannounced while someone was mid-sentence:
    // `refreshArtifact` only records one when the pane is dirty, and a block editor with a word
    // typed into it did not count.
    return (
      modeState.dirty || Boolean(richEditor?.isDirty()) || Boolean(openRun?.editor?.isDirty()) || workingSource !== null
    );
  }

  function focusPreview() {
    const target =
      (!emptyEl.hidden ? emptyEl.querySelector(".glosa-empty-title, p") : null) ??
      contentEl.querySelector("h1, h2, h3, p") ??
      contentEl;
    if (!(target instanceof HTMLElement)) return;
    const temporaryTabIndex = !target.hasAttribute("tabindex");
    if (temporaryTabIndex) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    if (temporaryTabIndex) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }

  renderModeBar();
  renderContent();
  const ready = loadArtifact(path);

  return {
    element: paneEl,
    path,
    ready,
    get artifact() {
      return currentArtifact;
    },
    getMode: () => modeState.mode,
    setMode,
    /** The workbench's view of the workspace's apply lease: an object while a session holds one,
     * null once it ends or expires. Pauses Edit; a draft already open is kept and told why. */
    setApplyPause(lease) {
      const next = lease ?? null;
      if ((applyPause === null) === (next === null)) {
        applyPause = next;
        return;
      }
      applyPause = next;
      renderModeBar();
      renderArtifactTools();
      if (modeState.mode === "edit") {
        setEditStatus(
          next ? "A session is applying a change to this workspace. Your draft is kept; save when it finishes." : "",
        );
      }
    },
    /** Hide notes / show notes on the one page: the read ↔ review toggle, for commands. */
    toggleNotes() {
      if (readLock || modeState.mode === "edit") return;
      setMode(modeState.mode === "review" ? "read" : "review");
    },
    /** ⌘E: into Edit, or back out of it. Reaches the page's writable state, not the source view —
     * the shortcut follows the button beside it rather than the tool in the menu. */
    toggleEdit() {
      if (readLock) return;
      if (modeState.mode === "edit") setMode("read");
      else if (!currentArtifact || canEdit(currentArtifact)) setMode("edit");
    },
    canEdit: () => !readLock && Boolean(currentArtifact) && canEdit(currentArtifact) && !applyPause,
    /** This document's sections and the one the reader is in, for the workspace's Go to palette. */
    getOutline: () => ({ entries: outlineEntries, current: outlineCurrent }),
    isDirty,
    annotationCount: () => annotations.length,
    isMissing: () => paneEl.hasAttribute("data-missing"),
    isStale: () => Boolean(currentArtifact?.stale),
    artifactClass: () => currentArtifact?.class ?? null,
    focus: focusPreview,
    refreshArtifact,
    /** The approval strip reads workspace-scoped attention entries, which change outside this
     * pane (a new request arrives, another pane approves one). The workspace calls this. */
    refreshApproval: renderApprovalStrip,
    /** Same reason, for the rail: the session's asks arrive workspace-scoped and become cards in
     * THIS pane's margin, so a changed inbox has to repaint the cards and their bands. */
    refreshAgentRequests: ({ arrived } = {}) => {
      markArrived(arrived);
      // A question that was answered or withdrawn elsewhere must not leave this pane "on" it.
      if (focusedRequestId && !agentRequests().some((r) => r.id === focusedRequestId)) focusedRequestId = null;
      renderMargin();
      paintAgentBands();
    },
    /** Takes the reader to one request. Only the reader's own "Go to it" reaches this — for a
     * question about an artifact that was not open, the workspace opens it and then calls here.
     * Nothing calls it on arrival: glosa does not move the reader (#308). */
    revealRequest: (entryId) => {
      const request = agentRequests().find((candidate) => candidate.id === entryId);
      if (request) goToRequest(request);
    },
    /** The active pane is the one that offers questions about artifacts nobody has open. */
    refreshNotice: renderNotice,
    applyJournalEvent,
    markMissing,
    refreshHistory: () => void refreshHistory?.(),
    /** Opening or closing another tab can lengthen or shorten this one's label, which changes what
     * the bar still needs to say. The dock calls this whenever it relabels. */
    refreshTitle: renderTitle,
    /** Called by the dock when this pane's element is reparented (a drag between groups). The
     * observer keeps reporting, but the manuscript's scroll container moved, so anchors must be
     * re-measured against the new box. */
    remeasure() {
      applyPaneWidth(paneEl.clientWidth);
      renderMarkers();
      outlineSourceKey = "";
      refreshOutline();
    },
    confirmClose: () => confirmDiscard(),
    destroy() {
      destroyed = true;
      // Best effort, and the last chance this pane gets: a pending write outlives the element it
      // was typed into or it does not survive at all.
      void flushRunSave();
      if (modeState.mode === "review") releaseWidth();
      document.removeEventListener("click", onDocumentClick);
      paneEl.removeEventListener("scroll", onPaneScroll, { capture: true });
      editArea.removeEventListener("input", onSourceInputForOutline);
      if (outlineSourceTimer) clearTimeout(outlineSourceTimer);
      if (outlineFrame) cancelAnimationFrame(outlineFrame);
      faceControl?.destroy();
      observer?.disconnect();
      teardownRichFace();
      stopClassFViewer?.();
      // Withdraw only THIS pane's ranges: the three keys are shared, so deleting them outright
      // would erase every other open artifact's marks.
      for (const name of [HL_ANCHORS, HL_ANCHOR, HL_COMPOSER]) contributeHighlight(name, paneHighlightToken, []);
      closePreview();
      paneEl.remove();
    },
  };
}
