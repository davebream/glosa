// SPDX-License-Identifier: Apache-2.0
// electron-builder afterPack hook (#371, #432): copies the staged runtime into the app's resources,
// byte for byte, before signing seals the bundle. Not `extraResources`: electron-builder's copy
// filter always drops a source's top-level node_modules and silently skips `.d.ts` files and a list
// of names, and the app must carry exactly the tree package-app.ts staged and verified. CommonJS
// because electron-builder requires the hook from Node.
//
// macOS: Contents/Resources inside the .app. Linux (the pacman package): <appOutDir>/resources, which
// installs as /opt/glosa/resources; it also gets the package-type marker the CLI classifies itself
// by, and chrome-sandbox becomes mode 4755 (the package owns it as root), so the SUID sandbox works
// on kernels without unprivileged user namespaces and survives every upgrade without a script.
const { chmodSync, cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/** The staged parts copied into resources on each platform. */
function partsFor(platform) {
  return platform === "linux" ? ["bin", "glosa", "licenses", "package-type"] : ["bin", "glosa", "licenses"];
}

/** Where the resources go for this build. macOS keeps the exact expression it always used. */
function resourcesDirFor(context) {
  if (context.electronPlatformName === "linux") return context.packager.getResourcesDir(context.appOutDir);
  const app = `${context.packager.appInfo.productFilename}.app`;
  return join(context.appOutDir, app, "Contents", "Resources");
}

function copyStage(stage, resources, parts) {
  for (const part of parts) {
    if (!existsSync(join(stage, part)))
      throw new Error(`after-pack: ${join(stage, part)} is missing; run scripts/package-app.ts`);
  }
  for (const part of parts) cpSync(join(stage, part), join(resources, part), { recursive: true });
}

/** Linux: chrome-sandbox root-owned (fpm packages every file as root) with the setuid bit. */
function sealSandbox(appOutDir) {
  chmodSync(join(appOutDir, "chrome-sandbox"), 0o4755);
}

exports.partsFor = partsFor;
exports.resourcesDirFor = resourcesDirFor;
exports.copyStage = copyStage;
exports.sealSandbox = sealSandbox;

exports.default = async function afterPack(context) {
  const stage = join(__dirname, "..", "build", "stage");
  copyStage(stage, resourcesDirFor(context), partsFor(context.electronPlatformName));
  if (context.electronPlatformName === "linux") sealSandbox(context.appOutDir);
};
