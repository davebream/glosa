// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { managedEnvironment } from "../../src/agents/environment.ts";
import { IntentJournal } from "../../src/chats/journal.ts";
import { AgentStore, newProfile } from "../../src/chats/store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "glosa-managed-state-")));
  roots.push(path);
  return path;
}
const workspaceId = "a".repeat(64);

test("retry recovers the original durable receipt and rejects a changed payload", () => {
  const path = join(root(), "journal.jsonl");
  const schema = z.object({ value: z.string() }).strict();
  const request = { id: randomUUID(), input: { value: "once" }, result: { accepted: "stable" } };
  const writer = new IntentJournal(path, schema);
  writer.append({ value: "once" }, request);
  writer.close();
  const replay = new IntentJournal(path, schema);
  expect(replay.receipt(request.id, request.input)).toEqual({ found: true, result: { accepted: "stable" } });
  expect(() => replay.receipt(request.id, { value: "twice" })).toThrow("different input");
  replay.append({ value: "once" }, request);
  expect(replay.revision).toBe(1);
  replay.close();
});

test("torn final bytes are quarantined but corrupt interior executable policy blocks replay", () => {
  const dir = root(),
    path = join(dir, "journal.jsonl");
  const schema = z.object({ value: z.string() });
  const writer = new IntentJournal(path, schema);
  writer.append({ value: "safe" });
  writer.close();
  const valid = readFileSync(path, "utf8");
  appendFileSync(path, '{"schema":');
  const repaired = new IntentJournal(path, schema);
  expect(repaired.revision).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(valid);
  repaired.close();
  writeFileSync(path, `${valid}not-json\n${valid}`);
  expect(() => new IntentJournal(path, schema)).toThrow("execution is blocked");
});

test("chat/profile replay preserves model resolution, logical identity, frozen turns and separate draft revisions", () => {
  const dir = root(),
    store = new AgentStore(dir),
    profile = newProfile("fixture", "Personal");
  store.saveProfiles([profile]);
  const legacyCapabilities = {
    models: [{ id: "sonnet", name: "Sonnet", efforts: ["high"] }],
    resume: true,
    images: true,
    questions: true,
    permissions: true,
    mcp: true,
  };
  // A pre-version-discovery record remains replayable before a refreshed record.
  store.saveCapabilities(profile.id, profile.epoch, "fixture-runtime", legacyCapabilities);
  const refreshedCapabilities = {
    ...legacyCapabilities,
    models: [{ ...legacyCapabilities.models[0]!, resolvedModel: "claude-sonnet-5" }],
  };
  store.saveCapabilities(profile.id, profile.epoch, "fixture-runtime", refreshedCapabilities);
  expect(store.savedCapabilities(profile.id)?.capabilities).toEqual(refreshedCapabilities);
  const chatId = randomUUID(),
    sessionId = randomUUID();
  const input = {
    id: chatId,
    sessionId,
    workspaceId,
    workspaceEpoch: "registration-1",
    workspacePath: dir,
    provider: "fixture",
    profileId: profile.id,
    title: "New chat",
    settings: { model: "m", effort: "high", permissionMode: "default" as const },
    origin: "managed" as const,
  };
  const requestId = randomUUID();
  const chat = store.create(input, requestId);
  expect(store.create(input, requestId).state.id).toBe(chatId);
  const textHash = chat.blob(Buffer.from("first prompt"));
  const turnId = randomUUID();
  chat.append({
    type: "turn",
    turn: {
      id: turnId,
      textHash,
      attachments: [],
      settings: input.settings,
      profileEpoch: 0,
      identityRevision: 0,
      status: "accepted",
      at: new Date().toISOString(),
      origin: "user",
    },
  });
  chat.append({ type: "content", content: { id: "answer", turnId, role: "assistant", kind: "text", text: "Hello" } });
  expect(chat.state.draftRevision).toBe(0);
  expect(() => chat.append({ type: "changed", profileId: randomUUID() })).toThrow("identity cannot change");
  store.close();
  const replay = new AgentStore(dir);
  expect(replay.savedCapabilities(profile.id)?.capabilities).toEqual(refreshedCapabilities);
  expect(replay.chat(chatId).state.sessionId).toBe(sessionId);
  expect(replay.chat(chatId).text(replay.chat(chatId).state.turns[0]?.textHash)).toBe("first prompt");
  expect(replay.list(workspaceId, "new-registration")).toEqual([]);
  expect(replay.list(workspaceId, "registration-1")).toHaveLength(1);
  replay.close();
});

test("disabling all accounts never creates an implicit default", () => {
  const store = new AgentStore(root());
  const a = newProfile("fixture", "A"),
    b = newProfile("fixture", "B");
  store.saveProfiles([{ ...a, isDefault: true }, b]);
  expect(() => store.saveProfiles([{ ...b, isDefault: true }])).toThrow("one enabled default");
  store.saveProfiles([
    { ...a, enabled: false, isDefault: false },
    { ...b, enabled: false },
  ]);
  expect(store.listProfiles().some((p) => p.isDefault)).toBe(false);
  store.close();
});

test("subscription children do not inherit provider keys, gateway overrides or preload scripts", () => {
  const env = managedEnvironment(
    {
      HOME: "/example",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "never",
      OPENAI_API_KEY: "never",
      ANTHROPIC_AUTH_TOKEN: "never",
      CLAUDE_CONFIG_DIR: "/default",
      CODEX_HOME: "/default",
      NODE_OPTIONS: "--require unwanted",
      AWS_PROFILE: "paid",
    },
    { CLAUDE_CONFIG_DIR: "/isolated" },
  );
  expect(env.HOME).toBe("/example");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/isolated");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CODEX_HOME",
    "NODE_OPTIONS",
    "AWS_PROFILE",
  ])
    expect(env[key]).toBeUndefined();
});

test("workspace purge uses durable ownership without opening another workspace's corrupt chat", () => {
  const dir = root(),
    store = new AgentStore(dir),
    profile = newProfile("fixture", "A");
  store.saveProfiles([profile]);
  const input = {
    id: randomUUID(),
    sessionId: randomUUID(),
    workspaceId,
    workspaceEpoch: "e",
    workspacePath: dir,
    provider: "fixture",
    profileId: profile.id,
    title: "A",
    settings: { model: "m", effort: "", permissionMode: "default" as const },
    origin: "managed" as const,
  };
  store.create(input, randomUUID());
  const other = { ...input, id: randomUUID(), workspaceId: "b".repeat(64) };
  store.create(other, randomUUID());
  store.close();
  const path = join(dir, "chats", other.id, "journal.jsonl");
  const bytes = readFileSync(path, "utf8");
  writeFileSync(path, `not-json\n${bytes}`);
  const replay = new AgentStore(dir);
  expect(replay.preflightPurge(workspaceId, "e")).toEqual([input.id]);
  replay.purge(workspaceId, "e");
  replay.close();
  expect(() => readFileSync(join(dir, "chats", input.id, "journal.jsonl"))).toThrow();
  expect(readFileSync(path, "utf8")).toBe(`not-json\n${bytes}`);
  const again = new AgentStore(dir);
  again.purge(workspaceId, "e");
  again.close();
});
