// SPDX-License-Identifier: Apache-2.0
//
// The Homebrew cask and formula renderers and the SHA256SUMS reader behind them (#371). The cask is
// the one artifact a person installs the desktop app through, and the formula the command line
// alone, so the stanzas that decide what each touches on their machine are pinned here: the cask
// links the bundled CLI and never removes ~/.glosa; the formula pins Homebrew's Bun.
import { describe, expect, test } from "bun:test";
import {
  dmgDigests,
  dmgName,
  parseArgs,
  npmTarballUrl,
  parseSha256Sums,
  renderCask,
  renderFormula,
  sha256Hex,
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
      npmTarball: null,
      sums: null,
      tap: "davebream/homebrew-tap",
      dryRun: true,
      formula: false,
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

describe("renderFormula (#371)", () => {
  const TARBALL = "c".repeat(64);
  const formula = renderFormula(V, TARBALL);

  test("installs the npm tarball of this version on Homebrew's Bun", () => {
    expect(formula).toContain('depends_on "bun"');
    expect(formula).toContain(`url "${npmTarballUrl(V)}"`);
    expect(npmTarballUrl(V)).toBe(`https://registry.npmjs.org/@davebream/glosa/-/glosa-${V}.tgz`);
    expect(formula).toContain(`sha256 "${TARBALL}"`);
    expect(formula).toContain('system formula_opt_bin("bun")/"bun", "add", "--global", cached_download');
  });

  test("pins Homebrew's Bun in a wrapper, so the CLI runs on a bare PATH", () => {
    // Measured 2026-09-26: without the wrapper the keg's glosa died with "env: bun: No such file or
    // directory" under PATH=/usr/bin:/bin; with it, --version answered.
    expect(formula).toContain(
      '(bin/"glosa").write_env_script libexec/"bin/glosa", PATH: "#{formula_opt_bin("bun")}:$PATH"',
    );
  });

  test("carries a test block and a livecheck on the npm registry", () => {
    expect(formula).toContain("test do");
    expect(formula).toContain('assert_match version.to_s, shell_output("#{bin}/glosa --version")');
    expect(formula).toContain('url "https://registry.npmjs.org/@davebream/glosa"');
  });

  test("says to install the formula or the cask, never both", () => {
    expect(formula).toContain("Install one or the other");
    expect(renderCask(V, ARM, INTEL)).toContain("Install one or the other");
  });

  test("refuses a digest or version it could not have been given by a release", () => {
    expect(() => renderFormula(V, "short")).toThrow(/npm tarball digest/);
    expect(() => renderFormula("latest", TARBALL)).toThrow(/not a release version/);
  });

  test("carries no em dash", () => {
    expect(formula).not.toContain("\u2014");
  });

  test("hashes tarball bytes as lowercase sha256 hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseArgs: formula flags", () => {
  test("--npm-tarball takes a path and --formula selects what --dry-run prints", () => {
    const options = parseArgs(["--version", V, "--dry-run", "--formula", "--npm-tarball", "/tmp/glosa.tgz"]);
    expect(options.formula).toBe(true);
    expect(options.npmTarball).toBe("/tmp/glosa.tgz");
  });

  test("--formula without --dry-run is refused", () => {
    expect(() => parseArgs(["--version", V, "--formula"])).toThrow(/--dry-run/);
  });
});
