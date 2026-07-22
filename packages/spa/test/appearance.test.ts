// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APPEARANCE_STORAGE_KEY,
  createAppearanceController,
  mountAppearanceControl,
  readAppearance,
  resolveAppearance,
} from "../src/appearance.js";
import { installDom, type DomEnv } from "./dom-env.ts";

function fakeStorage(initial?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(APPEARANCE_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function fakeMediaQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches: initial,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    setMatches(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("appearance preference resolution", () => {
  test("only system inherits the operating-system appearance", () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });

  test("missing or invalid stored values safely default to system", () => {
    expect(readAppearance(fakeStorage())).toBe("system");
    expect(readAppearance(fakeStorage("sepia"))).toBe("system");
    expect(readAppearance({ getItem: () => { throw new Error("unavailable"); } } as unknown as Storage)).toBe("system");
  });
});

describe("createAppearanceController", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("stored light overrides a dark system across controller/browser restarts", () => {
    const storage = fakeStorage("light");
    const media = fakeMediaQuery(true);
    const first = createAppearanceController({ root: dom.document.documentElement, storage, mediaQuery: media as any });
    expect(first.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(dom.document.documentElement.dataset.theme).toBe("light");
    first.destroy();

    const newRoot = dom.document.createElement("html");
    const restarted = createAppearanceController({ root: newRoot, storage, mediaQuery: media as any });
    expect(restarted.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    restarted.destroy();
  });

  test("stored dark overrides a light system across controller/browser restarts", () => {
    const storage = fakeStorage("dark");
    const media = fakeMediaQuery(false);
    const first = createAppearanceController({ root: dom.document.documentElement, storage, mediaQuery: media as any });
    expect(first.getSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
    first.destroy();

    const restarted = createAppearanceController({ root: dom.document.createElement("html"), storage, mediaQuery: media as any });
    expect(restarted.getSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
    restarted.destroy();
  });

  test("system follows live OS changes; explicit mode ignores them; selecting system resumes inheritance", () => {
    const storage = fakeStorage("system");
    const media = fakeMediaQuery(false);
    const controller = createAppearanceController({ root: dom.document.documentElement, storage, mediaQuery: media as any });

    expect(controller.getSnapshot().resolved).toBe("light");
    media.setMatches(true);
    expect(controller.getSnapshot().resolved).toBe("dark");
    expect(dom.document.documentElement.dataset.theme).toBe("dark");

    controller.setPreference("light");
    media.setMatches(false);
    media.setMatches(true);
    expect(controller.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");

    controller.setPreference("system");
    expect(controller.getSnapshot()).toEqual({ preference: "system", resolved: "dark" });
    media.setMatches(false);
    expect(controller.getSnapshot().resolved).toBe("light");
    controller.destroy();
  });

  test("the workspace control exposes all choices and persists a selection", () => {
    const storage = fakeStorage("system");
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage,
      mediaQuery: fakeMediaQuery(false) as any,
    });
    const host = dom.document.createElement("div");
    const returnFocus = dom.document.createElement("button");
    dom.document.body.append(host);
    dom.document.body.append(returnFocus);

    const unmount = mountAppearanceControl(host, controller, { returnFocus });
    const options = [...host.querySelectorAll('[role="menuitemradio"]')] as unknown as HTMLElement[];
    expect(options).toHaveLength(3);
    expect(host.querySelector('.glosa-appearance-trigger')?.getAttribute("aria-label")).toBe("Appearance: System (light)");
    expect(host.querySelector('.glosa-appearance-trigger-label')?.textContent).toBe("Appearance");

    options[0]!.focus();
    options[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as any);
    expect(dom.document.activeElement).toBe(options[1] as any);

    (host.querySelector('[data-appearance="dark"]') as any).click();
    expect(controller.getSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(host.querySelector('[data-appearance="dark"]')?.getAttribute("aria-checked")).toBe("true");
    expect(dom.document.activeElement).toBe(returnFocus);

    unmount();
    controller.destroy();
    expect(host.childElementCount).toBe(0);
  });
});

test("the blocking appearance preload is loaded before the visual system stylesheet", () => {
  const shell = readFileSync(new URL("../src/shell.html", import.meta.url), "utf8");
  expect(shell.indexOf('/app/appearance-preload.js')).toBeGreaterThan(-1);
  expect(shell.indexOf('/app/appearance-preload.js')).toBeLessThan(shell.indexOf('/app/app.css'));
});
