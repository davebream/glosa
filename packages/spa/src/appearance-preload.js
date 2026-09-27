// SPDX-License-Identifier: Apache-2.0
// Applies the persisted appearance before CSS loads, so explicit light/dark overrides, a chosen
// palette and the operating system's request for more contrast never flash through the default
// theme while the SPA modules are still being fetched. Which ids exist and which theme and scheme
// each resolves to come from the one list (appearance-list.js, loaded just before this script);
// nothing here names an appearance.
(function preloadAppearance() {
  const appearances = globalThis.glosaAppearances;
  if (!appearances) return; // the list did not load: the stylesheet's light default paints
  let stored = null;
  let palette = null;
  try {
    stored = window.localStorage.getItem("glosa_appearance");
    palette = window.localStorage.getItem("glosa_palette");
  } catch {
    // Storage can be unavailable in hardened/private contexts. The list's defaults are safe.
  }

  const matches = (query) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const resolved = appearances.resolve(stored, matches("(prefers-color-scheme: dark)"), {
    palette,
    moreContrast: matches("(prefers-contrast: more)"),
  });
  const root = document.documentElement;
  root.dataset.appearance = resolved.preference;
  root.dataset.palette = resolved.palette;
  root.dataset.theme = resolved.theme;
  // The scheme is separate from which theme is active, so CSS can select what every dark theme
  // shares (`:root[data-scheme="dark"]`) without naming each one.
  root.dataset.scheme = resolved.scheme;
  root.style.colorScheme = resolved.scheme;
})();
