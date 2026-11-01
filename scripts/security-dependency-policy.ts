// SPDX-License-Identifier: Apache-2.0
// The advisory database's <11.0.1 range also includes legacy releases without the affected
// optimizer. Never ignore the ID until both complete trees contain only reviewed package bytes.
// https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
// https://github.com/github/advisory-database/issues/10811
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CONFIG = ".context/security/osv-scanner.toml";
const ADVISORY = "GHSA-g3hv-75wg-m249";

// Obtained from each exact npm registry tarball, without executing its lifecycle scripts.
// Source digests include package.json and every JS/CJS/MJS file, sorted by relative path:
// sha256(concat(path + NUL + sha256(file bytes) + LF)). Includes both CJS and ESM entry points.
const REVIEWED: Record<string, { integrity: string; sources: string }> = {
  "3.1.5": {
    integrity: "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==",
    sources: "71df77724101ae10e2813d5c3596d0ee01ad2aaad2a0d935bacefa0d50b0d415",
  },
  "5.1.9": {
    integrity: "sha512-7o1wEA2RyMP7Iu7GNba9vc0RWWGACJOCZBJX2GJWip0ikV+wcOsgVuY9uE8CPiyQhkGFSlhuSkZPavN7u1c2Fw==",
    sources: "00f8a171dc59cc1e4e0f44d1581e6cdf801a116aac61dc025198ffe85ace7cbf",
  },
  "11.0.1": {
    integrity: "sha512-t+Vn6DX4wPCxS23y03C0uhF7S1jpi1GfqPrnlEipCJaA2ykiNbMkVlDutZtmvLfRcUN6R8AYVlzTsQrT4RZoLQ==",
    sources: "82c745e2c5b00734d548ae357998e855354150d519c0879a2abaf66da736f80c",
  },
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sourceDigest(directory: string): string {
  const files: string[] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = join(path, entry.name);
      requireCondition(!entry.isSymbolicLink(), `${file}: unexpected package source symlink`);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === "package.json" || /\.(?:c|m)?js$/.test(entry.name)) files.push(file);
    }
  }
  walk(directory);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${relative(directory, file)}\0${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

/** Include aliases, nested modules and Bun's isolated store without traversing workspace source. */
function installedCopies(modules: string): string[] {
  const copies = new Set<string>();
  const visited = new Set<string>();
  function walk(path: string): void {
    const actualModules = realpathSync(path);
    if (visited.has(actualModules)) return;
    visited.add(actualModules);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const packagePath = join(path, entry.name);
      if (entry.name === ".bun") {
        for (const stored of readdirSync(packagePath)) {
          const nested = join(packagePath, stored, "node_modules");
          if (existsSync(nested)) walk(nested);
        }
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        walk(packagePath);
        continue;
      }
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !existsSync(packagePath)) continue;
      const actual = realpathSync(packagePath);
      const manifest = join(actual, "package.json");
      if (existsSync(manifest)) {
        const identity = JSON.parse(readFileSync(manifest, "utf8"));
        if (entry.name === "minimatch")
          requireCondition(identity.name === "minimatch", `${packagePath}: installed minimatch identity changed`);
        if (identity.name === "minimatch") copies.add(actual);
      }
      // Follow dependency directories even under a linked package. Only node_modules is visited,
      // never its workspace source; the realpath set prevents cycles back to this installation.
      const nested = join(actual, "node_modules");
      if (existsSync(nested)) walk(nested);
    }
  }
  walk(modules);
  return [...copies];
}

export function verifyMinimatchPolicy(root: string): void {
  for (const directory of [".", "packages/shell"]) {
    const project = resolve(root, directory);
    const lock = Bun.JSON5.parse(readFileSync(join(project, "bun.lock"), "utf8")) as {
      packages?: Record<string, unknown>;
    };
    requireCondition(lock.packages && typeof lock.packages === "object", `${directory}: lock packages missing`);
    const locked = new Set<string>();
    for (const entry of Object.values(lock.packages)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0].startsWith("minimatch@")) continue;
      const version = entry[0].slice("minimatch@".length);
      const reviewed = REVIEWED[version];
      requireCondition(reviewed, `${directory}: unreviewed locked minimatch ${version}`);
      requireCondition(
        entry.at(-1) === reviewed.integrity,
        `${directory}: minimatch ${version} lock integrity changed`,
      );
      locked.add(version);
    }
    requireCondition(locked.size > 0, `${directory}: no locked minimatch packages`);
    const copies = installedCopies(realpathSync(join(project, "node_modules")));
    const installed = new Set<string>();
    for (const path of copies) {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      const reviewed = REVIEWED[manifest.version];
      requireCondition(reviewed, `${path}: unreviewed installed minimatch ${manifest.version}`);
      requireCondition(locked.has(manifest.version), `${path}: installed minimatch absent from lock`);
      requireCondition(sourceDigest(path) === reviewed.sources, `${path}: installed minimatch source digest mismatch`);
      installed.add(manifest.version);
    }
    requireCondition(
      [...locked].sort().join(",") === [...installed].sort().join(","),
      `${directory}: installed minimatch versions do not match lock`,
    );
  }
}

export function writeVerifiedSecurityConfig(root: string): void {
  const output = join(root, CONFIG);
  // Failure must remove the record from any earlier successful run.
  rmSync(output, { force: true });
  verifyMinimatchPolicy(root);
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(
    output,
    `# Generated only after lock integrity and all installed minimatch source bytes are verified.
[[IgnoredVulns]]
id = "${ADVISORY}"
reason = "Verified minimatch 3.1.5 and 5.1.9 lack the affected optimizationLevel/firstPhasePreProcess mechanism. All other copies are patched 11.0.1. See https://github.com/github/advisory-database/issues/10811. Any other version or changed source blocks generation; every other advisory remains blocking."
`,
  );
}

if (import.meta.main) {
  writeVerifiedSecurityConfig(resolve(import.meta.dir, ".."));
  console.log("Verified minimatch lock identities and installed source bytes in both dependency trees");
}
