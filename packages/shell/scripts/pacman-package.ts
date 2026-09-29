// SPDX-License-Identifier: Apache-2.0
// Pure readers for a built glosa pacman package (#432): its file listing, .PKGINFO, .INSTALL and
// desktop entry, and the rules its contents must meet. Shared by linux-package-smoke.ts and the unit
// tests. Node APIs only (the shell's tsconfig typechecks this file with Node types).
import { FORBIDDEN_PACK_PATTERNS } from "../../../scripts/package-manifest.ts";

/** One entry of `bsdtar -tvf <package>`: its mode string, owner, size, and a symlink's target. */
export interface PackageEntry {
  mode: string;
  uid: string;
  gid: string;
  size: string;
  link?: string;
}

/** Parses `bsdtar -tvf` into path -> entry. Directories keep their trailing-slash-free path; the
 *  package's own metadata files (`.PKGINFO`, `.MTREE`, `.INSTALL`, `.BUILDINFO`) are included. */
export function parsePackageListing(text: string): Map<string, PackageEntry> {
  const out = new Map<string, PackageEntry>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [mode, , uid, gid, size] = parts as [string, string, string, string, string];
    const rest = parts.slice(8).join(" ");
    const arrow = mode.startsWith("l") ? rest.indexOf(" -> ") : -1;
    const path = (arrow >= 0 ? rest.slice(0, arrow) : rest).replace(/\/$/, "");
    out.set(path, { mode, uid, gid, size, ...(arrow >= 0 ? { link: rest.slice(arrow + 4) } : {}) });
  }
  return out;
}

/** The files under `prefix/` as the smoke's listing shape (relative path -> size, or `-> target`
 *  for a symlink), so a package can be compared with `treeListing` of what was staged or unpacked. */
export function listingUnder(entries: Map<string, PackageEntry>, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = `${prefix.replace(/\/$/, "")}/`;
  for (const [path, entry] of entries) {
    if (!path.startsWith(head) || entry.mode.startsWith("d")) continue;
    out.set(path.slice(head.length), entry.link !== undefined ? `-> ${entry.link}` : entry.size);
  }
  return out;
}

/** `.PKGINFO`'s `key = value` lines, each key to all its values in order. */
export function parsePkgInfo(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z]+) = (.*)$/.exec(line);
    if (!match) continue;
    out.set(match[1] as string, [...(out.get(match[1] as string) ?? []), match[2] as string]);
  }
  return out;
}

/** `.INSTALL`'s shell functions, each to the lines of its body that do something (comments, the
 *  embedded shebang and blank lines removed). glosa's are `post_install` and `post_remove`, both `:`. */
export function installFunctions(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of text.matchAll(/^([a-z_]+)\(\) \{\n([\s\S]*?)^\}/gm)) {
    const body = (match[2] as string)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    out.set(match[1] as string, body);
  }
  return out;
}

/** A desktop entry's `[Desktop Entry]` keys. */
export function parseDesktopEntry(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) out.set(match[1] as string, match[2] as string);
  }
  return out;
}

/** Every file outside /opt/glosa the package must carry, besides pacman's own metadata. */
export const PACKAGE_EXTRAS: readonly string[] = [
  "usr/bin/glosa",
  "usr/share/applications/glosa.desktop",
  "usr/share/icons/hicolor/scalable/apps/glosa.svg",
];

/** Paths that must never ship: pacman's own list of what glosa's npm file set excludes, applied to
 *  glosa's files (third-party packages under node_modules keep theirs, as the staged-tree guard
 *  already allows), plus development state and update metadata. */
export function forbiddenPackagePaths(paths: Iterable<string>): string[] {
  const glosaRoot = "opt/glosa/resources/glosa/";
  const problems: string[] = [];
  for (const path of paths) {
    const name = path.split("/").pop() ?? "";
    if (/(^|\/)\.git(\/|$)/.test(path)) problems.push(`${path}: a .git entry must not ship`);
    if (name === "app-update.yml" || name === "dev-app-update.yml")
      problems.push(`${path}: update metadata must not ship (glosa never checks for updates in the background)`);
    if (/^(\.env|\.npmrc|\.netrc|id_rsa|id_ed25519)$/.test(name))
      problems.push(`${path}: a credential file must not ship`);
    if (path.startsWith(glosaRoot)) {
      const rel = path.slice(glosaRoot.length);
      if (rel === "packages/daemon/test" || rel.startsWith("packages/daemon/test/"))
        problems.push(`${path}: the daemon's test tree would make the install a source checkout`);
      else if (!rel.startsWith("node_modules/") && FORBIDDEN_PACK_PATTERNS.some((pattern) => pattern.test(rel)))
        problems.push(`${path}: excluded from the npm file set, so it must not ship`);
    }
  }
  return problems;
}
