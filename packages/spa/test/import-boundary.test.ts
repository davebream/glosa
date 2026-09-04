// SPDX-License-Identifier: Apache-2.0
// P3.3 — structural check for R6's "ONE data-access module" invariant: no SPA module talks to the
// daemon except through data-access.js. Source-text based (not a runtime mock-count), on purpose —
// it catches a FUTURE stray `fetch(` call anywhere in these files even before a test happens to
// exercise that code path, which a purely behavioral test could miss.
//
// Two properties keep this guard honest, and both are asserted below rather than assumed:
//   1. It covers the WHOLE hand-written SPA surface, enumerated from disk. A hand-maintained list
//      is only as complete as the last person who remembered to append to it, and this one had
//      already drifted — see HAND_WRITTEN_SPA_MODULES.
//   2. It can actually fire. A guard that matches nothing passes forever, so the matchers are
//      pinned against literal fixtures and data-access.js is asserted to still trip them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SPA_SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

// Strip line and block comments before matching, so a docstring that merely MENTIONS "fetch(" —
// there are several, explaining the very invariant this file enforces — can't produce a false
// positive. Deliberately dumb: it does not understand `//` inside a string literal, which would
// only ever over-strip and so can only ever make this guard MISS, never false-alarm. The matcher
// fixtures below pin both directions of this behavior.
function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function hasActiveTsCheckDirective(source: string): boolean {
  // TypeScript only recognizes @ts-check in the leading comment preamble. Match that preamble
  // structurally so SPDX headers and future comment additions do not pin the directive to a line.
  const preamble = source.match(/^(?:(?:\s+)|(?:\/\/[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*/)?.[0] ?? "";
  return /^\s*\/\/\s*@ts-check\s*$/m.test(preamble);
}

// Matches a real network call: `fetch(`, `window.fetch(`, `globalThis.fetch(` — but not the string
// "fetch" in a comment, and not a parameter/property NAME (`fetchFn`, `{ fetchFn }`), which
// data-access.js uses legitimately as its own injection point, nor `fetch.bind(...)`.
//
// The leading class deliberately does NOT exclude `.`. It used to, which meant a module could
// reach the daemon as `window.fetch("/api/...")` and this guard would not see it — while the
// comment above it claimed the opposite. That evasion also has to be closed for the bootstrap
// per-call allowlist below to mean anything.
const FETCH_CALL_RE = /(^|[^A-Za-z0-9_])fetch\s*\(/m;
// A stricter check than FETCH_CALL_RE for the guarded set: data-access.js references the global
// `fetch` identifier (as the default for its injectable `fetchFn`) but never literally CALLS
// `fetch(...)` itself — every real call goes through the injected `fetchFn(...)`. Every other
// module must not so much as name it. Word-boundary so it doesn't also match `fetchFn`.
const FETCH_REFERENCE_RE = /(^|[^A-Za-z0-9_])fetch(?![A-Za-z0-9_])/m;

// R6 is enforced over the DIRECTORY, not over a hand-maintained list — a new module is guarded the
// day it lands, with nothing for anyone to remember. That is not hypothetical tidiness: the two
// lists this replaces had drifted apart (7 modules vs 8) and between them missed rich-editor.js,
// dialog.js, appearance.js and appearance-preload.js entirely — appearance-preload.js being a real
// browser-served module (shell.html:10, packages/daemon/src/http.ts's SPA_ASSETS). A stray `fetch(`
// in any of the four was exempt purely by omission, which is the same failure this file exists to
// prevent in the SPA.
//
// `.ts` is included alongside `.js` for the same reason: filtering by extension would recreate the
// hole one file type over. `vendor/` is excluded — third-party code (idiomorph, diff2html,
// ProseMirror) vendored verbatim, not ours to hold to R6. It is a subdirectory, so this
// non-recursive read never descends into it; the `isFile()` filter keeps that true regardless.
const HAND_WRITTEN_SPA_MODULES: readonly string[] = readdirSync(SPA_SRC_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.[jt]s$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

// data-access.js IS R6's one module. bootstrap.js is the one sanctioned exception, and gets the
// stricter per-CALL allowlist below rather than a blanket pass. Every other module must not touch
// the network at all.
const MODULES_ALLOWED_TO_REACH_THE_DAEMON = new Set(["data-access.js", "bootstrap.js"]);
const GUARDED_MODULES = HAND_WRITTEN_SPA_MODULES.filter((name) => !MODULES_ALLOWED_TO_REACH_THE_DAEMON.has(name));

/**
 * Slice the argument text of a call whose `(` sits at `open`, tracking bracket depth and string /
 * template literals so a `)` inside a string can't end the slice early. Returns null when the call
 * is unbalanced or uses nesting this deliberately small scanner can't follow — the caller turns
 * that into a signature that matches no allowlist entry, so an un-analyzable network call in
 * bootstrap.js fails loudly instead of passing quietly.
 */
function sliceCallArgs(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Every `fetch(...)` call site in `source`, as a `"<METHOD> <url>"` signature.
 *
 * Method AND url, not url alone: the whole defect this replaces was a state-changing POST quietly
 * inheriting a justification written for a tokenless GET, so a signature that can't tell those
 * apart would not have caught it. A call whose URL isn't a plain string literal, or whose text
 * can't be sliced, yields a sentinel that no allowlist entry can match — dynamic daemon URLs in
 * bootstrap.js are a review-blocker, not a silent pass.
 */
function fetchCallSignatures(source: string): string[] {
  const signatures: string[] = [];
  for (const match of source.matchAll(new RegExp(FETCH_CALL_RE.source, "gm"))) {
    const open = match.index! + match[0].length - 1;
    const args = sliceCallArgs(source, open);
    if (args === null) {
      signatures.push("<unparseable fetch call>");
      continue;
    }
    // Anchored on BOTH sides: the literal must be the whole first argument. Without the trailing
    // `,|$` a concatenation like `fetch("/api/handshake" + qs)` would yield the bare prefix and
    // quietly match a sanctioned entry while actually calling a different URL.
    const url = args.match(/^\s*"([^"]*)"\s*(?:,|$)|^\s*'([^']*)'\s*(?:,|$)/);
    if (!url) {
      signatures.push("<non-literal fetch url>");
      continue;
    }
    const method = args.match(/\bmethod\s*:\s*["']([A-Za-z]+)["']/);
    signatures.push(`${method ? method[1]!.toUpperCase() : "GET"} ${url[1] ?? url[2]}`);
  }
  return signatures;
}

// bootstrap.js is R6's one sanctioned exception because it runs BEFORE pairing exists, and
// data-access.js requires the very token bootstrap is still acquiring. The exception is per-CALL,
// not per-file. It used to be per-file, and that is precisely how it rotted: the blanket exclusion
// was justified in writing for the single tokenless `GET /api/handshake`, then silently absorbed a
// state-changing POST that mints the durable pairing credential — a call its justification never
// covered. Enumerating the calls means the NEXT one has to be argued for here, in writing, before
// it can land.
const BOOTSTRAP_SANCTIONED_CALLS = new Map<string, string>([
  [
    "POST /api/presentation-token/redeem",
    "A3 §3/F24 — exchanges the single-use `p=` presentation token carried in the URL fragment for " +
      "the durable pairing token. Necessarily pre-pairing and un-routable through data-access.js, " +
      "which needs the very credential this call mints.",
  ],
  [
    "GET /api/handshake",
    "A1 §3 — the one tokenless route, read to choose which of R5's four screens to render " +
      "(down / unpaired / mismatch / ready). Nothing to route through yet: mountApp has not run.",
  ],
]);

describe("no SPA module reaches the daemon except through data-access.js (R6)", () => {
  test("the daemon boundary and token bootstrap retain active static checking", () => {
    for (const name of ["data-access.js", "bootstrap.js"] as const) {
      expect(hasActiveTsCheckDirective(read(`../src/${name}`))).toBe(true);
    }
  });

  test("the enumeration found the SPA modules — proves the per-module checks below aren't vacuous", () => {
    // If HAND_WRITTEN_SPA_MODULES silently came back empty (wrong path, over-eager filter), every
    // `test.each` below would run zero cases and pass forever. Pin a known-present subset — not the
    // full list, which would just reintroduce the hand-maintained-omission hole it replaces. The
    // last four are exactly the modules the previous hardcoded lists had missed.
    for (const known of [
      "viewer.js",
      "conversation.js",
      "rich-editor.js",
      "dialog.js",
      "appearance.js",
      "appearance-preload.js",
    ]) {
      expect(GUARDED_MODULES).toContain(known);
    }
    for (const sanctioned of MODULES_ALLOWED_TO_REACH_THE_DAEMON) {
      expect(HAND_WRITTEN_SPA_MODULES).toContain(sanctioned);
      expect(GUARDED_MODULES).not.toContain(sanctioned);
    }
    expect(GUARDED_MODULES.length).toBeGreaterThanOrEqual(12);
  });

  test.each(GUARDED_MODULES)("%s has no direct fetch(...) call", (name) => {
    expect(FETCH_CALL_RE.test(stripComments(read(`../src/${name}`)))).toBe(false);
  });

  test.each(GUARDED_MODULES)("%s does not reference fetch at all", (name) => {
    // Stricter than the call check and it subsumes it: a module that never names `fetch` cannot
    // reach the daemon by aliasing it either (`const f = fetch; f(url)`).
    expect(FETCH_REFERENCE_RE.test(stripComments(read(`../src/${name}`)))).toBe(false);
  });

  test("data-access.js still trips the reference matcher — proves the checks above aren't vacuous", () => {
    expect(FETCH_REFERENCE_RE.test(stripComments(read("../src/data-access.js")))).toBe(true);
  });

  test("bootstrap.js's network calls are exactly the sanctioned pre-pairing set — a third fails here", () => {
    const signatures = fetchCallSignatures(stripComments(read("../src/bootstrap.js")));
    // Sorted-array equality rather than a set or a count: it catches an ADDED call, a REMOVED one,
    // a SUBSTITUTED one (swapping the handshake for some other route), and a DUPLICATED one. A
    // count catches only the first of those, and a count is what "two calls, both fine" degrades
    // into once nobody re-reads the justifications.
    expect(signatures.sort()).toEqual([...BOOTSTRAP_SANCTIONED_CALLS.keys()].sort());
  });

  test("every sanctioned bootstrap call carries a written justification", () => {
    // The exemption rotted because a call inherited someone else's reason. A blank entry here is
    // that same failure with extra steps.
    for (const [signature, why] of BOOTSTRAP_SANCTIONED_CALLS) {
      expect(why.length).toBeGreaterThan(40);
      expect(signature).toMatch(/^[A-Z]+ \/api\//);
    }
  });
});

describe("the fetch matchers fire on a real call and stay silent on a comment", () => {
  // Without this, a future edit that broke the regex or over-broadened stripComments would turn
  // every R6 check in this file into a no-op that passes forever, and nothing would say so.
  test("a real call is caught, however it is spelled", () => {
    expect(FETCH_CALL_RE.test(stripComments('const r = await fetch("/api/annotations");'))).toBe(true);
    expect(FETCH_CALL_RE.test(stripComments('window.fetch("/api/annotations");'))).toBe(true);
    expect(FETCH_CALL_RE.test(stripComments('globalThis.fetch("/api/annotations");'))).toBe(true);
  });

  test("a mention inside a comment is not caught", () => {
    expect(FETCH_CALL_RE.test(stripComments('// never call fetch("/api/annotations") here — R6'))).toBe(false);
    expect(FETCH_CALL_RE.test(stripComments('/* fetch("/api/annotations") is data-access.js\'s job */'))).toBe(false);
  });

  test("an identifier merely NAMED fetch-something is not a call", () => {
    expect(FETCH_CALL_RE.test("const { fetchFn } = deps;\nfetchFn(url);")).toBe(false);
    expect(FETCH_CALL_RE.test("const f = fetch.bind(globalThis);")).toBe(false);
  });

  test("signatures carry the method, so a POST can never pass as the sanctioned GET", () => {
    const source = 'fetch("/api/handshake");\nfetch("/api/x", { method: "post", body: "{}" });';
    expect(fetchCallSignatures(source)).toEqual(["GET /api/handshake", "POST /api/x"]);
  });

  test("a fetch call with a computed URL yields a signature no allowlist can match", () => {
    // Every way of not writing a plain string literal has to land on the sentinel, including the
    // subtle one: a concatenation whose PREFIX is a sanctioned route still calls something else.
    expect(fetchCallSignatures("fetch(route);")).toEqual(["<non-literal fetch url>"]);
    expect(fetchCallSignatures("fetch(`/api/handshake`);")).toEqual(["<non-literal fetch url>"]);
    expect(fetchCallSignatures('fetch("/api/handshake" + qs);')).toEqual(["<non-literal fetch url>"]);
  });
});

describe("viewer.js and its UI modules import only from data-access.js, their sanctioned set, and vendor/ — never a raw daemon URL helper", () => {
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
    "./attention-tray.js",
    "./agent-feedback.js",
    "./viewer-shell.js",
    "./viewer-context-surfaces.js",
    "./viewer-feedback.js",
    "./viewer-navigator.js",
    "./artifact-pane.js",
    "./diff-pane.js",
    "./dock.js",
    "./vendor/dockview.js",
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

  test("viewer.js lazy-loads the optional history, conversation, and rich-editor surfaces", () => {
    const source = read("../src/viewer.js");
    const staticSpecifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    for (const optional of ["./history.js", "./conversation.js", "./rich-editor.js"]) {
      expect(staticSpecifiers).not.toContain(optional);
      expect(source).toContain(`import("${optional}")`);
    }
  });

  test("artifact-pane.js's local imports are exactly the sanctioned set", () => {
    const source = read("../src/artifact-pane.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    const relative = specifiers.filter((s) => s.startsWith("./") || s.startsWith("../"));
    expect(relative.length).toBeGreaterThan(0);
    for (const spec of relative) expect(ALLOWED_RELATIVE_IMPORTS.has(spec)).toBe(true);
  });

  test("dock.js knows about panels and tabs, never about the daemon", () => {
    const source = read("../src/dock.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    // The dock decides which panes exist and where they sit. Everything a pane knows — including
    // how to reach the daemon — is injected by viewer.js.
    expect(specifiers).toEqual(["./vendor/dockview.js", "./viewer-shell.js"]);
    expect(source).not.toContain("data-access");
  });

  test("diff-pane.js's local imports are exactly the sanctioned set", () => {
    const source = read("../src/diff-pane.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    const relative = specifiers.filter((s) => s.startsWith("./") || s.startsWith("../"));
    for (const spec of relative) expect(ALLOWED_RELATIVE_IMPORTS.has(spec)).toBe(true);
  });

  test("annotate.js imports nothing (self-contained — no daemon access of its own)", () => {
    const source = read("../src/annotate.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)];
    expect(specifiers).toHaveLength(0);
  });

  test("artifact-tree.js imports nothing (pure tree rendering — no daemon access)", () => {
    const source = read("../src/artifact-tree.js");
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

  test("attention-tray.js imports nothing (all daemon access is caller-injected)", () => {
    const source = read("../src/attention-tray.js");
    const specifiers = [...source.matchAll(/^import\s+.*?\s+from\s+["']([^"']+)["'];?$/gm)];
    expect(specifiers).toHaveLength(0);
  });

  test("agent-feedback.js imports nothing (aggregate status is caller-injected)", () => {
    const source = read("../src/agent-feedback.js");
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
