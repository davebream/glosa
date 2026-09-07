// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { printJsonEnvelope } from "../src/envelope.ts";
import { printInboxListResult, runInboxGet, runInboxList } from "../src/inbox.ts";
import { daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

describe("glosa inbox list", () => {
  test("threads workspace/all to the daemon and the JSON envelope carries the raw ISO created_at (D6)", async () => {
    const client = new FakeGlosaApiClient();
    client.inboxListResult = {
      entries: [
        {
          id: "inb-1",
          kind: "common",
          status: "pending",
          created_at: "2024-01-01T00:00:00.000Z",
          target_path: null,
          payload_present: true,
        },
      ],
    };
    const result = await runInboxList({ workspace: "/repo", all: true }, { createClient: async () => client });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data.entries[0]?.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(client.calls).toEqual([{ method: "listInboxEntries", args: ["/repo", { all: true }] }]);

    const out = captureStdout(() => printJsonEnvelope(result));
    const parsed = JSON.parse(out);
    expect(parsed.data.entries[0].created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  test("createClient failure (no daemon running) is exit 3, never thrown", async () => {
    const result = await runInboxList(
      { workspace: "/repo" },
      {
        createClient: async () => {
          throw daemonUnreachable("no peer answered");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error?.code).toBe("daemon-unreachable");
    expect(result.data.entries).toEqual([]);
  });

  test("human rendering: two-space-indented columns, `-` for a missing target_path, and a `[no payload]` marker that never drops the row", () => {
    const client = new FakeGlosaApiClient();
    client.inboxListResult = {
      entries: [
        {
          id: "inb-kept",
          kind: "common",
          status: "pending",
          created_at: new Date(Date.now() - 65_000).toISOString(),
          target_path: "notes.md",
          payload_present: true,
        },
        {
          id: "inb-orphaned",
          kind: "common",
          status: "pending",
          created_at: null,
          target_path: null,
          payload_present: false,
        },
      ],
    };
    return runInboxList({ workspace: "/repo" }, { createClient: async () => client }).then((result) => {
      const out = captureStdout(() => printInboxListResult(result, false));
      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^ {2}inb-kept {2}common {2}pending {2}\S+ {2}notes\.md$/);
      expect(lines[0]).not.toContain("no payload");
      expect(lines[1]).toContain("inb-orphaned");
      expect(lines[1]).toContain("  -  ");
      expect(lines[1]).toContain("[no payload]");
    });
  });
});

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
