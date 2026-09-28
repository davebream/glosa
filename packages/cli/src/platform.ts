// SPDX-License-Identifier: Apache-2.0
/** Runtime admission shared by CLI commands and MCP startup. */
export interface PlatformDeps {
  platform: () => NodeJS.Platform;
  arch?: () => string;
  glibcVersion?: () => string | undefined;
  bunVersion?: () => string;
}

export function glibcVersion(): string | undefined {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime;
}

export function runtimeFloor(platform: NodeJS.Platform): string {
  return platform === "linux" ? "1.4.2" : "1.2.7";
}

export function platformProblem(deps: PlatformDeps, checkRuntime = true): string | undefined {
  const platform = deps.platform();
  const arch = (deps.arch ?? (() => process.arch))();
  if (platform !== "darwin" && platform !== "linux")
    return `${platform} is not supported. Use macOS or experimental Linux x86_64/glibc.`;
  if (platform === "darwin" ? !["arm64", "x64"].includes(arch) : arch !== "x64")
    return `${platform}/${arch} is not supported. Linux requires x86_64; macOS requires Apple Silicon or Intel.`;
  if (platform === "linux" && !(deps.glibcVersion ?? glibcVersion)())
    return "Linux requires glibc. Musl-based distributions are not supported.";
  const version = (deps.bunVersion ?? (() => Bun.version))();
  const floor = runtimeFloor(platform);
  if (checkRuntime && (!/^\d+\.\d+\.\d+(?:\+.*)?$/.test(version) || Bun.semver.order(version, floor) < 0))
    return `Bun ${version} is not supported on ${platform}. Install Bun ${floor} or newer.`;
}

export function browserLauncher(platform: NodeJS.Platform): string {
  return platform === "linux" ? "xdg-open" : "open";
}
