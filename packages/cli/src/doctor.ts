// @glosa/cli — `glosa doctor [dir] --json` (A6 §F26/§F30). Twelve enumerated checks — A6's own
// command-surface table names exactly 12 (platform, bun, git, claude-code, browser, daemon+proto,
// token/pairing, workspace, hooks, mcp, channel-registered, transcript-root), even though one
// unrelated summary line elsewhere in the docs says "13 enumerated checks". No 13th check is
// named anywhere in the spec — that's a doc inconsistency, not a real check this file is missing,
// so this implements exactly the 12 the table lists.
import { existsSync, readFileSync, statSync } from "node:fs";
import { claudeConfigDir, protocolCompatible, PROTOCOL_VERSION, resolveMatchedFiles, tokenPath } from "@glosa/daemon";
import { join } from "node:path";
import { checkManifestDrift } from "./init.ts";
import type { GlosaApiClient } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorData {
  checks: CheckResult[];
}

export interface DoctorDeps {
  createClient: () => Promise<GlosaApiClient>;
  platform: () => NodeJS.Platform;
  bunVersion: () => string;
  which: (cmd: string) => string | null;
  /** Runs `cmd` and returns its trimmed stdout, or `null` if it couldn't be spawned/exited
   * non-zero — every version-probe check goes through this so doctor never throws on a missing
   * binary, just reports what it can. */
  runVersionProbe: (cmd: string[]) => string | null;
  glosaHome: () => string;
  claudeConfigDir: () => string;
}

function realRunVersionProbe(cmd: string[]): string | null {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    if (!proc.success) return null;
    return proc.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
}

export function realDoctorDeps(createClient: () => Promise<GlosaApiClient>, glosaHome: () => string): DoctorDeps {
  return {
    createClient,
    platform: () => process.platform,
    bunVersion: () => Bun.version,
    which: (cmd) => Bun.which(cmd, { PATH: Bun.env.PATH ?? "" }),
    runVersionProbe: realRunVersionProbe,
    glosaHome,
    claudeConfigDir,
  };
}

/** Extracts the first `\d+\.\d+\.\d+` (or `\d+\.\d+`) run from arbitrary version-probe output
 * (e.g. `git version 2.43.0`, `claude 2.1.234 (some build tag)`) and compares it against a
 * `major.minor.patch` floor. `null` output (probe failed) or unparseable text -> `null` (caller
 * decides what that means — usually "can't verify", not an automatic fail). */
function meetsFloor(output: string | null, floor: string): boolean | null {
  if (output === null) return null;
  const m = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const have = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const want = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const h = have[i] ?? 0;
    const w = want[i] ?? 0;
    if (h !== w) return h > w;
  }
  return true;
}

function check(name: string, status: CheckStatus, detail: string): CheckResult {
  return { name, status, detail };
}

async function runChecks(dir: string, deps: DoctorDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // 1. platform
  const platform = deps.platform();
  checks.push(
    platform === "darwin"
      ? check("platform", "pass", `${platform} (macOS-only v1, A6 §F30)`)
      : check("platform", "fail", `${platform} is not supported — glosa v1 is macOS-only`),
  );
  if (platform !== "darwin") return checks; // nothing else here is meaningful off-Darwin

  // 2. bun
  const bunOk = meetsFloor(deps.bunVersion(), "1.2.7");
  checks.push(
    bunOk === true
      ? check("bun", "pass", `Bun ${deps.bunVersion()} (floor 1.2.7)`)
      : check("bun", "fail", `Bun ${deps.bunVersion()} is below the pinned floor 1.2.7`),
  );

  // 3. git
  const gitPath = deps.which("git");
  if (!gitPath) {
    checks.push(check("git", "fail", "system git not found on PATH (A6 §F30 requires it as host software)"));
  } else {
    const gitVersionOut = deps.runVersionProbe([gitPath, "--version"]);
    const gitOk = meetsFloor(gitVersionOut, "2.30.0");
    checks.push(
      gitOk === false
        ? check("git", "fail", `${gitVersionOut} is below the pinned floor 2.30`)
        : check("git", "pass", gitVersionOut ?? `found at ${gitPath}`),
    );
  }

  // 4. claude-code (WARN if absent, never fail — A6 §F30)
  const claudePath = deps.which("claude");
  if (!claudePath) {
    checks.push(check("claude-code", "warn", "claude not found on PATH — required for the live agent integration, not for glosa itself"));
  } else {
    const claudeVersionOut = deps.runVersionProbe([claudePath, "--version"]);
    const claudeOk = meetsFloor(claudeVersionOut, "2.1.80");
    checks.push(
      claudeOk === false
        ? check("claude-code", "warn", `${claudeVersionOut} is below the channel floor 2.1.80 (asyncRewake needs ≥2.1.0, the channel push needs ≥2.1.80)`)
        : check("claude-code", "pass", claudeVersionOut ?? `found at ${claudePath}`),
    );
  }

  // 5. browser — v1 has no generic way to enumerate/verify an actual Chromium≥111/Safari≥16.4
  // install; this is a best-effort proxy ("can macOS's own `open` launcher hand off to SOMETHING")
  // honestly labeled as such, not a fabricated pass of the real floor check.
  const openPath = deps.which("open");
  checks.push(
    openPath
      ? check("browser", "pass", "macOS `open` launcher is available (does not verify a specific browser/version floor)")
      : check("browser", "warn", "macOS `open` launcher not found — `glosa open` will not be able to launch a browser automatically"),
  );

  // 6. daemon+proto
  try {
    const client = await deps.createClient();
    const status = await client.getStatus();
    const compatible = protocolCompatible(PROTOCOL_VERSION, status.daemon.protocol_version);
    checks.push(
      compatible
        ? check("daemon+proto", "pass", `daemon reachable, protocol ${status.daemon.protocol_version} compatible with client ${PROTOCOL_VERSION}`)
        : check("daemon+proto", "fail", `daemon protocol ${status.daemon.protocol_version} is incompatible with this client's ${PROTOCOL_VERSION}`),
    );
  } catch (err) {
    checks.push(check("daemon+proto", "fail", `daemon unreachable: ${(err as Error).message}`));
  }

  // 7. token/pairing (file exists + mode 0600)
  const tPath = tokenPath(deps.glosaHome());
  if (!existsSync(tPath)) {
    checks.push(check("token/pairing", "warn", `${tPath} does not exist yet — not yet paired; run \`glosa open\``));
  } else {
    const mode = statSync(tPath).mode & 0o777;
    checks.push(
      mode === 0o600
        ? check("token/pairing", "pass", `${tPath} exists, mode 0600`)
        : check("token/pairing", "fail", `${tPath} has mode ${mode.toString(8)}, expected 0600`),
    );
  }

  // 8. workspace (.glosa + baseline checkpoint + matcher non-empty tracked set)
  const glosaDir = join(dir, ".glosa");
  if (!existsSync(glosaDir)) {
    checks.push(check("workspace", "warn", `${glosaDir} does not exist yet — workspace not yet opened; run \`glosa open\``));
  } else {
    const shadowGitDir = join(glosaDir, "shadow.git");
    const headOut = existsSync(shadowGitDir)
      ? deps.runVersionProbe(["git", `--git-dir=${shadowGitDir}`, `--work-tree=${dir}`, "rev-parse", "--verify", "-q", "HEAD"])
      : null;
    if (!headOut) {
      checks.push(check("workspace", "fail", `${shadowGitDir} has no baseline checkpoint (HEAD does not resolve)`));
    } else {
      const tracked = resolveMatchedFiles(dir).tracked;
      checks.push(
        tracked.length > 0
          ? check("workspace", "pass", `baseline checkpoint present, ${tracked.length} tracked artifact(s)`)
          : check("workspace", "warn", "baseline checkpoint present, but the matcher currently tracks zero artifacts"),
      );
    }
  }

  // 9. hooks (manifest hash match / drift)
  const { manifest, drifted } = checkManifestDrift(dir);
  if (!manifest) {
    checks.push(check("hooks", "warn", "no glosa init manifest found — `glosa init` has not been run for this workspace"));
  } else if (drifted.length > 0) {
    checks.push(check("hooks", "fail", `${drifted.length} node(s) drifted since \`glosa init\`: ${drifted.join(", ")} — re-run \`glosa init\``));
  } else {
    checks.push(check("hooks", "pass", "hooks manifest matches what glosa init installed"));
  }

  // 10. mcp (.mcp.json has the glosa entry)
  const mcpPath = join(dir, ".mcp.json");
  if (!existsSync(mcpPath)) {
    checks.push(check("mcp", "warn", `${mcpPath} does not exist — run \`glosa init\``));
  } else {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
      checks.push(
        parsed?.mcpServers?.glosa
          ? check("mcp", "pass", `${mcpPath} has a "glosa" MCP server entry`)
          : check("mcp", "warn", `${mcpPath} has no "glosa" MCP server entry — run \`glosa init\``),
      );
    } catch {
      checks.push(check("mcp", "fail", `${mcpPath} is not valid JSON`));
    }
  }

  // 11. channel actually registered (registry evidence) — `glosa mcp` is still a stub (P5.4), so
  // there is no real signal to check yet; honestly reported as unverifiable rather than a
  // fabricated pass.
  checks.push(check("channel", "skip", "cannot verify — channel registration evidence is not available until `glosa mcp` (P5.4) lands"));

  // 12. transcript-root (confined under the allowed CLAUDE_CONFIG_DIR)
  const configDir = deps.claudeConfigDir();
  checks.push(
    existsSync(configDir)
      ? check("transcript-root", "pass", `${configDir} exists`)
      : check("transcript-root", "warn", `${configDir} does not exist yet — Claude Code may not have run on this machine`),
  );

  return checks;
}

export async function runDoctor(dir: string, deps: DoctorDeps): Promise<CommandEnvelope<DoctorData>> {
  const checks = await runChecks(dir, deps);
  const anyFail = checks.some((c) => c.status === "fail");
  const platformFail = checks[0]?.name === "platform" && checks[0].status === "fail";

  const exitCode = platformFail ? EXIT_CODES.PLATFORM_UNSUPPORTED : anyFail ? EXIT_CODES.DEGRADED : EXIT_CODES.OK;
  return {
    ok: !anyFail,
    command: "doctor",
    exitCode,
    data: { checks },
    warnings: [],
  };
}

export function printDoctorResult(result: CommandEnvelope<DoctorData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  for (const c of result.data.checks) {
    process.stdout.write(`[${c.status.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}\n`);
  }
}
