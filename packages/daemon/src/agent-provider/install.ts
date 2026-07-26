// SPDX-License-Identifier: Apache-2.0
// Generic, declarative onboarding boundary for agent providers (A6 §F26).

export type InitScope = "workspace" | "user";
export type ProviderId = "claude-code" | "codex";

export interface InstallBin {
  command: string;
  args: string[];
}

export interface InstallRoots {
  workspace: string;
  home: string;
  glosaHome: string;
}

export interface DesiredInstallHook {
  event: string;
  matcher?: string;
  role: string;
  command: string;
  timeout?: number;
  asyncRewake?: boolean;
}

export type ProviderInstallTarget =
  | { key: string; kind: "hooks-json"; path: string; hooks: DesiredInstallHook[] }
  | { key: string; kind: "mcp-json"; path: string }
  | {
      key: string;
      kind: "mcp-toml";
      path: string;
      startMarker: string;
      endMarker: string;
    };

export interface ProviderDetectionDeps {
  exists(path: string): boolean;
  which(executable: string): string | null;
}

export interface ProviderInstallDescriptor {
  id: ProviderId;
  displayName: string;
  supportedScopes: readonly InitScope[];
  detect(roots: InstallRoots, deps: ProviderDetectionDeps): boolean;
  targets(scope: InitScope, roots: InstallRoots, bin: InstallBin): ProviderInstallTarget[];
  activationHelp: readonly string[];
}
