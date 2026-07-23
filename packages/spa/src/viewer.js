// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the class-R viewer (R6): renders the daemon's server-rendered markdown
// (`data-line`-stamped HTML), the Preview/Annotate/Edit mode toggle, the annotation-record flow
// (annotate.js builds the record, this module posts it), and the SSE-driven idiomorph morph that
// keeps the rendered view live. Talks to the daemon ONLY through data-access.js (R6's ONE
// data-access module) — never `fetch` directly (see test/import-boundary.test.ts, which checks
// this structurally across this file and annotate.js).
//
// Visual system: app.css (design brief docs/design/2026-07-21-workspace-review-surface-brief.md).
// Topology: top bar (title, mode control, panel toggles) / navigator / manuscript / contextual
// margin. The margin holds the annotation composer at full width; below 1024px the same composer
// node becomes a fixed bottom tray purely via CSS — this module renders ONE composer either way.
import { createDataAccess } from "./data-access.js";
import { buildAnnotationRecordFromSelection } from "./annotate.js";
import { Idiomorph } from "./vendor/idiomorph.js";
import { mountClassFViewer } from "./classf-viewer.js";
import { confirmDialog } from "./dialog.js";
import { createArtifactTreeNavigator } from "./artifact-tree.js";
import { mountAppearanceControl } from "./appearance.js";
import { mountAttentionTray } from "./attention-tray.js";

let historyPaneLoader;
let conversationPaneLoader;
let richEditorLoader;

function loadHistoryPane() {
  historyPaneLoader ??= import("./history.js").then((module) => module.mountHistoryPane);
  return historyPaneLoader;
}

function loadConversationPane() {
  conversationPaneLoader ??= import("./conversation.js").then((module) => module.mountConversationPane);
  return conversationPaneLoader;
}

function loadRichEditor() {
  richEditorLoader ??= import("./rich-editor.js").then((module) => module.mountRichEditor);
  return richEditorLoader;
}

export const MODES = ["preview", "annotate", "edit"];

// Writer-register labels for R3's annotation `intent` enum (brief §7.5): the wire value is the
// enum, the label is what the reviewer reads. Order = the enum's declaration order in R3.
export const INTENTS = [
  { value: "content", label: "Change the words" },
  { value: "classification", label: "Wrong label or split" },
  { value: "style", label: "Fix how it looks" },
];

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
 * SSE-driven update or this viewer's own post-save re-render — goes through. */
export function morphArtifactContent(container, newHtml) {
  Idiomorph.morph(container, newHtml, { morphStyle: "innerHTML" });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onInput") node.addEventListener("input", value);
    else if (key === "className") node.className = value;
    else if (key.startsWith("data-") || key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

/** Splits an artifact path into {dir, name} for the top-bar title — the filename leads, the
 * directory is quiet mono metadata beside it (brief §7.1). */
function splitPath(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { dir: "", name: path } : { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Mounts the whole ready-state app (top bar + navigator + the class-R viewer) into `root`.
 * `dataAccess` defaults to a real `createDataAccess()` — a test passes a fake one so nothing here
 * ever needs a real daemon. Returns an `unmount()` that tears down the SSE subscription —
 * bootstrap.js doesn't call it today (the SPA never remounts within one page load), but a test
 * does, so a leaked stream connection never outlives one test case.
 */
export function mountApp(root, {
  dataAccess = createDataAccess(),
  initialSlug,
  initialArtifact,
  surface = "workspace",
  initialMode = "preview",
  previewLock = false,
  appearance,
  onFocusChange,
} = {}) {
  root.textContent = "";
  root.classList.add("glosa-app");
  root.setAttribute("data-mode", MODES.includes(initialMode) ? initialMode : "preview");
  root.setAttribute("data-surface", surface === "document" ? "document" : "workspace");
  if (previewLock) root.setAttribute("data-preview-lock", "true");

  // --- top bar ---
  const navToggle = el("button", {
    className: "glosa-nav-toggle",
    type: "button",
    "aria-label": "Show artifacts",
    "aria-expanded": "false",
    "aria-controls": "glosa-sidebar",
  });
  // Static trusted markup (no artifact-derived content ever goes through innerHTML here).
  navToggle.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11m-11 3.5h11m-11 3.5h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const brandMark = el("span", { className: "glosa-brand-mark", role: "img", "aria-label": "glosa" });
  // Same geometry as glosa-mark.svg. Inline here so both forms follow explicit app themes,
  // including a persisted theme that differs from the operating-system preference.
  brandMark.innerHTML =
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="glosa-logo-ink" fill-rule="evenodd" d="M14 4C8.48 4 4 8.48 4 14s4.48 10 10 10c2.1 0 4.05-.65 5.65-1.75v-5.1A5.76 5.76 0 0 1 14 19.75 5.75 5.75 0 1 1 19.65 13V5.75A9.93 9.93 0 0 0 14 4Z"/><path class="glosa-logo-accent" d="M19.5 4H24v18.35C24 27.3 20.9 30 15.5 30H11v-4h4.5c2.75 0 4-1.16 4-3.72V4Z"/></svg>';
  const artifactNameEl = el("span", { className: "glosa-artifact-name", textContent: "glosa" });
  const artifactDirEl = el("span", { className: "glosa-artifact-dir" });
  const modeBar = el("div", { className: "glosa-modebar", role: "group", "aria-label": "View mode" });
  const historyToggle = el("button", {
    id: "glosa-history-toggle",
    className: "glosa-history-toggle",
    type: "button",
    textContent: "History",
    "aria-expanded": "false",
    "aria-controls": "glosa-history",
  });
  const conversationToggle = el("button", {
    id: "glosa-conversation-toggle",
    className: "glosa-conversation-toggle",
    type: "button",
    textContent: "Conversation",
    "aria-expanded": "false",
    "aria-controls": "glosa-conversation",
  });
  historyToggle.setAttribute("aria-label", "History");
  historyToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5V2.8M3.5 5.5h2.7M3.7 5.3A7 7 0 1 1 3 12M10 6.2V10l2.7 1.7"/></svg><span>History</span>';
  conversationToggle.setAttribute("aria-label", "Conversation");
  conversationToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v9H8l-4.5 3v-3H3v-9Z"/></svg><span>Conversation</span>';
  const topbarOverlays = el("div", { className: "glosa-topbar-overlays" });
  const appearanceHost = el("div", { className: "glosa-appearance" });
  const attentionHost = el("div", { className: "glosa-attention" });
  const attentionTray = mountAttentionTray(attentionHost, { dataAccess, overlayHost: topbarOverlays });
  const toolsTrigger = el("button", {
    className: "glosa-tools-trigger",
    type: "button",
    title: "More tools",
    "aria-label": "More tools",
    "aria-expanded": "false",
    "aria-controls": "glosa-tools-menu",
  });
  toolsTrigger.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg>';
  const stopAppearance = appearance
    ? mountAppearanceControl(appearanceHost, appearance, { overlayHost: topbarOverlays, returnFocus: toolsTrigger })
    : null;
  const toolsMenu = el("div", {
    id: "glosa-tools-menu",
    className: "glosa-tools-menu",
    role: "group",
    "aria-label": "Workspace tools",
  }, [attentionHost, historyToggle, conversationToggle, appearanceHost]);
  const tools = el("div", { className: "glosa-tools", "data-open": "false" }, [toolsTrigger, toolsMenu]);
  const toolControls = () => [
    attentionHost.querySelector(".glosa-attention-trigger"),
    historyToggle,
    conversationToggle,
    appearanceHost.querySelector(".glosa-appearance-trigger"),
  ].filter((control) => control && !control.disabled);

  function setToolsOpen(open, { restoreFocus = false } = {}) {
    tools.setAttribute("data-open", String(open));
    toolsTrigger.setAttribute("aria-expanded", String(open));
    if (open) {
      queueMicrotask(() => toolControls()[0]?.focus({ preventScroll: true }));
    } else if (restoreFocus) {
      queueMicrotask(() => toolsTrigger.focus({ preventScroll: true }));
    }
  }

  toolsTrigger.addEventListener("click", () => {
    setToolsOpen(tools.getAttribute("data-open") !== "true", { restoreFocus: true });
  });
  toolsMenu.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".glosa-history-toggle, .glosa-conversation-toggle")) {
      setToolsOpen(false, { restoreFocus: true });
    }
  });
  toolsMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setToolsOpen(false, { restoreFocus: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = toolControls();
    if (controls.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, controls.indexOf(document.activeElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next].focus();
  });

  const onDocumentClick = (event) => {
    if (tools.getAttribute("data-open") !== "true") return;
    if (event.target instanceof Node && (tools.contains(event.target) || topbarOverlays.contains(event.target))) return;
    setToolsOpen(false);
  };
  document.addEventListener("click", onDocumentClick);

  // --- navigator ---
  const sidebarList = el("ul", { className: "glosa-workspace-list" });
  const artifactList = el("ul", { className: "glosa-artifact-list" });
  let artifactNavigator = null;
  const expandArtifacts = el("button", {
    className: "glosa-tree-tool",
    type: "button",
    title: "Expand all folders",
    "aria-label": "Expand all folders",
    innerHTML:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>',
    onClick: () => artifactNavigator?.expandAll(),
  });
  const collapseArtifacts = el("button", {
    className: "glosa-tree-tool",
    type: "button",
    title: "Collapse all folders",
    "aria-label": "Collapse all folders",
    innerHTML:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 20 5-5 5 5M7 4l5 5 5-5"/></svg>',
    onClick: () => artifactNavigator?.collapseAll(),
  });
  const artifactHeading = el("div", { className: "glosa-sidebar-heading" }, [
    el("h2", { textContent: "Artifacts" }),
    el("div", { className: "glosa-tree-tools", role: "group", "aria-label": "Artifact tree" }, [
      expandArtifacts,
      collapseArtifacts,
    ]),
  ]);
  const artifactListEmpty = el("p", {
    className: "glosa-sidebar-empty",
    textContent: "Markdown, HTML, and text files in this workspace appear here.",
    hidden: true,
  });
  const backdrop = el("div", { className: "glosa-backdrop" });

  // --- manuscript column ---
  const contentEl = el("div", { className: "glosa-content", role: "region", "aria-label": "Artifact preview" });
  const emptyEl = el("div", { className: "glosa-empty", hidden: true, role: "status", "aria-live": "polite" });
  const skeletonEl = el("div", { className: "glosa-skeleton", hidden: true, "aria-hidden": "true" });
  for (let i = 0; i < 8; i++) skeletonEl.append(el("i"));
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true, "aria-label": "Artifact source" });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  const editStatus = el("p", { className: "glosa-edit-status", role: "status", "aria-live": "polite" });
  // Edit's two faces (rich is the default; Source is the byte-exact fallback and the code view).
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
  const classFEl = el("div", { className: "glosa-classf", hidden: true, role: "region", "aria-label": "Artifact preview" });
  const historyEl = el("section", {
    id: "glosa-history",
    className: "glosa-history",
    hidden: true,
    "aria-labelledby": "glosa-history-toggle",
  });
  const conversationEl = el("section", {
    id: "glosa-conversation",
    className: "glosa-conversation",
    hidden: true,
    "aria-labelledby": "glosa-conversation-toggle",
  });

  // --- contextual margin (annotation cards + the ONE composer) ---
  const marginEl = el("aside", { className: "glosa-margin", "aria-label": "Annotations" });
  // Compact gutter: one dot per annotation at its anchor's height; tapping jumps to the card
  // (which flows below the manuscript at narrow widths).
  const markersEl = el("div", { className: "glosa-markers", "aria-hidden": "true" });

  // The margin lives INSIDE the manuscript's scroll container (not a sibling column): cards are
  // absolutely positioned at their anchors' document offsets, so they scroll glued to the text.
  // Thin connection banner (hidden while healthy): honest words, no spinner theater.
  const bannerEl = el("div", { className: "glosa-banner", hidden: true, role: "status", textContent: "Reconnecting…" });
  const annotateInstructions = el("p", {
    id: "glosa-annotate-instructions",
    className: "glosa-visually-hidden",
    textContent: "Use Up and Down arrow keys to move between passages. Press Enter or Space to annotate.",
    hidden: true,
  });

  const mainEl = el("main", { className: "glosa-main" }, [
    bannerEl,
    annotateInstructions,
    emptyEl,
    skeletonEl,
    contentEl,
    classFEl,
    editWrap,
    marginEl,
    markersEl,
  ]);
  const sidebarEl = el("nav", {
    id: "glosa-sidebar",
    className: "glosa-sidebar",
    "aria-label": "Workspace navigation",
  }, [
    el("h2", { textContent: "Workspaces" }),
    sidebarList,
    artifactHeading,
    artifactList,
    artifactListEmpty,
  ]);

  root.append(
    el("header", { className: "glosa-topbar" }, [
      navToggle,
      brandMark,
      el("div", { className: "glosa-topbar-title" }, [artifactNameEl, artifactDirEl]),
      modeBar,
      el("div", { className: "glosa-topbar-actions" }, [tools]),
      topbarOverlays,
    ]),
    sidebarEl,
    backdrop,
    mainEl,
    historyEl,
    conversationEl,
  );

  if (surface === "document") {
    // Document surface: no navigator toggle, workspace switcher, sidebar, or artifact tree.
    navToggle.hidden = true;
    sidebarEl.hidden = true;
    backdrop.hidden = true;
    root.setAttribute("data-nav-open", "false");
  }

  artifactNavigator = createArtifactTreeNavigator(artifactList, {
    onOpen: (path) => void openArtifact(path),
  });

  let modeState = initialModeState(previewLock ? "preview" : initialMode);
  // NOT pre-seeded from initialSlug: selection is an act (selectWorkspace), not a default —
  // pre-seeding made refreshWorkspaces' "already selected" guard skip the deep-link entirely.
  let currentSlug = null;
  let currentArtifact = null; // {path, content, rendered_html, source_sha256, class, derived_from?}
  let loading = false;
  let sourceFace = false; // Edit's face: rich (default) or byte-exact source; sticky per session
  let richEditor = null; // {getMarkdown, isDirty, focus, destroy} while the rich face is mounted
  let richMountRequest = 0;
  let richEditorLoading = false;
  const annotationsByPath = new Map(); // per-session [{record, state}] (no GET-annotations route yet)
  let composer = null; // {record} while the annotation composer is open
  let annotatableFocusIndex = 0;
  let stopStream = null;
  let stopClassFViewer = null; // unmount() for the currently mounted class-F iframe, if any

  const compactNav = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches;
  const compactComposer = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 1279px)").matches;

  function focusPreview() {
    const target = (!emptyEl.hidden ? emptyEl.querySelector(".glosa-empty-title, p") : null)
      ?? contentEl.querySelector("h1, h2, h3, p")
      ?? contentEl;
    if (!(target instanceof HTMLElement)) return;
    const temporaryTabIndex = !target.hasAttribute("tabindex");
    if (temporaryTabIndex) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    if (temporaryTabIndex) {
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
  }

  function setNavOpen(open, { restoreFocus = false, focusDrawer = false } = {}) {
    root.setAttribute("data-nav-open", String(open));
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Hide artifacts" : "Show artifacts");
    syncNavInteractivity();
    if (open && focusDrawer && compactNav()) {
      queueMicrotask(() => {
        const target = artifactList.querySelector('[role="treeitem"][aria-current="page"]')
          ?? artifactList.querySelector('[role="treeitem"][tabindex="0"]')
          ?? sidebarList.querySelector('button[aria-current="true"]')
          ?? sidebarList.querySelector("button");
        target?.focus();
      });
    } else if (!open && restoreFocus) {
      queueMicrotask(() => navToggle.focus({ preventScroll: true }));
    }
  }

  function syncNavInteractivity() {
    const hiddenDrawer = compactNav() && root.getAttribute("data-nav-open") !== "true";
    sidebarEl.inert = hiddenDrawer;
    if (hiddenDrawer) sidebarEl.setAttribute("aria-hidden", "true");
    else sidebarEl.removeAttribute("aria-hidden");
  }

  syncNavInteractivity();
  navToggle.addEventListener("click", () => setNavOpen(root.getAttribute("data-nav-open") !== "true", { focusDrawer: true }));
  backdrop.addEventListener("click", () => setNavOpen(false, { restoreFocus: true }));

  // R6/A5 §F11: class-F Edit follows the generic derived-from edge — enabled only when the
  // artifact metadata carries a `derived_from` path (supplied by a content adapter, P6.1; the
  // core itself never invents one). With no edge, class F is opaque: Preview + Annotate only.
  function canEdit(artifact) {
    return !artifact || artifact.class !== "F" || Boolean(artifact.derived_from);
  }

  function renderModeBar() {
    const restoreModeFocus = modeBar.contains(document.activeElement);
    modeBar.textContent = "";
    // Preview lock is a UI affordance expressing intent ("not for review"), not authorization —
    // Annotate/Edit controls and shortcuts are omitted for this visit; the annotation API still
    // accepts authenticated POSTs.
    const visibleModes = previewLock ? ["preview"] : MODES;
    for (const mode of visibleModes) {
      // Opaque class F gets no Edit affordance at all rather than a permanently disabled one
      // (brief §7.4) — but only once an artifact is open; before that the control stays whole.
      if (mode === "edit" && currentArtifact && !canEdit(currentArtifact)) continue;
      const btn = el("button", {
        type: "button",
        textContent: mode,
        "data-mode": mode,
        onClick: () => setMode(mode),
      });
      btn.setAttribute("aria-pressed", String(mode === modeState.mode));
      if (!currentArtifact) btn.disabled = true;
      modeBar.append(btn);
    }
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
    if (!currentArtifact) {
      artifactNameEl.textContent = "glosa";
      artifactDirEl.textContent = "";
      return;
    }
    const { dir, name } = splitPath(currentArtifact.source_path);
    artifactNameEl.textContent = name;
    artifactDirEl.textContent = dir;
  }

  /** Mounts the rich face over `markdown`. A DOM that can't host a ProseMirror view (or any
   * other mount failure) falls back to the source textarea rather than a broken editor. */
  async function mountRichFace(markdown) {
    if (richEditorLoading) return;
    richEditorLoading = true;
    const request = ++richMountRequest;
    try {
      const mountRichEditor = await loadRichEditor();
      if (
        request !== richMountRequest
        || sourceFace
        || modeState.mode !== "edit"
        || !currentArtifact
      ) return;
      richEditor = mountRichEditor(richEl, {
        markdown,
        onDirty: () => {
          modeState = modeReducer(modeState, { type: "edited" });
          editStatus.textContent = "";
          editStatus.removeAttribute("data-error");
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
  }

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
    const blocks = Array.from(contentEl.querySelectorAll(":scope > [data-line]"))
      .filter((block) => block.textContent.trim());
    const focusedIndex = blocks.indexOf(document.activeElement);
    if (focusedIndex >= 0) annotatableFocusIndex = focusedIndex;
    annotatableFocusIndex = Math.min(annotatableFocusIndex, Math.max(0, blocks.length - 1));
    for (const [index, block] of blocks.entries()) {
      block.classList.add("glosa-annotatable-block");
      block.setAttribute("tabindex", index === annotatableFocusIndex ? "0" : "-1");
    }
  }

  function renderContent() {
    root.setAttribute("data-mode", modeState.mode);
    const isClassF = currentArtifact?.class === "F";
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

    if (!currentArtifact) {
      updateAnnotatableBlocks();
      if (!loading && !emptyEl.childElementCount) {
        setEmpty(
          "Choose an artifact to review.",
          el("p", {
            className: "glosa-empty-hint",
            textContent: "Its rendered manuscript opens here — switch to Annotate and select any passage to comment on it.",
          }),
        );
      }
      renderMargin();
      return;
    }
    if (isClassF) {
      updateAnnotatableBlocks();
      mountClassFArtifact();
      renderMargin();
      return;
    }
    // Leaving class F (a different artifact was opened) tears down any still-mounted iframe — it
    // must not keep running invisibly behind `classFEl.hidden`.
    if (stopClassFViewer) {
      stopClassFViewer();
      stopClassFViewer = null;
      classFEl.removeAttribute("data-path");
    }
    if (isEdit) {
      editArea.value = currentArtifact.content ?? "";
    } else {
      // First paint sets innerHTML directly (nothing to morph FROM yet); every later re-render
      // goes through morphArtifactContent instead (see refreshCurrentArtifact/onEvent below).
      if (contentEl.getAttribute("data-path") !== currentArtifact.source_path) {
        contentEl.innerHTML = currentArtifact.rendered_html ?? "";
        contentEl.setAttribute("data-path", currentArtifact.source_path);
      }
    }
    updateAnnotatableBlocks();
    renderMargin();
  }

  /** Mounts (or re-mounts, on a path change) the class-F viewer — P4.1. A fresh capability is
   * minted on every mount, per A1 §7's "fresh mint per iframe open/reload": `force` (used by
   * refreshCurrentArtifact when SSE reports the source changed) re-mints even for the SAME path,
   * discarding the old iframe rather than trying to reuse it. */
  function mountClassFArtifact(force = false) {
    if (!force && classFEl.getAttribute("data-path") === currentArtifact.source_path && stopClassFViewer) return;
    stopClassFViewer?.();
    classFEl.setAttribute("role", "region");
    classFEl.setAttribute("aria-label", "Artifact preview");
    classFEl.setAttribute("data-path", currentArtifact.source_path);
    stopClassFViewer = mountClassFViewer(classFEl, {
      dataAccess,
      slug: currentSlug,
      artifactPath: currentArtifact.source_path,
      onSelection: (target) => {
        if (modeState.mode !== "annotate") return;
        openComposer({ body: "", intent: "content", target });
      },
      onError: (message) => {
        classFEl.setAttribute("role", "alert");
        classFEl.removeAttribute("aria-label");
        classFEl.textContent = `This preview couldn't be opened. ${message}`;
      },
    });
  }

  // --- annotation composer (brief §7.3/§9): selection → composer → intent + comment → post.
  // ONE component; CSS places it in the margin at full width and as a bottom tray in compact. ---

  function openComposer(record, { returnFocus = null } = {}) {
    composer = { record, returnFocus, draft: "", error: "", submitting: false };
    // Compact (bottom-tray) widths: keep the selected passage visible in the unobscured upper
    // area before the tray covers the bottom of the window (brief §7.3).
    if (compactComposer()) {
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
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    });
  }

  async function submitComposer(input) {
    const body = input.value.trim();
    if (!body || !currentSlug || !currentArtifact || composer?.submitting) return;
    composer.draft = input.value;
    composer.error = "";
    composer.submitting = true;
    const record = {
      ...composer.record,
      body,
      artifact_path: currentArtifact.source_path,
      ...(currentArtifact.rendered_sha256 ? { captured_rendered_sha256: currentArtifact.rendered_sha256 } : {}),
    };
    try {
      const result = await dataAccess.postAnnotation(currentSlug, record);
      const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
      // Delivery is a separate axis from status (R3): the POST response only picks the honest
      // initial label — "Sent to session" vs "Waiting for a session" (brief §7.5). `id` is kept so
      // the card's Remove action can withdraw the entry later.
      list.push({ record, id: result?.id ?? null, state: result?.status === "delivered" ? "delivered" : "waiting" });
      annotationsByPath.set(currentArtifact.source_path, list);
      closeComposer();
    } catch (error) {
      composer.submitting = false;
      composer.error = error instanceof Error ? `Couldn't send this annotation: ${error.message}` : "Couldn't send this annotation. Try again.";
      renderMargin();
      queueMicrotask(() => marginEl.querySelector(".glosa-composer-input")?.focus());
    }
  }

  function buildComposer() {
    const { record } = composer;
    const form = el("form", { className: "glosa-composer", "aria-label": "New annotation" });
    if (record.target?.quote?.exact) {
      // Inner span so the anchor wash hugs the quoted words instead of striping the whole card.
      form.append(el("p", { className: "glosa-composer-quote" }, [el("span", { textContent: record.target.quote.exact })]));
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
    const cancel = el("button", { className: "glosa-btn glosa-btn-ghost", type: "button", textContent: "Cancel", onClick: closeComposer });
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

  // Writer-register labels for every status the journal can hand us (brief §7.5). `waiting` is
  // the SPA's own name for the wire's initial `pending`.
  const STATE_LABELS = {
    waiting: "Waiting for a session",
    delivered: "Sent to session",
    applied: "Done",
    rejected: "Closed",
    stale: "Out of date",
  };

  /** Live status: an SSE `journal` frame whose entry id matches a card updates it in place —
   * `transition_committed` moves the state, `delivery_attempt` counts re-nudges (a separate axis
   * that never changes status, R3). */
  function applyJournalEvent(event) {
    if (!event?.entry) return;
    for (const [path, list] of annotationsByPath) {
      const item = list.find((i) => i.id === event.entry);
      if (!item) continue;
      if (event.event === "transition_committed" && typeof event.detail?.to === "string") {
        item.state = event.detail.to === "pending" ? "waiting" : event.detail.to;
      } else if (event.event === "delivery_attempt") {
        item.attempts = (item.attempts ?? 0) + 1;
      } else {
        return;
      }
      if (path === currentArtifact?.source_path) renderMargin();
      return;
    }
  }

  /** Withdraws the entry (terminal `rejected` — the journal keeps it, delivery stops) and drops
   * the card. A 404/409 means the entry is already gone or closed daemon-side, so dropping the
   * card is still honest; any other failure keeps the card and says so. */
  async function removeAnnotation(item) {
    try {
      if (item.id) await dataAccess.withdrawAnnotation(currentSlug, item.id);
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 409) {
        item.state = "waiting";
        item.error = true;
        renderMargin();
        return;
      }
    }
    const list = annotationsByPath.get(currentArtifact?.source_path) ?? [];
    const idx = list.indexOf(item);
    if (idx !== -1) list.splice(idx, 1);
    renderMargin();
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
   * still IS the quoted text (an edit can leave offsets numerically valid while pointing at
   * different words — never underline the wrong passage); (2) re-find the quote by its
   * prefix+exact+suffix context; (3) exact quote alone when it's unambiguous; else null —
   * unanchored, and the card says so instead of guessing. */
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

  /** True when the margin is the side overlay (annotate mode, wide window) rather than the
   * in-flow block under the manuscript. */
  function isSideMargin() {
    return modeState.mode === "annotate" && typeof window !== "undefined" && window.matchMedia?.("(min-width: 1280px)").matches;
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
    const mainTop = mainEl.getBoundingClientRect().top;
    let prevBottom = 0;
    for (const cardEl of positioned) {
      const item = cardEl._glosaItem;
      const range = item ? rangeForTarget(item.record?.target ?? item.target) : null;
      const anchorTop = range
        ? range.getBoundingClientRect().top - mainTop + mainEl.scrollTop
        : prevBottom + 8;
      const top = Math.max(anchorTop, prevBottom + (prevBottom ? 8 : 0));
      cardEl.style.top = `${Math.round(top)}px`;
      prevBottom = top + cardEl.offsetHeight;
    }
  }

  /** Compact gutter dots: one per annotation at its anchor's height. Rebuilt with the margin. */
  function renderMarkers() {
    markersEl.textContent = "";
    if (modeState.mode !== "annotate" || !currentArtifact || isSideMargin()) return;
    const mainTop = mainEl.getBoundingClientRect().top;
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    for (const item of list) {
      const range = rangeForTarget(item.record?.target);
      if (!range) continue;
      const top = range.getBoundingClientRect().top - mainTop + mainEl.scrollTop;
      const dot = el("button", {
        className: "glosa-marker",
        type: "button",
        "aria-label": "Go to annotation",
        onClick: () => {
          const cardEl = [...marginEl.querySelectorAll(".glosa-annotation")].find((c) => c._glosaItem === item);
          const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          cardEl?.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
          cardEl?.classList.add("glosa-annotation-flash");
          setTimeout(() => cardEl?.classList.remove("glosa-annotation-flash"), 1200);
        },
      });
      dot.style.top = `${Math.round(top)}px`;
      markersEl.append(dot);
    }
  }

  const highlightsAvailable = () =>
    typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  /** The open composer owns a temporary, persistent selection wash. It deliberately lives in a
   * separate highlight from saved annotation underlines, so closing/sending a draft cannot erase
   * the durable annotation state. */
  function paintComposerSelection() {
    if (!highlightsAvailable()) return;
    const range = composer ? rangeForTarget(composer.record?.target) : null;
    if (range) CSS.highlights.set("glosa-composer-selection", new Highlight(range));
    else CSS.highlights.delete("glosa-composer-selection");
  }

  let anchoredRanges = []; // [{item, range}] cache from the last underline pass — hit-testing reuses it

  /** Every annotated passage carries a permanent quiet underline (the pencil line that says
   * "someone wrote in this margin"); rebuilt whenever the card set or content changes.
   * CSS Custom Highlight API — progressive: browsers below the floor simply don't get it. */
  function paintAnchorUnderlines() {
    anchoredRanges = [];
    if (modeState.mode === "annotate" && currentArtifact) {
      for (const item of annotationsByPath.get(currentArtifact.source_path) ?? []) {
        const range = rangeForTarget(item.record?.target);
        if (range) anchoredRanges.push({ item, range });
      }
    }
    if (!highlightsAvailable()) return;
    if (anchoredRanges.length) CSS.highlights.set("glosa-anchors", new Highlight(...anchoredRanges.map((a) => a.range)));
    else CSS.highlights.delete("glosa-anchors");
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
        if (hit) CSS.highlights.set("glosa-anchor", new Highlight(hit.range));
      } else {
        CSS.highlights.delete("glosa-anchor");
      }
    }
  }

  contentEl.addEventListener("mousemove", (e) => {
    if (modeState.mode !== "annotate" || anchoredRanges.length === 0 || hoverRafPending) return;
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
      if (range) CSS.highlights.set("glosa-anchor", new Highlight(range));
    };
    const off = () => CSS.highlights.delete("glosa-anchor");
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
      return;
    }
    marginEl.append(el("p", { className: "glosa-margin-title", textContent: "Annotations" }));
    if (composer) {
      const form = buildComposer();
      form._glosaItem = composer.record ? { record: composer.record } : null;
      marginEl.append(form);
    }
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    for (const item of list) {
      const { record, state } = item;
      const intentLabel = INTENTS.find((i) => i.value === record.intent)?.label ?? record.intent;
      // Honest anchoring: if the quoted passage no longer exists in the current text (edited
      // away, rewritten), the card says "Lost its place" and keeps the original quote — it never
      // underlines different words (client echo of A5 §F10; the daemon's resolver is the
      // authority at delivery time).
      const anchored = Boolean(rangeForTarget(record.target));
      const card = el("div", { className: "glosa-annotation", "data-state": state, "data-anchored": String(anchored) });
      if (record.target?.quote?.exact) {
        card.append(el("p", { className: "glosa-annotation-quote" }, [el("span", { textContent: record.target.quote.exact })]));
      }
      if (!anchored) {
        card.append(el("p", { className: "glosa-annotation-lost", textContent: "Lost its place — the passage changed since this was written." }));
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
    if (!composer && list.length === 0) {
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
      renderMarkers();
      paintAnchorUnderlines();
      paintComposerSelection();
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(align);
    else align();
  }

  function setMode(mode) {
    if (previewLock && mode !== "preview") return;
    // Class-F Edit follows the derived-from edge (R6/R7) rather than switching THIS artifact into
    // edit mode: with an edge, open the source (class-R) artifact and edit that; with none, Edit
    // is absent from the mode control entirely — a programmatic call is a no-op.
    if (mode === "edit" && currentArtifact?.class === "F") {
      if (currentArtifact.derived_from) void openArtifact(currentArtifact.derived_from).then(() => setMode("edit"));
      return;
    }

    const previousMode = modeState.mode;
    let next = modeReducer(modeState, { type: "set_mode", mode });
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
        onFocusChange?.({ slug: currentSlug, artifact: currentArtifact?.source_path ?? null, mode: modeState.mode });
        queueMicrotask(() => modeBar.querySelector(`[data-mode="${modeState.mode}"]`)?.focus({ preventScroll: true }));
      });
      return;
    }
    modeState = next;
    renderModeBar();
    renderContent();
    onFocusChange?.({ slug: currentSlug, artifact: currentArtifact?.source_path ?? null, mode: modeState.mode });
    if (modeState.mode === "edit" && previousMode !== "edit") mainEl.scrollTop = 0;
  }

  editArea.addEventListener("input", () => {
    modeState = modeReducer(modeState, { type: "edited" });
    editStatus.textContent = "";
    editStatus.removeAttribute("data-error");
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
    const carried = richEditor && (richEditor.isDirty() || modeState.dirty)
      ? richEditor.getMarkdown()
      : currentArtifact?.content ?? "";
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

  saveButton.addEventListener("click", async () => {
    if (!currentSlug || !currentArtifact || saveButton.disabled) return;
    saveButton.disabled = true;
    editStatus.removeAttribute("data-error");
    editStatus.textContent = "Saving…";
    try {
      // The rich face serializes ONLY when the document changed (its own edits, or source-face
      // edits carried in via `modeState.dirty`); a clean editor saves the artifact's exact bytes.
      const content = !sourceFace && richEditor
        ? richEditor.isDirty() || modeState.dirty
          ? richEditor.getMarkdown()
          : currentArtifact.content ?? ""
        : editArea.value;
      const saved = await dataAccess.putArtifact(currentSlug, currentArtifact.source_path, content, {
        ifMatch: currentArtifact.source_sha256,
      });
      currentArtifact = { ...currentArtifact, content, ...saved };
      modeState = modeReducer(modeState, { type: "saved" });
      // Re-render (fetch ?render=html) rather than trust `saved.rendered_html` blindly — matches
      // the brief's "on save → putArtifact → re-render" flow even though the route happens to
      // already return it.
      const fresh = await dataAccess.getArtifact(currentSlug, currentArtifact.source_path, { render: "html" });
      currentArtifact = fresh;
      contentEl.removeAttribute("data-path"); // force the next renderContent to repaint from scratch
      teardownRichFace(); // remount the rich face from the freshly saved content
      editStatus.textContent = "Saved.";
      renderModeBar();
      renderContent();
    } catch (error) {
      editStatus.setAttribute("data-error", "true");
      editStatus.textContent = error instanceof Error ? `Couldn't save this artifact: ${error.message}` : "Couldn't save this artifact. Try again.";
    } finally {
      saveButton.disabled = false;
    }
  });

  // Annotate mode: a text selection inside the rendered content opens the composer with the
  // selected quote; the record is only posted when the reviewer submits (brief §9).
  contentEl.addEventListener("mouseup", () => {
    if (modeState.mode !== "annotate" || !currentSlug || !currentArtifact) return;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (!record) return;
    let returnFocus = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    while (returnFocus?.parentElement && returnFocus.parentElement !== contentEl) returnFocus = returnFocus.parentElement;
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
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? blocks.length - 1
          : Math.min(blocks.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
      annotatableFocusIndex = next;
      for (const [index, candidate] of blocks.entries()) {
        candidate.setAttribute("tabindex", index === next ? "0" : "-1");
      }
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
    for (const [index, candidate] of blocks.entries()) {
      candidate.setAttribute("tabindex", index === annotatableFocusIndex ? "0" : "-1");
    }
  });

  // ⌘1/2/3 mode switching (brief §9); Escape in the composer input is handled by the composer.
  // On `document` (a non-focusable div never receives key events); removed by unmount below.
  function onShortcut(e) {
    if (e.key === "Escape" && root.getAttribute("data-nav-open") === "true") {
      e.preventDefault();
      setNavOpen(false, { restoreFocus: true });
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const idx = ["1", "2", "3"].indexOf(e.key);
    if (idx === -1) return;
    e.preventDefault();
    if (previewLock && idx !== 0) return; // preview lock: only ⌘1 (Preview) remains meaningful
    if (currentArtifact) setMode(MODES[idx]);
  }
  document.addEventListener("keydown", onShortcut);

  // Card alignment depends on wrapped-line geometry — recompute cards AND gutter markers when
  // the window reflows (a resize can also cross the side-margin breakpoint either way).
  const onResize = () => {
    syncNavInteractivity();
    layoutMargin();
    renderMarkers();
  };
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);

  let historyVisible = false;

  async function renderHistory() {
    if (!historyVisible || !currentSlug) return;
    const slug = currentSlug;
    try {
      const mountHistoryPane = await loadHistoryPane();
      if (!historyVisible || currentSlug !== slug) return;
      mountHistoryPane(historyEl, { dataAccess, slug, path: currentArtifact?.source_path });
    } catch {
      if (!historyVisible || currentSlug !== slug) return;
      historyEl.setAttribute("role", "alert");
      historyEl.textContent = "History couldn't be loaded. Close this panel and try again.";
    }
  }

  historyToggle.addEventListener("click", () => {
    const nextVisible = !historyVisible;
    if (nextVisible && conversationVisible) setConversationVisible(false);
    historyVisible = nextVisible;
    historyEl.hidden = !historyVisible;
    historyToggle.setAttribute("aria-expanded", String(historyVisible));
    void renderHistory();
  });

  // P4.2 — workspace-scoped (not artifact-scoped, unlike history): re-mounted on open and on every
  // workspace switch (renderConversation is called from selectWorkspace below), never per-artifact.
  let conversationVisible = false;
  let stopConversation = null;

  function setConversationVisible(visible) {
    conversationVisible = visible;
    conversationEl.hidden = !conversationVisible;
    conversationToggle.setAttribute("aria-expanded", String(conversationVisible));
    void renderConversation();
  }

  async function renderConversation() {
    stopConversation?.();
    stopConversation = null;
    if (!conversationVisible || !currentSlug) return;
    const slug = currentSlug;
    try {
      const mountConversationPane = await loadConversationPane();
      if (!conversationVisible || currentSlug !== slug) return;
      stopConversation = mountConversationPane(conversationEl, {
        dataAccess,
        slug,
        onClose: () => {
          setConversationVisible(false);
          conversationToggle.focus({ preventScroll: true });
        },
      });
    } catch {
      if (!conversationVisible || currentSlug !== slug) return;
      conversationEl.setAttribute("role", "alert");
      conversationEl.textContent = "Conversation couldn't be loaded. Close this panel and use the terminal.";
    }
  }

  conversationToggle.addEventListener("click", () => {
    const nextVisible = !conversationVisible;
    if (nextVisible && historyVisible) {
      historyVisible = false;
      historyEl.hidden = true;
      historyToggle.setAttribute("aria-expanded", "false");
    }
    setConversationVisible(nextVisible);
  });

  function markCurrent(listEl, key) {
    for (const btn of listEl.querySelectorAll("button")) {
      btn.setAttribute("aria-current", String(btn.getAttribute("data-key") === key));
    }
  }

  async function openArtifact(path) {
    const returnToReading = compactNav() && root.getAttribute("data-nav-open") === "true";
    loading = true;
    composer = null;
    renderContent();
    try {
      currentArtifact = await dataAccess.getArtifact(currentSlug, path, { render: "html" });
    } catch (err) {
      loading = false;
      currentArtifact = null;
      artifactNavigator.setCurrent(null, { reveal: false });
      onFocusChange?.({ slug: currentSlug, artifact: null, mode: modeState.mode }); // URL reflects on-screen state: no open file
      setEmpty(
        "This artifact couldn't be opened.",
        el("p", { className: "glosa-empty-hint", textContent: err?.message ?? "Try again, or pick another artifact." }),
      );
      renderModeBar();
      renderContent();
      if (returnToReading) queueMicrotask(focusPreview);
      return;
    }
    loading = false;
    setNavOpen(false); // compact: picking an artifact closes the drawer and returns to reading
    contentEl.removeAttribute("data-path");
    artifactNavigator.setCurrent(path);
    onFocusChange?.({ slug: currentSlug, artifact: path, mode: modeState.mode }); // reflect the opened file into the URL
    renderModeBar();
    renderContent();
    void renderHistory(); // the open pane, if any, should reflect the newly opened artifact
    if (returnToReading) queueMicrotask(focusPreview);
  }

  async function refreshArtifactList() {
    const artifacts = await dataAccess.getArtifacts(currentSlug);
    artifactListEmpty.hidden = artifacts.length > 0;
    artifactNavigator.setArtifacts(artifacts);
    artifactNavigator.setCurrent(currentArtifact?.source_path ?? null, { reveal: false });
    return artifacts;
  }

  async function refreshCurrentArtifact() {
    if (!currentArtifact) return;
    const fresh = await dataAccess.getArtifact(currentSlug, currentArtifact.source_path, { render: "html" });
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
    renderMarkers();
    paintAnchorUnderlines();
  }

  function startStream() {
    stopStream?.();
    stopStream = dataAccess.openStream(currentSlug, {
      onStatus: (status) => {
        bannerEl.hidden = status !== "down";
      },
      onReconnect: () => {
        void refreshArtifactList();
        void refreshCurrentArtifact();
        void attentionTray.refresh();
      },
      onEvent: (frame) => {
        if (frame.event === "artifact" && currentArtifact && frame.data?.path === currentArtifact.source_path) {
          void refreshCurrentArtifact();
        }
        if (frame.event === "journal") applyJournalEvent(frame.data);
        if (frame.event === "journal" || frame.event === "metadata") void attentionTray.refresh();
        if (frame.event === "metadata") {
          void refreshArtifactList();
          void refreshCurrentArtifact();
        }
      },
    });
  }

  async function selectWorkspace(slug) {
    currentSlug = slug;
    attentionTray.setWorkspace(slug);
    currentArtifact = null;
    onFocusChange?.({ slug, artifact: null, mode: modeState.mode }); // a deep-linked artifact re-reflects below via openArtifact
    artifactNavigator.setWorkspace(slug);
    composer = null;
    emptyEl.textContent = ""; // drop any stale per-artifact error so the default teaching state returns
    stopClassFViewer?.();
    stopClassFViewer = null;
    classFEl.removeAttribute("data-path");
    markCurrent(sidebarList, slug);
    await refreshArtifactList();
    renderModeBar();
    renderContent();
    startStream();
    void renderConversation(); // the open pane, if any, should follow the newly selected workspace
    // CLI deep-link (`glosa open <file>`): the first workspace selection focuses the named
    // artifact, once — after that, navigation is the user's.
    if (initialArtifact) {
      const focus = initialArtifact;
      initialArtifact = undefined;
      await openArtifact(focus);
    }
  }

  function showWorkspaceError(error) {
    loading = false;
    currentArtifact = null;
    setEmpty(
      "This workspace couldn't be opened.",
      el("p", {
        className: "glosa-empty-hint",
        textContent: error instanceof Error ? error.message : "Try again, or reopen the workspace from the terminal.",
      }),
    );
    renderModeBar();
    renderContent();
  }

  async function refreshWorkspaces() {
    const workspaces = await dataAccess.getWorkspaces();
    sidebarList.textContent = "";
    for (const w of workspaces) {
      sidebarList.append(
        el("li", {}, [
          el("button", {
            type: "button",
            textContent: w.slug,
            "data-key": w.slug,
            onClick: () => void selectWorkspace(w.slug).catch(showWorkspaceError),
          }),
        ]),
      );
    }
    // MCP/CLI single-workspace mode: a "list of one" is noise — you're already scoped, and a lone
    // workspace auto-selects below. The switcher only earns its space once a SECOND workspace is
    // live (the machine-wide singleton daemon can serve several at once). Buttons stay in the DOM
    // for markCurrent + the compact-drawer focus fallback; only the switcher chrome is hidden.
    sidebarList.hidden = workspaces.length <= 1;
    if (workspaces.length === 0) {
      setEmpty(
        "No workspaces yet.",
        el("p", { className: "glosa-empty-hint" }, [
          "In a terminal, run ",
          el("code", { textContent: "glosa open <directory>" }),
          " to start reviewing its artifacts here.",
        ]),
      );
      renderContent();
    }
    if (currentSlug) {
      markCurrent(sidebarList, currentSlug);
      return;
    }
    if (initialSlug) {
      await selectWorkspace(initialSlug);
    } else if (workspaces.length === 1) {
      await selectWorkspace(workspaces[0].slug);
    }
  }

  renderModeBar();
  renderContent();
  void refreshWorkspaces().catch(showWorkspaceError);

  return () => {
    document.removeEventListener("keydown", onShortcut);
    document.removeEventListener("click", onDocumentClick);
    if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
    teardownRichFace();
    stopStream?.();
    stopClassFViewer?.();
    stopConversation?.();
    stopAppearance?.();
    attentionTray.destroy();
    artifactNavigator.destroy();
  };
}
