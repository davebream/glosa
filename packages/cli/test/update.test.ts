// SPDX-License-Identifier: Apache-2.0
// `glosa update` — every branch is exercised through the injected `UpdateDeps` seam, so there is no
// network and no spawn anywhere in this file. The pure helpers (classification, URL trust boundary,
// redaction, target resolution) are table-tested directly.
import { describe, expect, test } from "bun:test";
import {
  classifyInstall,
  createLineRedactor,
  decideAction,
  deriveChannel,
  parseRegistryUrl,
  redact,
  resolveTarget,
  validateTarballUrl,
} from "../src/update.ts";

const BUN = "/Users/x/.bun/install/global/node_modules/@davebream/glosa";
const NPM = "/usr/local/lib/node_modules/@davebream/glosa";
const VOLTA_PATH = "/Users/x/.volta/tools/image/packages/@davebream/glosa/lib/node_modules/@davebream/glosa";

describe("classifyInstall", () => {
  test.each([
    [BUN, "bun-global"],
    ["/opt/bunroot/install/global/node_modules/@davebream/glosa", "bun-global"],
    [NPM, "npm-global"],
    ["/opt/homebrew/lib/node_modules/@davebream/glosa", "npm-global"],
    // Volta MUST win over the /lib/node_modules/ marker: its layout matches, but writing there
    // bypasses the shim, so a naive classify would report success while `glosa --version` still
    // printed the old version.
    [VOLTA_PATH, "volta"],
    ["/Users/x/.bun/install/cache/@davebream/glosa@0.1.0-alpha.0", "ephemeral"],
    ["/Users/x/.npm/_npx/abc/node_modules/@davebream/glosa", "ephemeral"],
    ["/Users/x/proj/node_modules/@davebream/glosa", "project-local"],
    ["/Users/x/Library/pnpm/global/5/node_modules/@davebream/glosa", "pnpm"],
    // import.meta.url resolves pnpm's symlink farm into the store; the path still carries /pnpm/.
    ["/Users/x/Library/pnpm/store/v3/files/ab/cdef/node_modules/@davebream/glosa", "pnpm"],
    ["/Users/x/.yarn/berry/cache/@davebream-glosa-npm-0.1.0", "yarn"],
    // A `bun link`ed dev copy: import.meta.url resolves the global symlink straight to the checkout
    // root, which carries no package-path suffix. Caught without any realpath comparison.
    ["/Users/x/code/glosa", "unknown"],
    ["/Users/x/somewhere/glosa", "unknown"],
  ] as const)("%s -> %s", (path, kind) => {
    expect(classifyInstall(path).kind).toBe(kind);
  });

  test("a `bun link`ed checkout is source-checkout once the .git marker is seen", () => {
    expect(classifyInstall("/Users/x/code/glosa", true).kind).toBe("source-checkout");
  });

  test("a .git marker beats every managed marker — never write into a developer's own tree", () => {
    expect(classifyInstall(BUN, true).kind).toBe("source-checkout");
    expect(classifyInstall(NPM, true).kind).toBe("source-checkout");
  });

  test("bun-global carries the install/global dir to pin", () => {
    expect(classifyInstall(BUN)).toMatchObject({
      kind: "bun-global",
      managed: true,
      installDir: "/Users/x/.bun/install/global",
    });
  });

  test("npm-global carries the prefix, not the lib dir", () => {
    expect(classifyInstall(NPM)).toMatchObject({ kind: "npm-global", managed: true, installDir: "/usr/local" });
  });

  test("every refused kind carries a copy-pasteable manual command", () => {
    for (const p of [
      VOLTA_PATH,
      "/Users/x/proj/node_modules/@davebream/glosa",
      "/Users/x/Library/pnpm/global/5/node_modules/@davebream/glosa",
      "/Users/x/.yarn/berry/cache/@davebream-glosa-npm-0.1.0",
      "/Users/x/.bun/install/cache/@davebream/glosa@0.1.0-alpha.0",
      "/Users/x/somewhere/glosa",
    ]) {
      const c = classifyInstall(p);
      expect(c.managed).toBe(false);
      expect(c.manualCommand, `${p} needs a manual command`).toBeTruthy();
    }
    expect(classifyInstall("/Users/x/code/glosa", true).manualCommand).toBe("git pull && bun install");
    expect(classifyInstall(VOLTA_PATH).manualCommand).toBe("volta install @davebream/glosa");
  });

  test("asdf and mise installs are npm-global but flagged for a reshim", () => {
    expect(classifyInstall("/Users/x/.asdf/installs/nodejs/22.0.0/lib/node_modules/@davebream/glosa")).toMatchObject({
      kind: "npm-global",
      reshimHint: "asdf reshim nodejs",
    });
    expect(
      classifyInstall("/Users/x/.local/share/mise/installs/node/22.0.0/lib/node_modules/@davebream/glosa"),
    ).toMatchObject({ kind: "npm-global", reshimHint: "mise reshim" });
  });
});

const REG = "https://registry.npmjs.org";

describe("parseRegistryUrl", () => {
  test.each([
    ["https://registry.npmjs.org", true],
    ["https://mirror.corp.example/repo/npm", true],
    ["http://registry.npmjs.org", false],
    // NO loopback carve-out: the fetchPackument seam is injected, so tests never need a real
    // listener, and the carve-out would be reachable from the user-facing --registry flag.
    ["http://127.0.0.1:4873", false],
    ["http://localhost:4873", false],
    ["file:///etc/passwd", false],
    ["ftp://example.com", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
    ["", false],
    ["https://alice:secret@registry.npmjs.org", false],
  ])("%s -> ok=%s", (raw, ok) => {
    expect(parseRegistryUrl(raw).ok).toBe(ok);
  });
});

describe("validateTarballUrl", () => {
  const V = "0.1.0-alpha.3";
  const good = `${REG}/@davebream/glosa/-/glosa-${V}.tgz`;

  test("accepts the real npm tarball URL", () => {
    expect(validateTarballUrl(good, REG, V, false).ok).toBe(true);
  });

  test.each([
    // suffix-domain trick — the classic `includes()` bypass
    [`https://registry.npmjs.org.evil.com/@davebream/glosa/-/glosa-${V}.tgz`],
    // userinfo tricks: WHATWG parses `registry.npmjs.org` as userinfo and `evil.com` as the host
    [`https://registry.npmjs.org@evil.com/@davebream/glosa/-/glosa-${V}.tgz`],
    [`https://x@registry.npmjs.org.evil.com/@davebream/glosa/-/glosa-${V}.tgz`],
    // substring anywhere in the path
    [`https://evil.com/registry.npmjs.org/@davebream/glosa/-/glosa-${V}.tgz`],
    // same host, different port
    [`https://registry.npmjs.org:8081/@davebream/glosa/-/glosa-${V}.tgz`],
    // plaintext even on the right host
    [`http://registry.npmjs.org/@davebream/glosa/-/glosa-${V}.tgz`],
    // right host, wrong package
    [`${REG}/@evil/pkg/-/pkg-${V}.tgz`],
    // right host, right package, wrong version
    [`${REG}/@davebream/glosa/-/glosa-9.9.9.tgz`],
    // right host, path traversal (URL normalizes `..`, so the shape test catches it)
    [`${REG}/@davebream/glosa/-/../../evil.tgz`],
  ])("rejects %s", (url) => {
    expect(validateTarballUrl(url, REG, V, false).ok).toBe(false);
  });

  // Immune to any `hostname.includes(registryHost)` implementation; fails only a real equality check.
  test("a host that CONTAINS the registry host is still rejected", () => {
    expect(validateTarballUrl(`https://registry.npmjs.org.evil.com/@davebream/glosa/-/glosa-${V}.tgz`, REG, V, false).ok).toBe(
      false,
    );
  });

  test("a trailing-dot hostname is DNS-equivalent and must not false-reject", () => {
    expect(validateTarballUrl(`https://registry.npmjs.org./@davebream/glosa/-/glosa-${V}.tgz`, REG, V, false).ok).toBe(true);
  });

  test("an offsite host is accepted only with the explicit override", () => {
    const offsite = `https://mirror.corp.example/@davebream/glosa/-/glosa-${V}.tgz`;
    expect(validateTarballUrl(offsite, REG, V, false).ok).toBe(false);
    expect(validateTarballUrl(offsite, REG, V, true).ok).toBe(true);
  });

  test("the override widens WHERE, never HOW — https stays mandatory", () => {
    expect(validateTarballUrl(`http://mirror.corp.example/@davebream/glosa/-/glosa-${V}.tgz`, REG, V, true).ok).toBe(false);
  });
});

describe("redact", () => {
  test.each([
    ["npm ERR! https://alice:s3cr3t@registry.corp/x", "s3cr3t"],
    ["//registry.corp/:_authToken=npm_EXAMPLE_NOT_A_REAL_TOKEN", "npm_EXAMPLE_NOT_A_REAL_TOKEN"],
    ["//registry.corp/:_auth=EXAMPLE_NOT_REAL_BASE64==", "EXAMPLE_NOT_REAL_BASE64"],
    ["//registry.corp/:_password=hunter2", "hunter2"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["value=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ])("scrubs the secret in %s", (line, secret) => {
    expect(redact(line)).not.toContain(secret);
  });

  test("leaves ordinary installer output legible", () => {
    expect(redact("115 packages installed [854.00ms]")).toBe("115 packages installed [854.00ms]");
  });
});

describe("createLineRedactor", () => {
  test("a token split across two chunks never reaches the sink unredacted", () => {
    let out = "";
    const r = createLineRedactor((s) => {
      out += s;
    });
    r.push("npm ERR! //registry.corp/:_authTok");
    r.push("en=npm_SuperSecretValue123\n");
    r.flush();
    expect(out).not.toContain("npm_SuperSecretValue123");
    expect(out).toContain("[redacted]");
  });

  test("emits complete lines eagerly so progress is visible while the installer runs", () => {
    const seen: string[] = [];
    const r = createLineRedactor((s) => seen.push(s));
    r.push("Resolving dependencies\nResolved, downloaded and extracted [105]\n");
    expect(seen).toEqual(["Resolving dependencies\n", "Resolved, downloaded and extracted [105]\n"]);
  });

  test("flush emits a trailing partial line (no-newline progress bars)", () => {
    let out = "";
    const r = createLineRedactor((s) => {
      out += s;
    });
    r.push("installing...");
    expect(out).toBe("");
    r.flush();
    expect(out).toBe("installing...");
  });

  test("a no-newline stream is bounded, and the split boundary keeps a token intact", () => {
    let out = "";
    const r = createLineRedactor((s) => {
      out += s;
    });
    r.push("x".repeat(9000));
    r.push("_authToken=npm_TailSecretValue0001\n");
    r.flush();
    expect(out).not.toContain("npm_TailSecretValue0001");
  });
});

const GOOD_SHA = "YXHRRkWEVirER/go5i15Uqnm2tHh+tzPQRJEtVMmB7Wx+/J4GoIxQAfDZzVMYRvFkqsHi7TR58jlXNolUOr9hg==";

const PACKUMENT = {
  "dist-tags": { latest: "0.1.0-alpha.0", alpha: "0.1.0-alpha.3" },
  versions: {
    "0.1.0-alpha.0": {
      dist: {
        tarball: "https://registry.npmjs.org/@davebream/glosa/-/glosa-0.1.0-alpha.0.tgz",
        integrity: "sha512-AAAA",
      },
    },
    "0.1.0-alpha.3": {
      dist: {
        tarball: "https://registry.npmjs.org/@davebream/glosa/-/glosa-0.1.0-alpha.3.tgz",
        integrity: `sha512-${GOOD_SHA}`,
      },
    },
  },
};

describe("deriveChannel", () => {
  test.each([
    ["0.1.0-alpha.2", "alpha"],
    ["0.1.0-beta.7", "beta"],
    ["0.2.0-rc.1", "rc"],
    ["1.0.0", "latest"],
  ])("%s -> %s", (v, ch) => expect(deriveChannel(v)).toBe(ch));
});

describe("resolveTarget", () => {
  test("resolves a dist-tag to a version + tarball + integrity", () => {
    expect(resolveTarget(PACKUMENT, { channel: "alpha" })).toMatchObject({
      ok: true,
      version: "0.1.0-alpha.3",
      integrity: `sha512-${GOOD_SHA}`,
      latest: "0.1.0-alpha.0",
    });
  });

  test("an unknown channel lists the available tags", () => {
    const r = resolveTarget(PACKUMENT, { channel: "nightly" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("update-unknown-channel");
      expect(r.availableTags).toEqual(["alpha", "latest"]);
    }
  });

  test("--to addresses an exact version", () => {
    expect(resolveTarget(PACKUMENT, { version: "0.1.0-alpha.0" })).toMatchObject({ ok: true, version: "0.1.0-alpha.0" });
  });

  test("--to an unpublished version is a user error", () => {
    const r = resolveTarget(PACKUMENT, { version: "9.9.9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("update-unknown-version");
  });

  // A real post-`npm unpublish` state — distinct from user error, so a distinct code.
  test("a dist-tag pointing at a missing version is registry-inconsistent, not user error", () => {
    const broken = { "dist-tags": { alpha: "0.1.0-alpha.9" }, versions: PACKUMENT.versions };
    const r = resolveTarget(broken, { channel: "alpha" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("registry-inconsistent");
  });

  test("a version entry with no dist.tarball is registry-inconsistent", () => {
    const broken = { "dist-tags": { alpha: "0.1.0-alpha.3" }, versions: { "0.1.0-alpha.3": { dist: {} } } };
    const r = resolveTarget(broken, { channel: "alpha" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("registry-inconsistent");
  });

  test("a non-semver version string is refused before it can reach an argv", () => {
    const broken = {
      "dist-tags": { alpha: "not-a-version" },
      versions: { "not-a-version": { dist: { tarball: "https://x/y.tgz", integrity: "sha512-C" } } },
    };
    expect(resolveTarget(broken, { channel: "alpha" }).ok).toBe(false);
  });

  test("a malformed packument is registry-inconsistent rather than a crash", () => {
    for (const junk of [null, 42, "string", {}, { versions: {} }, { "dist-tags": null }]) {
      const r = resolveTarget(junk, { channel: "alpha" });
      expect(r.ok).toBe(false);
    }
  });
});

describe("decideAction", () => {
  test.each([
    // current,        target,          force, dryRun, action,              installs
    ["0.1.0-alpha.2", "0.1.0-alpha.3", false, false, "updated", true],
    ["0.1.0-alpha.3", "0.1.0-alpha.3", false, false, "already-current", false],
    ["0.1.0-alpha.3", "0.1.0-alpha.0", false, false, "downgrade-refused", false],
    // --force installs regardless: older, equal, or newer. Equal matters because BUILD_ID is
    // version + content hash, so the same version can carry different bytes.
    ["0.1.0-alpha.3", "0.1.0-alpha.0", true, false, "updated", true],
    ["0.1.0-alpha.3", "0.1.0-alpha.3", true, false, "updated", true],
    // --check never installs, and --check --force is legal: "show me what --force would install".
    ["0.1.0-alpha.2", "0.1.0-alpha.3", false, true, "checked", false],
    ["0.1.0-alpha.3", "0.1.0-alpha.0", true, true, "checked", false],
    ["0.1.0-alpha.3", "0.1.0-alpha.0", false, true, "checked", false],
  ] as const)("%s -> %s force=%s dry=%s", (current, target, force, dryRun, action, installs) => {
    const d = decideAction(current, target, { force, dryRun });
    expect(d.action).toBe(action);
    expect(d.shouldInstall).toBe(installs);
  });

  test("--check reports availability in data, never in the exit code", () => {
    const d = decideAction("0.1.0-alpha.2", "0.1.0-alpha.3", { force: false, dryRun: true });
    expect(d.updateAvailable).toBe(true);
    expect(d.wouldInstall).toBe(true);
    expect(d.exitCode).toBe(0);
  });

  test("--check still reports the real comparison for a downgrade", () => {
    const d = decideAction("0.1.0-alpha.3", "0.1.0-alpha.0", { force: false, dryRun: true });
    expect(d).toMatchObject({ action: "checked", comparison: "older", wouldInstall: false });
  });

  test("every action exits 0 — availability is data, not an exit code", () => {
    for (const [c, t, force, dryRun] of [
      ["0.1.0-alpha.2", "0.1.0-alpha.3", false, false],
      ["0.1.0-alpha.3", "0.1.0-alpha.3", false, false],
      ["0.1.0-alpha.3", "0.1.0-alpha.0", false, false],
      ["0.1.0-alpha.2", "0.1.0-alpha.3", false, true],
    ] as const) {
      expect(decideAction(c, t, { force, dryRun }).exitCode).toBe(0);
    }
  });

  // Without this, a user on a retired alpha line sits at a permanent, confident "up to date".
  test("a retired channel does not report a confident 'up to date' when a newer stable exists", () => {
    const d = decideAction("0.1.0-alpha.3", "0.1.0-alpha.3", { force: false, dryRun: false, latest: "0.2.0" });
    expect(d.action).toBe("already-current");
    expect(d.warnings.map((w) => w.code)).toContain("newer-stable-available");
    expect(d.warnings.find((w) => w.code === "newer-stable-available")?.message).toContain("glosa update --channel latest");
  });

  test("no newer-stable warning when latest is not ahead of the target", () => {
    const d = decideAction("0.1.0-alpha.2", "0.1.0-alpha.3", { force: false, dryRun: false, latest: "0.1.0-alpha.0" });
    expect(d.warnings.map((w) => w.code)).not.toContain("newer-stable-available");
  });
});
