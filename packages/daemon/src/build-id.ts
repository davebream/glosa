// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageMetadata from "../../../package.json" with { type: "json" };

const HASH_HEX_LENGTH = 16;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const APP_VERSION = packageMetadata.version;

export interface ParsedBuildId {
  version: string;
  sourceHash: string;
}

function collectRegularFiles(directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRegularFiles(path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
}

export function runtimeSourceFiles(root = REPO_ROOT): string[] {
  const files: string[] = [];
  for (const directory of ["packages/daemon/src", "packages/cli/src", "packages/spa/src"]) {
    collectRegularFiles(join(root, directory), files);
  }

  const providersRoot = join(root, "packages/providers");
  for (const provider of readdirSync(providersRoot, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const sourceRoot = join(providersRoot, provider.name, "src");
    collectRegularFiles(sourceRoot, files);
  }

  return files.sort((left, right) => {
    const leftRelative = relative(root, left).split(sep).join("/");
    const rightRelative = relative(root, right).split(sep).join("/");
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
}

function updateFramed(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

export function computeBuildId(root = REPO_ROOT, version = APP_VERSION): string {
  if (!Bun.semver.satisfies(version, version)) {
    throw new Error(`invalid glosa package version: ${version}`);
  }

  const files = runtimeSourceFiles(root);
  if (files.length === 0) throw new Error("glosa runtime source set is empty");

  const hash = createHash("sha256");
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join("/");
    updateFramed(hash, Buffer.from(relativePath, "utf8"));
    updateFramed(hash, readFileSync(path));
  }
  return `${version}-${hash.digest("hex").slice(0, HASH_HEX_LENGTH)}`;
}

export function parseBuildId(buildId: string): ParsedBuildId | null {
  const match = /^(.*)-([0-9a-f]{16})$/.exec(buildId);
  if (!match) return null;
  const version = match[1] as string;
  if (!Bun.semver.satisfies(version, version)) return null;
  return { version, sourceHash: match[2] as string };
}

export const BUILD_ID = computeBuildId();
