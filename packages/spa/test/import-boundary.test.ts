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
    for (const src of [read("../src/viewer.js"), read("../src/annotate.js")]) {
      const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(FETCH_REFERENCE_RE.test(stripped)).toBe(false);
    }
  });
});

describe("viewer.js/annotate.js import only from data-access.js, annotate.js, and vendor/ — never a raw daemon URL helper", () => {
  const ALLOWED_RELATIVE_IMPORTS = new Set(["./data-access.js", "./annotate.js", "./vendor/idiomorph.js"]);

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
});
