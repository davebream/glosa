// SPDX-License-Identifier: Apache-2.0
//
// The fore-edge index. Everything here is the part of the instrument that has to be right without
// a browser to look at: what counts as a heading, how deep it sits, where its rule lands on the
// rail, which section the reader is standing in, and what a typed query matches.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectSourceHeadings } from "../src/markdown-parser.js";
import { installDom, type DomEnv } from "./dom-env.ts";
import {
  collectRenderedHeadings,
  currentHeadingIndex,
  matchesQuery,
  outlineDepths,
  plainHeadingText,
} from "../src/outline.js";

describe("heading text", () => {
  test("a source heading and its rendered twin arrive at the same string", () => {
    expect(plainHeadingText("The **hard** part")).toBe("The hard part");
    expect(plainHeadingText("`glosa open` and _why_")).toBe("glosa open and why");
    expect(plainHeadingText("See [the brief](docs/brief.md)")).toBe("See the brief");
    expect(plainHeadingText("R4 — delivery  (detail:  A2)")).toBe("R4 — delivery (detail: A2)");
  });
});

describe("collectSourceHeadings", () => {
  test("reads ATX headings with their level, line, and byte offset", () => {
    const source = ["# Title", "", "text", "", "## Section", "", "### Detail"].join("\n");
    expect(collectSourceHeadings(source)).toEqual([
      { level: 1, text: "Title", line: 0, offset: 0 },
      { level: 2, text: "Section", line: 4, offset: 15 },
      { level: 3, text: "Detail", line: 6, offset: 27 },
    ]);
  });

  test("ignores hashes inside a fenced block", () => {
    const source = ["# Real", "", "```bash", "# not a heading", "```", "", "## Also real"].join("\n");
    expect(collectSourceHeadings(source).map((heading) => heading.text)).toEqual(["Real", "Also real"]);
  });

  test("closes a fence only on a matching marker, so a tilde block survives a backtick line", () => {
    const source = ["~~~", "```", "# still fenced", "~~~", "", "# out"].join("\n");
    expect(collectSourceHeadings(source).map((heading) => heading.text)).toEqual(["out"]);
  });

  test("reads top-level and nested setext headings but not a thematic break", () => {
    const source = ["Title", "=====", "", "Section", "-------", "", "---", "", "- item", "  ---"].join("\n");
    expect(collectSourceHeadings(source)).toEqual([
      { level: 1, text: "Title", line: 0, offset: 0 },
      { level: 2, text: "Section", line: 3, offset: 13 },
      { level: 2, text: "item", line: 8, offset: 35 },
    ]);
  });

  test("drops a heading with no text rather than offering an empty destination", () => {
    expect(collectSourceHeadings("#\n\n##   \n\n# Kept")).toEqual([{ level: 1, text: "Kept", line: 4, offset: 10 }]);
  });

  test("strips a closed ATX heading's trailing hashes", () => {
    expect(collectSourceHeadings("## Balanced ##")[0]?.text).toBe("Balanced");
  });
});

describe("collectRenderedHeadings", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("reads every heading level out of rendered markup, in document order", () => {
    const root = dom.document.createElement("div");
    root.innerHTML = "<h1>Title</h1><p>x</p><h2>Section</h2><h3><em>Deep</em></h3><h2></h2>";
    expect(collectRenderedHeadings(root).map((heading) => [heading.level, heading.text])).toEqual([
      [1, "Title"],
      [2, "Section"],
      [3, "Deep"],
    ]);
  });

  test("no root is no outline, not a crash", () => {
    expect(collectRenderedHeadings(null)).toEqual([]);
  });
});

describe("outlineDepths", () => {
  test("indents from the document's own top level, not from an absent h1", () => {
    expect(outlineDepths([{ level: 2 }, { level: 3 }, { level: 3 }, { level: 2 }])).toEqual([1, 2, 2, 1]);
  });

  test("a skipped level does not open a phantom rung", () => {
    expect(outlineDepths([{ level: 1 }, { level: 3 }, { level: 2 }])).toEqual([1, 2, 2]);
  });

  test("an empty document has no depths", () => {
    expect(outlineDepths([])).toEqual([]);
  });
});

const gapsOf = (tops: number[]) => tops.slice(1).map((top, index) => top - (tops[index] as number));

describe("currentHeadingIndex", () => {
  test("is the last heading whose top has passed the reading line", () => {
    const tops = [0, 400, 900];
    expect(currentHeadingIndex(tops, 0, 96)).toBe(0);
    expect(currentHeadingIndex(tops, 350, 96)).toBe(1);
    expect(currentHeadingIndex(tops, 1000, 96)).toBe(2);
  });

  test("claims nothing while the reader is still in the preamble", () => {
    expect(currentHeadingIndex([300, 900], 0, 96)).toBe(-1);
    expect(currentHeadingIndex([], 0, 96)).toBe(-1);
  });
});

describe("matchesQuery", () => {
  test("every word must appear, case-insensitively and in any order", () => {
    expect(matchesQuery("Functional requirements", "req")).toBe(true);
    expect(matchesQuery("Functional requirements", "func req")).toBe(true);
    expect(matchesQuery("Functional requirements", "req func")).toBe(true);
    expect(matchesQuery("Functional requirements", "func zzz")).toBe(false);
  });

  test("scattered letters do not match — long prose headings would all match everything", () => {
    expect(matchesQuery("R9 — attention model", "attn")).toBe(false);
    expect(matchesQuery("What changed from v1 (orientation for anyone who read v1)", "attn")).toBe(false);
    expect(matchesQuery("R9 — attention model", "attention")).toBe(true);
  });

  test("an empty query hides nothing", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });
});
