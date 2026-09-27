// SPDX-License-Identifier: Apache-2.0
// The text size step (#406): its ladder, and the step applied before first paint.
//
// One step per device sets every reading surface together: the document, its margin notes and the
// composer, and the chat. Chrome (buttons, menus, tabs, the navigator) never follows it; it follows
// browser and desktop zoom. The step is stored in this browser under `glosa_text_size`, like the
// appearance, and never leaves it.
//
// A classic script, not a module: shell.html loads it as a blocking script before the stylesheet,
// so a document is laid out at its size from the first frame and never reflows once it has
// painted. text-size.js imports it for the ladder; a second run applies the same step again.
//
// What it writes on <html>, which app.css turns into sizes:
// - `--reading-step`: the step itself, the document's size in pixels at the browser's default
//   font size;
// - `--chat-step`: one step under it, stopping at the ladder's foot (16 beside the default 18);
// - `--note-step`: two steps under it, stopping at the ladder's foot (15, today's note size,
//   beside 18);
// - `data-text-size`: the step, for anything that needs to read it back.
(function defineTextSize(root) {
  const key = "glosa_text_size";
  const ladder = Object.freeze([15, 16, 18, 20, 22, 24]);
  const defaultSize = 18;

  /** A step on the ladder, from a number or the string it is stored as. Anything else (nothing
   * stored, a size that was never on the ladder, text) is the default. */
  function resolve(value) {
    for (const size of ladder) if (value === size || value === String(size)) return size;
    return defaultSize;
  }

  /** The step `count` rungs under `size`, stopping at the ladder's foot. */
  function under(size, count) {
    return ladder[Math.max(0, ladder.indexOf(resolve(size)) - count)];
  }

  function apply(element, value) {
    const size = resolve(value);
    element.style.setProperty("--reading-step", String(size));
    element.style.setProperty("--chat-step", String(under(size, 1)));
    element.style.setProperty("--note-step", String(under(size, 2)));
    element.dataset.textSize = String(size);
    return size;
  }

  root.glosaTextSize = Object.freeze({ key, ladder, defaultSize, resolve, under, apply });

  if (typeof document === "undefined") return; // imported where there is no page to apply it to
  let stored = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    // Storage can be unavailable in hardened or private contexts. The default is safe.
  }
  apply(document.documentElement, stored);
})(globalThis);
