// SPDX-License-Identifier: Apache-2.0
// AGENTS.md "Copy": nothing the app, the shell or the CLI shows a person contains an em dash. The
// scanner in scripts/visible-text.ts looks only at text a person can see (string and template
// literals, HTML text and attributes, CSS `content:`), so comments stay free to say what they like.
// The self-checks below prove the scanner sees a literal and ignores a comment, so that a green
// run means the rule held and not that the scanner looked away.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emDashesInVisibleText } from "../scripts/visible-text.ts";

const ROOT = resolve(import.meta.dir, "..");
const TREES = ["packages/spa/src", "packages/shell/src", "packages/cli/src"];

function trackedSources(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", ...TREES], { cwd: ROOT }).stdout.toString();
  return out
    .split("\0")
    .filter((f) => /\.(js|ts|cjs|mjs|html?|css)$/.test(f) && !f.includes("/vendor/"))
    .sort();
}

describe("copy rules: no em dash reaches a person", () => {
  test("the scanner sees a literal, a template, HTML text, an attribute and a CSS content string", () => {
    expect(emDashesInVisibleText("a.js", 'const s = "Not saved — try again";')).toHaveLength(1);
    expect(emDashesInVisibleText("a.js", "const s = `${name} — ${folder}`;")).toHaveLength(1);
    expect(emDashesInVisibleText("a.html", "<p>run it — then reload</p>")).toHaveLength(1);
    expect(emDashesInVisibleText("a.html", '<button aria-label="Close — discards"></button>')).toHaveLength(1);
    expect(emDashesInVisibleText("a.css", '.x::before { content: "Private — hidden"; }')).toHaveLength(1);
  });
  test("the scanner ignores comments, regex literals and code", () => {
    expect(emDashesInVisibleText("a.js", "// a comment — with a dash\nconst s = 'fine';")).toHaveLength(0);
    expect(emDashesInVisibleText("a.js", "/* block — dash */ const s = 'fine';")).toHaveLength(0);
    expect(emDashesInVisibleText("a.js", "const re = /—/g; const s = 'fine';")).toHaveLength(0);
    expect(emDashesInVisibleText("a.html", "<!-- — --><p>fine</p>")).toHaveLength(0);
    expect(emDashesInVisibleText("a.css", "/* — */ .x { color: red; }")).toHaveLength(0);
  });
  test("a comment does not hide a literal on the same line", () => {
    expect(emDashesInVisibleText("a.js", 'const s = "a — b"; // c — d')).toHaveLength(1);
  });
  test("every tracked source under the SPA, the shell and the CLI is clean", () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(50);
    const findings = files.flatMap((f) => emDashesInVisibleText(f, readFileSync(resolve(ROOT, f), "utf8")));
    expect(
      findings.map((x) => `${x.file}:${x.line}:${x.column}  ${x.text}`),
      "an em dash in text a person can see; use a colon, a period or a comma instead (AGENTS.md, Copy)",
    ).toEqual([]);
  });
});
