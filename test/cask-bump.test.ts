// SPDX-License-Identifier: Apache-2.0
//
// The Homebrew cask renderer and the SHA256SUMS reader behind it (#371). The cask is the one
// artifact a person installs the desktop app through, so the stanzas that decide what it touches
// on their machine are pinned here: it links the bundled CLI, and it never removes ~/.glosa.
import { describe, expect, test } from "bun:test";
import {
  dmgDigests,
  dmgName,
  parseArgs,
  parseSha256Sums,
  renderCask,
  tapAuthEnvironment,
} from "../scripts/cask-bump.ts";

const ARM = "a".repeat(64);
const INTEL = "b".repeat(64);
const V = "0.1.0-alpha.32";

describe("parseSha256Sums", () => {
  test("reads text-mode and binary-mode lines, and skips blank lines", () => {
    const sums = parseSha256Sums(`${ARM}  ${dmgName(V, "arm64")}\n\n${INTEL.toUpperCase()} *${dmgName(V, "x64")}\n`);
    expect(sums.get(dmgName(V, "arm64"))).toBe(ARM);
    expect(sums.get(dmgName(V, "x64"))).toBe(INTEL);
  });

  test("an unreadable line is an error, never a skipped line", () => {
    expect(() => parseSha256Sums(`${ARM}  ok.dmg\nnot a digest line\n`)).toThrow(/line 2/);
  });

  test("a missing arm64 or x64 digest is a named error", () => {
    const onlyArm = parseSha256Sums(`${ARM}  ${dmgName(V, "arm64")}\n`);
    expect(() => dmgDigests(onlyArm, V)).toThrow(dmgName(V, "x64"));
    const onlyIntel = parseSha256Sums(`${INTEL}  ${dmgName(V, "x64")}\n`);
    expect(() => dmgDigests(onlyIntel, V)).toThrow(dmgName(V, "arm64"));
    const zipsOnly = parseSha256Sums(`${ARM}  glosa-${V}-arm64.zip\n${INTEL}  glosa-${V}-x64.zip\n`);
    expect(() => dmgDigests(zipsOnly, V)).toThrow(/no digest/);
  });
});

describe("renderCask", () => {
  const cask = renderCask(V, ARM, INTEL);

  test("links the CLI the app carries, so the terminal, the plugin and the app see one glosa", () => {
    expect(cask).toContain('binary "#{appdir}/glosa.app/Contents/Resources/bin/glosa"');
    expect(cask).toContain('app "glosa.app"');
  });

  test("carries both digests against the per-arch DMG the release uploads", () => {
    expect(cask).toContain(`arm:   "${ARM}"`);
    expect(cask).toContain(`intel: "${INTEL}"`);
    expect(cask).toContain(`version "${V}"`);
    expect(cask).toContain("glosa-#{version}-#{arch}.dmg");
    expect(cask).toContain('arch arm: "arm64", intel: "x64"');
  });

  test("never removes ~/.glosa: journals, history and the pairing token live there", () => {
    expect(cask).not.toContain("~/.glosa");
    expect(cask).not.toMatch(/\.glosa[/"]/);
  });

  test("updates only when asked, and only on the macOS floor glosa supports", () => {
    expect(cask).toContain("auto_updates false");
    expect(cask).toContain("depends_on macos: :ventura");
    expect(cask).toContain("strategy :github_releases");
  });

  test("carries no em dash", () => {
    expect(cask).not.toContain("\u2014");
  });

  test("refuses a digest or version it could not have been given by a release", () => {
    expect(() => renderCask(V, "short", INTEL)).toThrow(/arm64 digest/);
    expect(() => renderCask(V, ARM, "z".repeat(64))).toThrow(/x64 digest/);
    expect(() => renderCask("latest", ARM, INTEL)).toThrow(/not a release version/);
  });
});

describe("parseArgs", () => {
  test("accepts a v-prefixed version and defaults the tap", () => {
    expect(parseArgs(["--version", `v${V}`, "--dry-run"])).toEqual({
      version: V,
      notarized: false,
      sums: null,
      tap: "davebream/homebrew-tap",
      dryRun: true,
    });
  });

  test("a missing version or an unknown flag is refused", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/--version/);
    expect(() => parseArgs(["--version", V, "--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--version"])).toThrow(/needs a value/);
  });
});

test("the tap token reaches git only as a basic-auth header, never as a raw value", () => {
  const env = tapAuthEnvironment("ghp_secretvalue");
  expect(Object.values(env).some((v) => v.includes("ghp_secretvalue"))).toBe(false);
  expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  const encoded = env.GIT_CONFIG_VALUE_0?.replace("AUTHORIZATION: basic ", "") ?? "";
  expect(Buffer.from(encoded, "base64").toString()).toBe("x-access-token:ghp_secretvalue");
});

describe("quarantine caveat (#371)", () => {
  test("an ad-hoc cask tells people how to unblock the app and its command line", () => {
    const cask = renderCask(V, ARM, INTEL);
    expect(cask).toContain("xattr -dr com.apple.quarantine #{appdir}/glosa.app");
    expect(cask).toContain("Open Anyway");
  });
  test("a notarized cask carries no quarantine step", () => {
    const cask = renderCask(V, ARM, INTEL, { notarized: true });
    expect(cask).not.toContain("com.apple.quarantine");
    expect(cask).toContain("The glosa command line is linked");
  });
  test("--notarized is opt-in; the default is the ad-hoc cask", () => {
    expect(parseArgs(["--version", V]).notarized).toBe(false);
    expect(parseArgs(["--version", V, "--notarized"]).notarized).toBe(true);
  });
});
