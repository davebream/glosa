// SPDX-License-Identifier: Apache-2.0
//
// The shipped Claude Code plugin, checked against the documented manifest contracts.
//
// #305: `monitors/monitors.json` wrapped its entries in an object. Claude Code requires a bare
// array, so the plugin installed, failed to load, and its session monitor never started — margin
// notes were never delivered and nothing said so, because the MCP tools still registered.
//
// `claude plugin validate` does not catch this, and neither does `--strict`: both read only
// `plugin.json` and never parse the other manifests. So these assertions, not the vendor
// validator, are what stands between the repository and shipping an unloadable plugin.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitEnvironment } from "../scripts/git-env.ts";

const root = resolve(import.meta.dir, "..");
const plugin = join(root, "glosa-plugin");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(plugin, relative), "utf8"));
}

describe("the shipped Claude Code plugin", () => {
  test("monitors.json is a bare array, not an object (#305)", () => {
    const monitors = readJson("monitors/monitors.json");
    // The regression pin. An object here loads as nothing and reports `failed to load`.
    expect(Array.isArray(monitors)).toBe(true);
    expect((monitors as unknown[]).length).toBeGreaterThan(0);
  });

  test("every monitor entry carries the required fields with a unique name", () => {
    const monitors = readJson("monitors/monitors.json") as Array<Record<string, unknown>>;
    for (const entry of monitors) {
      for (const field of ["name", "command", "description"]) {
        expect(typeof entry[field], `${String(entry.name)}.${field}`).toBe("string");
        expect((entry[field] as string).length, `${String(entry.name)}.${field}`).toBeGreaterThan(0);
      }
    }
    const names = monitors.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a monitor's `when` is a documented trigger naming a skill this plugin ships", () => {
    const monitors = readJson("monitors/monitors.json") as Array<Record<string, unknown>>;
    const skills = readdirSync(join(plugin, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const entry of monitors) {
      if (entry.when === undefined) continue;
      const when = entry.when as string;
      if (when === "always") continue;
      const skill = when.match(/^on-skill-invoke:(.+)$/)?.[1];
      expect(skill, `${String(entry.name)}.when is not a documented trigger: ${when}`).toBeDefined();
      expect(skills, `${String(entry.name)}.when names a skill this plugin does not ship`).toContain(skill!);
    }
  });

  test("plugin.json points at a skills directory that actually holds skills", () => {
    const manifest = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
    expect(manifest.name).toBe("glosa");
    const skillsDir = join(plugin, manifest.skills as string);
    expect(existsSync(skillsDir)).toBe(true);
    const found = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(skillsDir, entry.name, "SKILL.md")));
    expect(found.length).toBeGreaterThan(0);
  });

  test(".mcp.json launches an executable that ships with the plugin", () => {
    const mcp = readJson(".mcp.json") as { mcpServers: Record<string, { command: string }> };
    const command = mcp.mcpServers.glosa?.command;
    expect(command).toBeDefined();
    const launcher = command!.replace("${CLAUDE_PLUGIN_ROOT}", plugin);
    expect(existsSync(launcher), launcher).toBe(true);
    // Claude Code execs this path directly; a lost mode bit makes the server silently unstartable.
    expect(statSync(launcher).mode & 0o111, "launcher is not executable").toBeGreaterThan(0);
  });

  test("the monitor command invokes the same launcher the MCP server uses", () => {
    const monitors = readJson("monitors/monitors.json") as Array<{ command: string }>;
    for (const entry of monitors) expect(entry.command).toContain('"${CLAUDE_PLUGIN_ROOT}"/bin/glosa');
  });
});

// #311: the plugin's content changed without a version bump, and nothing checked.
//
// `/plugin marketplace add davebream/glosa` installs the plugin straight from this repository, and
// Claude Code only offers an update when `plugin.json`'s version string changes. So plugin content
// that lands on main under an unchanged version reaches nobody who already installed: #254 added
// eleven lines to `skills/glosa-connect/SKILL.md` and anyone who installed before it still has the
// older text.
//
// The version is the root package version (see scripts/version-sync.ts), so satisfying this check
// means the change rides a release. Plugin content has changed twice in the project's life, so that
// is a rare cost against permanently stranding installed users.
describe("plugin content cannot change without the version changing (#311)", () => {
  const git = (args: string[]): { ok: boolean; out: string } => {
    const child = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: root,
      // #316: `root` decides the repository, so the ambient selectors a hook exports must not.
      env: gitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: child.exitCode === 0, out: child.stdout.toString().trim() };
  };

  test("a change under glosa-plugin/ is accompanied by a different plugin version", () => {
    const base = git(["merge-base", "origin/main", "HEAD"]);
    if (!base.ok) {
      // Never silently pass on CI, where the base always exists (both workflows use fetch-depth: 0).
      if (process.env.GITHUB_ACTIONS) throw new Error("origin/main is unreachable; this check cannot run blind");
      console.warn("SKIPPED: origin/main is not available in this checkout, so plugin drift was not compared.");
      return;
    }

    const changed = git(["diff", "--name-only", base.out, "HEAD", "--", "glosa-plugin/"]);
    expect(changed.ok).toBe(true);
    if (changed.out === "") return; // the plugin is untouched on this branch

    const manifest = "glosa-plugin/.claude-plugin/plugin.json";
    const before = git(["show", `${base.out}:${manifest}`]);
    if (!before.ok) return; // the plugin did not exist at the base

    const versionOf = (text: string) => (JSON.parse(text) as { version?: string }).version;
    const baseVersion = versionOf(before.out);
    const headVersion = versionOf(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));

    expect(
      headVersion,
      `glosa-plugin/ changed (${changed.out.split("\n").join(", ")}) but plugin.json still says ${baseVersion}. ` +
        "Claude Code would not offer this to anyone who already installed the plugin. " +
        "Bump the root package version so the change rides a release.",
    ).not.toBe(baseVersion);
  });
});
