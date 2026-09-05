// SPDX-License-Identifier: Apache-2.0
// The annotation surface: where a draft opens, where the saved set lives, what the manuscript
// shows about itself, and what happens to a note after a session has acted on it.
//
// These are the invariants that were silently false in the shipped build, so each one names the
// defect it exists to catch rather than the feature it decorates:
//
//   * The three CSS Custom Highlight keys are DOCUMENT-GLOBAL. A per-pane random suffix made every
//     `::highlight()` rule in app.css unmatchable, so the annotation underline, the anchor wash and
//     the composer's selection wash painted nothing at all — a heavily annotated manuscript looked
//     untouched. Nothing in the DOM changes when this breaks; only these names tie the two files.
//   * The compact composer was declared `position: absolute; bottom: 0` inside `.glosa-pane-main`,
//     a SCROLL CONTAINER. That resolves against the padding box at scroll origin and then scrolls
//     away with the content, so the draft sat frozen one viewport down the document — hundreds of
//     pixels off-screen for anyone reading past the first screenful.
//   * An anchor is per-SELECTION, never per-block: five words carry their own mark and one
//     paragraph can hold as many as the reader writes, each with its own gutter dot.
//   * `applied` is where a note stops being a task and becomes history — and the `pre_apply`
//     checkpoint the agent's lease left behind is what makes that history reversible.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("the annotation surface", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
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

  /** happy-dom's `Element` is nominally distinct from lib.dom's, and these tests poke at
   * `.click()`/`.value` on nodes the DOM lib types as bare `Element`. One escape hatch, named, in
   * the same spirit as the casts the other suites use inline. */
  const q = (root: any, selector: string): any => root.querySelector(selector);
  const qa = (root: any, selector: string): any[] => [...root.querySelectorAll(selector)];

  const RENDERED = `<h1>Konspekt</h1><p id="para">Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.</p>`;

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
    let n = 1;
    return {
      posted: [] as Array<Record<string, unknown>>,
      withdrawn: [] as string[],
      restored: [] as Array<Record<string, unknown>>,
      checkpointCalls: 0,
      async getArtifact() {
        return {
          source_path: "notes.md",
          content: "# Konspekt",
          rendered_html: RENDERED,
          source_sha256: "sha-1",
          rendered_sha256: "r-1",
          class: "R",
        };
      },
      async postAnnotation(_slug: string, record: Record<string, unknown>) {
        this.posted.push(record);
        return { id: `inb-${n++}`, status: "pending" };
      },
      async withdrawAnnotation(_slug: string, id: string) {
        this.withdrawn.push(id);
        return { id, status: "rejected" };
      },
      async getCheckpoints() {
        this.checkpointCalls++;
        return [];
      },
      async restore(_slug: string, opts: Record<string, unknown>) {
        this.restored.push(opts);
        return { ok: true };
      },
      ...overrides,
    };
  }

  async function mountPane(da: ReturnType<typeof fakeDataAccess>) {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "annotate",
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  /** A pointer drag selects TEXT-NODE boundaries, which is what the record builder reads. */
  function selectRange(host: any, from: number, to: number) {
    const content = q(host, ".glosa-content");
    const textNode = q(host, "#para").firstChild;
    const range = dom.document.createRange();
    range.setStart(textNode, from);
    range.setEnd(textNode, to);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
  }

  async function annotate(host: any, from: number, to: number, body: string) {
    selectRange(host, from, to);
    await flush();
    const input = q(host, ".glosa-composer-input");
    input.value = body;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    q(host, ".glosa-composer-send").click();
    await paint();
  }

  test("the highlight keys JS registers are the ones app.css styles — a suffix here paints nothing", async () => {
    const source = await Bun.file(new URL("../src/artifact-pane.js", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/app.css", import.meta.url)).text();

    // Every name the module writes into the global registry...
    const declared = [...source.matchAll(/^const (HL_[A-Z_]+) = "([^"]+)";$/gm)].map((m) => m[2]);
    expect(declared.sort()).toEqual(["glosa-anchor", "glosa-anchors", "glosa-composer-selection"]);

    // ...must be a name the stylesheet actually selects, or the highlight is invisible. This is the
    // whole failure mode: a random per-pane suffix kept the DOM identical and the paint empty.
    for (const name of declared) expect(css).toContain(`::highlight(${name})`);

    // And nothing may reintroduce a computed key — a template literal here is the regression.
    expect(source).not.toMatch(/CSS\.highlights\.set\(`/);
  });

  test("panes contribute to the shared keys rather than deleting them, so closing one tab cannot blank another's marks", async () => {
    // The registry is document-global and happy-dom implements none of it, so the guarantee is
    // pinned at the source: a pane must WITHDRAW its own contribution on teardown. The previous
    // shape — `CSS.highlights.delete(HL_ANCHORS)` in destroy() — erased every other open
    // artifact's underlines along with its own, which is why per-pane keys were reached for in
    // the first place. Contribution + withdrawal is what makes one shared key correct.
    const source = await Bun.file(new URL("../src/artifact-pane.js", import.meta.url)).text();
    expect(source).not.toMatch(/CSS\.highlights\.delete\(HL_/);
    expect(source).toMatch(/contributeHighlight\(name, paneHighlightToken, \[\]\)/);

    // And two live panes must both survive one of them closing.
    const a = await mountPane(fakeDataAccess());
    const b = await mountPane(fakeDataAccess());
    await annotate(a.host, 0, 10, "first pane");
    await annotate(b.host, 0, 10, "second pane");
    a.pane.destroy();
    await paint();
    expect(qa(b.host, ".glosa-annotation")).toHaveLength(1);
    expect(qa(b.host, ".glosa-marker")).toHaveLength(1);
  });

  test("a compact pane opens the draft AT its passage, inside the visible band — never at a frozen scroll offset", async () => {
    const { host } = await mountPane(fakeDataAccess());
    const margin = q(host, ".glosa-margin");

    selectRange(host, 0, 16);
    await paint();

    // The margin is the anchored layer, not an in-flow block at the end of the document, and not
    // the side rail (an unmeasured pane is below the rail floor).
    expect(margin.classList.contains("glosa-margin-anchored")).toBe(true);
    expect(margin.classList.contains("glosa-margin-side")).toBe(false);

    const composer = q(host, ".glosa-composer");
    expect(composer).not.toBeNull();
    // Placed, and placed at a non-negative offset. The shipped defect put it at the padding box's
    // bottom edge at scroll origin, which reads as a large NEGATIVE viewport offset once scrolled.
    expect(composer.style.top).toMatch(/^\d+px$/);
  });

  test("the saved set lives in the pane's collection tray, not at the end of a long manuscript", async () => {
    const { host } = await mountPane(fakeDataAccess());
    const tray = q(host, ".glosa-annotations-tray");
    expect(tray.hidden).toBe(false);
    expect(q(host, ".glosa-tray-count").textContent).toBe("No annotations yet");

    await annotate(host, 0, 10, "tighten this");

    expect(q(host, ".glosa-tray-count").textContent).toBe("1 annotation");
    // The card is in the tray — which hangs off the PANE, not inside its scrolling main.
    expect(qa(host, ".glosa-tray-list .glosa-annotation")).toHaveLength(1);
    expect(q(host, ".glosa-pane-main .glosa-annotation")).toBeNull();

    // Collapsed by default; the toggle discloses it without moving focus.
    expect(tray.hasAttribute("data-open")).toBe(false);
    q(host, ".glosa-tray-toggle").click();
    await flush();
    expect(tray.hasAttribute("data-open")).toBe(true);
    expect(q(host, ".glosa-tray-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  test("marking five words marks FIVE WORDS: several annotations in one paragraph keep separate anchors and separate dots", async () => {
    const da = fakeDataAccess();
    const { host } = await mountPane(da);
    const full = q(host, "#para").textContent as string;

    await annotate(host, full.indexOf("gamma"), full.indexOf("gamma") + 5, "one");
    await annotate(host, full.indexOf("epsilon"), full.indexOf("epsilon") + 7, "two");
    await annotate(host, full.indexOf("lambda"), full.indexOf("lambda") + 6, "three");

    // What each note is anchored TO is what decides what gets marked. Each target is the words the
    // reader dragged over — never the paragraph that contains them.
    const quoted = da.posted.map((p: any) => p.target.quote.exact as string);
    expect(quoted.sort()).toEqual(["epsilon", "gamma", "lambda"]);
    for (const text of quoted) expect(text.length).toBeLessThan(full.length);
    // Distinct, non-overlapping spans — three marks, not one merged smear over the block.
    const spans = da.posted.map((p: any) => p.target.position);
    expect(new Set(spans.map((s: any) => `${s.start}:${s.end}`)).size).toBe(3);
    for (const span of spans) expect(span.end - span.start).toBeLessThan(full.length);

    // Three notes, three reachable indicators — never one dot hiding a pile.
    const dots = qa(host, ".glosa-marker");
    expect(dots).toHaveLength(3);
    const tops = dots.map((d) => Number.parseFloat(d.style.top));
    expect(new Set(tops).size).toBe(3);
    // Each names its own note, so seven of them are distinguishable to a screen reader.
    const labels = dots.map((d) => d.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(3);
  });

  test("Edit is withdraw-then-write: the new entry is posted BEFORE the old one is withdrawn", async () => {
    const da = fakeDataAccess();
    const { host } = await mountPane(da);
    await annotate(host, 0, 10, "first wording");

    q(host, ".glosa-annotation-edit").click();
    await paint();

    const form = q(host, ".glosa-composer");
    expect(form.getAttribute("data-editing")).toBe("true");
    expect(form.querySelector(".glosa-composer-input").value).toBe("first wording");
    expect(form.querySelector(".glosa-composer-send").textContent).toBe("Replace");
    // The journal cannot rewrite an entry, so the UI says what it will actually do.
    expect(form.querySelector(".glosa-composer-note").textContent).toContain("withdrawn");

    const input = q(form, ".glosa-composer-input");
    input.value = "second wording";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    q(form, ".glosa-composer-send").click();
    await paint();

    expect(da.posted.map((p) => p.body)).toEqual(["first wording", "second wording"]);
    expect(da.withdrawn).toEqual(["inb-1"]); // the superseded entry, withdrawn after the new one exists
    const bodies = qa(host, ".glosa-annotation-body").map((n) => n.textContent);
    expect(bodies).toEqual(["second wording"]);
  });

  test("a session applying a note turns it into reversible history: Resolved, with Undo to its pre-apply checkpoint", async () => {
    const da = fakeDataAccess({
      async getCheckpoints(this: any) {
        this.checkpointCalls++;
        return [
          // The lease's own "before" — stamped with the entry by `apply-begin` (Glosa-Entry).
          {
            checkpoint_id: "pre111",
            at: "2026-09-05T10:00:00Z",
            by: "unknown",
            summary: "pre_apply",
            bytes_changed: 20,
            origin: "workspace",
            entry: "inb-1",
          },
          // The "after". Restoring to THIS would be a no-op dressed up as an undo.
          {
            checkpoint_id: "post22",
            at: "2026-09-05T10:02:00Z",
            by: "session:s1",
            summary: "applied",
            bytes_changed: 40,
            origin: "workspace",
            entry: "inb-1",
          },
        ];
      },
    });
    const { host, pane } = await mountPane(da);
    await annotate(host, 0, 10, "tighten this");

    // Exactly what the daemon streams when `glosa resolve inb-1 applied --session s1` closes the lease.
    pane.applyJournalEvent({
      event: "transition_committed",
      entry: "inb-1",
      detail: { to: "applied", lease_id: "lease-1", post_sha: "post22" },
      by: "session:s1",
    });
    await paint();
    await paint();

    const card = q(host, ".glosa-annotation");
    expect(card.getAttribute("data-state")).toBe("applied");
    expect(card.querySelector(".glosa-annotation-state").textContent).toContain("Done");
    // Settled work sits under its own heading rather than mixed in with what is still open.
    expect(q(host, ".glosa-margin-subhead")).not.toBeNull();

    // Terminal: nothing left to revise, and "Remove" would be a lie — the entry cannot be withdrawn.
    expect(card.querySelector(".glosa-annotation-edit")).toBeNull();
    expect(card.querySelector(".glosa-annotation-remove").textContent).toBe("Dismiss");

    // Undo is offered because the lease left a proven "before" to return to.
    const undo = q(card, ".glosa-annotation-undo");
    expect(undo).not.toBeNull();

    (dom.window as any).HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    undo.click();
    await flush();
    const dialog = q(dom.document, "dialog.glosa-dialog");
    expect(dialog).not.toBeNull();
    q(dialog, ".glosa-btn-danger").click();
    await paint();

    // It restores to the PRE-apply checkpoint for this entry, on this artifact.
    expect(da.restored).toEqual([{ path: "notes.md", to: "pre111", force: false }]);
  });

  test("no proven pre-apply checkpoint, no undo offer — glosa never promises a rollback it cannot perform", async () => {
    const da = fakeDataAccess({
      async getCheckpoints(this: any) {
        this.checkpointCalls++;
        // A session that edited WITHOUT taking an apply-lease leaves no entry-stamped "before".
        return [
          {
            checkpoint_id: "aaa",
            at: "2026-09-05T10:00:00Z",
            by: "unknown",
            summary: "auto_checkpoint",
            bytes_changed: 20,
            origin: "workspace",
          },
        ];
      },
    });
    const { host, pane } = await mountPane(da);
    await annotate(host, 0, 10, "tighten this");
    pane.applyJournalEvent({
      event: "transition_committed",
      entry: "inb-1",
      detail: { to: "applied" },
      by: "session:s1",
    });
    await paint();
    await paint();

    const card = q(host, ".glosa-annotation");
    expect(card.getAttribute("data-state")).toBe("applied");
    expect(card.querySelector(".glosa-annotation-undo")).toBeNull();
  });
});
