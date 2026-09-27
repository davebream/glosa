// SPDX-License-Identifier: Apache-2.0
// Applies the persisted appearance before CSS loads, so explicit light/dark overrides never
// flash through the system theme while the SPA modules are still being fetched. Which ids exist
// and which scheme each paints with come from the one list (appearance-list.js, loaded just
// before this script); nothing here names an appearance.
(function preloadAppearance() {
  const appearances = globalThis.glosaAppearances;
  if (!appearances) return; // the list did not load: the stylesheet's light default paints
  const key = "glosa_appearance";
  let stored = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // Storage can be unavailable in hardened/private contexts. The list's default is safe.
  }

  const systemIsDark =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = appearances.resolve(stored, systemIsDark);
  const root = document.documentElement;
  root.dataset.appearance = resolved.preference;
  root.dataset.theme = resolved.theme;
  // The scheme is separate from which theme is active, so CSS can select what every dark theme
  // shares (`:root[data-scheme="dark"]`) without naming each one.
  root.dataset.scheme = resolved.scheme;
  root.style.colorScheme = resolved.scheme;
})();
