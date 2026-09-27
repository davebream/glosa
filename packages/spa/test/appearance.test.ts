// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { mountAgentSettings } from "../src/agent-settings.js";
import {
  APPEARANCE_STORAGE_KEY,
  createAppearanceController,
  mountAppearanceControl,
  readAppearance,
  reportAppearanceToShell,
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
    expect(
      readAppearance({
        getItem: () => {
          throw new Error("unavailable");
        },
      } as unknown as Storage),
    ).toBe("system");
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
    expect(first.getSnapshot()).toEqual({ preference: "light", resolved: "light", scheme: "light" });
    expect(dom.document.documentElement.dataset.theme).toBe("light");
    expect(dom.document.documentElement.dataset.scheme).toBe("light");
    first.destroy();

    const newRoot = dom.document.createElement("html");
    const restarted = createAppearanceController({ root: newRoot, storage, mediaQuery: media as any });
    expect(restarted.getSnapshot()).toEqual({ preference: "light", resolved: "light", scheme: "light" });
    restarted.destroy();
  });

  test("stored dark overrides a light system across controller/browser restarts", () => {
    const storage = fakeStorage("dark");
    const media = fakeMediaQuery(false);
    const first = createAppearanceController({ root: dom.document.documentElement, storage, mediaQuery: media as any });
    expect(first.getSnapshot()).toEqual({ preference: "dark", resolved: "dark", scheme: "dark" });
    first.destroy();

    const restarted = createAppearanceController({
      root: dom.document.createElement("html"),
      storage,
      mediaQuery: media as any,
    });
    expect(restarted.getSnapshot()).toEqual({ preference: "dark", resolved: "dark", scheme: "dark" });
    restarted.destroy();
  });

  test("system follows live OS changes; explicit mode ignores them; selecting system resumes inheritance", () => {
    const storage = fakeStorage("system");
    const media = fakeMediaQuery(false);
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage,
      mediaQuery: media as any,
    });

    expect(controller.getSnapshot().resolved).toBe("light");
    media.setMatches(true);
    expect(controller.getSnapshot().resolved).toBe("dark");
    expect(dom.document.documentElement.dataset.theme).toBe("dark");
    // The scheme is its own attribute, so CSS can select every dark theme without naming one.
    expect(dom.document.documentElement.dataset.scheme).toBe("dark");
    expect(dom.document.documentElement.style.colorScheme).toBe("dark");

    controller.setPreference("light");
    media.setMatches(false);
    media.setMatches(true);
    expect(controller.getSnapshot()).toEqual({ preference: "light", resolved: "light", scheme: "light" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");

    controller.setPreference("system");
    expect(controller.getSnapshot()).toEqual({ preference: "system", resolved: "dark", scheme: "dark" });
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
    expect(host.querySelector(".glosa-appearance-trigger")?.getAttribute("aria-label")).toBe(
      "Appearance: System (light)",
    );
    expect(host.querySelector(".glosa-appearance-trigger-label")?.textContent).toBe("Appearance");

    options[0]!.focus();
    options[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as any);
    expect(dom.document.activeElement).toBe(options[1] as any);

    (host.querySelector('[data-appearance="dark"]') as any).click();
    expect(controller.getSnapshot()).toEqual({ preference: "dark", resolved: "dark", scheme: "dark" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(host.querySelector('[data-appearance="dark"]')?.getAttribute("aria-checked")).toBe("true");
    expect(dom.document.activeElement).toBe(returnFocus);

    unmount();
    controller.destroy();
    expect(host.childElementCount).toBe(0);
  });

  test("inside the desktop shell the page reports what it resolved as source, scheme and paper; a tab reports nothing", () => {
    const reports: unknown[] = [];
    const shell = {
      reportAppearance: (message: unknown) => {
        reports.push(message);
        return Promise.resolve();
      },
    };
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage: fakeStorage("system"),
      mediaQuery: fakeMediaQuery(true) as unknown as MediaQueryList,
    });
    let paper = "#1c1917";
    const stop = reportAppearanceToShell(controller, shell, { readPaper: () => paper });
    expect(reports).toEqual([{ source: "system", scheme: "dark", background: "#1c1917" }]);

    paper = "#fdfaf5";
    controller.setPreference("light");
    expect(reports.at(-1)).toEqual({ source: "light", scheme: "light", background: "#fdfaf5" });
    stop();
    controller.setPreference("dark");
    expect(reports).toHaveLength(2);

    // A browser tab has no bridge: nothing to report to, and nothing throws.
    expect(() => reportAppearanceToShell(controller, null)()).not.toThrow();
    expect(() => reportAppearanceToShell(controller, {})()).not.toThrow();
    controller.destroy();
  });
});

// A classic script runs in the page's one global scope: here, the realm the SPA's modules run in.
// (happy-dom's own `eval`, which `installDom()` copies onto the global, would run it in happy-dom's
// separate realm, where those modules never see what the script defined.)
const runClassicScript = (source: string, filename: string) => runInThisContext(source, { filename });
/** Where appearance-list.js publishes the list, typed for the one field these tests swap. */
const page = globalThis as { glosaAppearances?: unknown };

describe("the one list of appearances (#405)", () => {
  const LIST_SOURCE = readFileSync(new URL("../src/appearance-list.js", import.meta.url), "utf8");
  const PRELOAD_SOURCE = readFileSync(new URL("../src/appearance-preload.js", import.meta.url), "utf8");
  const LIST_OPENS = "const list = Object.freeze([";
  const DUSK =
    'Object.freeze({ id: "test-dusk", scheme: "dark", label: "Dusk (test)", settingsLabel: "Dusk, a test theme" }),';
  let dom: DomEnv;
  let listed: unknown;
  beforeEach(() => {
    dom = installDom();
    listed = page.glosaAppearances;
  });
  afterEach(() => {
    page.glosaAppearances = listed;
    dom.teardown();
  });

  test("one entry added to the list resolves before first paint and appears in the popover and in Settings", async () => {
    // The list and the preload are classic scripts, run as shell.html runs them: from their own
    // source, in order, before any module has touched this document. The list is removed first, so
    // the preload can only resolve through the edited copy.
    expect(LIST_SOURCE).toContain(LIST_OPENS);
    delete page.glosaAppearances;
    const withDusk = LIST_SOURCE.replace(LIST_OPENS, `${LIST_OPENS}\n    ${DUSK}`);
    dom.window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "test-dusk");
    // The operating system is light here, so a dark result can only come from the entry's scheme.
    expect(dom.window.matchMedia("(prefers-color-scheme: dark)").matches).toBe(false);
    runClassicScript(withDusk, "appearance-list.js");
    runClassicScript(PRELOAD_SOURCE, "appearance-preload.js");
    const html = dom.document.documentElement;
    expect({
      colorScheme: html.style.colorScheme,
      scheme: html.dataset.scheme,
      theme: html.dataset.theme,
      appearance: html.dataset.appearance,
    }).toEqual({ colorScheme: "dark", scheme: "dark", theme: "test-dusk", appearance: "test-dusk" });

    const controller = createAppearanceController({
      root: html,
      storage: dom.window.localStorage as unknown as Storage,
      mediaQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
    });
    expect(controller.getSnapshot()).toEqual({ preference: "test-dusk", resolved: "test-dusk", scheme: "dark" });

    const popover = dom.document.createElement("div");
    dom.document.body.append(popover);
    const unmount = mountAppearanceControl(popover, controller);
    const row = popover.querySelector('[data-appearance="test-dusk"]');
    expect(row?.textContent).toBe("Dusk (test)");
    expect(row?.getAttribute("aria-checked")).toBe("true");

    const settingsHost = dom.document.createElement("div");
    dom.document.body.append(settingsHost);
    const settings = mountAgentSettings(settingsHost, {
      appearance: controller,
      onChange: undefined,
      dataAccess: { getAgentStatus: async () => ({ available: true, providers: [], profiles: [] }) },
    });
    const choice = settingsHost.querySelector('[data-theme-choice="test-dusk"]');
    expect(choice?.textContent).toBe("Dusk, a test theme");
    expect(choice?.getAttribute("aria-pressed")).toBe("true");
    expect(
      [...settingsHost.querySelectorAll("[data-theme-choice]")].map((button) =>
        button.getAttribute("data-theme-choice"),
      ),
    ).toEqual(["test-dusk", "system", "light", "dark"]);

    settings.destroy();
    unmount();
    controller.destroy();
  });

  test("an unlisted stored value paints the list's default through the operating system", () => {
    dom.window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "sepia");
    runClassicScript(PRELOAD_SOURCE, "appearance-preload.js");
    const html = dom.document.documentElement;
    expect([html.dataset.appearance, html.dataset.theme, html.dataset.scheme, html.style.colorScheme]).toEqual([
      "system",
      "light",
      "light",
      "light",
    ]);
  });
});

test("the list of appearances and the blocking preload load, in that order, before the visual system stylesheet", () => {
  const shell = readFileSync(new URL("../src/shell.html", import.meta.url), "utf8");
  const list = shell.indexOf('<script src="/app/appearance-list.js"></script>');
  const preload = shell.indexOf('<script src="/app/appearance-preload.js"></script>');
  expect(list).toBeGreaterThan(-1);
  expect(preload).toBeGreaterThan(list);
  expect(preload).toBeLessThan(shell.indexOf("/app/app.css"));
});
