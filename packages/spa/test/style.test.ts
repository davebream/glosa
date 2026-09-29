// SPDX-License-Identifier: Apache-2.0
// A document's style (#407) is its typographic dress: Editorial, Spec or Mono. These pin what a
// happy-path click would not: which style wins (the document's own, then the folder's default,
// then Editorial), that choosing Editorial is a choice of its own, that a face stored before
// styles existed carries over, that storage and daemon failures never block a page-local choice,
// and that the menu rows say which style applies and whether a folder default is behind it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  STYLE_STORAGE_PREFIX,
  STYLES,
  createStyleStore,
  mountStyleControl,
  readStyle,
  resolveStyle,
  styleKey,
} from "../src/style.js";
import { type DomEnv, installDom } from "./dom-env.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage & { map: Map<string, string> };
}

/** A daemon's folder defaults, in memory, answering the way data-access.js does. */
function fakeFolders(initial: Record<string, string | null> = {}) {
  const folders = new Map(Object.entries(initial));
  const saved: Array<[string, string]> = [];
  let failNextSave = false;
  return {
    folders,
    saved,
    failNextSave: () => {
      failNextSave = true;
    },
    loadFolderStyle: async (slug: string) => ({ style: folders.get(slug) ?? null }),
    saveFolderStyle: async (slug: string, style: string) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("daemon unavailable");
      }
      folders.set(slug, style);
      saved.push([slug, style]);
      return { style };
    },
  };
}

describe("which style a document is set in", () => {
  test("folder rename carries closed document styles and repeated events do not erase them", () => {
    const storage = fakeStorage({
      [styleKey("ws", "drafts/closed.md")]: "spec",
      [styleKey("other", "drafts/closed.md")]: "mono",
    });
    const store = createStyleStore({ storage });
    store.choose("ws", "drafts/open.md", "mono");
    store.rename("ws", "drafts", "ideas");
    store.rename("ws", "drafts", "ideas");
    expect(store.get("ws", "ideas/closed.md").style).toBe("spec");
    expect(store.get("ws", "ideas/open.md").style).toBe("mono");
    expect(store.get("ws", "drafts/open.md").own).toBeNull();
    expect(store.get("other", "drafts/closed.md").style).toBe("mono");
  });

  test("the document's own choice, then the folder's default, then Editorial", () => {
    expect(resolveStyle(null, null)).toEqual({ style: "editorial", source: "default" });
    expect(resolveStyle(null, "spec")).toEqual({ style: "spec", source: "folder" });
    expect(resolveStyle("mono", "spec")).toEqual({ style: "mono", source: "document" });
    // An explicit Editorial is a choice: it holds in a folder whose default is Spec.
    expect(resolveStyle("editorial", "spec")).toEqual({ style: "editorial", source: "document" });
    expect(resolveStyle("gothic", "nonsense")).toEqual({ style: "editorial", source: "default" });
  });

  test("a face stored before styles carries over: sans is Spec, mono is Mono, serif is Editorial", () => {
    const key = styleKey("ws", "a.md");
    expect(key).toBe(`${STYLE_STORAGE_PREFIX}ws:a.md`);
    expect(readStyle(fakeStorage({ [key]: "sans" }), key)).toBe("spec");
    expect(readStyle(fakeStorage({ [key]: "mono" }), key)).toBe("mono");
    expect(readStyle(fakeStorage({ [key]: "serif" }), key)).toBe("editorial");
    // Choosing Default removed the key, so nothing stored means never chosen: follow the folder.
    expect(readStyle(fakeStorage(), key)).toBeNull();
    expect(readStyle(fakeStorage({ [key]: "default" }), key)).toBeNull();
    expect(readStyle(fakeStorage({ [key]: "gothic" }), key)).toBeNull();
  });

  test("a document with a carried-over sans stays Spec in an Editorial folder; one with nothing follows a Spec folder", async () => {
    const storage = fakeStorage({ [styleKey("ws", "old.md")]: "sans", [styleKey("ws", "mono.md")]: "mono" });
    const daemon = fakeFolders({ ws: "spec", other: "editorial" });
    const store = createStyleStore({ storage, ...daemon });
    await store.loadFolder("ws");
    await store.loadFolder("other");
    expect(store.get("ws", "new.md")).toMatchObject({ style: "spec", source: "folder" });
    expect(store.get("ws", "mono.md")).toMatchObject({ style: "mono", source: "document" });
    storage.map.set(styleKey("other", "old.md"), "sans");
    expect(store.get("other", "old.md")).toMatchObject({ style: "spec", source: "document" });
    expect(store.get("other", "new.md")).toMatchObject({ style: "editorial", source: "folder" });
  });

  test("choosing Editorial in a Spec folder is stored; choosing the folder's own style goes back to following it", async () => {
    const storage = fakeStorage();
    const store = createStyleStore({ storage, ...fakeFolders({ ws: "spec" }) });
    await store.loadFolder("ws");
    const key = styleKey("ws", "a.md");

    store.choose("ws", "a.md", "editorial");
    expect(storage.map.get(key)).toBe("editorial");
    expect(store.get("ws", "a.md")).toMatchObject({ style: "editorial", source: "document", folder: "spec" });

    store.choose("ws", "a.md", "spec");
    expect(storage.map.has(key)).toBe(false);
    expect(store.get("ws", "a.md")).toMatchObject({ style: "spec", source: "folder" });
    expect(() => store.choose("ws", "a.md", "gothic")).toThrow(TypeError);
  });

  test("without a folder default every choice is the document's own, Editorial included", () => {
    const storage = fakeStorage();
    const store = createStyleStore({ storage });
    store.choose("ws", "a.md", "editorial");
    expect(storage.map.get(styleKey("ws", "a.md"))).toBe("editorial");
    expect(store.get("ws", "a.md").source).toBe("document");
  });

  test("using a document's style as the folder default stores it in the daemon and every following document takes it", async () => {
    const daemon = fakeFolders();
    const storage = fakeStorage();
    const store = createStyleStore({ storage, ...daemon });
    await store.loadFolder("ws");
    const seen: string[] = [];
    store.subscribe("ws", "b.md", (state) => seen.push(`${state.style}/${state.source}`));
    store.choose("ws", "a.md", "spec");

    expect(await store.useAsFolderDefault("ws", "a.md")).toBe("spec");
    expect(daemon.saved).toEqual([["ws", "spec"]]);
    // a.md now follows the folder it set, like b.md, which never chose.
    expect(storage.map.has(styleKey("ws", "a.md"))).toBe(false);
    expect(store.get("ws", "a.md")).toMatchObject({ style: "spec", source: "folder" });
    expect(seen).toEqual(["editorial/default", "spec/folder"]);
  });

  test("a folder default the daemon could not store changes nothing on the page", async () => {
    const daemon = fakeFolders({ ws: "mono" });
    const storage = fakeStorage();
    const store = createStyleStore({ storage, ...daemon });
    await store.loadFolder("ws");
    store.choose("ws", "a.md", "spec");
    daemon.failNextSave();
    await expect(store.useAsFolderDefault("ws", "a.md")).rejects.toThrow("daemon unavailable");
    expect(store.get("ws", "a.md")).toMatchObject({ style: "spec", source: "document", folder: "mono" });
    expect(store.get("ws", "b.md")).toMatchObject({ style: "mono", source: "folder" });
  });

  test("a style chosen while the folder default is being saved is kept", async () => {
    let finish: (value: { style: string }) => void = () => {};
    const storage = fakeStorage();
    const store = createStyleStore({
      storage,
      loadFolderStyle: async () => ({ style: null }),
      saveFolderStyle: () => new Promise((resolve) => (finish = resolve)),
    });
    await store.loadFolder("ws");
    store.choose("ws", "a.md", "spec");
    const saving = store.useAsFolderDefault("ws", "a.md");
    store.choose("ws", "a.md", "mono");
    finish({ style: "spec" });
    await saving;
    expect(storage.map.get(styleKey("ws", "a.md"))).toBe("mono");
    expect(store.get("ws", "a.md")).toMatchObject({ style: "mono", source: "document", folder: "spec" });
  });

  test("another window's default that lands after this one's save is the one the page keeps", async () => {
    let daemonStyle: string | null = null;
    let finish: () => void = () => {};
    const store = createStyleStore({
      storage: fakeStorage(),
      loadFolderStyle: async () => ({ style: daemonStyle }),
      saveFolderStyle: (_slug: string, style: string) =>
        new Promise((resolve) => {
          finish = () => {
            daemonStyle = style;
            resolve({ style });
          };
        }),
    });
    await store.loadFolder("ws");
    store.choose("ws", "a.md", "spec");
    const saving = store.useAsFolderDefault("ws", "a.md");
    finish(); // this window's Spec lands...
    daemonStyle = "mono"; // ...then another window's Mono, whose frame asks for a read
    const read = store.loadFolder("ws");
    await saving;
    await read;
    await Bun.sleep(0);
    expect(store.folder("ws")).toEqual({ style: "mono", available: true });
  });

  test("a folder default read again reaches every document of that folder, and a failed read keeps the last one", async () => {
    const daemon = fakeFolders({ ws: "spec" });
    const store = createStyleStore({ storage: fakeStorage(), ...daemon });
    await store.loadFolder("ws");
    const seen: string[] = [];
    store.subscribe("ws", "a.md", (state) => seen.push(state.style));
    store.subscribe("elsewhere", "a.md", (state) => seen.push(`elsewhere:${state.style}`));

    daemon.folders.set("ws", "mono"); // another window set it
    await store.loadFolder("ws");
    expect(seen).toEqual(["spec", "elsewhere:editorial", "mono"]);

    const failing = createStyleStore({
      storage: fakeStorage(),
      loadFolderStyle: async () => {
        throw new Error("down");
      },
    });
    expect(await failing.loadFolder("ws")).toEqual({ style: null, available: false });
  });

  test("a slow folder read never overwrites a newer one", async () => {
    const answers: Array<(value: { style: string }) => void> = [];
    const store = createStyleStore({
      storage: fakeStorage(),
      loadFolderStyle: () => new Promise((resolve) => answers.push(resolve)),
    });
    const older = store.loadFolder("ws");
    const newer = store.loadFolder("ws");
    answers[1]!({ style: "mono" });
    await newer;
    answers[0]!({ style: "spec" });
    await older;
    expect(store.folder("ws")).toEqual({ style: "mono", available: true });
  });

  test("storage failure still applies the style for this page", () => {
    const store = createStyleStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {},
      } as unknown as Storage,
    });
    const seen: string[] = [];
    store.subscribe("ws", "a.md", (state) => seen.push(state.style));
    store.choose("ws", "a.md", "mono");
    expect(store.get("ws", "a.md").style).toBe("mono");
    expect(seen).toEqual(["editorial", "mono"]);
  });
});

describe("mountStyleControl", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  function mount(store: ReturnType<typeof createStyleStore>, target: () => { slug: string; path: string } | null) {
    const applied: string[] = [];
    const results: Array<{ ok: boolean; style: string }> = [];
    let picks = 0;
    const element = dom.document.createElement("div");
    dom.document.body.append(element);
    const host = element as unknown as HTMLElement;
    const control = mountStyleControl(host, store, {
      getTarget: target,
      onChange: (style) => applied.push(style),
      onPick: () => {
        picks += 1;
      },
      onFolderResult: (result) => results.push(result),
    });
    const rows = () => Array.from(host.querySelectorAll('[role="menuitemradio"]')) as unknown as HTMLButtonElement[];
    const note = () => host.querySelector(".glosa-style-folder-note") as unknown as HTMLElement;
    const useAsDefault = () => host.querySelector(".glosa-style-folder") as unknown as HTMLButtonElement;
    const status = () => host.querySelector(".glosa-style-status") as unknown as HTMLElement;
    return { host, control, rows, note, useAsDefault, status, applied, results, picks: () => picks };
  }

  test("offers Style: Editorial (Serif), Spec (Sans) and Mono as radio rows, follows the pane's document, and reports picks", () => {
    const store = createStyleStore({ storage: fakeStorage({ [styleKey("ws", "b.md")]: "mono" }) });
    let target: { slug: string; path: string } | null = { slug: "ws", path: "a.md" };
    const ui = mount(store, () => target);
    expect(ui.host.getAttribute("aria-label")).toBe("Style");
    expect(ui.host.querySelector(".glosa-pane-menu-heading")?.textContent).toBe("Style");
    expect(ui.rows().map((r) => r.dataset.style)).toEqual([...STYLES]);
    expect(ui.rows().map((r) => r.textContent)).toEqual(["AaEditorial (Serif)", "AaSpec (Sans)", "AaMono"]);
    expect(ui.rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);

    ui.rows()[1]!.click();
    expect(store.get("ws", "a.md").style).toBe("spec");
    expect(ui.applied.at(-1)).toBe("spec");
    expect(ui.picks()).toBe(1);
    expect(ui.rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);

    target = { slug: "ws", path: "b.md" };
    ui.control.refresh();
    expect(ui.rows()[2]!.getAttribute("aria-checked")).toBe("true");
    expect(ui.applied.at(-1)).toBe("mono");

    target = null;
    ui.control.refresh();
    expect(ui.rows().every((r) => r.disabled)).toBe(true);
    expect(ui.useAsDefault().hidden).toBe(true);
    expect(ui.applied.at(-1)).toBe("editorial");
    ui.control.destroy();
    expect(ui.host.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  test("with no folder default it offers Use as folder default, and once used says Folder default: Spec", async () => {
    const daemon = fakeFolders();
    const store = createStyleStore({ storage: fakeStorage(), ...daemon });
    await store.loadFolder("ws");
    const ui = mount(store, () => ({ slug: "ws", path: "a.md" }));
    expect(ui.note().hidden).toBe(true);
    expect(ui.useAsDefault().hidden).toBe(false);
    expect(ui.useAsDefault().textContent).toBe("Use as folder default");

    ui.rows()[1]!.click();
    ui.useAsDefault().click();
    await Bun.sleep(0);
    expect(daemon.saved).toEqual([["ws", "spec"]]);
    expect(ui.results).toEqual([{ ok: true, style: "spec" }]);
    expect(ui.note().hidden).toBe(false);
    expect(ui.note().textContent).toBe("Folder default: Spec");
    // The document is set in its folder's default, so there is nothing left to use.
    expect(ui.useAsDefault().hidden).toBe(true);
    expect(ui.rows()[1]!.getAttribute("aria-checked")).toBe("true");
    // What happened is said in the group, after the note and the row that did it, as a live region.
    const children = Array.from(ui.host.children);
    expect(ui.status().getAttribute("role")).toBe("status");
    expect(ui.status().getAttribute("aria-live")).toBe("polite");
    expect({
      hidden: ui.status().hidden,
      text: ui.status().textContent,
      error: ui.status().hasAttribute("data-error"),
    }).toEqual({
      hidden: false,
      text: "Spec is now this folder's default.",
      error: false,
    });
    const at = (element: HTMLElement) => children.indexOf(element as unknown as Element);
    expect(at(ui.status())).toBeGreaterThan(at(ui.useAsDefault()));
    expect(at(ui.useAsDefault())).toBeGreaterThan(at(ui.note()));
    // Choosing a style again starts a new moment: the old result is gone.
    ui.rows()[2]!.click();
    expect(ui.status().hidden).toBe(true);
  });

  test("a document that chose otherwise in a Spec folder says so, and can set its own style as the default", async () => {
    const daemon = fakeFolders({ ws: "spec" });
    const store = createStyleStore({ storage: fakeStorage(), ...daemon });
    await store.loadFolder("ws");
    const ui = mount(store, () => ({ slug: "ws", path: "a.md" }));
    expect(ui.note().textContent).toBe("Folder default: Spec");
    expect(ui.useAsDefault().hidden).toBe(true);

    ui.rows()[0]!.click(); // Editorial, over the folder's Spec
    expect(ui.rows()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(ui.note().textContent).toBe("Folder default: Spec");
    expect(ui.useAsDefault().hidden).toBe(false);
    expect(ui.useAsDefault().title).toBe("Documents in this folder without a style of their own will use Editorial");

    daemon.failNextSave();
    ui.useAsDefault().click();
    // While the default is being written nothing in the group can be chosen.
    expect([...ui.rows(), ui.useAsDefault()].every((control) => control.disabled)).toBe(true);
    await Bun.sleep(0);
    expect(ui.results).toEqual([{ ok: false, style: "editorial" }]);
    expect({ text: ui.status().textContent, error: ui.status().hasAttribute("data-error") }).toEqual({
      text: "Couldn't set the folder default, so nothing changed. Try again.",
      error: true,
    });
    expect(ui.rows().some((row) => row.disabled)).toBe(false);
    expect(ui.note().textContent).toBe("Folder default: Spec");
    expect(ui.useAsDefault().hidden).toBe(false);
    expect(ui.useAsDefault().disabled).toBe(false);
  });

  test("where the daemon keeps no folder default the folder rows stand down", async () => {
    const store = createStyleStore({
      storage: fakeStorage(),
      loadFolderStyle: async () => {
        throw new Error("422 folder-style-not-directory");
      },
    });
    await store.loadFolder("loose");
    const ui = mount(store, () => ({ slug: "loose", path: "note.md" }));
    expect(ui.note().hidden).toBe(true);
    expect(ui.useAsDefault().hidden).toBe(true);
    expect(ui.control.controls().filter((c: HTMLElement) => !c.hidden)).toHaveLength(3);
  });

  test("the style chooser is a pane-menu group, not a control in the document bar", () => {
    const pane = readFileSync(new URL("../src/artifact-pane.js", import.meta.url), "utf8");
    const bar =
      pane.match(/const artifactBar = el\("div", \{ className: "glosa-artifact-bar" \}, \[([\s\S]*?)\]\);/)?.[1] ?? "";
    expect(bar).not.toContain("style");
    const menu = pane.match(/const toolsMenu = el\([\s\S]*?\[([\s\S]*?)\]\);/)?.[1] ?? "";
    expect(menu).toContain("styleGroup");
  });
});

describe("the style reaches the manuscript through its tokens", () => {
  test("app.css sets the manuscript from --font-manuscript, Editorial's at the root and each other style's on the pane", () => {
    const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.glosa-content\s*\{[^}]*font-family:\s*var\(--font-manuscript\)/);
    // Editorial is the serif at the root; only Spec and Mono replace it on a pane.
    expect(css).toMatch(/:root\s*\{[^}]*--font-manuscript:\s*var\(--font-serif\)/);
    expect(css).toMatch(/\.glosa-pane\[data-style="spec"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-sans\)/);
    expect(css).toMatch(/\.glosa-pane\[data-style="mono"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-mono\)/);
    // The rendered manuscript never names the serif directly: the document's style decides.
    expect(css).not.toMatch(/\.glosa-content\s*\{[^}]*var\(--font-serif\)/);
  });
});
