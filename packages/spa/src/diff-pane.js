// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — a comparison as a pane (design brief 2026-09-04 §4). One of the three pane kinds
// shipping with the workbench, beside `artifact-R` and `artifact-F`.
//
// The history surface already knew how to fetch and render a diff; what it could not do was leave
// the comparison on screen beside the manuscript it describes. A diff tab is that comparison,
// parked in the dock like any other document, so a reader can read a draft against the version it
// replaced without either one going away.
//
// Talks to the daemon ONLY through the injected data-access instance (R6), never `fetch`.

import { splitDirectory, splitPath } from "./artifact-pane.js";
import { Diff2Html } from "./vendor/diff2html.js";
import { createElement as el } from "./viewer-shell.js";

/** Mounts a diff pane for `path` between two versions. `to: "working"` is the live file. */
export function createDiffPane(host, { dataAccess, slug, path, from, to, describeVersion }) {
  const fromLabel = describeVersion(from);
  const toLabel = describeVersion(to);

  const { dir, name } = splitPath(path);
  const { head, tail } = splitDirectory(dir);
  const identity = el("div", { className: "glosa-artifact-id" }, [
    el("span", { className: "glosa-artifact-dir", hidden: !dir }, [
      el("span", { className: "glosa-artifact-dir-head", textContent: head }),
      el("span", { className: "glosa-artifact-dir-tail", textContent: tail }),
    ]),
    el("span", { className: "glosa-artifact-name", textContent: name }),
  ]);
  identity.title = path;
  const range = el("p", {
    className: "glosa-diff-range",
    textContent: `${fromLabel} → ${toLabel}`,
  });
  const status = el("p", {
    className: "glosa-diff-status",
    role: "status",
    "aria-live": "polite",
    textContent: "Loading comparison…",
  });
  const surface = el("div", { className: "glosa-diff-surface" });
  const bar = el("div", { className: "glosa-artifact-bar" }, [identity, range]);
  const paneMain = el("main", { className: "glosa-pane-main glosa-diff-main" }, [status, surface]);
  const paneEl = el("section", { className: "glosa-pane", "data-kind": "diff", "aria-label": "Version comparison" }, [
    bar,
    paneMain,
  ]);
  host.append(paneEl);

  let destroyed = false;

  async function load() {
    status.removeAttribute("data-error");
    status.hidden = false;
    status.textContent = "Loading comparison…";
    try {
      const diff = await dataAccess.getDiff(slug, { from, to });
      if (destroyed) return;
      // The workspace diff covers every changed file; this pane is about one artifact, so it
      // keeps only that file's hunks rather than showing the reader a comparison they did not ask
      // for. A hunk with no path attribution is kept — dropping it would silently hide a change.
      const hunks = (diff.hunks ?? []).filter((hunk) => !hunk.path || hunk.path === path);
      const unified = hunks.map((hunk) => hunk.diff).join("\n");
      if (!unified.trim()) {
        surface.textContent = "";
        status.textContent = `No differences between ${fromLabel} and ${toLabel}.`;
        return;
      }
      // Diff2Html's own output — trusted (built from the daemon's diff text, not raw user HTML).
      surface.innerHTML = Diff2Html.html(unified, { drawFileList: false, outputFormat: "line-by-line" });
      status.hidden = true;
    } catch (error) {
      if (destroyed) return;
      status.hidden = false;
      status.setAttribute("data-error", "true");
      status.textContent =
        error instanceof Error
          ? `Couldn't load this comparison: ${error.message}`
          : "Couldn't load this comparison. Try again.";
    }
  }

  const ready = load();

  return {
    element: paneEl,
    path,
    ready,
    kind: "diff",
    getMode: () => "preview",
    setMode: () => {},
    isDirty: () => false,
    annotationCount: () => 0,
    isMissing: () => false,
    isStale: () => false,
    artifactClass: () => null,
    focus: () => {
      surface.setAttribute("tabindex", "-1");
      surface.focus({ preventScroll: true });
    },
    // A comparison is a snapshot of two named versions. `to: "working"` is the only side that can
    // move, so that is the only case where a live artifact change means anything here.
    refreshArtifact: () => (to === "working" ? load() : Promise.resolve()),
    applyJournalEvent: () => false,
    markMissing: () => {},
    refreshHistory: () => {},
    remeasure: () => {},
    confirmClose: () => Promise.resolve(true),
    destroy() {
      destroyed = true;
      paneEl.remove();
    },
  };
}
