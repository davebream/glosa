import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { assignSlug, canonicalize, type ExistingSlugEntry } from "../../src/registry/slug.ts";
import { cleanup, freshWorkspaceDir } from "./helpers.ts";

describe("canonicalize", () => {
  test("resolves a symlink to its real target", () => {
    const real = freshWorkspaceDir();
    const parent = freshWorkspaceDir();
    const link = join(parent, "alias");
    symlinkSync(real, link);

    expect(canonicalize(link)).toBe(canonicalize(real));
    cleanup(real);
    cleanup(parent);
  });

  test("strips a trailing slash and is stable under repeated calls", () => {
    const root = freshWorkspaceDir();
    const withSlash = `${root}/`;
    expect(canonicalize(withSlash)).toBe(canonicalize(root));
    expect(canonicalize(root).endsWith("/")).toBe(false);
    cleanup(root);
  });

  test("NFC-normalizes a decomposed (NFD) path component", () => {
    // "é" as NFD (e + combining acute) vs NFC (single codepoint) — both must canonicalize to the
    // same string once realpath + normalize("NFC") run, regardless of which form the caller passed.
    const root = freshWorkspaceDir();
    const nfd = "café"; // "café" decomposed
    mkdirSync(join(root, nfd));
    const viaNfd = canonicalize(join(root, nfd));
    const viaNfc = canonicalize(join(root, "café"));
    expect(viaNfd).toBe(viaNfc);
    expect(viaNfd.normalize("NFC")).toBe(viaNfd);
    cleanup(root);
  });
});

describe("assignSlug", () => {
  test("first sight of a path gets the natural 6-hex slug", () => {
    const { slug, slugLen } = assignSlug("/Users/alice/glosa", []);
    expect(slugLen).toBe(6);
    expect(slug).toMatch(/^glosa-[0-9a-f]{6}$/);
  });

  test("is idempotent for the same canonical path", () => {
    const first = assignSlug("/Users/alice/glosa", []);
    const existing: ExistingSlugEntry[] = [{ canonicalPath: "/Users/alice/glosa", slug: first.slug, slugLen: first.slugLen }];
    const second = assignSlug("/Users/alice/glosa", existing);
    expect(second).toEqual(first);
  });

  test("deterministic across repeated calls with no existing entries", () => {
    const a = assignSlug("/Users/alice/glosa", []);
    const b = assignSlug("/Users/alice/glosa", []);
    expect(a).toEqual(b);
  });

  test("sanitizes a basename with non-alphanumeric characters and never leaves it empty", () => {
    const { slug } = assignSlug("/Users/alice/My Report (2026)!", []);
    expect(slug).toMatch(/^my-report-2026-[0-9a-f]{6}$/);

    const rootSlug = assignSlug("/", []);
    expect(rootSlug.slug.startsWith("workspace-")).toBe(true);
  });

  test("collision at the natural length: incumbent keeps its slug, newcomer lengthens until unique", () => {
    // Same basename ("glosa") for both, and a forced hash collision at the first 6 hex chars
    // that diverges at 8 — a real sha256 collision would be astronomically unlikely to hunt for,
    // so the hash function is injected to make this deterministic and fast.
    const fakeHash = (path: string): string => {
      if (path === "/Users/alice/glosa") return "aaaaaa00" + "0".repeat(56);
      if (path === "/Users/bob/glosa") return "aaaaaa11" + "0".repeat(56);
      throw new Error(`unexpected path in fakeHash: ${path}`);
    };

    const incumbent = assignSlug("/Users/alice/glosa", [], { hash: fakeHash });
    expect(incumbent).toEqual({ slug: "glosa-aaaaaa", slugLen: 6 });

    const existing: ExistingSlugEntry[] = [{ canonicalPath: "/Users/alice/glosa", slug: incumbent.slug, slugLen: incumbent.slugLen }];
    const newcomer = assignSlug("/Users/bob/glosa", existing, { hash: fakeHash });

    // Incumbent's slug is untouched by the newcomer's assignment.
    expect(incumbent.slug).toBe("glosa-aaaaaa");
    // Newcomer lengthened by exactly one step (2 hex chars) since that's where the fake hashes
    // diverge, and its slug differs from the incumbent's.
    expect(newcomer).toEqual({ slug: "glosa-aaaaaa11", slugLen: 8 });
    expect(newcomer.slug).not.toBe(incumbent.slug);
  });

  test("re-running assignSlug for the newcomer with the same existing set is deterministic", () => {
    const fakeHash = (path: string): string => {
      if (path === "/a/glosa") return "b".repeat(64);
      if (path === "/b/glosa") return "b".repeat(64); // identical at every length — worst case
      throw new Error("unexpected");
    };
    const existing: ExistingSlugEntry[] = [{ canonicalPath: "/a/glosa", slug: "glosa-bbbbbb", slugLen: 6 }];
    const first = assignSlug("/b/glosa", existing, { hash: fakeHash });
    const second = assignSlug("/b/glosa", existing, { hash: fakeHash });
    expect(first).toEqual(second);
  });

  test("terminates at the 64-hex cap even under a total hash collision at every length", () => {
    const fakeHash = (): string => "c".repeat(64);
    // A candidate at length L is always `glosa-` + "c" x L (the fake hash is constant). To force
    // the loop to advance all the way to the cap, an existing different-path entry must already
    // occupy that exact string at EVERY length the loop will try (6, 8, ..., 62) — one real prior
    // collision alone (as in the test above) only proves a single lengthening step, not that the
    // loop is bounded when it keeps losing.
    const existing: ExistingSlugEntry[] = [];
    for (let len = 6; len <= 62; len += 2) {
      existing.push({ canonicalPath: `/other-${len}/glosa`, slug: `glosa-${"c".repeat(len)}`, slugLen: len });
    }
    existing.push({ canonicalPath: "/a/glosa", slug: `glosa-${"c".repeat(64)}`, slugLen: 64 });

    const result = assignSlug("/b/glosa", existing, { hash: fakeHash });
    // Can't escape the collision at any length (every prefix is already taken) — the loop still
    // terminates at the cap rather than looping forever, which is the property under test.
    expect(result.slugLen).toBe(64);
  });

  test("a collision against a slug belonging to the SAME path never triggers lengthening (idempotent, not a false collision)", () => {
    const first = assignSlug("/Users/alice/glosa", []);
    const existing: ExistingSlugEntry[] = [{ canonicalPath: "/Users/alice/glosa", slug: first.slug, slugLen: first.slugLen }];
    // Same path again -> the "already assigned" branch, not the collision-lengthening branch.
    const again = assignSlug("/Users/alice/glosa", existing);
    expect(again.slugLen).toBe(6);
    expect(again.slug).toBe(first.slug);
  });
});
