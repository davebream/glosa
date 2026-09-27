// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — what a theme file must be before glosa paints with it (#409): its sixteen slots,
// the contrast floor each role meets on the grounds it is actually drawn on, and the hue rules that
// keep the two hands apart. A theme that misses any of them is refused, and each refusal names the
// theme, the role, the measured ratio and the floor. Nothing here repairs a colour: a vermilion
// lightened until it passes is no longer the theme a person chose.
//
// Pure and dependency-free, so one module serves the test over the shipped theme files
// (packages/spa/test/themes.test.ts), the stylesheet they render to (stylesheet.js), and, once a
// theme can come from outside the repository, a check when the daemon loads it. The page itself
// never loads this: it paints from the stylesheet the checked files became.
//
// The contrast is the comps page's own arithmetic (docs/research/spikes/theming-comps.html): OKLCH
// to linear sRGB, clipped to the sRGB gamut, then the WCAG 2 relative luminance and ratio. It is
// computed in sRGB, so on a wide-gamut display the ratio on screen can differ slightly.

/** The sixteen colour slots a theme sets, in the order the stylesheet writes them. Everything else
 * glosa paints (washes, hover shades, the primary action, focus, shadows) is derived from these in
 * app.css and is not a theme's to set. */
export const SLOTS = Object.freeze([
  "bg", // paper: the document and the whole desk
  "surface", // code beds, the collection tray, the chat's own bubbles; what floats, in dark
  "surface-sunken", // hover beds under rows, tabs and segments; disabled fills
  "ink", // text, actions, the region rule in light
  "muted", // metadata, quotes, placeholders, resting icons
  "faint", // disabled text only, never live copy
  "border", // quiet rules inside a region
  "border-strong", // interactive edges
  "rule", // the hairline between the desk's regions
  "hand", // every mark a person makes
  "pencil", // the same mark before it is sent
  "session", // a session's mark on the page
  "danger",
  "warn",
  "ok",
  "scrim", // the dim behind a blocking dialog, and the one slot that may be translucent
]);

const EVERY_GROUND = Object.freeze(["bg", "surface", "surface-sunken"]);

/**
 * Where each role is drawn, and the floor it must clear there. A role is checked only on the
 * grounds glosa actually draws it on, read from app.css (#409): checking every role on every ground
 * would refuse glosa's own light pencil, which is 4.27:1 on the surface it is never drawn on.
 *
 * `elevated` is what floats above the work (the composer, a question at its passage, dialogs,
 * menus): the paper in a light theme and the surface in a dark one, as app.css's `--elevated-bg`
 * resolves. `floor` is the WCAG 2 ratio in every theme; `more` replaces it in a theme made for
 * `prefers-contrast: more` (`"contrast": "more"`).
 * @type {ReadonlyArray<{ role: string, as: "text" | "line", on: readonly string[], floor: number, more?: number }>}
 */
export const ROLE_CHECKS = Object.freeze([
  // Body text for hours, code on the surface, a row's label on its hover bed.
  { role: "ink", as: "text", on: EVERY_GROUND, floor: 7 },
  // Metadata everywhere, including the tab count and the diff's range on the sunken ground.
  { role: "muted", as: "text", on: EVERY_GROUND, floor: 4.5, more: 7 },
  // The note and its § address on the page and in the tray, an address on a selected Go to row;
  // as a line, the focus ring wherever focus lands and the unsaved dot on a hovered tab.
  { role: "hand", as: "text", on: EVERY_GROUND, floor: 4.5 },
  { role: "hand", as: "line", on: EVERY_GROUND, floor: 3, more: 4.5 },
  // The pencil is drawn only in the composer: its address, "You · not sent yet", the draft and the
  // rules above and under it.
  { role: "pencil", as: "text", on: ["elevated"], floor: 4.5 },
  { role: "pencil", as: "line", on: ["elevated"], floor: 3, more: 4.5 },
  // A session's label beside its bracket and in the tray; as a line, the bracket, the question
  // card's top rule (elevated, which is one of these grounds in either scheme) and a claimed tab.
  { role: "session", as: "text", on: ["bg", "surface"], floor: 4.5 },
  { role: "session", as: "line", on: EVERY_GROUND, floor: 3, more: 4.5 },
  // Errors in panes, dialogs and a hovered starred row.
  { role: "danger", as: "text", on: EVERY_GROUND, floor: 4.5 },
  { role: "danger", as: "line", on: EVERY_GROUND, floor: 3, more: 4.5 },
  // "Lost its place" in the rail and the tray; as a line, the stale dot on a hovered tree row or tab.
  { role: "warn", as: "text", on: ["bg", "surface"], floor: 4.5 },
  { role: "warn", as: "line", on: EVERY_GROUND, floor: 3, more: 4.5 },
  // "Applied" in the rail and the tray, and its dot.
  { role: "ok", as: "text", on: ["bg", "surface"], floor: 4.5 },
  { role: "ok", as: "line", on: ["bg", "surface"], floor: 3, more: 4.5 },
  // Interactive edges, on every ground including a hover bed.
  { role: "border-strong", as: "line", on: EVERY_GROUND, floor: 3 },
]);

/** Roles that carry live text. None of them may be mapped to `faint`, which is for disabled text
 * only and has no floor. */
const LIVE_TEXT_ROLES = Object.freeze(["ink", "muted", "hand", "pencil", "session", "danger", "warn", "ok"]);

/**
 * The two rules that keep a person's marks apart from a session's and from an error, whatever the
 * palette (DESIGN.md, The Two Hands Rule):
 * - the hand and session ink sit at least 90 degrees apart in OKLCH hue;
 * - danger is held apart from the hand by lightness, never by hue alone: their OKLCH lightness
 *   differs by at least 0.02. That is glosa's own dark gap (0.72 against 0.70), the smallest any
 *   shipped theme has, so it is a weak guarantee; what separates an error from a mark is that an
 *   error always arrives with a label or a shape (The Status Needs Shape Rule), which no colour
 *   check can see.
 */
export const HUE_RULES = Object.freeze({ handSessionDegrees: 90, handDangerLightness: 0.02 });

const THEME_KEYS = new Set(["id", "name", "scheme", "contrast", "media", "slots"]);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/;

/**
 * A colour literal a theme may use: `#rgb`, `#rrggbb` or `oklch(L C H)` with an optional `/ alpha`.
 * Returns its declared OKLCH (converted for hex), its linear sRGB clipped to the gamut, and its alpha;
 * null for anything else.
 * @param {string} value
 * @returns {{ lch: [number, number, number], linear: [number, number, number], alpha: number } | null}
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (HEX.test(text)) {
    const digits = text.length === 4 ? [...text.slice(1)].map((d) => d + d).join("") : text.slice(1);
    const n = Number.parseInt(digits, 16);
    const linear = /** @type {[number, number, number]} */ (
      [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((byte) => {
        const v = byte / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
    );
    return { lch: linearToOklch(linear), linear, alpha: 1 };
  }
  const match = text.match(OKLCH);
  if (!match) return null;
  const [l, c, h] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![l, c, h].every(Number.isFinite) || l > 1) return null;
  const alphaText = match[4];
  const alpha =
    alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return { lch: [l, c, h], linear: oklchToLinear(l, c, h), alpha };
}

/**
 * @param {number} L
 * @param {number} C
 * @param {number} h
 * @returns {[number, number, number]}
 */
function oklchToLinear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return /** @type {[number, number, number]} */ (rgb.map((v) => Math.min(1, Math.max(0, v))));
}

/**
 * @param {[number, number, number]} linear
 * @returns {[number, number, number]}
 */
function linearToOklch([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** @param {[number, number, number]} linear */
function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The WCAG 2 contrast ratio between two opaque colours, from 1 to 21.
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const first = parseColor(a);
  const second = parseColor(b);
  if (!first || !second) throw new TypeError(`not a colour a theme may use: ${first ? b : a}`);
  const [a1, b1] = [luminance(first.linear), luminance(second.linear)];
  return (Math.max(a1, b1) + 0.05) / (Math.min(a1, b1) + 0.05);
}

/**
 * The distance between two colours' OKLCH hues, from 0 to 180 degrees.
 * @param {string} a
 * @param {string} b
 */
export function hueDistance(a, b) {
  const d = Math.abs(/** @type {any} */ (parseColor(a)).lch[2] - /** @type {any} */ (parseColor(b)).lch[2]);
  return Math.min(d, 360 - d);
}

/**
 * Every slot the theme sets, with a reference to another slot (`"rule": "ink"`) replaced by that
 * slot's colour. A reference is written as a slot's name and renders as `var(--name)`, so glosa's
 * own light rule stays the ink it is, in print too. Unresolvable slots are left out.
 * @param {Record<string, string>} slots
 * @returns {Record<string, string>}
 */
export function resolveSlots(slots) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of Object.keys(slots)) {
    let value = slots[name];
    const seen = new Set([name]);
    while (typeof value === "string" && SLOTS.includes(value) && !seen.has(value)) {
      seen.add(value);
      value = slots[value];
    }
    if (typeof value === "string" && parseColor(value)) out[name] = value;
  }
  return out;
}

/** @param {number} n */
const ratioText = (n) => `${(Math.floor(n * 100) / 100).toFixed(2)}:1`;

/**
 * @typedef {{ theme: string, rule: string, role?: string, as?: string, ground?: string,
 *   ratio?: number, floor?: number, message: string }} Refusal
 */

/**
 * Every reason `theme` cannot be painted, as refusals that name the theme, the role, the measured
 * ratio and the floor. Empty when the theme passes. A theme with `media` (print) sets only some
 * slots over whichever theme is showing; it is checked for the roles and grounds it sets.
 * @param {any} theme
 * @returns {Refusal[]}
 */
export function checkTheme(theme) {
  /** @type {Refusal[]} */
  const refusals = [];
  const id = typeof theme?.id === "string" && theme.id ? theme.id : "(no id)";
  /** @param {Omit<Refusal, "theme" | "message">} detail @param {string} reason */
  const refuse = (detail, reason) =>
    refusals.push({ theme: id, ...detail, message: `theme "${id}" is refused: ${reason}` });

  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) {
    refuse({ rule: "shape" }, "a theme is a JSON object");
    return refusals;
  }
  for (const key of Object.keys(theme))
    if (!THEME_KEYS.has(key)) refuse({ rule: "shape" }, `"${key}" is not a theme field`);
  if (!/^[a-z][a-z0-9-]*$/.test(theme.id ?? ""))
    refuse({ rule: "shape" }, "its id must be lowercase letters, digits and hyphens");
  const overlay = theme.media !== undefined;
  if (overlay && theme.media !== "print") refuse({ rule: "shape" }, `media "${theme.media}" is not one glosa paints`);
  if (!overlay && theme.scheme !== "light" && theme.scheme !== "dark")
    refuse({ rule: "shape" }, 'its scheme must be "light" or "dark"');
  if (overlay && theme.scheme !== undefined)
    refuse({ rule: "shape" }, "a print theme paints over any scheme and names none");
  if (theme.contrast !== undefined && theme.contrast !== "more")
    refuse({ rule: "shape" }, 'contrast is "more" or absent');

  const slots = theme.slots;
  if (typeof slots !== "object" || slots === null || Array.isArray(slots)) {
    refuse({ rule: "shape" }, "its slots are a JSON object");
    return refusals;
  }
  for (const name of Object.keys(slots)) {
    const value = slots[name];
    if (!SLOTS.includes(name)) {
      refuse({ rule: "slot", role: name }, `"${name}" is not one of the sixteen slots`);
      continue;
    }
    if (typeof value === "string" && SLOTS.includes(value)) {
      if (!(value in slots)) refuse({ rule: "slot", role: name }, `${name} refers to ${value}, which it does not set`);
      continue;
    }
    const colour = parseColor(value);
    if (!colour)
      refuse({ rule: "slot", role: name }, `${name} is ${JSON.stringify(value)}, not a hex or oklch() colour`);
    else if (colour.alpha !== 1 && name !== "scrim") refuse({ rule: "slot", role: name }, `${name} must be opaque`);
  }
  if (!overlay)
    for (const name of SLOTS) if (!(name in slots)) refuse({ rule: "slot", role: name }, `it does not set ${name}`);

  const colours = resolveSlots(slots);
  for (const name of Object.keys(slots))
    if (SLOTS.includes(name) && !(name in colours) && typeof slots[name] === "string" && SLOTS.includes(slots[name]))
      refuse({ rule: "slot", role: name }, `${name} refers in a circle and has no colour`);

  // Faint is exempt from every floor, so no live text may be faint: not by name, not by colour.
  if ("faint" in colours)
    for (const role of LIVE_TEXT_ROLES) {
      if (!(role in slots)) continue;
      const colour = colours[role];
      const mapped =
        slots[role] === "faint" || (colour !== undefined && contrastRatio(colour, colours.faint) < 1 + 1e-9);
      if (mapped)
        refuse(
          { rule: "faint", role },
          `${role} is mapped to faint, which is for disabled text only; live text needs its own colour`,
        );
    }

  const more = theme.contrast === "more";
  for (const check of ROLE_CHECKS) {
    const colour = colours[check.role];
    if (!colour) continue;
    const floor = more && check.more !== undefined ? check.more : check.floor;
    for (const groundName of check.on) {
      const slot = groundName === "elevated" ? (theme.scheme === "dark" ? "surface" : "bg") : groundName;
      if (overlay && groundName === "elevated") continue;
      const ground = colours[slot];
      if (!ground) continue;
      const ratio = contrastRatio(colour, ground);
      if (ratio < floor)
        refuse(
          { rule: "contrast", role: check.role, as: check.as, ground: groundName, ratio, floor },
          `${check.role} is ${ratioText(ratio)} as ${check.as} on ${groundName === "elevated" ? `elevated (${slot})` : groundName}, under its floor of ${floor}:1`,
        );
    }
  }

  if (colours.hand && colours.session) {
    const degrees = hueDistance(colours.hand, colours.session);
    if (degrees < HUE_RULES.handSessionDegrees)
      refuse(
        { rule: "hue", role: "session" },
        `the hand and session ink are ${Math.round(degrees)}° apart in hue; they must be at least ${HUE_RULES.handSessionDegrees}° apart`,
      );
  }
  if (colours.hand && colours.danger) {
    const gap = Math.abs(
      /** @type {any} */ (parseColor(colours.hand)).lch[0] - /** @type {any} */ (parseColor(colours.danger)).lch[0],
    );
    if (gap + 1e-9 < HUE_RULES.handDangerLightness)
      refuse(
        { rule: "lightness", role: "danger" },
        `danger is ${gap.toFixed(3)} from the hand in lightness; it must differ by at least ${HUE_RULES.handDangerLightness}`,
      );
  }
  return refusals;
}

/** A theme glosa will not paint, carrying every refusal. */
export class ThemeRefusedError extends Error {
  /** @param {Refusal[]} refusals */
  constructor(refusals) {
    super(refusals.map((refusal) => refusal.message).join("\n"));
    this.name = "ThemeRefusedError";
    this.refusals = refusals;
  }
}

/**
 * Returns `theme` unchanged when it passes, and throws a ThemeRefusedError naming every refusal when
 * it does not. It never returns a corrected theme.
 * @template T
 * @param {T} theme
 * @returns {T}
 */
export function validateTheme(theme) {
  const refusals = checkTheme(theme);
  if (refusals.length > 0) throw new ThemeRefusedError(refusals);
  return theme;
}
