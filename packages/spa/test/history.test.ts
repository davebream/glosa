// SPDX-License-Identifier: Apache-2.0
// P3.5 — history.js: the pure kind/attribution/timestamp label mappers (R1 — document-native
// language, never "commit"/"SHA"), the selection reducer, a diff2html render smoke test, and a
// DOM mount integration test against a fake data-access object (no real daemon).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  describeAttribution,
  describeCheckpointKind,
  formatTimestamp,
  mountHistoryPane,
  selectionReducer,
} from "../src/history.js";
import { Diff2Html as Diff2HtmlUntyped } from "../src/vendor/diff2html.js";
import { installDom, type DomEnv } from "./dom-env.ts";

// The vendored UMD wrapper's `module.exports` starts as a plain `{}` literal (see
// vendor/diff2html.js's own header) — TS's structural inference over a plain (unchecked, `allowJs`
// without `checkJs`) .js file sees only that initial shape, not what the minified bundle body
// reassigns into it at runtime. `Diff2Html.html(...)` genuinely exists (proved by the tests
// below); this is a type-only escape hatch, same spirit as the `as any` casts already used
// throughout viewer.test.ts for happy-dom's own nominally-distinct DOM types (see dom-env.ts).
const Diff2Html = Diff2HtmlUntyped as { html: (diff: string, config?: Record<string, unknown>) => string };

describe("describeCheckpointKind / describeAttribution — document-native labels (R1)", () => {
  test("every known Glosa-Kind trailer value maps to a human phrase, none of which leak the raw token", () => {
    const kinds = ["baseline", "human_edit", "restore", "pre_apply", "post_apply", "auto_checkpoint"];
    for (const kind of kinds) {
      const label = describeCheckpointKind(kind);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(kind); // never just echoes the raw trailer value
    }
  });

  test("an unrecognized kind falls back to a generic phrase, not the raw token", () => {
    expect(describeCheckpointKind("some_future_kind_this_ui_has_never_seen")).toBe("Saved version");
  });

  test("attribution: human -> 'You', unknown -> 'Unknown change', session:<id> -> a phrase that never echoes the raw id", () => {
    expect(describeAttribution("human")).toBe("You");
    expect(describeAttribution("unknown")).toBe("Unknown change");
    const sessionLabel = describeAttribution("session:2b7f19a3-abcd");
    expect(sessionLabel).not.toContain("2b7f19a3");
    expect(sessionLabel).not.toContain("session:");
  });
});

describe("formatTimestamp", () => {
  test("a valid ISO instant formats to a non-empty locale string", () => {
    expect(formatTimestamp("2026-07-20T10:00:00Z").length).toBeGreaterThan(0);
  });
});

describe("selectionReducer — pure compare-pair selection", () => {
  test("selecting up to two ids accumulates them", () => {
    let selected: string[] = [];
    selected = selectionReducer(selected, "a");
    selected = selectionReducer(selected, "b");
    expect(selected).toEqual(["a", "b"]);
  });

  test("a third selection drops the OLDEST pick (FIFO), keeping exactly two", () => {
    let selected = selectionReducer(selectionReducer([], "a"), "b");
    selected = selectionReducer(selected, "c");
    expect(selected).toEqual(["b", "c"]);
  });

  test("re-selecting an already-picked id deselects it", () => {
    const selected = selectionReducer(["a", "b"], "a");
    expect(selected).toEqual(["b"]);
  });
});

describe("Diff2Html render smoke (the vendored diff2html.js actually produces HTML in this runtime)", () => {
  test("Diff2Html.html() renders a unified diff into markup containing the changed lines", () => {
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "index e69de29..4b825dc 100644",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "",
    ].join("\n");
    const html = Diff2Html.html(diff, { drawFileList: false, outputFormat: "line-by-line" });
    expect(html).toContain("d2h-file-wrapper");
    expect(html).toContain("d2h-ins"); // the added line is marked as an insertion
    expect(html).toContain(">new<"); // word-level diff highlighting wraps the changed word itself
  });
});

describe("mountHistoryPane — DOM integration against a fake dataAccess (no real daemon)", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  // A real `git diff` hunk (what checkpoint-diff.ts's `buildDiffHunks` actually sends) carries its
  // own `diff --git`/`---`/`+++` file headers, not just the `@@` body — diff2html needs those to
  // know which file it's rendering. Realistic fixture, matching the wire shape.
  const SAMPLE_HUNK_DIFF = [
    "diff --git a/notes.md b/notes.md",
    "index e69de29..4b825dc 100644",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
    return {
      getCheckpoints: async () => [
        { checkpoint_id: "c2", at: "2026-07-20T11:00:00Z", by: "human", summary: "human_edit", bytes_changed: 12 },
        { checkpoint_id: "c1", at: "2026-07-20T10:00:00Z", by: "unknown", summary: "baseline", bytes_changed: 40 },
      ],
      getDiff: async () => ({ from: "c1", to: "c2", hunks: [{ path: "notes.md", diff: SAMPLE_HUNK_DIFF, attribution: "human" }] }),
      restore: async () => ({ path: "notes.md", restored_to: "c1", checkpoint_id: "c3", source_sha256: "sha" }),
      ...overrides,
    };
  }

  test("renders one row per checkpoint using document-native language — never 'commit' or a raw SHA-looking token in the visible text", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const dataAccess = fakeDataAccess();

    mountHistoryPane(root, { dataAccess, slug: "ws-1", path: "notes.md" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const rows = Array.from(root.querySelectorAll(".glosa-history-row"));
    expect(rows).toHaveLength(2);
    const visibleText = root.textContent ?? "";
    expect(visibleText.toLowerCase()).not.toContain("commit");
    expect(visibleText).not.toContain("c1"); // the raw checkpoint_id never appears in rendered prose
    expect(visibleText).not.toContain("c2");
    expect(visibleText).toContain("You"); // human attribution, document-native
    expect(visibleText).toContain("Unknown change");

    const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    expect(checkboxes.every((checkbox) => (checkbox.getAttribute("aria-label") ?? "").startsWith("Select "))).toBe(true);
    expect(root.querySelector(".glosa-history-status")?.getAttribute("role")).toBe("status");
    expect((root.querySelector(".glosa-history-compare-current") as any).disabled).toBe(true);
  });

  test("checking two rows fetches and renders their diff via diff2html", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const calls: Array<{ from: string; to: string }> = [];
    const dataAccess = fakeDataAccess({
      getDiff: async (_slug: string, args: { from: string; to: string }) => {
        calls.push(args);
        return { from: args.from, to: args.to, hunks: [{ path: "notes.md", diff: SAMPLE_HUNK_DIFF, attribution: "human" }] };
      },
    });

    mountHistoryPane(root, { dataAccess, slug: "ws-1", path: "notes.md" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]')) as any[];
    checkboxes[0]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect((root.querySelector(".glosa-history-compare-current") as any).disabled).toBe(false);
    checkboxes[1]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(calls).toEqual([{ from: "c2", to: "c1" }]); // only ONE compare fires — exactly when the pair completes
    const diffPane = root.querySelector(".glosa-diff-pane")!;
    expect(diffPane.innerHTML).toContain("d2h-file-wrapper");
  });

  test("restore button calls dataAccess.restore with the row's checkpoint_id and the open artifact's path", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const calls: Array<{ path: string; to: string; force?: boolean }> = [];
    const dataAccess = fakeDataAccess({
      restore: async (_slug: string, args: { path: string; to: string; force?: boolean }) => {
        calls.push(args);
        return { path: args.path, restored_to: args.to, checkpoint_id: "c3", source_sha256: "sha" };
      },
    });

    mountHistoryPane(root, { dataAccess, slug: "ws-1", path: "notes.md" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const buttons = Array.from(root.querySelectorAll(".glosa-history-row button")) as any[];
    buttons[0]!.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(calls).toEqual([{ path: "notes.md", to: "c2", force: false }]);
  });
});
