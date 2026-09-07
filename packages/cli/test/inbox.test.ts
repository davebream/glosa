// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { printJsonEnvelope } from "../src/envelope.ts";
import {
  printInboxDismissResult,
  printInboxGetResult,
  printInboxListResult,
  runInboxDismiss,
  runInboxGet,
  runInboxList,
} from "../src/inbox.ts";
import { runResolve } from "../src/resolve.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
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
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data.presentation?.text).toBe("actionable page");
    expect(client.calls).toEqual([{ method: "getInboxPresentation", args: ["/repo", "inb-1", "opaque"] }]);

    // Success `--json` output is byte-for-byte unchanged: `data` is the presentation object
    // itself, never nested under `.presentation`.
    const out = captureStdout(() => printInboxGetResult(result, true));
    const parsed = JSON.parse(out);
    expect(parsed.data.text).toBe("actionable page");
    expect(parsed.data.presentation).toBeUndefined();
  });

  test("createClient failure (no daemon running) is exit 3, never exit 70 (previously escaped to run()'s boundary handler)", async () => {
    const result = await runInboxGet(
      { workspace: "/repo", id: "inb-1" },
      {
        createClient: async () => {
          throw daemonUnreachable("no peer answered");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error?.code).toBe("daemon-unreachable");
  });

  test("an unknown entry maps through mapEntryFailure to exit 8, not an unmapped throw", async () => {
    const client = new FakeGlosaApiClient();
    client.getInboxPresentation = async () => {
      throw apiError(404, { title: "unknown inbox entry" });
    };
    const result = await runInboxGet({ workspace: "/repo", id: "inb-missing" }, { createClient: async () => client });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(8);
    expect(result.error?.kind).toBe("entry_error");
  });
});

describe("glosa inbox dismiss", () => {
  test("threads workspace/id/note to the daemon and returns the dismissed envelope", async () => {
    const client = new FakeGlosaApiClient();
    client.dismissEntryImpl = async (path, entry, note) => ({ entry, status: "dismissed", to: "dismissed" });
    const result = await runInboxDismiss(
      { workspace: "/repo", id: "inb-1", note: "closing unread" },
      { createClient: async () => client },
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ entry: "inb-1", status: "dismissed", to: "dismissed" });
    expect(client.calls).toEqual([{ method: "dismissEntry", args: ["/repo", "inb-1", "closing unread"] }]);

    const out = captureStdout(() => printInboxDismissResult(result, false));
    expect(out).toBe("glosa inbox dismiss: inb-1 -> dismissed\n");
  });

  test("missing <id> -> exit 2 (usage), never touches the daemon", async () => {
    const client = new FakeGlosaApiClient();
    const result = await runInboxDismiss({ workspace: "/repo" }, { createClient: async () => client });
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("an entry-related failure (unknown id, already terminal) maps to exit 8", async () => {
    const client = new FakeGlosaApiClient();
    client.dismissEntryImpl = async () => {
      throw apiError(409, { title: "entry is already applied" });
    };
    const result = await runInboxDismiss({ workspace: "/repo", id: "inb-1" }, { createClient: async () => client });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(8);
    expect(result.error?.kind).toBe("entry_error");
  });

  test("createClient failure (no daemon running) is exit 3", async () => {
    const result = await runInboxDismiss(
      { workspace: "/repo", id: "inb-1" },
      {
        createClient: async () => {
          throw daemonUnreachable("no peer answered");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error?.code).toBe("daemon-unreachable");
  });
});

describe("glosa inbox list — daemon-unreachable exit code", () => {
  test("createClient failure is exit 3, matching get and dismiss", async () => {
    const result = await runInboxList(
      { workspace: "/repo" },
      {
        createClient: async () => {
          throw daemonUnreachable("no peer answered");
        },
      },
    );
    expect(result.exitCode).toBe(3);
  });
});

describe("positive control — dismiss did not loosen resolve's --session requirement", () => {
  test("glosa resolve <id> applied still exits 2 without --session", async () => {
    const client = new FakeGlosaApiClient();
    const result = await runResolve(
      { dir: "/repo", id: "inb-1", outcome: "applied" },
      { createClient: async () => client },
    );
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });
});
