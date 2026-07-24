// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the history/timeline pane (A6 §F31, P3.5): lists checkpoints for the workspace,
// lets the human pick any two (or one + "current") to compare in a diff pane, and restore an
// artifact to a chosen checkpoint. Talks to the daemon ONLY through data-access.js (R6's ONE
// data-access module) — never `fetch` directly (see test/import-boundary.test.ts).
//
// R1: the UI speaks DOCUMENT-NATIVE language, never "commit"/"SHA" — `checkpoint_id` is treated
// as an opaque token here (used only as an id to pass back to the daemon), and every user-visible
// label goes through `describeCheckpointKind`/`describeAttribution` below rather than surfacing
// the raw `summary`/`by` fields (which ARE git-shaped internally — `human_edit`, `session:<id>` —
// that's the API's business, not the reader's).
import { Diff2Html } from "./vendor/diff2html.js";
import { confirmDialog } from "./dialog.js";

/** Maps a checkpoint's raw `summary` (the `Glosa-Kind` trailer value, per checkpoints.ts) to a
 * short, document-native phrase. An unrecognized kind (future trailer value this UI doesn't know
 * about yet) falls back to "Saved version" rather than leaking the raw token. */
export function describeCheckpointKind(kind) {
  switch (kind) {
    case "baseline":
      return "Started tracking this version";
    case "human_edit":
      return "You edited this version";
    case "restore":
      return "You restored an earlier version";
    case "pre_apply":
      return "Version before an agent change";
    case "post_apply":
      return "Agent applied a change";
    case "auto_checkpoint":
      return "Autosaved version";
    default:
      return "Saved version";
  }
}

/** Maps a checkpoint's raw `by` attribution (`human`|`unknown`|`session:<id>`) to a document-
 * native phrase — never echoes the raw `session:<id>` form. */
export function describeAttribution(by) {
  if (by === "human") return "You";
  if (by === "unknown") return "Unknown change";
  if (typeof by === "string" && by.startsWith("session:")) return "An agent session";
  return "Unknown change";
}

export function formatTimestamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Pure selection state: up to two checkpoint ids picked for comparison. Toggling a third
 * selection drops the OLDEST pick (FIFO), so the human never has to manually deselect before
 * picking a new pair. `toggle` on an already-selected id deselects it.
 */
export function selectionReducer(selected, id) {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  if (selected.length < 2) return [...selected, id];
  return [selected[1], id];
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onClick") node.addEventListener("click", value);
    else if (key === "className") node.className = value;
    else if (key.startsWith("data-") || key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * Mounts the history/timeline pane into `container` for `path` (the currently open artifact) in
 * `slug`'s workspace. `dataAccess` defaults to a real `createDataAccess()` import — but per R6's
 * ONE-module rule this file never constructs one itself (viewer.js, which already holds the app's
 * single `dataAccess` instance, passes it in). Returns a `refresh()` the caller can invoke after
 * an SSE artifact-change event so the timeline picks up new checkpoints.
 */
export function mountHistoryPane(container, { dataAccess, slug, path, canRestore = false, onClose = () => {} }) {
  container.textContent = "";
  const list = el("ul", { className: "glosa-history-list" });
  const diffPane = el("div", { className: "glosa-diff-pane" });
  const status = el("p", {
    className: "glosa-history-status",
    role: "status",
    "aria-live": "polite",
    textContent: "Select one version to compare it with the current artifact, or select two earlier versions.",
  });
  const compareCurrentButton = el("button", {
    className: "glosa-history-compare-current",
    type: "button",
    textContent: "Compare selected with current",
    onClick: () => void compareSelected(),
  });
  compareCurrentButton.disabled = true;
  const closeButton = el("button", { type: "button", className: "glosa-context-close", textContent: "Close version history", onClick: () => onClose?.() });
  container.append(el("header", { className: "glosa-context-header" }, [el("h3", { tabIndex: -1, textContent: "Version history" }), closeButton]), status, compareCurrentButton, list, diffPane);

  let selected = [];
  let rows = [];

  function renderDiff(html) {
    diffPane.innerHTML = html; // Diff2Html's own output — trusted (built from the daemon's diff text, not raw user HTML)
  }

  async function compareSelected() {
    if (selected.length === 0) return;
    status.removeAttribute("data-error");
    status.textContent = "Loading comparison…";
    try {
      const [from, to] = selected.length === 2 ? selected : [selected[0], "working"];
      const diff = await dataAccess.getDiff(slug, { from, to });
      const unified = diff.hunks.map((h) => h.diff).join("\n");
      if (!unified) {
        diffPane.textContent = "No differences.";
        status.textContent = "Comparison ready. No differences found.";
        return;
      }
      renderDiff(Diff2Html.html(unified, { drawFileList: true, outputFormat: "line-by-line" }));
      status.textContent = "Comparison ready.";
    } catch (error) {
      status.setAttribute("data-error", "true");
      status.textContent = error instanceof Error ? `Couldn't load the comparison: ${error.message}` : "Couldn't load the comparison. Try again.";
    }
  }

  async function restoreTo(checkpointId, force) {
    try {
      await dataAccess.restore(slug, { path, to: checkpointId, force });
      status.removeAttribute("data-error");
      status.textContent = "Restored.";
      await refresh();
    } catch (err) {
      if (err?.status === 409 && err.problem?.would_be_lost_diff) {
        // The dirty-worktree guard: show exactly what a forced restore would throw away (the
        // daemon's would-be-lost diff, rendered in the pane behind the dialog), then ask.
        const lostHtml = Diff2Html.html(err.problem.would_be_lost_diff, { drawFileList: false, outputFormat: "line-by-line" });
        renderDiff(lostHtml);
        const proceed = await confirmDialog({
          title: "Discard the changes shown behind this dialog?",
          body: "This artifact changed since its latest saved version. Restoring will throw those changes away — the diff pane shows exactly what would be lost.",
          confirmLabel: "Restore anyway",
          danger: true,
        });
        if (proceed) await restoreTo(checkpointId, true);
        else status.textContent = "Restore canceled.";
      } else {
        status.setAttribute("data-error", "true");
        status.textContent = err instanceof Error ? `Couldn't restore this version: ${err.message}` : "Couldn't restore this version. Try again.";
      }
    }
  }

  function syncSelectionControls() {
    for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = selected.includes(checkbox.value);
    }
    compareCurrentButton.disabled = selected.length === 0;
    if (selected.length > 0) {
      status.removeAttribute("data-error");
      status.textContent = selected.length === 1
        ? "One version selected. Compare it with the current artifact or select a second version."
        : "Two versions selected. Loading their comparison…";
    }
  }

  function renderList() {
    list.textContent = "";
    for (const row of rows) {
      const kindLabel = describeCheckpointKind(row.summary);
      const attributionLabel = describeAttribution(row.by);
      const timestampLabel = formatTimestamp(row.at);
      const checkbox = el("input", {
        type: "checkbox",
        name: "history-version",
        value: row.checkpoint_id,
        "aria-label": `Select ${kindLabel}, ${attributionLabel}, ${timestampLabel}, for comparison`,
      });
      checkbox.checked = selected.includes(row.checkpoint_id);
      checkbox.addEventListener("change", () => {
        selected = selectionReducer(selected, row.checkpoint_id);
        syncSelectionControls();
        // Only auto-compare once a full pair is picked — comparing after the FIRST checkbox would
        // silently default to "vs working" (compareSelected's own fallback for a lone selection),
        // firing a second, different comparison the instant the human checks the second box too.
        if (selected.length === 2) void compareSelected();
      });
      const restoreBtn = el("button", {
        type: "button",
        textContent: "Restore this version",
        onClick: async () => {
          const proceed = await confirmDialog({
            title: "Restore this version?",
            body: `Restoring the version from ${timestampLabel} replaces the current artifact content.`,
            confirmLabel: "Restore version",
            danger: true,
          });
          if (proceed) void restoreTo(row.checkpoint_id, false);
        },
      });
      restoreBtn.disabled = !path;
      list.append(
        el("li", { className: "glosa-history-row" }, [
          checkbox,
          el("span", {
            className: "glosa-history-attribution",
            textContent: attributionLabel,
            // Provenance chip styling hook (app.css): honest three-way shape — solid "You",
            // accent-tinted session, dashed unknown — never color alone (brief §7.5).
            "data-by": row.by === "human" ? "human" : typeof row.by === "string" && row.by.startsWith("session:") ? "session" : "unknown",
          }),
          el("span", { className: "glosa-history-kind", textContent: kindLabel }),
          el("time", { dateTime: row.at, textContent: timestampLabel }),
          ...(canRestore ? [restoreBtn] : []),
        ]),
      );
    }
    syncSelectionControls();
  }

  async function refresh() {
    try {
      rows = await dataAccess.getCheckpoints(slug);
      selected = selected.filter((id) => rows.some((r) => r.checkpoint_id === id));
      renderList();
    } catch (error) {
      status.setAttribute("data-error", "true");
      status.textContent = error instanceof Error ? `Couldn't load version history: ${error.message}` : "Couldn't load version history. Try again.";
    }
  }

  void refresh();
  return refresh;
}
