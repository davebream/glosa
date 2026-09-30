// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyFile, readOnlyPath, scanReadOnlyFiles } from "../src/read-only-files.ts";
import { ReadOnlyRegistry } from "../src/read-only-registry.ts";
import { FileViews } from "../src/registry/file-views.ts";
import { resolveTrackedFiles } from "../src/matcher.ts";
import { versionedInventory } from "../src/versioned-files.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "glosa-read-only-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function put(path: string, contents: string | Buffer = "source") {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}
const paths = (show = false, limit?: number) => scanReadOnlyFiles(root, show, limit).files.map((file) => file.path);

test("read-only inventory preserves documents/images, shows dotfiles and counts capped regular files exactly", () => {
  for (const path of [
    "a.ts",
    "b.json",
    "c.yaml",
    "notes.md",
    "photo.png",
    ".env",
    ".gitignore",
    "nested/.private/no.ts",
    "node_modules/no.ts",
    ".git/no.ts",
  ])
    put(path, path === ".gitignore" ? "" : "hello");
  symlinkSync(join(root, "a.ts"), join(root, "link.ts"));
  expect(paths()).toEqual([".env", ".gitignore", "a.ts", "b.json", "c.yaml"]);
  const listing = scanReadOnlyFiles(root, false, 2);
  expect(listing.files.map((file) => file.path)).toEqual([".env", ".gitignore"]);
  expect(listing).toMatchObject({ complete: true, omitted_count: 3, warning: null });
  expect(resolveTrackedFiles(root).tracked.map((file) => file.path)).toEqual(["notes.md"]);
  expect(versionedInventory(root).files.map((file) => file.path)).toEqual(["notes.md", "photo.png"]);
});

test("root and nested gitignore rules apply only to read-only files, with parent pruning and negation", () => {
  put(".gitignore", "*.log\ndist/\n*.md\nsub/*.json\n");
  put("sub/.gitignore", "!keep.json\n*.tmp\n");
  for (const path of [
    "log.log",
    "dist/code.js",
    "sub/keep.json",
    "sub/hide.json",
    "sub/a.tmp",
    "sub/code.ts",
    "notes.md",
  ])
    put(path);
  expect(paths()).toEqual([".gitignore", "sub/.gitignore", "sub/code.ts", "sub/keep.json"]);
  expect(paths(true)).toContain("dist/code.js");
  expect(paths(true)).toContain("sub/a.tmp");
  expect(resolveTrackedFiles(root).tracked.map((file) => file.path)).toContain("notes.md");
  expect(() => readOnlyFile(root, "dist/code.js", false)).toThrow();
  expect(readOnlyFile(root, "sub/keep.json", false).kind).toBe("text");
});

test("configured exclusions always win and configured includes retain document membership", () => {
  put(
    ".glosa/config.json",
    JSON.stringify({ artifacts: { include: ["**/*.json"], exclude: ["secret/**", "*.log"], maxFileBytes: 8 } }),
  );
  put("config.json", "{}");
  put("large.md", "0123456789");
  put("secret/file.ts");
  put("file.log");
  put("small.ts", "12345678");
  expect(paths(true)).toEqual(["large.md", "small.ts"]);
  expect(readOnlyFile(root, "large.md", true)).toMatchObject({
    kind: "placeholder",
    reason: "oversize",
    size_bytes: 10,
  });
  expect(readOnlyFile(root, "small.ts", true)).toMatchObject({ kind: "text", text: "12345678" });
  expect(() => readOnlyFile(root, "secret/file.ts", true)).toThrow();
  expect(() => readOnlyFile(root, "config.json", true)).toThrow();
});

test("reads preserve source as data and reject binary encodings and all symlink components", () => {
  put("source.js", "<script>globalThis.bad = true</script>");
  put("invalid.dat", Buffer.from([0xff]));
  put("nul.dat", Buffer.from([65, 0, 66]));
  put("inside/data.ts");
  symlinkSync(join(root, "source.js"), join(root, "alias.js"));
  symlinkSync(join(root, "inside"), join(root, "alias"));
  expect(readOnlyFile(root, "source.js", false)).toMatchObject({
    kind: "text",
    text: "<script>globalThis.bad = true</script>",
  });
  for (const path of ["invalid.dat", "nul.dat"])
    expect(readOnlyFile(root, path, false)).toMatchObject({ kind: "placeholder", reason: "binary" });
  for (const path of [
    "alias.js",
    "alias/data.ts",
    "../outside.ts",
    "/etc/passwd",
    "inside/../source.js",
    "source.js\0",
    ".git/config",
  ])
    expect(() => readOnlyPath(root, path), path).toThrow();
  put("cafe\u0301.ts");
  expect(readOnlyFile(root, "caf\u00e9.ts", false).kind).toBe("text");
  expect(existsSync(join(root, ".glosa"))).toBe(false);
});

test("unsafe or unreadable ignore rules are reported as incomplete instead of silently exposing files", () => {
  put("rules", "secret.ts");
  put("secret.ts");
  symlinkSync(join(root, "rules"), join(root, ".gitignore"));
  expect(scanReadOnlyFiles(root, false)).toMatchObject({ complete: false, files: [] });
  expect(paths(true)).toContain("secret.ts");
});

test("folder views persist privately, notify the right folder, and refuse newer stores", async () => {
  const views = new FileViews(join(root, "home"));
  expect(views.get(root)).toEqual({ mode: "all", show_ignored: false });
  let changes = 0;
  const stop = views.subscribe(root, () => changes++);
  await views.set(root, { mode: "documents", show_ignored: true });
  await views.set(root, { mode: "documents", show_ignored: true });
  expect(changes).toBe(1);
  stop();
  expect(new FileViews(join(root, "home")).get(root)).toEqual({ mode: "documents", show_ignored: true });
  expect(lstatSync(views.path).mode & 0o777).toBe(0o600);
  writeFileSync(views.path, '{"version":999,"folders":{}}');
  const newer = new FileViews(join(root, "home"));
  expect(newer.get(root)).toEqual({ mode: "all", show_ignored: false });
  await expect(newer.set(root, { mode: "all", show_ignored: true })).rejects.toThrow("newer glosa");
  expect(readFileSync(views.path, "utf8")).toBe('{"version":999,"folders":{}}');
});

test("worker listing and shared live invalidation stay independent of the workspace bus", async () => {
  const registry = new ReadOnlyRegistry();
  put("code.ts", "old");
  expect((await registry.list(root, false)).files.map((file) => file.path)).toEqual(["code.ts"]);
  let signal: (() => void) | undefined;
  const stop = registry.subscribe(root, () => signal?.());
  try {
    // Consume the subscribe/resync event before observing an actual filesystem change.
    await new Promise<void>((resolve) => {
      signal = resolve;
    });
    // The resync above is a queued microtask, not a filesystem-watcher readiness signal.
    // Prove a real event first; otherwise the single measured save can race native startup.
    await new Promise<void>((resolve, reject) => {
      let probe = 0;
      const interval = setInterval(() => put("watch-ready.ts", String(++probe)), 50);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Filesystem watcher did not become ready"));
      }, 3000);
      signal = () => {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      };
    });
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No file invalidation")), 3000);
      signal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    put("code.ts", "new");
    await changed;
    expect(readOnlyFile(root, "code.ts", false)).toMatchObject({ text: "new" });
    expect(existsSync(join(root, ".glosa"))).toBe(false);
  } finally {
    stop();
  }
});

// Admission by metadata is never permission to follow a later filesystem replacement.
test("an admitted source replaced by a symlink cannot be read, and the text cap is inclusive", () => {
  put("source.ts", "ok");
  put("target.ts", "private");
  expect(paths()).toContain("source.ts");
  rmSync(join(root, "source.ts"));
  symlinkSync(join(root, "target.ts"), join(root, "source.ts"));
  expect(() => readOnlyFile(root, "source.ts", false)).toThrow();
  put("limit.unknown", "a".repeat(2 * 1024 * 1024));
  expect(readOnlyFile(root, "limit.unknown", false).kind).toBe("text");
  put("limit.unknown", "a".repeat(2 * 1024 * 1024 + 1));
  expect(readOnlyFile(root, "limit.unknown", false)).toMatchObject({ kind: "placeholder", reason: "oversize" });
});

test("a filesystem invalidation during an in-flight scan notifies desks again after completion", async () => {
  put("code.ts");
  const registry = new ReadOnlyRegistry();
  let notifications = 0;
  const stop = registry.subscribe(root, () => notifications++);
  try {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const pending = registry.list(root, false);
    registry.invalidate(root);
    notifications = 0;
    await pending;
    expect(notifications).toBeGreaterThan(0);
  } finally {
    stop();
  }
});
