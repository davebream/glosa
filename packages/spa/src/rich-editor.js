// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the rich markdown editor (Edit mode's default face; the source textarea remains
// one toggle away and stays the byte-exact fallback). Built on the vendored ProseMirror bundle
// (vendor/prosemirror.js) with prosemirror-markdown's CommonMark schema, so what this editor
// parses and re-serializes is plain markdown — no HTML persistence, no hidden format.
//
// Honesty contract with the file on disk: a save re-serializes ONLY the blocks whose tree the
// writer actually changed, and copies every other block's original bytes verbatim, so outside the
// edited blocks the file is byte-identical. That matters beyond tidiness: every region this
// rewrites reaches the agent as a `human_edit`, and a save that invents edits makes the human's
// own change impossible to pick out. Where re-serializing an EDITED block would still cost bytes
// the writer did not touch — CommonMark has no node for frontmatter, callout markers, `%%`
// comments or soft line breaks, and it escapes brackets conservatively — `getSave()` reports that
// collateral instead of writing it, and artifact-pane.js asks first.
//
// Talks to the daemon through NOTHING — pure editor over a string; artifact-pane.js owns save and
// dirty wiring (see test/import-boundary.test.ts).
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

/**
 * A single newline inside a paragraph stays a newline.
 *
 * prosemirror-markdown's stock handler turns markdown-it's `softbreak` into a space, which is the
 * one loss in this file that no round trip undoes: once the save has written the joined line, the
 * break the writer typed is gone from disk and nothing can put it back. It is also by far the most
 * common one — a hand-wrapped paragraph or list item is most of the prose in this repo, so before
 * this the collateral dialog fired on roughly two saves in five, and a dialog that noisy gets
 * dismissed unread on the save where it is reporting an edit the serializer really did invent.
 *
 * A newline in a text node is enough; no new node or mark. `MarkdownSerializerState.text()` splits
 * on `\n` and writes each line through the current block delimiter, so a break inside a blockquote
 * or a list item comes back correctly prefixed. Leaving the schema alone is what keeps `Node.eq`
 * block pairing and the reparse net below meaning exactly what they meant before.
 *
 * Patched onto the shared parser rather than passed in its token spec: that spec takes only
 * `{block}`/`{node}`/`{mark}`/`{ignore}` descriptors and rejects a plain function. `tokenHandlers`
 * is the object prosemirror-markdown derives from it, and it seeds this key with
 * `handlers.softbreak ||= …`, so assigning here is the supported way past the default. Same shape
 * as the daemon configuring its one renderer at module load (daemon/src/artifact-render.ts).
 */
defaultMarkdownParser.tokenHandlers.softbreak = (state) => state.addText("\n");

/** DOM-free halves of the editor, exported for tests: what the rich face parses and persists. */
export function parseMarkdown(markdown) {
  return defaultMarkdownParser.parse(markdown ?? "");
}

export function serializeMarkdown(doc) {
  return mdSerializer.serialize(doc);
}

/** Serializes a run of top-level nodes on their own, so a changed block can be written back
 * without dragging the rest of the document through the serializer. */
function serializeNodes(nodes) {
  return mdSerializer.serialize(markdownSchema.node("doc", null, nodes));
}

/** True for the document prosemirror-markdown produces from an empty string: the schema requires
 * at least one block, so "nothing" is one empty paragraph rather than no children. */
function isBlankDoc(doc) {
  return doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild.content.size === 0);
}

/**
 * Where each top-level block of `source` came from, in document order: `{start, end}` character
 * offsets bounding the block's own bytes, its trailing line ending excluded.
 *
 * markdown-it's block tokens carry a source line `map` — the same map the daemon's `data-line`
 * stamping anchors on — and `defaultMarkdownParser.tokenizer` IS that markdown-it instance, so the
 * rich face can learn where every block came from without a second parser or a vendored rebuild.
 * Lines resolve against the RAW source rather than markdown-it's normalized copy, and line endings
 * are left in the gaps between blocks rather than inside them, so a CRLF file keeps its `\r` bytes
 * whether a block is copied or re-serialized.
 *
 * Everything between two blocks — blank lines, and link reference definitions, which produce
 * neither a token nor a node — falls outside every span and is therefore copied untouched.
 */
function blockLayout(source) {
  const lineStart = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStart.push(i + 1);
  const at = (line) => (line < lineStart.length ? lineStart[line] : source.length);
  const blocks = [];
  for (const token of defaultMarkdownParser.tokenizer.parse(source, {})) {
    // Top level only: an opening or self-closing token at nesting depth zero. Its closing partner
    // reports the same level, hence the `nesting` test rather than a depth counter.
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const start = at(token.map[0]);
    const body = source.slice(start, at(token.map[1])).replace(/(\r?\n)+$/, "");
    blocks.push({ start, end: start + body.length });
  }
  return blocks;
}

/**
 * Pairs the blocks the writer did not touch, by tree equality.
 *
 * `Node.eq` compares trees, not spelling, so `*em*` and `_em_` are one node to this. The backtrack
 * therefore prefers matches on the diagonal: in the ordinary case — one edited block, the rest in
 * place — that keeps every kept block paired with the block it actually came from, instead of
 * pairing two look-alike blocks crosswise and swapping their source spellings.
 */
function pairUnchangedBlocks(original, edited) {
  const n = original.length;
  const m = edited.length;
  const common = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i][j] = original[i].eq(edited[j])
        ? common[i + 1][j + 1] + 1
        : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (original[i].eq(edited[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (common[i + 1][j] > common[i][j + 1]) i += 1;
    else if (common[i + 1][j] < common[i][j + 1]) j += 1;
    else if (i > j)
      j += 1; // a tie: step whichever side is behind, to stay on the diagonal
    else i += 1;
  }
  return pairs;
}

/** A save that rewrote the whole file: what the rich face did before block splicing existed. The
 * caller must never write this without asking, which is what `degraded` is for. */
function wholeDocument(editedDoc, reason) {
  return { markdown: serializeMarkdown(editedDoc), collateral: [], degraded: reason };
}

/**
 * Binds a splice to one baseline — the exact string the editor was opened over, and the document
 * parsed from it. Returns `splice(editedDoc)`.
 *
 * The baseline never changes for an editor's lifetime, so its block layout is computed once here
 * rather than on every save, park, and face switch.
 */
export function createSplicer(source, originalDoc) {
  // A lone `\r` is a line break to markdown-it but not to a `\n` scan, which would slide every
  // block offset out from under the token maps. Classic-Mac endings are vanishingly rare and not
  // worth splicing carefully; refuse rather than corrupt.
  const scannable = !/\r(?!\n)/.test(source);
  const blocks = scannable ? blockLayout(source) : [];
  const original = originalDoc.content.content;
  const body = (index) => source.slice(blocks[index].start, blocks[index].end);
  /** The original bytes between block `index - 1` and block `index`: line ending plus blank lines. */
  const separator = (index) => source.slice(blocks[index - 1].end, blocks[index].start);

  return function splice(editedDoc) {
    if (!scannable) return wholeDocument(editedDoc, "line-endings");
    // A blank source has no block tokens at all, yet still parses to one empty paragraph, so the
    // counts disagree legitimately. Keep the writer's whitespace; append whatever they typed.
    if (blocks.length === 0) {
      return {
        markdown: isBlankDoc(editedDoc) ? source : source + serializeMarkdown(editedDoc),
        collateral: [],
        degraded: false,
      };
    }
    // Any other disagreement is a pairing this does not understand. Say so rather than splicing
    // bytes against blocks that may not line up.
    if (blocks.length !== original.length) return wholeDocument(editedDoc, "block-mismatch");

    const edited = editedDoc.content.content;
    const pairs = pairUnchangedBlocks(original, edited);
    // Originals nothing matched. A block that was moved rather than rewritten reappears in the
    // edited document as an insertion; finding it here lets its ORIGINAL bytes move with it,
    // instead of a re-serialization that would quietly restyle a block nobody edited.
    const moved = new Set(original.map((_, index) => index));
    for (const [index] of pairs) moved.delete(index);

    const collateral = [];
    const pieces = [];
    let o = 0;
    let e = 0;
    let p = 0;
    while (o < original.length || e < edited.length) {
      const pair = pairs[p];
      if (pair && pair[0] === o && pair[1] === e) {
        pieces.push({ text: body(o), before: o > 0 ? separator(o) : "\n\n" });
        o += 1;
        e += 1;
        p += 1;
        continue;
      }
      const nextO = pair ? pair[0] : original.length;
      const nextE = pair ? pair[1] : edited.length;
      const inserted = edited.slice(e, nextE);
      if (inserted.length && o < nextO) {
        const replaced = source.slice(blocks[o].start, blocks[nextO - 1].end);
        const written = serializeNodes(inserted);
        const faithful = serializeNodes(original.slice(o, nextO));
        if (faithful !== replaced) collateral.push({ original: replaced, faithful, written });
        pieces.push({ text: written, before: o > 0 ? separator(o) : "\n\n" });
      } else if (inserted.length) {
        // A pure insertion owns no original bytes, so it gets a blank line of its own rather than
        // borrowing the separator that still belongs to the block it was typed in front of.
        const text = inserted
          .map((node) => {
            for (const index of moved) {
              if (!original[index].eq(node)) continue;
              moved.delete(index);
              return body(index);
            }
            return serializeNodes([node]);
          })
          .join("\n\n");
        pieces.push({ text, before: "\n\n" });
      }
      o = nextO;
      e = nextE;
    }

    let markdown = source.slice(0, blocks[0].start);
    for (const [index, piece] of pieces.entries()) markdown += (index === 0 ? "" : piece.before) + piece.text;
    markdown += source.slice(blocks[blocks.length - 1].end);

    // The safety net that makes this scheme sound rather than merely well-tested: if the spliced
    // bytes do not parse back to the document the writer is looking at, the splice is wrong about
    // some construct, and no amount of enumerating markdown corner cases would have told us. Fall
    // back to the honest-but-blunt whole-document write, flagged so the caller has to ask.
    if (!parseMarkdown(markdown).eq(editedDoc)) return wholeDocument(editedDoc, "reparse");
    return { markdown, collateral, degraded: false };
  };
}

/**
 * One-shot splice, for callers that hold no editor: writes `editedDoc` back over `source`,
 * re-serializing ONLY the blocks whose tree changed and copying every other block's original bytes
 * verbatim. This is what makes a save honest — outside the blocks the writer edited the file is
 * byte-identical, so nothing reaching the agent as a `human_edit` was invented by the serializer.
 *
 * Returns `{markdown, collateral, degraded}`.
 *
 * `collateral` lists the edited blocks the serializer cannot reproduce faithfully — an escaped
 * bracket, a soft line break joined into a space. It is found by round-tripping the block's
 * ORIGINAL nodes and comparing against its original bytes, so it reports what re-serializing that
 * block costs regardless of what the writer changed inside it. `degraded` is a short reason string
 * when the whole document had to be re-serialized instead. Both are the caller's cue to ask before
 * writing; neither is ever written silently (see artifact-pane.js).
 */
export function spliceMarkdown(source, originalDoc, editedDoc) {
  return createSplicer(source, originalDoc)(editedDoc);
}

/** Markdown-reflex input rules so the editor keeps the writer's muscle memory: `# ` headings,
 * `> ` quote, `- ` / `1. ` lists — typed at a block start, they become the structure they name. */
function markdownInputRules(schema) {
  const rules = [
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({ level: match[1].length })),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + (node.attrs.order ?? 1) === Number(match[1]),
    ),
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
    {
      label: "B",
      aria: "Bold",
      command: () => toggleMark(schema.marks.strong),
      active: markActive(schema.marks.strong),
      className: "glosa-rich-b",
    },
    {
      label: "I",
      aria: "Italic",
      command: () => toggleMark(schema.marks.em),
      active: markActive(schema.marks.em),
      className: "glosa-rich-i",
    },
    {
      label: "Code",
      aria: "Inline code",
      command: () => toggleMark(schema.marks.code),
      active: markActive(schema.marks.code),
    },
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
 * app.css). Returns {getSave, getMarkdown, isDirty, focus, destroy}, where `getSave()` is the
 * splice report the caller must consult before writing and `getMarkdown()` is its text alone, for
 * callers that only need to carry the document somewhere (the source face, a parked draft).
 * Throws if the environment can't host a ProseMirror view (e.g. a DOM without layout APIs) — the
 * caller falls back to source mode.
 */
export function mountRichEditor(container, { markdown, onDirty } = {}) {
  const schema = markdownSchema;
  const source = markdown ?? "";
  const doc = parseMarkdown(source);
  const splice = createSplicer(source, doc);
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
    getSave: () => splice(view.state.doc),
    getMarkdown: () => splice(view.state.doc).markdown,
    isDirty: () => dirty,
    focus: () => view.focus(),
    destroy: () => {
      view.destroy();
      container.textContent = "";
    },
  };
}
