// SPDX-License-Identifier: Apache-2.0
// A4 "Cross-cutting invariant": daemon mutation runs "under an in-process async mutex keyed by
// immutable registration ID", and F21 requires "ONE git mutex/workspace". Both collapse unless a
// directory has exactly ONE registration id: `WorkspaceBus` derives its mutex key from
// `workspaceRegistrationId(target)` (src/bus/bus.ts), so if a bare-string target and the
// `WorkspaceLocation` the index persists for the same directory hash differently, one
// `shadow.git` and one `journal.ndjson` end up behind two mutex slots and two writer fds — the
// two-live-operators case A4 F21's `index.lock` reclaim explicitly cannot recover from.
import { describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyedMutex } from "../src/bus/mutex.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { workspaceRegistrationId } from "../src/workspace.ts";
import { cleanup, freshHome, freshWorkspaceDir } from "./registry/helpers.ts";

describe("workspaceRegistrationId — one canonical id per workspace", () => {
  test("a bare directory string hashes to the SAME id the index persists for that directory", async () => {
    const home = freshHome();
    const dir = realpathSync(freshWorkspaceDir());
    const index = new WorkspaceIndex({ home });

    const entry = await index.resolveOpenTarget(dir);

    // `entry.registration_id` is the sha256 that reaches `~/.glosa/workspaces.json` and
    // `~/.glosa/state/<id>`. The bare worktree path is what every pre-location caller passes.
    // They must be indistinguishable as a key.
    expect(entry.entry.kind).toBe("directory");
    expect(workspaceRegistrationId(entry.entry.worktree_path)).toBe(entry.entry.registration_id);
    expect(workspaceRegistrationId(entry.entry)).toBe(entry.entry.registration_id);

    cleanup(home);
    cleanup(dir);
  });

  test("the id is a bare sha256 hex digest — never a `directory:<path>` locator", async () => {
    const home = freshHome();
    const dir = realpathSync(freshWorkspaceDir());
    const index = new WorkspaceIndex({ home });
    await index.resolveOpenTarget(dir);

    const id = workspaceRegistrationId(dir);

    // The `directory:` form embedded a raw path, so it could never collide with the hashed form
    // the index writes. Pin the shape, not just the value: a locator-shaped key regressing here
    // silently re-splits the mutex.
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(dir);
    expect(id).not.toContain("directory:");

    cleanup(home);
    cleanup(dir);
  });

  test("registration kind is part of the identity — a loose file never collides with a directory of the same path", async () => {
    const home = freshHome();
    const dir = realpathSync(freshWorkspaceDir()); // no .git in its ancestry -> loose-file path
    const docPath = join(dir, "note.md");
    writeFileSync(docPath, "note");
    const index = new WorkspaceIndex({ home });

    const opened = await index.resolveOpenTarget(docPath);

    // A4 F04 gives a loose registration its own `~/.glosa/state/<id>` bus. If the string form
    // ignored `kind`, `workspaceRegistrationId(<file path>)` would alias a hypothetical
    // directory registration at the same path onto that bus.
    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.canonical_path).toBe(docPath);
    expect(workspaceRegistrationId(opened.entry)).toBe(opened.entry.registration_id);
    expect(workspaceRegistrationId(docPath)).not.toBe(opened.entry.registration_id);

    cleanup(home);
    cleanup(dir);
  });

  test("both target forms claim the SAME KeyedMutex slot, so two buses over one root serialize", async () => {
    const home = freshHome();
    const dir = realpathSync(freshWorkspaceDir());
    const index = new WorkspaceIndex({ home });
    const entry = (await index.resolveOpenTarget(dir)).entry;

    // This is the failure mode in miniature: `WorkspaceBus` takes exactly this key from exactly
    // this shared `KeyedMutex`. Same slot -> the second holder queues; different slots -> both
    // run concurrently against one `shadow.git`.
    const mutex = new KeyedMutex<string>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBody = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusive(workspaceRegistrationId(entry), async () => {
      order.push("first-enter");
      await firstBody;
      order.push("first-exit");
    });
    const second = mutex.runExclusive(workspaceRegistrationId(entry.worktree_path), () => {
      order.push("second-enter");
    });

    await Bun.sleep(0);
    expect(order).toEqual(["first-enter"]); // second must NOT have run yet
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);

    cleanup(home);
    cleanup(dir);
  });
});
