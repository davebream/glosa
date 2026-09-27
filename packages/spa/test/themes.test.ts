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
  parseColor,
  ROLE_CHECKS,
  SLOTS,
  ThemeRefusedError,
  validateTheme,
} from "../src/themes/validate.js";

type Move = {
  from: string;
  to: string;
  as: string;
  on: string;
  floor: number;
  was: number;
  now: number;
  lightness?: string;
};
type Upstream = { palette: string; source: string; colours: Record<string, string>; moved: Record<string, Move> };
type Theme = {
  id: string;
  scheme?: string;
  contrast?: string;
  media?: string;
  upstream?: Upstream;
  slots: Record<string, string>;
};

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
  test("every shipped theme passes its floors: glosa's light, dark, High contrast light and dark and print, and Catppuccin, Gruvbox and Rosé Pine in light and dark", () => {
    const themes = shipped();
    expect(themes.map((candidate) => candidate.id).sort()).toEqual([
      "catppuccin-latte",
      "catppuccin-mocha",
      "dark",
      "gruvbox-dark",
      "gruvbox-light",
      "high-contrast-dark",
      "high-contrast-light",
      "light",
      "print",
      "rose-pine",
      "rose-pine-dawn",
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

describe("palettes made by others, adapted to the floors (#410)", () => {
  const borrowed = () => shipped().filter((candidate) => candidate.upstream);
  /** "peach #fe640b", "text #4c4f69 at 30%": the upstream name's colour, and its alpha if any. */
  const upstreamColour = (entry: string) => {
    const match = entry.match(/(#[0-9a-f]{6})(?: at (\d+)%)?$/);
    return match ? { hex: match[1]!, alpha: match[2] === undefined ? 1 : Number(match[2]) / 100 } : null;
  };
  const lchOf = (value: string) => parseColor(value)!.lch;
  /** OKLCH to linear sRGB without clipping: a slot outside sRGB would paint differently on a
   * wide-gamut display from the ratio the validator measured. */
  const inSrgb = (value: string) => {
    const [L, C, h] = lchOf(value);
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].every((channel) => channel > -1e-4 && channel < 1 + 1e-4);
  };
  const hexOf = (value: string) =>
    `#${parseColor(value)!
      .linear.map((v) => Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  const truncated = (ratio: number) => Math.floor(ratio * 100) / 100;
  const groundOf = (candidate: Theme, on: string) =>
    candidate.slots[on === "elevated" ? (candidate.scheme === "dark" ? "surface" : "bg") : on]!;

  test("Catppuccin, Gruvbox and Rosé Pine each ship a light and a dark theme that records where its colours come from", () => {
    expect(borrowed().map((candidate) => [candidate.id, candidate.scheme])).toEqual([
      ["catppuccin-latte", "light"],
      ["catppuccin-mocha", "dark"],
      ["gruvbox-dark", "dark"],
      ["gruvbox-light", "light"],
      ["rose-pine-dawn", "light"],
      ["rose-pine", "dark"],
    ]);
  });

  test("every slot is its upstream colour unchanged, a reference to another slot, or a recorded move", () => {
    for (const candidate of borrowed()) {
      const { colours, moved } = candidate.upstream!;
      for (const slot of SLOTS) {
        const value = candidate.slots[slot]!;
        const where = `${candidate.id} ${slot}`;
        if ((SLOTS as readonly string[]).includes(value)) {
          expect(colours[slot], `${where} refers to ${value} and names no colour of its own`).toBeUndefined();
          continue;
        }
        if (slot === "scrim" && colours.scrim?.startsWith("glosa's own")) {
          expect(value, where).toBe("oklch(0 0 0 / 0.45)");
          continue;
        }
        const upstream = upstreamColour(colours[slot] ?? "");
        expect(upstream, `${where} names its upstream colour`).not.toBeNull();
        if (moved[slot]) {
          expect(value, `${where} was moved, so it is not the upstream colour`).not.toBe(upstream!.hex);
        } else if (upstream!.alpha === 1) {
          expect(value, `${where} is the upstream colour, unchanged`).toBe(upstream!.hex);
        } else {
          // A translucent slot (the scrim) is the upstream colour at the named strength.
          const [l1, c1, h1] = lchOf(value);
          const [l2, c2, h2] = lchOf(upstream!.hex);
          expect([l1 - l2, c1 - c2].every((d) => Math.abs(d) < 0.0006) && Math.abs(h1 - h2) < 0.06, where).toBe(true);
          expect(parseColor(value)!.alpha, where).toBe(upstream!.alpha);
        }
      }
      for (const role of Object.keys(moved)) expect(colours[role], `${candidate.id} ${role}`).toBeDefined();
    }
  });

  test("every recorded move was needed, kept its hue, stayed in sRGB and stopped at its floor, and its ratios are the ones measured", () => {
    let moves = 0;
    for (const candidate of borrowed()) {
      const { colours, moved } = candidate.upstream!;
      const light = candidate.scheme === "light";
      for (const [role, move] of Object.entries(moved)) {
        moves++;
        const where = `${candidate.id} ${role}`;
        const upstream = upstreamColour(colours[role]!)!.hex;
        const value = candidate.slots[role]!;
        const [L0, C0, H0] = lchOf(upstream);
        const [L, C, H] = lchOf(value);
        // The record's upstream OKLCH is the upstream colour's, and its hex is what the slot paints.
        expect(move.from, where).toBe(`oklch(${+L0.toFixed(3)} ${+C0.toFixed(3)} ${+H0.toFixed(1)})`);
        expect(move.to, where).toBe(hexOf(value));
        // Lightness only, away from the paper; chroma only where sRGB holds no more; the hue kept.
        expect(Math.abs(H - H0), `${where} keeps its hue`).toBeLessThan(0.06);
        expect(C, `${where} gains no chroma`).toBeLessThanOrEqual(C0 + 0.0005);
        expect(light ? L < L0 : L > L0, `${where} moves away from the paper`).toBe(true);
        expect(inSrgb(value), `${where} stays inside sRGB`).toBe(true);
        // The ground it failed on is where it fell furthest under its floor, with the ratios as measured.
        const margins = ROLE_CHECKS.filter((check) => check.role === role).flatMap((check) =>
          check.on.map((on) => ({
            as: check.as,
            on,
            floor: check.floor,
            margin: contrastRatio(upstream, groundOf(candidate, on)) - check.floor,
          })),
        );
        const worst = margins.reduce((a, b) => (b.margin < a.margin ? b : a));
        expect({ as: move.as, on: move.on, floor: move.floor }, where).toEqual({
          as: worst.as,
          on: worst.on,
          floor: worst.floor,
        });
        const ground = groundOf(candidate, move.on);
        expect(move.was, where).toBe(truncated(contrastRatio(upstream, ground)));
        expect(move.now, where).toBe(truncated(contrastRatio(value, ground)));
        expect(move.was, `${where} failed its floor upstream`).toBeLessThan(move.floor);
        expect(move.now, `${where} passes its floor`).toBeGreaterThanOrEqual(move.floor);
        // It stopped as soon as it passed: at the floor, or, for danger, at the 0.02 the hand needs.
        if (move.lightness)
          expect(Math.abs(L - lchOf(candidate.slots.hand!)[0]), where).toBeLessThan(
            HUE_RULES.handDangerLightness + 0.0015,
          );
        else expect(move.now - move.floor, `${where} moved no further than its floor`).toBeLessThan(0.05);
        // With its upstream colour back, the palette is refused for exactly this role.
        const refusals = checkTheme(withSlots(candidate, { [role]: upstream }));
        expect(
          refusals.some((refusal) => refusal.role === role),
          `${where}: the upstream colour ${upstream} is refused`,
        ).toBe(true);
      }
    }
    expect(moves).toBe(24);
  });

  test("every palette made by others is credited in THIRD_PARTY_NOTICES.md with its source, author and licence", () => {
    const LIST = readFileSync(new URL("../src/appearance-list.js", import.meta.url), "utf8");
    type Palette = { id: string; label: string; credit: string; source?: string };
    const page = globalThis as { glosaAppearances?: { palettes: Palette[] } };
    const before = page.glosaAppearances;
    runInThisContext(LIST, { filename: "appearance-list.js" });
    const palettes = page.glosaAppearances!.palettes.filter((palette) => palette.source);
    page.glosaAppearances = before;
    const notices = readFileSync(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    expect(palettes.map((palette) => palette.id)).toEqual(["catppuccin", "gruvbox", "rose-pine"]);
    for (const palette of palettes) {
      // "Gruvbox by Pavel Pertsev · MIT/X11": the author and the licence the row names.
      const [, author, licence] = palette.credit.match(/ by (?:the )?(.+) · (.+)$/)!;
      expect(notices, palette.id).toContain(`https://${palette.source}`);
      expect(notices, palette.id).toContain(author!);
      expect(notices, palette.id).toContain(licence!);
    }
  });

  test("a palette paints colours only: a face, a register or a font slot in its file is refused", () => {
    // The face and the register (#407) belong to the document; a theme file carries the sixteen
    // colour slots and nothing a page reads as type.
    const gruvbox = theme("gruvbox-light");
    expect(checkTheme({ ...gruvbox, face: "mono" })).toContainEqual(
      expect.objectContaining({ theme: "gruvbox-light", rule: "shape", message: expect.stringContaining('"face"') }),
    );
    expect(checkTheme({ ...gruvbox, register: "spec" })).toContainEqual(
      expect.objectContaining({ rule: "shape", message: expect.stringContaining('"register"') }),
    );
    expect(checkTheme(withSlots(gruvbox, { "font-serif": "#3c3836" }))).toContainEqual(
      expect.objectContaining({ rule: "slot", role: "font-serif" }),
    );
  });

  test("Latte's upstream peach back as the hand is refused, naming the theme, the hand, 2.25:1 and 4.5:1", () => {
    const latte = theme("catppuccin-latte");
    const upstreamPeach = withSlots(latte, { hand: "#fe640b" });
    const error = refusalOf(upstreamPeach);
    const onSunken = error.refusals.find(
      (refusal) => refusal.role === "hand" && refusal.as === "text" && refusal.ground === "surface-sunken",
    );
    expect(onSunken).toMatchObject({ theme: "catppuccin-latte", rule: "contrast", role: "hand", floor: 4.5 });
    expect(onSunken!.message).toBe(
      'theme "catppuccin-latte" is refused: hand is 2.25:1 as text on surface-sunken, under its floor of 4.5:1',
    );
    // On the paper and the surface too, as text and as a line: peach is under every floor it has.
    expect(
      error.refusals
        .filter((refusal) => refusal.role === "hand")
        .map((refusal) => `${refusal.as} on ${refusal.ground}`),
    ).toEqual([
      "text on bg",
      "text on surface",
      "text on surface-sunken",
      "line on bg",
      "line on surface",
      "line on surface-sunken",
    ]);
    expect(() => renderThemeStylesheet([theme("light"), upstreamPeach], { defaultTheme: "light" })).toThrow(
      ThemeRefusedError,
    );
  });
});
