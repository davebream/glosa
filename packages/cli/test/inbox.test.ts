// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { runInboxGet } from "../src/inbox.ts";
import { FakeGlosaApiClient } from "./fake-api-client.ts";

describe("glosa inbox get", () => {
  test("threads workspace/id/cursor to the stable daemon retrieval surface", async () => {
    const client = new FakeGlosaApiClient();
    client.inboxPresentationResult = {
      presentation: {
        id: "inb-1",
        kind: "annotation",
        status: "pending",
        text: "actionable page",
        bytes: 15,
        detail: {},
        truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
        retrieval: { command: "glosa inbox get inb-1", mcp_tool: "glosa_inbox_get" },
      },
    };
    const result = await runInboxGet(
      { workspace: "/repo", id: "inb-1", cursor: "opaque" },
      { createClient: async () => client },
    );
    expect(result.presentation.text).toBe("actionable page");
    expect(client.calls).toEqual([{ method: "getInboxPresentation", args: ["/repo", "inb-1", "opaque"] }]);
  });
});
