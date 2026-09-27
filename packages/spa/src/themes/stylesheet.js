// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — the checked theme files as the one stylesheet the page loads, /app/themes.css
// (#409). The stylesheet is checked in beside the files it comes from, so the SPA stays static
// files with no build step: `bun run themes:render` writes it, and packages/spa/test/themes.test.ts
// fails whenever the file on disk is not what the theme files render to.
//
// Every theme is validated first (validate.js), and a refused theme stops the render: nothing is
// written for it and nothing is repaired.

import { SLOTS, validateTheme } from "./validate.js";

const HEADER = `/* SPDX-License-Identifier: Apache-2.0 */
/* @glosa/spa: the theme slots (#409). GENERATED from packages/spa/src/themes/*.json by
   \`bun run themes:render\`. Edit a theme file and render again; never edit this file by hand.
   packages/spa/test/themes.test.ts fails when the two disagree, and refuses any theme below its
   contrast floors (packages/spa/src/themes/validate.js).

   A theme sets the sixteen slots on <html> when \`data-theme\` names it, which the one list of
   appearances (appearance-list.js) resolves before first paint, and on a Settings swatch that names
   it (\`data-theme-swatch\`). The first theme is also the page's own default, before anything is
   resolved. What is derived from the slots (washes, hover shades, the primary action, the focus
   ring, shadows) lives in app.css, which reads the slots and never sets them. */
`;

/** @param {string} value */
const cssValue = (value) => (SLOTS.includes(value) ? `var(--${value})` : value);

/** @param {{ slots: Record<string, string> }} theme */
function declarations(theme) {
  return SLOTS.filter((name) => name in theme.slots)
    .map((name) => `  --${name}: ${cssValue(/** @type {string} */ (theme.slots[name]))};`)
    .join("\n");
}

/**
 * Renders validated themes into the stylesheet's text. `defaultTheme` also binds to a bare `:root`,
 * so the page paints it before (or without) a resolved `data-theme`. Themes with `media` (print)
 * come last, inside their media query, over every theme.
 * @param {ReadonlyArray<any>} themes
 * @param {{ defaultTheme: string }} options
 * @returns {string}
 */
export function renderThemeStylesheet(themes, { defaultTheme }) {
  for (const theme of themes) validateTheme(theme);
  const ids = themes.map((theme) => theme.id);
  if (new Set(ids).size !== ids.length) throw new Error(`two theme files share an id: ${ids.join(", ")}`);
  const screen = themes.filter((theme) => theme.media === undefined);
  const first = screen.find((theme) => theme.id === defaultTheme);
  if (!first) throw new Error(`the default theme "${defaultTheme}" is not among the themes`);
  const ordered = [first, ...screen.filter((theme) => theme !== first)];

  const blocks = ordered.map((theme) => {
    const selectors = [
      ...(theme === first ? [":root"] : []),
      `:root[data-theme="${theme.id}"]`,
      `[data-theme-swatch="${theme.id}"]`,
    ];
    return `/* ${theme.name ?? theme.id} */\n${selectors.join(",\n")} {\n${declarations(theme)}\n}\n`;
  });
  for (const theme of themes.filter((theme) => theme.media !== undefined)) {
    const body = declarations(theme).replaceAll("\n", "\n  ");
    blocks.push(
      `/* ${theme.name ?? theme.id}.
   It sets only these slots. Marks do not print, so the hand, pencil and session keep the values
   of the theme that is showing. */
@media ${theme.media} {\n  :root,\n  :root[data-theme] {\n  ${body}\n  }\n}\n`,
    );
  }
  return `${HEADER}\n${blocks.join("\n")}`;
}
