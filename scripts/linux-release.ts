// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { claudeRuntimeCandidate } from "../packages/providers/claude-code/src/runtime.ts";
import { codexRuntimeCandidate } from "../packages/providers/codex/src/runtime.ts";
import { DECLARED_STAGES } from "../packages/shell/scripts/linux-package-smoke.ts";
import { command, github, publishAssets, sha256 } from "./release-assets.ts";
import { checkedFiles } from "./test-plan.ts";
import { inspectReport } from "./test-runner.ts";

export const DESKTOP_CHECKS = [
  "clean-install",
  "menu-icons",
  "folder-picker",
  "cold-link-confirmation",
  "warm-link",
  "dolphin-reveal",
  "notifications",
  "cli-mcp",
  "review-feedback",
  "edit-save-history",
  "external-edit-reconnect",
  "sandbox-seccomp",
  "host-origin-pairing",
  "path-confinement-egress",
  "close-reopen",
  "daemon-crash-cleanup",
  "upgrade-remove-reinstall",
  "secure-store",
  "microphone-permissions",
  "dictation-four-composers",
] as const;
export const NATIVE_GATES = [
  "offering",
  "claude-isolation-refresh-expiry",
  "codex-isolation-refresh-expiry",
  "claude-native-behavior",
  "codex-native-behavior",
  "claude-process-cleanup",
  "codex-process-cleanup",
  "installed-app-g4",
  "t8-signoff",
  "wispr-live-consent",
] as const;
const LOCKS = [
  "bun.lock",
  "packages/shell/bun.lock",
  "packages/providers/claude-code/src/runtime-locks/linux-x64.lock",
  "packages/providers/codex/src/runtime-locks/linux-x64.lock",
];

export type Candidate = {
  schema: 1;
  version: string;
  commit: string;
  runId: string;
  runAttempt: string;
  artifactName: string;
  package: { name: string; sha256: string };
  runtimes: { bun: string; electron: string; claude: string; sdk: string; codex: string };
  locks: Record<string, string>;
};
type Observation = { result: "pass"; evidence: string };
export type Qualification = {
  schema: 1;
  candidate: Candidate;
  candidateArtifactId: string;
  maintainer: string;
  approvedAt: string;
  report: string;
  environment: Record<string, string>;
  sessions: Record<"wayland" | "x11", Record<string, Observation>>;
  gates: Record<string, Observation>;
};
export type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  conclusion: string;
  repository: { full_name: string };
};
export type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  expires_at: string;
  workflow_run: { id: number; head_sha: string };
};

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
}

export function validateJobs(results: Record<string, { result: string }>, jobs: string[]): void {
  for (const job of jobs)
    if (results[job]?.result !== "success") throw new Error(`Required job did not succeed: ${job}`);
}

export function validateSmoke(
  report: { results: { stage: string; ok: boolean }[]; unrun: string[]; emulated: boolean; packageSha256: string },
  digest: string,
): void {
  if (report.packageSha256 !== digest) throw new Error("Pacman smoke belongs to different package bytes");
  if (
    report.emulated !== false ||
    !Array.isArray(report.results) ||
    !Array.isArray(report.unrun) ||
    report.unrun.length
  )
    throw new Error("Missing native pacman execution evidence");
  if (
    report.results.length !== DECLARED_STAGES.length ||
    new Set(report.results.map((row) => row.stage)).size !== DECLARED_STAGES.length
  )
    throw new Error("Incomplete pacman stage inventory");
  for (const stage of DECLARED_STAGES)
    if (!report.results.some((row) => row.stage === stage && row.ok === true))
      throw new Error(`Failed pacman stage: ${stage}`);
}

export function validateCandidate(candidate: Candidate, bytes: Uint8Array): void {
  if (
    candidate.schema !== 1 ||
    !/^[0-9][A-Za-z0-9.+-]*$/.test(candidate.version) ||
    !/^[a-f0-9]{40}$/.test(candidate.commit)
  )
    throw new Error("Invalid candidate identity");
  if (!/^[1-9][0-9]*$/.test(candidate.runId) || !/^[1-9][0-9]*$/.test(candidate.runAttempt))
    throw new Error("Invalid candidate run");
  if (
    candidate.artifactName !== `linux-candidate-${candidate.commit}-${candidate.runAttempt}` ||
    candidate.package.name !== `glosa-${candidate.version}-x64.pacman`
  )
    throw new Error("Invalid candidate artifact name");
  if (candidate.package.sha256 !== sha256(bytes)) throw new Error("Candidate package checksum mismatch");
  for (const key of ["bun", "electron", "claude", "sdk", "codex"] as const)
    requireText(candidate.runtimes[key], `runtime ${key}`);
  if (Object.keys(candidate.locks).length !== LOCKS.length) throw new Error("Invalid lock inventory");
  for (const lock of LOCKS)
    if (!/^[a-f0-9]{64}$/.test(candidate.locks[lock] ?? "")) throw new Error(`Missing lock digest: ${lock}`);
}

export function validateProvenance(
  candidate: Candidate,
  run: Run,
  artifact: Artifact,
  repository: string,
  tagCommit: string,
): void {
  if (
    run.repository.full_name !== repository ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/release.yml" ||
    run.head_branch !== "main" ||
    run.conclusion !== "success"
  )
    throw new Error("Candidate must come from a successful trusted main release workflow");
  if (
    String(run.id) !== candidate.runId ||
    String(run.run_attempt) !== candidate.runAttempt ||
    run.head_sha !== candidate.commit ||
    tagCommit !== candidate.commit
  )
    throw new Error("Candidate run/tag commit mismatch");
  if (
    artifact.name !== candidate.artifactName ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.head_sha !== candidate.commit ||
    artifact.expired ||
    !(Date.parse(artifact.expires_at) > Date.now())
  )
    throw new Error("Candidate artifact provenance or expiry mismatch");
}

export function validateQualification(candidate: Candidate, artifactId: string, record: Qualification): void {
  if (
    record.schema !== 1 ||
    record.candidateArtifactId !== artifactId ||
    !isDeepStrictEqual(record.candidate, candidate)
  )
    throw new Error("Qualification belongs to different candidate bytes or identity");
  requireText(record.maintainer, "maintainer signature");
  if (!/^docs\/compatibility\/[a-z0-9.-]+\.md$/.test(record.report)) throw new Error("Missing sanitized report path");
  if (!Number.isFinite(Date.parse(record.approvedAt)) || Date.parse(record.approvedAt) > Date.now())
    throw new Error("Invalid approval date");
  for (const field of ["osSnapshot", "kernel", "desktop", "libc", "git", "secureStore", "microphone"])
    requireText(record.environment[field], `environment ${field}`);
  const check = (row: Observation | undefined, name: string) => {
    if (row?.result !== "pass") throw new Error(`Qualification hold: ${name}`);
    requireText(row.evidence, `evidence for ${name}`);
  };
  for (const session of ["wayland", "x11"] as const)
    for (const name of DESKTOP_CHECKS) check(record.sessions[session]?.[name], `${session}/${name}`);
  for (const name of NATIVE_GATES) check(record.gates[name], name);
}

export function validateEvidence(directory: string, commit: string, bun: string): void {
  const receipts: Array<{ profile: string; platform: string; identities: string[] }> = [];
  for (const file of new Bun.Glob("**/*.json").scanSync({ cwd: directory, absolute: true })) {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!Object.hasOwn(record, "profile")) continue;
    if (record.commit !== commit || record.bun !== bun || record.exitCode !== 0 || record.childExitCode !== 0)
      throw new Error(`Invalid test receipt: ${basename(file)}`);
    if (record.platform === "linux" && record.arch !== "x64") throw new Error("Linux evidence must execute on x86_64");
    const selected = checkedFiles(record.profile);
    if (JSON.stringify(record.files) !== JSON.stringify(selected)) throw new Error("Receipt selection mismatch");
    const report = inspectReport(readFileSync(file.replace(/\.json$/, ".xml"), "utf8"), selected);
    if (report.failures || report.skipped) throw new Error("Failed or skipped candidate tests");
    receipts.push({ profile: record.profile, platform: record.platform, identities: report.identities });
  }
  for (const [platform, profiles] of [
    ["darwin", ["ci-1", "ci-2", "ci-3", "full", "shell", "stability"]],
    ["linux", ["linux-acceptance", "shell"]],
  ] as const) {
    for (const profile of profiles) {
      const rows = receipts.filter((row) => row.platform === platform && row.profile === profile);
      if (rows.length !== (profile === "stability" ? 2 : 1))
        throw new Error(`Missing or duplicate evidence: ${platform}/${profile}`);
      if (rows.some((row) => JSON.stringify(row.identities) !== JSON.stringify(rows[0]!.identities)))
        throw new Error("Stability identities changed");
    }
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function downloadArtifact(repository: string, artifactId: string, directory: string): void {
  const temporary = mkdtempSync(join(tmpdir(), "glosa-candidate-download-"));
  try {
    const result = Bun.spawnSync(["gh", "api", `repos/${repository}/actions/artifacts/${artifactId}/zip`], {
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`Artifact download failed: ${result.stderr.toString()}`);
    const archive = join(temporary, "candidate.zip");
    writeFileSync(archive, result.stdout);
    const files = command(["unzip", "-Z1", archive]).split("\n");
    if (
      !files.length ||
      files.some((name) => name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
    )
      throw new Error("Unconfined candidate archive");
    command(["unzip", "-q", archive, "-d", directory]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function qualificationTemplate(manifest: Candidate, artifactId: string) {
  const rows = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, { result: "hold", evidence: "" }]));
  return {
    schema: 1,
    candidate: manifest,
    candidateArtifactId: artifactId,
    maintainer: "",
    approvedAt: "",
    report: `docs/compatibility/linux-${manifest.version}.md`,
    environment: Object.fromEntries(
      ["osSnapshot", "kernel", "desktop", "libc", "git", "secureStore", "microphone"].map((name) => [name, ""]),
    ),
    sessions: { wayland: rows(DESKTOP_CHECKS), x11: rows(DESKTOP_CHECKS) },
    gates: rows(NATIVE_GATES),
  };
}

function identity(): Omit<Candidate, "package"> {
  const root = readJson<{ version: string; packageManager: string }>("package.json");
  const shell = readJson<{ devDependencies: { electron: string } }>("packages/shell/package.json");
  const target = { platform: "linux", architecture: "x64", libc: "glibc" } as const;
  const claude = claudeRuntimeCandidate(target);
  const codex = codexRuntimeCandidate(target);
  const commit = command(["git", "rev-parse", "HEAD"]);
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  return {
    schema: 1,
    version: root.version,
    commit,
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt,
    artifactName: `linux-candidate-${commit}-${runAttempt}`,
    runtimes: {
      bun: root.packageManager.replace(/^bun@/, ""),
      electron: shell.devDependencies.electron,
      claude: claude.version,
      sdk: claude.sdkVersion!,
      codex: codex.version,
    },
    locks: Object.fromEntries(LOCKS.map((path) => [path, sha256(readFileSync(path))])),
  };
}

async function candidate(): Promise<void> {
  validateJobs(JSON.parse(process.env.CANDIDATE_RESULTS ?? "{}"), ["ci", "security", "pacman"]);
  const metadata = identity();
  const directory = resolve(".context/linux-candidate");
  mkdirSync(directory, { recursive: true });
  const evidence = join(directory, "evidence");
  command(["gh", "run", "download", metadata.runId, "--pattern", "tests-*", "--dir", evidence]);
  command([
    "gh",
    "run",
    "download",
    metadata.runId,
    "--name",
    `linux-payload-${metadata.runAttempt}`,
    "--dir",
    directory,
  ]);
  validateEvidence(evidence, metadata.commit, metadata.runtimes.bun);
  const name = `glosa-${metadata.version}-x64.pacman`;
  const bytes = readFileSync(join(directory, name));
  const manifest: Candidate = { ...metadata, package: { name, sha256: sha256(bytes) } };
  validateSmoke(readJson(join(evidence, "tests-pacman/pacman/report.json")), manifest.package.sha256);
  validateCandidate(manifest, bytes);
  writeFileSync(join(directory, "candidate.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, "SHA256SUMS"), `${manifest.package.sha256}  ${name}\n`);
}

async function promote(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const artifactId = process.env.CANDIDATE_ARTIFACT_ID ?? "";
  const runId = process.env.CANDIDATE_RUN_ID ?? "";
  const tag = process.env.RELEASE_TAG ?? "";
  const qualificationCommit = process.env.QUALIFICATION_COMMIT ?? "";
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[1-9][0-9]*$/.test(artifactId) ||
    !/^[1-9][0-9]*$/.test(runId) ||
    !/^v[0-9][A-Za-z0-9.+-]*$/.test(tag) ||
    !/^[a-f0-9]{40}$/.test(qualificationCommit)
  )
    throw new Error("Promotion requires main and valid explicit identities");
  const environment = github<{ protection_rules: { type: string; reviewers?: unknown[] }[] }>(
    `repos/${repository}/environments/linux-release`,
  );
  if (!environment.protection_rules.some((rule) => rule.type === "required_reviewers" && rule.reviewers?.length))
    throw new Error("linux-release must have required reviewers configured");
  command(["git", "merge-base", "--is-ancestor", qualificationCommit, "origin/main"]);
  const run = github<Run>(`repos/${repository}/actions/runs/${runId}`);
  const artifact = github<Artifact>(`repos/${repository}/actions/artifacts/${artifactId}`);
  if (String(artifact.workflow_run.id) !== runId || !/^linux-candidate-[a-f0-9]{40}-[1-9][0-9]*$/.test(artifact.name))
    throw new Error("Wrong candidate artifact");
  const directory = resolve(".context/linux-promotion");
  if (existsSync(directory)) throw new Error("Promotion directory must be fresh");
  downloadArtifact(repository, artifactId, directory);
  const manifest = readJson<Candidate>(join(directory, "candidate.json"));
  const packagePath = join(directory, `glosa-${tag.slice(1)}-x64.pacman`);
  validateCandidate(manifest, readFileSync(packagePath));
  if (manifest.version !== tag.slice(1)) throw new Error("Release version mismatch");
  const tagCommit = command(["git", "rev-parse", `refs/tags/${tag}^{commit}`]);
  validateProvenance(manifest, run, artifact, repository, tagCommit);
  const qualification = JSON.parse(
    command(["git", "show", `${qualificationCommit}:docs/compatibility/linux-${manifest.version}.json`]),
  ) as Qualification;
  validateQualification(manifest, artifactId, qualification);
  command(["git", "show", `${qualificationCommit}:${qualification.report}`]);
  const source = resolve(".context/linux-source");
  command(["git", "worktree", "add", "--detach", source, manifest.commit]);
  for (const lock of LOCKS)
    if (sha256(readFileSync(join(source, lock))) !== manifest.locks[lock])
      throw new Error(`Source lock mismatch: ${lock}`);
  validateSmoke(readJson(join(directory, "evidence/tests-pacman/pacman/report.json")), manifest.package.sha256);
  command(
    [
      process.execPath,
      join(source, "scripts/linux-release.ts"),
      "verify-evidence",
      join(directory, "evidence"),
      manifest.commit,
      manifest.runtimes.bun,
    ],
    source,
  );
  await publishAssets(tag, [packagePath], join(directory, "SHA256SUMS"));
}

if (import.meta.main) {
  const action = process.argv[2];
  if (action === "candidate") await candidate();
  else if (action === "promote") await promote();
  else if (action === "verify-evidence") validateEvidence(process.argv[3]!, process.argv[4]!, process.argv[5]!);
  else if (action === "qualification-template") {
    const [directory, artifactId, output] = process.argv.slice(3);
    if (!directory || !/^[1-9][0-9]*$/.test(artifactId ?? "") || !output)
      throw new Error("Specify candidate directory, artifact ID and new output path");
    const manifest = readJson<Candidate>(join(directory, "candidate.json"));
    if (basename(manifest.package.name) !== manifest.package.name) throw new Error("Invalid package name");
    validateCandidate(manifest, readFileSync(join(directory, manifest.package.name)));
    writeFileSync(output, `${JSON.stringify(qualificationTemplate(manifest, artifactId!), null, 2)}\n`, { flag: "wx" });
  } else throw new Error("Usage: linux-release.ts candidate|promote|verify-evidence|qualification-template");
}
