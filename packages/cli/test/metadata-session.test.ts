// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlosaApiClient } from "../src/api-client.ts";
import { runMetadata } from "../src/metadata.ts";
import { runSessionBind } from "../src/session.ts";

describe("metadata/session CLI contract", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("metadata set/show/clear use stable descriptor-only data", async () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-cli-metadata-"));
    roots.push(root);
    const file = join(root, "metadata.json");
    const descriptor = { version: 1 as const, id: "fixture", artifacts: [] };
    writeFileSync(file, JSON.stringify(descriptor));
    const calls: unknown[] = [];
    const client: Partial<GlosaApiClient> = {
      setMetadata: async (workspace, metadata) => {
        calls.push(["set", workspace, metadata]);
        return { metadata, replaced: false };
      },
      getMetadata: async (workspace) => {
        calls.push(["show", workspace]);
        return descriptor;
      },
      clearMetadata: async (workspace) => {
        calls.push(["clear", workspace]);
        return { cleared: true };
      },
    };
    const createClient = async () => client as GlosaApiClient;
    expect((await runMetadata({ action: "set", workspace: "/private/workspace", file }, createClient)).data).toEqual({ metadata: descriptor, replaced: false });
    expect((await runMetadata({ action: "show", workspace: "/private/workspace" }, createClient)).data).toEqual({ metadata: descriptor });
    expect((await runMetadata({ action: "clear", workspace: "/private/workspace" }, createClient)).data).toEqual({ cleared: true });
    expect(JSON.stringify(calls)).toContain("/private/workspace");
    expect(JSON.stringify((await runMetadata({ action: "show", workspace: "/private/workspace" }, createClient)).data)).not.toContain("/private/workspace");
  });

  test("session bind reports only the session id and bound state", async () => {
    const client: Partial<GlosaApiClient> = {
      bindSession: async (_workspace, sessionId) => ({ bound: true, session_id: sessionId }),
    };
    const result = await runSessionBind("/private/workspace", "session-1", async () => client as GlosaApiClient);
    expect(result.data).toEqual({ bound: true, session_id: "session-1" });
    expect(JSON.stringify(result.data)).not.toContain("/private/workspace");
  });

  test("metadata set rejects unreadable or invalid JSON before contacting the daemon", async () => {
    let contacted = false;
    const result = await runMetadata(
      { action: "set", workspace: "/workspace", file: "/does/not/exist.json" },
      async () => {
        contacted = true;
        return {} as GlosaApiClient;
      },
    );
    expect(result.exitCode).toBe(2);
    expect(contacted).toBe(false);
  });
});
