// F11: Class R has no declared transform, so it can NEVER return `pipeline_feedback` — regardless
// of `intent`. A miss is `orphaned` or `block_range` guidance, never routed to a producer that
// doesn't exist for this artifact class.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Kazanie

Boża łaska jest wystarczająca.
`;

describe("Class R never returns pipeline_feedback", () => {
  for (const intent of ["content", "classification", "style", "anything-else-entirely"]) {
    test(`intent="${intent}" on a total miss still resolves to orphaned/block_range, never pipeline_feedback`, () => {
      const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
      const res = resolve(annotation({ quoteExact: "this text does not exist anywhere in the source", intent }), artifact, freshCtx);
      expect(res.kind).not.toBe("pipeline_feedback");
      expect(["orphaned", "source_range"]).toContain(res.kind);
    });

    test(`intent="${intent}" on a markup-crossing block_range miss is still source_range, never pipeline_feedback`, () => {
      const source = `# Kazanie\n\nTo jest **kluczowe** zdanie z linkiem [tutaj](http://example.com).\n`;
      const { artifact, freshCtx } = buildRArtifact("07.md", source);
      const quote = "kluczowe zdanie z linkiem tutaj";
      const position = positionOf(artifact, quote);
      const res = resolve(annotation({ quoteExact: quote, position, intent }), artifact, freshCtx);

      expect(res.kind).toBe("source_range");
      if (res.kind !== "source_range") throw new Error("unreachable");
      expect(res.confidence).toBe("block_range");
    });
  }
});
