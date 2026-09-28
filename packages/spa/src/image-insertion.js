// SPDX-License-Identifier: Apache-2.0
import { imageMarkdown } from "./document-images.js";

export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.svg,.avif";
export function droppedImages(event) {
  const transfer = event.clipboardData ?? event.dataTransfer;
  return Array.from(transfer?.files ?? []).filter(
    (file) => /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file.name),
  );
}

/** Owns pending operations; a closed pane must never insert into its replacement. */
export function mountImageInsertion({ root, dataAccess, slug, documentPath, capture, status }) {
  let disposed = false;
  let dialog = null;
  let queue = Promise.resolve();
  const positions = new Set();
  function retain(insert) {
    if (!insert) return null;
    if (disposed) {
      insert.release?.();
      return null;
    }
    positions.add(insert);
    const release = insert.release;
    insert.release = () => {
      if (positions.delete(insert)) release?.();
    };
    return insert;
  }
  function capturePosition(coords, target) {
    const insert = capture(coords, target);
    return insert?.then ? insert.then(retain) : retain(insert);
  }
  async function upload(files, insert, alt = "") {
    try {
      for (const file of files) {
        if (disposed) return;
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error("Images must be 20 MiB or smaller.");
          status(`Adding ${file.name || "image"}…`);
          const result = await dataAccess.importImage(slug, file, { document_path: documentPath });
          if (disposed) return;
          if (!insert(imageMarkdown(result.relative_path, alt)))
            throw new Error("The insertion position changed. The image is saved; insert it again from the workspace.");
          status("");
        } catch (error) {
          if (!disposed) status(`${file.name || "Image"}: ${error.message}`);
        }
      }
    } finally {
      insert?.release?.();
    }
  }
  function receive(event) {
    if (!event.target.closest?.(".glosa-content, .glosa-rich-surface, .glosa-edit-area")) return;
    const files = droppedImages(event);
    if (!files.length) return;
    const insert = capturePosition(
      event.type === "drop" ? { left: event.clientX, top: event.clientY } : undefined,
      event.target,
    );
    if (!insert) return;
    event.preventDefault();
    event.stopPropagation();
    queue = queue
      .then(async () => {
        const position = await insert;
        if (position) await upload(files, position);
      })
      .catch((error) => {
        if (!disposed) status(error.message);
      });
  }
  function dragover(event) {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }
  root.addEventListener("paste", receive, true);
  root.addEventListener("drop", receive, true);
  root.addEventListener("dragover", dragover);

  function open() {
    if (disposed || dialog) return;
    const insert = capturePosition();
    if (!insert) {
      status("Place the cursor in the document to insert an image.");
      return;
    }
    dialog = document.createElement("dialog");
    dialog.className = "glosa-image-picker";
    dialog.setAttribute("aria-label", "Insert image");
    const title = document.createElement("h2");
    title.textContent = "Insert image";
    const altLabel = document.createElement("label");
    altLabel.textContent = "Description (alt text)";
    const alt = document.createElement("input");
    alt.type = "text";
    altLabel.append(alt);
    const label = document.createElement("label");
    label.textContent = "From workspace";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Workspace image");
    label.append(select);
    const hint = document.createElement("p");
    hint.setAttribute("role", "status");
    hint.textContent = "Loading workspace images…";
    const existing = document.createElement("button");
    existing.type = "button";
    existing.textContent = "Insert selected image";
    existing.disabled = true;
    const browse = document.createElement("button");
    browse.type = "button";
    browse.textContent = "Choose from disk…";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = IMAGE_ACCEPT;
    file.multiple = true;
    file.hidden = true;
    const thisDialog = dialog;
    const close = () => {
      thisDialog.close();
      thisDialog.remove();
      if (dialog === thisDialog) dialog = null;
    };
    cancel.onclick = () => {
      insert.release?.();
      close();
    };
    thisDialog.addEventListener("cancel", () => {
      insert.release?.();
      close();
    });
    browse.onclick = () => file.click();
    file.onchange = () => {
      const files = [...file.files];
      const text = alt.value;
      close();
      queue = queue.then(() => upload(files, insert, text));
    };
    existing.onclick = async () => {
      const selected = select.value;
      const text = alt.value;
      close();
      const folder = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
      if (selected.startsWith(folder)) {
        if (!disposed && !insert(imageMarkdown(selected.slice(folder.length), text)))
          status("The insertion position changed. Try again.");
        insert.release?.();
      } else {
        // The Markdown policy refuses parent traversal: copy this workspace image beside the document.
        try {
          const image = await dataAccess.getImage(slug, selected);
          if (disposed) return;
          const encoded = image.url.slice(image.url.indexOf(",") + 1);
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          queue = queue.then(() =>
            upload([new File([bytes], selected.split("/").pop(), { type: image.mime })], insert, text),
          );
        } catch (error) {
          insert.release?.();
          if (!disposed) status(error.message);
        }
      }
    };
    thisDialog.append(title, altLabel, label, hint, existing, browse, cancel, file);
    root.append(thisDialog);
    thisDialog.showModal();
    dataAccess
      .getImages(slug)
      .then((result) => {
        if (disposed || dialog !== thisDialog) return;
        for (const image of result.images) {
          const option = document.createElement("option");
          option.value = image.path;
          option.textContent = image.path;
          option.disabled = image.oversize;
          select.append(option);
        }
        existing.disabled = !result.images.some((image) => !image.oversize);
        hint.textContent = result.truncated
          ? "Showing a limited listing. Choose from disk to find another image."
          : result.images.length
            ? "Files from disk are copied into the images folder beside this document."
            : "No workspace images yet. Choose one from disk.";
      })
      .catch((error) => {
        if (dialog === thisDialog) hint.textContent = error.message;
      });
  }
  return {
    open,
    destroy() {
      disposed = true;
      for (const insert of positions) insert.release?.();
      dialog?.remove();
      dialog = null;
      root.removeEventListener("paste", receive, true);
      root.removeEventListener("drop", receive, true);
      root.removeEventListener("dragover", dragover);
    },
  };
}
