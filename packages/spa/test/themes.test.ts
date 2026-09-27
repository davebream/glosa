// SPDX-License-Identifier: Apache-2.0
// #409 — the theme files, the floors they are checked against, and the stylesheet they become.
//
// The validator is the real module (packages/spa/src/themes/validate.js) run over the real shipped
// files; nothing here is a stand-in. What these tests cannot see is how an engine paints the
// result: test/acceptance/workbench-real-engine.test.ts reads the computed tokens in Chromium.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import {
  DEFAULT_THEME,
  readShippedThemes,
  renderShippedStylesheet,
  STYLESHEET_PATH,
} from "../../../scripts/render-themes.ts";
import { renderThemeStylesheet } from "../src/themes/stylesheet.js";
import {
  checkTheme,
  contrastRatio,
  HUE_RULES,
  hueDistance,
  ThemeRefusedError,
  validateTheme,
} from "../src/themes/validate.js";

type Theme = { id: string; scheme?: string; contrast?: string; media?: string; slots: Record<string, string> };

const shipped = () => readShippedThemes() as unknown as Theme[];
const theme = (id: string): Theme => {
  const found = shipped().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no shipped theme "${id}"`);
  return structuredClone(found);
};
const withSlots = (base: Theme, slots: Record<string, string>): Theme => ({
  ...base,
  slots: { ...base.slots, ...slots },
});
const refusalOf = (candidate: Theme) => {
  try {
    validateTheme(candidate);
  } catch (error) {
    expect(error).toBeInstanceOf(ThemeRefusedError);
    return error as ThemeRefusedError;
  }
  throw new Error(`theme "${candidate.id}" was not refused`);
};

describe("the shipped theme files", () => {
  test("every shipped theme passes its floors, and glosa ships light, dark, High contrast light and dark, and print", () => {
    const themes = shipped();
    expect(themes.map((candidate) => candidate.id).sort()).toEqual([
      "dark",
      "high-contrast-dark",
      "high-contrast-light",
      "light",
      "print",
    ]);
    for (const candidate of themes) expect(checkTheme(candidate), candidate.id).toEqual([]);
  });

  test("themes.css on disk is exactly what the theme files render to", () => {
    // The stylesheet is checked in so the SPA needs no build step; this is what keeps it honest.
    // If it fails: `bun run themes:render`.
    expect(readFileSync(STYLESHEET_PATH, "utf8")).toBe(renderShippedStylesheet());
  });

  test("every palette in the one list names two shipped themes of its schemes, and the stylesheet's default is the list's", () => {
    const LIST = readFileSync(new URL("../src/appearance-list.js", import.meta.url), "utf8");
    type Palette = { id: string; themes: Record<string, string> };
    const page = globalThis as { glosaAppearances?: { palettes: Palette[] } };
    const before = page.glosaAppearances;
    runInThisContext(LIST, { filename: "appearance-list.js" });
    const palettes = page.glosaAppearances!.palettes;
    page.glosaAppearances = before;
    const byId = new Map(shipped().map((candidate) => [candidate.id, candidate]));
    for (const palette of palettes)
      for (const scheme of ["light", "dark"]) {
        const named = byId.get(palette.themes[scheme]!);
        expect(named?.scheme, `${palette.id} in ${scheme}`).toBe(scheme);
      }
    // No shipped screen theme is unreachable from a palette.
    const reachable = new Set(palettes.flatMap((palette) => Object.values(palette.themes)));
    for (const candidate of shipped())
      if (!candidate.media) expect(reachable.has(candidate.id), candidate.id).toBe(true);
    expect(palettes[0]!.themes.light).toBe(DEFAULT_THEME);
  });
});

describe("a theme below a floor is refused by name, and never repaired", () => {
  test("ink lowered below 7:1 is refused, naming the theme, ink, the measured ratio and the floor", () => {
    const lowered = withSlots(theme("light"), { ink: "oklch(0.5 0.012 60)" });
    const ratio = contrastRatio(lowered.slots.ink!, lowered.slots.bg!);
    expect(ratio).toBeLessThan(7);
    const error = refusalOf(lowered);
    const onPaper = error.refusals.find((refusal) => refusal.role === "ink" && refusal.ground === "bg");
    expect(onPaper).toMatchObject({ theme: "light", rule: "contrast", role: "ink", as: "text", floor: 7 });
    expect(onPaper!.ratio).toBeCloseTo(ratio, 10);
    expect(onPaper!.message).toBe(
      `theme "light" is refused: ink is ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 as text on bg, under its floor of 7:1`,
    );
    expect(error.message).toContain(onPaper!.message);
  });

  test("the hand below 3:1 as a line is refused as a line, naming the theme, hand, the ratio and 3:1", () => {
    const lowered = withSlots(theme("light"), { hand: "oklch(0.72 0.14 42)" });
    const onPaper = contrastRatio(lowered.slots.hand!, lowered.slots.bg!);
    expect(onPaper).toBeLessThan(3);
    const refusal = refusalOf(lowered).refusals.find(
      (candidate) => candidate.role === "hand" && candidate.as === "line" && candidate.ground === "bg",
    );
    expect(refusal).toMatchObject({ theme: "light", rule: "contrast", role: "hand", as: "line", floor: 3 });
    expect(refusal!.message).toContain(`hand is ${(Math.floor(onPaper * 100) / 100).toFixed(2)}:1 as line on bg`);
    expect(refusal!.message).toContain("under its floor of 3:1");
  });

  test("a theme made for more contrast is held to its stricter floors: glosa's own light warn passes as a line at 3:1 but not at 4.5:1", () => {
    // glosa's light warn is 4.49:1 on the sunken ground, where its stale dot sits on a hovered row.
    const light = theme("light");
    expect(contrastRatio(light.slots.warn!, light.slots["surface-sunken"]!)).toBeLessThan(4.5);
    expect(checkTheme(light)).toEqual([]);
    const refusals = checkTheme({ ...light, id: "strict-light", contrast: "more" });
    expect(refusals).toContainEqual(
      expect.objectContaining({
        theme: "strict-light",
        role: "warn",
        as: "line",
        ground: "surface-sunken",
        floor: 4.5,
      }),
    );
    // Muted is held to 7:1 there too; glosa's own light muted is 6.66:1 on paper.
    expect(refusals).toContainEqual(expect.objectContaining({ role: "muted", ground: "bg", floor: 7 }));
  });

  test("faint mapped to live text is refused, by name or by colour", () => {
    const byName = checkTheme(withSlots(theme("light"), { muted: "faint" }));
    expect(byName).toContainEqual(expect.objectContaining({ theme: "light", rule: "faint", role: "muted" }));
    const light = theme("light");
    const byColour = checkTheme(withSlots(light, { faint: light.slots.pencil! }));
    expect(byColour).toContainEqual(expect.objectContaining({ rule: "faint", role: "pencil" }));
    expect(byColour.find((refusal) => refusal.rule === "faint")!.message).toContain("disabled text only");
  });

  test("a refused theme is never corrected: the refusal leaves it as it was, and a passing theme comes back unchanged", () => {
    const lowered = withSlots(theme("dark"), { ink: "oklch(0.4 0.01 80)" });
    const copy = structuredClone(lowered);
    refusalOf(lowered);
    expect(lowered).toEqual(copy);
    const dark = theme("dark");
    expect(validateTheme(dark)).toBe(dark);
    expect(() => renderThemeStylesheet([theme("light"), lowered], { defaultTheme: "light" })).toThrow(
      ThemeRefusedError,
    );
  });
});

describe("where each role is checked: the grounds it is drawn on", () => {
  test("glosa's own light pencil passes at 4.53:1 on the paper it is drawn on, though it is 4.27:1 on the surface it never is", () => {
    const light = theme("light");
    expect(contrastRatio(light.slots.pencil!, light.slots.bg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.slots.pencil!, light.slots.surface!)).toBeLessThan(4.5);
    expect(checkTheme(light)).toEqual([]);
    // In dark the composer floats on the surface, so that is where the pencil is held to 4.5:1.
    const dim = withSlots(theme("dark"), { pencil: "oklch(0.6 0.01 70)" });
    expect(contrastRatio(dim.slots.pencil!, dim.slots.bg!)).toBeGreaterThanOrEqual(4.5);
    expect(checkTheme(dim)).toContainEqual(
      expect.objectContaining({ role: "pencil", as: "text", ground: "elevated", floor: 4.5 }),
    );
  });

  test("print is checked for the slots it sets, over any theme", () => {
    const print = theme("print");
    expect(Object.keys(print.slots)).toEqual(["bg", "surface", "ink", "muted", "border", "border-strong"]);
    expect(checkTheme(withSlots(print, { muted: "#999" }))).toContainEqual(
      expect.objectContaining({ theme: "print", role: "muted", ground: "bg", floor: 4.5 }),
    );
  });
});

describe("the hue rules that keep the marks apart (DESIGN.md, #410 relies on them)", () => {
  test(`the hand and session ink closer than ${HUE_RULES.handSessionDegrees} degrees are refused`, () => {
    const close = withSlots(theme("light"), { session: "oklch(0.42 0.11 120)" });
    expect(hueDistance(close.slots.hand!, close.slots.session!)).toBeLessThan(90);
    expect(checkTheme(close)).toContainEqual(expect.objectContaining({ theme: "light", rule: "hue", role: "session" }));
    for (const candidate of shipped())
      if (candidate.slots.hand && candidate.slots.session)
        expect(hueDistance(candidate.slots.hand, candidate.slots.session), candidate.id).toBeGreaterThanOrEqual(90);
  });

  test("danger may sit near the hand's hue, as glosa's own does, but never at its lightness", () => {
    const light = theme("light");
    expect(hueDistance(light.slots.hand!, light.slots.danger!)).toBeLessThan(25);
    expect(checkTheme(light)).toEqual([]);
    const same = checkTheme(withSlots(light, { danger: "oklch(0.52 0.17 22)" }));
    expect(same).toContainEqual(expect.objectContaining({ theme: "light", rule: "lightness", role: "danger" }));
  });
});

describe("a theme file's shape", () => {
  test("a missing slot, an unknown slot, a colour glosa cannot read and a translucent ink are each refused", () => {
    const light = theme("light");
    const { ok: _dropped, ...withoutOk } = light.slots;
    expect(checkTheme({ ...light, slots: withoutOk })).toContainEqual(
      expect.objectContaining({ rule: "slot", role: "ok" }),
    );
    expect(checkTheme(withSlots(light, { accent: "#ff0000" }))).toContainEqual(
      expect.objectContaining({ rule: "slot", role: "accent" }),
    );
    expect(checkTheme(withSlots(light, { hand: "rgb(176 63 0)" }))).toContainEqual(
      expect.objectContaining({ rule: "slot", role: "hand" }),
    );
    expect(checkTheme(withSlots(light, { ink: "oklch(0.2 0.012 60 / 0.8)" }))).toContainEqual(
      expect.objectContaining({ rule: "slot", role: "ink" }),
    );
    expect(checkTheme({ ...light, scheme: "sepia" })).toContainEqual(expect.objectContaining({ rule: "shape" }));
  });
});
