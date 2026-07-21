// SPDX-License-Identifier: Apache-2.0
// The named "stale hashes" hard case (A5 §F10): `rendered_sha256` no longer matches (the artifact
// was re-rendered since the annotation's `position` was captured) → `position` is NOT trusted,
// even though it's syntactically present — falls straight to whole-doc scope, same as never
// having had a position at all.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf, renderedSha256 } from "./helpers.ts";

const SOURCE = `# Kazanie

Boża łaska jest wystarczająca dla każdego grzesznika.

## Druga sekcja

Zupełnie inny akapit, gdzie indziej w dokumencie.
`;

describe("stale rendered_sha256", () => {
  test("ctx.capturedRenderedSha256 mismatches the artifact's current rendered bytes → position ignored, whole-doc search used instead — still resolves when unique", () => {
    const { artifact } = buildRArtifact("07.md", SOURCE);
    const quote = "dla każdego grzesznika";
    // A position that, if trusted, would scope to the FIRST paragraph (line 2) — but the captured
    // hash is stale, so the resolver must not lean on it at all.
    const position = positionOf(artifact, quote);
    const staleCtx = { capturedRenderedSha256: "0000000000000000000000000000000000000000000000000000000000000000" };

    const res = resolve(annotation({ quoteExact: quote, position }), artifact, staleCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact"); // still findable — just via the whole-doc path, not the block one
  });

  test("no capturedRenderedSha256 supplied at all → treated the same as stale (no proof, no trust)", () => {
    const { artifact } = buildRArtifact("07.md", SOURCE);
    const quote = "dla każdego grzesznika";
    const position = positionOf(artifact, quote);

    const res = resolve(annotation({ quoteExact: quote, position }), artifact, {});
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
  });

  test("a stale hash + a doc-wide duplicate → orphaned{ambiguous}, since there's no block scope to fall back on", () => {
    const source = `# Kazanie\n\n"hello world" pierwszy raz.\n\n## Sekcja\n\n"hello world" drugi raz.\n`;
    const { artifact } = buildRArtifact("07.md", source);
    const position = positionOf(artifact, "hello world", 0);
    const res = resolve(annotation({ quoteExact: "hello world", position }), artifact, {});

    expect(res.kind).toBe("orphaned");
    if (res.kind !== "orphaned") throw new Error("unreachable");
    expect(res.reason).toBe("ambiguous");
  });

  test("a fresh (matching) hash DOES trust position and scopes to the block — contrast case", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const quote = "dla każdego grzesznika";
    const position = positionOf(artifact, quote);
    const res = resolve(annotation({ quoteExact: quote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(2);
  });

  test("sanity: renderedSha256(html) actually changes when the artifact is re-rendered with different content", () => {
    const { artifact } = buildRArtifact("07.md", SOURCE);
    const otherHtmlSha = renderedSha256("<p data-line=\"0\">completely different</p>");
    expect(otherHtmlSha).not.toBe(renderedSha256(artifact.renderedHtml));
  });
});
