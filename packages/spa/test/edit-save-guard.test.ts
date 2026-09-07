// SPDX-License-Identifier: Apache-2.0
// Edit mode's save gate. The rich face writes back only the blocks the writer changed, but some
// blocks cannot be written back exactly — CommonMark has no node for a callout marker or a soft
// line break. This is the wiring that makes sure those changes are consented to rather than
// discovered afterwards in a diff.
//
// Each test names the way this could be quietly wrong:
//
//   * A save that writes collateral without asking is the whole defect (#143) reappearing one
//     layer up: the bytes reach the agent as a `human_edit` and the writer's real change becomes
//     impossible to pick out.
//   * "Edit as source" must KEEP the edit. An escape hatch that discards the writer's work is not
//     an escape hatch.
//   * The gate leaks if it only guards the Save button. Rich → Source hands the same spliced text
//     to the textarea, and a save from there takes a different code path.
//   * The approval flow saves first and then approves "the revision that produced". A declined
//     save that reads as a completed one would approve the bytes still sitting unsaved on screen.
//
// ProseMirror cannot mount in happy-dom, so the rich editor is a stub here; what the real one
// returns is proven in rich-editor.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom, installModalDialogs } from "./dom-env.ts";

describe("Edit mode — a save never invents an edit", () => {
  let dom: DomEnv;
  let restoreDialogs: () => void;

  beforeEach(() => {
    dom = installDom();
    restoreDialogs = installModalDialogs(dom);
  });

  afterEach(() => {
    restoreDialogs();
    dom.teardown();
  });

  const flush = async (n = 10) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const paint = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  };

  const SOURCE = "> [!info] A callout\n> with a second line.\n\nAfter.\n";

  /**
   * What the real rich editor would return, without needing a ProseMirror view.
   *
   * The mount argument matters: the real splice is relative to whatever string the editor was
   * opened over, so an editor re-mounted over ALREADY-spliced text is clean and has nothing to
   * report. A stub that reported collateral no matter what it was mounted over would make the
   * park-and-return test pass without testing anything.
   *
   * `dirty` defaults to `true` so the 9 pre-existing cases — none of which set it — are
   * unaffected. AC-2 (a clean pane still tracking the file) is the reason this needs to be
   * settable at all: `renderContent` always mounts the rich face in Edit, so without a way to
   * force `isDirty()` false the pane cannot obtain a clean pane to assert against.
   *
   * `rebase.report` is a separate, independently settable box for `rebaseOnto`'s return value
   * (AC-17 needs `degraded: "block-mismatch"` back from a call the splice itself never produces),
   * so a test sets it after constructing the stub and before mounting.
   */
  function stubRichEditor(
    save: { markdown: string; collateral?: unknown[]; degraded?: string | false },
    { dirty = true }: { dirty?: boolean } = {},
  ) {
    const target = { collateral: [] as unknown[], degraded: false as string | false, ...save };
    const calls = { destroyed: 0 };
    const rebase: { report: { markdown: string; collateral: unknown[]; degraded: string | false } | null } = {
      report: null,
    };
    const mount = (_container: unknown, { markdown }: { markdown: string }) => {
      const report =
        markdown === target.markdown ? { markdown, collateral: [], degraded: false as string | false } : target;
      return {
        getSave: () => report,
        getMarkdown: () => report.markdown,
        isDirty: () => dirty,
        rebaseOnto: (_newSource: string) => rebase.report ?? report,
        focus: () => {},
        destroy: () => {
          calls.destroyed += 1;
        },
      };
    };
    return { loadRichEditor: async () => mount, calls, rebase };
  }

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
    return {
      // Mutable so a test can move the file "on disk" between calls — `getArtifact` and
      // `refreshArtifact` both read through this record rather than a fixed literal.
      disk: {
        content: SOURCE,
        rendered_html: "<p>After.</p>",
        source_sha256: "sha-1",
      },
      // Settable per test; default `{hunks: []}` so no existing case sees a hunk it didn't ask for.
      diff: { hunks: [] as unknown[] },
      // Settable per test; default `[]` matches today's unconditional empty return.
      checkpoints: [] as unknown[],
      // A per-call rejection queue: shift one off to make the next `putArtifact` reject instead of
      // resolving, carrying the `{status, problem}` shape `DataAccessError` throws for real.
      putRejections: [] as Array<{
        status: number;
        problem?: { type?: string; title?: string; [key: string]: unknown };
      }>,
      put: [] as { path: string; content: string; ifMatch?: string }[],
      subscribe: () => () => {},
      async getArtifact() {
        return {
          source_path: "notes.md",
          content: this.disk.content,
          rendered_html: this.disk.rendered_html,
          source_sha256: this.disk.source_sha256,
          class: "R",
        };
      },
      async getAnnotations() {
        return { annotations: [] };
      },
      async getCheckpoints() {
        return this.checkpoints;
      },
      async getDiff() {
        return this.diff;
      },
      async putArtifact(_slug: string, path: string, content: string, opts: { ifMatch?: string } = {}) {
        const rejection = this.putRejections.shift();
        if (rejection) {
          const error = Object.assign(
            new Error(rejection.problem?.title ?? `request failed with status ${rejection.status}`),
            { status: rejection.status, problem: rejection.problem ?? null },
          );
          throw error;
        }
        this.put.push({ path, content, ifMatch: opts.ifMatch });
        return { source_sha256: "sha-2" };
      },
      async respondToAttention(_slug: string, id: string, body: Record<string, unknown>) {
        return { id, ...body };
      },
      ...overrides,
    };
  }

  async function mountEditPane(extra: Record<string, unknown> = {}, daOverrides: Record<string, unknown> = {}) {
    const da = fakeDataAccess(daOverrides);
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "edit",
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
      ...extra,
    });
    await pane.ready;
    await paint();
    return { host, pane, da };
  }

  const modal = () => dom.document.querySelector("dialog");
  const modalButton = (label: string) =>
    [...(modal()?.querySelectorAll("button") ?? [])].find((b: any) => b.textContent === label) as any;
  const saveButton = (host: any) => host.querySelector(".glosa-save") as any;

  const LOSSY = {
    markdown: "> \\[!info\\] A CALLOUT with a second line.\n\nAfter.\n",
    collateral: [
      {
        original: "> [!info] A callout\n> with a second line.",
        faithful: "> \\[!info\\] A callout with a second line.",
        written: "> \\[!info\\] A CALLOUT with a second line.",
      },
    ],
  };

  test("a save that would reformat what the writer did not touch asks first, and writes nothing on Cancel", async () => {
    const { host, da } = await mountEditPane(stubRichEditor(LOSSY));
    saveButton(host).click();
    await paint();

    expect(modal()).toBeTruthy();
    expect(modal()?.querySelector("h2")?.textContent).toBe("This save would change words you didn't type");
    // The reader is shown the exact bytes, not a description of them.
    expect(modal()?.querySelector(".glosa-dialog-detail")?.textContent).toContain("> [!info] A callout");
    expect(modal()?.querySelector(".glosa-dialog-detail")?.textContent).toContain("\\[!info\\]");
    expect(da.put).toEqual([]);

    modalButton("Cancel").click();
    await paint();
    expect(da.put).toEqual([]);
  });

  test("Save anyway writes the spliced text, once, against the revision it was captured from", async () => {
    const { host, da } = await mountEditPane(stubRichEditor(LOSSY));
    saveButton(host).click();
    await paint();
    modalButton("Save anyway").click();
    await paint();

    expect(da.put).toEqual([{ path: "notes.md", content: LOSSY.markdown, ifMatch: "sha-1" }]);
  });

  test("Edit as source keeps the edit and hands it to the byte-exact face without writing", async () => {
    const { host, da } = await mountEditPane(stubRichEditor(LOSSY));
    saveButton(host).click();
    await paint();
    modalButton("Edit as source").click();
    await paint();

    expect(da.put).toEqual([]);
    const textarea = host.querySelector(".glosa-edit-area") as any;
    expect(textarea.hidden).toBe(false);
    expect(textarea.value).toBe(LOSSY.markdown); // the writer's edit, not the file on disk
    expect(host.querySelector("[data-editor-face]")?.getAttribute?.("data-editor-face") ?? "").not.toBe("rich");
  });

  test("a save with nothing to consent to just saves", async () => {
    const clean = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(clean));
    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toEqual([{ path: "notes.md", content: clean.markdown, ifMatch: "sha-1" }]);
  });

  test("a degraded splice — a whole-file rewrite — is gated the same way", async () => {
    const { host, da } = await mountEditPane(stubRichEditor({ markdown: "REWRITTEN\n", degraded: "reparse" }));
    saveButton(host).click();
    await paint();

    expect(modal()?.querySelector("p")?.textContent).toContain("rewrites the whole thing");
    modalButton("Cancel").click();
    await paint();
    expect(da.put).toEqual([]);
  });

  test("the gate does not leak through the source face: text carried from Rich is still gated", async () => {
    // The natural "let me look at the source first" path. Saving from the textarea takes a
    // different branch, and an ungated one would put the same unconsented bytes on disk.
    const { host, da } = await mountEditPane(stubRichEditor(LOSSY));
    (host.querySelector(".glosa-face-source") as any).click();
    await paint();
    expect((host.querySelector(".glosa-edit-area") as any).value).toBe(LOSSY.markdown);

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();
    modalButton("Cancel").click();
    await paint();
    expect(da.put).toEqual([]);
  });

  test("a declined save does not approve the bytes still sitting unsaved on screen", async () => {
    // The approval flow tells the reader "your pending edits will be saved first" and then
    // approves the revision that save produced. If a declined save read as a completed one, the
    // verdict would land on the file as it is on DISK — a different document from the one they
    // just looked at and approved.
    const request = {
      id: "inb-1",
      created_at: "2026-09-05T10:00:00Z",
      status: "open",
      action: "review",
      target_path: "notes.md",
      message: "Ready to sign off?",
      agent_label: "api-refactor",
      passage: null,
      answer_options: null,
      approval_mode: true,
    };
    const answered: unknown[] = [];
    const { host, da } = await mountEditPane({
      ...stubRichEditor(LOSSY),
      getAttentionEntries: () => [request],
      respondToAttention: undefined,
    });
    (da as any).respondToAttention = async (_slug: string, id: string, body: Record<string, unknown>) => {
      answered.push({ id, ...body });
      return { id, ...body };
    };

    const strip = host.querySelector(".glosa-approval-strip") as any;
    expect(strip).toBeTruthy();
    (strip.querySelector(".glosa-approval-button") as any).click();
    await paint();
    // First modal: "Approve this revision?" — the reader says yes.
    modalButton("Approve revision").click();
    await paint();
    // Second modal: the collateral gate on the save that approval triggers. The reader says no.
    expect(modal()?.querySelector("h2")?.textContent).toBe("This save would change words you didn't type");
    modalButton("Cancel").click();
    await paint();

    expect(da.put).toEqual([]);
    expect(answered).toEqual([]);
    expect(host.querySelector(".glosa-approval-status")?.textContent).toContain("Nothing was approved");
  });

  test("parking a draft across a mode switch does not launder the collateral away", async () => {
    // Leaving Edit parks the spliced text, and coming back re-mounts the rich face OVER it — so
    // that text becomes the baseline and the editor is clean with nothing to report. Without the
    // report surviving the round trip, the bytes nobody agreed to would save silently.
    const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
    pane.setMode("read");
    await paint();
    pane.setMode("edit");
    await paint();

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();
    modalButton("Cancel").click();
    await paint();
    expect(da.put).toEqual([]);
  });

  test("once the writer edits the carried text the bytes are theirs and nothing is asked", async () => {
    const { host, da } = await mountEditPane(stubRichEditor(LOSSY));
    (host.querySelector(".glosa-face-source") as any).click();
    await paint();

    const textarea = host.querySelector(".glosa-edit-area") as any;
    textarea.value = "> [!info] A callout\n> with a second line.\n\nAfter, fixed by hand.\n";
    textarea.dispatchEvent(new dom.window.Event("input"));
    await paint();

    saveButton(host).click();
    await paint();
    expect(modal()).toBeNull();
    expect(da.put).toHaveLength(1);
    expect(da.put[0]?.content).toContain("fixed by hand");
  });

  test("AC-29: the harness can produce a clean pane, and a dirty one", async () => {
    const clean = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
    expect(clean.pane.isDirty()).toBe(false);

    const dirty = await mountEditPane(stubRichEditor(LOSSY, { dirty: true }));
    expect(dirty.pane.isDirty()).toBe(true);
  });
});
