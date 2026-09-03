// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceIndex, type WorkspaceIndexFile, workspaceIndexPath } from "../../src/registry/workspace-index.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir } from "./helpers.ts";

function replaceRegistrationId(index: WorkspaceIndexFile, previousId: string, nextId: string): void {
  const entry = index.workspaces[previousId];
  if (!entry) throw new Error(`missing fixture registration ${previousId}`);
  delete index.workspaces[previousId];
  index.workspaces[nextId] = { ...entry, registration_id: nextId };
}

describe("WorkspaceIndex — adoption source ordering", () => {
  test("beginAdoption persists sources in byte-exact UTF-8 registration-id order", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();

    try {
      const firstPath = join(root, "z.md");
      const secondPath = join(root, "é.md");
      writeFileSync(firstPath, "z\n");
      writeFileSync(secondPath, "accent\n");

      const seed = new WorkspaceIndex({ home, now: deterministicClock() });
      const first = await seed.resolveOpenTarget(firstPath);
      const second = await seed.resolveOpenTarget(secondPath);
      mkdirSync(first.entry.bus_path, { recursive: true });
      mkdirSync(second.entry.bus_path, { recursive: true });

      // Real v1 registration IDs are lowercase SHA-256 hex, whose current alphabet happens to
      // collate like UTF-8 bytes. Rekey the durable fixture to cover a future ID format (and old
      // index data) where locale collation disagrees: ICU puts "é" before "z", while UTF-8 puts
      // 0x7a (z) before 0xc3 0xa9 (é). The exercised code remains the real index reload and
      // beginAdoption path, rather than a detached comparator unit test.
      const persisted = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")) as WorkspaceIndexFile;
      replaceRegistrationId(persisted, first.entry.registration_id, "z-source");
      replaceRegistrationId(persisted, second.entry.registration_id, "é-source");
      writeFileSync(workspaceIndexPath(home), JSON.stringify(persisted));

      const index = new WorkspaceIndex({ home, now: deterministicClock() });
      const target = await index.resolveOpenTarget(root);
      const adoption = await index.beginAdoption(target.entry);

      expect(adoption?.sources.map((source) => source.registration_id)).toEqual(["z-source", "é-source"]);
    } finally {
      cleanup(home);
      cleanup(root);
    }
  });

  test("beginAdoption never delegates durable ordering to locale collation", () => {
    // The behavioral fixture above distinguishes the two orders on this host. This structural
    // backstop keeps the guarantee meaningful on a host whose locale happens to collate the
    // fixture like UTF-8 byte order.
    const source = readFileSync(new URL("../../src/registry/workspace-index.ts", import.meta.url), "utf8");
    const methodStart = source.indexOf("  beginAdoption(");
    const methodEnd = source.indexOf("\n  markAdoptionSourcesSealed(", methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    expect(source.slice(methodStart, methodEnd)).not.toContain("localeCompare");
  });
});
