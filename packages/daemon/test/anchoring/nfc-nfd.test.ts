// SPDX-License-Identifier: Apache-2.0
// The named "Polish combining chars / NFC-vs-NFD" hard case (A5 §F10, T8 anchor corpus): an
// annotation's quote captured/typed in NFD (a base letter + a trailing combining mark, as some
// editors/IMEs produce) against source text that is NFC (precomposed) — or vice versa. The
// resolver's fixed normalization is "NFC first" (A5 §F10), so this must fall through EXACT
// (byte-different) into NORMALIZED and still resolve, recovering the real (NFC) source text as
// `matched_quote`.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Kazanie

Boża łaska jest wystarczająca dla każdego grzesznika.

Ktoś inny mówi o łasce w innym miejscu tego kazania, zupełnie osobno.
`;

describe("NFC vs NFD combining characters", () => {
  test("an NFD-authored quote (decomposed ż/ą) matches NFC source text — falls to normalized, not exact", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const nfcPhrase = "Boża łaska jest wystarczająca";
    expect(nfcPhrase.normalize("NFC")).toBe(nfcPhrase); // sanity: fixture really is precomposed
    const nfdQuote = nfcPhrase.normalize("NFD");
    expect(nfdQuote).not.toBe(nfcPhrase); // sanity: NFD really is a different byte sequence

    const position = positionOf(artifact, nfcPhrase); // the rendered text is NFC (from the NFC source)
    const res = resolve(annotation({ quoteExact: nfdQuote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("normalized");
    // matched_quote recovers the REAL (NFC) source text, not the NFD needle the annotation carried.
    expect(res.matched_quote).toBe(nfcPhrase);
    expect(res.matched_quote.normalize("NFC")).toBe(res.matched_quote);
    expect(res.start_line).toBe(2);
  });

  test("an NFD quote unique only within its own paragraph still resolves there via normalized fold, even though the un-normalized word appears in a different paragraph too", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    // "łasce" appears in the second paragraph; "łaska" (different inflection) in the first —
    // pick a phrase that's genuinely unique to the first paragraph once folded.
    const nfcPhrase = "dla każdego grzesznika";
    const nfdQuote = nfcPhrase.normalize("NFD");
    const position = positionOf(artifact, nfcPhrase);

    const res = resolve(annotation({ quoteExact: nfdQuote, position }), artifact, freshCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("normalized");
    expect(res.start_line).toBe(2);
  });
});
