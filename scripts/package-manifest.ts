// SPDX-License-Identifier: Apache-2.0
// What the published npm tarball must and must not contain. Pure, so two consumers share one list:
// scripts/package-smoke.ts (the npm channel) and packages/shell/scripts/package-app.ts (the desktop
// app, which stages exactly the bytes npm would publish). No Bun APIs: the shell's tsconfig
// typechecks this file through package-app.ts with Node types only.

export const REQUIRED_PACK_FILES: readonly string[] = [
  "package.json",
  "packages/cli/src/main.ts",
  "packages/daemon/src/index.ts",
  "packages/providers/claude-code/src/index.ts",
  "packages/providers/codex/src/index.ts",
  "packages/providers/wispr-flow/src/index.ts",
  "packages/providers/wispr-flow/src/browser.js",
  "packages/providers/wispr-flow/src/wispr-flow-worklet.js",
  "packages/spa/src/index.ts",
  ".claude-plugin/marketplace.json",
  "glosa-plugin/.claude-plugin/plugin.json",
  "glosa-plugin/.mcp.json",
  "glosa-plugin/monitors/monitors.json",
  "glosa-plugin/skills/glosa-connect/SKILL.md",
  "glosa-plugin/bin/glosa",
  "README.md",
  "ROADMAP.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
];

export const FORBIDDEN_PACK_PATTERNS: readonly RegExp[] = [
  /(^|\/)test(s)?\//,
  /^docs\//,
  /^\.context\//,
  /^\.agents\//,
  /^\.codex\//,
  /^\.impeccable\//,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)AGENTS\.md$/,
];

/** Every problem with a tarball's file list, as sentences, in the order package-smoke has always
 *  reported them (missing files first, then leaks). An empty array is a pass. */
export function packContentProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of REQUIRED_PACK_FILES) {
    if (!files.includes(path)) problems.push(`npm tarball is missing required file: ${path}`);
  }
  const leaked = files.filter((path) => FORBIDDEN_PACK_PATTERNS.some((pattern) => pattern.test(path)));
  if (leaked.length > 0) problems.push(`npm tarball includes internal files:\n${leaked.join("\n")}`);
  return problems;
}
