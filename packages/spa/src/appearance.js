// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — appearance preference state. This module owns the durable, non-sensitive
// localStorage preference under its own key; bootstrap owns the pairing token separately, under
// `glosa_token` in the same origin-scoped store.

// The one list of appearances (#405), a classic script the first-paint preload reads too. Imported
// for its side effect; it publishes `globalThis.glosaAppearances`. Every function below reads the
// list when it is called, never a copy taken at import.
import "./appearance-list.js";

export const APPEARANCE_STORAGE_KEY = "glosa_appearance";

/** The listed appearances, in chooser order: `{ id, scheme, label, settingsLabel }`. */
export function appearanceList() {
  return globalThis.glosaAppearances.list;
}

const ICONS = {
  system:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="10.5" rx="1.5"/><path d="M7 17h6M10 13.5V17"/></svg>',
  light:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.25"/><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16"/></svg>',
  dark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.8 12.3A7 7 0 0 1 7.7 3.2 7 7 0 1 0 16.8 12.3Z"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.2 10.2 3.1 3.1 6.5-6.6"/></svg>',
};

export function isAppearance(value) {
  return globalThis.glosaAppearances.find(value) !== null;
}

/** The theme id a preference paints with: itself, or for "Use system setting" the entry the
 * operating system's scheme resolves to. */
export function resolveAppearance(preference, systemIsDark) {
  return globalThis.glosaAppearances.resolve(preference, systemIsDark).theme;
}

/** True for an entry that resolves through the operating system ("Use system setting"). */
function followsSystem(id) {
  const entry = globalThis.glosaAppearances.find(id);
  return entry !== null && !entry.scheme;
}

export function readAppearance(storage) {
  const fallback = appearanceList()[0].id;
  try {
    const stored = storage?.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearance(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function fallbackMediaQuery() {
  return {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
}

/**
 * Creates the page-lifetime appearance controller. Explicit preferences ignore media-query
 * changes; system preference resolves every change event immediately. Storage failure never
 * prevents a session-local appearance change.
 */
export function createAppearanceController({ root, storage, mediaQuery } = {}) {
  const targetRoot = root ?? document.documentElement;
  let targetStorage = storage;
  if (targetStorage === undefined) {
    try {
      targetStorage = window.localStorage;
    } catch {
      targetStorage = undefined;
    }
  }
  const targetMedia =
    mediaQuery ??
    (typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : fallbackMediaQuery());
  const listeners = new Set();
  let preference = readAppearance(targetStorage);

  /** `resolved` is the theme id that paints; `scheme` its "light" or "dark". */
  function getSnapshot() {
    const { theme, scheme } = globalThis.glosaAppearances.resolve(preference, Boolean(targetMedia.matches));
    return { preference, resolved: theme, scheme };
  }

  function apply(notify) {
    const snapshot = getSnapshot();
    targetRoot.dataset.appearance = snapshot.preference;
    targetRoot.dataset.theme = snapshot.resolved;
    targetRoot.dataset.scheme = snapshot.scheme;
    targetRoot.style.colorScheme = snapshot.scheme;
    if (notify) for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function onSystemChange() {
    if (followsSystem(preference)) apply(true);
  }

  targetMedia.addEventListener?.("change", onSystemChange);
  apply(false);

  return {
    getSnapshot,
    setPreference(next) {
      if (!isAppearance(next)) throw new TypeError(`Unknown appearance: ${next}`);
      preference = next;
      try {
        targetStorage?.setItem(APPEARANCE_STORAGE_KEY, preference);
      } catch {
        // Applying the choice for this page remains useful when persistence is unavailable.
      }
      return apply(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(getSnapshot());
      return () => listeners.delete(listener);
    },
    destroy() {
      targetMedia.removeEventListener?.("change", onSystemChange);
      listeners.clear();
    },
  };
}

/**
 * The page's paper, the body's background (`--bg`), as `#rrggbb`. A 1x1 canvas converts whatever
 * CSS colour the theme uses (OKLCH today) to the sRGB bytes a native window takes. Null when there
 * is no body or no 2D context.
 */
export function readPaperColor(doc = document) {
  const context = doc.body ? doc.createElement("canvas").getContext("2d") : null;
  if (!context) return null;
  context.fillStyle = getComputedStyle(doc.body).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Tells the desktop shell what the page resolved (#405), so the window's first frame and the
 * native UI (dialogs, menus, the title bar) follow glosa rather than the operating system. Only
 * inside the shell: a browser tab has no `reportAppearance`. The message is `{ source, scheme,
 * background }`: whether the page follows the operating system or fixed a scheme ("system",
 * "light" or "dark"), the scheme it paints with, and its paper as `#rrggbb`. Never a path or a
 * theme name (A3 §4b). Returns an unsubscribe.
 */
export function reportAppearanceToShell(controller, shell, { readPaper = () => readPaperColor() } = {}) {
  if (typeof shell?.reportAppearance !== "function") return () => {};
  return controller.subscribe(({ preference, scheme }) => {
    const background = readPaper();
    if (!background) return;
    const source = followsSystem(preference) ? "system" : scheme;
    Promise.resolve(shell.reportAppearance({ source, scheme, background })).catch(() => {
      // A refused or failed report leaves the window as it was; the page itself is unaffected.
    });
  });
}

function icon(name, className) {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = ICONS[name];
  return span;
}

/**
 * Mounts the quiet-utility trigger (labelled in compact menus) and its top-layer popover.
 * @param {any} container
 * @param {any} controller
 * @param {{ overlayHost?: any, returnFocus?: any }} [options]
 */
export function mountAppearanceControl(container, controller, { overlayHost = container, returnFocus } = {}) {
  const trigger = document.createElement("button");
  trigger.className = "glosa-appearance-trigger";
  trigger.type = "button";
  trigger.setAttribute("popovertarget", "glosa-appearance-menu");

  const triggerIcon = icon("light", "glosa-appearance-icon");
  trigger.append(
    triggerIcon,
    Object.assign(document.createElement("span"), {
      className: "glosa-appearance-trigger-label",
      textContent: "Appearance",
    }),
  );

  const menu = document.createElement("div");
  menu.id = "glosa-appearance-menu";
  menu.className = "glosa-appearance-menu";
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Appearance");

  const rows = new Map();
  for (const { id: preference, scheme, label } of appearanceList()) {
    const row = document.createElement("button");
    row.className = "glosa-appearance-option";
    row.type = "button";
    row.setAttribute("role", "menuitemradio");
    row.dataset.appearance = preference;
    row.append(
      // The icon names the scheme (a sun, a moon), and the system entry its screen.
      icon(scheme ?? "system", "glosa-appearance-option-icon"),
      Object.assign(document.createElement("span"), {
        className: "glosa-appearance-option-label",
        textContent: label,
      }),
      icon("check", "glosa-appearance-check"),
    );
    row.addEventListener("click", () => {
      controller.setPreference(preference);
      menu.hidePopover?.();
      (returnFocus ?? trigger).focus();
    });
    rows.set(preference, row);
    menu.append(row);
  }

  menu.addEventListener("toggle", (event) => {
    if (event.newState === "open") rows.get(controller.getSnapshot().preference)?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...rows.values()];
    const current = Math.max(0, options.indexOf(document.activeElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });

  container.append(trigger);
  overlayHost.append(menu);

  const unsubscribe = controller.subscribe(({ preference, scheme }) => {
    triggerIcon.innerHTML = ICONS[scheme];
    const name = followsSystem(preference) ? `System (${scheme})` : preference;
    trigger.setAttribute("aria-label", `Appearance: ${name}`);
    trigger.title = `Appearance: ${name}`;
    for (const [value, row] of rows) {
      const selected = value === preference;
      row.setAttribute("aria-checked", String(selected));
      row.dataset.selected = String(selected);
    }
  });

  return () => {
    unsubscribe();
    menu.remove();
    trigger.remove();
  };
}
