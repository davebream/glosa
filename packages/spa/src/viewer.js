// @glosa/spa — the class-R viewer (R6): renders the daemon's server-rendered markdown
// (`data-line`-stamped HTML), the Preview/Annotate/Edit mode toggle, the annotation-record flow
// (annotate.js builds the record, this module posts it), and the SSE-driven idiomorph morph that
// keeps the rendered view live. Talks to the daemon ONLY through data-access.js (R6's ONE
// data-access module) — never `fetch` directly (see test/import-boundary.test.ts, which checks
// this structurally across this file and annotate.js).
import { createDataAccess } from "./data-access.js";
import { buildAnnotationRecordFromSelection } from "./annotate.js";
import { Idiomorph } from "./vendor/idiomorph.js";
import { mountHistoryPane } from "./history.js";
import { mountClassFViewer } from "./classf-viewer.js";
import { mountConversationPane } from "./conversation.js";

export const MODES = ["preview", "annotate", "edit"];

export function initialModeState() {
  return { mode: "preview", dirty: false, blocked: null };
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
    else if (key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * Mounts the whole ready-state app (workspace/artifact sidebar + the class-R viewer) into
 * `root`. `dataAccess` defaults to a real `createDataAccess()` — a test passes a fake one so
 * nothing here ever needs a real daemon. Returns an `unmount()` that tears down the SSE
 * subscription — bootstrap.js doesn't call it today (the SPA never remounts within one page
 * load), but a test does, so a leaked stream connection never outlives one test case.
 */
export function mountApp(root, { dataAccess = createDataAccess(), initialSlug } = {}) {
  root.textContent = "";

  const sidebarList = el("ul", { className: "glosa-workspace-list" });
  const artifactList = el("ul", { className: "glosa-artifact-list" });
  const modeBar = el("div", { className: "glosa-modebar" });
  const contentEl = el("div", { className: "glosa-content" });
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  const marginEl = el("aside", { className: "glosa-margin" });
  // P4.1: the class-F (foreign HTML) viewer's mount point — a sandboxed iframe lives inside this,
  // never `innerHTML`-set with anything artifact-derived (classf-viewer.js owns everything under
  // it). Hidden/shown opposite `contentEl` depending on the open artifact's class.
  const classFEl = el("div", { className: "glosa-classf" });
  // P3.5: the checkpoint/diff history pane (A6 §F31) — hidden until the human opens it, and
  // (re)mounted by history.js's own `mountHistoryPane` whenever it's open and the artifact
  // changes, rather than this module reaching into checkpoints/diff state itself.
  const historyToggle = el("button", { className: "glosa-history-toggle", type: "button", textContent: "History" });
  const historyEl = el("div", { className: "glosa-history", hidden: true });
  // P4.2: the conversation-mirror pane (R6/F32) — workspace-scoped (not artifact-scoped, unlike
  // history), hidden until the human opens it. Mounted/remounted by conversation.js's own
  // `mountConversationPane` on open and on every workspace switch, same DI shape as history.js.
  const conversationToggle = el("button", { className: "glosa-conversation-toggle", type: "button", textContent: "Conversation" });
  const conversationEl = el("div", { className: "glosa-conversation", hidden: true });

  root.append(
    el("nav", { className: "glosa-sidebar" }, [
      el("h2", { textContent: "Workspaces" }),
      sidebarList,
      el("h2", { textContent: "Artifacts" }),
      artifactList,
    ]),
    el("main", { className: "glosa-main" }, [
      modeBar,
      historyToggle,
      conversationToggle,
      contentEl,
      classFEl,
      editArea,
      saveButton,
      marginEl,
      historyEl,
      conversationEl,
    ]),
  );

  let modeState = initialModeState();
  let currentSlug = initialSlug ?? null;
  let currentArtifact = null; // {path, content, rendered_html, source_sha256, class, derived_from?}
  const annotationsByPath = new Map(); // client-remembered per-session (no GET-annotations route yet)
  let stopStream = null;
  let stopClassFViewer = null; // unmount() for the currently mounted class-F iframe, if any

  // R6/A5 §F11: class-F Edit follows the generic derived-from edge — enabled only when the
  // artifact metadata carries a `derived_from` path (supplied by a future content adapter, P6.1;
  // the core itself never invents one). With no edge, class F is opaque: Preview + Annotate only.
  function canEdit(artifact) {
    return !artifact || artifact.class !== "F" || Boolean(artifact.derived_from);
  }

  function renderModeBar() {
    modeBar.textContent = "";
    for (const mode of MODES) {
      const btn = el("button", {
        type: "button",
        textContent: mode,
        "data-mode": mode,
        onClick: () => setMode(mode),
      });
      btn.setAttribute("aria-pressed", String(mode === modeState.mode));
      if (mode === "edit" && !canEdit(currentArtifact)) btn.disabled = true;
      modeBar.append(btn);
    }
  }

  function renderContent() {
    const isClassF = currentArtifact?.class === "F";
    const isEdit = modeState.mode === "edit" && !isClassF;
    editArea.hidden = !isEdit;
    saveButton.hidden = !isEdit;
    contentEl.hidden = isEdit || isClassF;
    classFEl.hidden = !isClassF;

    if (!currentArtifact) {
      contentEl.textContent = "select an artifact";
      return;
    }
    if (isClassF) {
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
    renderMargin();
  }

  /** Mounts (or re-mounts, on a path change) the class-F viewer — P4.1. A fresh capability is
   * minted on every mount, per A1 §7's "fresh mint per iframe open/reload": `force` (used by
   * refreshCurrentArtifact when SSE reports the source changed) re-mints even for the SAME path,
   * discarding the old iframe rather than trying to reuse it. */
  function mountClassFArtifact(force = false) {
    if (!force && classFEl.getAttribute("data-path") === currentArtifact.source_path && stopClassFViewer) return;
    stopClassFViewer?.();
    classFEl.setAttribute("data-path", currentArtifact.source_path);
    stopClassFViewer = mountClassFViewer(classFEl, {
      dataAccess,
      slug: currentSlug,
      artifactPath: currentArtifact.source_path,
      onSelection: (target) => {
        if (modeState.mode !== "annotate") return;
        void postClassFAnnotation(target);
      },
    });
  }

  async function postClassFAnnotation(target) {
    if (!currentSlug || !currentArtifact) return;
    const body = typeof window !== "undefined" && window.prompt ? window.prompt("Annotation:", "") : "";
    if (!body) return;
    const record = { body, intent: "content", target };
    await dataAccess.postAnnotation(currentSlug, record);
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    list.push(record);
    annotationsByPath.set(currentArtifact.source_path, list);
    renderMargin();
  }

  function renderMargin() {
    marginEl.textContent = "";
    if (modeState.mode !== "annotate" || !currentArtifact) return;
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    for (const a of list) marginEl.append(el("p", { className: "glosa-annotation", textContent: a.body }));
  }

  function setMode(mode) {
    // Class-F Edit follows the derived-from edge (R6/R7) rather than switching THIS artifact into
    // edit mode: with an edge, open the source (class-R) artifact and edit that; with none, Edit
    // is disabled (renderModeBar already grays the button out) — a stray click is a no-op.
    if (mode === "edit" && currentArtifact?.class === "F") {
      if (currentArtifact.derived_from) void openArtifact(currentArtifact.derived_from).then(() => setMode("edit"));
      return;
    }

    let next = modeReducer(modeState, { type: "set_mode", mode });
    if (next.blocked) {
      const discard = typeof window !== "undefined" && window.confirm ? window.confirm("Discard unsaved edits?") : true;
      next = discard ? modeReducer(next, { type: "discard" }) : { ...next, mode: "edit", blocked: null };
    }
    modeState = next;
    renderModeBar();
    renderContent();
  }

  editArea.addEventListener("input", () => {
    modeState = modeReducer(modeState, { type: "edited" });
  });

  saveButton.addEventListener("click", async () => {
    if (!currentSlug || !currentArtifact) return;
    const saved = await dataAccess.putArtifact(currentSlug, currentArtifact.source_path, editArea.value, {
      ifMatch: currentArtifact.source_sha256,
    });
    currentArtifact = { ...currentArtifact, content: editArea.value, ...saved };
    modeState = modeReducer(modeState, { type: "saved" });
    // Re-render (fetch ?render=html) rather than trust `saved.rendered_html` blindly — matches
    // the brief's "on save → putArtifact → re-render" flow even though the route happens to
    // already return it.
    const fresh = await dataAccess.getArtifact(currentSlug, currentArtifact.source_path, { render: "html" });
    currentArtifact = fresh;
    contentEl.removeAttribute("data-path"); // force the next renderContent to repaint from scratch
    renderModeBar();
    renderContent();
  });

  // Annotate mode: a text selection inside the rendered content prompts for an annotation body
  // and posts it — deliberately minimal (a native prompt()), per the brief's "minimal but
  // functional" scope for v1.
  contentEl.addEventListener("mouseup", async () => {
    if (modeState.mode !== "annotate" || !currentSlug || !currentArtifact) return;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (!record) return;
    const body = typeof window !== "undefined" && window.prompt ? window.prompt("Annotation:", "") : "";
    if (!body) return;
    record.body = body;
    await dataAccess.postAnnotation(currentSlug, record);
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    list.push(record);
    annotationsByPath.set(currentArtifact.source_path, list);
    renderMargin();
  });

  let historyVisible = false;

  function renderHistory() {
    if (!historyVisible || !currentSlug) return;
    mountHistoryPane(historyEl, { dataAccess, slug: currentSlug, path: currentArtifact?.source_path });
  }

  historyToggle.addEventListener("click", () => {
    historyVisible = !historyVisible;
    historyEl.hidden = !historyVisible;
    historyToggle.setAttribute("aria-pressed", String(historyVisible));
    renderHistory();
  });

  // P4.2 — workspace-scoped (not artifact-scoped, unlike history): re-mounted on open and on every
  // workspace switch (renderConversation is called from selectWorkspace below), never per-artifact.
  let conversationVisible = false;
  let stopConversation = null;

  function renderConversation() {
    stopConversation?.();
    stopConversation = null;
    if (!conversationVisible || !currentSlug) return;
    stopConversation = mountConversationPane(conversationEl, { dataAccess, slug: currentSlug });
  }

  conversationToggle.addEventListener("click", () => {
    conversationVisible = !conversationVisible;
    conversationEl.hidden = !conversationVisible;
    conversationToggle.setAttribute("aria-pressed", String(conversationVisible));
    renderConversation();
  });

  async function openArtifact(path) {
    currentArtifact = await dataAccess.getArtifact(currentSlug, path, { render: "html" });
    contentEl.removeAttribute("data-path");
    renderContent();
    renderHistory(); // the open pane, if any, should reflect the newly opened artifact
  }

  async function refreshArtifactList() {
    const artifacts = await dataAccess.getArtifacts(currentSlug);
    artifactList.textContent = "";
    for (const a of artifacts) {
      artifactList.append(
        el("li", {}, [el("button", { type: "button", textContent: a.path, onClick: () => openArtifact(a.path) })]),
      );
    }
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
    if (modeState.mode !== "edit") morphArtifactContent(contentEl, fresh.rendered_html ?? "");
    contentEl.setAttribute("data-path", currentArtifact.source_path);
  }

  function startStream() {
    stopStream?.();
    stopStream = dataAccess.openStream(currentSlug, {
      onReconnect: () => {
        void refreshArtifactList();
        void refreshCurrentArtifact();
      },
      onEvent: (frame) => {
        if (frame.event === "artifact" && currentArtifact && frame.data?.path === currentArtifact.source_path) {
          void refreshCurrentArtifact();
        }
      },
    });
  }

  async function selectWorkspace(slug) {
    currentSlug = slug;
    currentArtifact = null;
    stopClassFViewer?.();
    stopClassFViewer = null;
    classFEl.removeAttribute("data-path");
    await refreshArtifactList();
    renderContent();
    startStream();
    renderConversation(); // the open pane, if any, should follow the newly selected workspace
  }

  async function refreshWorkspaces() {
    const workspaces = await dataAccess.getWorkspaces();
    sidebarList.textContent = "";
    for (const w of workspaces) {
      sidebarList.append(
        el("li", {}, [el("button", { type: "button", textContent: w.slug, onClick: () => selectWorkspace(w.slug) })]),
      );
    }
    if (currentSlug) return;
    if (initialSlug) {
      await selectWorkspace(initialSlug);
    } else if (workspaces.length === 1) {
      await selectWorkspace(workspaces[0].slug);
    }
  }

  renderModeBar();
  renderContent();
  void refreshWorkspaces();

  return () => {
    stopStream?.();
    stopClassFViewer?.();
    stopConversation?.();
  };
}
