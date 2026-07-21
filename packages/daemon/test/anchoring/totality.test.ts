// Totality (A5 §F10: "total, never throws, never guesses") — resolve() must survive garbage
// input of every shape and always return a member of the Resolution union. Plus a focused
// uniqueness-gate check: 0 matches and ≥2 matches must NEVER produce an auto-applied exact/
// normalized source_range, regardless of how the miss happened.
import { describe, expect, test } from "bun:test";
import { resolve, type Resolution } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const VALID_R_RESOLUTION_KINDS = new Set(["source_range", "orphaned"]); // Class R never pipeline_feedback

function assertIsValidResolution(res: unknown): asserts res is Resolution {
  expect(res).toBeTypeOf("object");
  const r = res as Record<string, unknown>;
  expect(["source_range", "pipeline_feedback", "orphaned"]).toContain(r.kind as string);
  if (r.kind === "source_range") {
    expect(typeof r.path).toBe("string");
    expect(typeof r.start_line).toBe("number");
    expect(typeof r.end_line).toBe("number");
    expect(typeof r.matched_quote).toBe("string");
    expect(["exact", "normalized", "block_range"]).toContain(r.confidence as string);
  } else if (r.kind === "pipeline_feedback") {
    expect(typeof r.intent).toBe("string");
    expect(typeof r.body).toBe("string");
  } else {
    expect(["hash_mismatch_no_match", "ambiguous", "no_source_map", "quote_absent_not_transformed"]).toContain(r.reason as string);
  }
}

describe("totality — garbage annotation input never throws", () => {
  const SOURCE = "# Kazanie\n\nBoża łaska jest wystarczająca.\n";

  const garbageAnnotations: unknown[] = [
    null,
    undefined,
    {},
    { target: null },
    { target: {} },
    { target: { quote: null } },
    { target: { quote: {} } },
    { target: { quote: { exact: null } } },
    { target: { quote: { exact: 12345 } } },
    { target: { quote: { exact: "" } } },
    { target: { quote: { exact: "x".repeat(200_000) } } }, // huge quote, far longer than the source
    { target: { quote: { exact: "łaska" }, position: null } },
    { target: { quote: { exact: "łaska" }, position: {} } },
    { target: { quote: { exact: "łaska" }, position: { start: "zero", end: 5 } } },
    { target: { quote: { exact: "łaska" }, position: { start: -50, end: 5 } } },
    { target: { quote: { exact: "łaska" }, position: { start: 10, end: 3 } } }, // end < start
    { target: { quote: { exact: "łaska" }, position: { start: NaN, end: Infinity } } },
    { target: { quote: { exact: "łaska" }, position: { start: 1.5, end: 3.7 } } }, // non-integers
    { body: 42, intent: {}, target: { quote: { exact: "łaska" } } },
    "just a string, not an object at all",
    42,
    [1, 2, 3],
    { target: { chunk_id: 999, quote: { exact: "x" } } }, // chunk_id wrong type
  ];

  const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);

  test.each(garbageAnnotations.map((a, i) => [i, a] as const))("garbage annotation #%p never throws, always a valid Resolution", (_i, garbage) => {
    let res: unknown;
    expect(() => {
      res = resolve(garbage, artifact, freshCtx);
    }).not.toThrow();
    assertIsValidResolution(res);
    expect(VALID_R_RESOLUTION_KINDS.has((res as Resolution).kind)).toBe(true);
  });
});

describe("totality — garbage artifact input never throws", () => {
  const okAnnotation = annotation({ quoteExact: "łaska" });

  const garbageArtifacts: unknown[] = [
    null,
    undefined,
    {},
    { class: "R" }, // missing path/source/renderedHtml
    { class: "R", path: "07.md", source: "x" }, // missing renderedHtml
    { class: "F", path: "x.html" }, // missing source
    { class: "Q", path: "x", source: "x" }, // unknown class
    { class: "R", path: 5, source: "x", renderedHtml: "<p>x</p>" }, // wrong path type
    { class: "F", path: "x.html", source: "manuscript text", manifest: "not an object" },
    { class: "F", path: "x.html", source: "manuscript text", manifest: { chunks: "not an array" } },
    "not an object",
    42,
  ];

  test.each(garbageArtifacts.map((a, i) => [i, a] as const))("garbage artifact #%p never throws, always orphaned/no_source_map-shaped", (_i, garbage) => {
    let res: unknown;
    expect(() => {
      res = resolve(okAnnotation, garbage, {});
    }).not.toThrow();
    assertIsValidResolution(res);
  });
});

describe("totality — garbage ctx never throws", () => {
  const { artifact } = buildRArtifact("07.md", "# Kazanie\n\nBoża łaska.\n");
  const okAnnotation = annotation({ quoteExact: "łaska" });
  const garbageCtxs: unknown[] = [null, undefined, "nope", 42, { capturedRenderedSha256: 12345 }, { pipelineFeedback: "not an object" }, { pipelineFeedback: { adapter: 5 } }];

  test.each(garbageCtxs.map((c, i) => [i, c] as const))("garbage ctx #%p never throws", (_i, garbage) => {
    let res: unknown;
    expect(() => {
      res = resolve(okAnnotation, artifact, garbage);
    }).not.toThrow();
    assertIsValidResolution(res);
  });
});

describe("uniqueness gate — 0 or ≥2 matches never auto-apply exact/normalized", () => {
  test("0 matches anywhere (no position) → orphaned, never a fabricated source_range", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nBoża łaska.\n");
    const res = resolve(annotation({ quoteExact: "text that is nowhere in this document" }), artifact, freshCtx);
    expect(res.kind).toBe("orphaned");
  });

  test("≥2 matches anywhere (no position) → orphaned{ambiguous}, never a coin-flip source_range", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nAmen amen powiadam.\n\namen znowu tutaj.\n");
    const res = resolve(annotation({ quoteExact: "amen" }), artifact, freshCtx);
    expect(res.kind).toBe("orphaned");
    if (res.kind !== "orphaned") throw new Error("unreachable");
    expect(res.reason).toBe("ambiguous");
  });

  test("an empty quote never resolves to a confident exact/normalized match", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nBoża łaska.\n");
    const position = positionOf(artifact, "Boża");
    const res = resolve(annotation({ quoteExact: "", position }), artifact, freshCtx);
    if (res.kind === "source_range") {
      expect(res.confidence).not.toBe("exact");
      expect(res.confidence).not.toBe("normalized");
    } else {
      expect(res.kind).toBe("orphaned");
    }
  });
});

describe("a lone (unpaired) surrogate in the quote never produces a mid-character 'exact' match", () => {
  test("a lone high surrogate prepended to a real quote is stripped, not searched for literally", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nBoża łaska jest wystarczająca.\n");
    const position = positionOf(artifact, "Boża łaska");
    const quoteWithLoneSurrogate = "\uD800Boża łaska"; // an unpaired high surrogate, not a real astral char
    const res = resolve(annotation({ quoteExact: quoteWithLoneSurrogate, position }), artifact, freshCtx);

    // The lone surrogate is stripped before it ever reaches the search — the sanitized needle
    // ("Boża łaska") is real text and resolves normally, never a bogus mid-character "exact" hit.
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.matched_quote).toBe("Boża łaska");
  });

  test("a well-formed astral character (a real surrogate PAIR) survives sanitization untouched", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nEmoji: 😀 jest tutaj.\n");
    const position = positionOf(artifact, "😀 jest");
    const res = resolve(annotation({ quoteExact: "😀 jest", position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.matched_quote).toBe("😀 jest");
  });

  test("a quote consisting ONLY of lone surrogates sanitizes to empty and never fabricates a match", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", "# Kazanie\n\nBoża łaska.\n");
    // \uDE00 is a lone low surrogate, \uD801 (at the very end, nothing following) is a lone high
    // surrogate — neither forms a valid pair, so both are stripped, leaving an empty needle.
    const res = resolve(annotation({ quoteExact: "\uDE00\uD801" }), artifact, freshCtx);
    // An empty needle on a non-empty whole-doc scope matches "everywhere" (ambiguous), never a
    // fabricated single-location hit.
    expect(res).toEqual({ kind: "orphaned", reason: "ambiguous" });
  });
});
