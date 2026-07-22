// SPDX-License-Identifier: Apache-2.0
// P6.1 — unit coverage for the generic-behavior helpers in src/adapters/interface.ts: given an
// adapter's answers (or no adapter at all), do these compute exactly the generic thing R7
// promises, with zero domain knowledge? Pure functions, no HTTP/filesystem workspace scaffolding
// needed (resolveManifest is the one exception — it reads a manifest FILE when an adapter names a
// path, so it gets a real tmp dir).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  classifyWithAdapter,
  derivedFromSourcePath,
  isArtifactStale,
  orderWithAdapter,
  resolveManifest,
  type AdapterSessionHint,
  type ContentAdapter,
} from "../../src/adapters/interface.ts";

function fakeAdapter(overrides: Partial<ContentAdapter> = {}): ContentAdapter {
  return { id: "fake", recognizes: () => true, ...overrides };
}

describe("AdapterRegistry", () => {
  test("forWorkspace returns the FIRST registered adapter whose recognizes() is true — registration order, not specificity", () => {
    const registry = new AdapterRegistry();
    const first = fakeAdapter({ id: "first", recognizes: (root) => root === "/w" });
    const second = fakeAdapter({ id: "second", recognizes: (root) => root === "/w" });
    registry.register(first);
    registry.register(second);
    expect(registry.forWorkspace("/w")).toBe(first);
  });

  test("no adapter recognizes the workspace -> undefined, not a throw", () => {
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter({ recognizes: () => false }));
    expect(registry.forWorkspace("/nowhere")).toBeUndefined();
  });

  test("an empty registry recognizes nothing", () => {
    expect(new AdapterRegistry().forWorkspace("/anything")).toBeUndefined();
  });

  test("Fix 1: a throwing recognizes() on an earlier adapter doesn't stop the registry from checking later ones, and doesn't crash", () => {
    const registry = new AdapterRegistry();
    registry.register(
      fakeAdapter({
        id: "buggy",
        recognizes: () => {
          throw new Error("boom — buggy adapter");
        },
      }),
    );
    const good = fakeAdapter({ id: "good", recognizes: (root) => root === "/w" });
    registry.register(good);
    expect(registry.forWorkspace("/w")).toBe(good);
  });

  test("list() surfaces every registered adapter in registration order", () => {
    const registry = new AdapterRegistry();
    const a = fakeAdapter({ id: "a" });
    const b = fakeAdapter({ id: "b" });
    registry.register(a);
    registry.register(b);
    expect(registry.list()).toEqual([a, b]);
  });

  describe("resolveSessionBinding", () => {
    const hint: AdapterSessionHint = { session_id: "s1", provider: "claude-code", cwd: "/home/x", source: "startup" };

    test("first adapter with a non-empty answer wins, in registration order", () => {
      const registry = new AdapterRegistry();
      registry.register(fakeAdapter({ id: "silent", sessionBinding: () => null }));
      registry.register(fakeAdapter({ id: "answers", sessionBinding: () => "/bound/workspace" }));
      expect(registry.resolveSessionBinding(hint)).toBe("/bound/workspace");
    });

    test("no adapter has an opinion -> null, defers to the core's cwd-ancestor fallback", () => {
      const registry = new AdapterRegistry();
      registry.register(fakeAdapter({ sessionBinding: () => null }));
      expect(registry.resolveSessionBinding(hint)).toBeNull();
    });

    test("an adapter with no sessionBinding method at all is skipped, not a throw", () => {
      const registry = new AdapterRegistry();
      registry.register(fakeAdapter()); // no sessionBinding
      registry.register(fakeAdapter({ sessionBinding: () => "/x" }));
      expect(registry.resolveSessionBinding(hint)).toBe("/x");
    });

    test("an empty-string answer is treated as no opinion, not a real binding", () => {
      const registry = new AdapterRegistry();
      registry.register(fakeAdapter({ sessionBinding: () => "" }));
      expect(registry.resolveSessionBinding(hint)).toBeNull();
    });

    test("Fix 1: a throwing sessionBinding() degrades to null (not a throw) and the registry keeps asking other adapters", () => {
      const registry = new AdapterRegistry();
      registry.register(
        fakeAdapter({
          id: "buggy",
          sessionBinding: () => {
            throw new Error("boom — buggy adapter");
          },
        }),
      );
      registry.register(fakeAdapter({ id: "answers", sessionBinding: () => "/bound/workspace" }));
      expect(registry.resolveSessionBinding(hint)).toBe("/bound/workspace");
    });
  });
});

describe("classifyWithAdapter", () => {
  test("no adapter -> the fallback (extension-based) classification", () => {
    expect(classifyWithAdapter(undefined, "/w", "notes.md", "R")).toBe("R");
  });

  test("adapter with no classifyArtifact method -> falls back", () => {
    expect(classifyWithAdapter(fakeAdapter(), "/w", "notes.md", "R")).toBe("R");
  });

  test("adapter returns undefined for this path -> falls back", () => {
    const adapter = fakeAdapter({ classifyArtifact: () => undefined });
    expect(classifyWithAdapter(adapter, "/w", "notes.md", "R")).toBe("R");
  });

  test("adapter overrides the classification", () => {
    const adapter = fakeAdapter({ classifyArtifact: () => "F" });
    expect(classifyWithAdapter(adapter, "/w", "notes.md", "R")).toBe("F");
  });

  test("Fix 1: a throwing classifyArtifact() degrades to the extension-based fallback, not a throw", () => {
    const adapter = fakeAdapter({
      classifyArtifact: () => {
        throw new Error("boom — buggy adapter");
      },
    });
    expect(classifyWithAdapter(adapter, "/w", "notes.md", "R")).toBe("R");
  });
});

describe("derivedFromSourcePath", () => {
  test("no adapter -> undefined", () => {
    expect(derivedFromSourcePath(undefined, "/w", "out.html")).toBeUndefined();
  });

  test("adapter declares no edge for this path -> undefined", () => {
    const adapter = fakeAdapter({ derivedFrom: () => null });
    expect(derivedFromSourcePath(adapter, "/w", "out.html")).toBeUndefined();
  });

  test("adapter declares an edge -> the source path", () => {
    const adapter = fakeAdapter({ derivedFrom: () => ({ sourcePath: "src.md", process: "render" }) });
    expect(derivedFromSourcePath(adapter, "/w", "out.html")).toBe("src.md");
  });

  test("Fix 1: a throwing derivedFrom() degrades to undefined (\"no edge\"), not a throw", () => {
    const adapter = fakeAdapter({
      derivedFrom: () => {
        throw new Error("boom — buggy adapter");
      },
    });
    expect(derivedFromSourcePath(adapter, "/w", "out.html")).toBeUndefined();
  });
});

describe("isArtifactStale", () => {
  test("no adapter -> never stale", () => {
    expect(isArtifactStale(undefined, "/w", "out.html", 1000, () => 2000)).toBe(false);
  });

  test("no derived-from edge -> never stale", () => {
    const adapter = fakeAdapter({ derivedFrom: () => null });
    expect(isArtifactStale(adapter, "/w", "out.html", 1000, () => 2000)).toBe(false);
  });

  test("source can't be resolved (deleted/untracked) -> can't prove staleness, fails open (false)", () => {
    const adapter = fakeAdapter({ derivedFrom: () => ({ sourcePath: "src.md", process: "render" }) });
    expect(isArtifactStale(adapter, "/w", "out.html", 1000, () => null)).toBe(false);
  });

  test("source mtime AFTER the artifact's own mtime -> stale", () => {
    const adapter = fakeAdapter({ derivedFrom: () => ({ sourcePath: "src.md", process: "render" }) });
    expect(isArtifactStale(adapter, "/w", "out.html", 1000, () => 2000)).toBe(true);
  });

  test("source mtime BEFORE (or equal to) the artifact's own mtime -> not stale", () => {
    const adapter = fakeAdapter({ derivedFrom: () => ({ sourcePath: "src.md", process: "render" }) });
    expect(isArtifactStale(adapter, "/w", "out.html", 2000, () => 1000)).toBe(false);
    expect(isArtifactStale(adapter, "/w", "out.html", 2000, () => 2000)).toBe(false);
  });

  test("Fix 1: a throwing derivedFrom() degrades to never-stale, not a throw", () => {
    const adapter = fakeAdapter({
      derivedFrom: () => {
        throw new Error("boom — buggy adapter");
      },
    });
    expect(isArtifactStale(adapter, "/w", "out.html", 1000, () => 2000)).toBe(false);
  });
});

describe("orderWithAdapter", () => {
  const paths = ["a.md", "b.md", "c.md"];

  test("no adapter -> the original order, unchanged", () => {
    expect(orderWithAdapter(undefined, "/w", paths)).toEqual(paths);
  });

  test("adapter with no sidebarOrder method -> the original order", () => {
    expect(orderWithAdapter(fakeAdapter(), "/w", paths)).toEqual(paths);
  });

  test("adapter's permutation is honored", () => {
    const adapter = fakeAdapter({ sidebarOrder: (_root, xs) => [...xs].reverse() });
    expect(orderWithAdapter(adapter, "/w", paths)).toEqual(["c.md", "b.md", "a.md"]);
  });

  test("an adapter that DROPS a real path still surfaces it, appended at the end — an artifact can never disappear from the sidebar", () => {
    const adapter = fakeAdapter({ sidebarOrder: () => ["c.md"] });
    expect(orderWithAdapter(adapter, "/w", paths)).toEqual(["c.md", "a.md", "b.md"]);
  });

  test("an adapter that INJECTS a foreign path never gets it into the result", () => {
    const adapter = fakeAdapter({ sidebarOrder: (_root, xs) => ["ghost.md", ...xs] });
    expect(orderWithAdapter(adapter, "/w", paths)).toEqual(paths);
  });

  test("an adapter that duplicates a path in its permutation only surfaces it once", () => {
    const adapter = fakeAdapter({ sidebarOrder: () => ["a.md", "a.md", "b.md", "c.md"] });
    expect(orderWithAdapter(adapter, "/w", paths)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("Fix 1: a throwing sidebarOrder() degrades to the original order, not a throw", () => {
    const adapter = fakeAdapter({
      sidebarOrder: () => {
        throw new Error("boom — buggy adapter");
      },
    });
    expect(orderWithAdapter(adapter, "/w", paths)).toEqual(paths);
  });
});

describe("resolveManifest", () => {
  test("no adapter -> null", () => {
    expect(resolveManifest("/w", undefined, "out.html")).toBeNull();
  });

  test("adapter declares no manifest for this path -> null", () => {
    const adapter = fakeAdapter({ manifestFor: () => null });
    expect(resolveManifest("/w", adapter, "out.html")).toBeNull();
  });

  test("Fix 1: a throwing manifestFor() degrades to null, not a throw", () => {
    const adapter = fakeAdapter({
      manifestFor: () => {
        throw new Error("boom — buggy adapter");
      },
    });
    expect(resolveManifest("/w", adapter, "out.html")).toBeNull();
  });

  test("adapter hands back an already-parsed manifest inline — no filesystem read", () => {
    const manifest = { manifest_version: 1 as const, source_path: "src.md", source_sha256: "abc", chunks: [] };
    const adapter = fakeAdapter({ manifestFor: () => ({ manifest, component: "renderer" }) });
    const result = resolveManifest("/nonexistent-root", adapter, "out.html");
    expect(result).toEqual({ manifest, component: "renderer", adapterId: "fake" });
  });

  describe("adapter names a manifestPath — read + parsed through confinePath", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "glosa-adapter-manifest-"));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    // The real manifest-path convention (A1 §5.4, requirements.md's `manifest_path` example) is a
    // plain ".json" file — it never matches the sidebar's tracked-artifact `include` glob
    // (`**/*.md`/`**/*.html`/`**/*.txt`), and per Fix 2 that's fine: `resolveManifest` only
    // rejects a manifestPath that falls in an EXCLUDED directory (`.glosa/**` etc.), never one
    // that merely fails the include list. These fixtures use ".json" throughout to prove that.
    test("valid manifest file -> parsed and returned with manifestPath set", () => {
      const manifest = { manifest_version: 1 as const, source_path: "src.md", source_sha256: "abc", chunks: [] };
      writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: "manifest.json", component: "renderer" }) });
      const result = resolveManifest(root, adapter, "out.html");
      expect(result).toEqual({ manifest, component: "renderer", manifestPath: "manifest.json", adapterId: "fake" });
    });

    test("regression (Fix 2): a real-convention .json manifest OUTSIDE any excluded directory resolves successfully, not null — the sidebar's include-glob (md/html/txt only) must NOT gate this path", () => {
      const manifest = { manifest_version: 1 as const, source_path: "src.md", source_sha256: "abc", chunks: [] };
      mkdirSync(join(root, "chunks-2026"), { recursive: true });
      writeFileSync(join(root, "chunks-2026", "manifest.json"), JSON.stringify(manifest));
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: "chunks-2026/manifest.json", component: "renderer" }) });
      const result = resolveManifest(root, adapter, "out.html");
      expect(result).toEqual({ manifest, component: "renderer", manifestPath: "chunks-2026/manifest.json", adapterId: "fake" });
    });

    test("manifestPath escaping the workspace (confinePath rejection) -> null, never a throw", () => {
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: "../../etc/passwd", component: "renderer" }) });
      expect(resolveManifest(root, adapter, "out.html")).toBeNull();
    });

    test("manifestPath naming a file that doesn't exist -> null", () => {
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: "missing.json", component: "renderer" }) });
      expect(resolveManifest(root, adapter, "out.html")).toBeNull();
    });

    test("manifestPath naming a file with invalid JSON -> null, never a throw", () => {
      writeFileSync(join(root, "bad.json"), "{ not json");
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: "bad.json", component: "renderer" }) });
      expect(resolveManifest(root, adapter, "out.html")).toBeNull();
    });

    test("manifestPath resolves into an EXCLUDED path (.glosa/** is excluded by default) -> null, not the file's contents", () => {
      const manifest = { manifest_version: 1 as const, source_path: "src.md", source_sha256: "abc", chunks: [] };
      mkdirSync(join(root, ".glosa"), { recursive: true });
      writeFileSync(join(root, ".glosa", "manifest.json"), JSON.stringify(manifest));
      const adapter = fakeAdapter({ manifestFor: () => ({ manifestPath: ".glosa/manifest.json", component: "renderer" }) });
      expect(resolveManifest(root, adapter, "out.html")).toBeNull();
    });
  });
});
