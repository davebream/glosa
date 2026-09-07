// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectReport, runInvocation, runAttempts } from "../scripts/test-runner.ts";

const report =
  '<testsuites tests="1" failures="0"><testsuite name="a.test.ts" time="0.1"><testcase name="works" file="a.test.ts" time="0.1" /></testsuite></testsuites>';
test("JUnit must be well formed, nonempty and prove exactly the selected files", () => {
  expect(inspectReport(report, ["a.test.ts"]).tests).toBe(1);
  for (const xml of [
    "",
    "<testsuites>",
    report.replace('tests="1"', 'tests="2"'),
    report.replace('time="0.1" />', 'time="NaN" />'),
  ])
    expect(() => inspectReport(xml, ["a.test.ts"])).toThrow();
  expect(() => inspectReport(report, ["a.test.ts", "missing.test.ts"])).toThrow("inventory");
  expect(() => inspectReport(report, ["other.test.ts"])).toThrow("inventory");
});

test("real failed child keeps raw diagnostics, JUnit and its failed exit status", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-runner-"));
  try {
    writeFileSync(
      join(root, "failure.test.ts"),
      'import {test,expect} from "bun:test"; test("deliberate failure",()=>{console.error("diagnostic sentinel"); expect(1).toBe(2);});',
    );
    const directory = join(root, "reports");
    expect(await runInvocation({ profile: "fixture", files: ["failure.test.ts"], root, directory })).not.toBe(0);
    const files = readdirSync(directory);
    const record = JSON.parse(readFileSync(join(directory, files.find((f) => f.endsWith(".json"))!), "utf8"));
    expect(record.exitCode).not.toBe(0);
    expect(record.report.failures).toBe(1);
    expect(files.some((f) => f.endsWith(".xml"))).toBe(true);
    expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stderr.log"))!), "utf8")).toContain(
      "diagnostic sentinel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a terminated child without JUnit remains failed and retains execution evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-runner-kill-"));
  try {
    const directory = join(root, "reports");
    expect(
      await runInvocation({
        profile: "killed",
        files: ["a.test.ts"],
        root,
        directory,
        command: [process.execPath, "-e", 'console.error("before termination");process.kill(process.pid,"SIGKILL");'],
      }),
    ).not.toBe(0);
    const files = readdirSync(directory);
    const record = JSON.parse(readFileSync(join(directory, files.find((f) => f.endsWith(".json"))!), "utf8"));
    expect(record.reportError).toBeDefined();
    expect(record.exitCode).not.toBe(0);
    expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stderr.log"))!), "utf8")).toContain(
      "before termination",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stability executes every attempt and cannot retry a failure into success", async () => {
  let attempts = 0;
  expect(await runAttempts(10, async () => (++attempts === 1 ? 7 : 0))).toBe(7);
  expect(attempts).toBe(10);
  attempts = 0;
  expect(
    await runAttempts(10, async () => {
      attempts++;
      return 143;
    }),
  ).toBe(143);
  expect(attempts).toBe(1);
});

test("JUnit identities decode escaped filenames and names without accepting document entities", () => {
  const escaped = report
    .replaceAll("a.test.ts", "a&amp;b.test.ts")
    .replace('name="works"', 'name="works &amp; &quot;quotes&quot;"');
  expect(inspectReport(escaped, ["a&b.test.ts"]).identities).toEqual(['a&b.test.ts\t\tworks & "quotes"']);
  expect(() => inspectReport('<!DOCTYPE testsuites [<!ENTITY x "text">]>' + report, ["a.test.ts"])).toThrow("entities");
});
