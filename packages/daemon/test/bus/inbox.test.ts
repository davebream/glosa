// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupOrphanInboxTempFiles,
  listInboxEntryIds,
  readInboxEntry,
  writeInboxEntryOnce,
} from "../../src/bus/inbox.ts";
import { inboxDir } from "../../src/bus/paths.ts";
import { cleanupWorkspace, freshWorkspace } from "./helpers.ts";

describe("inbox.ts — write-once, immutable", () => {
  test("round-trips and rejects a duplicate id with EEXIST", () => {
    const root = freshWorkspace();
    writeInboxEntryOnce(root, "e1", { kind: "human_edit" });
    expect(readInboxEntry(root, "e1")).toEqual({ kind: "human_edit" });

    expect(() => writeInboxEntryOnce(root, "e1", { kind: "annotation" })).toThrow();
    try {
      writeInboxEntryOnce(root, "e1", { kind: "annotation" });
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    }

    // The original content is untouched — never overwritten.
    expect(readInboxEntry(root, "e1")).toEqual({ kind: "human_edit" });
    cleanupWorkspace(root);
  });

  test("readInboxEntry returns null for a missing or unparseable entry, never throws", () => {
    const root = freshWorkspace();
    expect(readInboxEntry(root, "nope")).toBeNull();

    mkdirSync(inboxDir(root), { recursive: true });
    writeFileSync(join(inboxDir(root), "broken.json"), "{ not json");
    expect(readInboxEntry(root, "broken")).toBeNull();
    cleanupWorkspace(root);
  });

  test("listInboxEntryIds only sees finalized *.json files, never orphaned *.tmp ones", () => {
    const root = freshWorkspace();
    writeInboxEntryOnce(root, "e1", {});
    mkdirSync(inboxDir(root), { recursive: true });
    // Simulate a crash between temp-write and rename.
    writeFileSync(join(inboxDir(root), ".e2.crash.tmp"), JSON.stringify({}));

    expect(listInboxEntryIds(root)).toEqual(["e1"]); // e2 never existed as far as the bus is concerned
    cleanupWorkspace(root);
  });

  test("cleanupOrphanInboxTempFiles sweeps stray *.tmp files without touching real entries", () => {
    const root = freshWorkspace();
    writeInboxEntryOnce(root, "e1", { kind: "human_edit" });
    mkdirSync(inboxDir(root), { recursive: true });
    const orphan = join(inboxDir(root), ".e2.crash.tmp");
    writeFileSync(orphan, "{}");

    cleanupOrphanInboxTempFiles(root);

    expect(existsSync(orphan)).toBe(false);
    expect(listInboxEntryIds(root)).toEqual(["e1"]);
    expect(readInboxEntry(root, "e1")).toEqual({ kind: "human_edit" });
    cleanupWorkspace(root);
  });

  test("cleanupOrphanInboxTempFiles is a safe no-op when the inbox dir doesn't exist yet", () => {
    const root = freshWorkspace();
    expect(() => cleanupOrphanInboxTempFiles(root)).not.toThrow();
    cleanupWorkspace(root);
  });
});
