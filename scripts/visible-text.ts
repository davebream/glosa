// SPDX-License-Identifier: Apache-2.0
// Finds characters glosa does not show a person. The rule today is one character: the em dash
// (U+2014) never appears in anything the app, the shell or the CLI prints, because it is the
// tell of machine-written copy (AGENTS.md, "Copy"). Comments may say what they like; this looks
// only at text a person can see: string and template literals in JS/TS, text and attribute values
// in HTML, and `content:` strings in CSS.
//
// Pure over its inputs (functional core); test/copy-rules.test.ts is the shell that walks the tree.

export type Finding = { file: string; line: number; column: number; text: string };

const EM_DASH = "—";

/** Every string or template literal in a JS/TS source, with comments and regex literals skipped.
 *  A small state machine, not a parser: enough for this repository's code, and the test proves it
 *  sees a literal and ignores a comment. */
export function visibleTextInScript(source: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let i = 0;
  const n = source.length;
  // What the previous significant token was, to tell a regex literal from a division.
  let lastSignificant = "";
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") i += 1;
        if (source[i] === "\n") break;
        i += 1;
      }
      out.push({ text: source.slice(start + 1, i), offset: start + 1 });
      i += 1;
      lastSignificant = "string";
      continue;
    }
    if (c === "`") {
      const start = i;
      i += 1;
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (depth === 0 && ch === "`") break;
        if (ch === "$" && source[i + 1] === "{") {
          depth += 1;
          i += 2;
          continue;
        }
        if (depth > 0 && ch === "}") depth -= 1;
        i += 1;
      }
      out.push({ text: source.slice(start + 1, i), offset: start + 1 });
      i += 1;
      lastSignificant = "string";
      continue;
    }
    if (c === "/" && /[=(,:;!&|?{}[\]]|^$/.test(lastSignificant)) {
      // A regex literal after a token that cannot precede division.
      i += 1;
      let inClass = false;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break;
        i += 1;
      }
      i += 1;
      lastSignificant = "regex";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[A-Za-z0-9_$)\]]/.test(c) ? "word" : c;
    i += 1;
  }
  return out;
}

/** Text a browser renders from HTML: element text and attribute values, never comments or the
 *  inside of <script> and <style>, which the other two scanners own. */
export function visibleTextInHtml(source: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const withoutCode = withoutComments.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => " ".repeat(m.length));
  const tag = /<[^>]*>/g;
  let last = 0;
  for (const m of withoutCode.matchAll(tag)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: withoutCode.slice(last, idx), offset: last });
    for (const attr of m[0].matchAll(/=\s*"([^"]*)"/g)) {
      out.push({ text: attr[1] ?? "", offset: idx + (attr.index ?? 0) + attr[0].indexOf('"') + 1 });
    }
    last = idx + m[0].length;
  }
  if (last < withoutCode.length) out.push({ text: withoutCode.slice(last), offset: last });
  return out;
}

/** The only text CSS shows: `content:` strings. */
export function visibleTextInCss(source: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  for (const m of withoutComments.matchAll(/content\s*:\s*("([^"]*)"|'([^']*)')/g)) {
    const text = m[2] ?? m[3] ?? "";
    out.push({ text, offset: (m.index ?? 0) + m[0].indexOf(text) });
  }
  return out;
}

export function visibleText(file: string, source: string): Array<{ text: string; offset: number }> {
  if (/\.(html?)$/.test(file)) return visibleTextInHtml(source);
  if (/\.css$/.test(file)) return visibleTextInCss(source);
  return visibleTextInScript(source);
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}

/** Every em dash a person could see in `source`. */
export function emDashesInVisibleText(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const piece of visibleText(file, source)) {
    let at = piece.text.indexOf(EM_DASH);
    while (at !== -1) {
      const { line, column } = lineAndColumn(source, piece.offset + at);
      findings.push({ file, line, column, text: piece.text.trim().slice(0, 90) });
      at = piece.text.indexOf(EM_DASH, at + 1);
    }
  }
  return findings;
}
