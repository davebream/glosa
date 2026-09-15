// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the manuscript's face, per artifact. The page belongs to the writer, and the writer
// chooses how it is set: Default (the system sans), Serif, or Mono. glosa's identity does not live
// in the face — every mark, address and margin entry reads the same in all three — so this is a
// reading preference, durable per artifact, and never anything a session can see or change.
//
// Storage is the same non-sensitive localStorage appearance.js uses, keyed per workspace and
// artifact path. Storage failure never prevents a page-local change.

export const FACE_STORAGE_PREFIX = "glosa_face:";
export const FACES = Object.freeze(["default", "serif", "mono"]);
export const FACE_LABELS = Object.freeze({ default: "Default", serif: "Serif", mono: "Mono" });

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
 * Mounts the face control: a native select, because a reading preference wants the platform's own
 * affordance rather than an invented one. `getKey` answers which artifact the control is for right
 * now; the control re-reads it whenever the pane tells it the artifact changed.
 * @param {any} container
 * @param {ReturnType<typeof createFaceStore>} store
 * @param {{ getKey: () => string | null, onChange?: (face: string) => void }} options
 */
export function mountFaceControl(container, store, { getKey, onChange } = {}) {
  const label = document.createElement("label");
  label.className = "glosa-face";
  const glyph = document.createElement("span");
  glyph.className = "glosa-face-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "Aa";
  const select = document.createElement("select");
  select.className = "glosa-face-select";
  select.setAttribute("aria-label", "Manuscript face");
  for (const face of FACES) {
    const option = document.createElement("option");
    option.value = face;
    option.textContent = FACE_LABELS[face];
    select.append(option);
  }
  label.append(glyph, select);
  container.append(label);

  let unsubscribe = null;
  function bind() {
    unsubscribe?.();
    unsubscribe = null;
    const key = getKey?.();
    select.disabled = !key;
    if (!key) {
      select.value = "default";
      onChange?.("default");
      return;
    }
    unsubscribe = store.subscribe(key, (face) => {
      select.value = face;
      onChange?.(face);
    });
  }
  select.addEventListener("change", () => {
    const key = getKey?.();
    if (key) store.set(key, select.value);
  });
  bind();

  return {
    /** Call when the pane's artifact changed so the control follows it. */
    refresh: bind,
    destroy() {
      unsubscribe?.();
      label.remove();
    },
  };
}
