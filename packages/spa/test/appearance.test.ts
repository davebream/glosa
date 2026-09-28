// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { mountAgentSettings } from "../src/agent-settings.js";
import {
  APPEARANCE_STORAGE_KEY,
  createAppearanceController,
  mountAppearanceControl,
  PALETTE_STORAGE_KEY,
  paletteList,
  readAppearance,
  readPalette,
  reportAppearanceToShell,
  resolveAppearance,
  shellContrastQuery,
} from "../src/appearance.js";
import { installDom, type DomEnv } from "./dom-env.ts";

/** A snapshot's palette fields when glosa's own palette is chosen and paints. */
const GLOSA = { palette: "glosa", painting: "glosa" } as const;

function fakeStorage(initial?: string, palette?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(APPEARANCE_STORAGE_KEY, initial);
  if (palette !== undefined) map.set(PALETTE_STORAGE_KEY, palette);
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

/** The desktop shell's contrast members as the preload exposes them (#425): `moreContrast()` and
 * `onMoreContrastChange(listener)`. `push` calls every listener whether or not the value changed,
 * so a test can send a push that changes nothing. */
function fakeShell(initial: boolean) {
  const listeners = new Set<(value: boolean) => void>();
  let value = initial;
  return {
    moreContrast: () => value,
    onMoreContrastChange(listener: (value: boolean) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(next: boolean) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    get listeners() {
      return listeners.size;
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
    expect(first.getSnapshot()).toEqual({ ...GLOSA, preference: "light", resolved: "light", scheme: "light" });
    expect(dom.document.documentElement.dataset.theme).toBe("light");
    expect(dom.document.documentElement.dataset.scheme).toBe("light");
    first.destroy();

    const newRoot = dom.document.createElement("html");
    const restarted = createAppearanceController({ root: newRoot, storage, mediaQuery: media as any });
    expect(restarted.getSnapshot()).toEqual({ ...GLOSA, preference: "light", resolved: "light", scheme: "light" });
    restarted.destroy();
  });

  test("stored dark overrides a light system across controller/browser restarts", () => {
    const storage = fakeStorage("dark");
    const media = fakeMediaQuery(false);
    const first = createAppearanceController({ root: dom.document.documentElement, storage, mediaQuery: media as any });
    expect(first.getSnapshot()).toEqual({ ...GLOSA, preference: "dark", resolved: "dark", scheme: "dark" });
    first.destroy();

    const restarted = createAppearanceController({
      root: dom.document.createElement("html"),
      storage,
      mediaQuery: media as any,
    });
    expect(restarted.getSnapshot()).toEqual({ ...GLOSA, preference: "dark", resolved: "dark", scheme: "dark" });
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
    expect(controller.getSnapshot()).toEqual({ ...GLOSA, preference: "light", resolved: "light", scheme: "light" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");

    controller.setPreference("system");
    expect(controller.getSnapshot()).toEqual({ ...GLOSA, preference: "system", resolved: "dark", scheme: "dark" });
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
    expect(controller.getSnapshot()).toEqual({ ...GLOSA, preference: "dark", resolved: "dark", scheme: "dark" });
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(host.querySelector('[data-appearance="dark"]')?.getAttribute("aria-checked")).toBe("true");
    expect(dom.document.activeElement).toBe(returnFocus);

    unmount();
    controller.destroy();
    expect(host.childElementCount).toBe(0);
  });

  test("glosa's own palette follows the system's request for more contrast live; High contrast chosen holds either way (#409)", () => {
    const storage = fakeStorage("light");
    const contrast = fakeMediaQuery(false);
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage,
      mediaQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
      contrastQuery: contrast as unknown as MediaQueryList,
    });
    const html = dom.document.documentElement;
    expect(controller.getSnapshot()).toEqual({ ...GLOSA, preference: "light", resolved: "light", scheme: "light" });
    contrast.setMatches(true);
    expect(controller.getSnapshot()).toEqual({
      preference: "light",
      palette: "glosa",
      painting: "high-contrast",
      resolved: "high-contrast-light",
      scheme: "light",
    });
    expect([html.dataset.palette, html.dataset.theme, html.dataset.scheme]).toEqual([
      "glosa",
      "high-contrast-light",
      "light",
    ]);
    contrast.setMatches(false);
    expect(html.dataset.theme).toBe("light");

    controller.setPalette("high-contrast");
    expect(storage.getItem(PALETTE_STORAGE_KEY)).toBe("high-contrast");
    expect(html.dataset.theme).toBe("high-contrast-light");
    controller.setPreference("dark");
    expect(html.dataset.theme).toBe("high-contrast-dark");
    contrast.setMatches(true);
    contrast.setMatches(false);
    expect(controller.getSnapshot()).toEqual({
      preference: "dark",
      palette: "high-contrast",
      painting: "high-contrast",
      resolved: "high-contrast-dark",
      scheme: "dark",
    });
    expect(() => controller.setPalette("solarized")).toThrow(TypeError);
    expect(readPalette(storage)).toBe("high-contrast");
    expect(readPalette(fakeStorage(undefined, "solarized"))).toBe("glosa");
    controller.destroy();
  });

  test("Settings shows each palette with its credit, chooses one, and says when the system's contrast is showing another", async () => {
    const storage = fakeStorage("system");
    const contrast = fakeMediaQuery(false);
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage,
      mediaQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
      contrastQuery: contrast as unknown as MediaQueryList,
    });
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const settings = mountAgentSettings(host, {
      appearance: controller,
      onChange: undefined,
      dataAccess: { getAgentStatus: async () => ({ available: true, providers: [], profiles: [] }) },
    });
    const rows = [...host.querySelectorAll("[data-palette-choice]")] as unknown as HTMLElement[];
    expect(
      rows.map((row) => [
        row.querySelector(".glosa-settings-palette-name")?.textContent,
        row.querySelector(".glosa-settings-palette-credit")?.textContent,
        row.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["glosa", "glosa's own · warm paper, near-black ink, your marks in vermilion", "true"],
      ["High contrast", "glosa's own · stronger ink, marks and edges on the same paper", "false"],
      ["Catppuccin", "Catppuccin by the Catppuccin Org · MIT", "false"],
      ["Gruvbox", "Gruvbox by Pavel Pertsev · MIT/X11", "false"],
      ["Rosé Pine", "Rosé Pine by mvllow · MIT", "false"],
    ]);
    // Each swatch paints the theme its palette would show in the scheme on screen (light here).
    expect(
      rows.map((row) => row.querySelector(".glosa-settings-palette-paper")?.getAttribute("data-theme-swatch")),
    ).toEqual(["light", "high-contrast-light", "catppuccin-latte", "gruvbox-light", "rose-pine-dawn"]);
    // Under the rows, one closed disclosure credits the palettes made by others: that glosa adapts
    // them, where each comes from, and where the licences are.
    const credits = host.querySelector(".glosa-settings-credits") as unknown as HTMLDetailsElement;
    expect(credits.open).toBe(false);
    expect(credits.querySelector("summary")?.textContent).toBe("Palette credits");
    expect([...credits.querySelectorAll("p, li")].map((line) => line.textContent)).toEqual([
      "Catppuccin, Gruvbox and Rosé Pine keep their own colours wherever those meet glosa's contrast floors. A colour below its floor is made darker on light paper, or lighter on dark, in its own hue, so some marks differ from the originals.",
      "Catppuccin · github.com/catppuccin/palette",
      "Gruvbox · github.com/morhetz/gruvbox",
      "Rosé Pine · github.com/rose-pine/palette",
      "Their licences are in THIRD_PARTY_NOTICES.md, which comes with glosa.",
    ]);
    const group = host.querySelector(".glosa-settings-palettes");
    expect(host.querySelector(`#${group?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Palette");
    const hint = () => host.querySelector(".glosa-settings-palettes + .glosa-settings-hint") as unknown as HTMLElement;
    expect(hint().hidden).toBe(true);

    contrast.setMatches(true);
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toBe(
      "Increase contrast is on for this Mac, so glosa shows High contrast. glosa's own palette returns when it is off.",
    );
    // Each row is named by its palette and described by its credit.
    expect(rows[1]!.getAttribute("aria-labelledby")).toBe("glosa-settings-palette-high-contrast-name");
    expect(host.querySelector(`#${rows[1]!.getAttribute("aria-describedby")}`)?.textContent).toBe(
      "glosa's own · stronger ink, marks and edges on the same paper",
    );
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("true");

    rows[1]!.click();
    expect(controller.getSnapshot().palette).toBe("high-contrast");
    expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(hint().hidden).toBe(true);
    expect(storage.getItem(PALETTE_STORAGE_KEY)).toBe("high-contrast");

    // A palette made by others, chosen while the system still asks for more contrast, paints as
    // chosen, and there is nothing for the line to explain.
    rows[4]!.click();
    expect(controller.getSnapshot()).toMatchObject({
      palette: "rose-pine",
      painting: "rose-pine",
      resolved: "rose-pine-dawn",
    });
    expect(dom.document.documentElement.dataset.theme).toBe("rose-pine-dawn");
    expect(hint().hidden).toBe(true);
    expect(storage.getItem(PALETTE_STORAGE_KEY)).toBe("rose-pine");
    settings.destroy();
    controller.destroy();
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
    // A palette paints its own paper, so choosing one reports again with the paper it painted.
    paper = "#fefbf8";
    controller.setPalette("high-contrast");
    expect(reports.at(-1)).toEqual({ source: "light", scheme: "light", background: "#fefbf8" });
    expect(reports).toHaveLength(3);
    stop();
    controller.setPreference("dark");
    expect(reports).toHaveLength(3);

    // A browser tab has no bridge: nothing to report to, and nothing throws.
    expect(() => reportAppearanceToShell(controller, null)()).not.toThrow();
    expect(() => reportAppearanceToShell(controller, {})()).not.toThrow();
    controller.destroy();
  });

  test("the shell's more contrast joins the media query as one contrast query that changes only when the combined answer flips (#425)", () => {
    // A browser tab, or a shell without both members: no combined query, so the controller keeps
    // `(prefers-contrast: more)` alone.
    expect(shellContrastQuery(undefined, fakeMediaQuery(true))).toBeUndefined();
    expect(shellContrastQuery(null, fakeMediaQuery(true))).toBeUndefined();
    expect(shellContrastQuery({ reportAppearance() {} }, fakeMediaQuery(true))).toBeUndefined();
    expect(shellContrastQuery({ moreContrast: () => true }, fakeMediaQuery(true))).toBeUndefined();

    const media = fakeMediaQuery(false);
    const shell = fakeShell(false);
    const query = shellContrastQuery(shell, media)!;
    const seen: boolean[] = [];
    const listener = (event: { matches: boolean }) => seen.push(event.matches);
    query.addEventListener("change", listener);
    expect(shell.listeners).toBe(1);
    expect(query.matches).toBe(false);

    shell.push(true);
    expect([query.matches, seen]).toEqual([true, [true]]);
    // A push that changes nothing, and the media query turning on while the shell already says
    // more contrast, leave the answer as it was: no change event.
    shell.push(true);
    media.setMatches(true);
    expect(seen).toEqual([true]);
    shell.push(false);
    expect([query.matches, seen]).toEqual([true, [true]]);
    media.setMatches(false);
    expect([query.matches, seen]).toEqual([false, [true, false]]);
    // The media query alone still counts.
    media.setMatches(true);
    expect(seen).toEqual([true, false, true]);
    media.setMatches(false);

    query.removeEventListener("change", listener);
    shell.push(true);
    expect([query.matches, seen]).toEqual([true, [true, false, true, false]]);

    // A getter that throws, or answers anything but true, is no more contrast.
    const throwing = shellContrastQuery(
      {
        moreContrast: () => {
          throw new Error("bridge gone");
        },
        onMoreContrastChange: () => () => {},
      },
      fakeMediaQuery(false),
    )!;
    expect(throwing.matches).toBe(false);
    const truthy = shellContrastQuery({ moreContrast: () => "true", onMoreContrastChange: () => () => {} }, media)!;
    expect(truthy.matches).toBe(false);
  });

  test("inside the desktop shell glosa's own palette follows the shell's more contrast live, with Settings' sentence; any other palette stays as chosen (#425)", () => {
    const storage = fakeStorage("light");
    const shell = fakeShell(false);
    const controller = createAppearanceController({
      root: dom.document.documentElement,
      storage,
      mediaQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
      contrastQuery: shellContrastQuery(shell, fakeMediaQuery(false)) as unknown as MediaQueryList,
    });
    const html = dom.document.documentElement;
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const settings = mountAgentSettings(host, {
      appearance: controller,
      onChange: undefined,
      dataAccess: { getAgentStatus: async () => ({ available: true, providers: [], profiles: [] }) },
    });
    const hint = () => host.querySelector(".glosa-settings-palettes + .glosa-settings-hint") as unknown as HTMLElement;
    const shown = () => [html.dataset.palette, html.dataset.theme, hint().hidden, hint().textContent];
    expect(shown()).toEqual(["glosa", "light", true, ""]);

    shell.push(true);
    expect(shown()).toEqual([
      "glosa",
      "high-contrast-light",
      false,
      "Increase contrast is on for this Mac, so glosa shows High contrast. glosa's own palette returns when it is off.",
    ]);
    controller.setPreference("dark");
    expect(html.dataset.theme).toBe("high-contrast-dark");
    shell.push(false);
    expect(shown()).toEqual(["glosa", "dark", true, ""]);

    // Every palette without a `moreContrast` palette stays as chosen whichever way the shell goes.
    for (const entry of paletteList().filter((candidate: { moreContrast?: string }) => !candidate.moreContrast)) {
      controller.setPalette(entry.id);
      for (const value of [true, false]) {
        shell.push(value);
        expect(shown(), `${entry.id}, shell more contrast ${value}`).toEqual([entry.id, entry.themes.dark, true, ""]);
      }
    }
    settings.destroy();
    controller.destroy();
  });
});

// A classic script runs in the page's one global scope: here, the realm the SPA's modules run in.
// (happy-dom's own `eval`, which `installDom()` copies onto the global, would run it in happy-dom's
// separate realm, where those modules never see what the script defined.)
const runClassicScript = (source: string, filename: string) => runInThisContext(source, { filename });
/** Where appearance-list.js publishes the list, typed for the one field these tests swap. */
const page = globalThis as { glosaAppearances?: unknown };

describe("the one list of appearances (#405, #409)", () => {
  const LIST_SOURCE = readFileSync(new URL("../src/appearance-list.js", import.meta.url), "utf8");
  const PRELOAD_SOURCE = readFileSync(new URL("../src/appearance-preload.js", import.meta.url), "utf8");
  const PALETTES_OPEN = "const palettes = Object.freeze([";
  // A palette with no `moreContrast`, like each one #410 adds: it stays as chosen when the system
  // asks for more contrast.
  const DUSK =
    'Object.freeze({ id: "test-dusk", label: "Dusk (test)", credit: "A test palette · for this file only", themes: Object.freeze({ light: "test-dawn", dark: "test-dusk" }) }),';
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

  /** The operating system as the preload asks it: `(prefers-color-scheme: dark)` and
   * `(prefers-contrast: more)`, each answered from here rather than from happy-dom's defaults. */
  function system({ dark = false, moreContrast = false } = {}) {
    (dom.window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
      matches:
        query === "(prefers-color-scheme: dark)" ? dark : query === "(prefers-contrast: more)" ? moreContrast : false,
      addEventListener() {},
      removeEventListener() {},
    });
  }

  /** Runs the list (optionally with one more palette) and then the preload, as shell.html does:
   * classic scripts, in order, before any module has touched this document. The list is removed
   * first, so the preload can only resolve through the copy run here. */
  function firstPaint(withPalette?: string) {
    expect(LIST_SOURCE).toContain(PALETTES_OPEN);
    delete page.glosaAppearances;
    runClassicScript(
      withPalette ? LIST_SOURCE.replace(PALETTES_OPEN, `${PALETTES_OPEN}\n    ${withPalette}`) : LIST_SOURCE,
      "appearance-list.js",
    );
    runClassicScript(PRELOAD_SOURCE, "appearance-preload.js");
    const html = dom.document.documentElement;
    return {
      appearance: html.dataset.appearance,
      palette: html.dataset.palette,
      theme: html.dataset.theme,
      scheme: html.dataset.scheme,
      colorScheme: html.style.colorScheme,
    };
  }

  test("one palette entry added to the list resolves before first paint and appears in Settings, not in the popover", async () => {
    system({ dark: false });
    dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, "test-dusk");
    dom.window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "dark");
    // The system is light here, so a dark result can only come from the stored mode.
    expect(firstPaint(DUSK)).toEqual({
      appearance: "dark",
      palette: "test-dusk",
      theme: "test-dusk",
      scheme: "dark",
      colorScheme: "dark",
    });

    const html = dom.document.documentElement;
    const controller = createAppearanceController({
      root: html,
      storage: dom.window.localStorage as unknown as Storage,
      mediaQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
      contrastQuery: fakeMediaQuery(false) as unknown as MediaQueryList,
    });
    expect(controller.getSnapshot()).toEqual({
      preference: "dark",
      palette: "test-dusk",
      painting: "test-dusk",
      resolved: "test-dusk",
      scheme: "dark",
    });

    // The workspace popover chooses the mode only; a palette is chosen in Settings.
    const popover = dom.document.createElement("div");
    dom.document.body.append(popover);
    const unmount = mountAppearanceControl(popover, controller);
    expect(
      [...popover.querySelectorAll("[data-appearance]")].map((row) => row.getAttribute("data-appearance")),
    ).toEqual(["system", "light", "dark"]);

    const settingsHost = dom.document.createElement("div");
    dom.document.body.append(settingsHost);
    const settings = mountAgentSettings(settingsHost, {
      appearance: controller,
      onChange: undefined,
      dataAccess: { getAgentStatus: async () => ({ available: true, providers: [], profiles: [] }) },
    });
    const rows = [...settingsHost.querySelectorAll("[data-palette-choice]")];
    expect(rows.map((row) => row.getAttribute("data-palette-choice"))).toEqual([
      "test-dusk",
      "glosa",
      "high-contrast",
      "catppuccin",
      "gruvbox",
      "rose-pine",
    ]);
    const dusk = settingsHost.querySelector('[data-palette-choice="test-dusk"]');
    expect(dusk?.querySelector(".glosa-settings-palette-name")?.textContent).toBe("Dusk (test)");
    expect(dusk?.querySelector(".glosa-settings-palette-credit")?.textContent).toBe(
      "A test palette · for this file only",
    );
    expect(dusk?.getAttribute("aria-pressed")).toBe("true");
    // Its swatch paints the theme it would show in the current scheme.
    expect(dusk?.querySelector(".glosa-settings-palette-paper")?.getAttribute("data-theme-swatch")).toBe("test-dusk");
    controller.setPreference("light");
    expect(dusk?.querySelector(".glosa-settings-palette-paper")?.getAttribute("data-theme-swatch")).toBe("test-dawn");
    expect(
      [...settingsHost.querySelectorAll("[data-theme-choice]")].map((button) =>
        button.getAttribute("data-theme-choice"),
      ),
    ).toEqual(["system", "light", "dark"]);

    settings.destroy();
    unmount();
    controller.destroy();
  });

  test("a stored High contrast palette paints before first paint, in the scheme the mode resolves", () => {
    dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, "high-contrast");
    system({ dark: false });
    expect(firstPaint()).toMatchObject({ palette: "high-contrast", theme: "high-contrast-light", scheme: "light" });
    system({ dark: true });
    expect(firstPaint()).toMatchObject({ palette: "high-contrast", theme: "high-contrast-dark", scheme: "dark" });
  });

  test("when the system asks for more contrast, glosa's own palette paints as High contrast before first paint; a palette without that stays as chosen", () => {
    system({ dark: false, moreContrast: true });
    expect(firstPaint()).toMatchObject({ appearance: "system", palette: "glosa", theme: "high-contrast-light" });
    system({ dark: true, moreContrast: true });
    expect(firstPaint()).toMatchObject({ palette: "glosa", theme: "high-contrast-dark", scheme: "dark" });
    system({ dark: true, moreContrast: false });
    expect(firstPaint()).toMatchObject({ palette: "glosa", theme: "dark" });

    dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, "test-dusk");
    system({ dark: true, moreContrast: true });
    expect(firstPaint(DUSK)).toMatchObject({ palette: "test-dusk", theme: "test-dusk" });

    // Catppuccin, Gruvbox and Rosé Pine, chosen by name, stay as chosen in either scheme (#410).
    for (const [palette, light, dark] of [
      ["catppuccin", "catppuccin-latte", "catppuccin-mocha"],
      ["gruvbox", "gruvbox-light", "gruvbox-dark"],
      ["rose-pine", "rose-pine-dawn", "rose-pine"],
    ]) {
      dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, palette!);
      for (const moreContrast of [false, true]) {
        system({ dark: false, moreContrast });
        expect(firstPaint(), `${palette}, light, more contrast ${moreContrast}`).toMatchObject({
          palette,
          theme: light,
          scheme: "light",
        });
        system({ dark: true, moreContrast });
        expect(firstPaint(), `${palette}, dark, more contrast ${moreContrast}`).toMatchObject({
          palette,
          theme: dark,
          scheme: "dark",
        });
      }
    }
  });

  test("inside the desktop shell, the shell's more contrast paints glosa's own palette as High contrast before first paint, every other palette as chosen; a tab or a failing bridge paints as the media query says (#425)", () => {
    const bridge = dom.window as unknown as { glosaShell?: unknown };
    const moreContrastTheme = (entry: { moreContrast?: string }, scheme: "light" | "dark") =>
      paletteList().find((candidate: { id: string }) => candidate.id === entry.moreContrast)!.themes[scheme];
    for (const entry of paletteList()) {
      dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, entry.id);
      for (const dark of [false, true]) {
        const scheme = dark ? "dark" : "light";
        for (const shellSays of [false, true]) {
          bridge.glosaShell = { moreContrast: () => shellSays };
          system({ dark, moreContrast: false });
          const expected = shellSays && entry.moreContrast ? moreContrastTheme(entry, scheme) : entry.themes[scheme];
          expect(firstPaint(), `${entry.id}, ${scheme}, shell more contrast ${shellSays}`).toMatchObject({
            palette: entry.id,
            theme: expected,
            scheme,
          });
          // The media query still counts beside the shell.
          system({ dark, moreContrast: true });
          expect(firstPaint(), `${entry.id}, ${scheme}, media query and shell ${shellSays}`).toMatchObject({
            theme: entry.moreContrast ? moreContrastTheme(entry, scheme) : entry.themes[scheme],
          });
        }
      }
    }

    dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, "glosa");
    // A browser tab: no bridge, the media query alone.
    delete bridge.glosaShell;
    system({ moreContrast: false });
    expect(firstPaint()).toMatchObject({ palette: "glosa", theme: "light" });
    // A bridge that throws, or answers anything but true, still paints, as the media query says.
    for (const glosaShell of [
      {
        moreContrast: () => {
          throw new Error("bridge gone");
        },
      },
      { moreContrast: () => "true" },
      { moreContrast: true },
      {},
    ]) {
      bridge.glosaShell = glosaShell;
      system({ moreContrast: false });
      expect(firstPaint()).toMatchObject({ palette: "glosa", theme: "light" });
      system({ moreContrast: true });
      expect(firstPaint()).toMatchObject({ palette: "glosa", theme: "high-contrast-light" });
    }
    delete bridge.glosaShell;
  });

  test("an unlisted stored value paints the list's defaults through the operating system", () => {
    dom.window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "sepia");
    dom.window.localStorage.setItem(PALETTE_STORAGE_KEY, "solarized");
    system({ dark: false });
    expect(firstPaint()).toEqual({
      appearance: "system",
      palette: "glosa",
      theme: "light",
      scheme: "light",
      colorScheme: "light",
    });
  });
});

test("the list of appearances and the blocking preload load, in that order, before the theme slots and the visual system stylesheet", () => {
  const shell = readFileSync(new URL("../src/shell.html", import.meta.url), "utf8");
  const list = shell.indexOf('<script src="/app/appearance-list.js"></script>');
  const preload = shell.indexOf('<script src="/app/appearance-preload.js"></script>');
  const themes = shell.indexOf('<link rel="stylesheet" href="/app/themes.css" />');
  expect(list).toBeGreaterThan(-1);
  expect(preload).toBeGreaterThan(list);
  expect(themes).toBeGreaterThan(preload);
  expect(themes).toBeLessThan(shell.indexOf("/app/app.css"));
});
