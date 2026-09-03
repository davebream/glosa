// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createViewerFeedbackController } from "../src/viewer-feedback.js";

describe("viewer feedback controller", () => {
  test("a late response for the previous workspace cannot replace the current workspace state", async () => {
    let slug = "old";
    let releaseOldWiring: ((value: unknown) => void) | undefined;
    let releaseOldStatus: ((value: unknown) => void) | undefined;
    const rendered: unknown[] = [];
    const dataAccess = {
      getWiringStatus: (requestedSlug: string) =>
        requestedSlug === "old"
          ? new Promise((resolve) => (releaseOldWiring = resolve))
          : Promise.resolve({ state: "wired", workspace: requestedSlug }),
      getStatus: () =>
        slug === "old"
          ? new Promise((resolve) => (releaseOldStatus = resolve))
          : Promise.resolve({ sessions: [{ workspace_binding: slug }] }),
      triggerInit: async () => ({ restart_required: false }),
    };
    const controller = createViewerFeedbackController({
      dataAccess,
      view: { setState: (state: unknown) => rendered.push(state) },
      getWorkspaceSlug: () => slug,
      confirmDialog: async () => false,
      noticeDialog: async () => {},
      pollIntervalMs: 60_000,
    });

    const oldRefresh = controller.refresh();
    slug = "current";
    await controller.refresh();
    releaseOldWiring?.({ state: "unwired", workspace: "old" });
    releaseOldStatus?.({ sessions: [{ workspace_binding: "old" }] });
    await oldRefresh;

    expect(rendered.at(-1)).toEqual({
      slug: "current",
      wiring: { state: "wired", workspace: "current" },
      status: { sessions: [{ workspace_binding: "current" }] },
    });
    expect(rendered).not.toContainEqual(expect.objectContaining({ slug: "current", wiring: { workspace: "old" } }));
    controller.destroy();
  });
});
