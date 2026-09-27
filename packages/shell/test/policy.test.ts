// SPDX-License-Identifier: Apache-2.0
// The shell's pure rules. Each test names the contract clause it pins; deleting the rule in
// policy.ts must turn the matching test red (AGENTS.md "ablate it").
import { describe, expect, test } from "bun:test";
import { buildAppUrl } from "../../cli/src/open-presentation.ts";
import {
  cliCandidates,
  compareVersions,
  compatibility,
  egressDecision,
  linkFromArgv,
  loopbackApiOrigin,
  navigationDecision,
  needsConfirmation,
  notifyDecision,
  openArgsFor,
  parseGlosaUrl,
  parseOpenEnvelope,
  plainPath,
  preloadShouldExpose,
  quitDecision,
  RecentIds,
  type RoutedWindow,
  representedFile,
  revealTarget,
  scrubChildEnv,
  splitPresentationToken,
  surfaceKind,
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
  test("the recorded executable comes first and honours GLOSA_HOME", () => {
    expect(cliCandidates({ glosaHome: "/tmp/h", homeDir: HOME, resourcesPath: null })[0]).toBe("/tmp/h/bin/glosa");
    expect(cliCandidates({ homeDir: HOME, resourcesPath: null })[0]).toBe("/Users/u/.glosa/bin/glosa");
  });
  test("a packaged app's own CLI is second, before every well-known bin", () => {
    expect(cliCandidates({ homeDir: HOME, resourcesPath: RESOURCES })).toEqual([
      "/Users/u/.glosa/bin/glosa",
      "/Applications/glosa.app/Contents/Resources/bin/glosa",
      ...WELL_KNOWN,
    ]);
  });
  test("an unpackaged run has no bundle candidate and ends with the bare name", () => {
    const candidates = cliCandidates({ homeDir: HOME, resourcesPath: null });
    expect(candidates).toEqual(["/Users/u/.glosa/bin/glosa", ...WELL_KNOWN]);
    expect(candidates.some((c) => c.includes("/Contents/Resources/"))).toBe(false);
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
