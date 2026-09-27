// SPDX-License-Identifier: Apache-2.0
// The one list of appearances (#405). The first-paint preload (appearance-preload.js), the
// workspace popover (appearance.js) and Settings > Appearance (agent-settings.js) all read it and
// keep no copy of their own, so adding an entry here is the only edit an appearance needs to
// resolve before first paint and to appear in both choosers.
//
// A classic script, not a module: the preload must read it synchronously, before any CSS or
// module loads, so shell.html loads it first as a blocking script. appearance.js imports it for
// its side effect, which is also how the SPA's tests reach it; a second run only reassigns the
// same frozen list.
//
// An entry is `{ id, scheme, label, settingsLabel }`:
// - `id` is the stored preference and, once resolved, the `data-theme` value on <html>.
// - `scheme` is "light" or "dark": the `color-scheme` and `data-scheme` it paints with. The
//   system entry has none and names instead which entry each operating-system scheme resolves to
//   (`follows`), read through `prefers-color-scheme`.
// - `label` is the popover's word; `settingsLabel` is Settings > Appearance's.
// The first entry is the default when nothing, or something unlisted, is stored.
(function defineAppearances(root) {
  const list = Object.freeze([
    Object.freeze({
      id: "system",
      scheme: null,
      follows: Object.freeze({ light: "light", dark: "dark" }),
      label: "System",
      settingsLabel: "Use system setting",
    }),
    Object.freeze({ id: "light", scheme: "light", label: "Light", settingsLabel: "Light" }),
    Object.freeze({ id: "dark", scheme: "dark", label: "Dark", settingsLabel: "Dark" }),
  ]);

  function find(id) {
    for (const entry of list) if (entry.id === id) return entry;
    return null;
  }

  /** Resolves any stored value against the operating system's scheme: `{ preference, theme,
   * scheme }`, where `preference` is a listed id (the default for anything else), `theme` the id
   * that paints and `scheme` its "light" or "dark". */
  function resolve(stored, systemIsDark) {
    const preference = find(stored) ?? list[0];
    const theme = preference.scheme
      ? preference
      : (find(systemIsDark ? preference.follows.dark : preference.follows.light) ?? preference);
    return { preference: preference.id, theme: theme.id, scheme: theme.scheme ?? (systemIsDark ? "dark" : "light") };
  }

  root.glosaAppearances = Object.freeze({ list, find, resolve });
})(globalThis);
