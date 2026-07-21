// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — appearance preference state. This module owns the durable, non-sensitive
// localStorage preference; bootstrap owns the pairing token separately in sessionStorage.

export const APPEARANCE_STORAGE_KEY = "glosa_appearance";
export const APPEARANCES = Object.freeze(["system", "light", "dark"]);

const ICONS = {
  system:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="10.5" rx="1.5"/><path d="M7 17h6M10 13.5V17"/></svg>',
  light:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.25"/><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16"/></svg>',
  dark:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.8 12.3A7 7 0 0 1 7.7 3.2 7 7 0 1 0 16.8 12.3Z"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.2 10.2 3.1 3.1 6.5-6.6"/></svg>',
};

export function isAppearance(value) {
  return APPEARANCES.includes(value);
}

export function resolveAppearance(preference, systemIsDark) {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemIsDark ? "dark" : "light";
}

export function readAppearance(storage) {
  try {
    const stored = storage?.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearance(stored) ? stored : "system";
  } catch {
    return "system";
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
  const targetMedia = mediaQuery ?? (typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : fallbackMediaQuery());
  const listeners = new Set();
  let preference = readAppearance(targetStorage);

  function getSnapshot() {
    return {
      preference,
      resolved: resolveAppearance(preference, Boolean(targetMedia.matches)),
    };
  }

  function apply(notify) {
    const snapshot = getSnapshot();
    targetRoot.dataset.appearance = snapshot.preference;
    targetRoot.dataset.theme = snapshot.resolved;
    targetRoot.style.colorScheme = snapshot.resolved;
    if (notify) for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function onSystemChange() {
    if (preference === "system") apply(true);
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

function icon(name, className) {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = ICONS[name];
  return span;
}

/** Mounts the approved quiet-utility trigger and its native top-layer appearance popover. */
export function mountAppearanceControl(container, controller) {
  const trigger = document.createElement("button");
  trigger.className = "glosa-appearance-trigger";
  trigger.type = "button";
  trigger.setAttribute("popovertarget", "glosa-appearance-menu");

  const triggerIcon = icon("light", "glosa-appearance-icon");
  trigger.append(triggerIcon);

  const menu = document.createElement("div");
  menu.id = "glosa-appearance-menu";
  menu.className = "glosa-appearance-menu";
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Appearance");

  const rows = new Map();
  for (const preference of APPEARANCES) {
    const row = document.createElement("button");
    row.className = "glosa-appearance-option";
    row.type = "button";
    row.setAttribute("role", "menuitemradio");
    row.dataset.appearance = preference;
    row.append(
      icon(preference, "glosa-appearance-option-icon"),
      Object.assign(document.createElement("span"), {
        className: "glosa-appearance-option-label",
        textContent: preference[0].toUpperCase() + preference.slice(1),
      }),
      icon("check", "glosa-appearance-check"),
    );
    row.addEventListener("click", () => {
      controller.setPreference(preference);
      menu.hidePopover?.();
      trigger.focus();
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
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });

  container.append(trigger, menu);

  const unsubscribe = controller.subscribe(({ preference, resolved }) => {
    triggerIcon.innerHTML = ICONS[resolved];
    trigger.setAttribute("aria-label", `Appearance: ${preference === "system" ? `System (${resolved})` : preference}`);
    trigger.title = `Appearance: ${preference === "system" ? `System (${resolved})` : preference}`;
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
