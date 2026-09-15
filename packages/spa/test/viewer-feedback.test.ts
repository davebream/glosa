// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createViewerFeedbackController } from "../src/viewer-feedback.js";

describe("viewer feedback controller", () => {
  test("a late response for the previous workspace cannot replace the current workspace state", async () => {
    let slug = "old";
    let releaseOldStatus: ((value: unknown) => void) | undefined;
    const rendered: unknown[] = [];
    const dataAccess = {
      getStatus: () =>
        slug === "old"
          ? new Promise((resolve) => (releaseOldStatus = resolve))
          : Promise.resolve({ sessions: [{ workspace_binding: slug }] }),
    };
    const controller = createViewerFeedbackController({
      dataAccess,
      view: { setState: (state: unknown) => rendered.push(state) },
      getWorkspaceSlug: () => slug,
      pollIntervalMs: 60_000,
    });

    const oldRefresh = controller.refresh();
    slug = "current";
    await controller.refresh();
    releaseOldStatus?.({ sessions: [{ workspace_binding: "old" }] });
    await oldRefresh;

    expect(rendered.at(-1)).toEqual({
      slug: "current",
      status: { sessions: [{ workspace_binding: "current" }] },
    });
    expect(rendered).not.toContainEqual(
      expect.objectContaining({ slug: "current", status: { sessions: [{ workspace_binding: "old" }] } }),
    );
    controller.destroy();
  });

  test("the controller reaches the daemon only through getStatus — no wiring or init route exists (#152)", () => {
    const calls: string[] = [];
    const dataAccess = new Proxy(
      {},
      {
        get: (_target, name) => {
          calls.push(String(name));
          return async () => ({ sessions: [] });
        },
      },
    );
    const controller = createViewerFeedbackController({
      dataAccess,
      view: { setState: () => {} },
      getWorkspaceSlug: () => "ws",
      pollIntervalMs: 60_000,
    });
    controller.selectWorkspace();
    controller.destroy();
    expect(calls).toEqual(["getStatus"]);
  });
});
