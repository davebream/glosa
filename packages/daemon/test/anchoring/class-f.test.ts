// The Class F cascade (A5 §F10/§F11): chunk manifest lookup → staleness → verbatim-search-or-
// orphaned (transformed:false) vs. typed pipeline_feedback (transformed:true), with the F11
// honesty invariant that `intent` never authorizes the feedback path — only `transformed:true` does.
import { describe, expect, test } from "bun:test";
import { resolve, type ChunkManifest, type ClassFArtifact } from "../../src/anchoring.ts";
import { annotation } from "./helpers.ts";
import { sourceSha256 } from "../../src/artifact-render.ts";

// The manuscript this class-F artifact's HTML was derived FROM (per R7's derived-from edge) —
// resolve() anchors into THIS text, never the HTML.
const MANUSCRIPT = `# Kazanie

Boża łaska jest wystarczająca dla każdego grzesznika.

Ten fragment został sparafrazowany przez format-sermon i już nie brzmi jak oryginał.
`;

function manuscriptSha(text = MANUSCRIPT): string {
  return sourceSha256(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8"));
}

function chunkSliceSha(text: string, l0: number, l1: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return sourceSha256(Buffer.from(lines.slice(l0, l1 + 1).join("\n"), "utf8"));
}

function buildFArtifact(manifest?: ChunkManifest): ClassFArtifact {
  return { class: "F", path: "output/sermon/speech-notes.html", source: MANUSCRIPT, ...(manifest ? { manifest } : {}) };
}

function freshManifest(chunks: ChunkManifest["chunks"]): ChunkManifest {
  return { manifest_version: 1, source_path: "07_manuscript.md", source_sha256: manuscriptSha(), chunks };
}

describe("Class F — no manifest / no chunk", () => {
  test("no manifest at all → orphaned{no_source_map}", () => {
    const res = resolve(annotation({ quoteExact: "anything", chunkId: "chunk-001" }), buildFArtifact(undefined), {});
    expect(res).toEqual({ kind: "orphaned", reason: "no_source_map" });
  });

  test("chunk_id not present in the manifest → orphaned{no_source_map}", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-999", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2) },
    ]);
    const res = resolve(annotation({ quoteExact: "anything", chunkId: "chunk-not-in-manifest" }), buildFArtifact(manifest), {});
    expect(res).toEqual({ kind: "orphaned", reason: "no_source_map" });
  });

  test("no chunk_id on the annotation at all → orphaned{no_source_map}", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-001", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2) },
    ]);
    const res = resolve(annotation({ quoteExact: "anything" }), buildFArtifact(manifest), {});
    expect(res).toEqual({ kind: "orphaned", reason: "no_source_map" });
  });
});

describe("Class F — transformed:false (verbatim chunk)", () => {
  test("the quote is findable verbatim in the chunk's declared source lines → source_range against the MANUSCRIPT path", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-001", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2), transformed: false },
    ]);
    const res = resolve(annotation({ quoteExact: "dla każdego grzesznika", chunkId: "chunk-001" }), buildFArtifact(manifest), {});

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.path).toBe("07_manuscript.md"); // the SOURCE (manuscript) path, not the HTML's own path
    expect(res.confidence).toBe("exact");
    expect(res.start_line).toBe(2);
  });

  test("`transformed` omitted defaults to false — same verbatim-search behavior", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-001", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2) },
    ]);
    const res = resolve(annotation({ quoteExact: "dla każdego grzesznika", chunkId: "chunk-001" }), buildFArtifact(manifest), {});
    expect(res.kind).toBe("source_range");
  });

  test("the quote occurs TWICE within a verbatim chunk → orphaned{ambiguous}, NOT quote_absent_not_transformed — the quote IS present, just not unique", () => {
    const manuscript = "# Kazanie\n\nAmen, amen, powiadam wam: amen.\n";
    const artifact: ClassFArtifact = { class: "F", path: "output/sermon/speech-notes.html", source: manuscript };
    const manifest: ChunkManifest = {
      manifest_version: 1,
      source_path: "07_manuscript.md",
      source_sha256: sourceSha256(Buffer.from(manuscript, "utf8")),
      chunks: [
        {
          chunk_id: "chunk-001",
          source_start_line: 2,
          source_end_line: 2,
          source_sha256: chunkSliceSha(manuscript, 2, 2),
          transformed: false,
        },
      ],
    };
    const res = resolve(annotation({ quoteExact: "amen", chunkId: "chunk-001" }), { ...artifact, manifest }, {});
    expect(res).toEqual({ kind: "orphaned", reason: "ambiguous" });
  });

  test("the quote is absent from a verbatim chunk → orphaned{quote_absent_not_transformed}, EVEN with intent:classification — intent does not rescue", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-001", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2), transformed: false },
    ]);
    const res = resolve(
      annotation({ quoteExact: "this text is nowhere in the chunk", chunkId: "chunk-001", intent: "classification" }),
      buildFArtifact(manifest),
      {},
    );
    expect(res).toEqual({ kind: "orphaned", reason: "quote_absent_not_transformed" });
  });

  test("staleness: chunk.source_sha256 no longer matches its declared line range → widens to the whole document rather than trusting the stale range", () => {
    // Declare the chunk against the WRONG lines (line 4, the paraphrased sentence) with a stale
    // hash that doesn't match line 4's actual current content — but the quote genuinely lives at
    // line 2. Trusting the declared (stale) range would search line 4 and miss it; widening finds it.
    const manifest: ChunkManifest = {
      manifest_version: 1,
      source_path: "07_manuscript.md",
      source_sha256: manuscriptSha(),
      chunks: [{ chunk_id: "chunk-001", source_start_line: 4, source_end_line: 4, source_sha256: "0".repeat(64), transformed: false }],
    };
    const res = resolve(annotation({ quoteExact: "dla każdego grzesznika", chunkId: "chunk-001" }), buildFArtifact(manifest), {});

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(2);
  });

  test("staleness: whole-manifest source_sha256 mismatch also forces the widen-to-whole-doc path", () => {
    const manifest: ChunkManifest = {
      manifest_version: 1,
      source_path: "07_manuscript.md",
      source_sha256: "0".repeat(64), // stale against the WHOLE current manuscript
      chunks: [{ chunk_id: "chunk-001", source_start_line: 2, source_end_line: 2, source_sha256: chunkSliceSha(MANUSCRIPT, 2, 2), transformed: false }],
    };
    const res = resolve(annotation({ quoteExact: "sparafrazowany przez format-sermon", chunkId: "chunk-001" }), buildFArtifact(manifest), {});
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(4);
  });
});

describe("Class F — transformed:true (paraphrased chunk)", () => {
  test("always routes to pipeline_feedback — no search is even attempted, even when the quote WOULD be findable", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-002", source_start_line: 4, source_end_line: 4, source_sha256: chunkSliceSha(MANUSCRIPT, 4, 4), transformed: true },
    ]);
    const res = resolve(
      annotation({ quoteExact: "sparafrazowany przez format-sermon", chunkId: "chunk-002", intent: "classification", body: "wrong split" }),
      buildFArtifact(manifest),
      { pipelineFeedback: { adapter: "jethro", component: "format-sermon" } },
    );

    expect(res).toEqual({
      kind: "pipeline_feedback",
      target: { adapter: "jethro", component: "format-sermon", chunk_id: "chunk-002", source_line_range: [4, 4] },
      intent: "classification",
      body: "wrong split",
    });
  });

  test("no ctx.pipelineFeedback supplied → falls back to \"unknown\"/\"unknown\" rather than inventing or throwing", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-002", source_start_line: 4, source_end_line: 4, source_sha256: chunkSliceSha(MANUSCRIPT, 4, 4), transformed: true },
    ]);
    const res = resolve(annotation({ quoteExact: "anything", chunkId: "chunk-002" }), buildFArtifact(manifest), {});
    expect(res.kind).toBe("pipeline_feedback");
    if (res.kind !== "pipeline_feedback") throw new Error("unreachable");
    expect(res.target.adapter).toBe("unknown");
    expect(res.target.component).toBe("unknown");
  });

  test("a missing quote on a transformed chunk is STILL pipeline_feedback, not orphaned — there's nothing to verify against", () => {
    const manifest = freshManifest([
      { chunk_id: "chunk-002", source_start_line: 4, source_end_line: 4, source_sha256: chunkSliceSha(MANUSCRIPT, 4, 4), transformed: true },
    ]);
    const res = resolve(annotation({ quoteExact: "text that appears literally nowhere", chunkId: "chunk-002" }), buildFArtifact(manifest), {});
    expect(res.kind).toBe("pipeline_feedback");
  });
});
