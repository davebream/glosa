// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * The browser SPA is intentionally served as plain ES modules with no build step. This module
 * therefore uses TypeScript's checked-JavaScript mode: its public model is fully typed without
 * shipping syntax browsers cannot execute.
 *
 * @typedef {{
 *   path: string,
 *   class?: "R" | "F",
 *   size_bytes?: number,
 *   mtime?: string,
 *   source_sha256?: string,
 *   stale?: boolean
 * }} ArtifactSummary
 *
 * @typedef {{
 *   kind: "directory",
 *   id: string,
 *   path: string,
 *   name: string,
 *   children: TreeNode[]
 * }} DirectoryNode
 *
 * @typedef {{
 *   kind: "file",
 *   id: string,
 *   path: string,
 *   name: string,
 *   artifact: ArtifactSummary
 * }} FileNode
 *
 * @typedef {DirectoryNode | FileNode} TreeNode
 *
 * @typedef {{
 *   node: TreeNode,
 *   level: number,
 *   parentId: string | null
 * }} VisibleTreeNode
 */

const TYPEAHEAD_RESET_MS = 650;
const EXPANSION_STORAGE_PREFIX = "glosa:artifact-tree:expanded:";

/** How many of `openPaths` sit anywhere under a folder.
 *  @param {{ children: Array<any> }} node
 *  @param {Set<string>} openPaths
 *  @returns {number} */
function openInside(node, openPaths) {
  let count = 0;
  for (const child of node.children) {
    if (child.kind === "directory") count += openInside(child, openPaths);
    else if (openPaths.has(child.path)) count += 1;
  }
  return count;
}

/** Where a long hyphenated name may clip: the head takes the ellipsis, the tail (after the last
 *  hyphen, extension included) stays visible, so siblings that share a prefix keep their names. Short
 *  names, and names whose tail would be most of the name, are left whole.
 *  @param {string} name
 *  @returns {{ head: string, tail: string } | null} */
function splitName(name) {
  if (name.length < 24) return null;
  const at = name.lastIndexOf("-");
  if (at <= 0) return null;
  // The hyphen travels with the tail, so the join after the head's ellipsis still reads as one
  // word ("underfive-t…-comparison.md"), and a tail as long as "-preregistration.md" still fits.
  const tail = name.slice(at);
  if (tail.length < 2 || tail.length > 21) return null;
  return { head: name.slice(0, at), tail };
}

const ICONS = {
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
};

/** @param {string} path */
function directoryId(path) {
  return `d:${path}`;
}

/** @param {string} path */
function fileId(path) {
  return `f:${path}`;
}

/**
 * Builds a path trie in O(total path segments), then orders every level the way an IDE's file
 * tree does: directories first, then files, each group by name (case-insensitive, numeric-aware,
 * so `2.md` precedes `10.md`). The daemon's own order is not kept: it reflects the order artifacts
 * were registered in, which is no order a reader can predict.
 *
 * @param {ArtifactSummary[]} artifacts
 * @returns {DirectoryNode}
 */
export function buildArtifactTree(artifacts) {
  /** @type {DirectoryNode} */
  const root = { kind: "directory", id: "d:", path: "", name: "", children: [] };
  /** @type {Map<string, DirectoryNode>} */
  const directories = new Map([[root.id, root]]);

  for (const artifact of artifacts) {
    const segments = artifact.path.split("/");
    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) continue;

    let parent = root;
    let parentPath = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (name === undefined) continue;
      const path = parentPath ? `${parentPath}/${name}` : name;
      const id = directoryId(path);
      let directory = directories.get(id);
      if (!directory) {
        directory = { kind: "directory", id, path, name, children: [] };
        directories.set(id, directory);
        parent.children.push(directory);
      }
      parent = directory;
      parentPath = path;
    }

    const name = segments.at(-1);
    if (name === undefined) continue;
    parent.children.push({ kind: "file", id: fileId(artifact.path), path: artifact.path, name, artifact });
  }

  sortTree(root);
  return root;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** @param {DirectoryNode} directory */
function sortTree(directory) {
  directory.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return byName.compare(a.name, b.name);
  });
  for (const child of directory.children) if (child.kind === "directory") sortTree(child);
}

/**
 * @param {DirectoryNode} root
 * @param {Set<string>} expanded
 * @returns {VisibleTreeNode[]}
 */
export function flattenVisibleTree(root, expanded) {
  /** @type {VisibleTreeNode[]} */
  const visible = [];

  /** @param {TreeNode[]} nodes @param {number} level @param {string | null} parentId */
  function visit(nodes, level, parentId) {
    for (const node of nodes) {
      visible.push({ node, level, parentId });
      if (node.kind === "directory" && expanded.has(node.id)) visit(node.children, level + 1, node.id);
    }
  }

  visit(root.children, 1, null);
  return visible;
}

/** @param {string} path */
export function ancestorDirectoryIds(path) {
  const segments = path.split("/");
  /** @type {string[]} */
  const ids = [];
  for (let index = 1; index < segments.length; index += 1) {
    ids.push(directoryId(segments.slice(0, index).join("/")));
  }
  return ids;
}

/** @param {DirectoryNode} root */
function collectDirectoryIds(root) {
  /** @type {Set<string>} */
  const ids = new Set();
  /** @param {TreeNode[]} nodes */
  function visit(nodes) {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      ids.add(node.id);
      visit(node.children);
    }
  }
  visit(root.children);
  return ids;
}

/** @param {string} value */
function escapeSelectorValue(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * @param {HTMLElement} container
 * @param {{ onOpen: (path: string) => void, storage?: Storage | null }} options
 */
export function createArtifactTreeNavigator(container, options) {
  let root = buildArtifactTree([]);
  let workspace = "";
  /** @type {string | null} */
  let currentPath = null;
  /** Every artifact open in some pane. The tree says what is already on screen, not only where
   * the reader last clicked — the workbench can hold six documents at once (2026-09-04 brief §5).
   * @type {Set<string>} */
  let openPaths = new Set();
  /** @type {string | null} */
  let focusedId = null;
  /** @type {Set<string>} */
  let expanded = new Set();
  let typeahead = "";
  let typeaheadTimer = 0;
  const storage = options.storage ?? (typeof sessionStorage === "undefined" ? null : sessionStorage);

  container.setAttribute("role", "tree");
  container.setAttribute("aria-label", "Documents");

  function storageKey() {
    return `${EXPANSION_STORAGE_PREFIX}${workspace}`;
  }

  function loadExpansion() {
    expanded = new Set();
    if (!storage || !workspace) return;
    try {
      const stored = JSON.parse(storage.getItem(storageKey()) ?? "[]");
      if (Array.isArray(stored)) expanded = new Set(stored.filter((id) => typeof id === "string"));
    } catch {
      expanded = new Set();
    }
  }

  function saveExpansion() {
    if (!storage || !workspace) return;
    try {
      storage.setItem(storageKey(), JSON.stringify([...expanded]));
    } catch {
      // Storage can be disabled by browser policy; in-memory expansion still works.
    }
  }

  /** @param {string} id */
  function findItem(id) {
    return container.querySelector(`[role="treeitem"][data-node-id="${escapeSelectorValue(id)}"]`);
  }

  /** @param {string} id */
  function focusItem(id) {
    const item = findItem(id);
    if (!(item instanceof HTMLElement)) return;
    for (const candidate of container.querySelectorAll('[role="treeitem"]')) candidate.setAttribute("tabindex", "-1");
    item.setAttribute("tabindex", "0");
    focusedId = id;
    item.focus();
  }

  /** @param {TreeNode} node @param {number} level @param {string | null} parentId */
  function renderItem(node, level, parentId) {
    const item = document.createElement("li");
    item.setAttribute("role", "treeitem");
    item.setAttribute("data-node-id", node.id);
    item.setAttribute("data-kind", node.kind);
    item.setAttribute("data-level", String(level));
    if (parentId) item.setAttribute("data-parent-id", parentId);
    item.setAttribute("tabindex", "-1");

    const row = document.createElement("div");
    row.className = "glosa-tree-row";
    row.setAttribute("data-tree-action", node.kind === "directory" ? "toggle" : "open");
    row.title = node.path;

    const disclosure = document.createElement("span");
    disclosure.className = "glosa-tree-disclosure";
    if (node.kind === "directory") disclosure.innerHTML = ICONS.chevron;
    else disclosure.setAttribute("aria-hidden", "true");

    // No file or folder glyph: the chevron already says "folder", a file is a row without one, and
    // the 21px the glyph took is 21px more of every name in a 232px column.
    const label = document.createElement("span");
    label.className = "glosa-tree-label";
    // The name always sits in a head span, because the label is a flex row and `text-overflow`
    // does nothing for a flex container's bare text: a whole name that overflowed was cut mid-glyph
    // with no ellipsis at all. Split names add the tail beside it.
    const split = splitName(node.name);
    const head = document.createElement("span");
    head.className = "glosa-tree-label-head";
    head.textContent = split ? split.head : node.name;
    label.append(head);
    if (split) {
      const tail = document.createElement("span");
      tail.className = "glosa-tree-label-tail";
      tail.textContent = split.tail;
      label.append(tail);
    }

    row.append(disclosure, label);

    if (node.kind === "directory") {
      const isExpanded = expanded.has(node.id);
      item.setAttribute("aria-expanded", String(isExpanded));
      if (isExpanded) item.setAttribute("data-expanded", "true");
      // A folded folder with an open document inside still says so: the tab strip shows the
      // document, so the tree must not show a plain folder. The mark sits at the row's end (the
      // chevron owns the slot the file's dot uses) and the row names the count.
      const inside = isExpanded ? 0 : openInside(node, openPaths);
      if (inside > 0) {
        const mark = document.createElement("span");
        mark.className = "glosa-tree-open-inside";
        mark.setAttribute("aria-hidden", "true");
        row.append(mark);
        row.setAttribute("aria-label", `${node.name}, ${inside} open inside`);
      }
      item.append(row);
      if (isExpanded) {
        const group = document.createElement("ul");
        group.setAttribute("role", "group");
        for (const child of node.children) group.append(renderItem(child, level + 1, node.id));
        item.append(group);
      }
    } else {
      const isCurrent = node.path === currentPath;
      const isOpen = openPaths.has(node.path);
      item.setAttribute("aria-selected", String(isCurrent));
      if (isCurrent) item.setAttribute("aria-current", "page");
      if (isOpen) {
        // Not color alone: the row carries a mark AND names its state to assistive technology.
        item.setAttribute("data-open", "true");
        const openMark = document.createElement("span");
        openMark.className = "glosa-tree-open";
        openMark.setAttribute("aria-hidden", "true");
        row.prepend(openMark);
        row.setAttribute("aria-label", `${node.name}, ${isCurrent ? "open in the active pane" : "open in a pane"}`);
      }
      if (node.artifact.stale) {
        const stale = document.createElement("span");
        stale.className = "glosa-tree-stale";
        stale.title = "Generated document is out of date";
        stale.setAttribute("aria-label", "Out of date");
        row.append(stale);
      }
      item.append(row);
    }
    return item;
  }

  function render() {
    const hadFocus = container.contains(document.activeElement);
    const visible = flattenVisibleTree(root, expanded);
    const visibleIds = new Set(visible.map(({ node }) => node.id));
    if (!focusedId || !visibleIds.has(focusedId)) {
      const currentId = currentPath ? fileId(currentPath) : null;
      focusedId = currentId && visibleIds.has(currentId) ? currentId : (visible[0]?.node.id ?? null);
    }

    const fragment = document.createDocumentFragment();
    for (const node of root.children) fragment.append(renderItem(node, 1, null));
    container.replaceChildren(fragment);

    if (focusedId) findItem(focusedId)?.setAttribute("tabindex", "0");
    if (hadFocus && focusedId) focusItem(focusedId);
  }

  /** @param {string} id */
  function toggle(id) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    focusedId = id;
    saveExpansion();
    render();
  }

  /** @param {Element} item */
  function activate(item) {
    const id = item.getAttribute("data-node-id");
    if (!id) return;
    focusedId = id;
    if (item.getAttribute("data-kind") === "directory") toggle(id);
    else {
      const path = id.slice(2);
      options.onOpen(path);
    }
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(".glosa-tree-row");
    const item = row?.parentElement;
    if (!row || !item || item.getAttribute("role") !== "treeitem") return;
    item.focus();
    activate(item);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest('[role="treeitem"]');
    if (!(item instanceof HTMLElement) || !container.contains(item)) return;

    const items = [...container.querySelectorAll('[role="treeitem"]')].filter(
      (candidate) => candidate instanceof HTMLElement,
    );
    const index = items.indexOf(item);
    const id = item.getAttribute("data-node-id") ?? "";
    const isDirectory = item.getAttribute("data-kind") === "directory";
    const isExpanded = item.getAttribute("aria-expanded") === "true";

    if (event.key === "ArrowDown" && index < items.length - 1)
      focusItem(items[index + 1]?.getAttribute("data-node-id") ?? id);
    else if (event.key === "ArrowUp" && index > 0) focusItem(items[index - 1]?.getAttribute("data-node-id") ?? id);
    else if (event.key === "Home") focusItem(items[0]?.getAttribute("data-node-id") ?? id);
    else if (event.key === "End") focusItem(items.at(-1)?.getAttribute("data-node-id") ?? id);
    else if (event.key === "ArrowRight" && isDirectory) {
      if (!isExpanded) toggle(id);
      else if (items[index + 1]?.getAttribute("data-parent-id") === id)
        focusItem(items[index + 1]?.getAttribute("data-node-id") ?? id);
    } else if (event.key === "ArrowLeft") {
      if (isDirectory && isExpanded) toggle(id);
      else {
        const parentId = item.getAttribute("data-parent-id");
        if (parentId) focusItem(parentId);
      }
    } else if (event.key === "Enter" || event.key === " ") activate(item);
    else if (event.key === "*" && item.getAttribute("data-parent-id")) {
      const parentId = item.getAttribute("data-parent-id");
      for (const sibling of items) {
        if (sibling.getAttribute("data-parent-id") === parentId && sibling.getAttribute("data-kind") === "directory") {
          expanded.add(sibling.getAttribute("data-node-id") ?? "");
        }
      }
      saveExpansion();
      render();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ") {
      window.clearTimeout(typeaheadTimer);
      typeahead += event.key.toLocaleLowerCase();
      typeaheadTimer = window.setTimeout(() => {
        typeahead = "";
      }, TYPEAHEAD_RESET_MS);
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      const match = ordered.find((candidate) =>
        candidate.querySelector(".glosa-tree-label")?.textContent?.toLocaleLowerCase().startsWith(typeahead),
      );
      if (match) focusItem(match.getAttribute("data-node-id") ?? id);
      event.preventDefault();
      return;
    } else return;

    event.preventDefault();
  }

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);

  return {
    /** @param {string} slug */
    setWorkspace(slug) {
      workspace = slug;
      currentPath = null;
      focusedId = null;
      loadExpansion();
      render();
    },

    /** @param {ArtifactSummary[]} artifacts */
    setArtifacts(artifacts) {
      root = buildArtifactTree(artifacts);
      const validDirectories = collectDirectoryIds(root);
      expanded = new Set([...expanded].filter((id) => validDirectories.has(id)));
      saveExpansion();
      render();
    },

    /** @param {Iterable<string>} paths */
    setOpenPaths(paths) {
      const next = new Set(paths ?? []);
      if (next.size === openPaths.size && [...next].every((path) => openPaths.has(path))) return;
      openPaths = next;
      render();
    },

    /** @param {string | null} path @param {{ reveal?: boolean }} [settings] */
    setCurrent(path, settings = {}) {
      currentPath = path;
      if (path && settings.reveal !== false) {
        for (const id of ancestorDirectoryIds(path)) expanded.add(id);
        saveExpansion();
      }
      render();
      if (path && settings.reveal !== false) {
        const current = findItem(fileId(path));
        current?.scrollIntoView?.({ block: "nearest" });
      }
    },

    expandAll() {
      expanded = collectDirectoryIds(root);
      saveExpansion();
      render();
    },

    collapseAll() {
      expanded.clear();
      saveExpansion();
      render();
    },

    destroy() {
      window.clearTimeout(typeaheadTimer);
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
    },
  };
}
