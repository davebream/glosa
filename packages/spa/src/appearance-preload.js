// SPDX-License-Identifier: Apache-2.0
// Applies the persisted appearance before CSS loads, so explicit light/dark overrides never
// flash through the system theme while the SPA modules are still being fetched.
(function preloadAppearance() {
  const key = "glosa_appearance";
  let preference = "system";
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
  } catch {
    // Storage can be unavailable in hardened/private contexts. System is the safe default.
  }

  const systemIsDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
  const root = document.documentElement;
  root.dataset.appearance = preference;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
})();
