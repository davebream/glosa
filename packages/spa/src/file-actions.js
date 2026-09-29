// SPDX-License-Identifier: Apache-2.0
// The tree owns these actions. Editors keep their own undo and keyboard handling.
import { confirmDialog } from "./dialog.js";

const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const leafOf = (path) => path.split("/").pop();
function node(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

export function createFileActions({ tree, navigator, dataAccess, enabled, getSlug, prepare, changed, dirty, open }) {
  const toolbar = node("div", { className: "glosa-file-actions", hidden: true });
  toolbar.setAttribute("aria-label", "File actions");
  const status = node("div", { className: "glosa-file-status", hidden: true });
  const message = node("span");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const undoButton = node("button", {
    type: "button",
    className: "glosa-btn glosa-btn-ghost",
    textContent: "Undo",
    hidden: true,
  });
  status.append(message, undoButton);
  tree.before(toolbar);
  tree.after(status);
  let formats = null,
    selected = null,
    editor = null,
    menu = null,
    busy = false,
    generation = 0;
  const stacks = new Map();
  const deferred = [];
  function stack() {
    const slug = getSlug();
    if (!stacks.has(slug)) stacks.set(slug, []);
    return stacks.get(slug);
  }
  function announce(text, error = false) {
    status.hidden = false;
    message.setAttribute("role", error ? "alert" : "status");
    message.textContent = text;
    undoButton.hidden = !stack().length;
    undoButton.textContent = stack().at(-1)?.action === "trash" ? "Put back" : "Undo";
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function rowSelection(event) {
    const row = event.target.closest?.('[role="treeitem"]');
    if (!row) return null;
    return { path: row.dataset.nodeId.slice(2), folder: row.dataset.kind === "directory", row };
  }
  function focus(path, folder = false) {
    navigator.focusPath(path, folder);
  }
  function cancelEditor() {
    if (!editor) return;
    const previous = editor.previous;
    editor.element.remove();
    editor = null;
    navigator.pause(false);
    if (previous) focus(previous.path, previous.folder);
    else toolbar.querySelector("button")?.focus();
  }
  async function execute(action, body) {
    if (busy) return null;
    const slug = getSlug(),
      ticket = generation;
    busy = true;
    let release;
    try {
      release = await prepare(body.destination_path ?? body.from ?? body.path ?? "");
      const request = () =>
        action === "undo"
          ? dataAccess.undoFileOperation(slug, body.receipt)
          : action === "restore"
            ? dataAccess.restoreFileHistory(slug, body)
            : dataAccess[`${action}Path`](slug, body);
      let result;
      for (;;) {
        try {
          result = await request();
          break;
        } catch (error) {
          if (error.problem?.type?.endsWith("/dirty-artifact") && action === "restore" && !body.force) {
            if (
              !(await confirmDialog({
                title: "Replace the current image?",
                body: error.problem.would_be_lost_diff ?? error.message,
                confirmLabel: "Restore image",
              }))
            )
              return null;
            body.force = true;
            continue;
          }
          if (!error.problem?.type?.endsWith("/claimed") || action === "undo" || body.take_over) throw error;
          const claims = error.problem.claims ?? [];
          if (
            !claims.length ||
            !(await confirmDialog({
              title: "An agent is editing this item",
              body: `${claims.map((claim) => claim.holder_label).join(", ")}. Continuing stops its claim on these files.`,
              confirmLabel: "Continue anyway",
            }))
          )
            return null;
          body.take_over = claims.map((claim) => claim.id);
          // A changed holder is a fresh refusal. Each confirmation permits only one retry.
        }
      }
      if (ticket !== generation || slug !== getSlug()) return result;
      if (result.receipt) {
        stack().push({ action, body: { ...body }, receipt: result.receipt });
        if (stack().length > 50) stack().shift();
      }
      await changed(action, body, result);
      announce(
        result.history_status === "pending"
          ? "The file changed, but history recording was interrupted. Restart glosa before another action."
          : action === "undo"
            ? "Put back. Your files are restored."
            : action === "trash"
              ? `${leafOf(body.path)} moved to the Trash.`
              : action === "rename"
                ? `Renamed to ${leafOf(body.to)}.`
                : action === "restore"
                  ? `Restored ${body.destination_path ?? body.path}.`
                  : `Created ${leafOf(body.path)}.`,
      );
      return result;
    } catch (error) {
      announce(error.message || "This file action could not finish.", true);
      return null;
    } finally {
      release?.();
      busy = false;
      for (const callback of deferred.splice(0)) await callback();
    }
  }
  function editName(action, kind, target = selected) {
    if (busy || !formats?.manageable) return;
    closeMenu();
    cancelEditor();
    const directory =
      action === "rename" ? parentOf(target.path) : target?.folder ? target.path : parentOf(target?.path ?? "");
    const wrapper = node("div", { className: "glosa-file-name-editor" });
    const input = node("input", {
      type: "text",
      value: action === "rename" ? leafOf(target.path) : "",
      placeholder: kind === "folder" ? "Folder name" : "File name",
      className: "glosa-input",
    });
    input.setAttribute(
      "aria-label",
      action === "rename" ? "New name" : kind === "folder" ? "Folder name" : "File name",
    );
    const extension = node("select");
    extension.setAttribute("aria-label", "File format");
    for (const format of formats.documents)
      extension.append(node("option", { value: format.extension, textContent: format.extension }));
    extension.value = formats.default_extension;
    const save = node("button", {
      type: "button",
      className: "glosa-btn glosa-btn-ghost",
      textContent: action === "rename" ? "Rename" : "Create",
    });
    const cancel = node("button", { type: "button", className: "glosa-btn glosa-btn-ghost", textContent: "Cancel" });
    const error = node("p", { className: "glosa-file-name-error" });
    error.setAttribute("role", "alert");
    wrapper.append(input);
    if (action === "create" && kind === "file") wrapper.append(extension);
    wrapper.append(save, cancel, error);
    navigator.pause(true);
    const row = target?.row?.querySelector(".glosa-tree-row");
    if (row?.isConnected) row.after(wrapper);
    else tree.prepend(wrapper);
    editor = { element: wrapper, previous: target };
    async function submit() {
      let name = input.value;
      if (
        !name ||
        name.startsWith(".") ||
        /[\\/]/.test(name) ||
        [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        /[. ]$/.test(name) ||
        new TextEncoder().encode(name).length > 255
      ) {
        error.textContent = "Use a name without slashes, hidden prefixes, or trailing spaces.";
        input.focus();
        return;
      }
      if (action === "create" && kind === "file" && !name.includes(".")) name += extension.value;
      const path = directory ? `${directory}/${name}` : name;
      if (action === "rename" && path === target.path) {
        cancelEditor();
        return;
      }
      save.disabled = true;
      const result = await execute(action, action === "rename" ? { from: target.path, to: path } : { path, kind });
      save.disabled = false;
      if (!result) {
        error.textContent = message.textContent;
        input.focus();
        return;
      }
      cancelEditor();
      focus(path, kind === "folder");
      if (action === "create" && kind === "file") await open(path, { mode: "edit" });
    }
    save.addEventListener("click", () => void submit());
    cancel.addEventListener("click", cancelEditor);
    wrapper.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelEditor();
      }
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void submit();
      }
    });
    input.focus();
    if (action === "rename")
      input.setSelectionRange(
        0,
        kind === "folder" || !input.value.includes(".") ? input.value.length : input.value.lastIndexOf("."),
      );
  }
  async function trash(target = selected) {
    if (!target || busy) return;
    closeMenu();
    try {
      const info = await dataAccess.inspectPath(getSlug(), target.path);
      if (target.folder || info.open_notes || dirty(target.path)) {
        const body = target.folder
          ? `${info.documents} documents, ${info.images} images and ${info.other_files} other items. Everything in this folder moves to the Trash. History can restore supported files and folders; the Trash keeps all contents.`
          : `${info.open_notes} open notes. Unsaved edits stay in their tab until you put this file back.`;
        if (
          !(await confirmDialog({
            title: `Move ${leafOf(target.path)} to the Trash?`,
            body,
            confirmLabel: "Move to Trash",
            danger: true,
          }))
        )
          return;
      }
      const result = await execute("trash", { path: target.path });
      if (result) {
        const parent = parentOf(target.path);
        if (parent) focus(parent, true);
        else toolbar.querySelector("button")?.focus();
      }
    } catch (error) {
      announce(error.message, true);
    }
  }
  async function undo() {
    if (busy) return;
    const entry = stack().pop();
    if (!entry) return;
    await execute("undo", { receipt: entry.receipt, path: entry.body.to ?? entry.body.path ?? entry.body.from });
    undoButton.hidden = !stack().length;
  }
  function showMenu(target) {
    if (!formats?.manageable || editor || busy) return;
    closeMenu();
    selected = target;
    menu = node("div", { className: "glosa-file-menu" });
    menu.setAttribute("role", "menu");
    const items = [
      ["New file · ⌥⌘N", () => editName("create", "file", target)],
      ["New folder", () => editName("create", "folder", target)],
    ];
    if (target)
      items.push(
        ["Rename · F2", () => editName("rename", target.folder ? "folder" : "file", target)],
        ["Move to Trash · ⌘⌫", () => void trash(target)],
      );
    for (const [label, action] of items) {
      const button = node("button", { type: "button", textContent: label });
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", action);
      menu.append(button);
    }
    const anchor = target?.row?.querySelector(".glosa-tree-row");
    if (anchor) anchor.after(menu);
    else toolbar.append(menu);
    menu.addEventListener("keydown", (event) => {
      const buttons = [...menu.querySelectorAll("button")],
        index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        target?.row?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        ].focus();
      }
      event.stopPropagation();
    });
    menu.querySelector("button")?.focus();
  }
  function keydown(event) {
    if (
      !formats?.manageable ||
      event.defaultPrevented ||
      event.isComposing ||
      event.getModifierState?.("AltGraph") ||
      event.target.closest?.("input, textarea, select, [contenteditable=true], [role=menu]")
    )
      return;
    const target = rowSelection(event) ?? selected;
    let action;
    if (event.code === "KeyN" && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey)
      action = () => editName("create", "file", target);
    else if (event.code === "KeyZ" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey)
      action = undo;
    else if (event.code === "F2" && target && !event.metaKey && !event.ctrlKey && !event.altKey)
      action = () => editName("rename", target.folder ? "folder" : "file", target);
    else if (
      target &&
      ((event.code === "Backspace" && event.metaKey) || (event.code === "Delete" && !event.metaKey)) &&
      !event.ctrlKey &&
      !event.altKey
    )
      action = () => trash(target);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) action = () => showMenu(target);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      void action();
    }
  }
  async function history() {
    closeMenu();
    const dialog = node("dialog", { className: "glosa-dialog glosa-file-history" });
    const title = node("h2", { textContent: "File history" });
    const versions = node("select");
    versions.setAttribute("aria-label", "Saved version");
    const list = node("div"),
      close = node("button", { type: "button", textContent: "Close", className: "glosa-btn glosa-btn-ghost" });
    dialog.append(title, versions, list, close);
    document.body.append(dialog);
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
    const slug = getSlug();
    try {
      const checkpoints = await dataAccess.getCheckpoints(slug);
      for (const item of checkpoints.checkpoints ?? checkpoints)
        versions.append(
          node("option", {
            value: item.checkpoint_id,
            textContent: `${new Date(item.at).toLocaleString()} · ${item.by === "human" ? "You" : item.by?.startsWith("session:") ? "An agent session" : "Unknown change"}`,
          }),
        );
      async function contents(cursor = "0", append = false) {
        const checkpoint = versions.value;
        if (!checkpoint) {
          list.textContent = "No saved versions yet.";
          return;
        }
        const result = await dataAccess.getCheckpointContents(slug, { checkpoint, cursor });
        if (checkpoint !== versions.value || !dialog.isConnected) return;
        if (!append) list.replaceChildren();
        for (const item of result.items) {
          const row = node("div", { className: "glosa-history-file" });
          const label = node("span", { textContent: `${item.path}${item.kind === "folder" ? "/" : ""}` });
          const input = node("input", { value: item.path, className: "glosa-input" });
          input.setAttribute("aria-label", `Restore ${item.path} to a free path`);
          const restore = node("button", {
            type: "button",
            textContent: "Restore copy",
            className: "glosa-btn glosa-btn-ghost",
          });
          row.append(label, input, restore);
          if (item.kind === "image") {
            const preview = node("button", {
              type: "button",
              textContent: "Preview",
              className: "glosa-btn glosa-btn-ghost",
            });
            row.append(preview);
            preview.addEventListener("click", async () => {
              try {
                const image = await dataAccess.getImage(slug, item.path, { checkpoint });
                row.append(
                  node("img", { src: image.url, alt: `Saved ${item.path}`, className: "glosa-history-image" }),
                );
                preview.disabled = true;
              } catch (error) {
                announce(error.message, true);
              }
            });
          }
          restore.addEventListener("click", async () => {
            restore.disabled = true;
            try {
              if (slug !== getSlug()) return;
              const result = await execute("restore", {
                to: checkpoint,
                path: item.path,
                destination_path: input.value,
              });
              if (result) dialog.close();
              else {
                const notice = node("p", { textContent: message.textContent });
                notice.setAttribute("role", "alert");
                row.append(notice);
              }
            } catch (error) {
              const notice = node("p", { textContent: error.message });
              notice.setAttribute("role", "alert");
              row.append(notice);
            } finally {
              restore.disabled = false;
            }
          });
          list.append(row);
        }
        if (result.next_cursor !== null) {
          const more = node("button", {
            textContent: "More files",
            type: "button",
            className: "glosa-btn glosa-btn-ghost",
          });
          more.addEventListener("click", () => {
            more.remove();
            void contents(String(result.next_cursor), true);
          });
          list.append(more);
        }
      }
      versions.addEventListener(
        "change",
        () =>
          void contents().catch((error) => {
            list.textContent = error.message;
          }),
      );
      await contents();
    } catch (error) {
      list.textContent = error.message;
    }
  }
  for (const [label, action] of [
    ["New file", () => editName("create", "file")],
    ["New folder", () => editName("create", "folder")],
    ["History", () => void history()],
  ]) {
    const button = node("button", { type: "button", textContent: label, className: "glosa-btn glosa-btn-ghost" });
    button.addEventListener("click", action);
    toolbar.append(button);
  }
  undoButton.addEventListener("click", () => void undo());
  tree.addEventListener("focusin", (event) => {
    selected = rowSelection(event) ?? selected;
  });
  tree.addEventListener("contextmenu", (event) => {
    if (!formats?.manageable) return;
    event.preventDefault();
    showMenu(rowSelection(event));
  });
  tree.addEventListener("keydown", keydown, true);
  toolbar.addEventListener("keydown", keydown);
  const outside = (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
  };
  document.addEventListener("pointerdown", outside);
  return {
    get busy() {
      return busy;
    },
    defer(callback) {
      if (busy) deferred.push(callback);
      else void callback();
    },
    async setWorkspace() {
      const ticket = ++generation;
      cancelEditor();
      closeMenu();
      selected = null;
      formats = null;
      toolbar.hidden = true;
      status.hidden = true;
      if (!enabled || !dataAccess.getFileFormats) return;
      try {
        const result = await dataAccess.getFileFormats(getSlug());
        if (ticket === generation) {
          formats = result;
          toolbar.hidden = !result.manageable;
        }
      } catch {
        /* Older daemons have no file actions. */
      }
    },
    destroy() {
      document.removeEventListener("pointerdown", outside);
      tree.removeEventListener("keydown", keydown, true);
      cancelEditor();
      closeMenu();
      toolbar.remove();
      status.remove();
    },
  };
}
