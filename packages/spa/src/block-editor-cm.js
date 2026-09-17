// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — SPIKE: a block editor whose document IS the block's markdown bytes.
//
// WHY THIS EXISTS. The shipped block editor parses a run into a ProseMirror document and
// serializes it back, and about 970 lines of rich-editor.js plus ~4,700 lines of test exist to
// make that round trip return the writer's bytes rather than the serializer's opinion of them.
// This module is the other answer to the same problem: CodeMirror holds the markdown itself, so
// `getMarkdown()` is `doc.toString()` and fidelity is not a property anything has to maintain.
//
// What it costs is visible rather than hidden: the caret's own line shows its markdown. Every
// decoration below is VIEW-ONLY — nothing here ever changes a byte — which is exactly what makes
// the claim above true and is worth checking whenever this file grows.
//
// Mounted only behind `?editor=cm`. `loadEditorKit()` in artifact-pane.js is the one caller.
// No `@ts-check` here, for the same reason rich-editor.js has none: the vendored bundle ships no
// type declarations, so every symbol it exports would be reported as implicitly `any`.
import {
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  RangeSetBuilder,
  ViewPlugin,
  defaultKeymap,
  drawSelection,
  history,
  historyKeymap,
  keymap,
  markdown,
  markdownLanguage,
  syntaxTree,
} from "./vendor/codemirror.js";

/** Syntax that is spelling rather than content: hidden unless the caret is on its line. */
const MARKERS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "URL",
  "ListMark",
]);

/** Block constructs that set the line's type. */
const LINE_CLASS = {
  ATXHeading1: "cm-glosa-h1",
  ATXHeading2: "cm-glosa-h2",
  ATXHeading3: "cm-glosa-h3",
  ATXHeading4: "cm-glosa-h4",
  ATXHeading5: "cm-glosa-h5",
  ATXHeading6: "cm-glosa-h6",
  Blockquote: "cm-glosa-quote",
};

/** Inline constructs that carry a style. */
const MARK_CLASS = {
  StrongEmphasis: "cm-glosa-strong",
  Emphasis: "cm-glosa-em",
  InlineCode: "cm-glosa-code",
  Strikethrough: "cm-glosa-strike",
  Link: "cm-glosa-link",
};

const HIDE = Decoration.replace({});

/** The lines any cursor or selection currently touches. Markers on these stay visible, because a
 * marker you cannot see is a marker you cannot edit — this is the whole of the live-preview idea. */
function caretLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function buildDecorations(view) {
  const { state } = view;
  const lit = caretLines(state);
  const pending = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const lineStart = state.doc.lineAt(node.from).from;
        const lineNumber = state.doc.lineAt(node.from).number;
        const lineClass = LINE_CLASS[node.name];
        if (lineClass) pending.push([lineStart, lineStart, Decoration.line({ class: lineClass })]);
        const markClass = MARK_CLASS[node.name];
        if (markClass && node.to > node.from) pending.push([node.from, node.to, Decoration.mark({ class: markClass })]);
        if (MARKERS.has(node.name) && node.to > node.from && !lit.has(lineNumber)) {
          pending.push([node.from, node.to, HIDE]);
        }
      },
    });
  }
  // RangeSetBuilder demands sorted input and throws otherwise, and the tree walk emits line
  // decorations at a position it has already passed. Sorting here rather than restructuring the
  // walk keeps the walk readable and is O(n log n) over one block, not one document.
  pending.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2].startSide ?? 0) - (b[2].startSide ?? 0));
  const builder = new RangeSetBuilder();
  for (const [from, to, decoration] of pending) builder.add(from, to, decoration);
  return builder.finish();
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      // `selectionSet` matters as much as `docChanged`: moving the caret onto a line is what
      // reveals that line's syntax, and off it is what hides it again.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** CodeMirror's base theme is a CODE editor's — monospace, its own leading, its own scroller. A
 * block of a manuscript has to take every one of those back, or the block you clicked changes
 * typeface under your hand, which is the exact defect this whole redesign exists to remove. */
const manuscriptTheme = EditorView.theme({
  "&": {
    fontFamily: "var(--font-manuscript)",
    fontSize: "inherit",
    lineHeight: "inherit",
    color: "inherit",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { fontFamily: "inherit", padding: "0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0" },
  ".cm-glosa-h1": { fontSize: "2.5rem", lineHeight: "1.1", fontWeight: "650", letterSpacing: "-0.015em" },
  ".cm-glosa-h2": { fontSize: "1.625rem", lineHeight: "1.25", fontWeight: "620", letterSpacing: "-0.01em" },
  ".cm-glosa-h3": { fontSize: "1.25rem", lineHeight: "1.3", fontWeight: "620" },
  ".cm-glosa-h4, .cm-glosa-h5, .cm-glosa-h6": { fontSize: "var(--text-md)", fontWeight: "600" },
  ".cm-glosa-quote": { color: "var(--muted)", fontStyle: "italic" },
  ".cm-glosa-strong": { fontWeight: "600" },
  ".cm-glosa-em": { fontStyle: "italic" },
  ".cm-glosa-strike": { textDecoration: "line-through" },
  ".cm-glosa-code": { fontFamily: "var(--font-mono)", fontSize: "0.92em" },
  ".cm-glosa-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
});

/**
 * Mounts a block editor over `markdown`, with the same shape `mountRichEditor` returns so
 * `artifact-pane.js` does not know which of the two it is holding.
 *
 * @param {HTMLElement} container
 * @param {{ markdown?: string, onDirty?: () => void, label?: string }} [options]
 */
export function mountBlockEditor(container, { markdown: source = "", onDirty, label } = {}) {
  container.textContent = "";
  let dirty = false;

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: source,
      extensions: [
        keymap.of([...defaultKeymap, ...historyKeymap]),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        livePreview,
        manuscriptTheme,
        EditorView.contentAttributes.of({
          // Named for the passage it opened on, for the same reason the ProseMirror face is: a
          // screen reader leaving a labelled region for an unnamed textbox loses the reader's place.
          "aria-label": label ?? "Artifact editor",
          "aria-multiline": "true",
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          dirty = true;
          onDirty?.();
        }),
      ],
    }),
  });

  return {
    /** The whole point: the buffer IS the markdown, so there is no serializer to be faithful. */
    getMarkdown: () => view.state.doc.toString(),
    getSave: () => ({ markdown: view.state.doc.toString(), collateral: [], degraded: false }),
    isDirty: () => dirty,
    focus: () => view.focus(),
    /** Caret where the reader clicked. CodeMirror measures in `{x, y}`; the pane speaks in
     * `{left, top}` because that is what ProseMirror's `posAtCoords` takes.
     * @param {{left: number, top: number}} [coords] */
    focusAt: (coords) => {
      view.focus();
      if (!coords) return;
      const pos = view.posAtCoords({ x: coords.left, y: coords.top });
      if (pos === null) return;
      view.dispatch({ selection: EditorSelection.cursor(pos) });
    },
    destroy: () => {
      view.destroy();
      container.textContent = "";
    },
  };
}
