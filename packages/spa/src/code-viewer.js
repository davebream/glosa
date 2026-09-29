// SPDX-License-Identifier: Apache-2.0
import {
  EditorState,
  EditorView,
  Compartment,
  keymap,
  lineNumbers,
  drawSelection,
  search,
  searchKeymap,
  standardKeymap,
  openSearchPanel,
  highlightSelectionMatches,
  syntaxHighlighting,
  HighlightStyle,
  tags,
  languageFor,
} from "./vendor/codemirror.js";

export function mountCodeViewer(host, { text, path, wrapped = false }) {
  const wrapping = new Compartment();
  const identity = new Compartment();
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        identity.of(EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${path}, read-only source` })),
        lineNumbers(),
        drawSelection(),
        search({ top: true }),
        keymap.of([...searchKeymap, ...standardKeymap]),
        highlightSelectionMatches(),
        wrapping.of(wrapped ? EditorView.lineWrapping : []),
        languageFor(path),
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.keyword, color: "var(--ink)", fontWeight: "600" },
            { tag: [tags.string, tags.regexp], color: "var(--ok)" },
            { tag: [tags.number, tags.bool, tags.null], color: "var(--session)" },
            { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
            { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--ink)", fontWeight: "600" },
          ]),
        ),
        EditorView.theme({
          "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--ink)" },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "13px",
            lineHeight: "1.7",
          },
          ".cm-content": { padding: "12px 0" },
          ".cm-gutters": {
            backgroundColor: "var(--bg)",
            color: "var(--muted)",
            borderRight: "1px solid var(--border)",
          },
          ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--ink)" },
          ".cm-textfield, .cm-button": {
            background: "var(--bg)",
            color: "var(--ink)",
            border: "1px solid var(--border-strong)",
          },
          "&.cm-focused": { outline: "2px solid var(--hand)", outlineOffset: "-2px" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
            backgroundColor: "color-mix(in oklab, var(--hand) 22%, transparent)",
          },
        }),
      ],
    }),
  });
  return {
    retarget: (path) =>
      view.dispatch({
        effects: identity.reconfigure(
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${path}, read-only source` }),
        ),
      }),
    find: () => openSearchPanel(view),
    focus: () => view.focus(),
    wrap: (enabled) => view.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }),
    update(next) {
      if (view.state.doc.toString() === next) return;
      const scroll = view.scrollDOM.scrollTop,
        left = view.scrollDOM.scrollLeft;
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: Math.min(selection.anchor, next.length), head: Math.min(selection.head, next.length) },
      });
      view.scrollDOM.scrollTop = scroll;
      view.scrollDOM.scrollLeft = left;
    },
    destroy: () => view.destroy(),
  };
}
