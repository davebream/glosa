// SPDX-License-Identifier: Apache-2.0
// A6 §F26 — the v1→v2 ownership-manifest upgrade path, pinned against a FROZEN fixture.
//
// WHY this file exists separately from init.test.ts: A6 §F26 says "a legacy
// `<ws>/.claude/.glosa-init.json` is read and atomically migrated on the first scoped
// init/uninstall". Users have v1 manifests on disk right now, so the ability to READ one is a
// compatibility guarantee that outlives the now-removed v1 writer.
//
// The broader transaction suite also checks migration mechanics, but derives its fixture from a
// current scoped manifest. Every byte below is instead a hand-written literal captured from what
// v1 actually wrote, not a value re-derived from today's code: if the migration or reader drifts,
// these fixtures do not drift with it. That independence is the safety net that allowed the v1
// writer to be removed.
//
// The fixture is deliberately the FULL v1 shape — both providers, all four target files, including
// the optional `codex_hooks`/`codex_config` records — because `migrateLegacy` branches on those
// two being present and the narrow claude-only fixture would leave that branch unproven.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeInitManifest } from "../../daemon/src/init-probe.ts";
import {
  checkScopedManifestDrift,
  runScopedInit,
  runScopedUninstall,
  scopedManifestPaths,
} from "../src/scoped-init.ts";
import { tempGlosaHome, useTempHome } from "./home.ts";

useTempHome();

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-legacy-upgrade-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const LEGACY_BIN = { command: "glosa", args: [] as string[], mode: "path" as const };

/** Byte-for-byte what `glosa init` v1 wrote into `.claude/settings.json`. */
const LEGACY_SETTINGS = `{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook session-start",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "glosa hook rewake-watch",
            "asyncRewake": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook session-end",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook user-prompt-submit",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook stop",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook notification",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
`;

const LEGACY_MCP = `{
  "mcpServers": {
    "glosa": {
      "type": "stdio",
      "command": "glosa",
      "args": [
        "mcp"
      ]
    }
  }
}
`;

const LEGACY_CODEX_HOOKS = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook session-start --provider codex",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook session-end --provider codex",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook user-prompt-submit --provider codex",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "glosa hook stop --provider codex",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
`;

const LEGACY_CODEX_CONFIG = `# glosa:begin mcp_servers.glosa
[mcp_servers.glosa]
command = "glosa"
args = ["mcp"]
# glosa:end mcp_servers.glosa
`;

/** The frozen sha256s v1 recorded. Hardcoded rather than recomputed: recomputing them from the
 * fixture with today's `sha256Of` would make the drift assertions tautological — the test would
 * still pass if BOTH the hash function and the migration changed together. */
const LEGACY_SETTINGS_NODES = [
  {
    pointer: "/hooks/SessionStart/0/hooks/0",
    sha256: "53a245ee9f471ee642d5f022ebfae20e118317c3a62d2d7ee012854fe6f39b33",
  },
  {
    pointer: "/hooks/SessionStart/0/hooks/1",
    sha256: "f823928f8471aca12af74842319262f8084cb4146b31075c5a71200a14abfbeb",
  },
  {
    pointer: "/hooks/SessionEnd/0/hooks/0",
    sha256: "9cebb7559519f403a9c7328d36b2458ade1f67f17a4463723c7785c2b3984d13",
  },
  {
    pointer: "/hooks/UserPromptSubmit/0/hooks/0",
    sha256: "29f90b2754754ad1c1206f21f5e9a4b5dbe56266acf869c6befb747b0da077ea",
  },
  { pointer: "/hooks/Stop/0/hooks/0", sha256: "6006244dc302c9081ba9c301bf7f15e904a9e9313bfa1062324894074f987898" },
  {
    pointer: "/hooks/Notification/0/hooks/0",
    sha256: "cceb56fa862da3c12235b43b6e6182eac1e2426567493f7a3591ed09f9fe5de4",
  },
];
const LEGACY_MCP_NODES = [
  { pointer: "/mcpServers/glosa", sha256: "79d027f369e8ffd6d076812e48e94841b723cc8af08037a9cd36942b1814462f" },
];
const LEGACY_CODEX_HOOK_NODES = [
  {
    pointer: "/hooks/SessionStart/0/hooks/0",
    sha256: "fe163ac9e10ad3496558cb92e22758acd61bb33d51029accf8fda156ba3cb5c6",
  },
  {
    pointer: "/hooks/SessionEnd/0/hooks/0",
    sha256: "dc4c50143f910f2b97d709a0bdf4fac4c60652a18d3be966892217ddd1c9d80a",
  },
  {
    pointer: "/hooks/UserPromptSubmit/0/hooks/0",
    sha256: "6f48cb5b68aaee875a4930e4cdbf43a649545198d68601fae59108ecf859cd93",
  },
  { pointer: "/hooks/Stop/0/hooks/0", sha256: "43e3d07a6826382e04590aac20f8a553e4592be629c976a0803bdfe75eba8408" },
];
const LEGACY_CODEX_CONFIG_SHA = "d7046b2f3ec81a57f2d5fb1852da2253fdad87f1bb9e2d21ce48dfef0b1c4a40";

/** Materialize a workspace exactly as `glosa init` v1 left it: the four target files plus the
 * `.claude/.glosa-init.json` ownership record, and NOTHING under `.glosa/`. */
function writeLegacyWorkspace(dir: string): string {
  const settingsPath = join(dir, ".claude", "settings.json");
  const mcpPath = join(dir, ".mcp.json");
  const codexHooksPath = join(dir, ".codex", "hooks.json");
  const codexConfigPath = join(dir, ".codex", "config.toml");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(settingsPath, LEGACY_SETTINGS);
  writeFileSync(mcpPath, LEGACY_MCP);
  writeFileSync(codexHooksPath, LEGACY_CODEX_HOOKS);
  writeFileSync(codexConfigPath, LEGACY_CODEX_CONFIG);

  const legacyPath = join(dir, ".claude", ".glosa-init.json");
  writeFileSync(
    legacyPath,
    `${JSON.stringify(
      {
        version: 1,
        glosa_bin: LEGACY_BIN,
        files: {
          settings: { path: settingsPath, created: true, backup: null, inserted: LEGACY_SETTINGS_NODES },
          mcp: { path: mcpPath, created: true, backup: null, inserted: LEGACY_MCP_NODES },
          codex_hooks: { path: codexHooksPath, created: true, backup: null, inserted: LEGACY_CODEX_HOOK_NODES },
          codex_config: { path: codexConfigPath, created: true, backup: null, sha256: LEGACY_CODEX_CONFIG_SHA },
        },
      },
      null,
      2,
    )}\n`,
  );
  return legacyPath;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("legacy v1 init manifest — readable without the v1 writer", () => {
  test("the frozen v1 fixture reads as a fully-wired workspace with zero drift", () => {
    const dir = freshDir();
    writeLegacyWorkspace(dir);

    const { manifest, manifests, drifted } = checkScopedManifestDrift(dir, { glosaHomeDir: tempGlosaHome() });

    expect(drifted).toEqual([]);
    expect(manifests).toHaveLength(1);
    // Read through the v2 lens: `migrateLegacy` re-keys v1's flat `files` map onto the provider map.
    expect(manifest?.version).toBe(2);
    expect(manifest?.glosa_bin).toEqual(LEGACY_BIN);
    expect(Object.keys(manifest?.providers ?? {}).sort()).toEqual(["claude-code", "codex"]);
    expect(manifest?.providers["claude-code"]?.files.hooks?.kind).toBe("json");
    expect(manifest?.providers.codex?.files.mcp?.kind).toBe("text");
  });

  test("a hand-edited hook in a v1 workspace is reported as drift, not silently accepted", () => {
    const dir = freshDir();
    writeLegacyWorkspace(dir);
    const settingsPath = join(dir, ".claude", "settings.json");
    const settings = readJson(settingsPath);
    settings.hooks.Stop[0].hooks[0].timeout = 999;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const { drifted } = checkScopedManifestDrift(dir, { glosaHomeDir: tempGlosaHome() });

    expect(drifted).toEqual([`${settingsPath}/hooks/Stop/0/hooks/0`]);
  });

  test("a hand-edited Codex TOML block in a v1 workspace is reported as drift", () => {
    const dir = freshDir();
    writeLegacyWorkspace(dir);
    const codexConfigPath = join(dir, ".codex", "config.toml");
    writeFileSync(codexConfigPath, LEGACY_CODEX_CONFIG.replace('command = "glosa"', 'command = "tampered"'));

    const { drifted } = checkScopedManifestDrift(dir, { glosaHomeDir: tempGlosaHome() });

    expect(drifted).toEqual([`${codexConfigPath}[mcp_servers.glosa]`]);
  });

  test("`glosa init` upgrades a v1 workspace in place, carrying every recorded node across", async () => {
    const dir = freshDir();
    const legacyPath = writeLegacyWorkspace(dir);

    const result = await runScopedInit({
      dir,
      agents: ["claude-code", "codex"],
      glosaHomeDir: tempGlosaHome(),
      resolveGlosaBin: () => LEGACY_BIN,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(legacyPath)).toBe(false); // atomically migrated away (A6 §F26)

    const manifest = readJson(scopedManifestPaths(dir, { glosaHomeDir: tempGlosaHome() }).workspace);
    expect(manifest.version).toBe(2);
    expect(manifest.scope).toBe("workspace");
    expect(Object.keys(manifest.providers).sort()).toEqual(["claude-code", "codex"]);

    // The ownership RECORDS survive, not merely the provider keys — an upgrade that dropped these
    // would leave a workspace that `glosa init --uninstall` could no longer clean up, and doctor
    // could no longer verify. This is the assertion the old migration test never made.
    expect(manifest.providers["claude-code"].files.hooks.inserted).toEqual(LEGACY_SETTINGS_NODES);
    expect(manifest.providers["claude-code"].files.mcp.inserted).toEqual(LEGACY_MCP_NODES);
    expect(manifest.providers.codex.files.hooks.inserted).toEqual(LEGACY_CODEX_HOOK_NODES);
    expect(manifest.providers.codex.files.mcp.sha256).toBe(LEGACY_CODEX_CONFIG_SHA);
    // `created: true` is what tells uninstall it may delete the file outright rather than prune it.
    expect(manifest.providers["claude-code"].files.hooks.created).toBe(true);
    expect(manifest.providers.codex.files.mcp.created).toBe(true);

    // The workspace's own config is untouched by a migration that had nothing to change.
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe(LEGACY_SETTINGS);
    expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toBe(LEGACY_CODEX_CONFIG);
  });

  // The same A6 §F26 "created:true file now empty→delete" clause the scoped block of init.test.ts
  // pins, reached through a v1 manifest instead: the migrated ownership records must still carry
  // enough to empty and delete every file v1 created, hook-group scaffolding included. Not
  // migration-specific — a pure v2 install uninstalls through the same prune — but a v1 workspace
  // is the case with no v2 install run to repair a lossy migration.
  test("`glosa init --uninstall` cleans up a v1 workspace that was never upgraded first", async () => {
    const dir = freshDir();
    const legacyPath = writeLegacyWorkspace(dir);

    const result = await runScopedUninstall({
      dir,
      agents: ["claude-code", "codex"],
      glosaHomeDir: tempGlosaHome(),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // Every file v1 recorded as `created: true` ends up empty and is therefore deleted outright.
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });

  test("the daemon's read-only probe still reports a v1 workspace as wired", () => {
    const dir = freshDir();
    writeLegacyWorkspace(dir);

    // The SPA's wiring badge goes through this probe, not through the CLI's reader — a v1 user
    // whose probe stopped recognizing `.claude/.glosa-init.json` would see "not initialized" on a
    // workspace that is in fact fully wired (the issue #96 failure mode, one layer down).
    expect(probeInitManifest(dir)).toEqual({ manifest_present: true, manifest_invalid: false });
  });
});
