// SPDX-License-Identifier: Apache-2.0
//
// Renders glosa's shipped theme files (packages/spa/src/themes/*.json) into the stylesheet the page
// loads, packages/spa/src/themes.css (#409). The stylesheet is checked in, so the SPA stays plain
// files the daemon serves with no build step; packages/spa/test/themes.test.ts fails whenever the
// file on disk is not what the theme files render to.
//
//   bun run themes:render          write packages/spa/src/themes.css
//   bun run themes:render --check  exit 1 if it is out of date, writing nothing
//
// Every theme is validated before anything is written. A refused theme prints each refusal (the
// theme, the role, the ratio and the floor) and writes nothing.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderThemeStylesheet } from "../packages/spa/src/themes/stylesheet.js";
import { ThemeRefusedError } from "../packages/spa/src/themes/validate.js";

export const THEMES_DIR = resolve(import.meta.dir, "../packages/spa/src/themes");
export const STYLESHEET_PATH = resolve(import.meta.dir, "../packages/spa/src/themes.css");
/** The theme the page paints before anything is resolved: glosa's own light, the one list's
 * default (appearance-list.js). */
export const DEFAULT_THEME = "light";

/** A theme file as parsed; validate.js decides whether glosa will paint it. */
export type ThemeFile = { id: string; [field: string]: unknown };

/** Every shipped theme file, in file-name order. A theme's id is its file name. */
export function readShippedThemes(): ThemeFile[] {
  return readdirSync(THEMES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const theme = JSON.parse(readFileSync(join(THEMES_DIR, name), "utf8"));
      const id = name.slice(0, -".json".length);
      if (theme.id !== id) throw new Error(`${name} carries the id "${theme.id}"; a theme's id is its file name`);
      return theme;
    });
}

/** What packages/spa/src/themes.css must contain. */
export function renderShippedStylesheet(): string {
  return renderThemeStylesheet(readShippedThemes(), { defaultTheme: DEFAULT_THEME });
}

if (import.meta.main) {
  let css: string;
  try {
    css = renderShippedStylesheet();
  } catch (error) {
    if (error instanceof ThemeRefusedError) {
      for (const refusal of error.refusals) console.error(refusal.message);
      process.exit(1);
    }
    throw error;
  }
  if (process.argv.includes("--check")) {
    const current = readFileSync(STYLESHEET_PATH, "utf8");
    if (current !== css) {
      console.error("packages/spa/src/themes.css is out of date: run `bun run themes:render`");
      process.exit(1);
    }
  } else {
    writeFileSync(STYLESHEET_PATH, css);
    console.log(`wrote ${STYLESHEET_PATH}`);
  }
}
