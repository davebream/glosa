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
import { createHash } from "node:crypto";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom, installModalDialogs } from "./dom-env.ts";

/** A5 §F10's own formula (also `artifact-pane.js`'s own `sha256Hex`, computed with Web Crypto in
 * the browser) — used here to build a fixture whose `source_sha256` the pane's own `verifiedBaseline`
 * check actually accepts, rather than the placeholder "sha-1"/"sha-2" strings the other cases use
 * for artifacts the merge never needs to trust as a base. */
function realSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

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
    // Drains rather than flushing a fixed number of times. The pane fetches the merge module on
    // demand (it carries the ProseMirror bundle, so it must not be imported eagerly), which adds a
    // real module-resolution hop to the paths that reach it. Two flushes happened to cover that on
    // a warm local machine and did not on a loaded CI runner, where the conflict dialog had not
    // been built yet when the assertion ran. Draining costs nothing when there is nothing pending.
    for (let i = 0; i < 12; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
   * No `rebaseOnto` here (#182): Keep mine no longer calls it — it goes through the same
   * `getSave()`/merge path as an ordinary save (see `keepMineMerge` in artifact-pane.js), so this
   * stub's `getSave()` is what every test, including a degrading one (AC-17), drives through.
   */
  function stubRichEditor(
    save: { markdown: string; collateral?: unknown[]; degraded?: string | false },
    { dirty = true }: { dirty?: boolean } = {},
  ) {
    const target = { collateral: [] as unknown[], degraded: false as string | false, ...save };
    const calls = { destroyed: 0, mountedWith: [] as string[] };
    const mount = (_container: unknown, { markdown }: { markdown: string }) => {
      calls.mountedWith.push(markdown); // what text this face was actually filled from
      const report =
        markdown === target.markdown ? { markdown, collateral: [], degraded: false as string | false } : target;
      return {
        getSave: () => report,
        getMarkdown: () => report.markdown,
        isDirty: () => dirty,
        focus: () => {},
        destroy: () => {
          calls.destroyed += 1;
        },
      };
    };
    return { loadRichEditor: async () => mount, calls };
  }

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
    return {
      // Mutable so a test can move the file "on disk" between calls — `getArtifact` and
      // `refreshArtifact` both read through this record rather than a fixed literal.
      disk: {
        content: SOURCE,
        rendered_html: "<p>After.</p>",
        source_sha256: "sha-1",
        // #250. Left `undefined` by default — the key is then absent from the response entirely,
        // which is both an N-1 daemon's shape and what every pre-existing case in this suite
        // was written against.
        valid_utf8: undefined as boolean | undefined,
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
          ...(this.disk.valid_utf8 === undefined ? {} : { valid_utf8: this.disk.valid_utf8 }),
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
    // This suite is about the FULL-PAGE editor and its save, which since the two-mode control is a
    // tool reached from More rather than the face Edit opens on. Opened through the real menu item
    // rather than a test-only hook, so the path these tests exercise is the one a writer takes.
    (host.querySelector(".glosa-tools-edit-source") as any)?.click();
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

  test("#182 criterion 2: the base survives a park-and-remount — the writer's edit AND disk's change both land in a Keep-mine write", async () => {
    const base = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, pane, da } = await mountEditPane(stubRichEditor(edited), {
      disk: { content: base, rendered_html: "<p>After.</p>", source_sha256: realSha256(base) },
    });

    // Dirty switch away and back — parks the draft and remounts over it (`parkDrafts` →
    // `renderContent`), which `beginEditSession` deliberately does NOT treat as a new baseline.
    pane.setMode("read");
    await paint();

    // Disk changes a DIFFERENT block (the callout) while the draft is parked.
    const onDisk = "> [!info] A callout\n> with a second line, changed on disk.\n\nAfter.\n";
    da.disk.content = onDisk;
    da.disk.source_sha256 = "sha-3";
    await pane.refreshArtifact();

    pane.setMode("edit");
    await paint();

    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
    saveButton(host).click();
    await paint();
    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

    modalButton("Keep mine").click();
    await paint();

    expect(da.put).toEqual([
      {
        path: "notes.md",
        content: "> [!info] A callout\n> with a second line, changed on disk.\n\nAfter, edited.\n",
        ifMatch: "sha-3",
      },
    ]);
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

    // Reload, clean: nothing is parked, so the guard self-skips — a single click. Re-asserted
    // against the REAL takeDisk (Task 12 replaced Task 8's stub) — writes nothing and actually
    // remounts the editor over the disk bytes, not just that no error occurred.
    {
      const changed = "> [!info] A callout\n> with a second line.\n\nSomeone else's change.\n";
      const stub = stubRichEditor(LOSSY, { dirty: false });
      const { host, pane, da } = await mountEditPane(stub);
      da.disk.content = changed;
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();

      stub.calls.mountedWith.length = 0; // isolate what THIS reload's remount receives
      (host.querySelector(".glosa-disk-change-reload") as any).click();
      await paint();

      expect(modal()).toBeNull();
      expect(da.put).toEqual([]);
      expect(pane.artifact?.source_sha256).toBe("sha-2"); // currentArtifact now reflects disk
      expect(stub.calls.mountedWith.at(-1)).toBe(changed); // remounted over the disk bytes
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

    // Reload, dirty, confirming: discards the draft, writes nothing, and remounts over disk —
    // the clause Task 8's stub could not make true.
    {
      const changed = "> [!info] A callout\n> with a second line.\n\nSomeone else's change.\n";
      const stub = stubRichEditor(LOSSY);
      const { host, pane, da } = await mountEditPane(stub);
      da.disk.content = changed;
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();

      stub.calls.mountedWith.length = 0;
      (host.querySelector(".glosa-disk-change-reload") as any).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("Discard unsaved edits?");

      modalButton("Discard edits").click();
      await paint();

      expect(modal()).toBeNull();
      expect(da.put).toEqual([]);
      expect(pane.artifact?.source_sha256).toBe("sha-2");
      expect(stub.calls.mountedWith.at(-1)).toBe(changed);
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

  test("AC-16 (#182 D9): the dialog previews the merge itself — kept disk changes, conflicts, or a base-unavailable notice — needing no checkpoint pin", async () => {
    const base = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };

    // A verified base (real sha) plus a genuine disk-only change: the preview names it as a kept
    // change, computed client-side — no checkpoint, no getDiff call at all.
    {
      const { host, da } = await mountEditPane(stubRichEditor(edited), {
        disk: { content: base, rendered_html: "<p>After.</p>", source_sha256: realSha256(base) },
      });
      await paint();
      da.disk.content = "> [!info] A callout\n> with a second line, changed on disk.\n\nAfter.\n";
      da.getDiff = async () => {
        throw new Error("getDiff must not be called — the preview no longer depends on a pin");
      };
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

      saveButton(host).click();
      await paint();

      const detail = (modal()?.querySelector(".glosa-dialog-detail") as any)?.textContent ?? "";
      expect(detail).toContain("1 change from disk will be kept.");

      modalButton("Cancel").click();
      await paint();
    }

    // No verified base (the placeholder sha the other fixtures use never matches a real hash) —
    // the dialog still opens, and says the base could not be verified, rather than guessing.
    {
      const { host, da } = await mountEditPane(stubRichEditor(edited));
      await paint();
      da.disk.content = "> [!info] A callout\n> with a second line.\n\nSomeone else's paragraph.\n";
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

      saveButton(host).click();
      await paint();

      expect(modal()).toBeTruthy();
      const detail = (modal()?.querySelector(".glosa-dialog-detail") as any)?.textContent ?? "";
      expect(detail).toContain("can't verify the version you opened");
    }
  });

  test("#182 review round 2 (D6/D9): the preview names each conflicting block and quotes the disk text mine wins over", async () => {
    // Both sides change the SAME block, so the merge reports a conflict. A count alone would not
    // tell the writer which passage their version is about to overwrite; the preview must name the
    // block and show disk's text for it.
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const edited = { markdown: "# Title\n\nParagraph A, the writer's version.\n\nParagraph B.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(edited), {
      disk: { content: base, rendered_html: "<p>A</p>", source_sha256: realSha256(base) },
    });
    await paint();
    da.disk.content = "# Title\n\nParagraph A, rewritten on disk.\n\nParagraph B.\n";
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();

    const detail = (modal()?.querySelector(".glosa-dialog-detail") as any)?.textContent ?? "";
    expect({
      saysHowMany: detail.includes("1 block changed on both sides"),
      namesTheBlock: detail.includes("Block 2"),
      quotesDiskText: detail.includes("rewritten on disk"),
    }).toEqual({ saysHowMany: true, namesTheBlock: true, quotesDiskText: true });

    modalButton("Cancel").click();
    await paint();
  });

  test("#182 review rounds 5-6: a conflict in the source between blocks is not counted or named as a block", async () => {
    // Both sides change the region between the two blocks, differently. The dialog must not call
    // that "1 block changed on both sides" — the writer would look for a changed paragraph — and
    // it must not call it "spacing" either, since such a region can hold real Markdown.
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const edited = { markdown: "# Title\n\n\nParagraph A.\n\nParagraph B.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(edited), {
      disk: { content: base, rendered_html: "<p>A</p>", source_sha256: realSha256(base) },
    });
    await paint();
    da.disk.content = "# Title\n\n\n\nParagraph A.\n\nParagraph B.\n";
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();

    const detail = (modal()?.querySelector(".glosa-dialog-detail") as any)?.textContent ?? "";
    expect({
      callsItASourceRegion: detail.includes("other source region"),
      namesWhere: detail.includes("The source after block 1"),
      callsItABlock: detail.includes("1 block changed"),
    }).toEqual({ callsItASourceRegion: true, namesWhere: true, callsItABlock: false });

    modalButton("Cancel").click();
    await paint();
  });

  test("AC-10: Keep mine issues exactly one further write, carrying the re-read sha and the merged markdown", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(edited));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
    da.disk.source_sha256 = "sha-fresh"; // what staleSave's re-read of the artifact returns

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();

    modalButton("Keep mine").click();
    await paint();

    expect(modal()).toBeNull(); // nothing to consent to — a clean rebase writes straight through
    expect(da.put).toEqual([{ path: "notes.md", content: edited.markdown, ifMatch: "sha-fresh" }]);
  });

  test("AC-17 (#182 R4): mine's own degrading splice report still reaches the collateral consent gate through the merge; declining writes nothing", async () => {
    // #182 removed the `rebaseOnto` call Keep mine used to make; the degraded report now has to
    // ride through `getSave()` and the merge's pass-through instead (R4) — this is the ablation
    // R4 names: dropping that pass-through, or the `consentToCollateral` call after it, is exactly
    // what would make this test stop catching a degrading Keep mine.
    const edited = {
      markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n",
      degraded: "block-mismatch" as const,
    };
    const { host, da } = await mountEditPane(stubRichEditor(edited));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();
    // The ordinary save's own collateral gate fires first — a degrading report reaches it here
    // exactly as any other save's does. Consenting is what lets the write attempt (and its 409)
    // happen at all.
    expect(modal()?.querySelector("p")?.textContent).toContain("rewrites the whole thing");
    modalButton("Save anyway").click();
    await paint();

    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");
    modalButton("Keep mine").click();
    await paint();

    // Keep mine's own merge carries mine's SAME splice report through (R4) — asked again, not
    // silently dropped, and still not a second write.
    expect(modal()?.querySelector("p")?.textContent).toContain("rewrites the whole thing");
    expect(da.put).toEqual([]);

    modalButton("Cancel").click();
    await paint();
    expect(da.put).toEqual([]);
  });

  test("#182 R1: a clean Rich→Source switch after an SSE refresh fills from the baseline pair, not the refreshed content", async () => {
    const base = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const { host, pane, da } = await mountEditPane(stubRichEditor({ markdown: base }, { dirty: false }));
    expect(pane.isDirty()).toBe(false);

    // An SSE-driven refresh moves `currentArtifact.content` while the (clean) editor stays
    // mounted over the ORIGINAL bytes — the bug R1 names is filling the source face from THIS
    // instead of from the pair the rich face was actually opened over.
    da.disk.content = "> [!info] A callout\n> with a second line.\n\nSomeone else's change entirely.\n";
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();

    (host.querySelector(".glosa-face-source") as any).click();
    await paint();
    expect((host.querySelector(".glosa-edit-area") as any).value).toBe(base);
  });

  test("#182 F-8: a delayed rich-mount failure, racing an SSE refresh, fills the source face from the bytes it was asked to mount, and the base a later Keep-mine merge uses does not move either", async () => {
    const base = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    // A working loader for the pane's own initial mount (construction fires more than one mount
    // attempt before the artifact even loads — irrelevant plumbing this test must not depend on),
    // swapped for a controllable, never-settling one only once the pane has already loaded
    // cleanly, so the ONE pending mount left afterward is unambiguously the one this test drives.
    const clean = stubRichEditor({ markdown: base }, { dirty: false });
    let currentLoad = clean.loadRichEditor;
    const { host, pane, da } = await mountEditPane(
      { loadRichEditor: () => currentLoad() },
      { disk: { content: base, rendered_html: "<p>After.</p>", source_sha256: realSha256(base) } },
    );
    expect(pane.isDirty()).toBe(false);

    let rejectMount: (error: unknown) => void = () => {};
    currentLoad = () => new Promise((_resolve, reject) => (rejectMount = reject));
    // Force a fresh rich mount, through the SAME face-toggle path a writer's own click takes —
    // Source then Rich again — so this is the one, unambiguous, pending mount attempt.
    (host.querySelector(".glosa-face-source") as any).click();
    await paint();
    (host.querySelector(".glosa-face-rich") as any).click();
    await paint();

    // The mount is still pending (loadRichEditor never resolved) when an SSE refresh lands,
    // advancing `currentArtifact.content` past the held baseline pair.
    const onDiskDuringMount = "> [!info] A callout\n> with a second line, changed WHILE MOUNTING.\n\nAfter.\n";
    da.disk.content = onDiskDuringMount;
    da.disk.source_sha256 = "sha-mid-mount";
    await pane.refreshArtifact();

    // Only now does the mount actually fail.
    rejectMount(new Error("rich editor failed to load"));
    await paint();

    expect((host.querySelector(".glosa-face-source") as any).getAttribute("aria-pressed")).toBe("true");
    const textarea = host.querySelector(".glosa-edit-area") as any;
    // Filled from the ORIGINAL bytes this mount was asked to render, not from the SSE-refreshed
    // `currentArtifact.content` that raced ahead of it while `loadRichEditor()` was pending.
    expect(textarea.value).toBe(base);

    // The base a later Keep-mine merge uses did not move either: a source-face edit plus a
    // genuine, further disk change merges cleanly against the ORIGINAL base, not the bytes that
    // merely raced past it during the failed mount.
    const myEdit = "> [!info] A callout\n> with a second line.\n\nAfter, MY EDIT.\n";
    textarea.value = myEdit;
    textarea.dispatchEvent(new dom.window.Event("input"));
    await paint();

    const onDiskAtSave = "> [!info] A callout\n> with a second line, changed on disk for real.\n\nAfter.\n";
    da.disk.content = onDiskAtSave;
    da.disk.source_sha256 = "sha-fresh";
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();
    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

    modalButton("Keep mine").click();
    await paint();

    expect(da.put).toEqual([
      {
        path: "notes.md",
        content: "> [!info] A callout\n> with a second line, changed on disk for real.\n\nAfter, MY EDIT.\n",
        ifMatch: "sha-fresh",
      },
    ]);
  });

  test("#182 criterion 3: Keep mine from the SOURCE face runs the real three-way merge too, not a whole-file write", async () => {
    const base = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const { host, da } = await mountEditPane(stubRichEditor({ markdown: base }), {
      disk: { content: base, rendered_html: "<p>After.</p>", source_sha256: realSha256(base) },
    });

    (host.querySelector(".glosa-face-source") as any).click();
    await paint();
    const textarea = host.querySelector(".glosa-edit-area") as any;
    const myEdit = "> [!info] A callout\n> with a second line.\n\nAfter, MY EDIT.\n";
    textarea.value = myEdit;
    textarea.dispatchEvent(new dom.window.Event("input"));
    await paint();

    // Disk changed a DIFFERENT block — the callout — while the writer was editing "After.".
    const onDisk = "> [!info] A callout\n> with a second line, changed on disk.\n\nAfter.\n";
    da.disk.content = onDisk;
    da.disk.source_sha256 = "sha-fresh";
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();
    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

    modalButton("Keep mine").click();
    await paint();

    // Both survive, byte-exact — the whole point of #182, and only reachable from the source
    // face through the real merge, never through a whole-file `editArea.value` write.
    expect(da.put).toEqual([
      {
        path: "notes.md",
        content: "> [!info] A callout\n> with a second line, changed on disk.\n\nAfter, MY EDIT.\n",
        ifMatch: "sha-fresh",
      },
    ]);
  });

  test("AC-19: a second 409 on the Keep-mine retry does not re-open the dialog", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(edited));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } }); // the retry 409s too

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();

    modalButton("Keep mine").click();
    await paint();

    expect(modal()).toBeNull(); // reports and declines — never re-opens
    expect(da.put).toEqual([]);
    expect((host.querySelector(".glosa-edit-status") as any)?.textContent).toContain(
      "Not saved — this file changed again",
    );
  });

  test("AC-12: Take disk raises the dirty guard, writes nothing on confirm and reloads from disk, changes nothing on decline", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };

    // Confirm: zero further PUTs, and the editor remounts over the disk bytes.
    {
      const changed = "Someone else's change.\n";
      const stub = stubRichEditor(edited);
      const { host, pane, da } = await mountEditPane(stub);
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
      da.disk.content = changed;
      da.disk.source_sha256 = "sha-fresh";

      saveButton(host).click();
      await paint();
      expect(modal()).toBeTruthy();

      stub.calls.mountedWith.length = 0;
      modalButton("Take disk").click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("Discard unsaved edits?");

      modalButton("Discard edits").click();
      await paint();

      expect(modal()).toBeNull();
      expect(da.put).toEqual([]); // the rejected first attempt never landed in da.put either
      expect(pane.artifact?.source_sha256).toBe("sha-fresh");
      expect(stub.calls.mountedWith.at(-1)).toBe(changed);
    }

    // Decline: nothing changes.
    {
      const { host, da } = await mountEditPane(stubRichEditor(edited));
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

      saveButton(host).click();
      await paint();
      expect(modal()).toBeTruthy();

      modalButton("Take disk").click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("Discard unsaved edits?");

      modalButton("Cancel").click();
      await paint();

      expect(modal()).toBeNull();
      expect(da.put).toEqual([]);
    }
  });

  test("AC-13: Compare opens a diff tab from the pinned checkpoint to the working file, writes nothing, and leaves the editor dirty", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const opened: unknown[] = [];
    const stub = stubRichEditor(edited);
    const { host, pane, da } = await mountEditPane(
      { ...stub, openDiffTab: (range: unknown) => opened.push(range) },
      { checkpoints: [{ checkpoint_id: "cp-abc1234", at: "2026-09-06T10:00:00Z" }] },
    );
    await paint(); // let the pin land, so editSession.openedCheckpointId is the pinned checkpoint
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();

    modalButton("Compare").click();
    await paint();

    expect(modal()).toBeNull();
    expect(opened).toEqual([{ path: "notes.md", from: "cp-abc1234", to: "working" }]);
    expect(da.put).toEqual([]);
    expect(pane.isDirty()).toBe(true); // untouched — Compare doesn't act on the draft
  });

  test("Compare falls back to the newest checkpoint when nothing was pinned, and says so when there is none", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };

    // No pin (default empty checkpoints at mount), but a checkpoint exists by the time Compare is
    // clicked — falls back to the newest one, matching compareWithLastSaved's own behaviour.
    {
      const opened: unknown[] = [];
      const stub = stubRichEditor(edited);
      const { host, da } = await mountEditPane({ ...stub, openDiffTab: (range: unknown) => opened.push(range) });
      await paint();
      da.checkpoints = [{ checkpoint_id: "cp-fallback9", at: "2026-09-06T10:00:00Z" }];
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

      saveButton(host).click();
      await paint();
      modalButton("Compare").click();
      await paint();

      expect(opened).toEqual([{ path: "notes.md", from: "cp-fallback9", to: "working" }]);
    }

    // No pin and no checkpoint at all — the same message compareWithLastSaved uses.
    {
      const stub = stubRichEditor(edited);
      const { host, da } = await mountEditPane({ ...stub, openDiffTab: () => {} });
      await paint();
      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

      saveButton(host).click();
      await paint();
      modalButton("Compare").click();
      await paint();

      expect((host.querySelector(".glosa-edit-status") as any)?.textContent).toContain(
        "This artifact has no saved versions to compare with yet.",
      );
    }
  });

  test("AC-11: after Keep mine the pane settles — a further save carries the post-Keep-mine sha and opens no second dialog", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
    const { host, da } = await mountEditPane(stubRichEditor(edited));
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
    da.disk.source_sha256 = "sha-fresh";

    saveButton(host).click();
    await paint();
    expect(modal()).toBeTruthy();

    modalButton("Keep mine").click();
    await paint();
    expect(da.put).toEqual([{ path: "notes.md", content: edited.markdown, ifMatch: "sha-fresh" }]);

    // A further save, nothing more queued to reject — DSR-2's regression test: if writeAndSettle's
    // five transitions were skipped by the Keep-mine retry, baselineSha would still be the
    // PRE-conflict sha here and this save would 409 into a second dialog instead of just writing.
    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toHaveLength(2);
    expect(da.put[1]?.ifMatch).toBe("sha-fresh");
  });

  test("AC-20: a save that succeeds through the stale dialog can still be approved, with the post-Keep-mine revision id", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };
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
      ...stubRichEditor(edited),
      getAttentionEntries: () => [request],
      respondToAttention: undefined,
    });
    (da as any).respondToAttention = async (_slug: string, id: string, body: Record<string, unknown>) => {
      answered.push({ id, ...body });
      return { id, ...body };
    };
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
    da.disk.source_sha256 = "sha-fresh";

    const strip = host.querySelector(".glosa-approval-strip") as any;
    expect(strip).toBeTruthy();
    (strip.querySelector(".glosa-approval-button") as any).click();
    await paint();
    // First modal: "Approve this revision?" — the reader says yes.
    modalButton("Approve revision").click();
    await paint();
    // Second modal: the underlying save 409s — the stale-save dialog, not the collateral gate.
    expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

    modalButton("Keep mine").click();
    await paint();

    // approveCurrentArtifact:968 reads currentArtifact?.source_sha256 AFTER the save — this is the
    // branch the existing declined-save test (above) cannot reach, because its guard is
    // SAVE_DECLINED-only and this save succeeds.
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ id: "inb-1", outcome: "approved", revisionId: "sha-fresh" });
    expect(host.querySelector(".glosa-approval-status")?.textContent ?? "").not.toContain("Nothing was approved");
  });

  test("AC-32: the sealed scenario, end to end — dirty, disk changes, banner, save, dialog, each verb", async () => {
    const edited = { markdown: "> [!info] A callout\n> with a second line.\n\nAfter, edited.\n" };

    // Cancel: declines, nothing written, editor still dirty.
    {
      const { host, pane, da } = await mountEditPane(stubRichEditor(edited));
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      expect((host.querySelector(".glosa-disk-change") as any)?.hidden).toBe(false);

      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
      saveButton(host).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

      modalButton("Cancel").click();
      await paint();
      expect(da.put).toEqual([]);
      expect(pane.isDirty()).toBe(true);
    }

    // Take disk: declines nothing to write, discards, remounts over disk.
    {
      const changed = "Someone else's change.\n";
      const stub = stubRichEditor(edited);
      const { host, pane, da } = await mountEditPane(stub);
      da.disk.content = changed;
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      expect((host.querySelector(".glosa-disk-change") as any)?.hidden).toBe(false);

      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
      saveButton(host).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

      stub.calls.mountedWith.length = 0;
      modalButton("Take disk").click();
      await paint();
      modalButton("Discard edits").click();
      await paint();

      expect(da.put).toEqual([]);
      expect(pane.artifact?.source_sha256).toBe("sha-2");
      expect(stub.calls.mountedWith.at(-1)).toBe(changed);
    }

    // Compare: opens a diff tab, writes nothing, stays dirty.
    {
      const opened: unknown[] = [];
      const stub = stubRichEditor(edited);
      const { host, pane, da } = await mountEditPane(
        { ...stub, openDiffTab: (range: unknown) => opened.push(range) },
        { checkpoints: [{ checkpoint_id: "cp-abc1234", at: "2026-09-06T10:00:00Z" }] },
      );
      await paint(); // let the pin land
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      expect((host.querySelector(".glosa-disk-change") as any)?.hidden).toBe(false);

      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
      saveButton(host).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

      modalButton("Compare").click();
      await paint();

      expect(opened).toEqual([{ path: "notes.md", from: "cp-abc1234", to: "working" }]);
      expect(da.put).toEqual([]);
      expect(pane.isDirty()).toBe(true);
    }

    // Keep mine: writes once, carrying the fresh sha and the rebased bytes.
    {
      const stub = stubRichEditor(edited);
      const { host, pane, da } = await mountEditPane(stub);
      da.disk.source_sha256 = "sha-2";
      await pane.refreshArtifact();
      expect((host.querySelector(".glosa-disk-change") as any)?.hidden).toBe(false);

      da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });
      saveButton(host).click();
      await paint();
      expect(modal()?.querySelector("h2")?.textContent).toBe("This file changed while you were editing");

      modalButton("Keep mine").click();
      await paint();

      expect(modal()).toBeNull();
      expect(da.put).toEqual([{ path: "notes.md", content: edited.markdown, ifMatch: "sha-2" }]);
      expect(pane.artifact?.source_sha256).toBe("sha-2");
    }
  });

  test("#250: a save refused because the file on disk became undecodable never opens the merge dialog", async () => {
    // The daemon refuses this PUT with `not-utf8`, but the SPA re-reads before deciding what to
    // show, and what it finds is a file it must not offer to merge onto: Take disk would fill the
    // editor from a replacement-character decode, and Keep mine would splice onto one as a base.
    const { host, da } = await mountEditPane(stubRichEditor({ markdown: "EDITED\n" }));
    da.disk.valid_utf8 = false;
    da.disk.source_sha256 = "sha-2";
    da.putRejections.push({ status: 409, problem: { type: "https://glosa.local/errors/source-changed" } });

    saveButton(host).click();
    await paint();

    expect(modal()).toBeNull();
    expect(da.put).toEqual([]);
    const status = host.querySelector(".glosa-edit-status") as any;
    expect(status.textContent).toContain("no longer valid UTF-8 on disk");
    expect(status.getAttribute("data-error")).toBe("true");
  });

  test("#250: Reload onto bytes that are no longer decodable takes the file and leaves Edit", async () => {
    const { host, pane, da } = await mountEditPane(stubRichEditor({ markdown: "EDITED\n" }));
    // Dirty, so `refreshArtifact` holds the draft and raises the banner instead of dropping out
    // of Edit on its own — which is what makes Reload the reachable path here.
    expect(pane.isDirty()).toBe(true);
    da.disk.valid_utf8 = false;
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();
    await paint();
    expect((host.querySelector(".glosa-disk-change") as any).hidden).toBe(false);
    expect(pane.getMode()).toBe("edit");

    (host.querySelector(".glosa-disk-change-reload") as any).click();
    await paint();
    modalButton("Discard edits")?.click();
    await paint();

    expect(pane.getMode()).toBe("read");
    expect(host.querySelector('.glosa-modebar [data-control="edit"]')).toBeNull();
    expect((host.querySelector(".glosa-encoding-notice") as any).hidden).toBe(false);
    expect(da.put).toEqual([]);
  });

  test("AC-29: the harness can produce a clean pane, and a dirty one", async () => {
    const clean = await mountEditPane(stubRichEditor(LOSSY, { dirty: false }));
    expect(clean.pane.isDirty()).toBe(false);

    const dirty = await mountEditPane(stubRichEditor(LOSSY, { dirty: true }));
    expect(dirty.pane.isDirty()).toBe(true);
  });
});

// #250 — an artifact whose bytes the daemon could not decode. The pane holds a
// replacement-character copy of the file, so every writable face over it is a face that would save
// something other than what is on disk. Edit is therefore not offered at all, and the reason is on
// the page rather than left to be discovered in a diff.
//
// These mount the pane in READ, unlike the suite above: the whole point is that the path into Edit
// is gone, so there is no "Edit source" tool to click on the way in.
describe("Edit mode — an artifact that is not valid UTF-8 is shown, never edited", () => {
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
    for (let i = 0; i < 12; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await flush();
  };

  /** What `getArtifact` returns for a file holding a lone `0xe9`: the lossy decode the daemon
   * still serves for preview, plus the field saying so. */
  const LOSSY_CONTENT = "# Caf�\n\nBody\n";

  function fake({ validUtf8 = false }: { validUtf8?: boolean | undefined } = {}) {
    return {
      disk: { content: LOSSY_CONTENT, rendered_html: "<p>Body</p>", source_sha256: "sha-1", valid_utf8: validUtf8 },
      put: [] as unknown[],
      subscribe: () => () => {},
      async getArtifact() {
        return {
          source_path: "latin1.md",
          class: "R",
          content: this.disk.content,
          rendered_html: this.disk.rendered_html,
          source_sha256: this.disk.source_sha256,
          // `undefined` is how an N-1 daemon answers: the key is absent from the JSON entirely.
          ...(this.disk.valid_utf8 === undefined ? {} : { valid_utf8: this.disk.valid_utf8 }),
        };
      },
      async getAnnotations() {
        return { annotations: [] };
      },
      async getCheckpoints() {
        return [];
      },
      async getDiff() {
        return { hunks: [] };
      },
      async putArtifact(_slug: string, path: string, content: string) {
        this.put.push({ path, content });
        return { source_sha256: "sha-2" };
      },
    };
  }

  async function mountPane(daOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const da = Object.assign(fake(), daOverrides);
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "latin1.md",
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
      ...extra,
    });
    await pane.ready;
    await paint();
    return { host, pane, da };
  }

  const notice = (host: any) => host.querySelector(".glosa-encoding-notice") as any;
  const editButton = (host: any) => host.querySelector('.glosa-modebar [data-control="edit"]');

  test("no way into Edit is offered, and the page says why", async () => {
    const { host, pane } = await mountPane();

    expect(editButton(host)).toBeNull();
    expect((host.querySelector(".glosa-tools-edit-source") as any).hidden).toBe(true);
    expect(pane.canEdit()).toBe(false);
    expect(notice(host).hidden).toBe(false);
    expect(notice(host).textContent).toContain("not valid UTF-8");
    expect(notice(host).textContent).toContain("saving would rewrite the bytes it cannot read");
    // Still a preview: refusing to edit is not refusing to show.
    expect((host.querySelector(".glosa-content") as any).textContent).toContain("Body");
  });

  test("⌘E and a programmatic setMode both leave the pane in Read, writing nothing", async () => {
    const { host, pane, da } = await mountPane();

    pane.toggleEdit();
    await paint();
    expect(pane.getMode()).toBe("read");

    pane.setMode("edit");
    await paint();
    expect(pane.getMode()).toBe("read");
    expect(host.querySelector(".glosa-pane")?.getAttribute("data-mode")).toBe("read");
    expect(da.put).toEqual([]);
  });

  test("a pane deep-linked straight into Edit lands in Read, with no editable face ever mounted", async () => {
    const { host, pane, da } = await mountPane({}, { initialMode: "edit" });

    expect(pane.getMode()).toBe("read");
    expect(host.querySelector(".glosa-pane")?.getAttribute("data-mode")).toBe("read");
    expect((host.querySelector(".glosa-edit-area") as any).hidden).toBe(true);
    expect(editButton(host)).toBeNull();
    expect(notice(host).hidden).toBe(false);
    expect(da.put).toEqual([]);
  });

  test("a file that becomes undecodable under an open, clean pane drops out of Edit", async () => {
    const { host, pane, da } = await mountPane({ disk: { ...fake().disk, content: "# Fine\n", valid_utf8: true } });
    expect(pane.getMode()).toBe("read");
    pane.setMode("edit");
    await paint();
    expect(pane.getMode()).toBe("edit");
    expect(pane.isDirty()).toBe(false);

    da.disk.valid_utf8 = false;
    da.disk.source_sha256 = "sha-2";
    await pane.refreshArtifact();
    await paint();

    expect(pane.getMode()).toBe("read");
    expect(editButton(host)).toBeNull();
    expect(notice(host).hidden).toBe(false);
  });

  test("N-1 pin: a daemon that sends no valid_utf8 field still offers Edit, and the notice stays hidden", async () => {
    const { host, pane } = await mountPane({ disk: { ...fake().disk, content: "# Fine\n", valid_utf8: undefined } });

    expect(editButton(host)).not.toBeNull();
    expect(pane.canEdit()).toBe(true);
    expect((host.querySelector(".glosa-tools-edit-source") as any).hidden).toBe(false);
    expect(notice(host).hidden).toBe(true);
  });
});
