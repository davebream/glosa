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
    else if (key.startsWith("data-")) node.setAttribute(key, value);
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
export function mountHistoryPane(container, { dataAccess, slug, path }) {
  container.textContent = "";
  const list = el("ul", { className: "glosa-history-list" });
  const diffPane = el("div", { className: "glosa-diff-pane" });
  const status = el("p", { className: "glosa-history-status" });
  const compareCurrentButton = el("button", {
    className: "glosa-history-compare-current",
    type: "button",
    textContent: "Compare selected with current",
    onClick: () => void compareSelected(),
  });
  container.append(el("h3", { textContent: "Version history" }), status, compareCurrentButton, list, diffPane);

  let selected = [];
  let rows = [];

  function renderDiff(html) {
    diffPane.innerHTML = html; // Diff2Html's own output — trusted (built from the daemon's diff text, not raw user HTML)
  }

  async function compareSelected() {
    if (selected.length === 0) return;
    const [from, to] = selected.length === 2 ? selected : [selected[0], "working"];
    const diff = await dataAccess.getDiff(slug, { from, to });
    const unified = diff.hunks.map((h) => h.diff).join("\n");
    if (!unified) {
      diffPane.textContent = "No differences.";
      return;
    }
    renderDiff(Diff2Html.html(unified, { drawFileList: true, outputFormat: "line-by-line" }));
  }

  async function restoreTo(checkpointId, force) {
    try {
      await dataAccess.restore(slug, { path, to: checkpointId, force });
      status.textContent = "Restored.";
      await refresh();
    } catch (err) {
      if (err?.status === 409 && err.problem?.would_be_lost_diff) {
        const lostHtml = Diff2Html.html(err.problem.would_be_lost_diff, { drawFileList: false, outputFormat: "line-by-line" });
        renderDiff(lostHtml);
        const proceed =
          typeof window !== "undefined" && window.confirm
            ? window.confirm("This artifact has unsaved changes since its latest saved version. Restoring will discard them — continue?")
            : false;
        if (proceed) await restoreTo(checkpointId, true);
      } else {
        throw err;
      }
    }
  }

  function renderList() {
    list.textContent = "";
    for (const row of rows) {
      const checkbox = el("input", { type: "checkbox" });
      checkbox.checked = selected.includes(row.checkpoint_id);
      checkbox.addEventListener("change", () => {
        selected = selectionReducer(selected, row.checkpoint_id);
        // Only auto-compare once a full pair is picked — comparing after the FIRST checkbox would
        // silently default to "vs working" (compareSelected's own fallback for a lone selection),
        // firing a second, different comparison the instant the human checks the second box too.
        if (selected.length === 2) void compareSelected();
      });
      const restoreBtn = el("button", {
        type: "button",
        textContent: "Restore this version",
        onClick: () => void restoreTo(row.checkpoint_id, false),
      });
      restoreBtn.disabled = !path;
      list.append(
        el("li", { className: "glosa-history-row" }, [
          checkbox,
          el("span", {
            className: "glosa-history-attribution",
            textContent: describeAttribution(row.by),
            // Provenance chip styling hook (app.css): honest three-way shape — solid "You",
            // accent-tinted session, dashed unknown — never color alone (brief §7.5).
            "data-by": row.by === "human" ? "human" : typeof row.by === "string" && row.by.startsWith("session:") ? "session" : "unknown",
          }),
          el("span", { className: "glosa-history-kind", textContent: describeCheckpointKind(row.summary) }),
          el("time", { textContent: formatTimestamp(row.at) }),
          restoreBtn,
        ]),
      );
    }
  }

  async function refresh() {
    rows = await dataAccess.getCheckpoints(slug);
    selected = selected.filter((id) => rows.some((r) => r.checkpoint_id === id));
    renderList();
  }

  void refresh();
  return refresh;
}
