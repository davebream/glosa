// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceMetadataError,
  WorkspaceMetadataRegistry,
  validateWorkspaceMetadata,
  workspaceMetadataPath,
} from "../../src/adapters/workspace-metadata.ts";

describe("WorkspaceMetadataDescriptor v1", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "glosa-metadata-"));
    writeFileSync(join(root, "source.md"), "source");
    writeFileSync(join(root, "rendered.html"), "<p>rendered</p>");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, chunks: [] }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function descriptor(id = "fixture") {
    return {
      version: 1 as const,
      id,
      artifacts: [
        { path: "source.md", class: "R" as const, order: 0 },
        {
          path: "rendered.html",
          class: "F" as const,
          order: 1,
          derived_from: { path: "source.md", via: "render" },
          manifest: { path: "manifest.json", component: "renderer" },
        },
      ],
    };
  }

  test("persists, reloads after restart, and hydrates the generic adapter", async () => {
    const first = new WorkspaceMetadataRegistry();
    await first.set(root, descriptor());
    expect(JSON.parse(readFileSync(workspaceMetadataPath(root), "utf8"))).toEqual(descriptor());

    const restarted = new WorkspaceMetadataRegistry();
    expect(restarted.get(root)).toEqual(descriptor());
    const adapter = restarted.adapter();
    expect(adapter.recognizes(root)).toBe(true);
    expect(adapter.classifyArtifact?.(root, "rendered.html")).toBe("F");
    expect(adapter.derivedFrom?.(root, "rendered.html")).toEqual({ sourcePath: "source.md", process: "render" });
    expect(adapter.manifestFor?.(root, "rendered.html")).toEqual({ manifestPath: "manifest.json", component: "renderer", adapterId: "fixture" });
  });

  test("same id replaces atomically; different id conflicts until clear", async () => {
    const registry = new WorkspaceMetadataRegistry();
    expect((await registry.set(root, descriptor())).replaced).toBe(false);
    const replacement = descriptor();
    replacement.artifacts[0]!.order = 2;
    expect((await registry.set(root, replacement)).replaced).toBe(true);
    await expect(registry.set(root, descriptor("other"))).rejects.toMatchObject({ code: "metadata-conflict", status: 409 });
    expect(registry.get(root)).toEqual(replacement);
    expect(await registry.clear(root)).toBe(true);
    expect((await registry.set(root, descriptor("other"))).descriptor.id).toBe("other");
  });

  test("malformed replacement leaves the active descriptor and bytes unchanged", async () => {
    const registry = new WorkspaceMetadataRegistry();
    await registry.set(root, descriptor());
    const before = readFileSync(workspaceMetadataPath(root), "utf8");
    await expect(registry.set(root, { ...descriptor(), artifacts: [{ path: "missing.md" }] })).rejects.toBeInstanceOf(WorkspaceMetadataError);
    expect(readFileSync(workspaceMetadataPath(root), "utf8")).toBe(before);
    expect(registry.get(root)).toEqual(descriptor());
  });

  test("non-JSON roots are validation failures rather than internal errors", () => {
    expect(() => validateWorkspaceMetadata(root, undefined)).toThrow(WorkspaceMetadataError);
    expect(() => validateWorkspaceMetadata(root, 1n)).toThrow(WorkspaceMetadataError);
  });

  test("rejects duplicate, escaping, missing-reference, and symlink paths", async () => {
    const registry = new WorkspaceMetadataRegistry();
    await expect(registry.set(root, { ...descriptor(), artifacts: [{ path: "source.md" }, { path: "source.md" }] })).rejects.toThrow("duplicate");
    await expect(registry.set(root, { ...descriptor(), artifacts: [{ path: "../outside.md" }] })).rejects.toThrow("confined");
    await expect(registry.set(root, { ...descriptor(), artifacts: [{ path: "source.md", derived_from: { path: "missing.md", via: "render" } }] })).rejects.toThrow("does not exist");
    symlinkSync(join(root, "source.md"), join(root, "linked.md"));
    await expect(registry.set(root, { ...descriptor(), artifacts: [{ path: "linked.md" }] })).rejects.toThrow("symlinks");
  });

  test("empty registry preserves zero-adapter behavior", () => {
    const registry = new WorkspaceMetadataRegistry();
    expect(registry.get(root)).toBeNull();
    expect(registry.adapter().recognizes(root)).toBe(false);
  });
});
