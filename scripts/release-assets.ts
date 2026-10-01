// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gitEnvironment } from "./git-env.ts";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function command(args: string[], cwd?: string): string {
  const child = Bun.spawnSync(args, {
    cwd,
    env: { ...(args[0] === "git" ? gitEnvironment() : process.env), ANTHROPIC_API_KEY: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`${args[0]} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

export function github<T>(endpoint: string): T {
  return JSON.parse(command(["gh", "api", endpoint])) as T;
}

export function mergeChecksums(existing: string, additions: Record<string, string>): string {
  const entries = new Map<string, string>();
  const add = (name: string, digest: string) => {
    if (!/^glosa-[A-Za-z0-9._-]+\.(dmg|zip|pacman)$/.test(name) || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`Invalid checksum entry: ${name}`);
    if (entries.has(name) && entries.get(name) !== digest) throw new Error(`Conflicting checksum: ${name}`);
    entries.set(name, digest);
  };
  for (const line of existing.split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
    if (!match) throw new Error("Malformed SHA256SUMS");
    add(match[2]!, match[1]!);
  }
  for (const [name, digest] of Object.entries(additions)) add(name, digest);
  if (!entries.size) throw new Error("Empty SHA256SUMS");
  return [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}\n`)
    .join("");
}

export async function publishAssets(tag: string, files: string[], sumsPath: string, run = command): Promise<void> {
  if (!/^v[0-9][A-Za-z0-9.+-]*$/.test(tag) || !files.length)
    throw new Error("Invalid release or empty asset selection");
  const directory = mkdtempSync(join(tmpdir(), "glosa-release-assets-"));
  try {
    const release = JSON.parse(run(["gh", "release", "view", tag, "--json", "assets,isDraft"])) as {
      isDraft: boolean;
      assets: { name: string }[];
    };
    if (release.isDraft) throw new Error("Release must already be published by the maintainer's tag workflow");
    const names = new Set(release.assets.map((asset) => asset.name));
    let existing = "";
    if (names.has("SHA256SUMS")) {
      run(["gh", "release", "download", tag, "--pattern", "SHA256SUMS", "--dir", directory]);
      existing = readFileSync(join(directory, "SHA256SUMS"), "utf8");
    }
    const additions: Record<string, string> = {};
    for (const file of files) {
      const name = basename(file);
      if (Object.hasOwn(additions, name)) throw new Error(`Duplicate asset: ${name}`);
      additions[name] = sha256(readFileSync(file));
    }
    const combined = mergeChecksums(existing, additions);
    for (const name of names) {
      if (/^glosa-.*\.(dmg|zip|pacman)$/.test(name) && !combined.includes(`  ${name}\n`))
        throw new Error(`Published asset has no checksum: ${name}`);
    }
    for (const line of combined.trim().split("\n")) {
      const [digest, name] = line.split("  ") as [string, string];
      if (names.has(name)) {
        run(["gh", "release", "download", tag, "--pattern", name, "--dir", directory]);
        if (sha256(readFileSync(join(directory, name))) !== digest)
          throw new Error(`Published asset mismatch: ${name}`);
      } else if (!Object.hasOwn(additions, name)) throw new Error(`Checksum names a missing release asset: ${name}`);
    }
    for (const file of files) {
      if (!names.has(basename(file))) run(["gh", "release", "upload", tag, file]);
    }
    writeFileSync(sumsPath, combined);
    run(["gh", "release", "upload", tag, sumsPath, "--clobber"]);
    for (const file of files) {
      const name = basename(file);
      run(["gh", "release", "download", tag, "--pattern", name, "--dir", directory, "--clobber"]);
      if (sha256(readFileSync(join(directory, name))) !== additions[name])
        throw new Error(`Downloaded asset mismatch: ${name}`);
    }
    run(["gh", "release", "download", tag, "--pattern", "SHA256SUMS", "--dir", directory, "--clobber"]);
    if (readFileSync(join(directory, "SHA256SUMS"), "utf8") !== combined)
      throw new Error("Published checksums changed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tag, sumsPath, ...files] = process.argv.slice(2);
  if (!tag || !sumsPath) throw new Error("Usage: release-assets.ts <tag> <SHA256SUMS path> <assets...>");
  await publishAssets(tag, files, sumsPath);
}
