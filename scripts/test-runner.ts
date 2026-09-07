// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { checkedFiles, ROOT, type Profile } from "./test-plan.ts";

type Case = {
  name: string;
  classname?: string;
  file: string;
  time: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
};
type Suite = { name: string; time: string; testcase?: Case[] };
export function inspectReport(xml: string, selected: string[]) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("JUnit must not declare document entities");
  if (XMLValidator.validate(xml) !== true) throw new Error("Malformed JUnit report");
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => name === "testsuite" || name === "testcase",
    processEntities: true,
  }).parse(xml) as { testsuites?: { tests: string; failures: string; testsuite?: Suite[] } };
  const report = document.testsuites;
  const suites = report?.testsuite ?? [];
  const cases = suites.flatMap((suite) => suite.testcase ?? []);
  if (!report || cases.length === 0 || Number(report.tests) !== cases.length)
    throw new Error("Missing or inconsistent JUnit test cases");
  if (!Number.isInteger(Number(report.failures)) || Number(report.failures) < 0)
    throw new Error("Invalid JUnit failure count");
  const actual = new Set(cases.map((entry) => entry.file.replace(/^\.\//, "")));
  if (selected.some((file) => !actual.has(file)) || [...actual].some((file) => !selected.includes(file)))
    throw new Error("JUnit executed files do not match the selected inventory");
  if (cases.some((entry) => !Number.isFinite(Number(entry.time)) || Number(entry.time) < 0))
    throw new Error("Invalid JUnit timing");
  return {
    tests: cases.length,
    failures:
      Number(report.failures) ||
      cases.filter((entry) => entry.failure !== undefined || entry.error !== undefined).length,
    skipped: cases.filter((entry) => entry.skipped !== undefined).length,
    identities: cases.map((entry) => `${entry.file}\t${entry.classname ?? ""}\t${entry.name}`).sort(),
    slowFiles: suites
      .map((suite) => ({ file: suite.name, seconds: Number(suite.time) }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 10),
    slowTests: cases
      .map((entry) => ({ file: entry.file, name: entry.name, seconds: Number(entry.time) }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 10),
  };
}

export async function runInvocation(options: {
  profile: string;
  files: string[];
  directory: string;
  root?: string;
  command?: string[];
}): Promise<number> {
  const root = options.root ?? ROOT;
  mkdirSync(options.directory, { recursive: true });
  const prefix = join(options.directory, `${options.profile}-${Date.now()}-${crypto.randomUUID()}`);
  const started = performance.now();
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
  const command = options.command ?? [
    process.execPath,
    "test",
    ...(options.profile === "full" ? [] : options.files.map((file) => `./${file}`)),
    "--reporter=junit",
    `--reporter-outfile=${prefix}.xml`,
  ];
  const record: Record<string, unknown> = {
    profile: options.profile,
    commit,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    runner: process.env.RUNNER_NAME ?? "local",
    files: options.files,
    command,
    startedAt: new Date().toISOString(),
    exitCode: null,
  };
  const save = () => writeFileSync(`${prefix}.json`, `${JSON.stringify(record, null, 2)}\n`);
  save();
  writeFileSync(`${prefix}.stdout.log`, "");
  writeFileSync(`${prefix}.stderr.log`, "");
  let child: ReturnType<typeof spawn>;
  const spawn = () =>
    Bun.spawn(command, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, GLOSA_TEST_PHASE_REPORT: `${prefix}.phases.jsonl` },
    });
  try {
    child = spawn();
  } catch (error) {
    record.exitCode = 1;
    record.spawnError = String(error);
    record.elapsedSeconds = (performance.now() - started) / 1000;
    appendFileSync(`${prefix}.stderr.log`, String(error));
    save();
    return 1;
  }
  let signalExit: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (code: number) => {
    signalExit = code;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
  };
  const int = () => interrupt(130);
  const term = () => interrupt(143);
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  async function copy(stream: ReadableStream<Uint8Array>, file: string, output: NodeJS.WriteStream) {
    writeFileSync(file, "");
    for await (const chunk of stream) {
      appendFileSync(file, chunk);
      output.write(chunk);
    }
  }
  let exitCode = 1;
  try {
    await Promise.all([
      copy(child.stdout, `${prefix}.stdout.log`, process.stdout),
      copy(child.stderr, `${prefix}.stderr.log`, process.stderr),
    ]);
    exitCode = signalExit ?? (await child.exited);
    record.childExitCode = exitCode;
    try {
      const report = inspectReport(readFileSync(`${prefix}.xml`, "utf8"), options.files);
      record.report = report;
      if (report.failures || report.skipped) exitCode ||= 1;
      const summary =
        `\n### Tests: ${options.profile}\n\n${report.tests} tests; ${report.failures} failures; ${report.skipped} skipped.\n\n` +
        report.slowFiles.map((entry) => `- ${entry.seconds.toFixed(2)}s — ${entry.file}`).join("\n") +
        "\n\nSlowest cases:\n\n" +
        report.slowTests
          .map((entry) => `- ${entry.seconds.toFixed(2)}s — ${entry.file}: ${entry.name.replace(/[\r\n]/g, " ")}`)
          .join("\n") +
        "\n";
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } catch (error) {
      record.reportError = String(error);
      console.error(`Report verification failed: ${error}`);
      exitCode ||= 1;
    }
  } finally {
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", int);
    process.off("SIGTERM", term);
    record.elapsedSeconds = (performance.now() - started) / 1000;
    record.exitCode = exitCode;
    save();
  }
  return exitCode;
}

export async function runAttempts(count: number, execute: () => Promise<number>): Promise<number> {
  if (![1, 2, 10].includes(count)) throw new Error("Unsupported repetition count");
  let exitCode = 0;
  for (let attempt = 0; attempt < count; attempt++) {
    const result = await execute();
    if (result === 130 || result === 143) return result;
    exitCode ||= result;
  }
  return exitCode;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const profile = args.shift() ?? "";
  let repetitions = 2;
  if (args.length) {
    if (profile !== "stability" || args.length !== 2 || args[0] !== "--repetitions" || !["2", "10"].includes(args[1]!))
      throw new Error("Usage: test-runner.ts <profile|ci> [--repetitions 2|10]");
    repetitions = Number(args[1]);
  }
  const profiles: Profile[] = profile === "ci" ? ["acceptance", "remaining-1", "remaining-2"] : [profile as Profile];
  let exitCode = 0;
  for (const selected of profiles) {
    const files = checkedFiles(selected);
    const result = await runAttempts(selected === "stability" ? repetitions : 1, () =>
      runInvocation({
        profile: selected,
        files,
        directory: resolve(ROOT, ".context/test-results"),
      }),
    );
    if (result === 130 || result === 143) {
      exitCode = result;
      break;
    }
    exitCode ||= result;
  }
  process.exitCode = exitCode;
}
