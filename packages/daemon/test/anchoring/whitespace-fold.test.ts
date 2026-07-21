// The named "whitespace-fold" hard case (A5 §F10): NBSP / multiple spaces / newlines in the quote
// vs. the source collapse to a single space (all Unicode whitespace, NBSP included) before the
// NORMALIZED comparison — never at the EXACT stage.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Kazanie

Boża łaska jest wystarczająca dla każdego, kto się nawróci i uwierzy.
`;

describe("whitespace-fold", () => {
  test("a quote with an NBSP where the source has an ordinary space still resolves — normalized, not exact", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const nfcPhrase = "wystarczająca dla każdego";
    const position = positionOf(artifact, nfcPhrase);
    const quoteWithNbsp = "wystarczająca dla każdego"; // NBSP instead of the first space
    expect(quoteWithNbsp).not.toBe(nfcPhrase);

    const res = resolve(annotation({ quoteExact: quoteWithNbsp, position }), artifact, freshCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("normalized");
    expect(res.matched_quote).toBe(nfcPhrase); // recovers the real source text (ordinary spaces)
  });

  test("a quote with doubled internal spaces and embedded newlines still folds to a unique match", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const nfcPhrase = "dla każdego, kto się nawróci";
    const position = positionOf(artifact, nfcPhrase);
    const messyQuote = "dla  każdego,\n\nkto się   nawróci"; // double space, blank line, triple space

    const res = resolve(annotation({ quoteExact: messyQuote, position }), artifact, freshCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("normalized");
    expect(res.matched_quote).toBe(nfcPhrase);
  });

  test("leading/trailing whitespace on the quote is trimmed by the fold and still resolves", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const nfcPhrase = "Boża łaska";
    const position = positionOf(artifact, nfcPhrase);
    const res = resolve(annotation({ quoteExact: `  ${nfcPhrase}\n`, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("normalized");
    expect(res.matched_quote).toBe(nfcPhrase);
  });
});
