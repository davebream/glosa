// P1.3 — confinePath unit coverage (A1 §6, A3 §3/§5 #4-5, F24). Hermetic: builds a real tmp
// workspace dir per test (symlink escape needs a real filesystem — no way to fake realpath()).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { confinePath } from "../src/confine-path.ts";

describe("confinePath", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "glosa-confine-ws-"));
    outside = mkdtempSync(join(tmpdir(), "glosa-confine-outside-"));
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "file.md"), "hello");
    writeFileSync(join(outside, "secret.txt"), "nope");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("legit nested existing path → ok", () => {
    const result = confinePath(workspace, "nested/file.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.realPath).toBe(join(workspace, "nested/file.md"));
  });

  test("not-yet-existing file under the root → ok (nearest-ancestor realpath)", () => {
    const result = confinePath(workspace, "nested/does-not-exist-yet.md");
    expect(result.ok).toBe(true);
  });

  test("literal .. segment → reject", () => {
    expect(confinePath(workspace, "../outside.txt").ok).toBe(false);
    expect(confinePath(workspace, "nested/../../escape.txt").ok).toBe(false);
  });

  test("leading / (not workspace-relative) → reject", () => {
    expect(confinePath(workspace, "/etc/passwd").ok).toBe(false);
  });

  test("NUL byte → reject", () => {
    expect(confinePath(workspace, "nested/file\u0000.md").ok).toBe(false);
  });

  test("control char (\\n) in path → reject — A3 §5 attack #5", () => {
    expect(confinePath(workspace, "nested/file\n.md").ok).toBe(false);
  });

  test("empty path → reject", () => {
    expect(confinePath(workspace, "").ok).toBe(false);
  });

  test("symlink escape (existing target) → reject, contents never read — A3 §5 attack #4", () => {
    symlinkSync(outside, join(workspace, "evil"));
    const result = confinePath(workspace, "evil/secret.txt");
    expect(result.ok).toBe(false);
  });

  test("symlink escape (not-yet-existing leaf under the escaped target) → reject", () => {
    symlinkSync(outside, join(workspace, "evil2"));
    const result = confinePath(workspace, "evil2/not-there-yet.txt");
    expect(result.ok).toBe(false);
  });

  test("workspace root itself does not exist → reject rather than throw", () => {
    const result = confinePath(join(workspace, "no-such-root"), "file.md");
    expect(result.ok).toBe(false);
  });

  test("sanity: realPath is always under workspaceRoot + sep when ok", () => {
    const result = confinePath(workspace, "nested/file.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.realPath.startsWith(workspace + sep)).toBe(true);
  });

  // Fix 3 (P6.1 review): an absurdly deep/long relative path has no ".." components (so the
  // cheap traversal pre-check above doesn't catch it) — without a segment/length ceiling this
  // would drive hundreds of thousands of synchronous realpathSync/dirname calls in
  // realpathNearestAncestor, blocking the single-threaded daemon for the request's duration.
  test("pathological deep path (thousands of segments, no ..) → reject fast, never touches the filesystem walk", () => {
    const start = performance.now();
    const result = confinePath(workspace, "a/".repeat(5000) + "leaf.md");
    const elapsedMs = performance.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  test("pathological long single-segment-free path (huge total length) → reject fast", () => {
    const start = performance.now();
    const result = confinePath(workspace, "a".repeat(10_000) + ".md");
    const elapsedMs = performance.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });
});
