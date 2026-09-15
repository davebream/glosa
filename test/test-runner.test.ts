// SPDX-License-Identifier: Apache-2.0
import { expect, test, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectReport, runInvocation, runAttempts, assertJUnitRuntime } from "../scripts/test-runner.ts";

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

// #230: the old runtime aborted while recording passing tests around entry 4921.
// Keep this in a child so the repository suite still has a normal test inventory.
test("JUnit records all 10000 passing tests and retains both output streams (#230)", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-reporter-volume-"));
  try {
    writeFileSync(
      join(root, "reporter-only.test.ts"),
      `import {describe,test,expect} from "bun:test";
console.log("reporter stdout sentinel"); console.error("reporter stderr sentinel");
describe("outer",()=>describe("inner",()=>{
for(let i=0;i<10000;i++) test(\`empty test \${i}\`,()=>expect(true).toBe(true));
}));`,
    );
    const directory = join(root, "reports");
    expect(await runInvocation({ profile: "reporter-volume", files: ["reporter-only.test.ts"], root, directory })).toBe(
      0,
    );
    const files = readdirSync(directory);
    const record = JSON.parse(readFileSync(join(directory, files.find((f) => f.endsWith(".json"))!), "utf8"));
    expect(record.report).toMatchObject({ tests: 10000, failures: 0, skipped: 0 });
    expect(record.report.identities).toHaveLength(10000);
    expect(new Set(record.report.identities).size).toBe(10000);
    expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stdout.log"))!), "utf8")).toContain(
      "reporter stdout sentinel",
    );
    expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stderr.log"))!), "utf8")).toContain(
      "reporter stderr sentinel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JUnit runtime preflight refuses the known-broken runtime with an actionable error (#230)", () => {
  expect(() => assertJUnitRuntime("1.2.7")).toThrow("requires Bun >=1.4.2");
  expect(() => assertJUnitRuntime("1.4.1")).toThrow("packageManager");
  expect(() => assertJUnitRuntime("1.4.2")).not.toThrow();
  expect(() => assertJUnitRuntime("1.5.0")).not.toThrow();
});

test("a real skipped test remains a failed gate even when the child exits zero (#230)", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-runner-skip-"));
  try {
    writeFileSync(
      join(root, "skipped.test.ts"),
      'import {test} from "bun:test"; test.skip("required scenario",()=>{});',
    );
    const directory = join(root, "reports");
    expect(await runInvocation({ profile: "skip", files: ["skipped.test.ts"], root, directory })).not.toBe(0);
    const record = JSON.parse(
      readFileSync(join(directory, readdirSync(directory).find((f) => f.endsWith(".json"))!), "utf8"),
    );
    expect(record.childExitCode).toBe(0);
    expect(record.report.skipped).toBe(1);
    expect(record.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const shape of ["missing", "incomplete", "failure"] as const) {
  test(`zero-exit ${shape} reporter output cannot pass the gate (#230)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-runner-report-"));
    try {
      const directory = join(root, "reports");
      // A fixture producer deliberately violates the reporter contract. The real-volume and
      // assertion/skip cases above exercise Bun's actual producer independently.
      const script = `import {readdirSync,writeFileSync} from "node:fs"; import {join} from "node:path";
const dir=${JSON.stringify(directory)};
${shape !== "missing" ? `const record=readdirSync(dir).find(f=>f.endsWith(".json"));writeFileSync(join(dir,record.replace(/\\.json$/,".xml")),${JSON.stringify(shape === "failure" ? report.replace('failures="0"', 'failures="1"') : report)});` : ""}
console.log("report stdout sentinel");console.error("report stderr sentinel");`;
      expect(
        await runInvocation({
          profile: shape,
          files: shape === "failure" ? ["a.test.ts"] : ["a.test.ts", "missing.test.ts"],
          root,
          directory,
          command: [process.execPath, "-e", script],
        }),
      ).not.toBe(0);
      const files = readdirSync(directory);
      const record = JSON.parse(readFileSync(join(directory, files.find((f) => f.endsWith(".json"))!), "utf8"));
      expect(record.childExitCode).toBe(0);
      if (shape === "failure") {
        expect(record.report.failures).toBe(1);
        expect(record.reportError).toBeUndefined();
      } else expect(record.reportError).toContain(shape === "incomplete" ? "inventory" : "ENOENT");
      expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stdout.log"))!), "utf8")).toContain(
        "report stdout sentinel",
      );
      expect(readFileSync(join(directory, files.find((f) => f.endsWith(".stderr.log"))!), "utf8")).toContain(
        "report stderr sentinel",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("unsupported-runtime preflight stops before creating reports or starting a child (#230)", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-runner-version-"));
  const directory = join(root, "reports");
  // Supply an unsupported version decision without requiring an old binary in every checkout.
  // The independent old-runtime probe reproduces the actual 1.2.7 refusal and reporter abort.
  const version = spyOn(Bun.semver, "satisfies").mockReturnValue(false);
  try {
    await expect(
      runInvocation({
        profile: "version",
        files: ["a.test.ts"],
        root,
        directory,
        command: [process.execPath, "-e", "console.log('child must not start')"],
      }),
    ).rejects.toThrow("requires Bun");
    expect(existsSync(directory)).toBe(false);
  } finally {
    version.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

// Bun 1.4.2 emits nested suites for describe groups. Parent counts include descendants;
// count each testcase once, while still accepting a mixture of direct and nested cases.
test("nested JUnit suites preserve inventory and failure/skip checks (#230)", () => {
  const nested = `<testsuites tests="3" failures="0"><testsuite name="a.test.ts" time="0.3">
    <testcase name="direct" file="a.test.ts" time="0.1" />
    <testsuite name="outer" tests="2" time="0.2">
      <testcase name="grouped" classname="outer" file="a.test.ts" time="0.1" />
      <testsuite name="inner" tests="1" time="0.1">
        <testcase name="deep" classname="outer &gt; inner" file="a.test.ts" time="0.1" />
      </testsuite>
    </testsuite>
  </testsuite></testsuites>`;
  const parsed = inspectReport(nested, ["a.test.ts"]);
  expect(parsed.tests).toBe(3);
  expect(parsed.identities).toEqual(
    ["a.test.ts\t\tdirect", "a.test.ts\touter > inner\tdeep", "a.test.ts\touter\tgrouped"].sort(),
  );
  expect(() => inspectReport(nested, ["a.test.ts", "missing.test.ts"])).toThrow("inventory");
  expect(() => inspectReport(nested.replace('tests="3"', 'tests="4"'), ["a.test.ts"])).toThrow("inconsistent");
  const deep = 'name="deep" classname="outer &gt; inner" file="a.test.ts" time="0.1" />';
  for (const kind of ["failure", "error", "skipped"]) {
    const bad = nested.replace(deep, deep.replace("/>", `><${kind} /></testcase>`));
    const result = inspectReport(bad, ["a.test.ts"]);
    expect(kind === "skipped" ? result.skipped : result.failures).toBe(1);
  }
});
