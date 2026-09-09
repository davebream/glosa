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
// the writer did not touch — CommonMark has no node for callout markers, `%%` comments, or raw
// HTML — `getSave()` reports that collateral instead of writing it, and artifact-pane.js asks
// first. A single newline inside a paragraph is NOT one of those cases: CommonMark has no node
// for it either, but this file never needed one — a bare `\n` in a text node carries it, all the
// way from the markdown parse (#173) through a live `EditorView` keypress (#183) — so it is
// preserved rather than reported, in a root paragraph, one inside a blockquote, or one inside a
// list item alike.
//
// Talks to the daemon through NOTHING — pure editor over a string; artifact-pane.js owns save and
// dirty wiring (see test/import-boundary.test.ts).
import {
  EditorState,
  EditorView,
  markdownSchema,
  Schema,
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
    glosa_raw(state, node) {
      // `false` = do not escape. These bytes are the file's own; escaping them is the corruption
      // contracts.md C1.4 exists to prevent, and it is what makes T2's reparse-based verification
      // trivially satisfiable on a raw block rather than starting to fail on one.
      state.text(node.textContent, false);
      state.closeBlock(node);
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
/** A document's metadata header — `---` before any block content, a non-blank line under it, closed
 *  by a later `---` at column 0, trailing whitespace ignored on both fences — is a construct
 *  CommonMark cannot model. It reads as a thematic break plus a setext heading, so re-serializing it
 *  writes `## title: …`, the reparse net then refuses the result, and the WHOLE document goes down
 *  the `degraded: "reparse"` fallback: a one-word edit to `status:` rewrites the file and lands all
 *  of it on the agent's side as one `human_edit`. One token, one node, its own bytes.
 *
 *  THE NON-BLANK GUARD IS LOAD-BEARING, not tidiness: without it a document that opens with a
 *  thematic break and contains a second one is swallowed whole into a monospaced slab. Measured both
 *  ways. It resolves the blank-line-separated half of that ambiguity only; the other half is accepted
 *  and pinned (design §3.2), because `---\nkey: value\n---` and `---\ntext\n---` are the same shape
 *  and nothing short of YAML validation separates them.
 *
 *  THE trimEnd IS ALSO LOAD-BEARING: without it one trailing space on either fence defeats the
 *  recogniser entirely and an edit inside the header falls back to the whole-file rewrite — the
 *  unmodified #143 damage, in a spelling ordinary editors produce. Measured, on both fences and with
 *  a tab.
 *
 *  `---` only. `+++` is an ordinary paragraph to CommonMark, so making it opaque would CHANGE
 *  rendering rather than preserve it; `----` is a thematic break. Widening the fence is one edit to
 *  the constant below plus one control; do it when a document needs it, not before. */
const RAW_NODE = "glosa_raw";
const HEADER_FENCE = "---";

/** `state.tokens.length !== 0` means "before any block content" — root-only AND admitting leading
 *  blank lines, which emit no token. Deliberately NOT `startLine !== 0`: under that, a file opening
 *  with a stray blank line keeps taking the whole-file `reparse` path, which is the damage this rule
 *  exists to remove. */
function metadataHeaderRule(state, startLine, endLine, silent) {
  if (state.tokens.length !== 0) return false;
  if (state.sCount[startLine] - state.blkIndent !== 0) return false;
  const line = (n) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  if (line(startLine).trimEnd() !== HEADER_FENCE) return false;
  // The non-blank guard. A blank line under the fence means a thematic break, not a header.
  if (startLine + 1 >= endLine || state.isEmpty(startLine + 1)) return false;

  let close = -1;
  for (let n = startLine + 1; n < endLine; n += 1) {
    if (state.sCount[n] - state.blkIndent !== 0) continue;
    if (line(n).trimEnd() === HEADER_FENCE) {
      close = n;
      break;
    }
  }
  // An unclosed `---` is a thematic break, not a header.
  if (close === -1) return false;
  if (silent) return true;

  const token = state.push(RAW_NODE, "", 0);
  token.block = true;
  token.map = [startLine, close + 1];
  // `keepLastLF: false`. THE CHOICE IS INERT AND THAT IS WORTH WRITING DOWN: both variants produce
  // byte-identical node text over every header shape measured, but only because `noCloseToken`
  // routes through prosemirror-markdown's `withoutTrailingNewline`, which strips exactly one `\n`.
  // That is the vendored bundle's property, not this rule's. `false` is the variant that stays
  // correct if the bundle ever stops stripping, because `blockLayout` already excludes a block's
  // trailing line ending from its span and the node's text must match that span.
  token.content = state.getLines(startLine, close + 1, 0, false);
  token.markup = HEADER_FENCE;
  state.line = close + 1;
  return true;
}

// From here on `defaultMarkdownParser` is only the SOURCE of three things — the tokenizer instance,
// the token map, and the parser class. It no longer parses anything: `parseMarkdown` resolves through
// `editorParser` below, and a second parse path in this file would silently reopen #173.
defaultMarkdownParser.tokenizer.block.ruler.before("hr", RAW_NODE, metadataHeaderRule, { alt: [] });

/** #183's lever. `paragraph`'s inherited spec carries no whitespace policy, and the vendored
 *  bundle's OWN change-reading path (`EditorView`'s `readDOMChange`) already asks for
 *  `preserveWhitespace: true` — never `false` — whenever a keypress lands inside one. Traced in the
 *  minified bundle rather than assumed: `addTextNode`'s branch for that value keeps every OTHER
 *  whitespace byte untouched (multiple spaces, tabs, leading indentation all survive already,
 *  "true" and "full" are identical there) and does exactly one thing differently — an embedded
 *  newline. Without a schema-level lever it is rewritten to a single space, which is the whole of
 *  #183: the one construct that value silently discards is the one #173 chose to carry as a bare
 *  `\n` IN TEXT rather than as a node.
 *
 *  THE NODE-BASED LEVER (`NodeSpec.linebreakReplacement`, ProseMirror's own designed-for-this
 *  mechanism) was tried first and is why this is a comment and not just a one-line diff. It
 *  resolves the SAME branch by splitting the changed text on `\n` and inserting a dedicated leaf
 *  node instead of collapsing to a space — but that node would have to be `paragraph`-legal
 *  everywhere `\n` already survives on the PARSE side, and `heading` here is `(text | image)*`
 *  (the round-trip test below spells out why: a setext heading spanning lines already depends on
 *  its break staying inside one text run, and a node the content expression refuses does not make
 *  the node fail quietly — it makes the whole block fail to build). Moving softbreak's OWN handler
 *  to build that node would need heading's content expression to admit it too, which reopens
 *  exactly the parse-side redesign #173 chose not to do, for a schema this file does not own via
 *  the DOM half alone. Inside THIS ONE CALL, `preserveWhitespace: "full"` costs nothing measurable
 *  BECAUSE `addTextNode` never reaches the branch that would collapse an ordinary run of spaces
 *  either way — the only branch "full" changes there is the one already reserved for `\n` and
 *  `\r`. That is a claim about `readDOMChange` specifically, not about the node spec as a whole —
 *  see `PARAGRAPH_SPEC`'s own comment below for where that distinction stopped being free.
 *
 *  Scoped to `paragraph` alone: every hand-wrapped break this repo's own issue reports on — a root
 *  paragraph, one inside a blockquote, one inside a list item — is this one node type, wherever it
 *  sits. A heading spanning two source lines keeps today's pre-#183 behaviour (a keypress inside it
 *  still costs the break); nothing here makes that case WORSE, and extending the same lever to
 *  `heading` is a narrower follow-up, not a prerequisite. */
const INHERITED_PARAGRAPH_SPEC = markdownSchema.spec.nodes.get("paragraph");
const PARAGRAPH_SPEC = {
  ...INHERITED_PARAGRAPH_SPEC,
  whitespace: "pre",
  // NARROWED TO THE CHANGE-READING PATH, measured rather than assumed (a real-browser paste check
  // pinned it): `whitespace: "pre"` alone is schema-wide, not scoped to `readDOMChange`. Any
  // OTHER caller that runs `<p>` elements through the vendored `DOMParser`'s ordinary rule-matching
  // — paste is the reachable one, since `EditorView` wires up its own paste handling by default —
  // reaches the exact same node-type fallback in `Ai()`/`addTextNode` this file's own top comment
  // traces, and inherits `whitespace: "pre"` from the TYPE rather than from `readDOMChange`'s own
  // call site. Measured with a synthetic `ClipboardEvent` against this schema before this line
  // existed: pasting `<p>alpha  beta   gamma</p>` kept the extra spaces verbatim in `getSave()`'s
  // own markdown, a tab survived literally, and `<p>   indented</p>` kept its leading spaces —
  // none of which the unmodified schema did (ordinary HTML-paste collapse: single spaces, no
  // leading whitespace). None of that is "the writer typed it": CommonMark and every other
  // markdown surface in this repo collapse exactly those runs, and inventing them into a saved
  // file on paste is the same class of dishonesty #174 exists to prevent, just on the other side.
  //
  // `readDOMChange`'s own parse call never matches this rule at all — it hands the changed
  // paragraph in as `topNode`/`topOpen: true` and reads `h.parent.type.whitespace` directly
  // (this file's earlier comment traces that call site), bypassing `parseDOM` rule-matching for
  // the paragraph's own wrapper entirely. So an explicit `preserveWhitespace: false` on the RULE
  // only reaches callers that DO rule-match a `<p>` tag — paste, and any future full-document
  // DOM parse — while `readDOMChange`'s keypress fix, which never consults this rule, is
  // unaffected. `rich-editor-browser-roundtrip.test.ts`'s own paste check pins all four cases
  // (multi-space run, tab, leading indentation, and a raw `\n` inside pasted markup) as
  // byte-identical to the unmodified schema, reading back the file the real save route wrote, not
  // only `getSave()`'s own report — and bypassing only this line, with `whitespace: "pre"` above
  // left in place, turns that same check red on exactly this behavior (retained ablation).
  parseDOM: [{ ...INHERITED_PARAGRAPH_SPEC.parseDOM[0], preserveWhitespace: false }],
};

/** The schema the rich face actually runs on: CommonMark plus the one node above.
 *
 *  `isolating: true` is not decoration — it is what stops a `Backspace` at the head of the following
 *  paragraph lifting prose up into the YAML. `marks: ""` and `code: true` say the bytes are literal:
 *  nothing inside a metadata header is emphasis or a link. */
export const editorSchema = new Schema({
  nodes: markdownSchema.spec.nodes.update("paragraph", PARAGRAPH_SPEC).addToEnd(RAW_NODE, {
    content: "text*",
    group: "block",
    marks: "",
    code: true,
    defining: true,
    isolating: true,
    toDOM: () => ["pre", { class: "glosa-raw" }, ["code", 0]],
    parseDOM: [{ tag: "pre.glosa-raw", preserveWhitespace: "full" }],
  }),
  marks: markdownSchema.spec.marks,
});

/** `MarkdownParser` is not on the vendored export list; its constructor is. Same tokenizer instance
 *  as before — that is what keeps `blockLayout` and `parseMarkdown` reading one token stream, so a
 *  block rule can never exist on one without a token-map entry on the other. */
const editorParser = new defaultMarkdownParser.constructor(editorSchema, defaultMarkdownParser.tokenizer, {
  ...defaultMarkdownParser.tokens,
  [RAW_NODE]: { block: RAW_NODE, noCloseToken: true },
});

/** #173's soft break, moved onto the parser `parseMarkdown` actually resolves through.
 *
 *  MOVED, NOT DUPLICATED. Patching `defaultMarkdownParser` here would apply to a parser nothing
 *  calls, and soft breaks would silently collapse back into spaces — the one loss in this file that
 *  no round trip undoes. A second softbreak handler in this file is a bug for the same reason:
 *  `parseMarkdown` resolves through exactly one parser, and this is it. */
editorParser.tokenHandlers.softbreak = (state) => state.addText("\n");

/** DOM-free halves of the editor, exported for tests: what the rich face parses and persists. */
export function parseMarkdown(markdown) {
  return editorParser.parse(markdown ?? "");
}

export function serializeMarkdown(doc) {
  const raw = mdSerializer.serialize(doc);
  // T5's opt-out (contracts.md C1.2), and THIS is the path where it does the work rather than
  // merely restating what the check below would have said. The baseline here is relative — what the
  // serializer's own output parses to — and that baseline is closed under this schema whatever `doc`
  // holds, so an opaque node changes neither side of the comparison and the relaxation is accepted
  // over its verbatim bytes. See `MODELLED_NODE_TYPES` for why a tree comparison is not a backstop.
  if (!runIsModelled([doc])) return raw;
  // The baseline here is RELATIVE — what the serializer's OWN output parses to, so the question is
  // "does dropping the escapes change what that output means?" — not absolute against `doc`.
  // Reaching this path does not imply the document failed to round-trip: `wholeDocument()` also
  // arrives here for a file refused over its lone-`\r` line endings, and the blank-source branch
  // below calls in with nothing degraded at all. The relative baseline costs nothing on those,
  // because for a document that IS a fixed point the two coincide exactly, and it is strictly better
  // on the ones that are not, where an absolute check would fail for reasons that have nothing to do
  // with escaping and would refuse every relaxation on exactly the documents that need one — the
  // #143 fixture among them, whose front matter alone breaks the round trip.
  //
  // No reference context: this path holds no source bytes, so there are no definitions to read out
  // of one. Both sides are therefore parsed the same way, which is what the comparison needs.
  return relaxEscapes(raw, (relaxed) => verifiesAs(relaxed, "", parseMarkdown(raw).content.content));
}

/** Serializes a run of top-level nodes on their own, so a changed block can be written back
 * without dragging the rest of the document through the serializer. */
function serializeNodes(nodes) {
  return mdSerializer.serialize(editorSchema.node("doc", null, nodes));
}

/**
 * The node and mark types the two byte-faithful mechanisms below are allowed to touch: exactly
 * prosemirror-markdown's CommonMark inventory — `markdownSchema.nodes` and `markdownSchema.marks`,
 * both spelled out in full rather than read off the schema at run time.
 *
 * THIS IS AN OPT-OUT FOR T5'S OPAQUE NODES (contracts.md C1.2), not a micro-optimization, and the
 * spelling-out is the point. T5 (#143) gives front matter a node whose serialization IS its literal
 * source bytes, over a schema DERIVED from this one — so reading the inventory off whatever schema
 * `serializeNodes()` happens to use would enrol that node automatically and silently, which is the
 * one thing this must not do. Dropping a backslash or re-encoding an entity inside bytes that are
 * already verbatim corrupts them, and the tree comparison downstream is not a reliable backstop
 * there: it only catches such a change if the opaque node's own parse is byte-exact, which is a
 * property of T5's parser rather than of this file.
 *
 * So: DENY BY DEFAULT. A type nobody has vouched for here gets the serializer's own output and
 * nothing else, and a type added to a schema later has to be added here deliberately before either
 * mechanism will touch a run containing it.
 *
 * Frozen arrays rather than sets because they are exported, and because a linear scan of twelve
 * names per node is nothing beside the reparse each mechanism is about to spend. Exported so a test
 * can hold them against `markdownSchema`'s own inventory in BOTH directions: a name the schema has
 * and this list lacks would drop ordinary documents onto the raw path, and a name here that the
 * schema does not have is dead weight that would mislead whoever reads this next.
 */
export const MODELLED_NODE_TYPES = Object.freeze([
  "doc",
  "paragraph",
  "blockquote",
  "horizontal_rule",
  "heading",
  "code_block",
  "ordered_list",
  "bullet_list",
  "list_item",
  "text",
  "image",
  "hard_break",
]);
export const MODELLED_MARK_TYPES = Object.freeze(["em", "strong", "link", "code"]);

/** Whether `node`'s own type, and every mark it carries, is one this file models. */
function nodeIsModelled(node) {
  if (!MODELLED_NODE_TYPES.includes(node.type.name)) return false;
  return node.marks.every((mark) => MODELLED_MARK_TYPES.includes(mark.type.name));
}

/**
 * Whether every node in `nodes` is modelled, AT EVERY DEPTH AND INCLUDING ITS MARKS.
 *
 * Both halves are load-bearing. `descendants` walks nodes only, so the marks have to be asked for
 * separately at each stop — a node-only walk reads as correct while checking half the inventory,
 * and a `link` mark on text inside a list item inside a blockquote is still a mark. And the walk
 * has to reach every depth: `serializeNodes()` renders the whole subtree, so an opaque node buried
 * three levels down contributes its bytes to the string the mechanisms then rewrite.
 *
 * Exported for tests, on the same grounds as `parseMarkdown` and `serializeMarkdown` above.
 */
export function runIsModelled(nodes) {
  return nodes.every((node) => {
    let modelled = nodeIsModelled(node);
    node.descendants((child) => {
      if (modelled) modelled = nodeIsModelled(child);
      // Stop descending once something is unmodelled; the answer cannot come back.
      return modelled;
    });
    return modelled;
  });
}

/** The characters prosemirror-markdown's `esc()` escapes inside text, unconditionally: it does not
 * ask whether leaving one bare would actually mean anything. Line-start escapes (`\#`, `\-`, `\+ `,
 * `\>`, `\1.`) are a separate rule in the same function and are deliberately NOT in this set. */
const ESCAPED_IN_TEXT = /\\([`*\\~[\]_])/g;

/**
 * Drops the escapes the serializer added and keeps the result only if `verify` says the tree is
 * unchanged. The file said `[!info]`; the serializer says `\[!info\]`; both mean the same thing,
 * so the writer's file should keep saying what it said.
 *
 * ALL-OR-NOTHING, DELIBERATELY — every escape goes or none does. A greedy per-escape variant was
 * implemented and measured, and it is unsafe: given `This is \*not emphasis\* here.` it drops the
 * FIRST backslash only, because `*not emphasis\*` has no closing delimiter and so still parses to
 * the same text, and it writes `This is *not emphasis\* here.` — a spelling that is neither the
 * serializer's nor the file's. Do not "improve" this into a per-escape fallback.
 *
 * The cost of being conservative is that a block holding one load-bearing escape keeps all of its
 * escapes. Where the block's own source bytes exist, that spelling is recoverable from them.
 */
function relaxEscapes(raw, verify) {
  const relaxed = raw.replace(ESCAPED_IN_TEXT, "$1");
  if (relaxed === raw) return raw;
  return verify(relaxed) ? relaxed : raw;
}

/** Whether `doc` is exactly the run of top-level `nodes`, child for child. Spelled out rather than
 * built into a throwaway `doc` node so `serializeNodes()`'s own expression stays untouched. */
function sameNodes(doc, nodes) {
  if (doc.childCount !== nodes.length) return false;
  for (let index = 0; index < nodes.length; index += 1) if (!doc.child(index).eq(nodes[index])) return false;
  return true;
}

/**
 * Whether `candidate`, read in the reference context its bytes will actually live in, means exactly
 * `baseline`. The one place that decides a candidate spelling is safe to write.
 *
 * THE SUFFIX IS LOAD-BEARING, not a refinement. A reference link whose definition is out of scope
 * parses to plain text, so the same bytes say different things alone and in the file that defines
 * the label. Verify `See [r] there.` on its own and the de-escape of a source that really spelled
 * `\[r\]` is accepted, because in isolation the brackets are still literal; spliced back into the
 * document they are a live link, the whole-document reparse net below rejects the save, and the
 * fallback rewrite drops the definition — the writer loses a line they never touched. With the
 * definitions in scope the candidate parses as a link, the baseline says text, and the relaxation
 * is refused where it should be.
 *
 * `baseline` is always a run of top-level nodes, and which run it is decides the predicate's
 * character. Per block it is the run being serialized, which makes the check ABSOLUTE (REQ-7).
 * For the whole document it is what the serializer's own output parses to, which makes it relative.
 * Nothing in between: a per-block hybrid falling back to the relative baseline on a block that does
 * not round-trip was measured and costs 2 of the corpus's 418 blocks, because on a lossy block the
 * absolute baseline is precisely what lets the source spelling be restored in full.
 */
function verifiesAs(candidate, referenceSuffix, baseline) {
  return sameNodes(parseMarkdown(candidate + referenceSuffix), baseline);
}

/** How the source restoration below reads both sides: words, WHITESPACE RUNS, and single other
 * characters.
 *
 * The whitespace RUN is a run on purpose. Reading whitespace one character at a time roughly doubles
 * the token count of ordinary prose and so quadruples the LCS matrix — this repository's largest
 * block goes from 3.6M cells to about 14M — and it lets an alignment slide along inside a stretch of
 * spaces, which is the opposite of what a restoration wants. Both reasons are about keeping a
 * difference where it actually is. An ad-hoc "merge runs separated by a short common gap" rule was
 * measured as the alternative and rejected: every threshold that fixed one case broke another, and
 * the largest produced a half-escaped spelling the file never contained.
 *
 * MEASURED, so that a later reader is not told something this file cannot back up: the run token was
 * specified to keep the serializer's `` `git   add` `` against the file's `` `git\n  add` `` in ONE
 * run, on the reasoning that two runs only verify together and the break inside the code span would
 * be lost for good. In this implementation that case survives per-character whitespace too, under
 * either backtrack — the diagonal tie-break in `diffRuns` is what actually holds it — so no test
 * here fails if this is narrowed to `\s`. Going the other way costs one block of this repository
 * (the `&nbsp;·&nbsp;` pair before an edited word in README.md restores per-character and not per
 * run), which is why the run stands: the matrix, and the locality. Not because that one case needs it.
 *
 * Every character is a word character, whitespace, or neither, so `tokenize(s).join("") === s` and
 * the restoration only ever reassembles pieces of the two strings it was handed. */
const RESTORE_TOKEN = /\w+|\s+|[^\w\s]/g;

function tokenize(text) {
  return text.match(RESTORE_TOKEN) ?? [];
}

/** The LCS matrix the restoration refuses to fill. Past it restoration is skipped entirely and the
 * serializer's own output is written — exactly what this file did before the restoration existed:
 * the collateral guard still reports, nothing is corrupted. The corpus's worst top-level block is
 * 1896 tokens against 1896 (3.59M cells, ~14 MiB, ~19 ms), and a test asserts that no block in the
 * nine hand-written documents comes near this, so the number stays checkable rather than assumed. */
const MAX_RESTORE_CELLS = 24_000_000;

/**
 * Groups every place `a` and `b` disagree into runs, by token LCS: `{a0, a1, b0, b1}` half-open on
 * each side, in order, with the tokens between two runs identical on both sides.
 *
 * A run is zero-width on one side when it is a pure insertion or deletion — the serializer adding
 * bytes the file never had, or dropping bytes it did. Hand-written rather than imported, on the same
 * grounds as `pairUnchangedBlocks` above: this module imports the vendored bundle and nothing else.
 */
function diffRuns(a, b) {
  const n = a.length;
  const m = b.length;
  const common = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const runs = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const a0 = i;
    const b0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j >= m) i += 1;
      else if (i >= n) j += 1;
      // PREFER THE DIAGONAL, exactly as `pairUnchangedBlocks` above does and for the same reason.
      // Several alignments tie at the same number of matched tokens, and which one the backtrack
      // walks decides whether a run stays where it is or drifts across the block. Measured on this
      // repository's `## [0.1.0-alpha.12]` headings: writing the destination out inline puts a
      // second `alpha` in the serializer's output, a drifting backtrack matches the FILE's `alpha`
      // against that copy, and the writer's edited word ends up inside the same run as the inlined
      // destination — one run, so it is all-or-nothing, so neither is ever put back. Stepping both
      // sides on a tie keeps the substitution where the writer made it and leaves the destination
      // its own run. Same token count, 13 of CHANGELOG.md's headings restored instead of none.
      else if (common[i + 1][j + 1] === common[i][j]) {
        i += 1;
        j += 1;
      } else if (common[i + 1][j] >= common[i][j + 1]) i += 1;
      else j += 1;
    }
    runs.push({ a0, a1: i, b0, b1: j });
  }
  return runs;
}

/** `diffRuns` behind the budget: `null` when the matrix is too large to fill. Two callers read
 * that `null` differently and both are right — the restoration returns the serializer's own bytes,
 * and the collateral guard reports, because a write it cannot prove honest is one to ask about. */
function diffRunsWithin(a, b) {
  if ((a.length + 1) * (b.length + 1) > MAX_RESTORE_CELLS) return null;
  return diffRuns(a, b);
}

/** `a` with the runs `restored[k]` marks taken from `b` instead. Outside the runs the two token
 * streams are identical, so which side those pieces come from cannot matter. */
function applyRuns(a, b, runs, restored) {
  let text = "";
  let cursor = 0;
  for (const [index, run] of runs.entries()) {
    text += a.slice(cursor, run.a0).join("");
    text += (restored[index] ? b.slice(run.b0, run.b1) : a.slice(run.a0, run.a1)).join("");
    cursor = run.a1;
  }
  return text + a.slice(cursor).join("");
}

const isWhitespaceToken = (token) => /^\s+$/.test(token);
const isFenceToken = (token) => token === "`" || token === "~";

/** Whether a run is whitespace on both sides — exact, not a heuristic, since `RESTORE_TOKEN` never
 * puts a word character in a whitespace token. */
function isWhitespaceOnlyRun(a, b, run) {
  return a.slice(run.a0, run.a1).every(isWhitespaceToken) && b.slice(run.b0, run.b1).every(isWhitespaceToken);
}

/** Whether a run's OUTPUT side touches a fence delimiter — the token right before it or right
 * after it is a backtick or tilde. `serializeNodes()` always writes a fence as a run of those
 * characters, one token each (`RESTORE_TOKEN` has no repetition for `[^\w\s]`), so the first or
 * last character of the delimiter is enough to detect it. */
function isFenceAdjacentRun(a, run) {
  return isFenceToken(a[run.a0 - 1] ?? "") || isFenceToken(a[run.a1] ?? "");
}

/**
 * Peels a purely-whitespace leading/trailing token off a run wherever both sides agree, at that
 * position, that the token is whitespace (not that its value matches — only its kind). `diffRuns`
 * only merges a whitespace difference into a word difference when nothing separates them — an
 * edited word sitting directly against an inserted blank line — so peeling there recovers the
 * whitespace half as its own run without ever touching the word token beside it.
 *
 * Gated on equal token counts on both sides of the whole run: an entity decode can merge several
 * source tokens (`&nbsp; ` is four) into one collapsed run of output whitespace, and peeling the
 * first token of each side there would pair a whole entity against a single space and, because
 * CommonMark collapses whitespace runs, that partial trade can verify by itself — silently
 * stranding the rest of the entity unrestored. A run with matching token counts on both sides
 * doesn't have that shape; a mismatched one is returned unpeeled, exactly as before this existed.
 */
function peelWhitespaceBoundary(a, b, run) {
  let { a0, a1, b0, b1 } = run;
  if (a1 - a0 !== b1 - b0) return [run];
  const leading = [];
  while (a0 < a1 && b0 < b1 && isWhitespaceToken(a[a0]) && isWhitespaceToken(b[b0])) {
    leading.push({ a0, a1: a0 + 1, b0, b1: b0 + 1 });
    a0 += 1;
    b0 += 1;
  }
  const trailing = [];
  while (a1 > a0 && b1 > b0 && isWhitespaceToken(a[a1 - 1]) && isWhitespaceToken(b[b1 - 1])) {
    trailing.unshift({ a0: a1 - 1, a1, b0: b1 - 1, b1 });
    a1 -= 1;
    b1 -= 1;
  }
  const core = a0 < a1 || b0 < b1 ? [{ a0, a1, b0, b1 }] : [];
  return [...leading, ...core, ...trailing];
}

/**
 * M2 — source-spelling restoration. Wherever the serializer's `output` disagrees with the block's
 * own `source` bytes, propose putting the source spelling back, and keep a proposal only if the
 * candidate still means exactly what the writer's tree means.
 *
 * Every run at once first, which is one reparse in the common case and is by construction the source
 * itself for a block whose tree did not change. If that fails, runs go in one at a time, each kept
 * only if the candidate still verifies. On any failure the input comes back untouched.
 *
 * ONE BOUNDED REFINEMENT SITS AFTER THAT PASS, for #184: a fenced code block's serializer output
 * carries a blank line before and after it regardless of the source list's own tightness, and
 * CommonMark's tight/loose is one attribute of the whole list — so restoring only one of the two
 * invented blank lines still leaves the list reading loose, and the per-run pass, trying them one
 * at a time, can put neither back. `peelWhitespaceBoundary` first separates such a blank line from
 * an edited word landing right beside it, when the two were merged into one run because nothing
 * else was between them; the retry below then restores every rejected run that is BOTH
 * whitespace-only AND touches a fence delimiter, together, once.
 *
 * Restricted to fence-adjacent runs deliberately, not every rejected whitespace-only run: `verify`
 * is tree equality, and a list's tight/loose attribute does not record WHICH blank line made it
 * loose, so a candidate that puts the wrong one back can still verify. Scoping the retry to the
 * pair the fence itself produces keeps an unrelated whitespace edit elsewhere in the same block —
 * including one that is itself whitespace-only, which a writer's edit can be — out of the group
 * entirely, rather than relying on the group's own verify to catch it after the fact.
 */
function restoreSourceSpelling(output, source, verify) {
  if (source === undefined || source === output) return output;
  const a = tokenize(output);
  const b = tokenize(source);
  const coarse = diffRunsWithin(a, b);
  if (coarse === null || coarse.length === 0) return output;
  const runs = coarse.flatMap((run) => peelWhitespaceBoundary(a, b, run));
  const all = applyRuns(
    a,
    b,
    runs,
    runs.map(() => true),
  );
  if (verify(all)) return all;
  const restored = runs.map(() => false);
  for (let index = 0; index < runs.length; index += 1) {
    restored[index] = true;
    if (!verify(applyRuns(a, b, runs, restored))) restored[index] = false;
  }
  let best = applyRuns(a, b, runs, restored);
  const rejectedFenceSpacing = runs
    .map((run, index) => index)
    .filter(
      (index) => !restored[index] && isWhitespaceOnlyRun(a, b, runs[index]) && isFenceAdjacentRun(a, runs[index]),
    );
  if (rejectedFenceSpacing.length > 1) {
    const grouped = restored.slice();
    for (const index of rejectedFenceSpacing) grouped[index] = true;
    const candidate = applyRuns(a, b, runs, grouped);
    if (verify(candidate)) best = candidate;
  }
  return best;
}

/**
 * `serializeNodes()` with both mechanisms on top: the escape relaxation, then — when the caller can
 * say which bytes this run is replacing — the source-spelling restoration. Verified ABSOLUTELY
 * against the run it was made from and in the document's own reference context (REQ-7), so every
 * path out of here is either the serializer's own bytes or bytes proven to mean what the writer's
 * tree means.
 *
 * ORDER IS LOAD-BEARING: relaxation first, restoration second, never the other way round. Measured
 * on both safety fixtures, running the restoration first lets the relaxation then strip an escape
 * the restoration had just correctly put back.
 *
 * `source` is optional and omitting it is the whole of the M1-only path — that is what the pure
 * insertion below does, having no original bytes to restore from, and it is how a test measures this
 * module with the restoration ablated. There is deliberately no flag, toggle or option that turns
 * the restoration off: this is the code path that writes a writer's document, and a runtime switch
 * for "write the bytes they did not type" is one stray assignment from being thrown in production.
 *
 * Exported for tests on the same grounds as `parseMarkdown` and `serializeMarkdown` above.
 */
export function serializeNodesFaithfully(nodes, referenceSuffix, source) {
  const raw = serializeNodes(nodes);
  // T5's opt-out (contracts.md C1.2). On THIS path the absolute predicate below happens to refuse
  // an unmodelled run too, because it compares against `nodes` and `parseMarkdown` can only ever
  // build nodes this schema has — so today the two agree, and that is exactly why the opt-out may
  // not be left implicit in it: T5's parser WILL produce its opaque node, at which point the
  // predicate starts passing and this line is the only thing left standing between a raw block's
  // bytes and a rewrite of them.
  if (!runIsModelled(nodes)) return raw;
  const verify = (candidate) => verifiesAs(candidate, referenceSuffix, nodes);
  const written = restoreSourceSpelling(relaxEscapes(raw, verify), source, verify);
  // The final gate. Both mechanisms already return their input on any failure, so this is belt and
  // braces rather than the first line of defence — and it costs nothing on the path that refused
  // both, which returns the serializer's bytes and is checked by identity rather than by a reparse.
  if (written === raw) return raw;
  return verify(written) ? written : raw;
}

/**
 * Whether two diff runs meet on their SOURCE side. Both intervals are half-open token ranges into
 * the same string — the block's own bytes — so a run taken from one diff and a run taken from
 * another are directly comparable.
 *
 * TOUCHING COUNTS, and the strict reading is the wrong one. `<` is the natural reading of the word
 * "overlaps", and under it two ZERO-WIDTH runs at one offset never meet — but zero-width on the
 * source side is exactly what a pure insertion is, the serializer adding bytes the file never had.
 * Measured over the nine documents REQ-8 is recorded on: of the 40 blocks the serializer respells,
 * 18 have nothing but zero-width source runs — every `## [0.1.0-alpha.N]` heading in CHANGELOG.md
 * plus `## [Unreleased]`, whose reference definitions get written out inline. A strict join is
 * structurally blind on those, which is REQ-3's largest residual cause going unguarded.
 *
 * It is also the semantically right rule rather than merely the convenient one: an insertion sitting
 * immediately beside the writer's edit is precisely the entangled case the guard exists for. And it
 * costs nothing — the false-alarm count is zero under both joins in every measured configuration.
 *
 * Exported for tests, because nothing else can pin it: the setext control in the gate file fires
 * under EITHER join, so only a direct test of this predicate tells the two apart.
 */
export function runsOverlap(a, b) {
  return a.b0 <= b.b1 && b.b0 <= a.b1;
}

/**
 * The collateral guard. The question is not "can the serializer reproduce this block?" — the
 * restoration above answers that one with the source bytes — but: **does the write still differ
 * from the file at a place the SERIALIZER caused, rather than a place the writer's edit caused?**
 *
 * Two token diffs against the same source bytes:
 *
 * - `D`, what the serializer respells on its own: `M1(serializeNodes(originalNodes))` against
 *   `source`. **NO SOURCE RESTORATION IS INVOLVED**, and that is the whole anti-tautology property.
 *   Compute this side through the restoration and `faithful !== source` becomes true by
 *   construction — measured, 418 blocks of 418 restore and verify — so the guard cannot fire for
 *   any input while still looking like a guard. This is also the string the report carries.
 * - `R`, what the write still changes: `written` against `source`.
 *
 * Collateral iff some run of `R` meets a run of `D` on the source side. Why each case lands right:
 *
 * | | in `D`? | in `R`? | verdict |
 * |---|---|---|---|
 * | the writer's edited word, where the file already held plain text | no | yes | not collateral — those bytes are the writer's own |
 * | a respelling the restoration put back | yes | no | not collateral — nothing was lost |
 * | a respelling it could NOT put back, entangled with the writer's edit | yes | yes | **collateral** — this is the case that fires |
 * | markup the writer freshly typed, respelled on the way out | no | yes | not collateral, and the write may be dishonest — see below |
 *
 * **THE BLIND SPOT, stated rather than overclaimed.** `D` is built from the ORIGINAL nodes, so where
 * the writer types NEW markup `D` is empty there and this cannot fire under any join. Measured:
 * typing `[home]` into a document that defines that label writes an inlined URL; typing `&amp;`
 * writes `&`; typing `[note]` into a block that also holds a load-bearing `\*` writes `\[note\]`.
 * None of the three is a regression — `D` empty is equivalent to `faithful === source`, which is
 * precisely what the guard this replaces was silent on too — and none is fixed here. So, precisely:
 * this detects serializer infidelity carried from the block's ORIGINAL bytes, and is blind, exactly
 * as its predecessor is, to infidelity in content the writer freshly typed.
 *
 * `written` is taken as DATA rather than computed here, which is what lets a test ablate the
 * restoration by passing a `written` the wrapper produced with its source argument omitted. There is
 * no flag: see `serializeNodesFaithfully` above for why this write path may not have one.
 *
 * Exported for tests. The report entry, its three strings and the call site are unchanged; only the
 * condition moved.
 */
export function collateralFor(originalNodes, referenceSuffix, written, source) {
  const faithful = serializeNodesFaithfully(originalNodes, referenceSuffix);
  const entry = [{ original: source, faithful, written }];
  const sourceTokens = tokenize(source);
  const respelt = diffRunsWithin(tokenize(faithful), sourceTokens);
  const remaining = diffRunsWithin(tokenize(written), sourceTokens);
  // Fail safe. A matrix too large to fill is a write this cannot prove honest, and an unproven
  // write is one the writer is asked about — never one written silently.
  if (respelt === null || remaining === null) return entry;
  for (const d of respelt) for (const r of remaining) if (runsOverlap(d, r)) return entry;
  return [];
}

/** True for the document prosemirror-markdown produces from an empty string: the schema requires
 * at least one block, so "nothing" is one empty paragraph rather than no children. */
function isBlankDoc(doc) {
  return doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild.content.size === 0);
}

/** What a re-rendered link destination or title has to escape to survive being parsed again.
 * markdown-it stores both DECODED — `parseLinkDestination` and `parseLinkTitle` run them through
 * `unescapeAll()`, which resolves backslash escapes and character entities — so writing one back
 * raw would let a `&amp;` or a `\"` the writer's file spelled out mean something new. The
 * destination is then also NORMALIZED, through `normalizeLink`, which percent-encodes `\`, `<` and
 * `>`: of the four characters escaped there only `&` can reach a stored href at all, and the other
 * three are defense against that changing. A title skips `normalizeLink`, so all three of its
 * escapes are live.
 *
 * The LABEL needs no escaping either, but NOT because it survives verbatim — it does not.
 * markdown-it keys `env.references` on `normalizeReference(label)`, and a link resolves its own
 * label through the same function, so writing the key back reproduces the same binding even though
 * the emitted spelling is the case-folded key rather than the writer's: `[0.1.0-alpha.17]` comes
 * back out as `[0.1.0-ALPHA.17]` and still resolves, because a candidate's own label folds too.
 * Normalizing only trims, collapses whitespace runs and case-folds, so it preserves escape
 * structure exactly, and the label grammar admits no unescaped bracket in the first place. */
const ESCAPED_IN_DESTINATION = /[\\<>&]/g;
const ESCAPED_IN_TITLE = /[\\"&]/g;
const escapeReferencePart = (char) => (char === "&" ? "&amp;" : `\\${char}`);

/**
 * The document's link reference definitions as text that can be appended to any candidate spelling
 * before parsing it — `""` when the document defines none.
 *
 * A reference link whose definition is out of scope parses to plain text, so `## [Unreleased]`
 * means something different on its own than it means in the file it came from. Carrying the
 * definitions beside the block spans is what lets a verification parse ask its question in the
 * context the bytes will actually live in.
 *
 * Every line is checked before it is kept, against the two things the caller relies on: it must
 * tokenize to NOTHING — a definition produces no token and therefore no node, which is exactly why
 * appending it cannot disturb a candidate's tree — and it must define the same href and title
 * markdown-it recorded. A definition that fails either is dropped rather than guessed at, which
 * costs its own links their reference form and can never add a node to a candidate. No input is
 * known to reach that branch — it is a fail-closed guard against vendor drift, not a check that
 * fires in practice: should a markdown-it or `normalizeLink` change stop a spelling round-tripping,
 * this costs the reference form rather than silently emitting a binding that means something else.
 */
function referenceDefinitions(references) {
  const lines = [];
  for (const [label, { href, title }] of Object.entries(references ?? {})) {
    const destination = href.replace(ESCAPED_IN_DESTINATION, escapeReferencePart);
    const quoted = title ? ` "${title.replace(ESCAPED_IN_TITLE, escapeReferencePart)}"` : "";
    const line = `[${label}]: <${destination}>${quoted}`;
    const env = {};
    if (editorParser.tokenizer.parse(line, env).length !== 0) continue;
    const defined = env.references ?? {};
    if (Object.keys(defined).length !== 1) continue;
    if (defined[label]?.href !== href || defined[label]?.title !== title) continue;
    lines.push(line);
  }
  // A leading blank line, so the definitions cannot be absorbed into whatever the candidate ends
  // with, and nothing else: `candidate + referenceSuffix` is the whole of the call site.
  return lines.length === 0 ? "" : `\n\n${lines.join("\n")}\n`;
}

/**
 * Where `source`'s top-level blocks came from, and the reference context they came from it in:
 * `{blocks, referenceSuffix}`. The suffix is rendered, appendable TEXT — deliberately not the
 * `{label: {href, title}}` map markdown-it keeps under `env.references`, which would push rendering
 * into every verification parse. `blocks` holds one `{start, end}` pair per block, in document order —
 * character offsets bounding the block's own bytes, its trailing line ending excluded.
 *
 * markdown-it's block tokens carry a source line `map` — the same map the daemon's `data-line`
 * stamping anchors on — and `editorParser.tokenizer` IS that markdown-it instance (the same object
 * `defaultMarkdownParser` was built over; only the schema and token map differ), so the
 * rich face can learn where every block came from without a second parser or a vendored rebuild.
 * Lines resolve against the RAW source rather than markdown-it's normalized copy, and line endings
 * are left in the gaps between blocks rather than inside them, so a CRLF file keeps its `\r` bytes
 * whether a block is copied or re-serialized.
 *
 * Everything between two blocks — blank lines, and link reference definitions, which produce
 * neither a token nor a node — falls outside every span and is therefore copied untouched. The
 * definitions still have to travel, hence the second half of the record. Both halves come off the
 * one tokenizer pass this already makes — rendering them back out costs one further tokenizer call
 * per definition, but not one of those ever sees `source` — so this stays the SINGLE route to where
 * a block's bytes came from rather than growing a parallel one beside it.
 *
 * Exported for tests on the same grounds as `parseMarkdown` and `serializeMarkdown` above.
 */
export function blockLayout(source) {
  const lineStart = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStart.push(i + 1);
  const at = (line) => (line < lineStart.length ? lineStart[line] : source.length);
  const blocks = [];
  // markdown-it fills `env.references` on this pass; nothing here needed an env before, which is
  // why the argument used to be a throwaway object literal.
  const env = {};
  for (const token of editorParser.tokenizer.parse(source, env)) {
    // Top level only: an opening or self-closing token at nesting depth zero. Its closing partner
    // reports the same level, hence the `nesting` test rather than a depth counter.
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const start = at(token.map[0]);
    const body = source.slice(start, at(token.map[1])).replace(/(\r?\n)+$/, "");
    blocks.push({ start, end: start + body.length });
  }
  return { blocks, referenceSuffix: referenceDefinitions(env.references) };
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
 * The baseline never changes for an editor's lifetime, so its block layout — spans and reference
 * context both — is computed once here rather than on every save, park, and face switch.
 */
export function createSplicer(source, originalDoc) {
  // A lone `\r` is a line break to markdown-it but not to a `\n` scan, which would slide every
  // block offset out from under the token maps. Classic-Mac endings are vanishingly rare and not
  // worth splicing carefully; refuse rather than corrupt.
  const scannable = !/\r(?!\n)/.test(source);
  const layout = scannable ? blockLayout(source) : { blocks: [], referenceSuffix: "" };
  const blocks = layout.blocks;
  // Every candidate spelling this splice proposes is verified in this context, so a block's bytes
  // are judged by what they mean in the file rather than by what they would mean on their own.
  const referenceSuffix = layout.referenceSuffix;
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
        const written = serializeNodesFaithfully(inserted, referenceSuffix, replaced);
        collateral.push(...collateralFor(original.slice(o, nextO), referenceSuffix, written, replaced));
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
            return serializeNodesFaithfully([node], referenceSuffix);
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
 * `collateral` lists the edited blocks whose write STILL differs from the file at a place the
 * serializer caused rather than the writer — a respelling the source restoration above could not
 * put back, because the writer's own edit was entangled with it. It is no longer "what
 * re-serializing this block would cost regardless of the edit": most of that cost is now paid back
 * from the block's own bytes, and reporting it anyway would ask for consent to a save that costs
 * nothing. See `collateralFor` above for how it is decided and what it does not cover.
 *
 * `degraded` is a short reason string when the whole document had to be re-serialized instead.
 * Both are the caller's cue to ask before writing; neither is ever written silently (see
 * artifact-pane.js).
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
 * app.css). Returns {getSave, getMarkdown, getDoc, isDirty, focus, destroy}, where `getSave()` is
 * the splice report the caller must consult before writing and `getMarkdown()` is its text alone,
 * for callers that only need to carry the document somewhere (the source face, a parked draft).
 * `getDoc()` is the ProseMirror document itself, straight off `view.state` with no serialization
 * in between — the one honest way to ask "what did the keypress that just landed actually do to
 * the model", which `getSave()`/`getMarkdown()` cannot answer on their own: both already round
 * through `splice()`, so a loss between the DOM and the model would be invisible to either.
 * Throws if the environment can't host a ProseMirror view (e.g. a DOM without layout APIs) — the
 * caller falls back to source mode.
 */
export function mountRichEditor(container, { markdown, onDirty } = {}) {
  const schema = editorSchema;
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
    getDoc: () => view.state.doc,
    isDirty: () => dirty,
    focus: () => view.focus(),
    destroy: () => {
      view.destroy();
      container.textContent = "";
    },
    rebaseOnto: (newSource) => spliceMarkdown(newSource, parseMarkdown(newSource), view.state.doc),
  };
}
