// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { validateReferences } from "../../src/chats/references.ts";
import { managedEnvironment } from "../../src/agents/environment.ts";
import { IntentJournal } from "../../src/chats/journal.ts";
import { AgentStore, newProfile } from "../../src/chats/store.ts";
import { chatFailure } from "../../src/chats/types.ts";
import * as fs from "node:fs";

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

function storedChat() {
  const store = new AgentStore(root());
  const chat = store.create(
    {
      id: randomUUID(),
      sessionId: randomUUID(),
      workspaceId,
      workspaceEpoch: "e",
      workspacePath: store.root,
      provider: "fixture",
      title: "New chat",
      settings: { model: "m", effort: "", permissionMode: "default" },
      origin: "managed",
    },
    randomUUID(),
  );
  const turnId = randomUUID();
  chat.append({
    type: "turn",
    turn: {
      id: turnId,
      textHash: chat.blob(Buffer.from("prompt")),
      attachments: [],
      settings: chat.state.settings,
      profileEpoch: 0,
      identityRevision: 0,
      status: "accepted",
      at: new Date().toISOString(),
      origin: "user",
    },
  });
  return { store, chat, turnId };
}

test("native error details remain actionable while credentials, URL secrets and stacks are excluded", () => {
  const error = Object.assign(new Error("Internal error"), {
    data: {
      details:
        "Model is unavailable. access_token=private-token https://user:pass@example.test/login?code=private-code#secret",
    },
    cause: new Error("Request denied. Bearer private-bearer grant=private-grant"),
    details: "Native RPC detail. refresh_token=private-refresh",
  });
  const failure = chatFailure(error, { phase: "connecting", dispatchCertainty: "unsent", secrets: ["private-grant"] });
  expect(failure.title).toBe("Internal error");
  expect(failure.detail).toContain("Model is unavailable.");
  expect(failure.detail).toContain("Native RPC detail.");
  expect(failure.detail).toContain("https://example.test/login");
  for (const secret of [
    "private-token",
    "private-code",
    "private-bearer",
    "private-grant",
    "private-refresh",
    "user:pass",
    "at ",
  ])
    expect(JSON.stringify(failure)).not.toContain(secret);
});

test("a display batch is durable before notification, uses one fsync and does not clone prior history", async () => {
  const { store, chat, turnId } = storedChat();
  chat.append({
    type: "content",
    content: { id: "answer", turnId, role: "assistant", kind: "text", text: "old history" },
  });
  await Promise.resolve();
  const notifications: number[] = [];
  const before = chat.journal.revision;
  chat.journal.listeners.add((record) => {
    const replay = new IntentJournal(chat.journal.path, z.unknown());
    try {
      expect(replay.revision).toBe(before + 2);
      notifications.push(record.seq);
    } finally {
      replay.close();
    }
  });
  const sync = spyOn(fs, "fsyncSync"),
    clone = spyOn(globalThis, "structuredClone");
  try {
    chat.appendMany([
      { type: "content", content: { id: "answer", turnId, role: "assistant", kind: "text", text: " first" } },
      { type: "content", content: { id: "reasoning", turnId, role: "assistant", kind: "reasoning", text: "thought" } },
    ]);
    // This is the explicit durability and copy budget, rather than timing on a shared runner.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
    expect(chat.view.content.map((content) => content.text)).toEqual(["old history first", "thought"]);
    await Promise.resolve();
    expect(notifications).toEqual([before + 1, before + 2]);
  } finally {
    sync.mockRestore();
    clone.mockRestore();
    store.close();
  }
});

test("a failed display fsync leaves projection, receipts and subscribers at the previous durable prefix", async () => {
  const { store, chat, turnId } = storedChat();
  await Promise.resolve();
  const before = readFileSync(chat.journal.path, "utf8"),
    revision = chat.journal.revision;
  let notified = false;
  chat.journal.listeners.add(() => {
    notified = true;
  });
  const sync = spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  try {
    expect(() =>
      chat.appendMany([
        { type: "content", content: { id: "answer", turnId, role: "assistant", kind: "text", text: "not committed" } },
      ]),
    ).toThrow("Could not persist managed state");
    expect(chat.view.content).toEqual([]);
    expect(chat.journal.revision).toBe(revision);
    expect(readFileSync(chat.journal.path, "utf8")).toBe(before);
    await Promise.resolve();
    expect(notified).toBe(false);
  } finally {
    sync.mockRestore();
    store.close();
  }
});

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
  const references = [{ kind: "command" as const, id: "review", text: "/review", start: 0, end: 7 }];
  store.saveCommands("workspace-account", "revision-1", [
    { id: "review", name: "review", description: "Review writing", kind: "skill" },
  ]);
  chat.append({
    type: "draft",
    textHash: chat.blob(Buffer.from("/review draft")),
    attachments: [],
    references,
    revision: 1,
  });
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
  expect(chat.state.draftRevision).toBe(1);
  expect(() => chat.append({ type: "changed", profileId: randomUUID() })).toThrow(
    "active chat subscription cannot change",
  );
  store.close();
  const replay = new AgentStore(dir);
  expect(replay.chat(chatId).state.draftReferences).toEqual(references);
  expect(replay.savedCommands("workspace-account")?.commands[0]?.id).toBe("review");
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

test("reference validation rejects overlapping ranges, forged file labels and split Unicode characters", () => {
  expect(() => validateReferences("@a", [{ kind: "file", id: "other", text: "@a", start: 0, end: 2 }])).toThrow(
    "Select the file again",
  );
  const reference = { kind: "file" as const, id: "a", text: "@a", start: 0, end: 2 };
  expect(() => validateReferences("@a", [reference, reference])).toThrow("selected reference changed");
  expect(() => validateReferences("/😀", [{ kind: "command", id: "a", text: "/\ud83d", start: 0, end: 2 }])).toThrow(
    "selected reference changed",
  );
  expect(() =>
    validateReferences("ask /review", [{ kind: "command", id: "a", text: "/review", start: 4, end: 11 }]),
  ).toThrow("first word");
});
