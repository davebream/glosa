// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the manuscript's face, per artifact. The page belongs to the writer, and the writer
// chooses how it is set: Default (Source Serif 4), Sans (Source Sans 3), or Mono. glosa's identity does not live
// in the face — every mark, address and margin entry reads the same in all three — so this is a
// reading preference, durable per artifact, and never anything a session can see or change.
//
// Storage is the same non-sensitive localStorage appearance.js uses, keyed per workspace and
// artifact path. Storage failure never prevents a page-local change.

export const FACE_STORAGE_PREFIX = "glosa_face:";
// A page stored as "serif" before the serif became the default is no longer a face here; it reads
// back as "default", which now sets it in the same serif.
export const FACES = Object.freeze(["default", "sans", "mono"]);
export const FACE_LABELS = Object.freeze({ default: "Default", sans: "Sans", mono: "Mono" });

export function isFace(value) {
  return FACES.includes(value);
}

/** The storage key for one artifact in one workspace. */
export function faceKey(slug, path) {
  return `${FACE_STORAGE_PREFIX}${slug ?? ""}:${path ?? ""}`;
}

export function readFace(storage, key) {
  try {
    const stored = storage?.getItem(key);
    return isFace(stored) ? stored : "default";
  } catch {
    return "default";
  }
}

/**
 * Creates the page-lifetime face store. One store serves every pane; each pane asks for its own
 * artifact's face and subscribes to changes to that key only.
 */
export function createFaceStore({ storage } = {}) {
  let targetStorage = storage;
  if (targetStorage === undefined) {
    try {
      targetStorage = window.localStorage;
    } catch {
      targetStorage = undefined;
    }
  }
  /** @type {Map<string, Set<(face: string) => void>>} */
  const listeners = new Map();
  /** In-memory truth for keys whose persistence failed, so a choice still holds for this page. */
  const session = new Map();

  function get(key) {
    if (session.has(key)) return session.get(key);
    return readFace(targetStorage, key);
  }

  return {
    get,
    set(key, face) {
      if (!isFace(face)) throw new TypeError(`Unknown face: ${face}`);
      session.set(key, face);
      try {
        if (face === "default") targetStorage?.removeItem(key);
        else targetStorage?.setItem(key, face);
      } catch {
        // The page-local choice above still applies.
      }
      for (const listener of listeners.get(key) ?? []) listener(face);
      return face;
    },
    subscribe(key, listener) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      listener(get(key));
      return () => listeners.get(key)?.delete(listener);
    },
  };
}

/**
 * Mounts the face chooser as a group of menu rows, the same home the workspace menu gives
 * Appearance: a reading preference is a setting, not primary chrome. `getKey` answers which
 * artifact the rows are for right now; the pane calls `refresh` whenever that changes, and
 * `onPick` after a row is chosen so the menu can close.
 * @param {any} container
 * @param {ReturnType<typeof createFaceStore>} store
 * @param {{ getKey: () => string | null, onChange?: (face: string) => void, onPick?: () => void }} options
 */
export function mountFaceControl(container, store, { getKey, onChange, onPick } = {}) {
  const heading = document.createElement("p");
  heading.className = "glosa-pane-menu-heading";
  heading.textContent = "Manuscript face";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Manuscript face");
  container.append(heading);
  /** @type {Map<string, HTMLButtonElement>} */
  const rows = new Map();
  for (const face of FACES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "glosa-pane-menu-item glosa-face-option";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", "false");
    row.dataset.face = face;
    const sample = document.createElement("span");
    sample.className = "glosa-face-sample";
    sample.setAttribute("aria-hidden", "true");
    sample.textContent = "Aa";
    const label = document.createElement("span");
    label.textContent = FACE_LABELS[face];
    row.append(sample, label);
    row.addEventListener("click", () => {
      const key = getKey?.();
      if (!key) return;
      store.set(key, face);
      onPick?.();
    });
    rows.set(face, row);
    container.append(row);
  }

  function paint(face) {
    for (const [value, row] of rows) row.setAttribute("aria-checked", String(value === face));
  }

  let unsubscribe = null;
  function bind() {
    unsubscribe?.();
    unsubscribe = null;
    const key = getKey?.();
    for (const row of rows.values()) row.disabled = !key;
    if (!key) {
      paint("default");
      onChange?.("default");
      return;
    }
    unsubscribe = store.subscribe(key, (face) => {
      paint(face);
      onChange?.(face);
    });
  }
  bind();

  return {
    /** Call when the pane's artifact changed so the rows follow it. */
    refresh: bind,
    destroy() {
      unsubscribe?.();
      container.replaceChildren();
    },
  };
}
