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

  test("missing, invalid or unreadable values default to the sans", () => {
    expect(readFace(fakeStorage(), "k")).toBe("default");
    expect(readFace(fakeStorage({ k: "gothic" }), "k")).toBe("default");
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
    store.set(a, "serif");
    expect(store.get(a)).toBe("serif");
    expect(store.get(b)).toBe("default");
    expect(storage.map.get(a)).toBe("serif");
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

  test("offers exactly the three faces, follows the pane's artifact, and reports changes", () => {
    const store = createFaceStore({ storage: fakeStorage({ [faceKey("ws", "b.md")]: "mono" }) });
    let key: string | null = faceKey("ws", "a.md");
    const applied: string[] = [];
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    const control = mountFaceControl(host, store, { getKey: () => key, onChange: (face) => applied.push(face) });
    const select = host.querySelector("select") as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...FACES]);
    expect(select.getAttribute("aria-label")).toBe("Manuscript face");
    expect(select.value).toBe("default");

    select.value = "serif";
    select.dispatchEvent(new dom.window.Event("change") as unknown as Event);
    expect(store.get(key)).toBe("serif");
    expect(applied.at(-1)).toBe("serif");

    key = faceKey("ws", "b.md");
    control.refresh();
    expect(select.value).toBe("mono");
    expect(applied.at(-1)).toBe("mono");

    key = null;
    control.refresh();
    expect(select.disabled).toBe(true);
    expect(applied.at(-1)).toBe("default");
    control.destroy();
    expect(host.querySelector("select")).toBeNull();
  });
});

describe("the face reaches the manuscript through one variable", () => {
  test("app.css sets the manuscript from --font-manuscript and stamps it per pane", () => {
    const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.glosa-content\s*\{[^}]*font-family:\s*var\(--font-manuscript\)/);
    expect(css).toMatch(/\.glosa-pane\[data-face="serif"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-serif\)/);
    expect(css).toMatch(/\.glosa-pane\[data-face="mono"\]\s*\{[^}]*--font-manuscript:\s*var\(--font-mono\)/);
    // The rendered manuscript never names the serif directly any more: the writer's face decides.
    expect(css).not.toMatch(/\.glosa-content\s*\{[^}]*var\(--font-serif\)/);
  });
});
