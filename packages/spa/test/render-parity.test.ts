// SPDX-License-Identifier: Apache-2.0
// #271 — the browser renders too, and its output must be the daemon's output exactly.
//
// The daemon stays the authority for an artifact's HTML. The SPA gained a renderer so that a single
// run the writer just edited can come back on the page immediately instead of after a save round
// trip; the daemon's own render replaces it on the next refresh.
//
// That optimistic paint is only safe while the two agree byte for byte. If they drift, a block
// would visibly change the moment the authoritative render arrived — the flicker this whole line of
// work exists to remove — and `data-line`, which class-R anchoring resolves passages against, could
// differ between the two. So this file holds them to string equality over the repository's own
// documents rather than over a fixture that cannot drift.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown as daemonRender } from "../../daemon/src/artifact-render.ts";
import { renderMarkdown as browserRender } from "../src/markdown-parser.js";

const documents = [
  "README.md",
  "AGENTS.md",
  "DESIGN.md",
  "CONTRIBUTING.md",
  "ROADMAP.md",
  "PRODUCT.md",
  "CHANGELOG.md",
  "docs/requirements.md",
  "docs/decisions.md",
];

const read = (name: string) => readFileSync(join(import.meta.dir, "../../..", name), "utf8");

describe("#271 — the browser renderer matches the daemon's", () => {
  for (const name of documents) {
    test(`${name} renders identically on both sides`, () => {
      const source = read(name);
      expect(browserRender(source)).toBe(daemonRender(source));
    });
  }

  test("constructs that only one side used to understand still agree", () => {
    // The #270 pair, restated here against the RENDERER rather than the tokenizer. Tables and
    // strikethrough are where the two sides diverged before, so they are where a future divergence
    // is most likely to reappear.
    const source = "| a | b |\n|---|---|\n| 1 | 2 |\n\nSome ~~struck~~ text.\n";
    expect(browserRender(source)).toBe(daemonRender(source));
    expect(browserRender(source)).toContain("<table");
    expect(browserRender(source)).toContain("<s>");
  });

  test("the browser stamps data-line, which is what anchoring resolves against", () => {
    // The reason this renderer could not simply be `commonMarkTokenizer.render()`: that instance is
    // handed to prosemirror-markdown and must not start emitting stamped attributes, so the stamp
    // lives on a second instance. A browser render WITHOUT the stamp would still look right and
    // would silently strip every anchor target on the run it repainted.
    const html = browserRender("# One\n\nTwo\n");
    expect(html).toContain('data-line="0"');
    expect(html).toContain('data-line="2"');
  });

  test("non-manuscript regions stay hidden on the browser side too", () => {
    // Front matter and `%%` comments are not manuscript. If the browser renderer had been built
    // without `installNonManuscriptRules`, repainting an edited run would have exposed a document's
    // metadata header as a heading — the #175 defect, reintroduced through the back door.
    const html = browserRender("---\ntitle: T\n---\n\n# Visible\n\n%%\nprivate\n%%\n");
    expect(html).not.toContain("title: T");
    expect(html).not.toContain("private");
    expect(html).toContain("Visible");
  });
});
