// SPDX-License-Identifier: Apache-2.0
// The one list of appearances (#405, #409). The first-paint preload (appearance-preload.js), the
// workspace popover (appearance.js) and Settings > Appearance (agent-settings.js) all read it and
// keep no copy of their own, so adding an entry here is the only edit an appearance needs to
// resolve before first paint and to appear where it is chosen.
//
// A classic script, not a module: the preload must read it synchronously, before any CSS or
// module loads, so shell.html loads it first as a blocking script. appearance.js imports it for
// its side effect, which is also how the SPA's tests reach it; a second run only reassigns the
// same frozen lists.
//
// An appearance is two choices, each stored on its own:
// - A mode (`list`) says which scheme paints: `{ id, scheme, label, settingsLabel }`. `scheme` is
//   "light" or "dark"; the system entry has none and follows `prefers-color-scheme`. `label` is the
//   popover's word, `settingsLabel` Settings > Appearance's. The stored ids ("system", "light",
//   "dark") are the ones every earlier glosa stored.
// - A palette (`palettes`) says which colours paint it: `{ id, label, credit, themes,
//   moreContrast? }`. `themes` names the theme file (packages/spa/src/themes/<id>.json, rendered
//   into themes.css) for each scheme; `credit` is its line in Settings. A palette with
//   `moreContrast` is shown as that palette instead while the operating system asks for more
//   contrast (`prefers-contrast: more`); a palette without it stays as chosen.
// Adding a palette is one entry here plus its two theme files.
// The first entry of each list is the default when nothing, or something unlisted, is stored.
(function defineAppearances(root) {
  const list = Object.freeze([
    Object.freeze({ id: "system", scheme: null, label: "System", settingsLabel: "Use system setting" }),
    Object.freeze({ id: "light", scheme: "light", label: "Light", settingsLabel: "Light" }),
    Object.freeze({ id: "dark", scheme: "dark", label: "Dark", settingsLabel: "Dark" }),
  ]);
  const palettes = Object.freeze([
    Object.freeze({
      id: "glosa",
      label: "glosa",
      credit: "glosa's own · warm paper, near-black ink, your marks in vermilion",
      themes: Object.freeze({ light: "light", dark: "dark" }),
      moreContrast: "high-contrast",
    }),
    Object.freeze({
      id: "high-contrast",
      label: "High contrast",
      credit: "glosa's own · stronger ink, marks and edges on the same paper",
      themes: Object.freeze({ light: "high-contrast-light", dark: "high-contrast-dark" }),
    }),
  ]);

  function find(id) {
    for (const entry of list) if (entry.id === id) return entry;
    return null;
  }

  function findPalette(id) {
    for (const entry of palettes) if (entry.id === id) return entry;
    return null;
  }

  /** Resolves any stored mode and palette against the operating system: `{ preference, palette,
   * painting, theme, scheme }`. `preference` and `palette` are listed ids (the defaults for anything
   * else); `painting` is the palette that paints, which is the chosen one unless the system asks for
   * more contrast and it has a `moreContrast` palette; `theme` is the theme id that paints and
   * `scheme` its "light" or "dark". */
  function resolve(stored, systemIsDark, { palette: storedPalette = null, moreContrast = false } = {}) {
    const preference = find(stored) ?? list[0];
    const scheme = preference.scheme ?? (systemIsDark ? "dark" : "light");
    const chosen = findPalette(storedPalette) ?? palettes[0];
    const painting = (moreContrast && findPalette(chosen.moreContrast)) || chosen;
    return {
      preference: preference.id,
      palette: chosen.id,
      painting: painting.id,
      theme: painting.themes[scheme],
      scheme,
    };
  }

  root.glosaAppearances = Object.freeze({ list, palettes, find, findPalette, resolve });
})(globalThis);
