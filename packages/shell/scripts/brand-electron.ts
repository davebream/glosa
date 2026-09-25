// SPDX-License-Identifier: Apache-2.0
// The Dock, the app switcher and the menu bar read an app's name and icon from its bundle, not
// from anything the main process says. Unpackaged, that bundle is node_modules/electron's own
// Electron.app, so a `bun run start` shows "Electron" and the atom. This rewrites that one
// bundle's name and icon to glosa's after install and re-signs it ad hoc, the way it was signed
// before. Idempotent; a missing bundle (Linux, or before install) is a no-op, not an error.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = join(here, "..");
const bundle = join(shellRoot, "node_modules", "electron", "dist", "Electron.app");
const plist = join(bundle, "Contents", "Info.plist");
const icon = join(bundle, "Contents", "Resources", "electron.icns");
const ours = join(shellRoot, "assets", "icon.icns");
const name = "glosa";

/** Sets one `<key>` string in a plist's XML. Pure over the text; the file I/O is below. */
export function withPlistString(xml: string, key: string, value: string): string {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (!re.test(xml)) {
    return xml.replace("</dict>\n</plist>", `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>`);
  }
  return xml.replace(re, `$1${value}$3`);
}

if (import.meta.main) {
  if (process.platform !== "darwin" || !existsSync(plist)) {
    console.log("brand-electron: no Electron.app to brand here; nothing to do");
    process.exit(0);
  }
  const before = readFileSync(plist, "utf8");
  let after = before;
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) after = withPlistString(after, key, name);
  const iconChanged = existsSync(ours) && readFileSync(ours).compare(readFileSync(icon)) !== 0;
  if (after === before && !iconChanged) {
    console.log("brand-electron: Electron.app already reads glosa");
    process.exit(0);
  }
  if (after !== before) writeFileSync(plist, after);
  if (iconChanged) copyFileSync(ours, icon);
  // Editing the bundle breaks its ad-hoc signature; sign it ad hoc again so macOS launches it.
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { encoding: "utf8" });
  if (sign.status !== 0) {
    console.error(`brand-electron: codesign failed: ${(sign.stderr ?? "").trim()}`);
    process.exit(1);
  }
  console.log(`brand-electron: Electron.app now reads ${name}, with glosa's icon`);
}
