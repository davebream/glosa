// SPDX-License-Identifier: Apache-2.0
// @glosa/cli: which kind of install is running, and where its recorded launcher lives.
//
// Split out of update.ts so the entrypoint (main.ts), which runs on every CLI, daemon, MCP and
// monitor start, can classify its own install without loading the self-update module. update.ts
// re-exports the classifier, so its callers and tests keep importing it from update.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = "@davebream/glosa";

/** A package-runner cache (`npx`/`bunx`/`pnpm dlx`) is never upgradeable in place. */
export function isEphemeralPackageRunnerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/_npx/") ||
    normalized.includes("/install/cache/") ||
    normalized.includes("/.pnpm/dlx/")
  );
}

export type InstallKind =
  | "bun-global"
  | "npm-global"
  | "app-bundle"
  | "homebrew"
  | "ephemeral"
  | "source-checkout"
  | "project-local"
  | "volta"
  | "pnpm"
  | "yarn"
  | "unknown";

export interface InstallClassification {
  kind: InstallKind;
  /** True only for kinds we can actually upgrade. */
  managed: boolean;
  /** bun-global: the `install/global` dir to pin via BUN_INSTALL_GLOBAL_DIR.
   *  npm-global: the `--prefix` value (NOT the lib dir). Null for refused kinds. */
  installDir: string | null;
  /** Exact copy-pasteable command for a refused kind; null when managed. */
  manualCommand: string | null;
  /** Appended to the output when the install lives behind a version-manager shim. */
  reshimHint: string | null;
}

function norm(p: string): string {
  return p.replaceAll("\\", "/");
}

/** `<anything>.app/Contents/Resources/` as a run of path segments: the desktop app's bundle
 *  (#371). `/glosa.app/` matches; a plain `/app/` directory does not. */
const APP_BUNDLE_RESOURCES = /\/[^/]+\.app\/Contents\/Resources\//;

/** `<prefix>/Cellar/glosa/<version>/...`: the keg of the `glosa` Homebrew formula (#371). */
const HOMEBREW_KEG = /\/Cellar\/glosa\/[^/]+\//;

/** True when `path` sits inside the `glosa` formula's keg, on either Homebrew prefix. */
export function isHomebrewKegPath(path: string): boolean {
  return HOMEBREW_KEG.test(norm(path));
}

/** True when `path` sits inside a macOS application bundle's resources. */
export function isAppBundlePath(path: string): boolean {
  return APP_BUNDLE_RESOURCES.test(norm(path));
}

/** The launcher the cask links and the bundled CLI records: `<Resources>/bin/glosa`, a sibling of
 *  the package root `<Resources>/glosa`. It runs the CLI on the Bun the app carries, which is why
 *  it, not `main.ts` (`#!/usr/bin/env bun`), is what the bundled CLI records. */
export function bundledLauncherPath(packageRoot: string): string {
  return join(packageRoot, "..", "bin", "glosa");
}

/** The package root of the running CLI, derived the way update.ts's `realUpdateDeps` does:
 *  this file lives at `<root>/packages/cli/src/`. */
export function currentPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** True when a recorded executable's resolved target belongs to the install at `packageRoot`:
 *  either that root's own `packages/cli/src/main.ts` or its bundled launcher. Pure; the caller
 *  supplies the realpath. */
export function targetsInstall(resolvedTarget: string, packageRoot: string): boolean {
  const target = norm(join(resolvedTarget));
  return (
    target === norm(join(packageRoot, "packages", "cli", "src", "main.ts")) ||
    target === norm(bundledLauncherPath(packageRoot))
  );
}

/** Pure over its arguments — zero filesystem access, so every branch is a table test.
 *  `hasGitMarker` is passed in (the caller does the `pathExists` check) for the same reason.
 *
 *  Takes ONE path, not two. Bun's `import.meta.url` is already symlink-resolved — measured through
 *  a module symlink AND a symlinked ancestor — so a `logical` vs `realpath` comparison could never
 *  differ and would be dead code. A `bun link`ed dev copy therefore arrives here as the checkout
 *  root itself, which carries no package-path suffix and falls through to `unknown`; the caller's
 *  `.git` probe is what promotes it to `source-checkout`. */
export function classifyInstall(packagePath: string, hasGitMarker = false): InstallClassification {
  const p = norm(packagePath);

  const refuse = (kind: InstallKind, manualCommand: string): InstallClassification => ({
    kind,
    managed: false,
    installDir: null,
    manualCommand,
    reshimHint: null,
  });

  // ORDER IS LOAD-BEARING.
  // 1. A .git marker beats everything: whatever the path looks like, we are inside a developer's
  //    own tree and must never write over it.
  if (hasGitMarker) return refuse("source-checkout", "git pull && bun install");
  // 2. App bundle BEFORE every package-manager marker (#371). The tree under
  //    `<name>.app/Contents/Resources/` belongs to the desktop app, installed and upgraded by
  //    brew; whatever it contains (a bundled node_modules can carry any suffix) is not ours to
  //    rewrite.
  if (isAppBundlePath(p)) return refuse("app-bundle", "brew upgrade --cask glosa");
  // 2b. Homebrew formula, also BEFORE the package-manager markers (#371). The formula installs the
  //     npm package with `bun add --global` into its keg, so the path ends in the bun-global suffix;
  //     writing there would put the keg out of step with what brew recorded.
  if (isHomebrewKegPath(p)) return refuse("homebrew", "brew upgrade glosa");
  // 3. Ephemeral — a package-runner cache is never upgradeable, whatever else the path resembles.
  if (isEphemeralPackageRunnerPath(p)) return refuse("ephemeral", `bun add --global ${PKG}@alpha`);
  // 4. Volta BEFORE the /lib/node_modules/ marker. Volta's layout matches it, but writing there
  //    bypasses the shim, so a naive classify would report success while `glosa --version` still
  //    printed the old version.
  if (p.includes("/.volta/")) return refuse("volta", `volta install ${PKG}`);
  // 5. pnpm / yarn — refused. Yarn Berry removed `yarn global add` entirely, and pnpm's
  //    content-addressed store is where path-pinned verification is least reliable. These run
  //    before the marker tests because import.meta.url resolves pnpm's symlink farm into the
  //    store, whose path still carries `/pnpm/`.
  if (p.includes("/pnpm/") || p.includes("/.pnpm/")) return refuse("pnpm", `pnpm add --global ${PKG}@alpha`);
  if (p.includes("/.yarn/") || p.includes("/yarn/")) return refuse("yarn", `yarn global add ${PKG}@alpha`);

  // 6. bun-global and 7. npm-global: the two kinds glosa upgrades itself.
  const bunSuffix = `/install/global/node_modules/${PKG}`;
  if (p.endsWith(bunSuffix)) {
    return {
      kind: "bun-global",
      managed: true,
      installDir: p.slice(0, p.length - `/node_modules/${PKG}`.length),
      manualCommand: null,
      reshimHint: null,
    };
  }

  const npmSuffix = `/lib/node_modules/${PKG}`;
  if (p.endsWith(npmSuffix)) {
    return {
      kind: "npm-global",
      managed: true,
      installDir: p.slice(0, p.length - npmSuffix.length),
      manualCommand: null,
      reshimHint: p.includes("/.asdf/") ? "asdf reshim nodejs" : p.includes("/mise/installs/") ? "mise reshim" : null,
    };
  }

  // 8. project-local, 9. unknown.
  if (p.includes(`/node_modules/${PKG}`)) return refuse("project-local", `bun add --global ${PKG}@alpha`);
  return refuse("unknown", `bun add --global ${PKG}@alpha`);
}
