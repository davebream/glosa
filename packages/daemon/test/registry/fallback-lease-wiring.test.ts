// SPDX-License-Identifier: Apache-2.0
// Tripwire for the one registry-write coordination gap this repo knowingly ships.
//
// `withFileLease` (registry/lockfile-fallback.ts, A4 "Registry-write serialization") has NO
// production caller, and `WorkspaceIndex.persist()` correspondingly does not take that lease around
// its own temp->fsync->rename of `workspaces.json`. Two writers that can never run at the same time
// need no lock between them, so today that is safe. The moment a hook-side fallback caller exists it
// stops being safe: a hook writing `workspaces.json` under the O_EXCL lease and the daemon writing
// it through `persist()` would race two `renameSync` calls on the same file — precisely the torn
// write the lease exists to prevent.
//
// The standing instruction for that day is currently a code comment (the `P4.3:` notes in
// registry/workspace-index.ts and registry/lockfile-fallback.ts). Comments do not fail CI. This
// file does: it goes red the moment production source outside the lease's own module references
// `withFileLease` while `persist()` still does not take it.
//
// Source-text based, like packages/spa/test/import-boundary.test.ts's data-access guard, and for
// the same reason — it catches a FUTURE caller the day it is written, without waiting for a test to
// happen to exercise that code path.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** The lease's own module: the definition site, and the only production file allowed to name it. */
const DEFINITION = "daemon/src/registry/lockfile-fallback.ts";
/** The daemon-side writer of the same `workspaces.json` that must take the SAME lease once the
 * pre-daemon fallback has a real caller. */
const PERSIST_SITE = "daemon/src/registry/workspace-index.ts";

/** Word-boundary identifier match rather than a call-shaped `withFileLease\s*\(` pattern: an
 * `import { withFileLease }` in a production module is already the wiring this guard is watching
 * for, and the definition itself reads `withFileLease<T>(`, which a call-shaped pattern would miss
 * — leaving the anti-vacuity anchor below with nothing to hold on to. */
const IDENTIFIER = /\bwithFileLease\b/;

function read(relPath: string): string {
  return readFileSync(join(PACKAGES_DIR, relPath), "utf8");
}

/** Same strip the SPA import-boundary guard uses, and needed for the same reason: the `P4.3:` note
 * in workspace-index.ts explains this invariant in prose that names `withFileLease`, and prose must
 * not be mistaken for wiring. */
function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every PRODUCTION module in the monorepo: any `.ts`/`.js` under a package's own `src` directory,
 * which covers the provider packages nested one level deeper as well. Never a `test` tree, never
 * vendored third-party code. */
function productionSources(): string[] {
  return readdirSync(PACKAGES_DIR, { recursive: true })
    .map(String)
    .map((rel) => rel.split("\\").join("/"))
    .filter((rel) => rel.endsWith(".ts") || rel.endsWith(".js"))
    .filter((rel) => rel.includes("/src/"))
    .filter((rel) => !rel.includes("/node_modules/") && !rel.includes("/vendor/"))
    .filter((rel) => !/(^|\/)(test|tests|__tests__)\//.test(rel))
    .sort();
}

/** Points the reader at the note rather than at a line number that rots the next time anything
 * above it is edited. */
function p4NoteLocation(): string {
  const lines = read(PERSIST_SITE).split("\n");
  const index = lines.findIndex((line) => line.includes("P4.3:"));
  return `packages/${PERSIST_SITE}${index === -1 ? "" : `:${index + 1}`}`;
}

function remedy(wired: readonly string[]): string {
  return [
    `\`withFileLease\` now has production caller(s) — ${wired.join(", ")} — but WorkspaceIndex.persist()`,
    "still does not take the same lease. A hook writing workspaces.json through the pre-daemon",
    "fallback and the daemon writing it through persist() will race two renameSync calls on that",
    "one file, and the loser's registration is lost with no error raised anywhere.",
    "",
    "Do ONE of these before this ships:",
    "  (a) wrap persist()'s temp->fsync->rename in withFileLease(fallbackWorkspacesLockPath(home), ...)",
    "      — note that withFileLease's sleepSync blocks the thread via Atomics.wait, so putting it on",
    "      the daemon's event loop needs an async acquire path first; or",
    "  (b) prove the two paths can never run concurrently, and say where that proof lives.",
    "",
    `Then update this guard and the P4.3 notes at ${p4NoteLocation()} and packages/${DEFINITION}.`,
  ].join("\n");
}

describe("fallback lease wiring — persist() and the O_EXCL fallback must not diverge", () => {
  test("no production module references withFileLease while persist() still does not take the lease", () => {
    const wired = productionSources().filter((rel) => rel !== DEFINITION && IDENTIFIER.test(stripComments(read(rel))));
    expect(wired, remedy(wired)).toEqual([]);
  });

  // A guard whose detector scans nothing, or whose pattern stops matching, passes forever. The three
  // tests below pin each link in the chain, so breaking one disarms this file loudly.
  test("the scan reaches every package's production source, and no test tree", () => {
    const scanned = productionSources();
    expect(scanned).toContain(DEFINITION);
    expect(scanned).toContain(PERSIST_SITE);
    const packagesCovered = [...new Set(scanned.map((rel) => rel.split("/src/")[0]))].sort();
    expect(packagesCovered).toEqual(["cli", "daemon", "providers/claude-code", "providers/codex", "spa"]);
    expect(scanned.filter((rel) => rel.includes(".test."))).toEqual([]);
  });

  test("the identifier pattern still matches the lease's own definition site", () => {
    expect(IDENTIFIER.test(stripComments(read(DEFINITION)))).toBe(true);
  });

  test("the comment stripper is load-bearing: the P4.3 prose names withFileLease and must not trip the guard", () => {
    const source = read(PERSIST_SITE);
    // Still there, still connecting persist() to the lease...
    expect(IDENTIFIER.test(source)).toBe(true);
    expect(source).toContain("P4.3:");
    // ...and still prose rather than wiring, which is the ONE exclusion the guard above depends on.
    expect(IDENTIFIER.test(stripComments(source))).toBe(false);
  });
});
