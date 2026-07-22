// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the rich markdown editor (Edit mode's default face; the source textarea remains
// one toggle away and stays the byte-exact fallback). Built on the vendored ProseMirror bundle
// (vendor/prosemirror.js) with prosemirror-markdown's CommonMark schema, so what this editor
// parses and re-serializes is plain markdown — no HTML persistence, no hidden format.
//
// Honesty contract with the file on disk: `getMarkdown()` re-serializes ONLY when the document
// actually changed (`isDirty()`); an untouched open-then-save round-trip must never reformat the
// author's bytes. viewer.js enforces that by saving `currentArtifact.content` verbatim when the
// editor is clean.
//
// Talks to the daemon through NOTHING — pure editor over a string; viewer.js owns save/dirty
// wiring (see test/import-boundary.test.ts).
import {
  EditorState,
  EditorView,
  markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownSerializer,
  history,
  undo,
  redo,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  keymap,
  baseKeymap,
  toggleMark,
  setBlockType,
  wrapIn,
  wrapInList,
  splitListItem,
  liftListItem,
  sinkListItem,
} from "./vendor/prosemirror.js";

/** The default serializer bullets with `*`; nearly every hand-authored file here uses `-`.
 * Overriding just bullet_list keeps saved diffs from churning list markers document-wide. */
const mdSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
  },
  defaultMarkdownSerializer.marks,
);

/** DOM-free halves of the editor, exported for tests: what the rich face parses and persists. */
export function parseMarkdown(markdown) {
  return defaultMarkdownParser.parse(markdown ?? "");
}

export function serializeMarkdown(doc) {
  return mdSerializer.serialize(doc);
}

/** Markdown-reflex input rules so the editor keeps the writer's muscle memory: `# ` headings,
 * `> ` quote, `- ` / `1. ` lists — typed at a block start, they become the structure they name. */
function markdownInputRules(schema) {
  const rules = [
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({ level: match[1].length })),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, (match) => ({ order: Number(match[1]) }), (match, node) => node.childCount + (node.attrs.order ?? 1) === Number(match[1])),
  ];
  return inputRules({ rules });
}

function editorKeymap(schema) {
  return {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    Enter: splitListItem(schema.nodes.list_item),
    Tab: sinkListItem(schema.nodes.list_item),
    "Shift-Tab": liftListItem(schema.nodes.list_item),
  };
}

/** The quiet toolbar: writer-named actions, ghost buttons, no icon font. Each entry is
 * {label, aria, command(schema), active?(state)} — `active` drives aria-pressed for marks. */
function toolbarActions(schema) {
  const markActive = (markType) => (state) => {
    const { from, $from, to, empty } = state.selection;
    if (empty) return Boolean(markType.isInSet(state.storedMarks || $from.marks()));
    return state.doc.rangeHasMark(from, to, markType);
  };
  return [
    { label: "B", aria: "Bold", command: () => toggleMark(schema.marks.strong), active: markActive(schema.marks.strong), className: "glosa-rich-b" },
    { label: "I", aria: "Italic", command: () => toggleMark(schema.marks.em), active: markActive(schema.marks.em), className: "glosa-rich-i" },
    { label: "Code", aria: "Inline code", command: () => toggleMark(schema.marks.code), active: markActive(schema.marks.code) },
    { label: "H1", aria: "Heading 1", command: () => setBlockType(schema.nodes.heading, { level: 1 }) },
    { label: "H2", aria: "Heading 2", command: () => setBlockType(schema.nodes.heading, { level: 2 }) },
    { label: "H3", aria: "Heading 3", command: () => setBlockType(schema.nodes.heading, { level: 3 }) },
    { label: "¶", aria: "Paragraph", command: () => setBlockType(schema.nodes.paragraph) },
    { label: "• List", aria: "Bullet list", command: () => wrapInList(schema.nodes.bullet_list) },
    { label: "1. List", aria: "Numbered list", command: () => wrapInList(schema.nodes.ordered_list) },
    { label: "Quote", aria: "Blockquote", command: () => wrapIn(schema.nodes.blockquote) },
  ];
}

/**
 * Mounts the rich editor into `container` (a toolbar + a ProseMirror contenteditable styled by
 * app.css). Returns {getMarkdown, isDirty, focus, destroy}. Throws if the environment can't host
 * a ProseMirror view (e.g. a DOM without layout APIs) — the caller falls back to source mode.
 */
export function mountRichEditor(container, { markdown, onDirty } = {}) {
  const schema = markdownSchema;
  const doc = parseMarkdown(markdown);
  let dirty = false;

  container.textContent = "";
  const toolbar = document.createElement("div");
  toolbar.className = "glosa-rich-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Formatting");
  const mountEl = document.createElement("div");
  mountEl.className = "glosa-rich-surface glosa-content";
  container.append(toolbar, mountEl);

  const state = EditorState.create({
    doc,
    plugins: [markdownInputRules(schema), keymap(editorKeymap(schema)), keymap(baseKeymap), history()],
  });

  const view = new EditorView(mountEl, {
    state,
    attributes: {
      role: "textbox",
      "aria-label": "Artifact editor",
      "aria-multiline": "true",
    },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) {
        dirty = true;
        onDirty?.();
      }
      refreshToolbar();
    },
  });

  const actions = toolbarActions(schema);
  const buttons = actions.map((action) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    if (action.className) btn.classList.add(action.className);
    btn.setAttribute("aria-label", action.aria);
    btn.title = action.aria;
    // mousedown + preventDefault keeps the editor selection (a click would blur it first).
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      action.command()(view.state, view.dispatch, view);
      view.focus();
    });
    toolbar.append(btn);
    return { btn, action };
  });

  function refreshToolbar() {
    for (const { btn, action } of buttons) {
      if (action.active) btn.setAttribute("aria-pressed", String(action.active(view.state)));
    }
  }
  refreshToolbar();

  return {
    getMarkdown: () => serializeMarkdown(view.state.doc),
    isDirty: () => dirty,
    focus: () => view.focus(),
    destroy: () => {
      view.destroy();
      container.textContent = "";
    },
  };
}
