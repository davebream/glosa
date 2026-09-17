// SPDX-License-Identifier: Apache-2.0
// @ts-check
// The browser's shared markdown tokenizer. ProseMirror is already loaded by the rich editor.
//
// Constructed from the SAME preset and options the daemon renders with (MARKDOWN_PRESET /
// MARKDOWN_OPTIONS in markdown-non-manuscript.js), so the reader and the editor see one document.
// This used to name the `commonmark` preset independently, which is how tables and strikethrough
// came to exist on one side only.
import { defaultMarkdownParser } from "./vendor/prosemirror.js";
import {
  installNonManuscriptRules,
  MARKDOWN_OPTIONS,
  MARKDOWN_PRESET,
  NON_MANUSCRIPT_INLINE_TOKEN,
} from "./markdown-non-manuscript.js";
export const commonMarkTokenizer = new defaultMarkdownParser.tokenizer.constructor(MARKDOWN_PRESET, {
  ...MARKDOWN_OPTIONS,
});
installNonManuscriptRules(commonMarkTokenizer);
/** @param {string} source */
export function markdownTokens(source) {
  return commonMarkTokenizer.parse(source, {});
}

/** Visible inline text from actual tokens: formatting has already been parsed, while code
 * and escaped delimiter text remain literal. @param {any[]} tokens @returns {string} */
function visibleInlineText(tokens) {
  return tokens
    .map((token) => {
      if (token.type === NON_MANUSCRIPT_INLINE_TOKEN) return "";
      if (token.type === "softbreak" || token.type === "hardbreak") return " ";
      if (token.children) return visibleInlineText(token.children);
      return token.nesting === 0 ? (token.content ?? "") : "";
    })
    .join("");
}

/** Source headings use the same tokenizer as rich editing, including container and code rules.
 * Offsets refer to the original source, before markdown-it normalizes line endings.
 * @param {string} source
 * @returns {{level:number,text:string,line:number,offset:number}[]} */
export function collectSourceHeadings(source) {
  const text = String(source ?? "");
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  const tokens = markdownTokens(text);
  const found = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "heading_open" || !token.map) continue;
    const label = visibleInlineText(tokens[index + 1]?.children ?? [])
      .replace(/\s+/g, " ")
      .trim();
    if (label)
      found.push({
        level: Number(token.tag.slice(1)),
        text: label,
        line: token.map[0],
        offset: starts[token.map[0]] ?? text.length,
      });
  }
  return found;
}
