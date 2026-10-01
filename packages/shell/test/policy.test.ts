// SPDX-License-Identifier: Apache-2.0
// The shell's pure rules. Each test names the contract clause it pins; deleting the rule in
// policy.ts must turn the matching test red (AGENTS.md "ablate it").
import { describe, expect, test } from "bun:test";
import { buildAppUrl } from "../../cli/src/open-presentation.ts";
import {
  appearanceDecision,
  BROWSER_PARTITION,
  BROWSER_READ_MAX,
  BROWSER_READ_SCRIPT,
  browserContextMenu,
  browserKeyAction,
  browserReadResult,
  browserNavigationDecision,
  browserRequestDecision,
  browserUserAgent,
  cliCandidates,
  cliChoice,
  compareVersions,
  compatibility,
  contrastPush,
  contrastPushReaches,
  contrastReply,
  devProfilePath,
  downloadName,
  dictationPermissionAllowed,
  dictationEgressAllowed,
  egressDecision,
  externalLinkDecision,
  firstFrameColor,
  hiddenMode,
  linkFromArgv,
  lockGuestPreferences,
  loopbackApiOrigin,
  MAX_RESPONSE_BYTES,
  MAX_TAG_LENGTH,
  navigationDecision,
  needsConfirmation,
  newestRelease,
  notifyDecision,
  openArgsFor,
  PAPER,
  parseGlosaUrl,
  parseOpenEnvelope,
  parsePackageType,
  parseVersion,
  permissionNotice,
  plainPath,
  preloadShouldExpose,
  quitDecision,
  RELEASES_API,
  RecentIds,
  type RoutedWindow,
  readUpdateResponse,
  reconnectOutcome,
  releaseAssetNames,
  requestReleases,
  representedFile,
  revealTarget,
  scrubChildEnv,
  splitPresentationToken,
  surfaceKind,
  targetFromArg,
  UPDATE_HEADERS,
  UPDATE_USER_AGENT,
  type UpdateOutcome,
  updateChannelFor,
  webviewAttachDecision,
  updateDialog,
  updateOutcome,
  windowFor,
  withRoute,
} from "../src/policy.ts";

const SPA = "http://glosa.localhost:4646";

describe("egress gate (readiness note §3: a browser-process gate, not a CSP)", () => {
  test("loopback http is the only network the renderer may reach", () => {
    expect(egressDecision("http://127.0.0.1:4646/api/handshake")).toBe("allow");
    expect(egressDecision("http://glosa.localhost:4646/")).toBe("allow");
    expect(egressDecision("http://127.0.0.1:4647/doc/abc/x.html")).toBe("allow");
    expect(egressDecision("https://example.com/")).toBe("cancel");
    expect(egressDecision("http://example.com/")).toBe("cancel");
    expect(egressDecision("http://evil.localhost.example.com/")).toBe("cancel");
  });
  test("https to loopback is still cancelled: the daemon speaks plain http and nothing else should", () => {
    expect(egressDecision("https://127.0.0.1:4646/")).toBe("cancel");
  });
  test("data:, blob: and devtools: never leave the process; file: and unparsable are cancelled", () => {
    expect(egressDecision("data:text/html,hi")).toBe("allow");
    expect(egressDecision("blob:http://glosa.localhost:4646/uuid")).toBe("allow");
    expect(egressDecision("devtools://devtools/bundled/x.html")).toBe("allow");
    expect(egressDecision("file:///etc/passwd")).toBe("cancel");
    expect(egressDecision("not a url")).toBe("cancel");
  });
});

describe("hidden windows, test-only (#447)", () => {
  test("only an unpackaged app honors GLOSA_SHELL_HIDDEN=yes", () => {
    expect(hiddenMode({ packaged: false, value: "yes" })).toBe(true);
    expect(hiddenMode({ packaged: true, value: "yes" })).toBe(false);
    expect(hiddenMode({ packaged: false, value: undefined })).toBe(false);
    expect(hiddenMode({ packaged: false, value: "no" })).toBe(false);
    expect(hiddenMode({ packaged: false, value: "Yes" })).toBe(false);
  });
});

describe("top-frame navigation (readiness note §1b: class-F is never top level)", () => {
  test("only the SPA origin itself", () => {
    expect(navigationDecision(`${SPA}/#w=x`, SPA)).toBe("allow");
    expect(navigationDecision("http://127.0.0.1:4647/doc/cap/probe.html", SPA)).toBe("deny");
    expect(navigationDecision("https://example.com/", SPA)).toBe("deny");
  });
  test("origins compare as origins, not prefixes", () => {
    expect(navigationDecision("http://glosa.localhost:46460/", SPA)).toBe("deny");
    expect(navigationDecision("http://glosa.localhost:4646.example.com/", SPA)).toBe("deny");
    expect(navigationDecision("garbage", SPA)).toBe("deny");
  });
});

describe("preload scope (R-P3)", () => {
  test("exact origin equality only", () => {
    expect(preloadShouldExpose(SPA, SPA)).toBe(true);
    expect(preloadShouldExpose("http://127.0.0.1:4647", SPA)).toBe(false);
    expect(preloadShouldExpose("null", SPA)).toBe(false);
  });
});

describe("token handover (R-P1)", () => {
  test("splits p= out of the fragment and keeps the rest of the route", () => {
    const { tokenlessUrl, token } = splitPresentationToken(
      `${SPA}/#p=SECRET&w=slug&a=a.md&surface=document&mode=review`,
    );
    expect(token).toBe("SECRET");
    expect(tokenlessUrl).toBe(`${SPA}/#w=slug&a=a.md&surface=document&mode=review`);
    expect(tokenlessUrl).not.toContain("SECRET");
  });
  test("a URL without p= is returned untouched with no token", () => {
    const url = `${SPA}/#w=slug`;
    expect(splitPresentationToken(url)).toEqual({ tokenlessUrl: url, token: null });
  });
});

describe("glosa open envelope (A6)", () => {
  test("accepts the ok envelope and returns its url, slug and folder", () => {
    const text = JSON.stringify({
      glosa_json: 1,
      ok: true,
      command: "open",
      data: { url: `${SPA}/#p=x&w=s`, slug: "s", path: "/Users/x/proj", kind: "directory" },
    });
    expect(parseOpenEnvelope(text)).toEqual({ url: `${SPA}/#p=x&w=s`, slug: "s", path: "/Users/x/proj" });
  });
  test("the folder is the daemon's absolute path; an envelope without one is refused (#160)", () => {
    const envelope = (path: unknown) =>
      JSON.stringify({ glosa_json: 1, ok: true, data: { url: `${SPA}/#w=s`, slug: "s", path } });
    expect(() => parseOpenEnvelope(envelope(undefined))).toThrow(/absolute path/);
    expect(() => parseOpenEnvelope(envelope("proj"))).toThrow(/absolute path/);
  });
  test("a refusal surfaces the CLI's own error code, never a guessed url", () => {
    const text = JSON.stringify({
      glosa_json: 1,
      ok: false,
      error: { code: "workspace-forgetting", message: "mid-deletion" },
    });
    expect(() => parseOpenEnvelope(text)).toThrow(/workspace-forgetting/);
  });
  test("non-envelope output is refused", () => {
    expect(() => parseOpenEnvelope("http://glosa.localhost:4646/#p=x")).toThrow(/JSON envelope/);
    expect(() => parseOpenEnvelope(JSON.stringify({ ok: true, data: { url: "x" } }))).toThrow(/A6 envelope/);
  });
});

describe("compatibility is checked, not repaired (R-O5)", () => {
  test("version ordering handles prereleases", () => {
    expect(compareVersions("0.1.0-alpha.31", "0.1.0-alpha.30")).toBe(1);
    expect(compareVersions("0.1.0-alpha.31", "0.1.0-alpha.31")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.0-alpha.99")).toBe(1);
    expect(compareVersions("0.2.0-alpha.1", "0.1.0")).toBe(1);
  });
  test("no daemon → down with the command that starts one", () => {
    expect(compatibility(null, "0.1.0-alpha.31")).toEqual({ state: "down", command: "glosa open <folder>" });
  });
  test("contract major mismatch → incompatible, too-old daemon → too-old, both name glosa update", () => {
    expect(compatibility({ contract_version: "2.0", daemon_version: "9.9.9" }, "0.1.0")).toEqual({
      state: "incompatible",
      command: "glosa update",
    });
    expect(compatibility({ contract_version: "1.18", daemon_version: "0.1.0-alpha.30" }, "0.1.0-alpha.31")).toEqual({
      state: "too-old",
      command: "glosa update",
    });
    expect(compatibility({ contract_version: "1.18", daemon_version: "0.1.0-alpha.31" }, "0.1.0-alpha.31")).toEqual({
      state: "ok",
    });
  });
  test("a missing or malformed daemon version still reads as too old", () => {
    for (const daemon_version of [undefined, 42, "", "garbage", "v0.1.0-alpha.40", "0.1", "01.2.3"]) {
      expect(
        compatibility({ contract_version: "1.21", daemon_version }, "0.1.0-alpha.36"),
        String(daemon_version),
      ).toEqual({ state: "too-old", command: "glosa update" });
    }
  });
});

describe("SemVer 2.0 §11 precedence: one comparator for the daemon check and for updates (#424)", () => {
  // The spec's own chain, glosa's real tags, the next stages glosa will reach, and every §11 rule:
  // numeric identifiers numerically, alphanumeric in ASCII order, numeric below alphanumeric, a
  // longer list above a prefix of it, a release above its prereleases, build metadata ignored.
  const CORPUS = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "0.1.0-alpha.2",
    "0.1.0-alpha.32",
    "0.1.0-alpha.36",
    "0.1.0-alpha.40",
    "0.1.0-beta.1",
    "0.1.0-rc.1",
    "0.1.0",
    "0.0.0",
    "1.0.0-0",
    "1.0.0-1",
    "1.0.0-9",
    "1.0.0-10",
    "1.0.0-0a",
    "1.0.0-A",
    "1.0.0-Z",
    "1.0.0-a",
    "1.0.0--",
    "1.0.0-a-b",
    "1.0.0-alpha-1",
    "1.0.0-alpha.0a",
    "1.0.0-alpha.a0",
    "1.0.0-alpha.1.1",
    "1.0.0-x.7.z.92",
    "1.0.0+build.1",
    "1.0.0+zzz",
    "1.0.0-alpha+exp.sha",
    "1.2.0",
    "1.2.9",
    "1.2.10",
    "1.10.0",
    "2.0.0",
    "10.0.0",
    // SemVer sets no length limit: valid versions past 256 characters are ordered, not malformed.
    `1.0.0-${"a".repeat(300)}`,
    `1.0.0-${"a".repeat(299)}b`,
    `1.0.0-alpha.${"z".repeat(280)}`,
    `1.0.0-${Array.from({ length: 150 }, () => "x").join(".")}`,
    `0.0.1+${"b".repeat(300)}`,
  ];

  test("agrees with Bun.semver.order on every ordered pair of the corpus", () => {
    const disagreements: string[] = [];
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        const expected = Bun.semver.order(a, b);
        if (compareVersions(a, b) !== expected) disagreements.push(`${a} vs ${b}: expected ${expected}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("a later prerelease stage outranks a higher number in an earlier one", () => {
    expect(compareVersions("0.1.0-beta.1", "0.1.0-alpha.40")).toBe(1);
    expect(compareVersions("0.1.0-rc.1", "0.1.0-alpha.2")).toBe(1);
    expect(compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(1);
  });

  test("parses only SemVer: no v prefix, no short or zero-padded forms, no empty identifiers", () => {
    expect(parseVersion("0.1.0-alpha.36")).toEqual({ core: ["0", "1", "0"], pre: ["alpha", "36"] });
    expect(parseVersion("1.2.3+build.5")).toEqual({ core: ["1", "2", "3"], pre: [] });
    expect(parseVersion(`1.0.0-${"a".repeat(300)}`)?.pre).toEqual(["a".repeat(300)]);
    for (const bad of [
      "v1.0.0",
      "1.0",
      "1",
      "01.0.0",
      "1.0.0-01",
      "1.0.0-",
      "1.0.0-alpha..1",
      "1.0.0+",
      "latest",
      "",
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });
});

describe("the daemon outlives the shell (R-O4)", () => {
  test("never stop a daemon the shell did not spawn, nor one with a session or a claim", () => {
    expect(quitDecision({ spawnedByShell: false, boundSessions: 0, heldClaims: 0 })).toBe("leave");
    expect(quitDecision({ spawnedByShell: true, boundSessions: 1, heldClaims: 0 })).toBe("leave");
    expect(quitDecision({ spawnedByShell: true, boundSessions: 0, heldClaims: 1 })).toBe("leave");
    expect(quitDecision({ spawnedByShell: true, boundSessions: 0, heldClaims: 0 })).toBe("stop");
  });
});

describe("invariant 5: no API key reaches a child", () => {
  test("ANTHROPIC_API_KEY is dropped, everything else kept", () => {
    expect(scrubChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", HOME: "/h", NOPE: undefined })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    });
  });
});

describe("main-process requests use the loopback IP (A3 §4b)", () => {
  test("the SPA origin's port on 127.0.0.1, never the glosa.localhost name", () => {
    expect(loopbackApiOrigin("http://glosa.localhost:4646")).toBe("http://127.0.0.1:4646");
    expect(loopbackApiOrigin("http://127.0.0.1:20000")).toBe("http://127.0.0.1:20000");
  });
});

describe("the represented file (an editor's proxy icon)", () => {
  test("the route's document under the opened folder; the folder itself with no document", () => {
    expect(representedFile(`${SPA}/#w=s&a=docs%2Fplan.md&surface=document`, "/Users/x/proj")).toBe(
      "/Users/x/proj/docs/plan.md",
    );
    expect(representedFile(`${SPA}/#w=s&surface=workspace`, "/Users/x/proj/")).toBe("/Users/x/proj/");
  });
  test("a route that escapes the folder represents nothing", () => {
    expect(representedFile(`${SPA}/#a=..%2Fsecret`, "/Users/x/proj")).toBeNull();
    expect(representedFile(`${SPA}/#a=%2Fetc%2Fpasswd`, "/Users/x/proj")).toBeNull();
    expect(representedFile("garbage", "/Users/x/proj")).toBeNull();
  });
  test("only plain relative paths: no `.` or empty segments, no backslashes", () => {
    for (const a of ["docs%2F.%2Fplan.md", ".%2Fplan.md", "docs%2F%2Fplan.md", "docs%5C..%5Csecret", "docs%2F"]) {
      expect(representedFile(`${SPA}/#w=s&a=${a}`, "/Users/x/proj", "s")).toBeNull();
    }
  });
  test("a route on another workspace than the window opened represents nothing (#160)", () => {
    // The SPA can switch workspace inside a window; the folder then no longer matches the route.
    const other = `${SPA}/#w=other&a=docs%2Fplan.md`;
    expect(representedFile(other, "/Users/x/proj", "s")).toBeNull();
    expect(representedFile(`${SPA}/#w=other`, "/Users/x/proj", "s")).toBeNull();
    expect(representedFile(`${SPA}/#w=s&a=docs%2Fplan.md`, "/Users/x/proj", "s")).toBe("/Users/x/proj/docs/plan.md");
  });
});

describe("the surface kind a link opens", () => {
  test("desk only when the fragment says so; a link without it is a companion, as in the SPA", () => {
    expect(surfaceKind(`${SPA}/#w=s&kind=desk`)).toBe("desk");
    expect(surfaceKind(`${SPA}/#w=s&kind=companion`)).toBe("companion");
    expect(surfaceKind(`${SPA}/#w=s`)).toBe("companion");
    expect(surfaceKind("garbage")).toBe("companion");
  });
});

describe("Reveal in Finder (#160): the path comes from the window, never the page", () => {
  const WINDOW = { folder: "/Users/x/proj", slug: "s" };
  /** A filesystem where `links` maps a path to what it resolves to, and `present` lists what exists. */
  const fs = (present: string[], links: Record<string, string> = {}) => ({
    realpath: (path: string) => links[path] ?? (present.includes(path) ? path : null),
    exists: (path: string) => present.includes(path),
  });
  test("reveals the route's document when it exists inside the folder", () => {
    const io = fs(["/Users/x/proj", "/Users/x/proj/docs/plan.md"]);
    expect(revealTarget(`${SPA}/#w=s&a=docs%2Fplan.md`, WINDOW, io)).toBe("/Users/x/proj/docs/plan.md");
  });
  test("reveals the folder when the route names no document", () => {
    expect(revealTarget(`${SPA}/#w=s`, WINDOW, fs(["/Users/x/proj"]))).toBe("/Users/x/proj");
  });
  test("falls back to the folder when the document is gone", () => {
    expect(revealTarget(`${SPA}/#w=s&a=gone.md`, WINDOW, fs(["/Users/x/proj"]))).toBe("/Users/x/proj");
  });
  test("a symlink inside the folder that resolves outside it reveals nothing", () => {
    const io = fs(["/Users/x/proj", "/Users/x/proj/notes.md"], { "/Users/x/proj/notes.md": "/Users/x/secret.md" });
    expect(revealTarget(`${SPA}/#w=s&a=notes.md`, WINDOW, io)).toBeNull();
  });
  test("a sibling folder sharing the prefix is not inside it", () => {
    const io = fs(["/Users/x/proj", "/Users/x/proj/a.md"], { "/Users/x/proj/a.md": "/Users/x/proj-old/a.md" });
    expect(revealTarget(`${SPA}/#w=s&a=a.md`, WINDOW, io)).toBeNull();
  });
  test("a folder that resolves through a symlink still contains its own documents", () => {
    const io = fs(["/Users/x/proj", "/Users/x/proj/a.md"], {
      "/Users/x/proj": "/Volumes/data/proj",
      "/Users/x/proj/a.md": "/Volumes/data/proj/a.md",
    });
    expect(revealTarget(`${SPA}/#w=s&a=a.md`, WINDOW, io)).toBe("/Volumes/data/proj/a.md");
  });
  test("another workspace's route and an escaping path reveal nothing", () => {
    const io = fs(["/Users/x/proj", "/Users/x/proj/a.md"]);
    expect(revealTarget(`${SPA}/#w=other&a=a.md`, WINDOW, io)).toBeNull();
    expect(revealTarget(`${SPA}/#w=s&a=..%2Fsecret`, WINDOW, io)).toBeNull();
  });
});

describe("CLI lookup (R-O1, #371: the recorded executable first, the app's own CLI second)", () => {
  const HOME = "/Users/u";
  const RESOURCES = "/Applications/glosa.app/Contents/Resources";
  const WELL_KNOWN = ["/Users/u/.bun/bin/glosa", "/opt/homebrew/bin/glosa", "/usr/local/bin/glosa", "glosa"];

  test("GLOSA_SHELL_CLI is the only candidate when set", () => {
    expect(cliCandidates({ override: "/t/cli", homeDir: HOME, resourcesPath: RESOURCES })).toEqual(["/t/cli"]);
  });
  test("an unpackaged shell uses only its checkout CLI, even when another install is recorded", () => {
    const lookup = {
      glosaHome: "/tmp/h",
      homeDir: HOME,
      resourcesPath: null,
      checkoutCli: "/checkout/packages/cli/src/main.ts",
    };
    expect(cliCandidates(lookup)).toEqual([lookup.checkoutCli]);
    expect(cliCandidates({ ...lookup, override: "/t/cli" })).toEqual(["/t/cli"]);
    expect(cliCandidates({ homeDir: HOME, resourcesPath: null })).toEqual([]);
  });
  test("a packaged app's own CLI is second, before every well-known bin", () => {
    expect(cliCandidates({ homeDir: HOME, resourcesPath: RESOURCES })).toEqual([
      "/Users/u/.glosa/bin/glosa",
      "/Applications/glosa.app/Contents/Resources/bin/glosa",
      ...WELL_KNOWN,
    ]);
  });
  test("different checkouts use separate Electron profiles", () => {
    const one = devProfilePath("/Users/u/Library/Application Support", "/checkout/one");
    expect(one).toBe(devProfilePath("/Users/u/Library/Application Support", "/checkout/one"));
    expect(one).not.toBe(devProfilePath("/Users/u/Library/Application Support", "/checkout/two"));
    expect(one).toContain("/glosa-dev/");
  });
  test("on Linux the package's own CLI is second, and the well-known bins name /usr/bin, never Homebrew (#432)", () => {
    const candidates = cliCandidates({ homeDir: "/home/u", resourcesPath: "/opt/glosa/resources", platform: "linux" });
    expect(candidates).toEqual([
      "/home/u/.glosa/bin/glosa",
      "/opt/glosa/resources/bin/glosa",
      "/home/u/.bun/bin/glosa",
      "/usr/local/bin/glosa",
      "/usr/bin/glosa",
      "glosa",
    ]);
    expect(candidates.some((c) => c.includes("homebrew"))).toBe(false);
  });
  test("an explicit darwin platform keeps today's macOS list", () => {
    expect(
      cliCandidates({ homeDir: HOME, resourcesPath: null, platform: "darwin", checkoutCli: "/checkout/cli" }),
    ).toEqual(["/checkout/cli"]);
  });
  test("no candidate is a hard-coded /Applications path: the bundle is wherever it was launched from", () => {
    const moved = "/Users/u/Downloads/glosa.app/Contents/Resources";
    const candidates = cliCandidates({ homeDir: HOME, resourcesPath: moved });
    expect(candidates[1]).toBe(`${moved}/bin/glosa`);
    expect(candidates.some((c) => c.startsWith("/Applications/"))).toBe(false);
  });
});

describe("glosa:// links (#392)", () => {
  const link = (query: string) => parseGlosaUrl(`glosa://open?${query}`);
  const DIR = "/Users/u/writing";

  test("a well-formed link parses, with companion as the default kind", () => {
    expect(link(`path=${encodeURIComponent(DIR)}`)).toEqual({
      path: DIR,
      focus: null,
      kind: "companion",
      surface: null,
      mode: null,
      readLock: false,
    });
    expect(
      link(`path=${encodeURIComponent(DIR)}&focus=notes%2Fplan.md&kind=desk&surface=document&mode=edit&lock=read`),
    ).toEqual({ path: DIR, focus: "notes/plan.md", kind: "desk", surface: "document", mode: "edit", readLock: true });
  });

  test("a path must be absolute and plain; a focus relative and plain", () => {
    for (const bad of ["relative/dir", "/Users/u/../etc", "/Users/./u", "/Users//u", "/", "C:\\x", "/a/\0b"]) {
      expect(link(`path=${encodeURIComponent(bad)}`), bad).toBeNull();
    }
    for (const bad of ["/abs.md", "../up.md", "a/../b.md", "./a.md", "a//b.md", "a\\b.md"]) {
      expect(link(`path=${encodeURIComponent(DIR)}&focus=${encodeURIComponent(bad)}`), bad).toBeNull();
    }
    expect(plainPath("a/b.md", false)).toBe(true);
    expect(plainPath("/a/b", true)).toBe(true);
  });

  test("anything but glosa://open, a known value, or a single known parameter is refused", () => {
    expect(parseGlosaUrl(`https://open?path=${encodeURIComponent(DIR)}`)).toBeNull();
    expect(parseGlosaUrl(`glosa://present?path=${encodeURIComponent(DIR)}`)).toBeNull();
    expect(parseGlosaUrl(`glosa://open/extra?path=${encodeURIComponent(DIR)}`)).toBeNull();
    expect(parseGlosaUrl(`glosa://open?path=${encodeURIComponent(DIR)}#p=abc`)).toBeNull();
    expect(link("kind=desk")).toBeNull();
    expect(link(`path=${encodeURIComponent(DIR)}&kind=admin`)).toBeNull();
    expect(link(`path=${encodeURIComponent(DIR)}&mode=write`)).toBeNull();
    expect(link(`path=${encodeURIComponent(DIR)}&lock=edit`)).toBeNull();
    expect(link(`path=${encodeURIComponent(DIR)}&path=%2Fetc`)).toBeNull();
    // A link never carries a pairing token: an extra parameter is refused rather than ignored.
    expect(link(`path=${encodeURIComponent(DIR)}&p=abcd`)).toBeNull();
    expect(link(`path=${encodeURIComponent(DIR)}&t=abcd`)).toBeNull();
    expect(parseGlosaUrl("not a url")).toBeNull();
  });

  test("the CLI's app_url round-trips through the shell's parser", () => {
    const url = buildAppUrl({
      path: DIR,
      focus: "drafts/chapter one.md",
      kind: "companion",
      surface: "document",
      mode: "review",
      readLock: false,
    });
    expect(parseGlosaUrl(url)).toEqual({
      path: DIR,
      focus: "drafts/chapter one.md",
      kind: "companion",
      surface: "document",
      mode: "review",
      readLock: false,
    });
    const locked = buildAppUrl({ path: DIR, kind: "desk", surface: "workspace", mode: "read", readLock: true });
    expect(parseGlosaUrl(locked)).toMatchObject({ kind: "desk", surface: "workspace", mode: "read", readLock: true });
  });

  test("a link maps to the glosa open arguments that reproduce it", () => {
    const base = { path: DIR, focus: null, kind: "companion" as const, surface: null, mode: null, readLock: false };
    expect(openArgsFor(base)).toEqual([DIR]);
    expect(openArgsFor({ ...base, focus: "a.md" })).toEqual([DIR, "a.md"]);
    expect(openArgsFor({ ...base, focus: "a.md", surface: "workspace", readLock: true })).toEqual([
      DIR,
      "a.md",
      "--workspace",
      "--read",
    ]);
    // The CLI refuses --document beside a second positional, so a document link opens the file.
    expect(openArgsFor({ ...base, focus: "notes/a.md", surface: "document" })).toEqual([
      `${DIR}/notes/a.md`,
      "--document",
    ]);
    expect(openArgsFor({ ...base, surface: "document" })).toEqual([DIR, "--document"]);
  });

  test("kind and mode are set on the answered URL, every other entry kept", () => {
    const answered = `${SPA}/#p=tok&w=ws&a=a.md&surface=workspace&mode=review&kind=desk`;
    const routed = new URL(withRoute(answered, { kind: "companion", mode: "edit" }));
    const params = new URLSearchParams(routed.hash.slice(1));
    expect(params.get("kind")).toBe("companion");
    expect(params.get("mode")).toBe("edit");
    expect(params.get("p")).toBe("tok");
    expect(params.get("a")).toBe("a.md");
    expect(new URLSearchParams(new URL(withRoute(answered, { kind: "desk" })).hash.slice(1)).get("mode")).toBe(
      "review",
    );
    expect(surfaceKind(withRoute(answered, { kind: "companion" }))).toBe("companion");
  });

  const windows: RoutedWindow[] = [
    { id: 1, origin: SPA, folder: DIR, kind: "desk" },
    { id: 2, origin: SPA, folder: "/Users/u/other", kind: "companion" },
  ];

  test("a link reuses a window only when origin, folder and kind all match (decision 5)", () => {
    // A companion link beside a desk window on the same folder gets its own window.
    expect(windowFor({ origin: SPA, folder: DIR, kind: "companion" }, windows)).toBeNull();
    expect(windowFor({ origin: SPA, folder: DIR, kind: "desk" }, windows)).toBe(1);
    expect(windowFor({ origin: SPA, folder: "/Users/u/other", kind: "companion" }, windows)).toBe(2);
    expect(windowFor({ origin: "http://127.0.0.1:4646", folder: DIR, kind: "desk" }, windows)).toBeNull();
  });

  test("a link asks first unless a window already shows its folder", () => {
    expect(needsConfirmation(DIR, windows)).toBe(false);
    expect(needsConfirmation(`${DIR}/notes/a.md`, windows)).toBe(false);
    expect(needsConfirmation(`${DIR}-archive`, windows)).toBe(true);
    expect(needsConfirmation("/Users/u/elsewhere", windows)).toBe(true);
    expect(needsConfirmation(DIR, [{ id: 3, origin: SPA, folder: null, kind: null }])).toBe(true);
  });

  test("a link arrives on the command line as any argument starting glosa://", () => {
    expect(linkFromArgv(["/Applications/glosa.app/Contents/MacOS/glosa", "glosa://open?path=%2Fx"])).toBe(
      "glosa://open?path=%2Fx",
    );
    expect(linkFromArgv(["/tmp/folder"])).toBeNull();
  });
});

describe("notify: the Dock badge and notifications from the SPA (#391)", () => {
  test("a badge is a whole number from zero up; anything else is ignored", () => {
    const seen = new RecentIds();
    expect(notifyDecision({ badge: 3 }, seen)).toEqual({ badge: 3 });
    expect(notifyDecision({ badge: 0 }, seen)).toEqual({ badge: 0 });
    for (const badge of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", null])
      expect(notifyDecision({ badge }, seen)).toEqual({});
  });

  test("a badge alone shows nothing", () => {
    expect(notifyDecision({ badge: 2 }, new RecentIds()).show).toBeUndefined();
  });

  test("the same id is shown once, however many windows report it", () => {
    const seen = new RecentIds();
    const message = { id: "attention:b:q1", title: "beta", body: "Should the second section go?" };
    expect(notifyDecision(message, seen).show).toEqual({ title: "beta", body: "Should the second section go?" });
    expect(notifyDecision(message, seen).show).toBeUndefined();
    expect(notifyDecision({ ...message, id: "attention:b:q2" }, seen).show).toBeDefined();
  });

  test("title and body are clamped as before, and a missing title reads glosa", () => {
    const shown = notifyDecision({ id: "x", title: "t".repeat(200), body: "b".repeat(600) }, new RecentIds()).show;
    expect(shown?.title.length).toBe(120);
    expect(shown?.body.length).toBe(400);
    expect(notifyDecision({ body: "only a body" }, new RecentIds()).show).toEqual({
      title: "glosa",
      body: "only a body",
    });
  });

  test("nothing to show without a title or a body; junk payloads are ignored", () => {
    const seen = new RecentIds();
    expect(notifyDecision({ id: "x" }, seen)).toEqual({});
    expect(notifyDecision(null, seen)).toEqual({});
    expect(notifyDecision("text", seen)).toEqual({});
  });

  test("the remembered ids are bounded: the oldest is forgotten past the limit", () => {
    const seen = new RecentIds(2);
    expect(seen.add("1")).toBe(true);
    expect(seen.add("2")).toBe(true);
    expect(seen.add("3")).toBe(true);
    expect(seen.add("1")).toBe(true);
    expect(seen.add("3")).toBe(false);
  });
});

describe("appearance: the window follows what the page resolved (#405, A3 §4b)", () => {
  test("the three enumerated sources and a #rrggbb paper are accepted, and set themeSource", () => {
    expect(appearanceDecision({ source: "dark", scheme: "dark", background: "#1a1614" })).toEqual({
      themeSource: "dark",
      scheme: "dark",
      background: "#1a1614",
    });
    expect(appearanceDecision({ source: "light", scheme: "light", background: "#FEFBF7" })).toEqual({
      themeSource: "light",
      scheme: "light",
      background: "#fefbf7",
    });
    expect(appearanceDecision({ source: "system", scheme: "dark", background: "#1a1614" })?.themeSource).toBe("system");
  });

  test("an unknown scheme or source is refused, as is a fixed source that disagrees with its scheme", () => {
    for (const scheme of ["sepia", "Dark", "", null, 1, undefined])
      expect(appearanceDecision({ source: "system", scheme, background: "#1a1614" })).toBeNull();
    for (const source of ["os", "catppuccin-mocha", "", null, true])
      expect(appearanceDecision({ source, scheme: "dark", background: "#1a1614" })).toBeNull();
    expect(appearanceDecision({ source: "light", scheme: "dark", background: "#1a1614" })).toBeNull();
  });

  test("a path is refused wherever it rides: as an extra key or in place of a value", () => {
    const valid = { source: "dark", scheme: "dark", background: "#1a1614" };
    expect(appearanceDecision({ ...valid, path: "/Users/someone/secret.md" })).toBeNull();
    expect(appearanceDecision({ ...valid, url: "file:///etc/passwd" })).toBeNull();
    expect(appearanceDecision({ ...valid, background: "/Users/someone/secret.md" })).toBeNull();
    expect(appearanceDecision({ ...valid, source: "/Users/someone" })).toBeNull();
    expect(appearanceDecision({ source: "dark", scheme: "dark" })).toBeNull();
  });

  test("a malformed colour is refused: only six hex digits after #", () => {
    for (const background of [
      "#1a161",
      "#1a16140",
      "#1a1614ff",
      "1a1614",
      "#1g1614",
      "rgb(26, 22, 20)",
      "oklch(0.205 0.008 60)",
      "#1a1614;",
      " #1a1614",
      "",
      null,
      0x1a1614,
    ])
      expect(appearanceDecision({ source: "dark", scheme: "dark", background })).toBeNull();
  });

  test("junk payloads are refused", () => {
    for (const payload of [null, undefined, "dark", 3, [], ["dark", "dark", "#1a1614"]])
      expect(appearanceDecision(payload)).toBeNull();
  });

  test("a new window's first frame is the last reported paper, else the paper of the OS scheme", () => {
    expect(firstFrameColor(null, false)).toBe(PAPER.light);
    expect(firstFrameColor(null, true)).toBe(PAPER.dark);
    expect(firstFrameColor("#2b2a33", false)).toBe("#2b2a33");
    expect(firstFrameColor("#fefbf7", true)).toBe("#fefbf7");
  });
});

describe("Check for Updates…: which release, and what the dialog offers (#424)", () => {
  const RUNNING = { current: "0.1.0-alpha.36", arch: "arm64" };
  const RELEASES_PAGE = "https://github.com/davebream/glosa/releases";
  /** A release as GitHub's API lists glosa's: a prerelease with the app for both architectures. */
  const release = (
    version: string,
    options: { tag?: string; draft?: boolean; arches?: string[]; state?: string; html_url?: string } = {},
  ) => {
    const tag = options.tag ?? `v${version}`;
    const arches = options.arches ?? ["arm64", "x64"];
    return {
      tag_name: tag,
      name: tag,
      draft: options.draft ?? false,
      prerelease: true,
      html_url: options.html_url ?? `${RELEASES_PAGE}/tag/${tag}`,
      assets: [
        ...arches.flatMap((arch) =>
          ["dmg", "zip"].map((ext) => ({
            name: `glosa-${version}-${arch}.${ext}`,
            state: options.state ?? "uploaded",
          })),
        ),
        { name: "SHA256SUMS", state: "uploaded" },
      ],
    };
  };
  /** v0.1.0-alpha.32 and 33 are published with no assets at all. */
  const bare = (version: string) => ({ ...release(version), assets: [] });

  test("a prerelease-only list: the newest release above the running one", () => {
    const list = ["38", "37", "36", "35", "33", "32", "31"].map((n) => release(`0.1.0-alpha.${n}`));
    expect(newestRelease(list, RUNNING)).toEqual({ version: "0.1.0-alpha.38", tag: "v0.1.0-alpha.38" });
  });

  test("takes the maximum by version, not the first entry the API lists", () => {
    const list = [release("0.1.0-alpha.37"), release("0.1.0-alpha.39"), release("0.1.0-alpha.38")];
    expect(newestRelease(list, RUNNING)?.version).toBe("0.1.0-alpha.39");
    expect(newestRelease([release("0.1.0-alpha.40"), release("0.1.0-beta.1")], RUNNING)?.version).toBe("0.1.0-beta.1");
    expect(newestRelease([release("0.1.0-rc.1"), release("0.1.0")], RUNNING)?.version).toBe("0.1.0");
  });

  test("a release with no assets is not an upgrade, as v0.1.0-alpha.32 and 33 really are", () => {
    expect(newestRelease([bare("0.1.0-alpha.38"), release("0.1.0-alpha.37")], RUNNING)?.version).toBe("0.1.0-alpha.37");
    expect(newestRelease([bare("0.1.0-alpha.38")], RUNNING)).toBeNull();
  });

  test("only the other architecture's app is not an upgrade", () => {
    const list = [release("0.1.0-alpha.38", { arches: ["x64"] }), release("0.1.0-alpha.37")];
    expect(newestRelease(list, RUNNING)?.version).toBe("0.1.0-alpha.37");
    expect(newestRelease(list, { ...RUNNING, arch: "x64" })?.version).toBe("0.1.0-alpha.38");
    expect(newestRelease([release("0.1.0-alpha.38", { arches: ["x64"] })], RUNNING)).toBeNull();
  });

  test("release assets per platform: the DMG or ZIP on macOS, the pacman package on Linux (#432)", () => {
    expect(releaseAssetNames("darwin", "0.1.0-alpha.37", "arm64")).toEqual([
      "glosa-0.1.0-alpha.37-arm64.dmg",
      "glosa-0.1.0-alpha.37-arm64.zip",
    ]);
    expect(releaseAssetNames("linux", "0.1.0-alpha.37", "x64")).toEqual(["glosa-0.1.0-alpha.37-x64.pacman"]);
  });

  test("on Linux only a release carrying the pacman package is an upgrade (#432)", () => {
    const linux = { current: "0.1.0-alpha.36", arch: "x64", platform: "linux" as const };
    const withPacman = (version: string) => ({
      ...release(version),
      assets: [...release(version).assets, { name: `glosa-${version}-x64.pacman`, state: "uploaded" }],
    });
    // A macOS-only release is not an upgrade for a Linux app, however new.
    expect(newestRelease([release("0.1.0-alpha.38")], linux)).toBeNull();
    expect(newestRelease([release("0.1.0-alpha.38"), withPacman("0.1.0-alpha.37")], linux)?.version).toBe(
      "0.1.0-alpha.37",
    );
    // And a pacman-only release is not an upgrade for a Mac.
    const pacmanOnly = {
      ...bare("0.1.0-alpha.38"),
      assets: [{ name: "glosa-0.1.0-alpha.38-x64.pacman", state: "uploaded" }],
    };
    expect(newestRelease([pacmanOnly], { ...RUNNING, arch: "x64" })).toBeNull();
  });

  test("an asset still uploading, or a name that only looks like the app, does not count", () => {
    expect(newestRelease([release("0.1.0-alpha.38", { state: "new" })], RUNNING)).toBeNull();
    const nearMisses = {
      ...bare("0.1.0-alpha.38"),
      assets: [
        { name: "glosa-0.1.0-alpha.38-arm64.dmg.blockmap", state: "uploaded" },
        { name: "glosa-0.1.0-alpha.37-arm64.dmg", state: "uploaded" },
        { name: "glosa-0.1.0-alpha.38-arm64.pkg", state: "uploaded" },
        { name: "glosa-0.1.0-alpha.38-universal.dmg", state: "uploaded" },
        { name: "SHA256SUMS", state: "uploaded" },
      ],
    };
    expect(newestRelease([nearMisses], RUNNING)).toBeNull();
  });

  test("a draft is skipped", () => {
    const list = [release("0.1.0-alpha.39", { draft: true }), release("0.1.0-alpha.37")];
    expect(newestRelease(list, RUNNING)?.version).toBe("0.1.0-alpha.37");
  });

  test("only draft: false qualifies; a missing or non-boolean draft is a malformed entry", () => {
    for (const draft of [undefined, null, "false", 0, "", {}]) {
      const { draft: _, ...rest } = release("0.1.0-alpha.39");
      const entry = draft === undefined ? rest : { ...rest, draft };
      expect(newestRelease([entry, release("0.1.0-alpha.37")], RUNNING)?.version, String(draft)).toBe("0.1.0-alpha.37");
    }
  });

  test("a tag past MAX_TAG_LENGTH is skipped, even when it is valid SemVer and newer", () => {
    const long = `0.1.0-alpha.99.${"x".repeat(MAX_TAG_LENGTH)}`;
    expect(parseVersion(long)).not.toBeNull();
    expect(newestRelease([release(long), release("0.1.0-alpha.37")], RUNNING)?.version).toBe("0.1.0-alpha.37");
    const fits = `0.1.0-alpha.99.${"x".repeat(MAX_TAG_LENGTH - "v0.1.0-alpha.99.".length)}`;
    expect(newestRelease([release(fits), release("0.1.0-alpha.37")], RUNNING)?.version).toBe(fits);
  });

  test("entries and tags that do not parse are skipped; a bare version tag counts", () => {
    const list = [
      null,
      "v0.1.0-alpha.99",
      42,
      { ...release("0.1.0-alpha.99"), tag_name: 99 },
      { ...release("0.1.0-alpha.99"), assets: null },
      release("0.1.0-alpha.99", { tag: "latest" }),
      release("0.1.0-alpha.99", { tag: "vv0.1.0-alpha.99" }),
      release("0.1", { tag: "v0.1" }),
      release("0.1.0-alpha.37", { tag: "0.1.0-alpha.37" }),
    ];
    expect(newestRelease(list, RUNNING)).toEqual({ version: "0.1.0-alpha.37", tag: "0.1.0-alpha.37" });
  });

  test("the running version and anything older is up to date", () => {
    expect(newestRelease([release("0.1.0-alpha.36"), release("0.1.0-alpha.35")], RUNNING)).toBeNull();
    expect(newestRelease([], RUNNING)).toBeNull();
  });

  const reasons = (outcomes: UpdateOutcome[]) => outcomes.map((o) => (o.kind === "failed" ? o.reason : o.kind));
  const ok = JSON.stringify([release("0.1.0-alpha.37")]);

  test("a 2xx JSON array is read: a newer release, or up to date", () => {
    expect(updateOutcome({ status: 200, text: ok }, RUNNING)).toEqual({
      kind: "newer",
      version: "0.1.0-alpha.37",
      tag: "v0.1.0-alpha.37",
    });
    expect(updateOutcome({ status: 200, text: "[]" }, RUNNING)).toEqual({ kind: "current" });
  });

  test("a non-2xx answer fails the check, even with a release list in its body", () => {
    const outcomes = [500, 404, 403, 429, 304].map((status) => updateOutcome({ status, text: ok }, RUNNING));
    expect(reasons(outcomes)).toEqual([
      "GitHub answered with HTTP 500",
      "GitHub answered with HTTP 404",
      "GitHub is limiting requests from this network for now",
      "GitHub is limiting requests from this network for now",
      "GitHub answered with HTTP 304",
    ]);
  });

  test("a redirect fails the check with its own reason: the check follows none", () => {
    const outcomes = [301, 302, 303, 307, 308].map((status) => updateOutcome({ status, text: ok }, RUNNING));
    expect(reasons(outcomes)).toEqual(
      [301, 302, 303, 307, 308].map(
        (status) => `GitHub redirected the request (HTTP ${status}), and the check follows no redirect`,
      ),
    );
  });

  test("a 2xx whose body is not a JSON array fails the check", () => {
    const bodies = ['{"message":"Not Found"}', "<html>", "", "null", '"[]"', `{"0":${ok}}`];
    expect(reasons(bodies.map((text) => updateOutcome({ status: 200, text }, RUNNING)))).toEqual(
      bodies.map(() => "GitHub's answer was not a list of releases"),
    );
  });

  test("no answer, or one too large, fails the check with its own reason", () => {
    const outcomes = (["timeout", "network", "too-large"] as const).map((error) => updateOutcome({ error }, RUNNING));
    expect(reasons(outcomes)).toEqual([
      "GitHub did not answer in time",
      "GitHub could not be reached",
      "GitHub's answer was larger than 2 MiB, too large to be a list of releases",
    ]);
  });

  /** A 4 MiB body, twice the cap, in 64 KiB chunks, counting reads and noting a cancel. It ends,
   * so a reader without the cap finishes and fails its test rather than filling memory; a reader
   * with it stops at the chunk that crosses 2 MiB, whatever the body would have gone on to send. */
  const oversized = () => {
    const seen = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          seen.pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
          if (seen.pulls * 64 * 1024 >= 2 * MAX_RESPONSE_BYTES) controller.close();
        },
        cancel() {
          seen.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, seen };
  };

  test("the reader returns a 2xx body whole, up to and including the cap", async () => {
    expect(await readUpdateResponse(new Response(ok))).toEqual({ status: 200, text: ok });
    expect(await readUpdateResponse(new Response("[1,2]"), 5)).toEqual({ status: 200, text: "[1,2]" });
    expect(await readUpdateResponse(new Response("[1,2]"), 4)).toEqual({ error: "too-large" });
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  test("a body that grows past 2 MiB is cancelled there and fails the check, never read to its end", async () => {
    const { body, seen } = oversized();
    const read = await readUpdateResponse(new Response(body));
    expect(read).toEqual({ error: "too-large" });
    expect(seen.cancelled).toBe(true);
    expect(seen.pulls).toBe(MAX_RESPONSE_BYTES / (64 * 1024) + 1);
    expect(updateDialog(updateOutcome(read, RUNNING), context).message).toBe("The update check could not complete.");
  });

  test("a declared Content-Length over 2 MiB is refused before a byte is read", async () => {
    const { body, seen } = oversized();
    const declared = new Response(body, { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
    const read = await readUpdateResponse(declared);
    expect(read).toEqual({ error: "too-large" });
    expect(seen.pulls).toBe(0);
    expect(updateOutcome(read, RUNNING)).toMatchObject({ kind: "failed" });
  });

  test("a non-2xx body is not read at all", async () => {
    const { body, seen } = oversized();
    expect(await readUpdateResponse(new Response(body, { status: 302 }))).toEqual({ status: 302, text: "" });
    expect(seen.pulls).toBe(0);
  });

  const context = { current: RUNNING.current, releasesPage: RELEASES_PAGE };

  test("a newer version: the release page for its tag, the upgrade command, or later", () => {
    const outcome: UpdateOutcome = { kind: "newer", version: "0.1.0-alpha.37", tag: "v0.1.0-alpha.37" };
    const shown = updateDialog(outcome, context);
    expect(shown.message).toBe("glosa 0.1.0-alpha.37 is available. You have 0.1.0-alpha.36.");
    expect(shown.buttons).toEqual(["Open Release Page", "Copy Upgrade Command", "Later"]);
    expect(shown.actions).toEqual([
      { open: "https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.37" },
      { copy: "brew upgrade --cask glosa" },
      null,
    ]);
    expect(shown.cancelId).toBe(2);
  });

  test("up to date: says so, and offers nothing to open", () => {
    const shown = updateDialog({ kind: "current" }, context);
    expect(shown.message).toBe("glosa 0.1.0-alpha.36 is the newest version.");
    expect(shown.actions.every((action) => action === null)).toBe(true);
  });

  test("a failed check says it could not complete, gives the reason, and offers the releases page", () => {
    const shown = updateDialog({ kind: "failed", reason: "GitHub did not answer in time" }, context);
    expect(shown.message).toBe("The update check could not complete.");
    expect(shown.detail).toContain("GitHub did not answer in time.");
    expect(shown.buttons[0]).toBe("Open Release Page");
    expect(shown.actions[0]).toEqual({ open: RELEASES_PAGE });
    expect(
      updateDialog({ kind: "failed", reason: "x" }, { ...context, releasesPage: `${RELEASES_PAGE}/` }).actions[0],
    ).toEqual({ open: RELEASES_PAGE });
  });

  test("Open Release Page never opens a URL from GitHub's answer, whatever its html_url says", () => {
    const text = JSON.stringify([
      release("0.1.0-alpha.37", { html_url: "https://evil.example/glosa.dmg" }),
      release("0.1.0-alpha.35", { html_url: "javascript:alert(1)" }),
    ]);
    const shown = updateDialog(updateOutcome({ status: 200, text }, RUNNING), context);
    const opened = shown.actions.flatMap((action) => (action && "open" in action ? [action.open] : []));
    expect(opened).toEqual(["https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.37"]);
  });

  test("a pacman install: the release page, the pacman command for the exact file, or later (#432)", () => {
    const outcome: UpdateOutcome = { kind: "newer", version: "0.1.0-alpha.37", tag: "v0.1.0-alpha.37" };
    const shown = updateDialog(outcome, { ...context, channel: "pacman", arch: "x64" });
    expect(shown.message).toBe("glosa 0.1.0-alpha.37 is available. You have 0.1.0-alpha.36.");
    expect(shown.buttons).toEqual(["Open Release Page", "Copy Install Command", "Later"]);
    expect(shown.actions).toEqual([
      { open: "https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.37" },
      { copy: "sudo pacman -U ./glosa-0.1.0-alpha.37-x64.pacman" },
      null,
    ]);
    expect(shown.detail).toContain("glosa-0.1.0-alpha.37-x64.pacman");
    expect(shown.cancelId).toBe(2);
  });

  test("a Linux app pacman did not install gets only the release page", () => {
    const outcome: UpdateOutcome = { kind: "newer", version: "0.1.0-alpha.37", tag: "v0.1.0-alpha.37" };
    const shown = updateDialog(outcome, { ...context, channel: "download" });
    expect(shown.buttons).toEqual(["Open Release Page", "Later"]);
    expect(shown.actions).toEqual([{ open: "https://github.com/davebream/glosa/releases/tag/v0.1.0-alpha.37" }, null]);
    expect(shown.cancelId).toBe(1);
  });

  test("the channel follows the platform and the package's marker; Linux is never Homebrew", () => {
    expect(updateChannelFor("darwin", null)).toBe("homebrew-cask");
    expect(updateChannelFor("linux", "pacman")).toBe("pacman");
    expect(updateChannelFor("linux", null)).toBe("download");
    expect(updateChannelFor("linux", "deb")).toBe("download");
    for (const channel of ["pacman", "download"] as const) {
      const shown = updateDialog(
        { kind: "newer", version: "0.1.0-alpha.37", tag: "v0.1.0-alpha.37" },
        { ...context, channel },
      );
      expect(JSON.stringify(shown)).not.toMatch(/brew/i);
    }
  });

  test("no em dash in anything the dialog shows", () => {
    const outcomes: UpdateOutcome[] = [
      { kind: "newer", version: "0.1.0-alpha.37", tag: "v0.1.0-alpha.37" },
      { kind: "current" },
      updateOutcome({ error: "timeout" }, RUNNING),
    ];
    for (const channel of ["homebrew-cask", "pacman", "download"] as const) {
      for (const outcome of outcomes) {
        const { message, detail, buttons } = updateDialog(outcome, { ...context, channel });
        expect([message, detail, ...buttons].join("\n")).not.toContain("—");
      }
    }
  });

  test("the request is GitHub's release list, and its headers are constant: no version, nothing about the machine", () => {
    expect(RELEASES_API).toBe("https://api.github.com/repos/davebream/glosa/releases");
    expect(UPDATE_USER_AGENT).toBe("glosa-update");
    expect(UPDATE_HEADERS["user-agent"]).toBe(UPDATE_USER_AGENT);
    for (const value of Object.values(UPDATE_HEADERS))
      expect(value).not.toMatch(/\d+\.\d+\.\d+-|alpha|arm64|x64|darwin/);
  });
});

describe("Check for Updates…: the one request ends, however the answer stalls (#424)", () => {
  // Real time is the contract here: a local server that stalls, and requestReleases with a short
  // timeout in place of the production UPDATE_TIMEOUT_MS. Bun's fetch stands in for the Node fetch
  // the main process passes; both abort a pending read when the signal fires. The deadline below is
  // the test's own guard, well past the timeout under test.
  const stalling = (body: () => BodyInit | Promise<never>) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const b = body();
        return b instanceof Promise ? b : new Response(b, { headers: { "content-type": "application/json" } });
      },
    });
  const RUNNING = { current: "0.1.0-alpha.36", arch: "arm64" };
  const within = <T>(ms: number, p: Promise<T>) =>
    Promise.race([p, new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), ms))]);

  test("a body that never finishes ends as a timeout, and the check fails with the failure dialog", async () => {
    const server = stalling(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("[{"));
          },
        }),
    );
    try {
      const started = Date.now();
      const response = await within(5_000, requestReleases(`http://127.0.0.1:${server.port}/`, fetch, 300));
      expect(response).toEqual({ error: "timeout" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      const outcome = updateOutcome(response as { error: "timeout" }, RUNNING);
      expect(outcome).toEqual({ kind: "failed", reason: "GitHub did not answer in time" });
      expect(
        updateDialog(outcome, { current: RUNNING.current, releasesPage: "https://github.com/davebream/glosa/releases" })
          .buttons,
      ).toEqual(["Open Release Page", "Close"]);
    } finally {
      server.stop(true);
    }
  });

  test("an answer whose headers never arrive ends as a timeout too", async () => {
    const server = stalling(() => new Promise<never>(() => {}));
    try {
      expect(await within(5_000, requestReleases(`http://127.0.0.1:${server.port}/`, fetch, 300))).toEqual({
        error: "timeout",
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("more contrast: the page's read and the push (#425, A3 §4b)", () => {
  test("the SPA origin reads the system's value; only an exact true is more contrast", () => {
    expect(contrastReply(true, true)).toBe(true);
    expect(contrastReply(true, false)).toBe(false);
    for (const reading of [undefined, null, 1, "true", {}]) expect(contrastReply(true, reading)).toBe(false);
  });

  test("any other frame is refused with null whatever the system says", () => {
    expect(contrastReply(false, true)).toBeNull();
    expect(contrastReply(false, false)).toBeNull();
  });

  test("an updated event pushes only a change, as a boolean", () => {
    expect(contrastPush(false, true)).toBe(true);
    expect(contrastPush(true, false)).toBe(false);
    expect(contrastPush(true, true)).toBeNull();
    expect(contrastPush(false, false)).toBeNull();
    // A getter that stops answering a boolean reads as no more contrast.
    expect(contrastPush(true, undefined)).toBe(false);
    expect(contrastPush(false, "true")).toBeNull();
  });

  test("a push reaches a window only while its top frame is the SPA origin recorded for it", () => {
    expect(contrastPushReaches(SPA, SPA)).toBe(true);
    // A blocking screen after a failed compatibility check is a data: page, whose origin is opaque.
    expect(contrastPushReaches(SPA, "null")).toBe(false);
    expect(contrastPushReaches(SPA, "http://127.0.0.1:4646")).toBe(false);
    expect(contrastPushReaches(SPA, undefined)).toBe(false);
    // A window the shell created without an origin, or never recorded, gets nothing.
    for (const recorded of [null, undefined, ""]) expect(contrastPushReaches(recorded, SPA)).toBe(false);
  });
});

describe("Linux launch arguments and the package marker (#432)", () => {
  test("a desktop entry's file:// folder becomes a path; anything else passes through unchanged", () => {
    expect(targetFromArg("file:///home/u/My%20Notes")).toBe("/home/u/My Notes");
    expect(targetFromArg("file://localhost/home/u/ws")).toBe("/home/u/ws");
    expect(targetFromArg("/home/u/ws")).toBe("/home/u/ws");
    expect(targetFromArg("glosa://open?path=/home/u/ws")).toBe("glosa://open?path=/home/u/ws");
    // A file URL naming another host is not a local folder, and is not ours to open.
    expect(targetFromArg("file://server/share/ws")).toBe("file://server/share/ws");
    expect(targetFromArg("file:")).toBe("file:");
  });

  test("the marker is one short lowercase word, or nothing", () => {
    expect(parsePackageType("pacman\n")).toBe("pacman");
    expect(parsePackageType(null)).toBeNull();
    expect(parsePackageType("Pac Man")).toBeNull();
    expect(parsePackageType("a".repeat(65))).toBeNull();
    expect(parsePackageType("")).toBeNull();
  });
});

describe("a window whose daemon's install changed (#432, R-L8)", () => {
  test("a packaged app whose own CLI is gone runs no other install's CLI", () => {
    expect(cliChoice({ packaged: true, ownCliExists: false })).toBe("removed");
    expect(cliChoice({ packaged: true, ownCliExists: true })).toBe("lookup");
    // An unpackaged run never had its own CLI; it looks up candidates as it always did.
    expect(cliChoice({ packaged: false, ownCliExists: false })).toBe("lookup");
  });

  test("a reconnect is only a success when the same install answers", () => {
    expect(reconnectOutcome("install-a", "install-a")).toEqual({ ok: true });
    expect(reconnectOutcome("install-a", "install-b")).toEqual({ ok: false, reason: "foreign" });
    // A window paired with a daemon that published no install id cannot tell, and does not refuse.
    expect(reconnectOutcome(null, "install-b")).toEqual({ ok: true });
    const down = reconnectOutcome("install-a", null);
    expect(down).toMatchObject({ ok: false, reason: "failed" });
    expect(JSON.stringify(down)).not.toContain("\u2014");
  });
});

describe("desk browser tabs: what a page may reach, and what reaches it (#440, A3 §4b)", () => {
  test("a page loads the web and what never leaves the process, and nothing else", () => {
    for (const url of [
      "https://example.org/a",
      "http://example.org/",
      "wss://example.org/s",
      "ws://localhost:5173/hmr",
    ])
      expect(browserRequestDecision(url, [])).toBe("allow");
    for (const url of ["data:text/plain,x", "blob:https://example.org/1"])
      expect(browserRequestDecision(url, [])).toBe("allow");
    for (const url of [
      "file:///etc/passwd",
      "glosa://open?path=/x",
      "chrome://settings",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(browserRequestDecision(url, [])).toBe("cancel");
  });

  test("a page never reaches the daemon's SPA or class-F port on any loopback name", () => {
    const ports = [4646, 4647];
    for (const url of [
      "http://glosa.localhost:4646/api/handshake",
      "http://127.0.0.1:4647/doc/x",
      "http://localhost:4646/",
      "http://[::1]:4646/",
      "ws://127.0.0.1:4646/",
    ])
      expect(browserRequestDecision(url, ports)).toBe("cancel");
    // Another local server, or the same port off this machine, is a page like any other.
    expect(browserRequestDecision("http://localhost:5173/", ports)).toBe("allow");
    expect(browserRequestDecision("http://example.org:4646/", ports)).toBe("allow");
  });

  test("a tab navigates only to web addresses or a blank page", () => {
    expect(browserNavigationDecision("https://example.org/")).toBe("allow");
    expect(browserNavigationDecision("http://localhost:3000/")).toBe("allow");
    expect(browserNavigationDecision("about:blank")).toBe("allow");
    for (const url of ["file:///Users/", "mailto:a@b.c", "glosa://open?path=/x", "data:text/html,x", "about:config"])
      expect(browserNavigationDecision(url)).toBe("deny");
  });

  test("only a desk window's SPA frame may attach a tab, and only for a web address", () => {
    const desk = {
      kind: "desk" as const,
      frameOrigin: "http://glosa.localhost:4646",
      spaOrigin: "http://glosa.localhost:4646",
    };
    expect(webviewAttachDecision({ ...desk, src: "https://example.org/" })).toBe("allow");
    expect(webviewAttachDecision({ ...desk, kind: "companion", src: "https://example.org/" })).toBe("deny");
    expect(webviewAttachDecision({ ...desk, kind: null, src: "https://example.org/" })).toBe("deny");
    expect(webviewAttachDecision({ ...desk, frameOrigin: "null", src: "https://example.org/" })).toBe("deny");
    expect(webviewAttachDecision({ ...desk, frameOrigin: "http://127.0.0.1:4647", src: "https://example.org/" })).toBe(
      "deny",
    );
    expect(webviewAttachDecision({ ...desk, src: "file:///etc/hosts" })).toBe("deny");
  });

  test("a guest's preferences are locked whatever the page asked for", () => {
    const prefs: Record<string, unknown> = {
      preload: "/evil.js",
      preloadURL: "file:///evil.js",
      nodeIntegration: true,
      sandbox: false,
      contextIsolation: false,
      partition: "persist:elsewhere",
      webSecurity: false,
      enableBlinkFeatures: "X",
    };
    lockGuestPreferences(prefs);
    expect(prefs).toMatchObject({
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect(prefs).not.toHaveProperty("preload");
    expect(prefs).not.toHaveProperty("preloadURL");
    expect(prefs).not.toHaveProperty("enableBlinkFeatures");
    expect(BROWSER_PARTITION.startsWith("persist:")).toBe(true);
  });

  test("the user agent names neither Electron nor glosa", () => {
    for (const product of ["glosa", "glosadev"]) {
      const fallback = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${product}/0.1.0-alpha.36 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36`;
      const ua = browserUserAgent(fallback);
      expect(ua).not.toMatch(/glosa|Electron/i);
      expect(ua).toContain("Chrome/152.0.7977.130");
      expect(ua).toContain("Safari/537.36");
    }
  });

  test("glosa's chords work with a page focused; everything else is the page's", () => {
    const mac = (key: string, extra = {}) => browserKeyAction({ type: "keyDown", key, meta: true, ...extra }, "darwin");
    expect(mac("r")).toBe("reload");
    expect(mac("[")).toBe("back");
    expect(mac("]")).toBe("forward");
    for (const key of ["w", "k", "t", "l", "W", "\\"]) expect(mac(key)).toBe("app");
    expect(mac("ArrowRight", { alt: true })).toBe("app");
    expect(browserKeyAction({ type: "keyDown", key: "Tab", control: true }, "darwin")).toBe("app");
    // The page's own keys and edits stay the page's.
    for (const key of ["c", "v", "a", "z", "f", "1"]) expect(mac(key)).toBe(null);
    expect(browserKeyAction({ type: "keyDown", key: "w" }, "darwin")).toBe(null);
    expect(browserKeyAction({ type: "keyUp", key: "w", meta: true }, "darwin")).toBe(null);
    // Ctrl is the modifier off macOS, and ⌘ is not.
    expect(browserKeyAction({ type: "keyDown", key: "w", control: true }, "linux")).toBe("app");
    expect(browserKeyAction({ type: "keyDown", key: "w", meta: true }, "linux")).toBe(null);
  });

  test("Open in your browser leaves only for web and mail addresses", () => {
    for (const url of ["https://example.org/", "http://localhost:3000/", "mailto:someone@example.org"])
      expect(externalLinkDecision(url)).toBe("open");
    for (const url of [
      "file:///Applications/Calculator.app",
      "glosa://open?path=/x",
      "javascript:void 0",
      "zoommtg://x",
      42,
      null,
    ])
      expect(externalLinkDecision(url)).toBe("refuse");
    expect(externalLinkDecision(`https://example.org/${"a".repeat(9000)}`)).toBe("refuse");
  });

  test("refused permissions a person would miss are named; the rest stay quiet", () => {
    expect(permissionNotice("media")).toBe("your camera or microphone");
    expect(permissionNotice("geolocation")).toBe("your location");
    expect(permissionNotice("fullscreen")).toBe(null);
    expect(permissionNotice("clipboard-sanitized-write")).toBe(null);
  });

  test("a blocked download is named by its file alone, cut to a notice's length", () => {
    expect(downloadName("tides-2026.pdf")).toBe("tides-2026.pdf");
    expect(downloadName("../../etc/passwd")).toBe("passwd");
    expect(downloadName("a\nb.txt")).toBe("ab.txt");
    expect(downloadName("evil\u0000\u001b[2Jname.txt")).toBe("evil[2Jname.txt");
    expect(downloadName("")).toBe("a file");
    expect(downloadName(`${"x".repeat(100)}.pdf`)).toHaveLength(78);
  });

  test("the right-click menu offers link, editing and page actions where they apply", () => {
    const labels = (items: ReturnType<typeof browserContextMenu>) =>
      items.map((item) => ("label" in item ? item.label : "role" in item ? item.role : "-"));
    expect(
      labels(browserContextMenu({ linkURL: "https://example.org/", canGoBack: true, canGoForward: false })),
    ).toEqual([
      "Open Link in New Browser Tab",
      "Open Link in Your Browser",
      "Copy Link Address",
      "-",
      "Back",
      "Reload",
    ]);
    expect(labels(browserContextMenu({ isEditable: true, canGoBack: false, canGoForward: true }))).toEqual([
      "cut",
      "copy",
      "paste",
      "selectAll",
      "-",
      "Forward",
      "Reload",
    ]);
    // A link that is not a web address gets no link actions.
    expect(labels(browserContextMenu({ linkURL: "file:///x", canGoBack: false, canGoForward: false }))).toEqual([
      "Reload",
    ]);
  });
});

describe("a chat agent's read of a browser tab (#440)", () => {
  const page = (text: string) => ({ url: "https://example.org/a", title: "Example", text });

  test("returns the page's address, title and text, whole when it fits", () => {
    expect(browserReadResult(page("Hello"), 5000)).toEqual({
      url: "https://example.org/a",
      title: "Example",
      text: "Hello",
      truncated: false,
    });
  });

  test("cuts the text at the cap and says so; the cap stays between 1,000 and 100,000", () => {
    const long = "x".repeat(250_000);
    const cut = browserReadResult(page(long), 2000)!;
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe(`${"x".repeat(2000)}\n\n[glosa cut the page's text at 2000 characters.]`);
    expect(browserReadResult(page(long), 10)!.text.startsWith(`${"x".repeat(1000)}\n\n`)).toBe(true);
    expect(browserReadResult(page(long), 10_000_000)!.text).toContain(`at ${BROWSER_READ_MAX} characters.`);
    expect(browserReadResult(page(long), Number.NaN)!.text).toContain(`at ${BROWSER_READ_MAX} characters.`);
    expect(browserReadResult(page("x".repeat(1000)), 1000)!.truncated).toBe(false);
  });

  test("anything but that shape from the page is refused, and the address and title are bounded", () => {
    for (const raw of [null, "text", 42, { url: 1, title: "", text: "" }, { url: "", title: "" }]) {
      expect(browserReadResult(raw, 5000)).toBeNull();
    }
    const huge = browserReadResult(
      { url: `https://e.org/${"a".repeat(20_000)}`, title: "t".repeat(5000), text: "" },
      5000,
    )!;
    expect(huge.url.length).toBe(8192);
    expect(huge.title.length).toBe(1024);
  });

  test("the script reads only the address, title and visible text, and calls nothing the page defined", () => {
    expect(BROWSER_READ_SCRIPT).toContain("location.href");
    expect(BROWSER_READ_SCRIPT).toContain("document.title");
    expect(BROWSER_READ_SCRIPT).toContain("document.body.innerText");
    expect(BROWSER_READ_SCRIPT).not.toMatch(/window\.|fetch|eval|postMessage/);
  });
});

describe("Linux foreground dictation permission", () => {
  const allowed = {
    platform: "linux",
    active: true,
    mainFrame: true,
    origin: "http://glosa.localhost:4646",
    expectedOrigin: "http://glosa.localhost:4646",
    permission: "media",
    mediaTypes: ["audio"],
  };
  test("only one approved SPA main-frame audio attempt can use the microphone", () => {
    expect(dictationPermissionAllowed(allowed)).toBe(true);
    // Electron's media securityOrigin includes a trailing slash; IPC frame origins do not.
    expect(dictationPermissionAllowed({ ...allowed, origin: `${allowed.origin}/` })).toBe(true);
    for (const change of [
      { platform: "darwin" },
      { active: false },
      { mainFrame: false },
      { origin: "null" },
      { origin: "https://example.com" },
      { expectedOrigin: undefined },
      { permission: "display-capture" },
      { mediaTypes: [] },
      { mediaTypes: ["video"] },
      { mediaTypes: ["audio", "video"] },
    ]) {
      expect(dictationPermissionAllowed({ ...allowed, ...change })).toBe(false);
    }
  });
  test("the same attempt permits only the exact provider WebSocket and never general egress", () => {
    const request = {
      ...allowed,
      resourceType: "webSocket",
      url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
    };
    expect(dictationEgressAllowed(request)).toBe(true);
    for (const change of [
      { active: false },
      { mainFrame: false },
      { platform: "darwin" },
      { origin: "null" },
      { resourceType: "xhr" },
      { url: `${request.url}?secret=bad` },
      { url: "wss://platform-api.wisprflow.ai/other" },
      { url: "https://platform-api.wisprflow.ai/api/v1/dash/client_ws" },
    ]) {
      expect(dictationEgressAllowed({ ...request, ...change })).toBe(false);
    }
  });
});
