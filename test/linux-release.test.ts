// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Artifact,
  type Candidate,
  type Qualification,
  type Run,
  DESKTOP_CHECKS,
  NATIVE_GATES,
  validateCandidate,
  validateEvidence,
  validateJobs,
  validateProvenance,
  validateQualification,
  validateSmoke,
  qualificationTemplate,
} from "../scripts/linux-release.ts";
import { mergeChecksums, publishAssets, sha256 } from "../scripts/release-assets.ts";
import { DECLARED_STAGES } from "../packages/shell/scripts/linux-package-smoke.ts";
import { checkedFiles } from "../scripts/test-plan.ts";

const bytes = Buffer.from("retained pacman package fixture");
const candidate: Candidate = {
  schema: 1,
  version: "0.1.0-alpha.37",
  commit: "a".repeat(40),
  runId: "123",
  runAttempt: "1",
  artifactName: `linux-candidate-${"a".repeat(40)}-1`,
  package: { name: "glosa-0.1.0-alpha.37-x64.pacman", sha256: sha256(bytes) },
  runtimes: { bun: "1.4.2", electron: "44.4.5", claude: "2.1.280", sdk: "0.3.280", codex: "0.156.1" },
  locks: Object.fromEntries(
    [
      "bun.lock",
      "packages/shell/bun.lock",
      "packages/providers/claude-code/src/runtime-locks/linux-x64.lock",
      "packages/providers/codex/src/runtime-locks/linux-x64.lock",
    ].map((file) => [file, "b".repeat(64)]),
  ),
};
const run: Run = {
  id: 123,
  run_attempt: 1,
  head_sha: candidate.commit,
  head_branch: "main",
  event: "workflow_dispatch",
  path: ".github/workflows/release.yml",
  conclusion: "success",
  repository: { full_name: "davebream/glosa" },
};
const artifact: Artifact = {
  id: 456,
  name: candidate.artifactName,
  expired: false,
  expires_at: "2100-01-01T00:00:00Z",
  workflow_run: { id: 123, head_sha: candidate.commit },
};
const observation = { result: "pass" as const, evidence: "Synthetic validator fixture, not qualification evidence" };
function qualification(): Qualification {
  return {
    schema: 1,
    candidate: structuredClone(candidate),
    candidateArtifactId: "456",
    maintainer: "fixture-maintainer",
    approvedAt: "2026-01-01T00:00:00Z",
    report: "docs/compatibility/linux-fixture.md",
    environment: Object.fromEntries(
      ["osSnapshot", "kernel", "desktop", "libc", "git", "secureStore", "microphone"].map((key) => [key, "fixture"]),
    ),
    sessions: {
      wayland: Object.fromEntries(DESKTOP_CHECKS.map((name) => [name, { ...observation }])),
      x11: Object.fromEntries(DESKTOP_CHECKS.map((name) => [name, { ...observation }])),
    },
    gates: Object.fromEntries(NATIVE_GATES.map((name) => [name, { ...observation }])),
  };
}

test("candidate aggregation rejects every non-success result and missing required dependency", () => {
  const success = { ci: { result: "success" }, security: { result: "success" }, pacman: { result: "success" } };
  const required = Object.keys(success);
  expect(() => validateJobs(success, required)).not.toThrow();
  for (const job of required) {
    for (const result of ["failure", "skipped", "cancelled", "pending"])
      expect(() => validateJobs({ ...success, [job]: { result } }, required)).toThrow(job);
    const missing: Record<string, { result: string }> = structuredClone(success);
    delete missing[job];
    expect(() => validateJobs(missing, required)).toThrow(job);
  }
});

test("changed package bytes cannot reuse candidate or smoke qualification", () => {
  expect(() => validateCandidate(candidate, bytes)).not.toThrow();
  expect(() => validateCandidate(candidate, Buffer.from("rebuilt package"))).toThrow("checksum");
  const smoke = {
    packageSha256: candidate.package.sha256,
    emulated: false,
    unrun: [],
    results: DECLARED_STAGES.map((stage) => ({ stage, ok: true })),
  };
  expect(() => validateSmoke(smoke, candidate.package.sha256)).not.toThrow();
  expect(() => validateSmoke(smoke, sha256("other bytes"))).toThrow("different package");
  expect(() => validateSmoke({ ...smoke, emulated: true }, candidate.package.sha256)).toThrow("native");
  expect(() => validateSmoke({ ...smoke, results: [] }, candidate.package.sha256)).toThrow("inventory");
  for (const stage of DECLARED_STAGES)
    expect(() =>
      validateSmoke(
        { ...smoke, results: smoke.results.map((row) => ({ ...row, ok: row.stage !== stage })) },
        candidate.package.sha256,
      ),
    ).toThrow(stage);
});

test("only the successful trusted run and its unexpired artifact can match the release tag", () => {
  const verify = (changedRun = run, changedArtifact = artifact, tagCommit = candidate.commit) =>
    validateProvenance(candidate, changedRun, changedArtifact, "davebream/glosa", tagCommit);
  expect(() => verify()).not.toThrow();
  for (const change of [
    { event: "pull_request" },
    { head_branch: "branch" },
    { conclusion: "failure" },
    { conclusion: "skipped" },
    { path: ".github/workflows/ci.yml" },
    { head_sha: "b".repeat(40) },
    { id: 124 },
    { run_attempt: 2 },
    { repository: { full_name: "someone/fork" } },
  ])
    expect(() => verify({ ...run, ...change })).toThrow();
  for (const change of [
    { expired: true },
    { expires_at: "2020-01-01" },
    { name: "other" },
    { workflow_run: { id: 999, head_sha: candidate.commit } },
  ])
    expect(() => verify(run, { ...artifact, ...change })).toThrow();
  expect(() => verify(run, artifact, "b".repeat(40))).toThrow("commit");
});

test("both sessions and every native gate require an observed pass for the exact candidate", () => {
  const template = qualificationTemplate(candidate, "456");
  expect(Object.values(template.gates).every((row) => row.result === "hold")).toBe(true);
  expect(() => validateQualification(candidate, "456", template as unknown as Qualification)).toThrow();
  expect(() => validateQualification(candidate, "456", qualification())).not.toThrow();
  for (const session of ["wayland", "x11"] as const) {
    for (const name of DESKTOP_CHECKS) {
      const record = qualification();
      delete record.sessions[session][name];
      expect(() => validateQualification(candidate, "456", record)).toThrow(`${session}/${name}`);
    }
  }
  for (const name of NATIVE_GATES) {
    const record = qualification();
    delete record.gates[name];
    expect(() => validateQualification(candidate, "456", record)).toThrow(name);
  }
  const record = qualification();
  record.candidate.package.sha256 = sha256("changed");
  expect(() => validateQualification(candidate, "456", record)).toThrow("different candidate");
  expect(() => validateQualification(candidate, "999", qualification())).toThrow("identity");
  expect(() => validateQualification(candidate, "456", { ...qualification(), maintainer: "" })).toThrow("signature");
});

test("missing or malformed execution receipts fail rather than becoming a skipped pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "glosa-evidence-"));
  try {
    expect(() => validateEvidence(directory, candidate.commit, candidate.runtimes.bun)).toThrow("Missing");
    writeFileSync(join(directory, "broken.json"), "{");
    expect(() => validateEvidence(directory, candidate.commit, candidate.runtimes.bun)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate evidence requires complete platform reports with matching source and no skipped tests", () => {
  const directory = mkdtempSync(join(tmpdir(), "glosa-complete-evidence-"));
  const profiles = [
    ["darwin", "ci-1"],
    ["darwin", "ci-2"],
    ["darwin", "ci-3"],
    ["darwin", "full"],
    ["darwin", "shell"],
    ["darwin", "stability"],
    ["darwin", "stability"],
    ["linux", "linux-acceptance"],
    ["linux", "shell"],
  ];
  try {
    for (const [index, [platform, profile]] of profiles.entries()) {
      const files = checkedFiles(profile!);
      writeFileSync(
        join(directory, `${index}.json`),
        JSON.stringify({
          platform,
          profile,
          files,
          commit: candidate.commit,
          bun: candidate.runtimes.bun,
          arch: "x64",
          exitCode: 0,
          childExitCode: 0,
        }),
      );
      const cases = files.map((file) => `<testcase name="fixture" file="${file}" time="0"/>`).join("");
      writeFileSync(
        join(directory, `${index}.xml`),
        `<testsuites tests="${files.length}" failures="0"><testsuite name="fixture" time="0">${cases}</testsuite></testsuites>`,
      );
    }
    expect(() => validateEvidence(directory, candidate.commit, candidate.runtimes.bun)).not.toThrow();
    expect(() => validateEvidence(directory, "b".repeat(40), candidate.runtimes.bun)).toThrow("receipt");
    const xmlPath = join(directory, "7.xml");
    const xml = readFileSync(xmlPath, "utf8");
    writeFileSync(xmlPath, xml.replace('time="0"/>', 'time="0"><skipped/></testcase>'));
    expect(() => validateEvidence(directory, candidate.commit, candidate.runtimes.bun)).toThrow("skipped");
    writeFileSync(xmlPath, xml);
    rmSync(join(directory, "8.json"));
    expect(() => validateEvidence(directory, candidate.commit, candidate.runtimes.bun)).toThrow("linux/shell");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checksum merging preserves both platforms and refuses conflicts or unsafe names", () => {
  const mac = `${sha256("mac")}  glosa-1-arm64.dmg\n`;
  const linux = { "glosa-1-x64.pacman": sha256("linux") };
  const combined = mergeChecksums(mac, linux);
  expect(combined).toContain(mac);
  expect(combined).toContain(`${sha256("linux")}  glosa-1-x64.pacman\n`);
  expect(mergeChecksums(combined, linux)).toBe(combined);
  expect(() => mergeChecksums(combined, { "glosa-1-x64.pacman": sha256("changed") })).toThrow("Conflicting");
  expect(() => mergeChecksums("invalid", linux)).toThrow("Malformed");
  expect(() => mergeChecksums(mac, { "../bad": sha256("bad") })).toThrow("Invalid");
});

test("publication preserves remote macOS bytes, downloads verification, and never overwrites a conflicting asset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "glosa-publication-"));
  const remote = new Map<string, string>([["glosa-1-arm64.dmg", "mac"]]);
  remote.set("SHA256SUMS", mergeChecksums("", { "glosa-1-arm64.dmg": sha256("mac") }));
  const uploads: string[] = [];
  const fake = (args: string[]): string => {
    if (args[2] === "view")
      return JSON.stringify({ isDraft: false, assets: [...remote.keys()].map((name) => ({ name })) });
    if (args[2] === "download") {
      const name = args[args.indexOf("--pattern") + 1]!;
      const target = args[args.indexOf("--dir") + 1]!;
      if (!remote.has(name)) throw new Error("Missing remote fixture");
      writeFileSync(join(target, name), remote.get(name)!);
      return "";
    }
    if (args[2] === "upload") {
      const file = args[4]!;
      uploads.push(basename(file));
      remote.set(basename(file), readFileSync(file, "utf8"));
      return "";
    }
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  try {
    const file = join(directory, "glosa-1-x64.pacman");
    writeFileSync(file, "linux");
    await publishAssets("v1", [file], join(directory, "SHA256SUMS"), fake);
    expect(remote.get("glosa-1-arm64.dmg")).toBe("mac");
    expect(remote.get("SHA256SUMS")).toContain(sha256("mac"));
    expect(remote.get("SHA256SUMS")).toContain(sha256("linux"));
    await publishAssets("v1", [file], join(directory, "SHA256SUMS"), fake);
    expect(uploads.filter((name) => name.endsWith("pacman"))).toHaveLength(1);
    const before = uploads.length;
    writeFileSync(file, "replacement");
    await expect(publishAssets("v1", [file], join(directory, "SHA256SUMS"), fake)).rejects.toThrow("Conflicting");
    expect(uploads).toHaveLength(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
