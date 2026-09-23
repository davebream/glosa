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
  /** happy-dom implements no CSS Custom Highlight registry, and a session's words are marked
   * through it. This stand-in has the registry's shape (a map of names to set-like highlights of
   * ranges) so a test can read which words each key holds. It proves the pane hands the right
   * ranges to the right key; that the key paints is the stylesheet's and the real engine's part. */
  type HighlightedRange = { startContainer: unknown; toString(): string };
  const installHighlights = () => {
    const registry = new Map<string, Set<HighlightedRange>>();
    const g = globalThis as { CSS?: unknown; Highlight?: unknown };
    const before = { CSS: g.CSS, Highlight: g.Highlight };
    g.CSS = { highlights: registry };
    g.Highlight = class extends Set<HighlightedRange> {
      priority = 0;
      constructor(...ranges: HighlightedRange[]) {
        super(ranges);
      }
    };
    // Keys are document-global and panes from earlier tests are never destroyed, so their ranges
    // are still contributed; only the words inside this test's own pane are this test's.
    const words = (name: string, host: { contains(node: unknown): boolean }) =>
      [...(registry.get(name) ?? [])].filter((range) => host.contains(range.startContainer)).map((r) => r.toString());
    const restore = () => {
      g.CSS = before.CSS;
      g.Highlight = before.Highlight;
    };
    return { words, restore };
  };
  /** Since #271 the byte-exact editor is a tool in More, not a segment of the mode control. */
  const editSource = (host: any): any => q(host, ".glosa-tools-edit-source");
  const qa = (root: any, selector: string): any[] => [...root.querySelectorAll(selector)];

  const SOURCE = "# Konspekt\n\nThe argument rests on the premise that readers accept the frame.\n";
  const RENDERED = '<h1>Konspekt</h1><p id="para">The argument rests on the premise that readers accept the frame.</p>';

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

  describe("one page: a notes toggle, Edit as a state of it, and a pause while a session applies", () => {
    const control = (host: any, name: string) => q(host, `.glosa-modebar [data-control="${name}"]`);

    test("Note and Edit turn each other off, and neither pressed is the plain page", async () => {
      // REWRITTEN for the two-mode control. This test used to assert the opposite of every line
      // below — that there was no Edit segment at all, and that editing the source replaced the
      // whole control with Done. Both were true of the one-toggle model and are the thing the two
      // states replace: the two gestures claimed the same click and nothing on the page said so.
      const { host, pane } = await mountPane(fakeDataAccess([]));
      expect(control(host, "notes").getAttribute("aria-pressed")).toBe("true");
      expect(control(host, "edit").getAttribute("aria-pressed")).toBe("false");

      // Pressing Edit while Note is on moves between them rather than stacking them.
      control(host, "edit").click();
      await paint();
      expect(pane.getMode()).toBe("edit");
      expect(control(host, "notes").getAttribute("aria-pressed")).toBe("false");
      expect(control(host, "edit").getAttribute("aria-pressed")).toBe("true");

      // Pressing the one that is on leaves the reader with the manuscript and nothing else.
      control(host, "edit").click();
      await paint();
      expect(pane.getMode()).toBe("read");
      expect(control(host, "notes").getAttribute("aria-label")).toBe("Show notes");
      expect(control(host, "edit").getAttribute("aria-pressed")).toBe("false");

      // And both controls survive the source view, which is a tool inside Edit rather than a state
      // that takes the page over.
      editSource(host).click();
      await paint();
      expect(pane.getMode()).toBe("edit");
      expect(control(host, "notes")).not.toBeNull();
      expect(control(host, "edit")).not.toBeNull();
    });

    test("a session's apply lease pauses Edit, keeps an open draft, and lifts when the lease ends", async () => {
      const { host, pane } = await mountPane(fakeDataAccess([]));
      pane.setApplyPause({ lease_id: "L1", expires_at: null });
      await paint();
      expect(editSource(host).disabled).toBe(true);
      expect(editSource(host).getAttribute("aria-label")).toContain("paused");
      // The mode control's own Edit button says why it will not go, rather than quietly doing nothing.
      expect(control(host, "edit").disabled).toBe(true);
      pane.setMode("edit");
      expect(pane.getMode()).toBe("review");

      pane.setApplyPause(null);
      await paint();
      expect(editSource(host).disabled).toBe(false);
      pane.setMode("edit");
      expect(pane.getMode()).toBe("edit");

      // A lease that starts while a draft is open does not throw the draft away; it says why to wait.
      pane.setApplyPause({ lease_id: "L2", expires_at: null });
      await paint();
      expect(pane.getMode()).toBe("edit");
      expect(q(host, ".glosa-edit-status").textContent).toContain("session is applying a change");
    });
  });

  /** The mount is narrower than the rail floor, so a located question is answered in the card that
   * floats at its passage, and the reader gets there the way a reader does: "Go to it". */
  const goToIt = async (host: any) => {
    q(host, ".glosa-ask-notice-go").click();
    await paint();
  };
  const atPassage = (host: any): any => q(host, ".glosa-ask-layer .glosa-agent-card");

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

  test("a question brackets its block in the gutter and washes exactly its words, under its own key", async () => {
    const hl = installHighlights();
    try {
      const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
      // The block, in its own layer: a `[` in the gutter, an open path, never a box around text.
      expect(qa(host, ".glosa-session-marks .glosa-session-bracket").length).toBe(1);
      const bracket = q(host, ".glosa-session-bracket");
      expect(bracket.getAttribute("data-entries")).toBe("inb-1");
      expect(bracket.getAttribute("data-kind")).toBe("question");
      expect(bracket.getAttribute("d")).toMatch(/^M[\d.-]+,[\d.-]+H[\d.-]+V[\d.-]+H[\d.-]+$/);
      // The words, exactly, under the session's key. Never the hand's: a session's mark taking the
      // human's key would make the two indistinguishable (#308's rejected alternative).
      expect(hl.words("glosa-session-asks", host)).toEqual(["the premise that readers accept the frame"]);
      expect(hl.words("glosa-session-points", host)).toEqual([]);
      expect(hl.words("glosa-anchors", host)).toEqual([]);
      // Not by colour alone: the question's mark names its author in words, and has a tab.
      expect(q(host, ".glosa-session-by").textContent).toBe("Claude Code asks");
      expect(q(host, ".glosa-session-tab").getAttribute("aria-label")).toContain("Question from Claude Code");
    } finally {
      hl.restore();
    }
  });

  test("Edit withdraws a session's words and bracket, and Review brings them back", async () => {
    const hl = installHighlights();
    try {
      const { host, pane } = await mountPane(fakeDataAccess([askAboutPremise()]));
      pane.setMode("edit");
      await paint();
      expect(qa(host, ".glosa-session-bracket").length).toBe(0);
      expect(hl.words("glosa-session-asks", host)).toEqual([]);
      pane.setMode("review");
      await paint();
      expect(qa(host, ".glosa-session-bracket").length).toBe(1);
      expect(hl.words("glosa-session-asks", host)).toEqual(["the premise that readers accept the frame"]);
    } finally {
      hl.restore();
    }
  });

  test("hovering a request's card deepens its words, and leaving lets them go", async () => {
    const hl = installHighlights();
    try {
      // A pointer's card is the whole card at every width (a question's tray row only sends the
      // reader to the passage), so it is the card whose thread this exercises.
      const { host } = await mountPane(fakeDataAccess([askAboutPremise({ message: null, action: "point" })]));
      const card = q(host, ".glosa-agent-card");
      expect(hl.words("glosa-session-lit", host)).toEqual([]);
      card.dispatchEvent(new dom.window.Event("mouseenter"));
      expect(hl.words("glosa-session-lit", host)).toEqual(["the premise that readers accept the frame"]);
      expect(q(host, ".glosa-session-bracket").hasAttribute("data-hover")).toBe(true);
      card.dispatchEvent(new dom.window.Event("mouseleave"));
      expect(hl.words("glosa-session-lit", host)).toEqual([]);
      expect(q(host, ".glosa-session-bracket").hasAttribute("data-hover")).toBe(false);
    } finally {
      hl.restore();
    }
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

  test("a quote that occurs nowhere in the text is marked lost, and paints no mark", async () => {
    const { host } = await mountPane(
      fakeDataAccess([askAboutPremise({ passage: { quote: { exact: "a sentence deleted last week" } } })]),
    );
    expect(q(host, ".glosa-agent-lost")).toBeTruthy();
    expect(qa(host, ".glosa-session-bracket").length).toBe(0);
    expect(qa(host, ".glosa-session-tab").length).toBe(0);
    // The card stays: the question is still real even when its anchor is not.
    expect(q(host, ".glosa-agent-card")).toBeTruthy();
  });

  test("the free-text field is present even when the session offered options", async () => {
    const { host } = await mountPane(
      fakeDataAccess([askAboutPremise({ answer_options: ["covered", "thin", "missing"] })]),
    );
    await goToIt(host);
    expect(qa(host, ".glosa-agent-option").length).toBe(3);
    // The escape hatch is glosa's guarantee. A session supplies its own words; it never gets to
    // close the reviewer's.
    expect(q(host, ".glosa-agent-input")).toBeTruthy();
  });

  test("answering sends the typed words and the chosen option together", async () => {
    const da = fakeDataAccess([askAboutPremise({ answer_options: ["covered", "thin"] })]);
    const { host } = await mountPane(da);
    await goToIt(host);
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
    await goToIt(host);
    q(atPassage(host), ".glosa-agent-actions .glosa-secondary-button").click();
    await paint();
    expect(da.answered).toHaveLength(1);
    expect(da.answered[0]!.response).toBe("");
    expect(da.answered[0]!.chose).toBeUndefined();
  });

  test("a half-typed answer survives the rail being rebuilt by unrelated session activity", async () => {
    // The rail repaints on every journal event, including ones caused by a different session
    // entirely. An answer held only in the card's DOM would be silently erased mid-sentence —
    // the same class of loss parking exists to prevent, one surface over.
    const da = fakeDataAccess([askAboutPremise({ answer_options: ["covered", "thin"] })]);
    const { host, pane } = await mountPane(da);
    await goToIt(host);

    qa(host, ".glosa-agent-option input")[1].click();
    const input = q(host, ".glosa-agent-input");
    input.value = "Half an answer";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    pane.refreshAgentRequests();
    await paint();

    expect(q(host, ".glosa-agent-input").value).toBe("Half an answer");
    expect(qa(host, ".glosa-agent-option input")[1].checked).toBe(true);
  });

  test("answering a question completes it without asserting a verdict nobody gave", async () => {
    // `approved` and `changes_requested` are review verdicts. Neither is true of "the human
    // answered a question", so an ask completes as `done`.
    const da = fakeDataAccess([askAboutPremise({ action: "ask" })]);
    const { host } = await mountPane(da);
    await goToIt(host);
    q(host, ".glosa-agent-input").value = "Yes, that reads fine.";
    q(host, ".glosa-agent-actions .glosa-primary-button").click();
    await paint();
    expect(da.answered[0]).toMatchObject({ outcome: "done", response: "Yes, that reads fine." });
  });

  test("a pointer with no question still marks the passage", async () => {
    const hl = installHighlights();
    try {
      const { host } = await mountPane(fakeDataAccess([askAboutPremise({ message: null, action: "point" })]));
      expect(qa(host, ".glosa-session-bracket").length).toBe(1);
      // A pointer does not hold its session, so it is quieter on every channel: a dotted rule under
      // its words instead of the wash, no printed label, and never a notice.
      expect(q(host, ".glosa-session-bracket").getAttribute("data-kind")).toBe("pointer");
      expect(hl.words("glosa-session-points", host)).toEqual(["the premise that readers accept the frame"]);
      expect(hl.words("glosa-session-asks", host)).toEqual([]);
      expect(q(host, ".glosa-session-by")).toBeNull();
      expect(q(host, ".glosa-ask-notice").hidden).toBe(true);
      expect(q(host, ".glosa-agent-message")).toBeNull();
    } finally {
      hl.restore();
    }
  });

  test("the mark's tab is a real button: the keyboard reaches the question from the passage", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
    const tab = q(host, ".glosa-session-tab");
    expect(tab.tagName).toBe("BUTTON");
    tab.click();
    await paint();
    // Activation puts the reader ON this request: its bracket is the focused one, and its card is
    // the one floating at the passage.
    expect(q(host, ".glosa-session-bracket").getAttribute("data-focused")).toBe("true");
    expect(atPassage(host).getAttribute("data-entry")).toBe("inb-1");
  });

  test("the pointer's quote is still a keyboard route to its passage", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise({ message: null, action: "point" })]));
    const quote = q(host, ".glosa-agent-quote");
    expect(quote.getAttribute("role")).toBe("button");
    expect(quote.tabIndex).toBe(0);
    quote.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await paint();
    expect(q(host, ".glosa-session-bracket").getAttribute("data-focused")).toBe("true");
  });

  describe("#308 — the reader is told where, and never moved", () => {
    /** happy-dom lays nothing out: every rect is zero, so every passage reads as off screen. That
     * is the right default for most of these tests (it is the reported case). The two that need
     * the reader to ARRIVE somewhere give the engine a pane 800px tall with the passage inside it.
     * The real geometry is settled in test/acceptance/agent-question-real-engine.test.ts. */
    const putPassageOnScreen = () => {
      const rect = (top: number, bottom: number) => ({
        top,
        bottom,
        left: 0,
        right: 600,
        width: 600,
        height: bottom - top,
        x: 0,
        y: top,
      });
      dom.window.Element.prototype.getBoundingClientRect = () => rect(0, 800) as any;
      dom.window.Range.prototype.getBoundingClientRect = () => rect(200, 224) as any;
    };

    test("questions already waiting on the first load get the notice — the case that used to get nothing", async () => {
      const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
      const notice = q(host, ".glosa-ask-notice");
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain("Claude Code is asking about a passage");
      expect(q(notice, ".glosa-ask-notice-go").textContent).toBe("Go to it");
    });

    test("an arriving question does not switch the mode or move the page; it raises the notice", async () => {
      const da = fakeDataAccess([]);
      const { host, pane } = await mountPane(da, { initialMode: "read" });
      const main = q(host, ".glosa-pane-main");
      main.scrollTop = 0;
      da.attention = [askAboutPremise()];
      pane.refreshAgentRequests({ arrived: ["inb-1"] });
      await paint();
      expect(pane.getMode()).toBe("read");
      expect(main.scrollTop).toBe(0);
      expect(q(host, ".glosa-ask-notice").hidden).toBe(false);
      // The arrival draws its mark in once; that is the whole of what an arrival does to the page.
      expect(q(host, ".glosa-session-bracket").getAttribute("data-arrived")).toBe("true");
      expect(q(host, ".glosa-session-tab").getAttribute("data-arrived")).toBe("true");
    });

    test("'Go to it' is what opens Review and the card, and it leaves a way back", async () => {
      putPassageOnScreen();
      const { host, pane } = await mountPane(fakeDataAccess([askAboutPremise()]), { initialMode: "read" });
      // On screen, but in Read there is no card anywhere, so the question still is not beside its
      // words and the notice still stands.
      expect(atPassage(host)).toBeNull();
      await goToIt(host);
      expect(pane.getMode()).toBe("review");
      expect(atPassage(host)).toBeTruthy();
      // On the question now, so it no longer needs announcing; what the notice owes is the return.
      expect(q(host, ".glosa-ask-notice-go")).toBeNull();
      expect(q(host, ".glosa-ask-notice-back").textContent).toBe("Back to where you were");
      q(host, ".glosa-ask-notice-back").click();
      await paint();
      expect(q(host, ".glosa-ask-notice").hidden).toBe(true);
    });

    test("with several open the oldest is offered first, and says how many there are", async () => {
      const older = askAboutPremise({ id: "inb-1", created_at: "2026-09-05T10:00:00Z" });
      const newer = askAboutPremise({ id: "inb-2", created_at: "2026-09-05T10:00:05Z", message: "And this?" });
      putPassageOnScreen();
      const { host } = await mountPane(fakeDataAccess([newer, older]));
      expect(q(host, ".glosa-ask-notice-count").textContent).toBe("1 of 2");
      await goToIt(host);
      expect(atPassage(host).getAttribute("data-entry")).toBe("inb-1");
      // The second question is still not beside its words, so it is the one now offered.
      expect(q(host, ".glosa-ask-notice-count").textContent).toBe("2 of 2");
    });

    test("two questions in one block share its bracket, and each keeps a tab of its own", async () => {
      const older = askAboutPremise({ id: "inb-1", created_at: "2026-09-05T10:00:00Z" });
      const newer = askAboutPremise({ id: "inb-2", created_at: "2026-09-05T10:00:05Z" });
      const { host } = await mountPane(fakeDataAccess([newer, older]));
      // One paragraph asked about twice is still one paragraph: one bracket, one author label.
      const brackets = qa(host, ".glosa-session-bracket");
      expect(brackets.map((b) => b.getAttribute("data-entries"))).toEqual(["inb-1 inb-2"]);
      expect(qa(host, ".glosa-session-by").length).toBe(1);
      // Two tabs, oldest first, and never on top of each other: both words start on the same line,
      // so the newer tab is pushed below the older one rather than hidden under it.
      const tabs = qa(host, ".glosa-session-tab");
      expect(tabs.map((t) => t.getAttribute("data-entry"))).toEqual(["inb-1", "inb-2"]);
      expect(Number.parseFloat(tabs[1].style.top) - Number.parseFloat(tabs[0].style.top)).toBeGreaterThanOrEqual(24);
    });

    test("dismissing the notice waves away the notice, not the question", async () => {
      const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
      q(host, ".glosa-ask-notice-dismiss").click();
      await paint();
      expect(q(host, ".glosa-ask-notice").hidden).toBe(true);
      expect(qa(host, ".glosa-session-bracket").length).toBe(1);
      expect(q(host, ".glosa-tray-count").textContent).toBe("1 question");
    });

    test("a passage that cannot be located is never offered as somewhere to go", async () => {
      const { host } = await mountPane(
        fakeDataAccess([askAboutPremise({ passage: { quote: { exact: "a sentence deleted last week" } } })]),
      );
      const notice = q(host, ".glosa-ask-notice");
      expect(notice.textContent).toContain("could not be located");
      expect(q(notice, ".glosa-ask-notice-go").textContent).toBe("Show the question");
    });

    test("a question about an artifact nobody has open is offered by the active pane, by file name", async () => {
      const elsewhere: unknown[] = [];
      const { host } = await mountPane(fakeDataAccess([askAboutPremise({ target_path: "drafts/elsewhere.md" })]), {
        isArtifactOpen: () => false,
        goToRequestElsewhere: async (request: unknown) => {
          elsewhere.push(request);
          return true;
        },
      });
      expect(q(host, ".glosa-ask-notice").textContent).toContain("is asking about a passage in elsewhere.md");
      q(host, ".glosa-ask-notice-go").click();
      expect(elsewhere).toHaveLength(1);
    });

    test("…and is NOT offered when some pane already has that artifact open — that pane says it", async () => {
      const { host } = await mountPane(fakeDataAccess([askAboutPremise({ target_path: "elsewhere.md" })]), {
        isArtifactOpen: () => true,
      });
      expect(q(host, ".glosa-ask-notice").hidden).toBe(true);
    });

    test("Escape steps off the floating question without answering it", async () => {
      const da = fakeDataAccess([askAboutPremise()]);
      const { host } = await mountPane(da);
      await goToIt(host);
      atPassage(host).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await paint();
      expect(atPassage(host)).toBeNull();
      expect(da.answered).toHaveLength(0);
      expect(qa(host, ".glosa-session-bracket").length).toBe(1);
    });
  });

  test("an unanchored quote is NOT presented as somewhere you can be taken", async () => {
    const { host } = await mountPane(
      fakeDataAccess([askAboutPremise({ passage: { quote: { exact: "a sentence deleted last week" } } })]),
    );
    const quote = q(host, ".glosa-agent-quote");
    // No role, no tab stop: offering "go to this passage" for a passage that cannot be located
    // would be a control that does nothing.
    expect(quote.getAttribute("role")).toBeNull();
    expect(quote.tabIndex).not.toBe(0);
  });

  test("at compact widths a session's question is REACHABLE in the tray, not merely present in it", async () => {
    // Being appended to the tray is not enough. The tray counted annotations only, so a question
    // with no annotations beside it left the toggle disabled and the list collapsed: the card was
    // in the DOM and the reviewer could not get to it, while a turn sat blocked on the answer.
    // happy-dom reports zero widths, so this pane is below the rail floor and the tray is the
    // path actually exercised here.
    const { host } = await mountPane(fakeDataAccess([askAboutPremise()]));
    expect(qa(host, ".glosa-agent-card").length).toBe(1);

    const toggle = q(host, ".glosa-tray-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(false);
    expect(q(host, ".glosa-tray-count").textContent).toBe("1 question");
  });

  test("one session's question and pointer are counted as requests, not two sessions", async () => {
    const requests = [
      askAboutPremise(),
      askAboutPremise({
        id: "inb-2",
        created_at: "2026-09-05T10:00:01Z",
        message: null,
        action: "point",
      }),
    ];
    const da = fakeDataAccess(requests, {
      async getAnnotations() {
        return {
          annotations: Array.from({ length: 5 }, (_, index) => ({
            id: `inb-note-${index}`,
            artifact_path: "notes.md",
            body: `note ${index}`,
            intent: "content",
            target: { quote: { exact: "readers accept" } },
            status: "pending",
          })),
        };
      },
    });

    const { host } = await mountPane(da);
    expect(q(host, ".glosa-tray-count").textContent).toBe("1 question · 1 pointer · 5 annotations");
    expect(q(host, ".glosa-tray-list .glosa-margin-subhead").textContent).toBe("1 question · 1 pointer");
  });

  test("the tray names both kinds when the margin holds both", async () => {
    const da = fakeDataAccess([askAboutPremise()], {
      async getAnnotations() {
        return {
          annotations: [
            {
              id: "inb-9",
              artifact_path: "notes.md",
              body: "my own note",
              intent: "content",
              target: { quote: { exact: "readers accept" } },
              status: "pending",
            },
          ],
        };
      },
    });
    const { host } = await mountPane(da);
    expect(q(host, ".glosa-tray-count").textContent).toBe("1 question · 1 annotation");
  });

  test("a request for another artifact never appears in this pane's rail", async () => {
    const { host } = await mountPane(fakeDataAccess([askAboutPremise({ target_path: "elsewhere.md" })]));
    expect(q(host, ".glosa-agent-card")).toBeNull();
    expect(qa(host, ".glosa-session-bracket").length).toBe(0);
  });

  describe("unsaved work survives the switch the agent causes", () => {
    test("an Edit draft is still there after Review and back — nothing is discarded, nothing is asked", async () => {
      const da = fakeDataAccess([]);
      const { host, pane } = await mountPane(da, { initialMode: "edit" });
      // The draft lives in the full-page source editor, which Edit no longer opens on — it is a
      // tool in More now, and the writer asks for it.
      editSource(host).click();
      await paint();

      const editor = q(host, ".glosa-edit-area");
      editor.value = "# Konspekt\n\nA paragraph I was halfway through writing.";
      editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flush();

      // Exactly what an arriving question does to the pane.
      pane.setMode("review");
      await paint();
      // No dialog: parking removed the only reason to ask.
      expect(q(dom.document.body, "dialog[open]")).toBeNull();
      // "Your unsaved work is still here" is said by the control that takes the reader back to it,
      // which with the two-mode control is Edit again rather than the notes toggle that carried it
      // while there was no Edit button to carry it.
      expect(q(host, '.glosa-modebar [data-control="edit"]').getAttribute("data-parked")).toBe("true");
      expect(editSource(host).getAttribute("aria-label")).toContain("unsaved draft kept");

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
      expect(q(host, '.glosa-modebar [data-control="notes"]').getAttribute("data-parked")).toBeNull();
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
