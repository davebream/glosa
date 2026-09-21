// SPDX-License-Identifier: Apache-2.0
// #251 — the concurrency identity (A5 §F10) pinned as a formula, on its own, before any route
// reads it. Two properties, and the decision in docs/decisions.md ("Line endings are normalized
// for identity, never for content") rests on both: `\r\n` and `\n` spellings of one text are the
// same source, and the normalization goes no further than that — a lone `\r` is left alone and any
// real content change still differs. Six consumers share this hash (A4 §F05), so a change to the
// formula is a change to all of them at once, which is why it is pinned here rather than only
// through whichever route happened to exercise it.
import { describe, expect, test } from "bun:test";
import { sourceSha256 } from "../src/artifact-render.ts";

const sha = (text: string) => sourceSha256(Buffer.from(text, "utf8"));

describe("#251 source_sha256 — line endings are normalized for identity", () => {
  test("LF, CRLF and mixed spellings of one text are the same source", () => {
    const lf = "# T\n\nAlpha one\nbeta two.\n\nGamma.\n";
    const crlf = "# T\r\n\r\nAlpha one\r\nbeta two.\r\n\r\nGamma.\r\n";
    const mixed = "# T\r\n\r\nAlpha one\nbeta two.\r\n\r\nGamma.\n";
    expect(sha(crlf)).toBe(sha(lf));
    expect(sha(mixed)).toBe(sha(lf));
  });

  test("a lone \\r is NOT normalized — the formula is `\\r\\n` only", () => {
    // The old-Mac spelling is a different document, not a different spelling of this one. Pinned
    // because the cheap way to write the normalization (`/\r\n?/g`, or a `\r`-then-`\n` pass)
    // silently folds it in, and `createSplicer` refuses to scan a source containing a lone `\r`
    // at all — the two ends of the system stay consistent about calling it foreign.
    expect(sha("Alpha.\rBeta.\n")).not.toBe(sha("Alpha.\nBeta.\n"));
  });

  test("a content change is still a different source", () => {
    expect(sha("Alpha.\r\n")).not.toBe(sha("AlphaX.\r\n"));
    // Whitespace is content too: identity folds `\r\n`, never a trailing blank line.
    expect(sha("Alpha.\r\n\r\n")).not.toBe(sha("Alpha.\r\n"));
  });
});
