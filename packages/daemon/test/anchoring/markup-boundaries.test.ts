// The named "markdown markup" hard case (A5 §F10): a rendered selection spanning **bold**/
// [link](url)/`code` boundaries. Its literal (rendered, markup-stripped) text never substring-
// matches the source, which still has the `**`/`[...]`/`` ` `` syntax interspersed — so it falls
// to `block_range` guidance (a real, identifiable block scope), never a wrong exact match and
// never orphaned when the block itself IS identifiable via `position`.
import { describe, expect, test } from "bun:test";
import { resolve } from "../../src/anchoring.ts";
import { annotation, buildRArtifact, positionOf } from "./helpers.ts";

const SOURCE = `# Kazanie

To jest **kluczowe** zdanie z linkiem [tutaj](http://example.com) i \`kodem\` w środku.
`;

describe("a rendered selection crossing inline markup boundaries", () => {
  test("selection spanning bold+link+code text → block_range guidance, not a false exact/normalized match", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    // The rendered (markup-stripped) text reads "...zdanie z linkiem tutaj i kodem w środku." —
    // that exact run of words never appears in the raw source, which still has ** [ ]( ) ` around it.
    const renderedQuote = "kluczowe zdanie z linkiem tutaj i kodem";
    const position = positionOf(artifact, renderedQuote);

    const res = resolve(annotation({ quoteExact: renderedQuote, position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("block_range");
    expect(res.start_line).toBe(2);
    // No subsequent stamped block exists, so the block's range extends to the document's last
    // source line (index 3 — the trailing blank line from SOURCE's final `\n`), not just its own line.
    expect(res.end_line).toBe(3);
  });

  test("the same crossing selection with NO trustworthy position (no block identifiable) → orphaned, not a guess", () => {
    const { artifact, freshCtx } = buildRArtifact("07.md", SOURCE);
    const renderedQuote = "kluczowe zdanie z linkiem tutaj i kodem";
    // No position at all → whole-doc scope from the start → no "stamped block" to fall back on.
    const res = resolve(annotation({ quoteExact: renderedQuote }), artifact, freshCtx);

    expect(res.kind).toBe("orphaned");
    if (res.kind !== "orphaned") throw new Error("unreachable");
    expect(res.reason).toBe("hash_mismatch_no_match");
  });

  test("a middle block's block_range is bounded by the NEXT stamped block, not the whole document", () => {
    const source = `# Kazanie\n\nTo jest **kluczowe** zdanie z linkiem [tutaj](http://example.com) i \`kodem\`.\n\n## Następna sekcja\n\nDalszy tekst.\n`;
    const { artifact, freshCtx } = buildRArtifact("07.md", source);
    const renderedQuote = "kluczowe zdanie z linkiem tutaj i kodem";
    const position = positionOf(artifact, renderedQuote);

    const res = resolve(annotation({ quoteExact: renderedQuote, position }), artifact, freshCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("block_range");
    expect(res.start_line).toBe(2);
    expect(res.end_line).toBe(3); // stops right before the "## Następna sekcja" heading's own line (4)
  });

  test("a selection spanning TWO SIBLING blocks is bounded by the block AFTER the second sibling, not end-of-document", () => {
    // start block (line 2) has markup so the literal text never substring-matches → block_range;
    // end block (line 4) is the sibling right after it; a THIRD sibling (line 6) and a fourth
    // (line 8) exist afterward — the guidance must stop before the third, not run to the fourth.
    const source = "# T\n\nAAAA **bbbb** cccc.\n\nDDDD eeee.\n\nFFFF gggg.\n\nHHHH iiii.\n";
    const { artifact, freshCtx } = buildRArtifact("07.md", source);
    const renderedQuote = "bbbb cccc.\nDDDD eeee"; // crosses from inside the bold into the next paragraph
    const position = positionOf(artifact, renderedQuote);

    const res = resolve(annotation({ quoteExact: renderedQuote, position }), artifact, freshCtx);
    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("block_range");
    expect(res.start_line).toBe(2);
    expect(res.end_line).toBe(5); // stops right before "FFFF gggg." (line 6), not "HHHH iiii." (line 8)
  });

  test("markers tied at the same offset (a <ul> and its first <li> both start at zero text emitted) don't confuse block scoping", () => {
    // markdown-it stamps BOTH <ul data-line="2"> and its first <li data-line="2"> — the wrapper
    // contributes no text of its own before the <li> opens, so both markers land at the identical
    // text offset. `markerAt` must resolve this tie deterministically (last-in-document-order,
    // i.e. the more specific <li>) rather than picking whichever happens to be scanned first.
    const source = "# T\n\n- one\n- two\n- three\n\nNext para.\n";
    const { artifact, freshCtx } = buildRArtifact("07.md", source);
    const position = positionOf(artifact, "one");
    const res = resolve(annotation({ quoteExact: "one", position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.confidence).toBe("exact");
    expect(res.start_line).toBe(2);
    expect(res.end_line).toBe(2);
  });

  test("a selection inside the SECOND list item (past the tie) still scopes to its own line, not the tied first item's", () => {
    const source = "# T\n\n- one\n- two\n- three\n\nNext para.\n";
    const { artifact, freshCtx } = buildRArtifact("07.md", source);
    const position = positionOf(artifact, "two");
    const res = resolve(annotation({ quoteExact: "two", position }), artifact, freshCtx);

    expect(res.kind).toBe("source_range");
    if (res.kind !== "source_range") throw new Error("unreachable");
    expect(res.start_line).toBe(3);
    expect(res.end_line).toBe(3);
  });
});
