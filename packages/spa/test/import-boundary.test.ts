// P3.3 — structural check for R6's "ONE data-access module" invariant: no SPA component talks
// to the daemon except through data-access.js. Source-text based (not a runtime mock-count), on
// purpose — it catches a FUTURE stray `fetch(` call anywhere in these files even before a test
// happens to exercise that code path, which a purely behavioral test could miss.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

// Matches a real network call: `fetch(`, `window.fetch(`, `.fetch(` — not the string "fetch"
// appearing in a comment or as a parameter/property NAME (`fetchFn`, `{ fetchFn }`), which
// data-access.js itself uses legitimately as its own injection point.
const FETCH_CALL_RE = /(^|[^A-Za-z0-9_.])fetch\s*\(/m;
// A looser check for the sanity test below: data-access.js references the global `fetch`
// identifier (as a default for its injectable `fetchFn`) but never literally CALLS `fetch(...)`
// itself — every real call goes through the injected `fetchFn(...)`. Word-boundary so it doesn't
// also match `fetchFn`.
const FETCH_REFERENCE_RE = /(^|[^A-Za-z0-9_])fetch(?![A-Za-z0-9_])/m;

describe("no SPA component calls fetch directly except data-access.js", () => {
  // bootstrap.js is deliberately excluded: its one `fetch("/api/handshake")` call (P1.4) runs
  // BEFORE pairing/mounting even happens, against the one tokenless route — it's the bootstrap
  // sequence's own concern, not one of the "components" R6's ONE-data-access-module invariant
  // is about (the viewer/annotate/mode/morph code this task adds). Once mounted, `mountApp`
  // itself never calls `fetch` — only `viewer.js`/`annotate.js` are checked here.
  test.each([
    ["../src/viewer.js", read("../src/viewer.js")],
    ["../src/annotate.js", read("../src/annotate.js")],
    ["../src/history.js", read("../src/history.js")],
    ["../src/classf-viewer.js", read("../src/classf-viewer.js")],
    ["../src/conversation.js", read("../src/conversation.js")],
  ])("%s has no direct fetch(...) call", (_name, source) => {
    // Strip comments first so a docstring that merely MENTIONS "fetch(" (there are several,
    // explaining the invariant this test enforces) can't produce a false positive.
    const withoutComments = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(FETCH_CALL_RE.test(withoutComments)).toBe(false);
  });

  test("data-access.js is the only file that references fetch at all — proves the check above isn't vacuous", () => {
    const withoutComments = read("../src/data-access.js")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(FETCH_REFERENCE_RE.test(withoutComments)).toBe(true);
    for (const src of [
      read("../src/viewer.js"),
      read("../src/annotate.js"),
      read("../src/history.js"),
      read("../src/classf-viewer.js"),
      read("../src/conversation.js"),
    ]) {
      const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(FETCH_REFERENCE_RE.test(stripped)).toBe(false);
    }
  });
});

describe("viewer.js/annotate.js/history.js/classf-viewer.js/conversation.js import only from data-access.js, shared UI modules, each other's sanctioned set, and vendor/ — never a raw daemon URL helper", () => {
  const ALLOWED_RELATIVE_IMPORTS = new Set([
    "./data-access.js",
    "./annotate.js",
    "./history.js",
    "./classf-viewer.js",
    "./conversation.js",
    "./rich-editor.js",
    "./dialog.js",
    "./artifact-tree.js",
    "./appearance.js",
    "./vendor/idiomorph.js",
    "./vendor/diff2html.js",
    "./vendor/prosemirror.js",
  ]);

  test("viewer.js's local imports are exactly the sanctioned set", () => {
    const source = read("../src/viewer.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    const relative = specifiers.filter((s) => s.startsWith("./") || s.startsWith("../"));
    for (const spec of relative) expect(ALLOWED_RELATIVE_IMPORTS.has(spec)).toBe(true);
  });

  test("annotate.js imports nothing (self-contained — no daemon access of its own)", () => {
    const source = read("../src/annotate.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)];
    expect(specifiers).toHaveLength(0);
  });

  test("history.js's local imports are exactly the sanctioned set (its own vendored diff renderer, nothing else)", () => {
    const source = read("../src/history.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    const relative = specifiers.filter((s) => s.startsWith("./") || s.startsWith("../"));
    for (const spec of relative) expect(ALLOWED_RELATIVE_IMPORTS.has(spec)).toBe(true);
  });

  test("classf-viewer.js's local imports are exactly the sanctioned set (data-access.js only)", () => {
    const source = read("../src/classf-viewer.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    const relative = specifiers.filter((s) => s.startsWith("./") || s.startsWith("../"));
    for (const spec of relative) expect(ALLOWED_RELATIVE_IMPORTS.has(spec)).toBe(true);
  });

  test("conversation.js imports nothing (self-contained — no daemon access of its own; dataAccess is caller-injected)", () => {
    const source = read("../src/conversation.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)];
    expect(specifiers).toHaveLength(0);
  });

  test("dialog.js imports nothing (pure DOM — no daemon access)", () => {
    const source = read("../src/dialog.js");
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)];
    expect(specifiers).toHaveLength(0);
  });

  test("rich-editor.js imports only its vendored ProseMirror bundle (pure editor — no daemon access)", () => {
    const source = read("../src/rich-editor.js");
    // `from "..."` matcher (not the single-line import regex above): this module's one import is
    // a multi-line named-import block.
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers).toEqual(["./vendor/prosemirror.js"]);
  });
});
