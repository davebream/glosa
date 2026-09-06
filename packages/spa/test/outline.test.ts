// SPDX-License-Identifier: Apache-2.0
//
// The fore-edge index. Everything here is the part of the instrument that has to be right without
// a browser to look at: what counts as a heading, how deep it sits, where its rule lands on the
// rail, which section the reader is standing in, and what a typed query matches.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom, type DomEnv } from "./dom-env.ts";
import {
  collectRenderedHeadings,
  createOutlineController,
  collectSourceHeadings,
  currentHeadingIndex,
  distributeRules,
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

  test("reads setext headings but not a thematic break or a list rule", () => {
    const source = ["Title", "=====", "", "Section", "-------", "", "---", "", "- item", "  ---"].join("\n");
    expect(collectSourceHeadings(source)).toEqual([
      { level: 1, text: "Title", line: 0, offset: 0 },
      { level: 2, text: "Section", line: 3, offset: 13 },
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

describe("distributeRules", () => {
  test("places a rule where its section actually falls in the document", () => {
    expect(distributeRules([0, 0.5, 1], 102)).toEqual([0, 50, 100]);
  });

  test("spreads a crowd to the minimum legible gap instead of drawing one smudge", () => {
    const gaps = gapsOf(distributeRules([0.5, 0.501, 0.502], 202, { minGap: 5 }));
    expect(gaps).toEqual([5, 5]);
  });

  test("a crowd at the very end is pulled back up rather than pushed off the rail", () => {
    const tops = distributeRules([0.99, 0.995, 1], 102, { minGap: 5 });
    expect(Math.max(...tops)).toBeLessThanOrEqual(100);
    expect(gapsOf(tops)).toEqual([5, 5]);
  });

  test("every rule stays inside the rail even when there are more than it can hold", () => {
    const fractions = Array.from({ length: 60 }, (_, index) => index / 59);
    for (const top of distributeRules(fractions, 100)) {
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(98);
    }
  });

  test("survives a document with no measurable extent", () => {
    expect(distributeRules([Number.NaN, 0.5], 0)).toEqual([0, 0]);
    expect(distributeRules([], 100)).toEqual([]);
  });
});

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

describe("the fore-edge controller", () => {
  let dom: DomEnv;
  let host: any;
  // happy-dom's DOM classes are nominally distinct from lib.dom's (see dom-env.ts), so DOM
  // handles are read loosely here — the same idiom viewer.test.ts and workbench.test.ts use.
  const one = (selector: string): any => host.querySelector(selector);
  const all = (selector: string): any[] => Array.from(host.querySelectorAll(selector));

  const entry = (text: string, depth = 1, fraction = 0, jump = () => {}) => ({
    level: depth,
    depth,
    text,
    fraction,
    jump,
  });

  beforeEach(() => {
    dom = installDom();
    host = dom.document.createElement("div");
    dom.document.body.append(host);
  });
  afterEach(() => dom.teardown());

  test("a document with fewer than two headings gets no instrument at all", () => {
    const outline = createOutlineController({ host, id: "o1" });
    outline.setEntries([entry("Only a title")]);
    expect(outline.hasEntries()).toBe(false);
    expect(one(".glosa-foreedge").hidden).toBe(true);

    outline.setEntries([entry("Title"), entry("A section", 2, 0.5)]);
    expect(outline.hasEntries()).toBe(true);
    expect(one(".glosa-foreedge").hidden).toBe(false);
    outline.destroy();
  });

  test("toggle opens the panel, lists every heading, and closes again", () => {
    const outline = createOutlineController({ host, id: "o2" });
    outline.setEntries([entry("Title"), entry("One", 2, 0.3), entry("Two", 2, 0.6)]);
    outline.toggle();
    expect(outline.isOpen()).toBe(true);
    expect(all(".glosa-foreedge-row").map((row) => row.textContent)).toEqual(["Title", "One", "Two"]);
    outline.toggle();
    expect(outline.isOpen()).toBe(false);
    expect(one(".glosa-foreedge-panel").hidden).toBe(true);
    outline.destroy();
  });

  test("the filter narrows the list in document order and says so when nothing matches", () => {
    const outline = createOutlineController({ host, id: "o3" });
    outline.setEntries([
      entry("Goal and release gate"),
      entry("Functional requirements", 2, 0.4),
      entry("Glossary", 2, 0.9),
    ]);
    outline.toggle();
    const filter = one(".glosa-foreedge-filter");
    const type = (value: string) => {
      filter.value = value;
      filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };

    type("g");
    expect(all(".glosa-foreedge-row").map((row) => row.textContent)).toEqual(["Goal and release gate", "Glossary"]);

    type("nothing here");
    expect(all(".glosa-foreedge-row")).toHaveLength(0);
    expect(one(".glosa-foreedge-empty").hidden).toBe(false);
    outline.destroy();
  });

  test("a jumped-to heading closes the panel and runs its jump", () => {
    let jumped = "";
    const outline = createOutlineController({ host, id: "o4" });
    outline.setEntries([
      entry("Title", 1, 0, () => {
        jumped = "Title";
      }),
      entry("Section", 2, 0.5, () => {
        jumped = "Section";
      }),
    ]);
    outline.toggle();
    all(".glosa-foreedge-row")[1].click();
    expect(jumped).toBe("Section");
    expect(outline.isOpen()).toBe(false);
    outline.destroy();
  });

  test("the current section is named in the rail's accessible name, and marked in the open list", () => {
    const outline = createOutlineController({ host, id: "o5" });
    outline.setEntries([entry("Title"), entry("Second section", 2, 0.5)]);
    outline.setCurrent(1);
    expect(one(".glosa-foreedge-rail").getAttribute("aria-label")).toBe("Outline: in Second section");
    outline.toggle();
    expect(one('.glosa-foreedge-row[aria-current="location"]').textContent).toBe("Second section");

    // Scrolling back above the first heading is not "in section one" — it is the preamble, and
    // saying otherwise would be a small lie told on every scroll.
    outline.setCurrent(-1);
    expect(one(".glosa-foreedge-rail").getAttribute("aria-label")).toBe("Outline");
    expect(one('.glosa-foreedge-row[aria-current="location"]')).toBeNull();
    outline.destroy();
  });

  test("a pane with no whitespace left stops volunteering on hover, and still opens when asked", () => {
    const outline = createOutlineController({ host, id: "o6" });
    outline.setEntries([entry("Title"), entry("Section", 2, 0.5)]);
    outline.setCompact(true);
    one(".glosa-foreedge").dispatchEvent(new dom.window.Event("pointerenter"));
    expect(outline.isOpen()).toBe(false);
    outline.toggle();
    expect(outline.isOpen()).toBe(true);
    outline.destroy();
  });

  test("destroy takes the instrument out of the DOM", () => {
    const outline = createOutlineController({ host, id: "o7" });
    outline.setEntries([entry("Title"), entry("Section", 2, 0.5)]);
    outline.destroy();
    expect(one(".glosa-foreedge")).toBeNull();
  });
});
