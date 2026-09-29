// SPDX-License-Identifier: Apache-2.0
// Only a text preview loads CodeMirror. Binary and oversized files need no viewer bundle.
export function createReadOnlyPane(host, { dataAccess, slug, path, onStateChange = () => {} }) {
  const element = document.createElement("section");
  element.className = "glosa-pane glosa-read-only-pane";
  element.setAttribute("aria-label", `Read-only file: ${path}`);
  const toolbar = document.createElement("div");
  toolbar.className = "glosa-read-only-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Read-only file tools");
  const label = document.createElement("span");
  label.textContent = "Read-only";
  const find = document.createElement("button");
  find.type = "button";
  find.textContent = "Find";
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.textContent = "Wrap lines";
  wrap.setAttribute("aria-pressed", "false");
  toolbar.append(label, find, wrap);
  const status = document.createElement("p");
  status.className = "glosa-read-only-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading file…";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.hidden = true;
  const content = document.createElement("div");
  content.className = "glosa-read-only-content";
  const metadata = document.createElement("p");
  metadata.className = "glosa-read-only-metadata";
  element.append(toolbar, status, retry, content, metadata);
  host.append(element);
  let disposed = false,
    generation = 0,
    viewer = null,
    missing = false,
    wrapped = false;
  find.disabled = wrap.disabled = true;
  find.onclick = () => viewer?.find();
  wrap.onclick = () => {
    wrapped = !wrapped;
    wrap.setAttribute("aria-pressed", String(wrapped));
    viewer?.wrap(wrapped);
  };
  retry.onclick = () => void refresh();
  async function refresh() {
    const ticket = ++generation;
    try {
      const result = await dataAccess.getReadOnlyFile(slug, path);
      if (disposed || ticket !== generation) return;
      missing = false;
      retry.hidden = true;
      metadata.textContent = `${path} · ${new Intl.NumberFormat().format(result.size_bytes)} bytes · ${result.file_type}`;
      if (result.kind === "text") {
        const { mountCodeViewer } = await import("./code-viewer.js");
        if (disposed || ticket !== generation) return;
        if (viewer) viewer.update(result.text);
        else viewer = mountCodeViewer(content, { text: result.text, path, wrapped });
        status.hidden = true;
        find.disabled = wrap.disabled = false;
      } else {
        viewer?.destroy();
        viewer = null;
        content.replaceChildren();
        status.hidden = false;
        status.textContent =
          result.reason === "binary"
            ? "Binary file. A text preview is not available."
            : "This file exceeds the text preview limit.";
        find.disabled = wrap.disabled = true;
      }
      onStateChange();
    } catch (error) {
      if (disposed || ticket !== generation) return;
      missing = true;
      metadata.textContent = "";
      viewer?.destroy();
      viewer = null;
      content.replaceChildren();
      status.hidden = false;
      status.textContent = `${path}: ${error.message || "File could not be read."}`;
      retry.hidden = false;
      find.disabled = wrap.disabled = true;
      onStateChange();
    }
  }
  const ready = refresh();
  return {
    kind: "read-only",
    element,
    ready,
    get path() {
      return path;
    },
    get title() {
      return path.split("/").pop();
    },
    isMissing: () => missing,
    refreshReadOnly: refresh,
    focus: () => viewer?.focus(),
    retarget(nextPath) {
      path = nextPath;
      viewer?.retarget(path);
      element.setAttribute("aria-label", `Read-only file: ${path}`);
      void refresh();
    },
    rebindPanel() {},
    destroy() {
      disposed = true;
      generation++;
      viewer?.destroy();
      element.remove();
    },
  };
}
