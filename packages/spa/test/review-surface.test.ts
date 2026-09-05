// SPDX-License-Identifier: Apache-2.0
// Review mode's agent half: a session pointing at a passage, asking about it, and the reviewer
// answering without losing whatever they were in the middle of.
//
// Each test names the way the feature could be quietly wrong rather than the feature it covers:
//
//   * A mode switch used to DESTROY unsaved source — the reducer refused to leave Edit while dirty
//     and offered "Discard edits?". An agent-caused switch on top of that behaviour would have
//     thrown away a reviewer's paragraph to show them a question, which is the single worst thing
//     this feature could do. Parking is the reason the prompt is gone, so parking has to be proven
//     end to end, not just in the reducer.
//   * A session's options must never be able to close the reviewer's vocabulary. The free-text
//     field is glosa's guarantee, not the session's, so it is present even when options are.
//   * A quote that cannot be proven unique must produce NO mark. Underlining the wrong paragraph
//     is worse than underlining nothing, and it is the failure a resolver "helpfully" falling back
//     to the first match would produce.
//   * The provider is derived from a binding glosa verified; the label is a string the session
//     sent about itself. A card that ran them together would present a claim as a fact (A4 §F05's
//     honesty rule, applied to identity).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("Review mode — the agent's half of the margin", () => {
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
  const q = (root: any, selector: string): any => root.querySelector(selector);
  const qa = (root: any, selector: string): any[] => [...root.querySelectorAll(selector)];

  const SOURCE = "# Konspekt\n\nThe argument rests on the premise that readers accept the frame.\n";
  const RENDERED =
    "<h1>Konspekt</h1><p id=\"para\">The argument rests on the premise that readers accept the frame.</p>";

  function fakeDataAccess(entries: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
    return {
      answered: [] as Array<Record<string, unknown>>,
      saved: [] as string[],
      attention: entries,
      async getArtifact() {
        return {
          source_path: "notes.md",
          content: SOURCE,
          rendered_html: RENDERED,
          source_sha256: "sha-1",
          rendered_sha256: "r-1",
          class: "R",
        };
      },
      async getAnnotations() {
        return { annotations: [] };
      },
      async getCheckpoints() {
        return [];
      },
      async putArtifact(_slug: string, _path: string, content: string) {
        this.saved.push(content);
        return { source_sha256: "sha-2" };
      },
      async respondToAttention(_slug: string, id: string, body: Record<string, unknown>) {
        this.answered.push({ id, ...body });
        return { id, status: "done" };
      },
      ...overrides,
    };
  }

  async function mountPane(da: any, extra: Record<string, unknown> = {}) {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "review",
      getAttentionEntries: () => da.attention,
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
      ...extra,
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  const askAboutPremise = (over: Record<string, unknown> = {}) => ({
    id: "inb-1",
    created_at: "2026-09-05T10:00:00Z",
    status: "open",
    action: "review",
    target_path: "notes.md",
    message: "Is that ok already? Is argument X covered enough?",
    agent_label: "api-refactor",
    passage: { quote: { exact: "the premise that readers accept the frame" } },
    answer_options: null,
    approval_mode: false,
    ...over,
  });

  test("a session's question becomes a card in the rail, with its passage quoted", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
    const card = q(host, ".glosa-agent-card");
    expect(card).toBeTruthy();
    expect(q(card, ".glosa-agent-message").textContent).toContain("Is argument X covered enough?");
    expect(q(card, ".glosa-agent-quote").textContent).toContain("the premise that readers accept the frame");
  });

  test("the passage gets a SIDELINE, not a wash — the human's marks own the words", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
    // A rule beside the text, in its own layer. If this ever became a highlight range instead, an
    // agent mark and an annotation on the same sentence would be indistinguishable.
    expect(qa(host, ".glosa-sidelines .glosa-sideline").length).toBe(1);
    expect(q(host, ".glosa-sideline").getAttribute("data-entry")).toBe("inb-1");
  });

  test("proven provider and claimed label are rendered as separate things", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
    const card = q(host, ".glosa-agent-card");
    expect(q(card, ".glosa-agent-provider").textContent).toBe("Claude Code");
    expect(q(card, ".glosa-agent-claimed").textContent).toBe("api-refactor");
  });

  test("no session label leaves the provider standing alone rather than inventing a name", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise({ agent_label: null })]));
    expect(q(host, ".glosa-agent-provider").textContent).toBe("Claude Code");
    expect(q(host, ".glosa-agent-claimed")).toBeNull();
  });

  test("a quote that occurs nowhere in the text is marked lost, and paints no sideline", async () => {
    const { host } = await mountPane(
      fakeDataAccess([askAboutPremise({ passage: { quote: { exact: "a sentence deleted last week" } } })]),
    );
    expect(q(host, ".glosa-agent-lost")).toBeTruthy();
    expect(qa(host, ".glosa-sideline").length).toBe(0);
    // The card stays: the question is still real even when its anchor is not.
    expect(q(host, ".glosa-agent-card")).toBeTruthy();
  });

  test("the free-text field is present even when the session offered options", async () => {
    const { host } = await mountPane(
      fakeDataAccess([askAboutPremise({ answer_options: ["covered", "thin", "missing"] })]),
    );
    expect(qa(host, ".glosa-agent-option").length).toBe(3);
    // The escape hatch is glosa's guarantee. A session supplies its own words; it never gets to
    // close the reviewer's.
    expect(q(host, ".glosa-agent-input")).toBeTruthy();
  });

  test("answering sends the typed words and the chosen option together", async () => {
    const da = fakeDataAccess([askAboutPremise({ answer_options: ["covered", "thin"] })]);
    const { host } = await mountPane(da);
    qa(host, ".glosa-agent-option input")[1].click();
    const input = q(host, ".glosa-agent-input");
    input.value = "Not really — you never say why the reader would accept it.";
    q(host, ".glosa-agent-actions .glosa-primary-button").click();
    await paint();

    expect(da.answered).toHaveLength(1);
    expect(da.answered[0]).toMatchObject({
      id: "inb-1",
      chose: "thin",
      response: "Not really — you never say why the reader would accept it.",
    });
  });

  test("'Can't answer' resolves the request without inventing an answer", async () => {
    const da = fakeDataAccess([askAboutPremise()]);
    const { host } = await mountPane(da);
    q(host, ".glosa-agent-actions .glosa-secondary-button").click();
    await paint();
    expect(da.answered).toHaveLength(1);
    expect(da.answered[0]!.response).toBe("");
    expect(da.answered[0]!.chose).toBeUndefined();
  });

  test("a pointer with no question still marks the passage", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise({ message: null, action: "point" })]));
    expect(qa(host, ".glosa-sideline").length).toBe(1);
    expect(q(host, ".glosa-agent-message")).toBeNull();
  });

  test("a request for another artifact never appears in this pane's rail", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise({ target_path: "elsewhere.md" })]));
    expect(q(host, ".glosa-agent-card")).toBeNull();
    expect(qa(host, ".glosa-sideline").length).toBe(0);
  });

  describe("unsaved work survives the switch the agent causes", () => {
    test("an Edit draft is still there after Review and back — nothing is discarded, nothing is asked", async () => {
      const da = fakeDataAccess([]);
      const { host, pane } = await mountPane(da, { initialMode: "edit" });

      const editor = q(host, ".glosa-edit-area");
      editor.value = "# Konspekt\n\nA paragraph I was halfway through writing.";
      editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();

      // Exactly what an arriving question does to the pane.
      pane.setMode("review");
      await paint();
      // No dialog: parking removed the only reason to ask.
      expect(q(dom.document.body, "dialog[open]")).toBeNull();
      // The Edit segment says the work is still held, since the editor holding it is off screen.
      expect(q(host, '.glosa-modebar [data-mode="edit"]').getAttribute("data-parked")).toBe("true");

      pane.setMode("edit");
      await paint();
      expect(q(host, ".glosa-edit-area").value).toBe("# Konspekt\n\nA paragraph I was halfway through writing.");
      // And it is still unsaved — parking preserves the draft, it does not quietly commit it.
      expect(da.saved).toEqual([]);
    });

    test("saving clears the parked copy, so Edit shows the file rather than a stale draft", async () => {
      const da = fakeDataAccess([]);
      const { host, pane } = await mountPane(da, { initialMode: "edit" });
      const editor = q(host, ".glosa-edit-area");
      editor.value = "# Konspekt\n\nSaved text.";
      editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();
      q(host, ".glosa-save").click();
      await paint();

      pane.setMode("review");
      await paint();
      expect(q(host, '.glosa-modebar [data-mode="edit"]').getAttribute("data-parked")).toBeNull();
    });

    test("a half-written margin note comes back when Review is re-entered", async () => {
      const da = fakeDataAccess([]);
      const { host, pane } = await mountPane(da);

      const content = q(host, ".glosa-content");
      const textNode = q(host, "#para").firstChild;
      const range = dom.document.createRange();
      range.setStart(textNode, 4);
      range.setEnd(textNode, 12);
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
      await flush();

      const composer = q(host, ".glosa-composer-input");
      expect(composer).toBeTruthy();
      composer.value = "half a thought";
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

      pane.setMode("read");
      await paint();
      expect(q(host, ".glosa-composer-input")).toBeNull();

      pane.setMode("review");
      await paint();
      expect(q(host, ".glosa-composer-input").value).toBe("half a thought");
    });
  });
});
