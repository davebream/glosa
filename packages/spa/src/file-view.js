// SPDX-License-Identifier: Apache-2.0
// A folder's viewing choices; persistence and transport are injected by the workbench.
export function createFileViewControls(tree, { change, retry }) {
  const element = document.createElement("details");
  element.className = "glosa-file-view";
  element.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "All files";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Show ";
  const mode = document.createElement("select");
  mode.setAttribute("aria-label", "Files shown");
  for (const [value, label] of [
    ["all", "All files"],
    ["documents", "Documents only"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }
  modeLabel.append(mode);
  const ignoredLabel = document.createElement("label");
  const ignored = document.createElement("input");
  ignored.type = "checkbox";
  ignoredLabel.append(ignored, " Show ignored files");
  element.append(summary, modeLabel, ignoredLabel);
  const notice = document.createElement("p");
  notice.className = "glosa-file-view-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const message = document.createElement("span");
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.textContent = "Retry";
  retryButton.onclick = retry;
  notice.append(message, retryButton);
  tree.before(element);
  tree.after(notice);
  let current = { mode: "all", show_ignored: false },
    busy = false;
  async function save() {
    if (busy) return;
    busy = true;
    mode.disabled = ignored.disabled = true;
    try {
      await change({ mode: mode.value, show_ignored: ignored.checked });
    } catch (error) {
      fail(`Could not save this view: ${error.message}`);
    } finally {
      busy = false;
      render();
    }
  }
  function render() {
    mode.value = current.mode;
    ignored.checked = current.show_ignored;
    mode.disabled = busy;
    ignored.disabled = busy || current.mode === "documents";
    summary.textContent =
      current.mode === "documents"
        ? "Documents only"
        : current.show_ignored
          ? "All files · including ignored"
          : "All files";
  }
  function fail(text) {
    notice.hidden = false;
    message.textContent = text;
    retryButton.hidden = false;
  }
  mode.onchange = ignored.onchange = save;
  return {
    update(view, listing) {
      element.hidden = !view;
      if (!view) {
        notice.hidden = true;
        return;
      }
      current = view;
      render();
      const omitted =
        view.mode === "all" && listing.omitted_count
          ? `${listing.omitted_count.toLocaleString()} more files not shown.`
          : "";
      message.textContent = [omitted, listing.warning].filter(Boolean).join(" ");
      notice.hidden = !message.textContent;
      retryButton.hidden = !listing.warning;
    },
    fail,
    destroy() {
      element.remove();
      notice.remove();
    },
  };
}
