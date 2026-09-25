// SPDX-License-Identifier: Apache-2.0
// electron-builder afterPack hook (#371): copies the staged runtime into Contents/Resources, byte for
// byte, before signing seals the bundle. Not `extraResources`: electron-builder's copy filter always
// drops a source's top-level node_modules and silently skips `.d.ts` files and a list of names, and
// the app must carry exactly the tree package-app.ts staged and verified. CommonJS because
// electron-builder requires the hook from Node.
const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const stage = join(__dirname, "..", "build", "stage");
  const parts = ["bin", "glosa", "licenses"];
  for (const part of parts) {
    if (!existsSync(join(stage, part)))
      throw new Error(`after-pack: ${join(stage, part)} is missing; run scripts/package-app.ts`);
  }
  const app = `${context.packager.appInfo.productFilename}.app`;
  const resources = join(context.appOutDir, app, "Contents", "Resources");
  for (const part of parts) cpSync(join(stage, part), join(resources, part), { recursive: true });
};
