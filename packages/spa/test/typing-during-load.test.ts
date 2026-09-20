// SPDX-License-Identifier: Apache-2.0
// Typing while the pane is still finishing its load.
//
// `loadArtifact` fills the editor face as soon as the artifact arrives, then awaits annotation
// hydration and renders again. That second render re-read the file into the face, so anything
// typed in between was overwritten with no notice — the writer watched their own keystrokes
// disappear. The window is invisible when everything is fast and widens with a slow answer, which
// is why it surfaced as an intermittent failure rather than a report.
//
// The mistakes a fix can make, each one a test below:
//
//   * Protecting the face forever. Once the draft is saved the face must follow the file again —
//     the second test below.
//
// The guard is keyed to the artifact's path rather than to `modeState.dirty` alone, because that
// flag survives opening a different artifact in the same pane (see the note above `setBaseline`).
// A pane loads one artifact and the workbench replaces the whole pane to show another, so that
// case cannot be reached from here; the key costs nothing and keeps the flag from outliving the
// file it describes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("typing while the artifact is still loading", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  const flush = async (n = 20) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const paint = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  };
  const q = (root: any, selector: string): any => root.querySelector(selector);

  const NOTES = "# Notes\n\nA paragraph the writer opened.\n";
  const NOTES_HTML = '<h1 data-line="0">Notes</h1><p data-line="2">A paragraph the writer opened.</p>';

  /** `getAnnotations` is held open, which is the window `loadArtifact` leaves between filling the
   * face and its second render. Tests decide when it answers. */
  function fakeDataAccess() {
    let release: (() => void) | null = null;
    return {
      saved: [] as string[],
      hold: false,
      releaseAnnotations() {
        release?.();
        release = null;
      },
      async getArtifact(_slug: string, path: string) {
        return {
          source_path: path,
          content: NOTES,
          rendered_html: NOTES_HTML,
          source_sha256: "sha-notes",
          rendered_sha256: "r-notes",
          class: "R",
        };
      },
      async getAnnotations() {
        if (this.hold) await new Promise<void>((resolve) => (release = resolve));
        return { annotations: [] };
      },
      async getCheckpoints() {
        return [];
      },
      async putArtifact(_slug: string, _path: string, content: string) {
        this.saved.push(content);
        return { source_sha256: "sha-written" };
      },
    };
  }

  async function mountPane(da: any, path = "notes.md") {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path,
      initialMode: "edit",
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
    });
    return { host, pane };
  }

  /** The full-page source editor, opened through the real More item a writer uses. */
  const openSourceFace = async (host: any) => {
    q(host, ".glosa-tools-edit-source")?.click();
    await paint();
    q(host, ".glosa-face-source")?.click();
    await paint();
  };

  const typeInto = (host: any, text: string) => {
    const area = q(host, ".glosa-edit-area");
    expect(area).toBeTruthy();
    area.value = text;
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };

  test("a sentence typed before the load finishes is still there afterwards", async () => {
    const da = fakeDataAccess();
    da.hold = true;
    const { host, pane } = await mountPane(da);
    await paint();
    await openSourceFace(host);
    expect(q(host, ".glosa-edit-area").value).toBe(NOTES);

    // The window: the artifact has arrived and filled the face, annotations have not answered yet.
    typeInto(host, `${NOTES}A sentence typed while the pane was still loading.\n`);

    da.releaseAnnotations();
    await pane.ready;
    await paint();

    expect(q(host, ".glosa-edit-area").value).toContain("A sentence typed while the pane was still loading.");
  });

  test("once the draft is saved the face follows the file again", async () => {
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await pane.ready;
    await paint();
    await openSourceFace(host);
    typeInto(host, `${NOTES}Saved text.\n`);
    q(host, ".glosa-save")?.click();
    await paint();
    expect(da.saved.at(-1)).toContain("Saved text.");

    await pane.refreshArtifact();
    await paint();

    // The pane's own read of the file, unchanged in the fake, is what a clean face must show.
    expect(q(host, ".glosa-edit-area").value).toBe(NOTES);
  });
});
