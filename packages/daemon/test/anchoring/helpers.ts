// Test-only helpers for the anchoring resolver corpus (P3.4). Fixtures go through the REAL
// rendering pipeline (artifact-render.ts's renderMarkdown), and `position` offsets are computed
// against the REAL rendered textContent via happy-dom — the same string annotate.js's `position`
// offsets are into (packages/spa/src/annotate.js) — rather than hand-counted string indices, so a
// fixture can't drift from what a real browser selection would actually produce.
import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { renderMarkdown } from "../../src/artifact-render.ts";
import type { AnchoringAnnotation, ClassRArtifact, ResolveCtx } from "../../src/anchoring.ts";

export function renderedSha256(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

export function renderedTextOf(html: string): string {
  const w = new Window();
  w.document.body.innerHTML = html;
  return w.document.body.textContent ?? "";
}

/** A Class R artifact built from real source through the real markdown-it pipeline, plus a ctx
 * whose `capturedRenderedSha256` is fresh (matches the artifact's current rendered bytes) — the
 * "position is trustworthy" case most fixtures want by default. */
export function buildRArtifact(path: string, source: string): { artifact: ClassRArtifact; freshCtx: ResolveCtx } {
  const renderedHtml = renderMarkdown(source);
  return {
    artifact: { class: "R", path, source, renderedHtml },
    freshCtx: { capturedRenderedSha256: renderedSha256(renderedHtml) },
  };
}

/** Locates the `occurrence`-th copy of `needle` in the artifact's real rendered textContent and
 * returns the `position` a real browser selection over that text would produce. Throws at test
 * setup time (never inside the resolver itself) if the needle isn't where the fixture expects —
 * a corpus fixture that doesn't actually contain what it claims should fail loudly, not silently
 * test the wrong thing. */
export function positionOf(artifact: ClassRArtifact, needle: string, occurrence = 0): { start: number; end: number } {
  const text = renderedTextOf(artifact.renderedHtml);
  let from = 0;
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(needle, from);
    if (idx === -1) {
      throw new Error(`positionOf: "${needle}" occurrence ${occurrence} not found in rendered text: ${JSON.stringify(text)}`);
    }
    from = idx + 1;
  }
  return { start: idx, end: idx + needle.length };
}

export function annotation(opts: {
  body?: string;
  intent?: string;
  quoteExact: string;
  prefix?: string;
  suffix?: string;
  position?: { start: number; end: number };
  chunkId?: string;
}): AnchoringAnnotation {
  return {
    body: opts.body ?? "a note",
    intent: opts.intent ?? "content",
    target: {
      ...(opts.chunkId !== undefined ? { chunk_id: opts.chunkId } : {}),
      quote: { exact: opts.quoteExact, prefix: opts.prefix ?? "", suffix: opts.suffix ?? "" },
      ...(opts.position ? { position: opts.position } : {}),
    },
  };
}
