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
    const calls = { destroyed: 0, mountedWith: [] as string[] };
    const rebase: { report: { markdown: string; collateral: unknown[]; degraded: string | false } | null } = {
      report: null,
    };
    const mount = (_container: unknown, { markdown }: { markdown: string }) => {
      calls.mountedWith.push(markdown); // what text this face was actually filled from
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

  test("AC-1: a dirty editor's save carries the baseline sha, not the sha an SSE refresh brought in", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, pane, da } = await mountEditPane(stubRichEditor(edited));

    da.disk.source_sha256 = "sha-2"; // another writer's frame arrives while the editor is dirty
    await pane.refreshArtifact();

    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull(); // nothing to consent to
    expect(da.put).toEqual([{ path: "notes.md", content: edited.markdown, ifMatch: "sha-1" }]);
  });

  test("AC-2: a clean pane still tracks the file — an SSE refresh advances the displayed artifact", async () => {
    const { pane, da } = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
    expect(pane.isDirty()).toBe(false);

    da.disk.content = "> [!info] A callout\n> with a second line.\n\nSomeone else's change.\n";
    da.disk.rendered_html = "<p>Someone else's change.</p>";
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();

    expect(pane.artifact?.source_sha256).toBe("sha-2");
    expect(pane.artifact?.content).toContain("Someone else's change.");
  });

  test("AC-3: a draft parked through a mode switch keeps its baseline", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, pane, da } = await mountEditPane(stubRichEditor(edited));
    pane.setMode("read");
    await paint();

    da.disk.source_sha256 = "sha-2"; // arrives while the draft is parked, not mounted
    await pane.refreshArtifact();

    pane.setMode("edit");
    await paint();

    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toEqual([{ path: "notes.md", content: edited.markdown, ifMatch: "sha-1" }]);
  });

  test("AC-4: a clean pane in Edit that takes a disk change and is then typed into saves against the sha the editor was mounted over, not the frame's", async () => {
    const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
    expect(pane.isDirty()).toBe(false);

    // The frame arrives while the pane is still clean — the DSR-1 sequence.
    da.disk.content = "> [!info] A callout\n> with a second line.\n\nSomeone else's change.\n";
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();

    // Only now does the writer type — the source face is the harness's only way to dirty a pane
    // without a real ProseMirror view.
    (host.querySelector(".glosa-face-source") as any).click();
    await paint();
    const textarea = host.querySelector(".glosa-edit-area") as any;
    const myEdit = "> [!info] A callout\n> with a second line.\n\nMy own edit.\n";
    textarea.value = myEdit;
    textarea.dispatchEvent(new dom.window.Event("input"));
    await paint();

    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toEqual([{ path: "notes.md", content: myEdit, ifMatch: "sha-1" }]);
  });

  test("AC-18: a same-path refresh under an open modal no longer declines the save; a swapped-path one still does", async () => {
    // Same-path direction: refreshArtifact assigns a brand NEW object for the same file while the
    // collateral modal is up. Object identity would decline this save; the file at this path
    // didn't actually change out from under it.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
      saveButton(host).click();
      await paint();
      expect(modal()).toBeTruthy();

      await pane.refreshArtifact(); // a same-path SSE frame while the writer is still deciding

      modalButton("Save anyway").click();
      await paint();

      expect(da.put).toHaveLength(1); // proceeds — nothing about THIS path actually changed
    }

    // Swapped-path direction: the pane's artifact is swapped to a DIFFERENT file while the modal
    // is up (an agent-driven reveal). The save must still decline — writing here would land on
    // the wrong file.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
      saveButton(host).click();
      await paint();
      expect(modal()).toBeTruthy();

      da.getArtifact = async () => ({
        source_path: "other.md",
        content: "Somewhere else entirely.\n",
        rendered_html: "<p>Somewhere else entirely.</p>",
        source_sha256: "sha-other",
        class: "R",
      });
      await pane.refreshArtifact();

      modalButton("Save anyway").click();
      await paint();

      expect(da.put).toEqual([]); // declined — this would write to the wrong artifact
    }
  });

  test("writeAndSettle clears the parked draft — the remount after a successful save uses the fresh bytes, not the stale park", async () => {
    // Plan Task 4's own positive control names a test that clicks Cancel and so never reaches
    // writeAndSettle at all — deleting clearParkedSource() from writeAndSettle left the whole
    // suite green. This is the control the plan intended: it actually drives a save through a
    // parked draft and inspects what the rich face remounts over afterward.
    const parkedEdit = "> [!info] A callout\n> with a second line.\n\nParked, then saved.\n";
    const stub = stubRichEditor({ markdown: parkedEdit });
    const { host, pane, da } = await mountEditPane(stub);

    // Park the dirty draft by leaving Edit and returning — the rich face remounts OVER the
    // parked text, which becomes what the save below writes.
    pane.setMode("read");
    await paint();
    pane.setMode("edit");
    await paint();

    stub.calls.mountedWith.length = 0; // isolate what the SAVE's own remount receives below
    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull(); // plain text, nothing to consent to
    expect(da.put).toEqual([{ path: "notes.md", content: parkedEdit, ifMatch: "sha-1" }]);
    // writeAndSettle tears down and remounts the rich face after a successful save (:2491-2492
    // area). If clearParkedSource() were skipped, parkedSourceFor would still match this path and
    // the remount would carry the STALE parked text forward instead of the freshly re-read bytes.
    expect(stub.calls.mountedWith.at(-1)).toBe(SOURCE);
  });

  test("AC-5: the disk-change banner appears in Edit and takes no focus", async () => {
    const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
    const activeBefore = dom.document.activeElement;

    da.disk.source_sha256 = "sha-2"; // another writer's frame arrives while the editor is open
    await pane.refreshArtifact();

    const banner = host.querySelector(".glosa-disk-change") as any;
    expect(banner?.hidden).toBe(false);
    expect(dom.document.activeElement).toBe(activeBefore);
    // A guard against an explicit scrollTop write on the banner path, not proof of layout
    // stability — happy-dom performs no layout, so this passes under a correct AND a broken
    // implementation alike. The real property is the CSS argument in app.css (D7/§2).
    expect((host.querySelector(".glosa-pane-main") as any)?.scrollTop ?? 0).toBe(0);
  });

  test("AC-6: with no checkpoint since the cursor the banner names nobody and says so", async () => {
    // The default fake never checkpoints anything, so the pin `beginEditSession` takes never gets
    // a real cursor — this is the ordinary "nothing has been checkpointed yet" case, not an error.
    const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
    await paint(); // let the initial pin's getCheckpoints resolve

    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();
    await paint(); // let resolveDiskAttribution's calls resolve (it bails immediately here)

    const copy = (host.querySelector(".glosa-disk-change-copy") as any)?.textContent ?? "";
    expect(copy).toContain("seen at");
    expect(copy).not.toContain("session");
    expect(copy).not.toContain("human");
  });

  test("AC-7: a named attribution requires a path-matched hunk", async () => {
    async function scenario(hunkPath: string) {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY), {
        checkpoints: [{ checkpoint_id: "cp-1", at: "2026-09-06T10:00:00Z" }],
      });
      await paint(); // let the initial pin land on cp-1, giving resolveDiskAttribution a cursor
      da.diff = { hunks: [{ path: hunkPath, diff: "", attribution: "session:abc123def456xyz" }] };
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      await paint();
      return (host.querySelector(".glosa-disk-change-copy") as any)?.textContent ?? "";
    }

    // A hunk exists in the range, but for a DIFFERENT path — a workspace checkpoint proves
    // nothing about this one, so it must stay exactly as unattributed as no hunk at all.
    const unmatched = await scenario("other.md");
    expect(unmatched).toContain("seen at");
    expect(unmatched).not.toContain("session");

    // The same fixtures, path-matched this time — only now is the session named.
    const matched = await scenario("notes.md");
    expect(matched).toContain("session");
    expect(matched).toContain("abc123def456");
  });

  test("a checkpointed human edit is named as one, never invented for anything else", async () => {
    // AGENTS.md invariant 3: edits made in glosa are `human` by construction; nothing else may
    // ever render as `human`, including the unattributed default (checked above by AC-6/AC-7).
    const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY), {
      checkpoints: [{ checkpoint_id: "cp-1", at: "2026-09-06T10:00:00Z" }],
    });
    await paint();
    da.diff = { hunks: [{ path: "notes.md", diff: "", attribution: "human" }] };
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();
    await paint();

    const copy = (host.querySelector(".glosa-disk-change-copy") as any)?.textContent ?? "";
    // The design's copy never prints the literal word "human" to the reader — it says "an edit in
    // glosa", the honest translation of that attribution value into prose a writer would say.
    expect(copy).toContain("an edit in glosa");
    expect(copy).not.toContain("session");
  });

  test("AC-15: the banner's own actions — Keep editing dismisses it, Reload raises the discard guard", async () => {
    // Keep editing, plus the re-show positive control.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      const banner = host.querySelector(".glosa-disk-change") as any;
      expect(banner?.hidden).toBe(false);

      (host.querySelector(".glosa-disk-change-keep") as any).click();
      expect(banner?.hidden).toBe(true);

      // A repeated frame carrying the SAME sha must stay hidden — if `acknowledged` isn't being
      // read, this would show the banner again.
      await pane.refreshArtifact();
      expect(banner?.hidden).toBe(true);

      // A genuinely NEW disk change re-shows it.
      da.disk.source_sha256 = "sha-3";
      await pane.refreshArtifact();
      expect(banner?.hidden).toBe(false);
    }

    // Reload, clean: nothing is parked, so the guard self-skips — a single click.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();

      (host.querySelector(".glosa-disk-change-reload") as any).click();
      await paint();
      expect(modal()).toBeNull();
      expect(da.put).toEqual([]);
    }

    // Reload, dirty: the guard is asked, and declining leaves everything untouched.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(LOSSY));
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();

      (host.querySelector(".glosa-disk-change-reload") as any).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("Discard unsaved edits?");

      modalButton("Cancel").click();
      await paint();
      expect(da.put).toEqual([]);
    }
  });

  test("AC-8: a source-changed 409 opens a dialog offering Take disk, Compare and Keep mine beside Cancel", async () => {
    const clean = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(clean));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();

    expect(modal()).toBeTruthy();
    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");
    expect(modalButton("Take disk")).toBeTruthy();
    expect(modalButton("Compare")).toBeTruthy();
    expect(modalButton("Keep mine")).toBeTruthy();
    expect(modalButton("Cancel")).toBeTruthy();
  });

  test("AC-9: a workspace-adopting 409 opens no dialog and renders the ordinary save error", async () => {
    // D5's regression test — the discriminator is problem.type, not a bare 409 status. Two
    // distinct 409s reach this route, and matching on status alone would open the stale-save
    // dialog during an ordinary workspace adoption.
    const clean = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(clean));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/workspace-adopting" } });

    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect((host.querySelector(".glosa-edit-status") as any)?.textContent).toContain("Couldn't save this artifact");
    expect(da.put).toEqual([]);
  });

  test("AC-14: Cancel leaves the editor untouched and the file unwritten, and the save declines", async () => {
    const clean = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(clean));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();

    modalButton("Cancel").click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toEqual([]);
  });

  test("AC-29: the harness can produce a clean pane, and a dirty one", async () => {
    const clean = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
    expect(clean.pane.isDirty()).toBe(false);

    const dirty = await mountEditPane(stubRichEditor(LOSSY, { dirty: true }));
    expect(dirty.pane.isDirty()).toBe(true);
  });
});
