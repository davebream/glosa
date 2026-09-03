// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomPort } from "./helpers.ts";

const childHelperPath = join(import.meta.dir, "helpers.ts");
const childScript = `
  import { existsSync, writeFileSync } from "node:fs";
  import { randomPort } from ${JSON.stringify(childHelperPath)};
  writeFileSync(process.env.GLOSA_TEST_PORT_OUTPUT, String(randomPort()));
  while (!existsSync(process.env.GLOSA_TEST_PORT_RELEASE)) await Bun.sleep(10);
`;

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.length = 0;
});

async function waitUntil(predicate: () => boolean, deadlineMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

test("randomPort reserves non-overlapping blocks across isolated test processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-test-port-helper-"));
  cleanupDirs.push(root);
  const releasePath = join(root, "release");
  const outputs = Array.from({ length: 8 }, (_, index) => join(root, `port-${index}`));
  const children = outputs.map((outputPath) =>
    Bun.spawn({
      cmd: [process.execPath, "-e", childScript],
      env: {
        ...Bun.env,
        GLOSA_TEST_PORT_OUTPUT: outputPath,
        GLOSA_TEST_PORT_RELEASE: releasePath,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );

  try {
    expect(await waitUntil(() => outputs.every(existsSync))).toBe(true);
    const ports = outputs.map((output) => Number(readFileSync(output, "utf8")));
    const reservedPorts = ports.flatMap((port) => Array.from({ length: 4 }, (_, offset) => port + offset));
    expect(new Set(reservedPorts).size).toBe(reservedPorts.length);
  } finally {
    writeFileSync(releasePath, "release");
    await Promise.all(children.map((child) => child.exited));
  }
});

test("randomPort keeps locally allocated main and Class-F blocks disjoint", () => {
  const first = randomPort();
  const second = randomPort();
  const firstBlock = Array.from({ length: 4 }, (_, offset) => first + offset);
  const secondBlock = Array.from({ length: 4 }, (_, offset) => second + offset);
  expect(secondBlock.some((port) => firstBlock.includes(port))).toBe(false);
});
