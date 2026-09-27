// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the text size step (#406): one size per device for every reading surface, the
// page-lifetime store that holds it, and the stepper that chooses it. The same stepper sits in the
// document's More menu, where reading preferences live (DESIGN.md: never in primary chrome), and in
// Settings > Appearance.
//
// Storage is the same non-sensitive localStorage appearance.js and style.js use. A bad stored value
// reads as the default, and a storage failure never prevents a page-local change.

// The ladder and the first-paint application (text-size-preload.js), a classic script shell.html
// loads before the stylesheet. Imported for its side effect: it publishes
// `globalThis.glosaTextSize`, which everything below reads.
import "./text-size-preload.js";

const ladder = () => globalThis.glosaTextSize;

export const TEXT_SIZE_STORAGE_KEY = ladder().key;
/** The steps a reader can choose, smallest first, in pixels at the browser's default font size. */
export const TEXT_SIZES = ladder().ladder;
export const DEFAULT_TEXT_SIZE = ladder().defaultSize;

/** The stored step, or the default for anything unlisted or unreadable. */
export function readTextSize(storage) {
  try {
    return ladder().resolve(storage?.getItem(TEXT_SIZE_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/**
 * Creates the page-lifetime text size store and applies its step to `root` (<html>). Every reading
 * surface on the page reads the step from there through app.css, so one store serves every pane,
 * the chat and Settings.
 *
 * `beforeChange` listeners run just before the page takes a new size, while it is still laid out
 * at the old one: a pane records which block the reader is on there, and puts it back after.
 */
export function createTextSizeStore({ root, storage } = {}) {
  const target = root ?? document.documentElement;
  let targetStorage = storage;
  if (targetStorage === undefined) {
    try {
      targetStorage = window.localStorage;
    } catch {
      targetStorage = undefined;
    }
  }
  /** The page's truth. It holds the choice for this page even when persisting it failed. */
  let size = readTextSize(targetStorage);
  ladder().apply(target, size);
  /** @type {Set<(size: number) => void>} */
  const listeners = new Set();
  /** @type {Set<(next: number) => void>} */
  const preparers = new Set();

  function set(next) {
    if (!TEXT_SIZES.includes(next)) throw new TypeError(`Unknown text size: ${next}`);
    if (next === size) return size;
    for (const prepare of preparers) prepare(next);
    size = next;
    ladder().apply(target, size);
    try {
      // The default leaves nothing behind.
      if (size === DEFAULT_TEXT_SIZE) targetStorage?.removeItem(TEXT_SIZE_STORAGE_KEY);
      else targetStorage?.setItem(TEXT_SIZE_STORAGE_KEY, String(size));
    } catch {
      // The page-local choice above still applies.
    }
    for (const listener of listeners) listener(size);
    return size;
  }

  return {
    get: () => size,
    set,
    /** One rung up (1) or down (-1), stopping at the ends of the ladder. */
    step(direction) {
      const at = TEXT_SIZES.indexOf(size) + Math.sign(direction);
      return set(TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, at))]);
    },
    reset: () => set(DEFAULT_TEXT_SIZE),
    /** Calls `listener` with the step now and after every change. Returns an unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      listener(size);
      return () => listeners.delete(listener);
    },
    /** Calls `prepare` with the next step just before the page takes it. Returns an unsubscribe. */
    beforeChange(prepare) {
      preparers.add(prepare);
      return () => preparers.delete(prepare);
    },
  };
}

const MINUS = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7"/></svg>';
const PLUS = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7M6 2.5v7"/></svg>';
/** A large and a small A, the usual mark for text size, drawn like the pane menu's other icons. */
const TEXT_SIZE_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 16.5 7.5 3.8l5 12.7M4.4 11.8h6.2M12.9 16.5l2.7-7 2.7 7M13.9 14h3.4"/></svg>';

let mounted = 0;

/**
 * Mounts the text size stepper into `container`: the label "Text size", then − value + in one
 * outline track, and "Reset" whenever the step is not the default.
 *
 * The value is the control, a spinbutton with the step as its value: the arrow keys and Page Up and
 * Page Down step it, Home and End go to the ends of the ladder. − and + are for the pointer (outside
 * the tab order, as the ARIA spinbutton pattern has them), and the one that would do nothing at an
 * end of the ladder is disabled and says so. Changes apply at once; nothing closes around them.
 *
 * `variant` is "menu" (one row of the document's More menu) or "settings" (Settings > Appearance).
 * `describedBy` names an element that says what the step sets, read after the value. The container
 * is no group of its own: the spinbutton carries the name, and naming both says it twice.
 * @param {HTMLElement} container
 * @param {ReturnType<typeof createTextSizeStore>} store
 * @param {{ variant?: "menu" | "settings", describedBy?: string }} [options]
 */
export function mountTextSizeControl(container, store, { variant = "menu", describedBy } = {}) {
  mounted += 1;
  const labelId = `glosa-text-size-label-${mounted}`;
  container.classList.add("glosa-text-size");
  container.dataset.variant = variant;

  const label = document.createElement("span");
  label.className = "glosa-text-size-label";
  label.id = labelId;
  label.textContent = "Text size";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "glosa-text-size-reset";
  reset.textContent = "Reset";
  reset.setAttribute("aria-label", `Reset text size to ${DEFAULT_TEXT_SIZE}`);

  const stepButton = (direction, name, icon) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "glosa-stepper-step";
    button.dataset.step = direction > 0 ? "up" : "down";
    button.tabIndex = -1;
    button.setAttribute("aria-label", name);
    button.innerHTML = icon;
    // A pointer press steps the size without taking focus from wherever it was.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => store.step(direction));
    return button;
  };
  const smaller = stepButton(-1, "Smaller text", MINUS);
  const larger = stepButton(1, "Larger text", PLUS);

  const value = document.createElement("span");
  value.className = "glosa-stepper-value";
  value.setAttribute("role", "spinbutton");
  value.tabIndex = 0;
  value.setAttribute("aria-labelledby", labelId);
  if (describedBy) value.setAttribute("aria-describedby", describedBy);
  value.setAttribute("aria-valuemin", String(TEXT_SIZES[0]));
  value.setAttribute("aria-valuemax", String(TEXT_SIZES.at(-1)));
  value.addEventListener("keydown", (event) => {
    const moves = { ArrowUp: 1, ArrowRight: 1, PageUp: 1, ArrowDown: -1, ArrowLeft: -1, PageDown: -1 };
    if (event.key in moves) store.step(moves[/** @type {keyof typeof moves} */ (event.key)]);
    else if (event.key === "Home") store.set(TEXT_SIZES[0]);
    else if (event.key === "End") store.set(TEXT_SIZES.at(-1));
    else return;
    // The keys are the spinbutton's: the menu around it must not also move focus on them.
    event.preventDefault();
    event.stopPropagation();
  });

  reset.addEventListener("click", () => {
    store.reset();
    // Reset hides itself at the default, so focus goes to the control it reset.
    value.focus({ preventScroll: true });
  });

  const stepper = document.createElement("span");
  stepper.className = "glosa-stepper";
  stepper.append(smaller, value, larger);

  if (variant === "menu") {
    const icon = document.createElement("span");
    icon.className = "glosa-text-size-icon";
    icon.innerHTML = TEXT_SIZE_ICON;
    // Reset sits before the stepper, so the stepper holds still at the row's end when it appears.
    container.append(icon, label, reset, stepper);
  } else {
    container.append(label, stepper, reset);
  }

  function paint(size) {
    value.textContent = String(size);
    value.setAttribute("aria-valuenow", String(size));
    value.setAttribute("aria-valuetext", size === DEFAULT_TEXT_SIZE ? `${size}, the default` : String(size));
    smaller.disabled = size === TEXT_SIZES[0];
    larger.disabled = size === TEXT_SIZES.at(-1);
    smaller.title = smaller.disabled ? "This is the smallest size" : "Smaller text";
    larger.title = larger.disabled ? "This is the largest size" : "Larger text";
    reset.hidden = size === DEFAULT_TEXT_SIZE;
  }
  const unsubscribe = store.subscribe(paint);

  return {
    destroy() {
      unsubscribe();
      container.replaceChildren();
    },
  };
}
