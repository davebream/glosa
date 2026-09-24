// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — Go to: one palette for the two places a reader wants to be next, a section of
// the document they are reading and another file of the workspace.
//
// It replaced the fore-edge rail (a hover-to-open outline drawn at each pane's left inset), which
// was hard to hit, easy to open by accident on the way to the text, and only ever knew about one
// document. A palette is asked for, never volunteers, and can hold both lists at once.
//
// The list is two groups, in a fixed order: the ACTIVE pane's sections first, because "where in
// this document" is the nearer question, then every file in the workspace. Filtering is the same
// every-word match the outline used (see outline.js `matchesQuery`): typed words must all appear,
// in any order, and nothing is ever reordered by score — sections stay in document order and files
// in navigator order, so the list is always a view of something the reader already knows the shape
// of. Prefixes narrow it when a name lives in more than one group: `#` sections only, `/` files
// only, `@` workspaces only, `>` commands only.
//
// Workspaces come after files: switching workspace is the farther jump. Only the navigator's
// Starred section is kept at hand; every other workspace glosa is serving is found here.
//
// Transport-free by construction: the workspace hands this module its files and the active pane's
// entries when it opens, and gets a path or a jump back. It never reads an artifact.

import { matchesQuery } from "./outline.js";
import { createElement as el } from "./viewer-shell.js";

/**
 * @typedef {{ text: string, depth: number, address?: string | null, jump: () => void }} SectionEntry
 * @typedef {{ id: string, label: string, detail?: string, run: () => void }} CommandEntry
 * @typedef {{ slug: string, name: string, detail?: string, current: boolean, starred: boolean }} WorkspaceEntry
 * @typedef {{ id: string, title: string, archived?: boolean }} ChatEntry
 * @typedef {{ kind: "section", entry: SectionEntry, depth: number, text: string, address: string | null, current: boolean }
 *   | { kind: "file", path: string, name: string, dir: string, text: string }
 *   | { kind: "workspace", workspace: WorkspaceEntry, text: string }
 *   | { kind: "chat", chat: ChatEntry, text: string, matched?: boolean }
 *   | { kind: "command", command: CommandEntry, text: string }} PaletteItem
 */

/**
 * @param {{
 *   host: any,
 *   getFiles: () => string[],
 *   getSections: () => { title: string, entries: SectionEntry[], current: number } | null,
 *   onOpenFile: (path: string) => void,
 *   getCommands?: () => CommandEntry[],
 *   getWorkspaces?: () => WorkspaceEntry[],
 *   onOpenWorkspace?: (slug: string) => void,
 *   starIcon?: string,
 *   getChats?: () => ChatEntry[],
 *   searchChats?: (query: string, after?: string) => Promise<{chats: ChatEntry[], next?: string}>,
 *   onOpenChat?: (id: string) => void,
 * }} options
 */
export function createCommandPalette({
  host,
  getFiles,
  getSections,
  onOpenFile,
  getCommands = () => [],
  getWorkspaces = () => [],
  onOpenWorkspace = () => {},
  starIcon = "",
  getChats = () => [],
  searchChats,
  onOpenChat = () => {},
}) {
  let open = false;
  let destroyed = false;
  /** @type {PaletteItem[]} */ let items = [];
  /** @type {PaletteItem[]} */ let shown = [];
  let active = 0;
  /** @type {any} */ let previousFocus = null;
  let sectionsTitle = "";
  let filter = "all",
    searchGeneration = 0,
    searching = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let searchTimer;
  /** @type {string | undefined} */ let nextChatPage;

  const inputEl = el("input", {
    className: "glosa-palette-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Search artifacts, chats and commands…",
    "aria-label": "Search artifacts, chats and commands",
    maxLength: 256,
    role: "combobox",
    "aria-expanded": "true",
    "aria-autocomplete": "list",
  });
  const listEl = el("div", { className: "glosa-palette-list", role: "listbox", "aria-label": "Destinations" });
  const listId = `glosa-palette-list-${Math.random().toString(36).slice(2, 9)}`;
  listEl.id = listId;
  inputEl.setAttribute("aria-controls", listId);
  const emptyEl = el("p", { className: "glosa-palette-empty", role: "status", hidden: true });
  const hintEl = el("p", {
    className: "glosa-palette-hint",
    textContent: "↑↓ to move · Enter to go · # sections · / files · @ workspaces · > commands",
  });
  const filters = el("div", { className: "glosa-palette-filters", role: "group", "aria-label": "Search in" });
  for (const [value, label] of [
    ["all", "All"],
    ["file", "Artifacts"],
    ["chat", "Chats"],
    ["command", "Commands"],
  ]) {
    filters.append(
      el("button", {
        type: "button",
        textContent: label,
        "data-filter": value,
        "aria-pressed": String(value === filter),
        onClick: () => {
          filter = value ?? "all";
          for (const button of filters.children)
            button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
          onInput();
          inputEl.focus();
        },
      }),
    );
  }
  const searchStatus = el("p", { className: "glosa-palette-search-status", role: "status" });
  const more = el("button", {
    className: "glosa-palette-more",
    type: "button",
    textContent: "More matching chats",
    hidden: true,
    onClick: () => void findChats(true),
  });
  const sheetEl = el("div", { className: "glosa-palette-sheet" }, [
    inputEl,
    filters,
    listEl,
    emptyEl,
    searchStatus,
    more,
    hintEl,
  ]);
  const rootEl = el(
    "div",
    { className: "glosa-palette", role: "dialog", "aria-modal": "true", "aria-label": "Go to", hidden: true },
    [sheetEl],
  );
  host.append(rootEl);

  /** @param {string} raw */
  function parseQuery(raw) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("#")) return { scope: "section", query: trimmed.slice(1) };
    if (trimmed.startsWith("/")) return { scope: "file", query: trimmed.slice(1) };
    if (trimmed.startsWith("@")) return { scope: "workspace", query: trimmed.slice(1) };
    if (trimmed.startsWith(">")) return { scope: "command", query: trimmed.slice(1) };
    return { scope: null, query: trimmed };
  }

  function collect() {
    /** @type {PaletteItem[]} */
    const next = [];
    const sections = getSections();
    sectionsTitle = sections?.title ?? "";
    if (sections) {
      sections.entries.forEach((entry, index) => {
        const address = entry.address ?? null;
        next.push({
          kind: "section",
          entry,
          depth: Math.max(0, Math.min(5, (entry.depth || 1) - 1)),
          text: address ? `${address} ${entry.text}` : entry.text,
          address,
          current: index === sections.current,
        });
      });
    }
    for (const path of getFiles()) {
      const slash = path.lastIndexOf("/");
      next.push({
        kind: "file",
        path,
        name: slash === -1 ? path : path.slice(slash + 1),
        dir: slash === -1 ? "" : path.slice(0, slash),
        text: path,
      });
    }
    for (const chat of getChats()) next.push({ kind: "chat", chat, text: chat.title });
    for (const workspace of getWorkspaces()) {
      next.push({ kind: "workspace", workspace, text: workspace.name });
    }
    // What the reader can DO here, after where they can go. Commands keep the order the workbench
    // gives them, like every other group: nothing is reordered by score.
    for (const command of getCommands()) {
      next.push({ kind: "command", command, text: command.label });
    }
    items = next;
  }

  function render() {
    const { scope, query } = parseQuery(inputEl.value);
    shown = items.filter(
      (item) =>
        (scope === null || item.kind === scope) &&
        (filter === "all" || item.kind === filter) &&
        ((item.kind === "chat" && item.matched) || matchesQuery(item.text, query)),
    );
    active = Math.min(active, Math.max(0, shown.length - 1));
    listEl.textContent = "";
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = items.length ? "Nothing matches that." : "Nothing to go to yet.";
    /** @type {string | null} */
    let group = null;
    shown.forEach((item, index) => {
      if (item.kind !== group) {
        group = item.kind;
        listEl.append(
          el("div", {
            className: "glosa-palette-group",
            role: "presentation",
            textContent:
              item.kind === "section"
                ? `Sections · ${sectionsTitle}`
                : item.kind === "file"
                  ? "Files"
                  : item.kind === "chat"
                    ? "Chats"
                    : item.kind === "workspace"
                      ? "Workspaces"
                      : "Commands",
          }),
        );
      }
      const row = el("button", {
        className: "glosa-palette-item",
        type: "button",
        role: "option",
        id: `${listId}-${index}`,
        tabIndex: -1,
        "aria-selected": String(index === active),
        "data-kind": item.kind,
      });
      if (item.kind === "section") {
        row.style.setProperty("--palette-depth", String(item.depth));
        if (item.address) {
          row.append(
            el("span", { className: "glosa-palette-address", "aria-hidden": "true", textContent: item.address }),
          );
        }
        row.append(el("span", { className: "glosa-palette-label", textContent: item.entry.text }));
        if (item.current) {
          row.setAttribute("aria-current", "location");
          row.append(el("span", { className: "glosa-palette-meta", textContent: "you are here" }));
        }
      } else if (item.kind === "file") {
        row.append(el("span", { className: "glosa-palette-label", textContent: item.name }));
        if (item.dir) row.append(el("span", { className: "glosa-palette-meta", textContent: item.dir }));
      } else if (item.kind === "chat") {
        row.append(el("span", { className: "glosa-palette-label", textContent: item.chat.title }));
        if (item.chat.archived) row.append(el("span", { className: "glosa-palette-meta", textContent: "Archived" }));
      } else if (item.kind === "workspace") {
        const { workspace } = item;
        // Every workspace row keeps the star's slot, so names line up whether or not it is starred.
        const star = el("span", { className: "glosa-palette-star", "aria-hidden": "true" });
        if (workspace.starred) star.innerHTML = starIcon;
        row.append(star);
        row.append(el("span", { className: "glosa-palette-label", textContent: workspace.name }));
        if (workspace.starred) row.append(el("span", { className: "glosa-visually-hidden", textContent: ", starred" }));
        if (workspace.current) {
          row.setAttribute("aria-current", "location");
          row.append(el("span", { className: "glosa-palette-meta", textContent: "you are here" }));
        } else if (workspace.detail) {
          row.append(el("span", { className: "glosa-palette-meta", textContent: workspace.detail }));
        }
      } else {
        row.append(el("span", { className: "glosa-palette-label", textContent: item.command.label }));
        if (item.command.detail) {
          row.append(el("span", { className: "glosa-palette-meta", textContent: item.command.detail }));
        }
      }
      row.addEventListener("pointermove", () => setActive(index, { scroll: false }));
      row.addEventListener("click", () => pick(index));
      listEl.append(row);
    });
    syncActive();
  }

  function rows() {
    return /** @type {any[]} */ ([...listEl.querySelectorAll(".glosa-palette-item")]);
  }

  function syncActive({ scroll = true } = {}) {
    const all = rows();
    for (let index = 0; index < all.length; index += 1) {
      all[index].setAttribute("aria-selected", String(index === active));
    }
    const row = all[active];
    inputEl.setAttribute("aria-activedescendant", row ? row.id : "");
    if (row && scroll) row.scrollIntoView?.({ block: "nearest" });
  }

  /** @param {number} index */
  function setActive(index, { scroll = true } = {}) {
    if (!shown.length) return;
    const next = Math.min(Math.max(index, 0), shown.length - 1);
    if (next === active) return;
    active = next;
    syncActive({ scroll });
  }

  /** @param {number} index */
  function pick(index) {
    const item = shown[index];
    if (!item) return;
    close({ restoreFocus: false });
    if (item.kind === "section") item.entry.jump();
    else if (item.kind === "file") onOpenFile(item.path);
    else if (item.kind === "workspace") onOpenWorkspace(item.workspace.slug);
    else if (item.kind === "chat") onOpenChat(item.chat.id);
    else item.command.run();
  }

  function show() {
    if (destroyed || open) return;
    open = true;
    filter = "all";
    for (const button of filters.children)
      button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
    previousFocus = document.activeElement;
    collect();
    inputEl.value = "";
    // Opens on the section the reader is standing in, so ↓ reads "the next section" at once.
    const here = items.findIndex((item) => item.kind === "section" && item.current);
    active = Math.max(0, here);
    rootEl.hidden = false;
    render();
    void findChats();
    queueMicrotask(() => inputEl.focus({ preventScroll: true }));
  }

  function close({ restoreFocus = true } = {}) {
    if (!open) return;
    open = false;
    searchGeneration++;
    clearTimeout(searchTimer);
    rootEl.hidden = true;
    listEl.textContent = "";
    items = [];
    shown = [];
    const target = previousFocus;
    previousFocus = null;
    if (restoreFocus && target instanceof HTMLElement && target.isConnected) {
      queueMicrotask(() => target.focus({ preventScroll: true }));
    }
  }

  function onInput() {
    active = 0;
    searchGeneration++;
    clearTimeout(searchTimer);
    nextChatPage = undefined;
    more.hidden = true;
    searchStatus.textContent = "";
    collect();
    render();
    if (searchChats) searchTimer = setTimeout(() => void findChats(), 150);
  }

  async function findChats(append = false) {
    const { scope, query } = parseQuery(inputEl.value);
    if (
      (append && searching) ||
      !searchChats ||
      !open ||
      (scope && scope !== "chat") ||
      !["all", "chat"].includes(filter)
    )
      return;
    const generation = ++searchGeneration;
    searching = true;
    more.disabled = true;
    searchStatus.textContent = "Searching chats…";
    try {
      const result = await searchChats(query, append ? nextChatPage : undefined);
      if (generation !== searchGeneration || !open || destroyed) return;
      const prior = append ? items.filter((item) => item.kind === "chat") : [];
      const matches = [
        ...prior,
        ...result.chats.map((chat) => ({ kind: /** @type {const} */ ("chat"), chat, text: chat.title, matched: true })),
      ];
      const unique = [...new Map(matches.map((item) => [item.chat.id, item])).values()];
      const beforeChats = items.filter((item) => item.kind === "section" || item.kind === "file");
      const afterChats = items.filter((item) => item.kind === "workspace" || item.kind === "command");
      items = [...beforeChats, ...unique, ...afterChats];
      nextChatPage = result.next;
      more.hidden = !nextChatPage;
      searchStatus.textContent = "";
      render();
    } catch {
      if (generation !== searchGeneration || !open) return;
      searchStatus.textContent = "Chat search could not finish. Change the search to try again.";
    } finally {
      if (generation === searchGeneration) {
        searching = false;
        more.disabled = false;
      }
    }
  }

  /** @param {any} event */
  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    // Filter/pagination buttons keep native Enter/Space activation. Only the combobox
    // owns result navigation; otherwise Enter would open whichever result was active.
    if (event.target !== inputEl) return;
    if (event.key === "Enter") {
      event.preventDefault();
      pick(active);
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? active + 1
        : event.key === "ArrowUp"
          ? active - 1
          : event.key === "Home" && !inputEl.value
            ? 0
            : event.key === "End" && !inputEl.value
              ? shown.length - 1
              : event.key === "PageDown"
                ? active + 8
                : event.key === "PageUp"
                  ? active - 8
                  : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  /** @param {any} event */
  function onRootPointerDown(event) {
    // The scrim is the root itself; anything inside the sheet is the palette.
    if (event.target === rootEl) close();
  }

  inputEl.addEventListener("input", onInput);
  sheetEl.addEventListener("keydown", onKeydown);
  rootEl.addEventListener("pointerdown", onRootPointerDown);

  return {
    element: rootEl,
    open: show,
    close,
    /** ⌘K. Toggles, so the same key puts it away. */
    toggle() {
      if (open) close();
      else show();
    },
    isOpen: () => open,
    destroy() {
      destroyed = true;
      close({ restoreFocus: false });
      inputEl.removeEventListener("input", onInput);
      sheetEl.removeEventListener("keydown", onKeydown);
      rootEl.removeEventListener("pointerdown", onRootPointerDown);
      rootEl.remove();
    },
  };
}
