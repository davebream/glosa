// SPDX-License-Identifier: Apache-2.0
// contracts.md C4.1: the daemon's terminal set (`COMMON_TERMINALS`, packages/daemon/src/bus/
// lifecycle.ts) and the SPA's hand-duplicated copy — `isTerminalState`, `STATE_LABELS`, and the
// `[data-state=…]` rules in app.css — must agree at merge. They cannot literally share code
// (artifact-pane.js ships as plain JS straight to the browser with no build step, same reason
// sse-wire-compat.test.ts can't share sse.ts's encoder with data-access.js), so this is what
// actually proves they still agree: it imports the daemon's own set and iterates it, rather than
// re-spelling the four values by hand — a hand-copy would be the third duplicate this exists to
// prevent, and it would stay silent on a future fifth terminal.
//
// Every value in the set must be true of, checked structurally against the real source text so a
// match elsewhere in the file (a comment, an unrelated string) can't produce a false pass:
//   1. `isTerminalState` names it, and `STATE_LABELS` has a key for it.
//   2. `app.css` styles it — at least one `.glosa-annotation[data-state=…]` rule exists. Not every
//      terminal shares the SAME rule shape (`applied` gets its own dot/text-color treatment via
//      theme-adaptive custom properties and needs no explicit dark override; `rejected`/`stale`
//      share a whole-card opacity rule that DOES need one, for contrast reasons app.css itself
//      documents), so "styled at all" is the invariant every value actually owes, and a dedicated
//      test below pins `dismissed` to the exact block Task 11 puts it in.
// Plus one behavioral check: a card in that state is actually sorted into the resolved bucket and
// offered no Edit — `item.state` is the wire status verbatim (pending -> waiting aside), so an
// unhandled state reaching the pane is not a theoretical gap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMON_TERMINALS } from "../../daemon/src/bus/lifecycle.ts";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

const paneSource = read("../src/artifact-pane.js");
const cssSource = read("../src/app.css");

// Isolated to the actual function/object bodies, not the whole file, so a fixture that merely
// APPEARS in a comment or docstring elsewhere can't produce a false pass.
const isTerminalStateBody = paneSource.match(/const isTerminalState = \(state\) =>\s*([\s\S]*?);/)?.[1];
const stateLabelsBody = paneSource.match(/const STATE_LABELS = \{([\s\S]*?)\};/)?.[1];

describe("the SPA's terminal-state vocabulary agrees with the daemon's (contracts.md C4.1)", () => {
  test("the fixtures actually match something — a guard that matches nothing passes forever", () => {
    expect(isTerminalStateBody).toBeTruthy();
    expect(stateLabelsBody).toBeTruthy();
    // COMMON_TERMINALS itself isn't empty, or every test below would vacuously pass.
    expect(COMMON_TERMINALS.size).toBeGreaterThan(0);
  });

  for (const value of COMMON_TERMINALS) {
    test(`"${value}": isTerminalState names it, STATE_LABELS has a key, app.css styles it`, () => {
      expect(isTerminalStateBody).toContain(`state === "${value}"`);
      expect(stateLabelsBody).toMatch(new RegExp(`(^|[\\s{,])${value}:`));
      expect(cssSource).toContain(`.glosa-annotation[data-state="${value}"]`);
    });
  }

  // Task 11's specific claim: `dismissed` joins `rejected`/`stale` in the SAME whole-card opacity
  // rule, in both the light block (app.css ~:3345) and its dark-mode contrast override (~:3792) —
  // not just "styled somewhere", which the generic loop above already covers for every value.
  test('"dismissed" sits in the same opacity block as "rejected"/"stale", light and dark', () => {
    expect(cssSource).toContain(
      '.glosa-annotation[data-state="rejected"],\n.glosa-annotation[data-state="stale"],\n.glosa-annotation[data-state="dismissed"] {\n  opacity: 0.75;\n}',
    );
    expect(cssSource).toContain(
      ':root[data-theme="dark"] .glosa-annotation[data-state="rejected"],\n:root[data-theme="dark"] .glosa-annotation[data-state="stale"],\n:root[data-theme="dark"] .glosa-annotation[data-state="dismissed"] {',
    );
  });
});

describe("a card in a daemon terminal state is treated as resolved", () => {
  let dom: DomEnv;

  const flush = async (n = 10) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const paint = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  };

  const q = (root: any, selector: string): any => root.querySelector(selector);

  const RENDERED = `<h1>Konspekt</h1><p id="para">Alpha beta gamma delta epsilon zeta.</p>`;
  const PLAIN = "KonspektAlpha beta gamma delta epsilon zeta.";

  function targetFor(word: string) {
    const start = PLAIN.indexOf(word);
    expect(start).toBeGreaterThan(-1);
    return { quote: { exact: word }, position: { start, end: start + word.length } };
  }

  function fakeDataAccess(row: Record<string, unknown>) {
    return {
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
      async getAnnotations() {
        return { annotations: [row] };
      },
      async postAnnotation() {
        throw new Error("not exercised by this test");
      },
      async withdrawAnnotation() {
        throw new Error("not exercised by this test");
      },
      async getCheckpoints() {
        return [];
      },
      async restore() {
        return { ok: true };
      },
    };
  }

  async function mountPane(da: ReturnType<typeof fakeDataAccess>) {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "review",
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  for (const value of COMMON_TERMINALS) {
    test(`"${value}" — no Edit offered, sorted under Resolved, and the label isn't the raw wire word`, async () => {
      const da = fakeDataAccess({
        id: "inb-1",
        status: value,
        artifact_path: "notes.md",
        body: "a note",
        intent: "content",
        target: targetFor("gamma"),
        attempts: 0,
      });
      const { host } = await mountPane(da);

      const card = q(host, ".glosa-annotation");
      expect(card).not.toBeNull();
      expect(card.getAttribute("data-state")).toBe(value);

      // No Edit: the journal is append-only, so a terminal entry has nothing left to revise.
      expect(card.querySelector(".glosa-annotation-edit")).toBeNull();

      // Sorted into the resolved bucket, under its own heading — never mixed with open work.
      expect(q(host, ".glosa-margin-subhead")?.textContent).toBe("Resolved");

      // If STATE_LABELS were missing a key for this value, the `?? state` fallback at the
      // label's render site would print the raw machine word verbatim.
      const labelText = card.querySelector(".glosa-annotation-state")?.textContent ?? "";
      expect(labelText.startsWith(value)).toBe(false);
    });
  }
});
