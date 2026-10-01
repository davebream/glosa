// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDictation } from "../src/dictation.ts";
import {
  type OpenAIDictationCredentialStore,
  openAIDictationConfigPath,
} from "../../providers/openai-transcription/src/index.ts";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "glosa-dictation-cli-"));
  homes.push(home);
  const keys = new Map<string, string>();
  const credentialStore: OpenAIDictationCredentialStore = {
    has: async (account) => keys.has(account),
    read: async (account) => keys.get(account) ?? null,
    write: async (account, key) => {
      keys.set(account, key);
    },
    remove: async (account) => {
      keys.delete(account);
      return true;
    },
  };
  return {
    home,
    credentialStore,
    isTTY: () => true,
    confirm: async () => true,
    readKey: async () => "private-key",
    keys,
  };
}
test("configure requires the OpenAI provider, consent and an interactive terminal", async () => {
  const f = fixture();
  expect((await runDictation("configure", {}, f)).ok).toBe(false);
  expect((await runDictation("configure", { provider: "openai", json: true }, f)).ok).toBe(false);
  expect((await runDictation("configure", { provider: "openai" }, { ...f, confirm: async () => false })).ok).toBe(
    false,
  );
  expect(f.keys.size).toBe(0);
});
test("configure, status and disable use secure storage and never emit the key", async () => {
  const f = fixture();
  const result = await runDictation("configure", { provider: "openai" }, f);
  expect(result.ok).toBe(true);
  expect(result.data.state).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("private-key");
  expect(readFileSync(openAIDictationConfigPath(f.home), "utf8")).not.toContain("private-key");
  f.credentialStore.read = async () => {
    throw new Error("status must not read");
  };
  expect((await runDictation("status", { json: true }, f)).data.state).toBe("ready");
  expect((await runDictation("disable", {}, f)).ok).toBe(true);
  expect(f.keys.size).toBe(0);
});
test("key-write failure preserves the previous configuration", async () => {
  const f = fixture();
  await runDictation("configure", { provider: "openai" }, f);
  const before = readFileSync(openAIDictationConfigPath(f.home), "utf8");
  f.credentialStore.write = async () => {
    throw new Error("private-key");
  };
  const result = await runDictation("configure", { provider: "openai" }, f);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private-key");
  expect(readFileSync(openAIDictationConfigPath(f.home), "utf8")).toBe(before);
});
