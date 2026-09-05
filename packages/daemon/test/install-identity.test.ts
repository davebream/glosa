// SPDX-License-Identifier: Apache-2.0
// Install identity and the source-checkout defaults it drives (A5 §F13).
//
// The rule these enforce: a source checkout and a published install never share a home, a port, or
// a daemon. Sharing any of the three is what let two installs evict each other on every command.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { glosaHome } from "../src/lifecycle/home.ts";
import { computeInstallId, INSTALL_ID, isSourceCheckout, PACKAGE_ROOT } from "../src/lifecycle/install.ts";
import { DEFAULT_PORT, devPortFor, glosaClassFPort, glosaPort, usingDevDefaults } from "../src/lifecycle/port.ts";

const dirs: string[] = [];

function tempDir(withDaemonTests: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "glosa-install-id-"));
  dirs.push(root);
  if (withDaemonTests) mkdirSync(join(root, "packages", "daemon", "test"), { recursive: true });
  return root;
}

let savedHome: string | undefined;
let savedPort: string | undefined;
let savedClassF: string | undefined;

beforeEach(() => {
  savedHome = Bun.env.GLOSA_HOME;
  savedPort = Bun.env.GLOSA_PORT;
  savedClassF = Bun.env.GLOSA_CLASSF_PORT;
});

afterEach(() => {
  for (const [key, value] of [
    ["GLOSA_HOME", savedHome],
    ["GLOSA_PORT", savedPort],
    ["GLOSA_CLASSF_PORT", savedClassF],
  ] as const) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("install identity", () => {
  test("is deterministic per root and differs between roots", () => {
    const first = tempDir(false);
    const second = tempDir(false);
    expect(computeInstallId(first)).toBe(computeInstallId(first));
    expect(computeInstallId(first)).not.toBe(computeInstallId(second));
    expect(computeInstallId(first)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("survives a root that no longer resolves", () => {
    // A moved or deleted tree must still compare equal to itself rather than throw mid-discovery.
    const missing = join(tmpdir(), "glosa-install-id-gone-forever");
    expect(computeInstallId(missing)).toBe(computeInstallId(missing));
  });

  test("this process has one, and it is the package root's", () => {
    expect(INSTALL_ID).toBe(computeInstallId(PACKAGE_ROOT));
  });
});

describe("source-checkout detection", () => {
  test("keys on the daemon test tree, which the npm tarball never ships", () => {
    expect(isSourceCheckout(tempDir(true))).toBe(true);
    expect(isSourceCheckout(tempDir(false))).toBe(false);
  });

  test("the suite itself runs from a checkout", () => {
    expect(isSourceCheckout()).toBe(true);
  });
});

describe("dev port derivation", () => {
  test("is even, deterministic, and inside the dev range", () => {
    for (const id of [INSTALL_ID, "0000000000000000", "ffffffffffffffff", "0123456789abcdef"]) {
      const port = devPortFor(id);
      expect(port).toBe(devPortFor(id));
      expect(port % 2).toBe(0);
      expect(port).toBeGreaterThanOrEqual(60_000);
      expect(port).toBeLessThanOrEqual(65_498);
    }
  });

  test("stays clear of the test allocator's 20000-59999 block space", () => {
    // packages/daemon/test/helpers.ts reserves that range in four-port blocks with a sentinel per
    // block. A derived port inside it would hold no reservation and could be handed to a test
    // while a dev daemon owned it.
    for (const id of ["0000000000000000", "ffffffffffffffff", INSTALL_ID]) {
      const port = devPortFor(id);
      expect(port).toBeGreaterThan(59_999);
      expect(port + 1).toBeLessThanOrEqual(65_535); // class-F still a legal port
    }
  });

  test("the whole id feeds the port, not just a prefix", () => {
    // Two ids differing only in their last character must not share a port: a prefix is not a
    // property install ids are chosen to differ in.
    expect(devPortFor("0000000000000000")).not.toBe(devPortFor("0000000000000001"));
    expect(devPortFor("00000000aaaaaaaa")).not.toBe(devPortFor("00000000bbbbbbbb"));
  });

  test("a malformed id still yields a usable port rather than NaN", () => {
    const port = devPortFor("zzzzzzzzzzzzzzzz");
    expect(Number.isInteger(port)).toBe(true);
    expect(port % 2).toBe(0);
    expect(port).toBeGreaterThanOrEqual(60_000);
    expect(port).toBeLessThanOrEqual(65_498);
  });
});

describe("home and port resolution from a checkout", () => {
  test("an explicit GLOSA_HOME always wins", () => {
    Bun.env.GLOSA_HOME = "/tmp/explicit-glosa-home";
    expect(glosaHome()).toBe("/tmp/explicit-glosa-home");
  });

  test("with GLOSA_HOME unset a checkout roots OUTSIDE the working tree", () => {
    delete Bun.env.GLOSA_HOME;
    const resolved = glosaHome();
    expect(resolved).toBe(join(homedir(), ".glosa-dev", INSTALL_ID));
    // The token lives under this directory. Inside the checkout it would sit where repo-wide
    // agent reads, backups and IDE indexers all look; .gitignore stops none of those.
    expect(resolved.startsWith(PACKAGE_ROOT)).toBe(false);
    // And never the real user home, which belongs to the published install.
    expect(resolved).not.toBe(join(homedir(), ".glosa"));
  });

  test("an explicit GLOSA_PORT always wins, and class-F follows the resolved port", () => {
    Bun.env.GLOSA_PORT = "4791";
    expect(glosaPort()).toBe(4791);
    delete Bun.env.GLOSA_CLASSF_PORT;
    expect(glosaClassFPort()).toBe(4792);
    Bun.env.GLOSA_CLASSF_PORT = "5000";
    expect(glosaClassFPort()).toBe(5000);
  });

  test("with GLOSA_PORT unset a checkout never lands on the published default", () => {
    delete Bun.env.GLOSA_PORT;
    expect(glosaPort()).toBe(devPortFor(INSTALL_ID));
    expect(glosaPort()).not.toBe(DEFAULT_PORT);
  });

  test("usingDevDefaults reports only when a default is actually being applied", () => {
    delete Bun.env.GLOSA_HOME;
    delete Bun.env.GLOSA_PORT;
    expect(usingDevDefaults()).toBe(true);
    Bun.env.GLOSA_HOME = "/tmp/explicit-glosa-home";
    expect(usingDevDefaults()).toBe(true); // port still derived
    Bun.env.GLOSA_PORT = "4791";
    expect(usingDevDefaults()).toBe(false);
  });
});
