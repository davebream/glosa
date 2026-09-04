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

import { buildAnnotationRecordFromSelection } from "./annotate.js";
import { mountClassFViewer } from "./classf-viewer.js";
import { confirmDialog } from "./dialog.js";
import { Idiomorph } from "./vendor/idiomorph.js";
import { createElement as el } from "./viewer-shell.js";

export const MODES = ["preview", "annotate", "edit"];

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
};

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

export function initialModeState(mode = "preview") {
  return { mode: MODES.includes(mode) ? mode : "preview", dirty: false, blocked: null };
}

/**
 * Pure Preview↔Annotate↔Edit transition reducer. Leaving "edit" while `dirty` (unsaved textarea
 * changes) is blocked: the reducer parks the requested mode in `blocked` instead of switching,
 * so the caller can prompt ("discard unsaved edits?") and then dispatch either `discard` (drops
 * the edits, switches to the parked mode) or re-dispatch `set_mode` for "edit" itself (stays put)
 * once the user answers. Every other transition between the three modes is always legal.
 */
export function modeReducer(state, action) {
  switch (action.type) {
    case "set_mode": {
      if (!MODES.includes(action.mode)) return state;
      if (state.mode === "edit" && state.dirty && action.mode !== "edit") {
        return { ...state, blocked: action.mode };
      }
      return { mode: action.mode, dirty: false, blocked: null };
    }
    case "edited":
      return state.mode === "edit" ? { ...state, dirty: true } : state;
    case "saved":
      return { ...state, dirty: false, blocked: null };
    case "discard":
      return { mode: state.blocked ?? "preview", dirty: false, blocked: null };
    default:
      return state;
  }
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
  preview:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.8 10S4.7 4.8 10 4.8 18.2 10 18.2 10 15.3 15.2 10 15.2 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.4"/></svg>',
  annotate:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.2h8M3 8h8M3 11.8h5"/><path d="M17 3.4 13 7.4l-.6 2.4 2.4-.6 4-4a1.3 1.3 0 0 0-1.8-1.8Z"/></svg>',
  edit: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M9.5 3.5H4.6A1.6 1.6 0 0 0 3 5.1v10.3A1.6 1.6 0 0 0 4.6 17h10.3a1.6 1.6 0 0 0 1.6-1.6v-4.9"/><path d="M15.1 2.9a1.7 1.7 0 0 1 2.4 2.4L11 11.8l-3.2.8.8-3.2Z"/></svg>',
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
export function createArtifactPane(host, deps) {
  const {
    dataAccess,
    slug,
    path,
    initialMode = "preview",
    previewLock = false,
    loadHistoryPane,
    loadRichEditor,
    getAttentionEntries = () => [],
    refreshAttention = () => Promise.resolve(),
    maybeOfferWiring = () => Promise.resolve(),
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
  } = deps;

  let currentArtifact = null; // {source_path, content, rendered_html, source_sha256, class, derived_from?}
  let loading = true;
  let modeState = initialModeState(previewLock ? "preview" : initialMode);
  let sourceFace = false; // Edit's face: rich (default) or byte-exact source; sticky per pane
  let richEditor = null; // {getMarkdown, isDirty, focus, destroy} while the rich face is mounted
  let richMountRequest = 0;
  let richEditorLoading = false;
  let annotations = []; // [{record, id, state, attempts?, error?}] for THIS pane's one artifact
  let composer = null; // {record, ...} while the annotation composer is open
  let annotatableFocusIndex = 0;
  let stopClassFViewer = null;
  let classFInteractive = false;
  let approvalBusy = false;
  let approvalError = "";
  let approvalResult = null;
  let toolsStatusArtifactPath = null;
  let destroyed = false;
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
  const modeBar = el("div", { className: "glosa-modebar", role: "group", "aria-label": "View mode" });

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
  const toolsStatus = el("p", { className: "glosa-tools-status", role: "status", "aria-live": "polite", hidden: true });

  const moveGroup = el("div", { className: "glosa-pane-menu-group", role: "group", "aria-label": "Move tab to" });
  if (paneCommands.length) {
    moveGroup.append(el("p", { className: "glosa-pane-menu-heading", textContent: "Move tab to" }));
    for (const command of paneCommands) {
      moveGroup.append(
        menuItem("glosa-pane-menu-move", ICONS.move, command.label, () => {
          setToolsOpen(false);
          command.run();
        }),
      );
    }
  }

  const toolsMenu = el("div", { className: "glosa-pane-menu", role: "group", "aria-label": "Artifact tools" }, [
    historyMenuItem,
    copySourceButton,
    printArtifactButton,
    compareButton,
    moveGroup,
    toolsStatus,
  ]);
  const tools = el("div", { className: "glosa-pane-tools", "data-open": "false" }, [toolsTrigger, toolsMenu]);

  // What an unfocused pane shows instead of a live mode control. Two segmented switchers on one
  // screen read as two offers when only one of them is the one ⌘1/2/3 and the keyboard address —
  // but a pane in Preview and a pane in Annotate with nothing annotated yet look identical, so
  // the state still has to be legible. A quiet label states it without offering it.
  const modeLabel = el("span", { className: "glosa-pane-mode-label" });
  const artifactBar = el("div", { className: "glosa-artifact-bar" }, [
    artifactIdEl,
    modeLabel,
    modeBar,
    historyToggle,
    tools,
  ]);

  // ---------- pane body ----------

  const approvalStrip = el("section", {
    className: "glosa-approval-strip",
    hidden: true,
    "aria-label": "Final approval",
  });
  const annotateInstructions = el("p", {
    className: "glosa-visually-hidden",
    textContent: "Use Up and Down arrow keys to move between passages. Press Enter or Space to annotate.",
    hidden: true,
  });
  annotateInstructions.id = `glosa-annotate-instructions-${Math.random().toString(36).slice(2, 9)}`;
  const contentEl = el("div", { className: "glosa-content", role: "region", "aria-label": "Artifact preview" });
  const emptyEl = el("div", { className: "glosa-empty", hidden: true, role: "status", "aria-live": "polite" });
  const skeletonEl = el("div", { className: "glosa-skeleton", hidden: true, "aria-hidden": "true" });
  for (let i = 0; i < 8; i++) skeletonEl.append(el("i"));
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true, "aria-label": "Artifact source" });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  const editStatus = el("p", { className: "glosa-edit-status", role: "status", "aria-live": "polite" });
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
    el("div", { className: "glosa-edit-actions" }, [editStatus, saveButton]),
  ]);
  const classFEl = el("div", {
    className: "glosa-classf",
    hidden: true,
    role: "region",
    "aria-label": "Artifact preview",
  });
  const marginEl = el("aside", { className: "glosa-margin", "aria-label": "Annotations" });
  const markersEl = el("div", { className: "glosa-markers", "aria-hidden": "true" });
  const historyEl = el("section", { className: "glosa-history", hidden: true, "aria-label": "Version history" });

  const paneMain = el("main", { className: "glosa-pane-main" }, [
    approvalStrip,
    annotateInstructions,
    emptyEl,
    skeletonEl,
    contentEl,
    classFEl,
    editWrap,
    marginEl,
    markersEl,
  ]);
  const paneEl = el("section", { className: "glosa-pane", "aria-label": "Artifact" }, [
    artifactBar,
    paneMain,
    historyEl,
  ]);
  paneEl.setAttribute("data-mode", modeState.mode);
  paneEl.setAttribute("data-editor-face", "rich");
  host.append(paneEl);

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
    if (toolsStatusArtifactPath !== artifactPath) {
      toolsStatusArtifactPath = artifactPath;
      setToolsStatus("");
    }
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
      queueMicrotask(() => marginEl.querySelector(".glosa-composer-input")?.focus({ preventScroll: true }));
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
      if (dirty) await saveCurrentArtifact({ onlyIfDirty: true });
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
  function canEdit(artifact) {
    return artifact?.class !== "F" || Boolean(artifact.derived_from);
  }

  function renderModeBar() {
    const restoreModeFocus = modeBar.contains(document.activeElement);
    modeBar.textContent = "";
    // Preview lock is a UI affordance expressing intent ("not for review"), not authorization —
    // Annotate/Edit controls and shortcuts are omitted for this visit; the annotation API still
    // accepts authenticated POSTs.
    const visibleModes = previewLock ? ["preview"] : MODES;
    for (const mode of visibleModes) {
      // Opaque class F gets no Edit affordance at all rather than a permanently disabled one —
      // but only once an artifact is open; before that the control stays whole.
      if (mode === "edit" && currentArtifact && !canEdit(currentArtifact)) continue;
      const btn = el("button", { type: "button", "data-mode": mode, onClick: () => setMode(mode) });
      // Icon plus label: the label is what a comfortable pane shows, the icon is what survives
      // §6's collapse ladder. The accessible name never depends on which one is painted.
      btn.innerHTML = `${MODE_ICONS[mode]}<span class="glosa-control-label"></span>`;
      btn.querySelector(".glosa-control-label").textContent = mode;
      btn.setAttribute("aria-label", mode[0].toUpperCase() + mode.slice(1));
      btn.setAttribute("aria-pressed", String(mode === modeState.mode));
      if (!currentArtifact) btn.disabled = true;
      modeBar.append(btn);
    }
    modeLabel.textContent = modeState.mode;
    if (restoreModeFocus) {
      queueMicrotask(() => modeBar.querySelector(`[data-mode="${modeState.mode}"]`)?.focus({ preventScroll: true }));
    }
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
    if (richEditorLoading) return;
    richEditorLoading = true;
    const request = ++richMountRequest;
    try {
      const mountRichEditor = await loadRichEditor();
      if (request !== richMountRequest || sourceFace || modeState.mode !== "edit" || !currentArtifact) return;
      richEditor = mountRichEditor(richEl, {
        markdown,
        onDirty: () => {
          modeState = modeReducer(modeState, { type: "edited" });
          editStatus.textContent = "";
          editStatus.removeAttribute("data-error");
          onStateChange();
        },
      });
      renderContent();
    } catch {
      if (request !== richMountRequest) return;
      richEditor = null;
      sourceFace = true;
      renderContent();
    } finally {
      if (request === richMountRequest) richEditorLoading = false;
    }
  }

  function teardownRichFace() {
    richMountRequest += 1;
    richEditorLoading = false;
    richEditor?.destroy();
    richEditor = null;
  }

  function renderFaceToggle() {
    faceRichBtn.setAttribute("aria-pressed", String(!sourceFace));
    faceSourceBtn.setAttribute("aria-pressed", String(sourceFace));
    // §8: the measure follows the face, not the mode. app.css reads this attribute.
    paneEl.setAttribute("data-editor-face", sourceFace ? "source" : "rich");
  }

  // ---------- manuscript ----------

  function updateAnnotatableBlocks() {
    for (const block of contentEl.querySelectorAll(".glosa-annotatable-block")) {
      block.classList.remove("glosa-annotatable-block");
      block.removeAttribute("tabindex");
      block.removeAttribute("aria-describedby");
    }
    annotateInstructions.hidden = true;
    contentEl.removeAttribute("aria-describedby");
    if (loading || modeState.mode !== "annotate" || !currentArtifact || currentArtifact.class === "F") return;
    annotateInstructions.hidden = false;
    contentEl.setAttribute("aria-describedby", annotateInstructions.id);
    const blocks = Array.from(contentEl.querySelectorAll(":scope > [data-line]")).filter((block) =>
      block.textContent.trim(),
    );
    const focusedIndex = blocks.indexOf(document.activeElement);
    if (focusedIndex >= 0) annotatableFocusIndex = focusedIndex;
    annotatableFocusIndex = Math.min(annotatableFocusIndex, Math.max(0, blocks.length - 1));
    for (const [index, block] of blocks.entries()) {
      block.classList.add("glosa-annotatable-block");
      block.setAttribute("tabindex", index === annotatableFocusIndex ? "0" : "-1");
    }
  }

  function renderContent() {
    paneEl.setAttribute("data-mode", modeState.mode);
    const isClassF = currentArtifact?.class === "F";
    paneEl.setAttribute("data-class", currentArtifact?.class ?? "");
    renderArtifactTools();
    const isEdit = modeState.mode === "edit" && !isClassF;
    if (isEdit && !sourceFace && !richEditor) void mountRichFace(currentArtifact?.content ?? "");
    if (!isEdit) teardownRichFace();
    const richShown = isEdit && !sourceFace && Boolean(richEditor);
    richEl.hidden = !richShown;
    editArea.hidden = !isEdit || richShown;
    editWrap.hidden = !isEdit;
    saveButton.hidden = !isEdit;
    renderFaceToggle();
    skeletonEl.hidden = !loading;
    emptyEl.hidden = Boolean(currentArtifact) || loading;
    contentEl.hidden = isEdit || isClassF || !currentArtifact || loading;
    classFEl.hidden = !isClassF;
    renderTitle();
    renderApprovalStrip();

    if (!currentArtifact) {
      updateAnnotatableBlocks();
      renderMargin();
      return;
    }
    if (isClassF) {
      updateAnnotatableBlocks();
      mountClassFArtifact();
      renderMargin();
      return;
    }
    // Leaving class F (a different artifact was opened into this pane) tears down any
    // still-mounted iframe — it must not keep running invisibly behind `classFEl.hidden`.
    if (stopClassFViewer) {
      stopClassFViewer();
      stopClassFViewer = null;
      classFEl.removeAttribute("data-path");
    }
    if (isEdit) {
      editArea.value = currentArtifact.content ?? "";
    } else {
      // First paint sets innerHTML directly (nothing to morph FROM yet); every later re-render
      // goes through morphArtifactContent instead.
      if (contentEl.getAttribute("data-path") !== currentArtifact.source_path) {
        contentEl.innerHTML = currentArtifact.rendered_html ?? "";
        contentEl.setAttribute("data-path", currentArtifact.source_path);
      }
    }
    updateAnnotatableBlocks();
    renderMargin();
  }

  /** Mounts (or re-mounts, on a path change) the class-F viewer — P4.1. A fresh capability is
   * minted on every mount, per A1 §7's "fresh mint per iframe open/reload": `force` re-mints even
   * for the SAME path, discarding the old iframe rather than trying to reuse it.
   *
   * §11: dragging a class-F pane between groups reparents the iframe element, which reloads it and
   * re-mints. That is expected, not a defect. dockview's `renderer: 'always'` keeps the element
   * alive across TAB switches, which is the common case. */
  function mountClassFArtifact(force = false) {
    if (!force && classFEl.getAttribute("data-path") === currentArtifact.source_path && stopClassFViewer) return;
    stopClassFViewer?.();
    classFEl.setAttribute("data-path", currentArtifact.source_path);
    classFEl.textContent = "";
    const interactive = modeState.mode !== "preview" || classFInteractive;
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
        if (modeState.mode !== "annotate") return;
        openComposer({ body: "", intent: "content", target });
      },
      onError: (message) => {
        status.setAttribute("data-error", "true");
        status.textContent = `This preview couldn't be opened. ${message}`;
        openInteractive.hidden = interactive;
      },
    });
  }

  // --- annotation composer: selection → composer → intent + comment → post. ONE component; CSS
  // places it in the margin at rail widths and as a bottom tray in the compact pane. ---

  function openComposer(record, { returnFocus = null } = {}) {
    composer = { record, returnFocus, draft: "", error: "", submitting: false };
    // Compact (bottom-tray) pane widths: keep the selected passage visible in the unobscured
    // upper area before the tray covers the bottom of the window.
    if (!isSideMargin()) {
      const anchorNode = window.getSelection()?.anchorNode;
      const anchorEl = anchorNode && (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement);
      anchorEl?.scrollIntoView?.({ block: "center" });
    }
    // Moving focus into the composer ends the browser's transient selection paint. Keep the
    // captured range visibly marked for the whole composition step, so the reviewer can still
    // see exactly what their feedback will attach to.
    paintComposerSelection();
    renderMargin();
    // The composer is rendered in the margin, not at the selection itself. Native focus normally
    // scrolls the nearest scroll container until that newly inserted control is visible; for a
    // long artifact this can reset the reader's viewport after they release a selection. Keep
    // keyboard focus moving into the composer, but leave the manuscript exactly where it was.
    marginEl.querySelector(".glosa-composer-input")?.focus({ preventScroll: true });
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
    // Point-of-action wiring offer (issue #81) — strictly BEFORE the POST but never a gate on
    // it: whatever the user chooses (or if wiring itself fails), the save below proceeds.
    await maybeOfferWiring();
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
      closeComposer();
      onStateChange();
    } catch (error) {
      composer.submitting = false;
      composer.error =
        error instanceof Error
          ? `Couldn't send this annotation: ${error.message}`
          : "Couldn't send this annotation. Try again.";
      renderMargin();
      queueMicrotask(() => marginEl.querySelector(".glosa-composer-input")?.focus());
    }
  }

  function buildComposer() {
    const { record } = composer;
    const form = el("form", { className: "glosa-composer", "aria-label": "New annotation" });
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
      textContent: "Send",
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
  async function removeAnnotation(item) {
    try {
      if (item.id) await dataAccess.withdrawAnnotation(slug, item.id);
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 409) {
        item.state = "waiting";
        item.error = true;
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
   * still IS the quoted text; (2) re-find the quote by its prefix+exact+suffix context; (3) exact
   * quote alone when it's unambiguous; else null — unanchored, and the card says so. */
  function rangeForTarget(target) {
    const pos = target?.position;
    const exact = target?.quote?.exact;
    if (pos && typeof pos.start === "number" && typeof pos.end === "number") {
      const range = offsetsToRange(pos.start, pos.end);
      if (range && (!exact || range.toString() === exact)) return range;
    }
    if (!exact) return null;
    const text = contentEl.textContent;
    const prefix = target.quote.prefix ?? "";
    const suffix = target.quote.suffix ?? "";
    const contextIdx = prefix || suffix ? text.indexOf(prefix + exact + suffix) : -1;
    if (contextIdx !== -1) return offsetsToRange(contextIdx + prefix.length, contextIdx + prefix.length + exact.length);
    const first = text.indexOf(exact);
    if (first !== -1 && text.indexOf(exact, first + 1) === -1) return offsetsToRange(first, first + exact.length);
    return null;
  }

  /** True when the margin is the anchor-aligned side rail rather than the in-flow block under the
   * manuscript. Keyed on THIS PANE's inline size (§7), never the viewport: a pane changes width
   * when a sash moves and the window does not. */
  function isSideMargin() {
    return modeState.mode === "annotate" && paneWidth >= MARGIN_RAIL_FLOOR;
  }

  /** Aligns each margin card (and the open composer) beside its anchor: anchor rect → offset in
   * the shared scroll space → absolute top, collision-stacked downward so cards never overlap.
   * No-op in compact, where CSS lays the margin out in flow. */
  function layoutMargin() {
    const side = isSideMargin();
    marginEl.classList.toggle("glosa-margin-side", side);
    const positioned = [...marginEl.querySelectorAll(".glosa-annotation, .glosa-composer")];
    if (!side) {
      for (const cardEl of positioned) cardEl.style.top = "";
      return;
    }
    const mainTop = paneMain.getBoundingClientRect().top;
    let prevBottom = 0;
    for (const cardEl of positioned) {
      const item = cardEl._glosaItem;
      const range = item ? rangeForTarget(item.record?.target ?? item.target) : null;
      const anchorTop = range ? range.getBoundingClientRect().top - mainTop + paneMain.scrollTop : prevBottom + 8;
      const top = Math.max(anchorTop, prevBottom + (prevBottom ? 8 : 0));
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
    for (const item of annotations) {
      const range = rangeForTarget(item.record?.target);
      if (!range) continue;
      const top = range.getBoundingClientRect().top - mainTop + paneMain.scrollTop;
      const dot = el("button", {
        className: "glosa-marker",
        type: "button",
        "aria-label": "Go to annotation",
        onClick: () => {
          // Outside Annotate there is no card to jump to yet, so the dot's job is to get the
          // reader to one: it opens the mode that has them, then reveals its own.
          if (modeState.mode !== "annotate") setMode("annotate");
          const reveal = () => {
            const cardEl = [...marginEl.querySelectorAll(".glosa-annotation")].find((c) => c._glosaItem === item);
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

  const highlightsAvailable = () => typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  // CSS.highlights is a document-global registry, so panes cannot each own a key called
  // "glosa-anchors" — the last writer would erase every other pane's underlines. Each pane gets
  // its own suffix and only ever writes its own three keys.
  const highlightId = `${Math.random().toString(36).slice(2, 9)}`;
  const HL_ANCHORS = `glosa-anchors-${highlightId}`;
  const HL_ANCHOR = `glosa-anchor-${highlightId}`;
  const HL_COMPOSER = `glosa-composer-selection-${highlightId}`;

  /** The open composer owns a temporary, persistent selection wash. It deliberately lives in a
   * separate highlight from saved annotation underlines, so closing/sending a draft cannot erase
   * the durable annotation state. */
  function paintComposerSelection() {
    if (!highlightsAvailable()) return;
    const range = composer ? rangeForTarget(composer.record?.target) : null;
    if (range) CSS.highlights.set(HL_COMPOSER, new Highlight(range));
    else CSS.highlights.delete(HL_COMPOSER);
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
    if (!highlightsAvailable()) return;
    if (anchoredRanges.length) CSS.highlights.set(HL_ANCHORS, new Highlight(...anchoredRanges.map((a) => a.range)));
    else CSS.highlights.delete(HL_ANCHORS);
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
    if (highlightsAvailable()) {
      if (item) {
        const hit = anchoredRanges.find((a) => a.item === item);
        if (hit) CSS.highlights.set(HL_ANCHOR, new Highlight(hit.range));
      } else {
        CSS.highlights.delete(HL_ANCHOR);
      }
    }
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

  /** Hover/focus on a card washes its own anchor fully — the thread from margin back to text. */
  function connectAnchorHighlight(cardEl, item) {
    if (!highlightsAvailable()) return;
    const on = () => {
      const range = rangeForTarget(item.record?.target ?? item.target);
      if (range) CSS.highlights.set(HL_ANCHOR, new Highlight(range));
    };
    const off = () => CSS.highlights.delete(HL_ANCHOR);
    cardEl.addEventListener("mouseenter", on);
    cardEl.addEventListener("mouseleave", off);
    cardEl.addEventListener("focusin", on);
    cardEl.addEventListener("focusout", off);
  }

  function renderMargin() {
    marginEl.textContent = "";
    if (modeState.mode !== "annotate" || !currentArtifact) {
      if (composer) composer = null;
      paintComposerSelection();
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
    marginEl.append(el("p", { className: "glosa-margin-title", textContent: "Annotations" }));
    if (composer) {
      const form = buildComposer();
      form._glosaItem = composer.record ? { record: composer.record } : null;
      marginEl.append(form);
    }
    for (const item of annotations) {
      const { record, state } = item;
      const intentLabel = INTENTS.find((i) => i.value === record.intent)?.label ?? record.intent;
      // Honest anchoring: if the quoted passage no longer exists in the current text (edited
      // away, rewritten), the card says "Lost its place" and keeps the original quote — it never
      // underlines different words (client echo of A5 §F10; the daemon's resolver is the
      // authority at delivery time).
      const anchored = Boolean(rangeForTarget(record.target));
      const card = el("div", { className: "glosa-annotation", "data-state": state, "data-anchored": String(anchored) });
      if (record.target?.quote?.exact) {
        card.append(
          el("p", { className: "glosa-annotation-quote" }, [el("span", { textContent: record.target.quote.exact })]),
        );
      }
      if (!anchored) {
        card.append(
          el("p", {
            className: "glosa-annotation-lost",
            textContent: "Lost its place — the passage changed since this was written.",
          }),
        );
      }
      card.append(
        el("p", { className: "glosa-annotation-body", textContent: record.body }),
        el("p", { className: "glosa-annotation-state" }, [
          el("span", { className: "glosa-state-dot", "aria-hidden": "true" }),
          el("span", {
            role: "status",
            "aria-live": "polite",
            textContent: item.error
              ? "Couldn't remove — try again"
              : (STATE_LABELS[state] ?? state) + (item.attempts > 1 ? ` · nudged ×${item.attempts}` : ""),
          }),
          el("span", { className: "glosa-annotation-intent", textContent: intentLabel }),
          el("button", {
            className: "glosa-annotation-remove",
            type: "button",
            textContent: "Remove",
            "aria-label": "Remove this annotation",
            onClick: () => void removeAnnotation(item),
          }),
        ]),
      );
      card._glosaItem = item;
      connectAnchorHighlight(card, item);
      marginEl.append(card);
    }
    if (!composer && annotations.length === 0) {
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
  function paintAnnotationMarks() {
    paintAnchorUnderlines();
    renderMarkers();
  }

  function setMode(mode) {
    if (previewLock && mode !== "preview") return;
    // Class-F Edit follows the derived-from edge (R6/R7) rather than switching THIS artifact into
    // edit mode: with an edge, open the source (class-R) artifact and edit that; with none, Edit
    // is absent from the mode control entirely — a programmatic call is a no-op.
    if (mode === "edit" && currentArtifact?.class === "F") {
      if (currentArtifact.derived_from) void openArtifactInThisPane(currentArtifact.derived_from);
      return;
    }

    const previousMode = modeState.mode;
    const next = modeReducer(modeState, { type: "set_mode", mode });
    if (next.blocked) {
      // The dialog is async; park the blocked state and settle when the user answers.
      void confirmDialog({
        title: "Discard unsaved edits?",
        body: "This artifact has changes that haven't been saved. Leaving Edit now throws them away.",
        confirmLabel: "Discard edits",
        danger: true,
      }).then((discard) => {
        modeState = discard ? modeReducer(next, { type: "discard" }) : { ...next, mode: "edit", blocked: null };
        renderModeBar();
        renderContent();
        onStateChange();
        queueMicrotask(() => modeBar.querySelector(`[data-mode="${modeState.mode}"]`)?.focus({ preventScroll: true }));
      });
      return;
    }
    modeState = next;
    if (modeState.mode !== "preview") classFInteractive = true;
    // §7's rail needs about 1200px, and an evenly split pane never has it on any display anyone
    // owns. So Annotate takes the room it needs from its siblings rather than silently degrading
    // to the tray — the focus is expressed as WIDTH, not as depth: nothing floats, nothing covers
    // the other document, and the arrangement comes back when Annotate is left.
    if (modeState.mode === "annotate" && previousMode !== "annotate") claimWidth(MARGIN_RAIL_COMFORT);
    else if (previousMode === "annotate" && modeState.mode !== "annotate") releaseWidth();
    renderModeBar();
    renderContent();
    void renderHistory();
    onStateChange();
    if (modeState.mode === "edit" && previousMode !== "edit") paneMain.scrollTop = 0;
  }

  editArea.addEventListener("input", () => {
    modeState = modeReducer(modeState, { type: "edited" });
    editStatus.textContent = "";
    editStatus.removeAttribute("data-error");
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
    const carried =
      richEditor && (richEditor.isDirty() || modeState.dirty)
        ? richEditor.getMarkdown()
        : (currentArtifact?.content ?? "");
    teardownRichFace();
    sourceFace = true;
    renderContent();
    editArea.value = carried; // after renderContent, so the artifact snapshot doesn't clobber it
  });

  faceRichBtn.addEventListener("click", () => {
    if (!sourceFace || modeState.mode !== "edit") {
      sourceFace = false;
      renderContent();
      return;
    }
    const carried = editArea.value;
    sourceFace = false;
    teardownRichFace();
    renderFaceToggle();
    void mountRichFace(carried);
  });

  function currentEditorContent() {
    if (!currentArtifact) return "";
    return !sourceFace && richEditor
      ? richEditor.isDirty() || modeState.dirty
        ? richEditor.getMarkdown()
        : (currentArtifact.content ?? "")
      : editArea.value;
  }

  async function saveCurrentArtifact({ onlyIfDirty = false } = {}) {
    if (!slug || !currentArtifact || currentArtifact.class !== "R") return currentArtifact;
    const dirty = modeState.dirty || Boolean(richEditor?.isDirty());
    if (onlyIfDirty && !dirty) return currentArtifact;
    saveButton.disabled = true;
    editStatus.removeAttribute("data-error");
    editStatus.textContent = "Saving…";
    try {
      // The rich face serializes ONLY when the document changed (its own edits, or source-face
      // edits carried in via `modeState.dirty`); a clean editor saves the artifact's exact bytes.
      const content = currentEditorContent();
      const saved = await dataAccess.putArtifact(slug, currentArtifact.source_path, content, {
        ifMatch: currentArtifact.source_sha256,
      });
      currentArtifact = { ...currentArtifact, content, ...saved };
      modeState = modeReducer(modeState, { type: "saved" });
      // Re-render (fetch ?render=html) rather than trust `saved.rendered_html` blindly.
      const fresh = await dataAccess.getArtifact(slug, currentArtifact.source_path, { render: "html" });
      currentArtifact = fresh;
      contentEl.removeAttribute("data-path"); // force the next renderContent to repaint from scratch
      teardownRichFace(); // remount the rich face from the freshly saved content
      editStatus.textContent = "Saved.";
      renderModeBar();
      renderContent();
      onStateChange();
      void refreshHistory?.();
      return currentArtifact;
    } catch (error) {
      editStatus.setAttribute("data-error", "true");
      editStatus.textContent =
        error instanceof Error
          ? `Couldn't save this artifact: ${error.message}`
          : "Couldn't save this artifact. Try again.";
      throw error;
    } finally {
      saveButton.disabled = false;
    }
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
    if (modeState.mode !== "annotate" || !slug || !currentArtifact) return;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (!record) return;
    let returnFocus =
      selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    while (returnFocus?.parentElement && returnFocus.parentElement !== contentEl)
      returnFocus = returnFocus.parentElement;
    openComposer(record, { returnFocus: returnFocus instanceof HTMLElement ? returnFocus : contentEl });
  });

  // Keyboard-equivalent annotation path: in Annotate mode each top-level rendered block is a
  // focus target. Enter/Space selects that block and opens the exact same composer as a pointer
  // selection, so annotation composition never depends on drag-selection alone.
  contentEl.addEventListener("keydown", (event) => {
    const block = event.target;
    if (!(block instanceof HTMLElement) || !block.classList.contains("glosa-annotatable-block")) return;
    if (modeState.mode !== "annotate") return;
    const blocks = Array.from(contentEl.querySelectorAll(".glosa-annotatable-block"));
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const current = Math.max(0, blocks.indexOf(block));
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? blocks.length - 1
            : Math.min(blocks.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
      annotatableFocusIndex = next;
      for (const [index, candidate] of blocks.entries())
        candidate.setAttribute("tabindex", index === next ? "0" : "-1");
      blocks[next]?.focus();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
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
    if (!(block instanceof HTMLElement) || !block.classList.contains("glosa-annotatable-block")) return;
    const blocks = Array.from(contentEl.querySelectorAll(".glosa-annotatable-block"));
    annotatableFocusIndex = Math.max(0, blocks.indexOf(block));
    for (const [index, candidate] of blocks.entries())
      candidate.setAttribute("tabindex", index === annotatableFocusIndex ? "0" : "-1");
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
          paneWidth = width;
          layoutMargin();
          paintAnnotationMarks();
        });
  observer?.observe(paneEl);
  paneWidth = paneEl.clientWidth;

  // ---------- artifact loading ----------

  async function loadArtifact(artifactPath) {
    loading = true;
    classFInteractive = false;
    composer = null;
    annotations = [];
    approvalResult = null;
    approvalError = "";
    teardownRichFace();
    renderContent();
    try {
      currentArtifact = await dataAccess.getArtifact(slug, artifactPath, { render: "html" });
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
    contentEl.removeAttribute("data-path");
    renderModeBar();
    renderContent();
    void renderHistory();
    onStateChange();
    return true;
  }

  async function refreshArtifact() {
    if (!currentArtifact) return;
    const fresh = await dataAccess.getArtifact(slug, currentArtifact.source_path, { render: "html" });
    currentArtifact = fresh;
    if (fresh.class === "F") {
      // A1 §7: "fresh mint per iframe open/reload" — an SSE-driven re-render discards the old
      // iframe and mints a brand new capability rather than trying to reuse the expiring one.
      mountClassFArtifact(true);
      return;
    }
    if (modeState.mode !== "edit") {
      morphArtifactContent(contentEl, fresh.rendered_html ?? "");
      // Stamp ONLY after actually morphing — stamping while Edit skips the morph would make the
      // next renderContent believe the stale DOM is current and never repaint it.
      contentEl.setAttribute("data-path", currentArtifact.source_path);
    } else {
      contentEl.removeAttribute("data-path"); // repaint from fresh rendered_html when Edit closes
    }
    layoutMargin(); // anchors may have moved with the new content
    paintAnnotationMarks();
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
    return modeState.dirty || Boolean(richEditor?.isDirty());
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
      paneWidth = paneEl.clientWidth;
      layoutMargin();
      renderMarkers();
    },
    async confirmClose() {
      if (!isDirty()) return true;
      const discard = await confirmDialog({
        title: "Discard unsaved edits?",
        body: "This artifact has changes that haven't been saved. Closing this tab throws them away.",
        confirmLabel: "Discard edits",
        danger: true,
      });
      return discard;
    },
    destroy() {
      destroyed = true;
      if (modeState.mode === "annotate") releaseWidth();
      document.removeEventListener("click", onDocumentClick);
      observer?.disconnect();
      teardownRichFace();
      stopClassFViewer?.();
      if (highlightsAvailable()) {
        CSS.highlights.delete(HL_ANCHORS);
        CSS.highlights.delete(HL_ANCHOR);
        CSS.highlights.delete(HL_COMPOSER);
      }
      paneEl.remove();
    },
  };
}
