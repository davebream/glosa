// Class R happy paths + the position→block scoping mechanics the rest of the corpus builds on.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Kazanie o łasce

Boża łaska jest wystarczająca dla każdego grzesznika, który się nawróci.

## Sekcja o pokucie

Musimy pamiętać, że pokuta prowadzi do wolności w Chrystusie.
`;

describe("Class R — exact literal match", () => {
  test("a quote taken verbatim from a paragraph resolves exact, scoped to that paragraph's source line", () => {
    const { artifact, freshCtx } = buildRArtifact("07_manuscript.md", SOURCE);
    const quote = "jest wystarczająca dla każdego grzesznika";
    const position = positionOf(artifact, quote);
    const res = resolve(annotation({ quoteExact: quote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.matched_quote).toBe(quote);
    expect(res.path).toBe("07_manuscript.md");
    expect(res.start_line).toBe(2); // the "Boża łaska..." paragraph's source line (0-based)
    expect(res.end_line).toBe(2);
    expect(res.start_col).toBeDefined();
    expect(res.end_col).toBeDefined();
  });

  test("no position at all → whole-doc scope, still resolves exact when unique in the document", () => {
    const { artifact, freshCtx } = buildRArtifact("07_manuscript.md", SOURCE);
    const quote = "pokuta prowadzi do wolności";
    const res = resolve(annotation({ quoteExact: quote }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.start_line).toBe(6);
  });

  test("a heading resolves against its own source line", () => {
    const { artifact, freshCtx } = buildRArtifact("07_manuscript.md", SOURCE);
    const quote = "Sekcja o pokucie";
    const position = positionOf(artifact, quote);
    const res = resolve(annotation({ quoteExact: quote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(4);
    expect(res.confidence).toBe("exact");
  });
});
