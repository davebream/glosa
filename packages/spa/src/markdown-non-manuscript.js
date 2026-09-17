// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Portable syntax shared by the daemon renderer and the browser's CommonMark tokenizer.
/**
 * The ONE markdown-it configuration both renderers construct from.
 *
 * Before this existed the daemon built `new MarkdownIt({ html: false, linkify: false })` — the
 * DEFAULT preset — while the browser built the `commonmark` preset, which omits the `table` block
 * rule and the `strikethrough` inline rule. The same file was therefore a different document in
 * each: a pipe table rendered as `<table>` for a reader and as a paragraph of literal pipe
 * characters for the editor, and `~~struck~~` likewise. Sharing `installNonManuscriptRules` did
 * not help, because the presets underneath it disagreed.
 *
 * Named preset plus options rather than a constructed instance: markdown-it's `.use()` mutates the
 * instance it is called on, and the two consumers install different plugins afterwards (the daemon
 * adds `data-line` stamping, the browser does not). Sharing the CONFIGURATION keeps the one thing
 * that must not drift identical while leaving each side its own instance.
 *
 * Whatever this enables, `editorSchema` in rich-editor.js must be able to represent — a construct
 * the reader is shown but the editor cannot hold is exactly the divergence this removes.
 */
export const MARKDOWN_PRESET = "default";
export const MARKDOWN_OPTIONS = Object.freeze({ html: false, linkify: false });

export const HEADER_FENCE = "---";
export const COMMENT_FENCE = "%%";
export const RAW_KIND = Object.freeze({ METADATA: "metadata", COMMENT: "comment" });
export const NON_MANUSCRIPT_BLOCK_TOKEN = "glosa_non_manuscript";
export const NON_MANUSCRIPT_INLINE_TOKEN = "glosa_comment_inline";

/** @param {string} text @param {number} index */
function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === "\\") count++;
  return count % 2 === 1;
}

/** The first unescaped closing pair. Comment interiors are literal, including backticks.
 * @param {string} text @param {number} from */
function closingPair(text, from) {
  for (let index = text.indexOf(COMMENT_FENCE, from); index >= 0; index = text.indexOf(COMMENT_FENCE, index + 1)) {
    if (!escaped(text, index)) return index;
  }
  return -1;
}

/** Root metadata retains the existing non-blank guard to distinguish thematic breaks.
 * Container prefixes are removed with markdown-it's own indentation map, never a second scanner.
 * @param {string} fence @param {string} kind @param {boolean} metadata
 * @returns {import("markdown-it/lib/parser_block.mjs").RuleBlock} */
function blockRule(fence, kind, metadata) {
  return (state, start, end, silent) => {
    if (metadata && state.tokens.length !== 0) return false;
    if ((state.sCount[start] ?? -1) - state.blkIndent !== 0) return false;
    const line = (/** @type {number} */ n) =>
      state.src.slice((state.bMarks[n] ?? 0) + (state.tShift[n] ?? 0), state.eMarks[n]);
    if (line(start).trimEnd() !== fence) return false;
    if (metadata && (start + 1 >= end || state.isEmpty(start + 1))) return false;
    let close = -1;
    for (let n = start + 1; n < end; n++) {
      // Never consume a closing delimiter outside the current list/blockquote container.
      if (!state.isEmpty(n) && (state.sCount[n] ?? -1) < state.blkIndent) break;
      if ((state.sCount[n] ?? -1) - state.blkIndent === 0 && line(n).trimEnd() === fence) {
        close = n;
        break;
      }
    }
    if (close < 0) return false;
    if (silent) return true;
    const token = state.push(NON_MANUSCRIPT_BLOCK_TOKEN, "", 0);
    token.block = true;
    token.hidden = true;
    token.map = [start, close + 1];
    token.markup = fence;
    token.meta = { kind };
    token.content = state.getLines(start, close + 1, state.blkIndent, false);
    state.line = close + 1;
    return true;
  };
}

/** Inline pairs stay inside one CommonMark inline block, including soft line breaks.
 * Escape/code rules consume their own spans before dispatch can reach a comment opener.
 * @type {import("markdown-it/lib/parser_inline.mjs").RuleInline} */
function inlineRule(state, silent) {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== COMMENT_FENCE || escaped(state.src, start)) return false;
  const end = closingPair(state.src.slice(0, state.posMax), start + 2);
  if (end < 0) return false;
  if (!silent) {
    const token = state.push(NON_MANUSCRIPT_INLINE_TOKEN, "", 0);
    // Keep delimiters too: an empty comment must still have editable text in the rich schema.
    token.content = state.src.slice(start, end + 2);
    token.markup = COMMENT_FENCE;
  }
  state.pos = end + 2;
  return true;
}

/** @param {any} md @param {{hideInRenderer?: boolean}} [options] */
export function installNonManuscriptRules(md, { hideInRenderer = true } = {}) {
  md.block.ruler.before("hr", "glosa_metadata_header", blockRule(HEADER_FENCE, RAW_KIND.METADATA, true), { alt: [] });
  md.block.ruler.before("hr", "glosa_comment", blockRule(COMMENT_FENCE, RAW_KIND.COMMENT, false), { alt: [] });
  md.inline.ruler.before("backticks", "glosa_comment_inline", inlineRule);
  if (hideInRenderer) {
    md.renderer.rules[NON_MANUSCRIPT_BLOCK_TOKEN] = () => "";
    md.renderer.rules[NON_MANUSCRIPT_INLINE_TOKEN] = () => "";
  }
}

/** Ordered structural ranges, including nested blocks; endLine is exclusive.
 * @param {any[]} tokens */
export function tokenLayout(tokens) {
  return tokens
    .filter((token) => token.block && token.map && token.nesting >= 0 && token.type !== "inline")
    .map((token) => ({
      type: token.type === NON_MANUSCRIPT_BLOCK_TOKEN ? token.meta.kind : token.type.replace(/_open$/, ""),
      startLine: token.map[0],
      endLine: token.map[1],
      level: token.level,
    }));
}
