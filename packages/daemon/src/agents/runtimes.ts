// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { privateDirectory } from "../chats/journal.ts";
import { fsyncContainingDir } from "../bus/io.ts";
import { managedEnvironment } from "./environment.ts";
import { ManagedAgentError, type OwnedProcess, type ProcessLauncher, type RuntimeManifest } from "./interface.ts";
import { writeOwnership } from "./ownership.ts";

// The pinned native archive can exceed 125 MiB; a foreground install must tolerate
// slower connections while retaining a finite owned-process cleanup deadline.
export const RUNTIME_INSTALL_TIMEOUT_MS = 20 * 60_000;

export interface RuntimeCandidate {
  provider: string;
  version: string;
  lockFile: string;
  packages: Record<string, string>;
  binaryPackage: string;
  binaryName: string;
  sdkPackage?: string;
  sdkVersion?: string;
  /** Release-owned qualification, never a value accepted from an API request or local manifest. */
  qualified: boolean;
}
const manifestSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string(),
    version: z.string(),
    executable: z.string(),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sdkModule: z.string().optional(),
    sdkSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    architecture: z.enum(["arm64", "x64"]),
    bun: z.string(),
    source: z.literal("https://registry.npmjs.org/"),
    installedAt: z.iso.datetime(),
  })
  .strict();

function hashFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe runtime file");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function files(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      // Bun's .bin launch aliases are not executed; the selected original binary is addressed
      // directly and verified below. No other symlinks may hide dependencies outside the tuple.
      if (root.endsWith("/node_modules/.bin")) continue;
      throw new Error("runtime contains a symbolic link");
    }
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error("runtime contains an unsupported entry");
  }
  return result.sort();
}
function treeHash(root: string): string {
  const digest = createHash("sha256");
  for (const path of files(join(root, "node_modules"))) digest.update(`${relative(root, path)}\0${hashFile(path)}\n`);
  digest.update(hashFile(join(root, "bun.lock")));
  return digest.digest("hex");
}

/** Explicit install only. Construction, status and opening history never download anything. */
export class RuntimeCatalog {
  constructor(
    private readonly root: string,
    private readonly candidates: RuntimeCandidate[],
  ) {}
  candidatesForUi() {
    return this.candidates.map(({ provider, version, sdkVersion, qualified }) => ({
      provider,
      version,
      sdkVersion,
      qualified,
    }));
  }
  identity(provider: string): string {
    return this.tuple(this.candidate(provider));
  }
  status(provider: string) {
    const candidate = this.candidate(provider),
      installed = existsSync(join(this.directory(candidate), "manifest.json"));
    return { installed, qualified: installed && candidate.qualified };
  }
  private candidate(provider: string): RuntimeCandidate {
    const candidate = this.candidates.find((item) => item.provider === provider);
    if (!candidate)
      throw new ManagedAgentError("runtime-unqualified", "No runtime candidate is configured for this agent.", 422);
    return candidate;
  }
  private tuple(candidate: RuntimeCandidate): string {
    return `${candidate.provider}-${candidate.version}-${process.arch}-${hashFile(candidate.lockFile).slice(0, 16)}`;
  }
  private directory(candidate: RuntimeCandidate): string {
    return join(this.root, "runtimes", this.tuple(candidate));
  }
  manifest(provider: string): RuntimeManifest | undefined {
    const candidate = this.candidate(provider),
      root = this.directory(candidate);
    if (!existsSync(join(root, "manifest.json"))) return undefined;
    try {
      privateDirectory(root);
      const fd = openSync(join(root, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: z.infer<typeof manifestSchema>;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error("unsafe runtime manifest");
        value = manifestSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      } finally {
        closeSync(fd);
      }
      if (value.id !== this.tuple(candidate) || hashFile(join(root, "bun.lock")) !== hashFile(candidate.lockFile))
        throw new Error("wrong dependency lock");
      if (
        value.provider !== candidate.provider ||
        value.version !== candidate.version ||
        value.architecture !== process.arch
      )
        throw new Error("wrong runtime tuple");
      for (const path of [value.executable, value.sdkModule].filter((path): path is string => !!path)) {
        if (!isAbsolute(path) || !realpathSync(path).startsWith(`${root}/`))
          throw new Error("runtime escaped its directory");
      }
      if (
        hashFile(value.executable) !== value.executableSha256 ||
        (value.sdkModule && hashFile(value.sdkModule) !== value.sdkSha256) ||
        treeHash(root) !== value.treeSha256
      )
        throw new Error("runtime was modified");
      return {
        ...value,
        qualified: candidate.qualified,
        reason: candidate.qualified
          ? undefined
          : "Installed; native compatibility and release qualification are pending.",
      };
    } catch {
      throw new ManagedAgentError(
        "runtime-unqualified",
        "The installed runtime changed or failed integrity verification. Reinstall it explicitly.",
        503,
      );
    }
  }
  async install(provider: string, launcher: ProcessLauncher): Promise<RuntimeManifest> {
    const candidate = this.candidate(provider);
    if (
      process.platform !== "darwin" ||
      !["arm64", "x64"].includes(process.arch) ||
      Bun.semver.order(Bun.version, "1.4.2") < 0
    )
      throw new ManagedAgentError("runtime-unqualified", "Managed runtimes require macOS and Bun 1.4.2 or newer.", 422);
    try {
      const installed = this.manifest(provider);
      if (installed) return installed;
    } catch {
      /* Explicit repair preserves the invalid tuple until its replacement is verified. */
    }
    const runtimeRoot = privateDirectory(join(this.root, "runtimes"));
    const staging = privateDirectory(join(runtimeRoot, `.install-${randomUUID()}`));
    const installHome = privateDirectory(join(staging, "install-home"));
    const env = managedEnvironment({
      HOME: installHome,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: OwnedProcess | undefined;
    try {
      writeFileSync(
        join(staging, "package.json"),
        JSON.stringify({ name: "glosa-managed-runtime", private: true, dependencies: candidate.packages }),
        { mode: 0o600, flag: "wx" },
      );
      writeFileSync(join(staging, "bun.lock"), readFileSync(candidate.lockFile), { mode: 0o600, flag: "wx" });
      child = await launcher.spawn({
        command: process.execPath,
        args: [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--no-progress",
          "--backend=copyfile",
          "--omit=optional",
          "--registry=https://registry.npmjs.org/",
          `--cache-dir=${join(staging, "cache")}`,
        ],
        cwd: staging,
        env,
        onData() {},
      });
      const exit = await Promise.race([
        child.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ManagedAgentError(
                  "runtime-install-timeout",
                  "The runtime download exceeded 20 minutes. Check your connection and retry; existing installations were preserved.",
                  504,
                ),
              ),
            RUNTIME_INSTALL_TIMEOUT_MS,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      await child.stop();
      if (exit.code !== 0 || !exit.groupEmpty) throw new Error("install failed");
      const binaryRoot = join(staging, "node_modules", candidate.binaryPackage);
      const binaries = files(binaryRoot).filter((path) => path.split("/").pop() === candidate.binaryName);
      if (binaries.length !== 1) throw new Error("native executable could not be uniquely selected");
      const binary = binaries[0]!;
      chmodSync(binary, 0o700);
      const sdk = candidate.sdkPackage ? join(staging, "node_modules", candidate.sdkPackage, "sdk.mjs") : undefined;
      const root = this.directory(candidate);
      const descriptor = manifestSchema.parse({
        id: this.tuple(candidate),
        provider,
        version: candidate.version,
        executable: join(root, relative(staging, binary)),
        executableSha256: hashFile(binary),
        ...(sdk ? { sdkModule: join(root, relative(staging, sdk)), sdkSha256: hashFile(sdk) } : {}),
        treeSha256: treeHash(staging),
        architecture: process.arch,
        bun: Bun.version,
        source: "https://registry.npmjs.org/",
        installedAt: new Date().toISOString(),
      });
      // No install lifecycle scripts, warm-ups, login, or inference. Version qualification is a
      // separate attended probe; installation alone never enables a provider.
      writeOwnership(join(staging, "manifest.json"), descriptor);
      rmSync(join(staging, "cache"), { recursive: true, force: true });
      rmSync(installHome, { recursive: true, force: true });
      if (existsSync(root)) {
        privateDirectory(root);
        renameSync(root, `${root}.quarantine-${randomUUID()}`);
      }
      renameSync(staging, root);
      fsyncContainingDir(root);
      return this.manifest(provider)!;
    } catch (error) {
      if (error instanceof ManagedAgentError && error.code === "runtime-install-timeout") throw error;
      throw new ManagedAgentError(
        "runtime-unqualified",
        "The runtime could not be installed or verified. Existing installations were preserved.",
        503,
      );
    } finally {
      if (timer) clearTimeout(timer);
      let stopped = true;
      try {
        await child?.stop();
      } catch {
        stopped = false;
      }
      if (stopped && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }
}
