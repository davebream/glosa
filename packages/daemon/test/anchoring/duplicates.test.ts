// SPDX-License-Identifier: Apache-2.0
// The named "duplicate quotes" hard case (A5 §F10): uniqueness is ALWAYS required — 0 or ≥2
// matches never auto-apply. A quote duplicated across the document but unique WITHIN its own
// stamped block still resolves there (scoping narrows before uniqueness is checked); duplicated
// even after widening to the whole document → orphaned{ambiguous}, never a guess at which copy.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Document

Powtórzenie: "hello world" pojawia się tutaj po raz pierwszy.

## Druga sekcja

A tutaj "hello world" pojawia się ponownie, w innym miejscu.
`;

describe("duplicate quotes", () => {
  test("a quote duplicated across the doc but unique within its own scoped block still resolves there (exact)", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const quote = "hello world";
    const position = positionOf(artifact, quote, 0); // the first-paragraph occurrence
    const res = resolve(annotation({ quoteExact: quote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.start_line).toBe(2); // scoped to the FIRST paragraph, not the second copy at line 6
  });

  test("the second occurrence resolves to ITS OWN block, not the first", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const quote = "hello world";
    const position = positionOf(artifact, quote, 1); // the second occurrence
    const res = resolve(annotation({ quoteExact: quote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(6);
  });

  test("no position at all (whole-doc scope from the start) + a doc-wide duplicate → orphaned{ambiguous}, never auto-applied to either copy", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const res = resolve(annotation({ quoteExact: "hello world" }), artifact, freshCtx);

    expect(res.kind).toBe("orphaned");
    if (res.kind !== "orphaned") throw new Error("unreachable");
    expect(res.reason).toBe("ambiguous");
  });

  test("a quote duplicated even within ONE block (e.g. a repeated word in the same paragraph) → falls through to widen, then block_range guidance", () => {
    const source = `# Document\n\nAmen, amen, powiadam wam: amen.\n`;
    const { artifact, freshCtx } = buildRArtifact("07.md", source);
    const position = positionOf(artifact, "amen", 0);
    const res = resolve(annotation({ quoteExact: "amen", position }), artifact, freshCtx);

    // "amen" occurs 3x in the one paragraph → ambiguous within the block AND after widening —
    // but the block itself is still identifiable, so this is guidance, not orphaned.
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("block_range");
    expect(res.start_line).toBe(2);
  });
});
