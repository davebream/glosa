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
import { mountHistoryPane } from "./history.js";
import { mountClassFViewer } from "./classf-viewer.js";
import { mountConversationPane } from "./conversation.js";

export const MODES = ["preview", "annotate", "edit"];

// Writer-register labels for R3's annotation `intent` enum (brief §7.5): the wire value is the
// enum, the label is what the reviewer reads. Order = the enum's declaration order in R3.
export const INTENTS = [
  { value: "content", label: "Change the words" },
  { value: "classification", label: "Wrong label or split" },
  { value: "style", label: "Fix how it looks" },
];

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
export function mountApp(root, { dataAccess = createDataAccess(), initialSlug } = {}) {
  root.textContent = "";
  root.classList.add("glosa-app");
  root.setAttribute("data-mode", "preview");

  // --- top bar ---
  const navToggle = el("button", {
    className: "glosa-nav-toggle",
    type: "button",
    "aria-label": "Show artifacts",
    "aria-expanded": "false",
  });
  // Static trusted markup (no artifact-derived content ever goes through innerHTML here).
  navToggle.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11m-11 3.5h11m-11 3.5h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const artifactNameEl = el("span", { className: "glosa-artifact-name", textContent: "glosa" });
  const artifactDirEl = el("span", { className: "glosa-artifact-dir" });
  const modeBar = el("div", { className: "glosa-modebar", role: "group", "aria-label": "View mode" });
  const historyToggle = el("button", {
    className: "glosa-history-toggle",
    type: "button",
    textContent: "History",
    "aria-pressed": "false",
  });
  const conversationToggle = el("button", {
    className: "glosa-conversation-toggle",
    type: "button",
    textContent: "Conversation",
    "aria-pressed": "false",
  });

  // --- navigator ---
  const sidebarList = el("ul", { className: "glosa-workspace-list" });
  const artifactList = el("ul", { className: "glosa-artifact-list" });
  const artifactListEmpty = el("p", {
    className: "glosa-sidebar-empty",
    textContent: "Markdown, HTML, and text files in this workspace appear here.",
    hidden: true,
  });
  const backdrop = el("div", { className: "glosa-backdrop" });

  // --- manuscript column ---
  const contentEl = el("div", { className: "glosa-content" });
  const emptyEl = el("div", { className: "glosa-empty", hidden: true });
  const skeletonEl = el("div", { className: "glosa-skeleton", hidden: true, "aria-hidden": "true" });
  for (let i = 0; i < 8; i++) skeletonEl.append(el("i"));
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true, "aria-label": "Artifact source" });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  const editWrap = el("div", { className: "glosa-edit-wrap", hidden: true }, [
    editArea,
    el("div", { className: "glosa-edit-actions" }, [saveButton]),
  ]);
  const classFEl = el("div", { className: "glosa-classf", hidden: true });
  const historyEl = el("div", { className: "glosa-history", hidden: true });
  const conversationEl = el("div", { className: "glosa-conversation", hidden: true });

  // --- contextual margin (annotation cards + the ONE composer) ---
  const marginEl = el("aside", { className: "glosa-margin", "aria-label": "Annotations" });

  root.append(
    el("header", { className: "glosa-topbar" }, [
      navToggle,
      el("div", { className: "glosa-topbar-title" }, [artifactNameEl, artifactDirEl]),
      modeBar,
      el("div", { className: "glosa-topbar-actions" }, [historyToggle, conversationToggle]),
    ]),
    el("nav", { className: "glosa-sidebar" }, [
      el("h2", { textContent: "Workspaces" }),
      sidebarList,
      el("h2", { textContent: "Artifacts" }),
      artifactList,
      artifactListEmpty,
    ]),
    backdrop,
    el("main", { className: "glosa-main" }, [
      emptyEl,
      skeletonEl,
      contentEl,
      classFEl,
      editWrap,
      historyEl,
      conversationEl,
    ]),
    marginEl,
  );

  let modeState = initialModeState();
  let currentSlug = initialSlug ?? null;
  let currentArtifact = null; // {path, content, rendered_html, source_sha256, class, derived_from?}
  let loading = false;
  const annotationsByPath = new Map(); // per-session [{record, state}] (no GET-annotations route yet)
  let composer = null; // {record} while the annotation composer is open
  let stopStream = null;
  let stopClassFViewer = null; // unmount() for the currently mounted class-F iframe, if any

  function setNavOpen(open) {
    root.setAttribute("data-nav-open", String(open));
    navToggle.setAttribute("aria-expanded", String(open));
  }
  navToggle.addEventListener("click", () => setNavOpen(root.getAttribute("data-nav-open") !== "true"));
  backdrop.addEventListener("click", () => setNavOpen(false));

  // R6/A5 §F11: class-F Edit follows the generic derived-from edge — enabled only when the
  // artifact metadata carries a `derived_from` path (supplied by a content adapter, P6.1; the
  // core itself never invents one). With no edge, class F is opaque: Preview + Annotate only.
  function canEdit(artifact) {
    return !artifact || artifact.class !== "F" || Boolean(artifact.derived_from);
  }

  function renderModeBar() {
    modeBar.textContent = "";
    for (const mode of MODES) {
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

  function renderContent() {
    root.setAttribute("data-mode", modeState.mode);
    const isClassF = currentArtifact?.class === "F";
    const isEdit = modeState.mode === "edit" && !isClassF;
    editArea.hidden = !isEdit;
    editWrap.hidden = !isEdit;
    saveButton.hidden = !isEdit;
    skeletonEl.hidden = !loading;
    emptyEl.hidden = Boolean(currentArtifact) || loading;
    contentEl.hidden = isEdit || isClassF || !currentArtifact || loading;
    classFEl.hidden = !isClassF;
    renderTitle();

    if (!currentArtifact) {
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
        openComposer({ body: "", intent: "content", target });
      },
    });
  }

  // --- annotation composer (brief §7.3/§9): selection → composer → intent + comment → post.
  // ONE component; CSS places it in the margin at full width and as a bottom tray in compact. ---

  function openComposer(record) {
    composer = { record };
    // Compact (bottom-tray) widths: keep the selected passage visible in the unobscured upper
    // area before the tray covers the bottom of the window (brief §7.3).
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches) {
      const anchorNode = window.getSelection()?.anchorNode;
      const anchorEl = anchorNode && (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement);
      anchorEl?.scrollIntoView?.({ block: "center" });
    }
    renderMargin();
    marginEl.querySelector(".glosa-composer-input")?.focus();
  }

  function closeComposer() {
    composer = null;
    renderMargin();
  }

  async function submitComposer(input) {
    const body = input.value.trim();
    if (!body || !currentSlug || !currentArtifact) return;
    const record = { ...composer.record, body };
    const result = await dataAccess.postAnnotation(currentSlug, record);
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    // Delivery is a separate axis from status (R3): the POST response's `delivered` only picks
    // the honest initial label — "Sent to session" vs "Waiting for a session" (brief §7.5).
    list.push({ record, state: result?.delivered ? "delivered" : "waiting" });
    annotationsByPath.set(currentArtifact.source_path, list);
    closeComposer();
  }

  function buildComposer() {
    const { record } = composer;
    const form = el("form", { className: "glosa-composer" });
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
    form.addEventListener("submit", (e) => e.preventDefault());
    form.append(intents, input, el("div", { className: "glosa-composer-actions" }, [cancel, send]));
    return form;
  }

  const STATE_LABELS = { waiting: "Waiting for a session", delivered: "Sent to session" };

  function renderMargin() {
    marginEl.textContent = "";
    if (modeState.mode !== "annotate" || !currentArtifact) {
      if (composer) composer = null;
      return;
    }
    marginEl.append(el("p", { className: "glosa-margin-title", textContent: "Annotations" }));
    if (composer) marginEl.append(buildComposer());
    const list = annotationsByPath.get(currentArtifact.source_path) ?? [];
    for (const { record, state } of list) {
      const intentLabel = INTENTS.find((i) => i.value === record.intent)?.label ?? record.intent;
      const card = el("div", { className: "glosa-annotation", "data-state": state });
      if (record.target?.quote?.exact) {
        card.append(el("p", { className: "glosa-annotation-quote" }, [el("span", { textContent: record.target.quote.exact })]));
      }
      card.append(
        el("p", { className: "glosa-annotation-body", textContent: record.body }),
        el("p", { className: "glosa-annotation-state" }, [
          el("span", { className: "glosa-state-dot", "aria-hidden": "true" }),
          el("span", { textContent: STATE_LABELS[state] ?? state }),
          el("span", { className: "glosa-annotation-intent", textContent: intentLabel }),
        ]),
      );
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
  }

  function setMode(mode) {
    // Class-F Edit follows the derived-from edge (R6/R7) rather than switching THIS artifact into
    // edit mode: with an edge, open the source (class-R) artifact and edit that; with none, Edit
    // is absent from the mode control entirely — a programmatic call is a no-op.
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

  // Annotate mode: a text selection inside the rendered content opens the composer with the
  // selected quote; the record is only posted when the reviewer submits (brief §9).
  contentEl.addEventListener("mouseup", () => {
    if (modeState.mode !== "annotate" || !currentSlug || !currentArtifact) return;
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    const record = buildAnnotationRecordFromSelection(selection, contentEl, { body: "", intent: "content" });
    if (!record) return;
    openComposer(record);
  });

  // ⌘1/2/3 mode switching (brief §9); Escape in the composer input is handled by the composer.
  // On `document` (a non-focusable div never receives key events); removed by unmount below.
  function onShortcut(e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const idx = ["1", "2", "3"].indexOf(e.key);
    if (idx === -1) return;
    e.preventDefault();
    if (currentArtifact) setMode(MODES[idx]);
  }
  document.addEventListener("keydown", onShortcut);

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

  function markCurrent(listEl, key) {
    for (const btn of listEl.querySelectorAll("button")) {
      btn.setAttribute("aria-current", String(btn.getAttribute("data-key") === key));
    }
  }

  async function openArtifact(path) {
    loading = true;
    composer = null;
    renderContent();
    try {
      currentArtifact = await dataAccess.getArtifact(currentSlug, path, { render: "html" });
    } catch (err) {
      loading = false;
      currentArtifact = null;
      setEmpty(
        "This artifact couldn't be opened.",
        el("p", { className: "glosa-empty-hint", textContent: err?.message ?? "Try again, or pick another artifact." }),
      );
      renderModeBar();
      renderContent();
      return;
    }
    loading = false;
    setNavOpen(false); // compact: picking an artifact closes the drawer and returns to reading
    contentEl.removeAttribute("data-path");
    markCurrent(artifactList, path);
    renderModeBar();
    renderContent();
    renderHistory(); // the open pane, if any, should reflect the newly opened artifact
  }

  async function refreshArtifactList() {
    const artifacts = await dataAccess.getArtifacts(currentSlug);
    artifactList.textContent = "";
    artifactListEmpty.hidden = artifacts.length > 0;
    for (const a of artifacts) {
      artifactList.append(
        el("li", {}, [
          el("button", { type: "button", textContent: a.path, "data-key": a.path, onClick: () => openArtifact(a.path) }),
        ]),
      );
    }
    markCurrent(artifactList, currentArtifact?.source_path ?? null);
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
    renderConversation(); // the open pane, if any, should follow the newly selected workspace
  }

  async function refreshWorkspaces() {
    const workspaces = await dataAccess.getWorkspaces();
    sidebarList.textContent = "";
    for (const w of workspaces) {
      sidebarList.append(
        el("li", {}, [
          el("button", { type: "button", textContent: w.slug, "data-key": w.slug, onClick: () => selectWorkspace(w.slug) }),
        ]),
      );
    }
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
  void refreshWorkspaces();

  return () => {
    document.removeEventListener("keydown", onShortcut);
    stopStream?.();
    stopClassFViewer?.();
    stopConversation?.();
  };
}
