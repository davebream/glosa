// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — a document's style (#407): its typographic dress. Editorial (Source Serif 4, 18px),
// Spec (Source Sans 3, 16px, a deliberately denser page) and Mono each set the face, body size,
// leading, heading ladder, the gap between blocks, tables, code and line length; app.css holds the
// values. Serif for essays and sans for specs is a genre convention here, not a legibility claim.
//
// Which style a document is set in: its own choice, then its folder's default, then Editorial.
//   * A document's own choice is a reading preference of this device, stored in the browser like
//     the appearance and the text size, keyed per workspace and path. Storage failure never blocks
//     a page-local change.
//   * A folder's default lives in the daemon, beside the folder (A1 §5.23), so it follows the
//     folder into every browser and the desktop app. This module never reaches the daemon itself:
//     viewer.js hands it the two calls it needs, from data-access.js (R6).
// A style never sets light or dark, and glosa's identity does not live in it: every mark, address
// and margin entry reads the same in all three, and margin notes stay serif in every style.

export const STYLES = Object.freeze(["editorial", "spec", "mono"]);
export const DEFAULT_STYLE = "editorial";
/** The chooser's rows: each style by its intent, with the face it is set in. */
export const STYLE_LABELS = Object.freeze({ editorial: "Editorial (Serif)", spec: "Spec (Sans)", mono: "Mono" });
/** The short names, as "Folder default: Spec" says them. */
export const STYLE_NAMES = Object.freeze({ editorial: "Editorial", spec: "Spec", mono: "Mono" });

// The key keeps the name it had when the chooser set only a face, so a choice made then is still
// read: a stored `sans` is Spec, `mono` is Mono, and `serif` (the face chosen before the serif was
// the default) is Editorial. Before styles, choosing Default removed the key, so a document with
// nothing stored has never chosen and follows its folder.
export const STYLE_STORAGE_PREFIX = "glosa_face:";
const CARRIED_OVER = Object.freeze({ sans: "spec", serif: "editorial", mono: "mono" });

export function isStyle(value) {
  return STYLES.includes(value);
}

/** The storage key for one document in one workspace. */
export function styleKey(slug, path) {
  return `${STYLE_STORAGE_PREFIX}${slug ?? ""}:${path ?? ""}`;
}

/** A document's own stored style, or null when it has none (it follows its folder). */
export function readStyle(storage, key) {
  try {
    const stored = storage?.getItem(key);
    if (isStyle(stored)) return stored;
    return Object.hasOwn(CARRIED_OVER, stored ?? "") ? CARRIED_OVER[/** @type {string} */ (stored)] : null;
  } catch {
    return null;
  }
}

/**
 * Precedence: the document's own choice, then the folder's default, then Editorial. `source` says
 * which one decided, so the menu can say whether a folder default applies.
 * @param {string | null | undefined} own
 * @param {string | null | undefined} folder
 * @returns {{ style: string, source: "document" | "folder" | "default" }}
 */
export function resolveStyle(own, folder) {
  if (isStyle(own)) return { style: /** @type {string} */ (own), source: "document" };
  if (isStyle(folder)) return { style: /** @type {string} */ (folder), source: "folder" };
  return { style: DEFAULT_STYLE, source: "default" };
}

/**
 * @typedef {{ style: string, source: "document" | "folder" | "default", own: string | null,
 *   folder: string | null, folderAvailable: boolean }} StyleState
 */

/**
 * Creates the page-lifetime style store. One store serves every pane: each pane subscribes to its
 * own document and hears about a change to that document's choice or to its folder's default.
 *
 * `loadFolderStyle(slug)` answers `{ style }` for a folder, and `saveFolderStyle(slug, style)`
 * stores one and answers `{ style }`; both come from data-access.js. Without them (a test, or an
 * N-1 daemon that has no folder default) the store keeps working on documents alone.
 * @param {{ storage?: any, loadFolderStyle?: (slug: string) => Promise<any>,
 *   saveFolderStyle?: (slug: string, style: string) => Promise<any> }} [options]
 */
export function createStyleStore({ storage, loadFolderStyle, saveFolderStyle } = {}) {
  let targetStorage = storage;
  if (targetStorage === undefined) {
    try {
      targetStorage = window.localStorage;
    } catch {
      targetStorage = undefined;
    }
  }
  /** In-memory truth for keys whose persistence failed, so a choice still holds for this page.
   * A null value is a real answer: this document follows its folder. */
  const session = new Map();
  /** Each workspace's folder default as last read: `available` is false until the daemon answers,
   * and stays false where it cannot (an older daemon, a single-file workspace). */
  /** @type {Map<string, { style: string | null, available: boolean }>} */
  const folders = new Map();
  /** The latest load per workspace, so a slow answer never overwrites a newer one. */
  const loads = new Map();
  /** @type {Set<{ slug: string, path: string, key: string, listener: (state: StyleState) => void }>} */
  const subscriptions = new Set();

  function own(slug, path) {
    const key = styleKey(slug, path);
    if (session.has(key)) return session.get(key);
    return readStyle(targetStorage, key);
  }

  function folderOf(slug) {
    return folders.get(slug) ?? { style: null, available: false };
  }

  /** @returns {StyleState} */
  function get(slug, path) {
    const mine = own(slug, path);
    const folder = folderOf(slug);
    return { ...resolveStyle(mine, folder.style), own: mine, folder: folder.style, folderAvailable: folder.available };
  }

  function notify(match) {
    for (const subscription of [...subscriptions]) {
      if (match(subscription)) subscription.listener(get(subscription.slug, subscription.path));
    }
  }

  /** Keeps a document's own choice (null: it follows its folder) and returns its key. */
  function keepOwn(slug, path, style) {
    const key = styleKey(slug, path);
    session.set(key, style);
    try {
      if (style === null) targetStorage?.removeItem(key);
      else targetStorage?.setItem(key, style);
    } catch {
      // The page-local choice above still applies.
    }
    return key;
  }

  /**
   * Reads a folder's default from the daemon. Never rejects: a failure keeps what this page last
   * knew, and a folder the daemon has never answered for has no default here.
   * @param {string} slug
   */
  async function loadFolder(slug) {
    if (!slug || !loadFolderStyle) return folderOf(slug);
    const ticket = (loads.get(slug) ?? 0) + 1;
    loads.set(slug, ticket);
    let next;
    try {
      const answer = await loadFolderStyle(slug);
      next = { style: isStyle(answer?.style) ? answer.style : null, available: true };
    } catch {
      next = folders.get(slug) ?? { style: null, available: false };
    }
    if (loads.get(slug) === ticket) setFolder(slug, next);
    return folderOf(slug);
  }

  function setFolder(slug, next) {
    const current = folders.get(slug);
    if (current && current.style === next.style && current.available === next.available) return;
    folders.set(slug, next);
    notify((s) => s.slug === slug);
  }

  return {
    get,
    /** The folder default as last read: `{ style, available }`. */
    folder: folderOf,
    /**
     * Chooses a style for one document. Choosing the style its folder's default names puts the
     * document back to following the folder, so a later change to the default reaches it; any
     * other choice, Editorial included, is kept as the document's own.
     */
    choose(slug, path, style) {
      if (!isStyle(style)) throw new TypeError(`Unknown style: ${style}`);
      const folder = folderOf(slug);
      const key = keepOwn(slug, path, folder.available && folder.style === style ? null : style);
      notify((s) => s.key === key);
      return get(slug, path);
    },
    /**
     * Makes the style this document is set in its folder's default. The document then follows the
     * folder like every other document without a choice of its own. Rejects, changing nothing, if
     * the daemon could not store it.
     */
    async useAsFolderDefault(slug, path) {
      if (!saveFolderStyle) throw new Error("This folder has no default to set.");
      const { style, own: ownBefore } = get(slug, path);
      const readsBefore = loads.get(slug) ?? 0;
      const saved = await saveFolderStyle(slug, style);
      const stored = isStyle(saved?.style) ? saved.style : style;
      // Another window may have set the folder while this write was out, and its change may have
      // landed after this one. A read issued meanwhile is the sign: read again, after this write,
      // and let the daemon say which landed last. Reads that set out before it are dropped, since
      // they would answer with the default it replaced.
      const raced = (loads.get(slug) ?? 0) !== readsBefore;
      loads.set(slug, (loads.get(slug) ?? 0) + 1);
      folders.set(slug, { style: stored, available: true });
      // The document now follows its folder, unless the reader chose another style meanwhile.
      if (own(slug, path) === ownBefore) keepOwn(slug, path, null);
      notify((s) => s.slug === slug);
      if (raced) void loadFolder(slug);
      return stored;
    },
    loadFolder,
    /**
     * Calls `listener` with the document's state now and after every change to it.
     * @param {string} slug @param {string} path @param {(state: StyleState) => void} listener
     */
    subscribe(slug, path, listener) {
      const subscription = { slug, path, key: styleKey(slug, path), listener };
      subscriptions.add(subscription);
      listener(get(slug, path));
      return () => subscriptions.delete(subscription);
    },
  };
}

const FOLDER_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 6v8.5A1.5 1.5 0 0 0 4 16h12a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 16 6H9.5L8 4H4a1.5 1.5 0 0 0-1.5 1.5V6Z"/></svg>';

/**
 * Mounts the style chooser as a group of menu rows, the same home the workspace menu gives
 * Appearance: a reading preference is a setting, not primary chrome. Under the three styles, the
 * folder's default: "Folder default: Spec" when one is set, and "Use as folder default" whenever
 * the document is set in a style its folder does not already default to.
 *
 * `getTarget` answers which document the rows are for right now; the pane calls `refresh` whenever
 * that changes. `onPick` runs after a style row is chosen so the menu can close; the folder row
 * leaves the menu open and reports through `onFolderResult`, so a failure is said where it happened.
 * @param {any} container
 * @param {ReturnType<typeof createStyleStore>} store
 * @param {{ getTarget: () => { slug: string, path: string } | null, onChange?: (style: string) => void,
 *   onPick?: () => void, onFolderResult?: (result: { ok: boolean, style: string }) => void }} options
 */
export function mountStyleControl(
  container,
  store,
  { getTarget, onChange, onPick, onFolderResult } = /** @type {any} */ ({}),
) {
  const heading = document.createElement("p");
  heading.className = "glosa-pane-menu-heading";
  heading.textContent = "Style";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Style");
  container.append(heading);
  /** @type {Map<string, HTMLButtonElement>} */
  const rows = new Map();
  for (const style of STYLES) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "glosa-pane-menu-item glosa-style-option";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", "false");
    row.dataset.style = style;
    const sample = document.createElement("span");
    sample.className = "glosa-style-sample";
    sample.setAttribute("aria-hidden", "true");
    sample.textContent = "Aa";
    const label = document.createElement("span");
    label.textContent = STYLE_LABELS[style];
    row.append(sample, label);
    row.addEventListener("click", () => {
      const target = getTarget?.();
      if (!target) return;
      store.choose(target.slug, target.path, style);
      onPick?.();
    });
    rows.set(style, row);
    container.append(row);
  }

  const note = document.createElement("p");
  note.className = "glosa-style-folder-note";
  note.hidden = true;

  const useAsDefault = document.createElement("button");
  useAsDefault.type = "button";
  useAsDefault.className = "glosa-pane-menu-item glosa-style-folder";
  useAsDefault.setAttribute("role", "menuitem");
  useAsDefault.innerHTML = `${FOLDER_ICON}<span>Use as folder default</span>`;
  useAsDefault.hidden = true;
  let saving = false;
  useAsDefault.addEventListener("click", async () => {
    const target = getTarget?.();
    if (!target || saving) return;
    saving = true;
    // Nothing else in the group changes while the folder's default is being written.
    for (const control of [...rows.values(), useAsDefault]) control.disabled = true;
    const { style } = store.get(target.slug, target.path);
    /** @type {{ ok: boolean, style: string }} */
    let result;
    try {
      result = { ok: true, style: await store.useAsFolderDefault(target.slug, target.path) };
    } catch {
      result = { ok: false, style };
    }
    saving = false;
    const bound = Boolean(getTarget?.());
    for (const row of rows.values()) row.disabled = !bound;
    useAsDefault.disabled = false;
    // Focus stays in the menu: on the chosen style once the row has done its job and hidden, or
    // back on the row when it failed and is still there to try again.
    const focus = document.activeElement;
    if (focus === document.body || focus === useAsDefault || container.contains(focus)) {
      (result.ok ? rows.get(result.style) : useAsDefault)?.focus({ preventScroll: true });
    }
    onFolderResult?.(result);
  });
  container.append(note, useAsDefault);

  /** @param {StyleState} state @param {boolean} bound */
  function paint(state, bound) {
    for (const [value, row] of rows) row.setAttribute("aria-checked", String(value === state.style));
    const hasDefault = bound && state.folderAvailable && state.folder !== null;
    note.hidden = !hasDefault;
    note.textContent = hasDefault ? `Folder default: ${STYLE_NAMES[/** @type {string} */ (state.folder)]}` : "";
    useAsDefault.hidden = !bound || !state.folderAvailable || state.folder === state.style;
    useAsDefault.title = useAsDefault.hidden
      ? ""
      : `Documents in this folder without a style of their own will use ${STYLE_NAMES[state.style]}`;
  }

  let unsubscribe = null;
  function bind() {
    unsubscribe?.();
    unsubscribe = null;
    const target = getTarget?.();
    for (const row of rows.values()) row.disabled = !target;
    if (!target) {
      const state = { ...resolveStyle(null, null), own: null, folder: null, folderAvailable: false };
      paint(state, false);
      onChange?.(state.style);
      return;
    }
    unsubscribe = store.subscribe(target.slug, target.path, (state) => {
      paint(state, true);
      onChange?.(state.style);
    });
  }
  bind();

  return {
    /** Call when the pane's document changed so the rows follow it. */
    refresh: bind,
    /** Every row a menu's arrow keys move through, in order: the styles, then the folder row. */
    controls: () => [...rows.values(), useAsDefault],
    destroy() {
      unsubscribe?.();
      container.replaceChildren();
    },
  };
}
