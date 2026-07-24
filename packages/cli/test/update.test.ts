// SPDX-License-Identifier: Apache-2.0
// `glosa update` — every branch is exercised through the injected `UpdateDeps` seam, so there is no
// network and no spawn anywhere in this file. The pure helpers (classification, URL trust boundary,
// redaction, target resolution) are table-tested directly.
import { describe, expect, test } from "bun:test";
import {
  binPathFor,
  buildInstallerArgv,
  buildInstallerEnv,
  classifyInstall,
  createLineRedactor,
  decideAction,
  deriveChannel,
  fetchFailureToError,
  interpretProbe,
  parseRegistryUrl,
  readDaemonLockWith,
  readPackumentResponse,
  redact,
  resolvePackageManager,
  resolveTarget,
  validateTarballUrl,
  verifyIntegrity,
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

describe("readPackumentResponse", () => {
  test("parses a good body", async () => {
    const r = await readPackumentResponse(new Response(JSON.stringify(PACKUMENT), { status: 200 }));
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  test("a non-2xx is `http` with its status", async () => {
    const r = await readPackumentResponse(new Response("nope", { status: 401, statusText: "Unauthorized" }));
    expect(r).toMatchObject({ ok: false, kind: "http", status: 401 });
  });

  test("a non-JSON body (captive portal / proxy error page) is `malformed`", async () => {
    const r = await readPackumentResponse(new Response("<html>proxy error</html>", { status: 200 }));
    expect(r).toMatchObject({ ok: false, kind: "malformed" });
  });

  // The branch a naive `await res.text()` implementation makes unreachable: it would buffer the
  // whole body and OOM before ever checking the size.
  test("an unbounded body is cut off at the cap instead of being buffered whole", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const r = await readPackumentResponse(new Response(body, { status: 200 }));
    expect(r).toMatchObject({ ok: false, kind: "too-large" });
    expect(pulled).toBeLessThan(64); // proves it stopped early rather than reading forever
  });
});

describe("fetchFailureToError", () => {
  test.each([
    ["timeout", undefined, "registry-unreachable", "network"],
    ["network", undefined, "registry-unreachable", "network"],
    ["http", 404, "registry-http-error", "registry"],
    ["http", 401, "registry-http-error", "registry"],
    ["http", 500, "registry-http-error", "registry"],
    ["malformed", undefined, "registry-malformed-response", "registry"],
    ["too-large", undefined, "registry-malformed-response", "registry"],
  ] as const)("%s/%s -> %s (%s)", (kind, status, code, errKind) => {
    const e = fetchFailureToError({ ok: false, kind, status, message: "x" }, REG);
    expect(e.error.code).toBe(code);
    expect(e.error.kind).toBe(errKind);
    expect(e.exitCode).toBe(70);
    expect(e.error.hint).toBeTruthy(); // hint is mandatory on every non-zero envelope
  });

  test("401/403 names the real cause instead of a generic HTTP error", () => {
    const e = fetchFailureToError({ ok: false, kind: "http", status: 401, message: "Unauthorized" }, "https://mirror.corp");
    expect(e.error.message.toLowerCase()).toContain("authenticat");
    expect(e.error.hint).toContain(".npmrc");
  });

  test("no failure kind is described as an internal glosa error", () => {
    for (const kind of ["timeout", "network", "http", "malformed", "too-large"] as const) {
      expect(fetchFailureToError({ ok: false, kind, message: "x" }, REG).error.kind).not.toBe("internal");
    }
  });
});

describe("verifyIntegrity", () => {
  const REAL = `sha512-${GOOD_SHA}`;

  test("accepts the real published digest for the real bytes", () => {
    expect(verifyIntegrity(REAL, GOOD_SHA).ok).toBe(true);
  });

  test("refuses a single flipped byte", () => {
    expect(verifyIntegrity(REAL, `${GOOD_SHA.slice(0, -2)}XX`).ok).toBe(false);
  });

  test("refuses an algorithm we do not verify rather than silently passing", () => {
    expect(verifyIntegrity("sha1-abc", "abc").ok).toBe(false);
    expect(verifyIntegrity("md5-abc", "abc").ok).toBe(false);
    expect(verifyIntegrity("noalgo", "noalgo").ok).toBe(false);
  });

  test("a packument with NO integrity field is refused, not waved through", () => {
    expect(verifyIntegrity(null, GOOD_SHA).ok).toBe(false);
    expect(verifyIntegrity("", GOOD_SHA).ok).toBe(false);
  });

  test("a truncated digest is rejected, never treated as a prefix match", () => {
    expect(verifyIntegrity(REAL, GOOD_SHA.slice(0, 20)).ok).toBe(false);
  });
});

describe("resolvePackageManager", () => {
  test.each([
    ["bun-global", "bun"],
    ["npm-global", "npm"],
  ] as const)("%s resolves %s", (kind, cmd) => {
    const c = { kind } as never;
    expect(resolvePackageManager(c, () => `/p/${cmd}`)).toEqual({ ok: true, path: `/p/${cmd}` });
    expect(resolvePackageManager(c, () => null)).toEqual({ ok: false, cmd });
  });
});

const TGZ = "/var/folders/ab/glosa-update-x1/glosa-0.1.0-alpha.3.tgz";

describe("buildInstallerArgv", () => {
  test("bun-global", () => {
    expect(buildInstallerArgv(classifyInstall(BUN), "/opt/homebrew/bin/bun", TGZ)).toEqual([
      "/opt/homebrew/bin/bun",
      "add",
      "--global",
      "--",
      TGZ,
    ]);
  });

  test("npm-global uses the equals form so a leading-dash prefix cannot be read as a flag", () => {
    expect(buildInstallerArgv(classifyInstall(NPM), "/usr/bin/npm", TGZ)).toEqual([
      "/usr/bin/npm",
      "install",
      "--global",
      "--prefix=/usr/local",
      "--",
      TGZ,
    ]);
    expect(buildInstallerArgv({ kind: "npm-global", installDir: "/-oops" } as never, "/usr/bin/npm", TGZ)).toEqual([
      "/usr/bin/npm",
      "install",
      "--global",
      "--prefix=/-oops",
      "--",
      TGZ,
    ]);
  });

  test("the tarball is always the last argument and always absolute", () => {
    for (const c of [classifyInstall(BUN), classifyInstall(NPM)]) {
      const argv = buildInstallerArgv(c, "/bin/pm", TGZ);
      expect(argv.at(-1)).toBe(TGZ);
      expect(argv.at(-1)?.startsWith("/")).toBe(true);
    }
  });
});

describe("buildInstallerEnv", () => {
  const BASE = {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    ANTHROPIC_API_KEY: "sk-ant-should-never-appear",
    BUN_INSTALL: "/Users/x/.bun",
  };

  test("ANTHROPIC_API_KEY is scrubbed (invariant 5)", () => {
    const env = buildInstallerEnv(BASE, classifyInstall(BUN));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sk-ant-should-never-appear");
  });

  test("bun-global pins BUN_INSTALL_GLOBAL_DIR and leaves an existing BUN_INSTALL alone", () => {
    const env = buildInstallerEnv(BASE, classifyInstall(BUN));
    expect(env.BUN_INSTALL_GLOBAL_DIR).toBe("/Users/x/.bun/install/global");
    expect(env.BUN_INSTALL).toBe("/Users/x/.bun");
  });

  test("npm-global adds no env pin — the prefix travels as a flag", () => {
    const env = buildInstallerEnv(BASE, classifyInstall(NPM));
    expect(env.BUN_INSTALL_GLOBAL_DIR).toBeUndefined();
    expect(env.npm_config_prefix).toBeUndefined();
  });

  test("a corporate mirror config is deliberately preserved", () => {
    const env = buildInstallerEnv({ ...BASE, npm_config_registry: "https://mirror.corp/npm" }, classifyInstall(NPM));
    expect(env.npm_config_registry).toBe("https://mirror.corp/npm");
  });
});

describe("binPathFor", () => {
  // bun's PACKAGE dir and BIN dir are governed by different env vars, so the derivations differ.
  test("bun-global strips /install/global before appending /bin", () => {
    expect(binPathFor(classifyInstall(BUN))).toBe("/Users/x/.bun/bin/glosa");
  });

  test("npm-global appends /bin to the prefix", () => {
    expect(binPathFor(classifyInstall(NPM))).toBe("/usr/local/bin/glosa");
  });

  test("a refused kind has no bin path", () => {
    expect(binPathFor(classifyInstall(VOLTA_PATH))).toBeNull();
  });
});

describe("interpretProbe", () => {
  test("a matching version verifies", () => {
    expect(interpretProbe("glosa 0.1.0-alpha.3", "0.1.0-alpha.3", "/usr/local/bin/glosa")).toMatchObject({
      matched: true,
      exitCode: 0,
      reportedVersion: "0.1.0-alpha.3",
    });
  });

  test("parses `glosa <version>`, never a bare string compare", () => {
    expect(interpretProbe("glosa 0.1.0-alpha.3\n", "0.1.0-alpha.3", "/p").matched).toBe(true);
  });

  test("the old version still on PATH is a shadow, named by path", () => {
    const r = interpretProbe("glosa 0.1.0-alpha.2", "0.1.0-alpha.3", "/usr/local/bin/glosa");
    expect(r).toMatchObject({ matched: false, exitCode: 9, code: "update-unverified" });
    expect(r.message).toContain("/usr/local/bin/glosa");
    expect(r.message).toContain("0.1.0-alpha.2");
    // Bun.which cannot see shell aliases or functions by construction — say so rather than pretend.
    expect(r.hint).toContain("alias");
  });

  test("a probe that could not run is a DIFFERENT code — never claim an unobserved mismatch", () => {
    const r = interpretProbe(null, "0.1.0-alpha.3", "/usr/local/bin/glosa");
    expect(r).toMatchObject({ matched: null, exitCode: 9, code: "update-unverified-probe-failed" });
    expect(r.message).not.toContain("0.1.0-alpha.2");
    expect(r.hint).toContain("PATH");
  });

  test("unparseable output is treated as probe-failed, not as a mismatch", () => {
    expect(interpretProbe("command not found", "0.1.0-alpha.3", "/p").code).toBe("update-unverified-probe-failed");
    expect(interpretProbe("glosa not-a-version", "0.1.0-alpha.3", "/p").code).toBe("update-unverified-probe-failed");
  });
});

describe("readDaemonLockWith", () => {
  test("a lock file for a dead pid is NOT a running daemon", () => {
    expect(readDaemonLockWith(() => ({ pid: 999999, port: 4646 }) as never, () => false)).toBeNull();
  });

  test("a lock file for a live pid is a running daemon", () => {
    expect(readDaemonLockWith(() => ({ pid: 8510, port: 4646 }) as never, () => true)).toMatchObject({ pid: 8510 });
  });

  test("no lock file at all is not a running daemon", () => {
    expect(readDaemonLockWith(() => null, () => true)).toBeNull();
  });
});
