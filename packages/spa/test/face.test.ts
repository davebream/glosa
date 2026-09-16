// SPDX-License-Identifier: Apache-2.0
// The manuscript face is the writer's per-artifact reading preference (direction contract,
// packages/spa/.impeccable/surfaces/src-app-css.md). These pin the parts a happy-path click would
// not: the preference is scoped to one artifact, Default leaves nothing behind in storage, storage
// failure never blocks a page-local change, and the control follows the pane's artifact.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FACES, FACE_STORAGE_PREFIX, createFaceStore, faceKey, mountFaceControl, readFace } from "../src/face.js";
import { type DomEnv, installDom } from "./dom-env.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage & { map: Map<string, string> };
}

describe("face preference", () => {
  test("keys are scoped to workspace and artifact", () => {
    expect(faceKey("ws-1", "plans/a.md")).toBe(`${FACE_STORAGE_PREFIX}ws-1:plans/a.md`);
    expect(faceKey("ws-1", "plans/a.md")).not.toBe(faceKey("ws-2", "plans/a.md"));
  });

  test("missing, invalid or unreadable values fall back to Default, the serif", () => {
    expect(readFace(fakeStorage(), "k")).toBe("default");
    expect(readFace(fakeStorage({ k: "gothic" }), "k")).toBe("default");
    // A page chosen as "serif" before the serif became the default keeps its serif as Default.
    expect(readFace(fakeStorage({ k: "serif" }), "k")).toBe("default");
    expect(
      readFace(
        {
          getItem: () => {
            throw new Error("unavailable");
          },
        } as unknown as Storage,
        "k",
      ),
    ).toBe("default");
  });

  test("a chosen face persists per artifact and Default removes the entry", () => {
    const storage = fakeStorage();
    const store = createFaceStore({ storage });
    const a = faceKey("ws", "a.md");
    const b = faceKey("ws", "b.md");
    store.set(a, "sans");
    expect(store.get(a)).toBe("sans");
    expect(store.get(b)).toBe("default");
    expect(storage.map.get(a)).toBe("sans");
    store.set(a, "default");
    expect(storage.map.has(a)).toBe(false);
    expect(() => store.set(a, "gothic")).toThrow(TypeError);
  });

  test("storage failure still applies the face for this page", () => {
    const store = createFaceStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {},
      } as unknown as Storage,
    });
    const seen: string[] = [];
    store.subscribe("k", (face: string) => seen.push(face));
    store.set("k", "mono");
    expect(store.get("k")).toBe("mono");
    expect(seen).toEqual(["default", "mono"]);
  });
});

describe("mountFaceControl", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("offers exactly the three faces as menu radio rows, follows the pane's artifact, and reports picks", () => {
    const store = createFaceStore({ storage: fakeStorage({ [faceKey("ws", "b.md")]: "mono" }) });
    let key: string | null = faceKey("ws", "a.md");
    const applied: string[] = [];
    let picks = 0;
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    const control = mountFaceControl(host, store, {
      getKey: () => key,
      onChange: (face) => applied.push(face),
      onPick: () => {
        picks += 1;
      },
    });
    const rows = () => Array.from(host.querySelectorAll('[role="menuitemradio"]')) as unknown as HTMLButtonElement[];
    expect(host.getAttribute("aria-label")).toBe("Manuscript face");
    expect(rows().map((r) => r.dataset.face)).toEqual([...FACES]);
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);

    rows()[1]!.click();
    expect(store.get(key)).toBe("sans");
    expect(applied.at(-1)).toBe("sans");
    expect(picks).toBe(1);
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);

    key = faceKey("ws", "b.md");
    control.refresh();
    expect(rows()[2]!.getAttribute("aria-checked")).toBe("true");
    expect(applied.at(-1)).toBe("mono");

    key = null;
    control.refresh();
    expect(rows().every((r) => r.disabled)).toBe(true);
    expect(applied.at(-1)).toBe("default");
    control.destroy();
    expect(host.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  test("the face chooser is a pane-menu group, not a control in the artifact bar", () => {
    const pane = readFileSync(new URL("../src/artifact-pane.js", import.meta.url), "utf8");
    const bar =
      pane.match(/const artifactBar = el\("div", \{ className: "glosa-artifact-bar" \}, \[([\s\S]*?)\]\);/)?.[1] ?? "";
    expect(bar).not.toContain("face");
    const menu = pane.match(/const toolsMenu = el\([\s\S]*?\[([\s\S]*?)\]\);/)?.[1] ?? "";
    expect(menu).toContain("faceGroup");
  });
});

describe("the face reaches the manuscript through one variable", () => {
  test("app.css sets the manuscript from --font-manuscript and stamps it per pane", () => {
    const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.glosa-content\s*\{[^}]*font-family:\s*var\(--font-manuscript\)/);
    // Default is the serif: the root sets it, and only Sans and Mono are stamped on a pane.
    expect(css).toMatch(/:root\s*\{[^}]*--font-manuscript:\s*var\(--font-serif\)/);
    expect(css).toMatch(/\.glosa-pane\[data-face="sans"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-sans\)/);
    expect(css).toMatch(/\.glosa-pane\[data-face="mono"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-mono\)/);
    // The rendered manuscript never names the serif directly any more: the writer's face decides.
    expect(css).not.toMatch(/\.glosa-content\s*\{[^}]*var\(--font-serif\)/);
  });
});
