// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentCapabilities,
  type AgentMcpServer,
  type AgentProfile,
  ManagedAgentError,
} from "../agents/interface.ts";
import { IntentJournal, privateDirectory, putBlob, readBlob } from "./journal.ts";

const id = z.uuid();
const text = z.string().max(32_768);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const serverBase = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
};
export const mcpServersSchema = z
  .array(
    z.discriminatedUnion("transport", [
      z
        .object({
          ...serverBase,
          transport: z.literal("stdio"),
          command: z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => value.startsWith("/") && !value.includes("\0"), "Use an absolute executable path"),
          args: z
            .array(
              z
                .string()
                .max(1024)
                .refine((value) => !value.includes("\0")),
            )
            .max(24),
        })
        .strict(),
      z
        .object({
          ...serverBase,
          transport: z.literal("http"),
          url: z
            .url()
            .max(2048)
            .refine((value) => {
              const url = new URL(value);
              return (
                ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search
              );
            }, "Use an HTTP(S) endpoint without credentials or query parameters"),
        })
        .strict(),
    ]),
  )
  .max(8)
  .refine(
    (servers) => new Set(servers.map((server) => server.id)).size === servers.length,
    "Server names must be unique",
  );
const settings = z
  .object({ model: z.string().max(160), effort: z.string().max(40), permissionMode: z.enum(["default", "plan"]) })
  .strict();
const auth = z
  .object({
    state: z.enum(["unknown", "authenticated", "needs_login", "expired", "probe_failed", "identity_mismatch"]),
    identity: z.string().max(320).optional(),
    label: z.string().max(320).optional(),
    plan: z.string().max(160).optional(),
    method: z.string().max(80).optional(),
    observedAt: z.iso.datetime(),
  })
  .strict();
const profileSchema = z
  .object({
    id,
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    label: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    revision: z.number().int().positive(),
    epoch: z.number().int().nonnegative(),
    identityRevision: z.number().int().nonnegative(),
    auth,
    removed: z.boolean(),
    cleanup: z.enum(["signout", "remove"]).optional(),
    mcpServers: mcpServersSchema.optional(),
  })
  .strict();
const capabilitiesSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            id: z.string().max(160),
            name: z.string().max(200),
            resolvedModel: z.string().min(1).max(160).optional(),
            efforts: z.array(z.string().max(40)).max(32),
          })
          .strict(),
      )
      .max(500),
    resume: z.boolean(),
    images: z.boolean(),
    questions: z.boolean(),
    permissions: z.boolean(),
    mcp: z.boolean(),
  })
  .strict();
const controlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mcp_override"),
      profileId: id,
      workspaceId: hash,
      workspaceEpoch: z.string().min(1),
      revision: z.number().int().positive(),
      servers: mcpServersSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capabilities"),
      profileId: id,
      epoch: z.number().int().nonnegative(),
      manifestId: z.string().max(256),
      capabilities: capabilitiesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("external"),
      id,
      workspaceId: hash,
      workspaceEpoch: z.string().min(1),
      sessionId: z.string().min(1).max(512),
      provider: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({ type: z.literal("chat_deleted"), chatId: id, workspaceId: hash, workspaceEpoch: z.string().min(1) })
    .strict(),
  z
    .object({ type: z.literal("chat_registered"), chatId: id, workspaceId: hash, workspaceEpoch: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("purge_planned"),
      workspaceId: hash,
      workspaceEpoch: z.string().min(1),
      chatIds: z.array(id).max(1000),
    })
    .strict(),
  z.object({ type: z.literal("profiles"), profiles: z.array(profileSchema).min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("consent"),
      profileId: id,
      workspaceId: hash,
      workspaceEpoch: z.string().min(1),
      version: z.literal(1),
      granted: z.boolean(),
      mcpDigest: z.string().max(64).optional(),
    })
    .strict(),
]);
export interface Attachment {
  name: string;
  mime: string;
  hash: string;
  size: number;
}
const attachment = z
  .object({
    name: z.string().min(1).max(240),
    mime: z.string().max(120),
    hash,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024),
  })
  .strict();
const turnStatus = z.enum([
  "accepted",
  "queued",
  "held",
  "dispatching",
  "running",
  "waiting",
  "stopping",
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);
export type TurnStatus = z.infer<typeof turnStatus>;
const turn = z
  .object({
    id,
    textHash: hash,
    attachments: z.array(attachment).max(10),
    settings,
    profileEpoch: z.number().int().nonnegative(),
    identityRevision: z.number().int().nonnegative(),
    runtimeManifestId: z.string().max(256).optional(),
    mcpDigest: z.string().max(64).optional(),
    status: turnStatus,
    at: z.iso.datetime(),
    origin: z.enum(["user", "feedback"]),
    feedbackIds: z.array(z.string().min(1).max(512)).max(8).optional(),
  })
  .strict();
export type ChatTurn = z.infer<typeof turn> & { error?: string; effective?: { model?: string; effort?: string } };
const decision = z
  .object({
    id,
    nativeId: z.string().min(1).max(512),
    generation: z.number().int().positive(),
    turnId: id,
    kind: z.enum(["permission", "question"]),
    title: z.string().max(500),
    detail: text,
    choices: z
      .array(z.object({ id: z.string().max(100), label: z.string().max(200) }).strict())
      .min(1)
      .max(32),
    allowText: z.boolean(),
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1024),
            question: z.string().min(1).max(4096),
            options: z
              .array(z.object({ label: z.string().max(500), description: z.string().max(2000).optional() }).strict())
              .max(32),
            multiple: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .optional(),
    expiresAt: z.iso.datetime(),
    status: z.enum(["pending", "reserved", "answered", "expired", "unknown"]),
  })
  .strict();
export type ChatDecision = z.infer<typeof decision>;
const content = z
  .object({
    id: z.string().min(1).max(512),
    turnId: id,
    role: z.enum(["assistant", "tool", "system"]),
    kind: z.enum(["text", "reasoning", "tool", "status"]),
    text,
    name: z.string().max(200).optional(),
    status: z.enum(["running", "completed", "failed"]).optional(),
  })
  .strict();
export type ChatContent = z.infer<typeof content>;
const created = z
  .object({
    id,
    sessionId: id,
    workspaceId: hash,
    workspaceEpoch: z.string().min(1).max(128),
    workspacePath: z.string().min(1),
    provider: z.string().min(1).max(64),
    profileId: id.optional(),
    title: z.string().min(1).max(120),
    settings,
    origin: z.enum(["managed", "external"]),
    externalSessionId: z.string().max(512).optional(),
  })
  .strict();
export const chatEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("reauthorized"),
      turnId: id,
      profileEpoch: z.number().int().nonnegative(),
      identityRevision: z.number().int().nonnegative(),
      runtimeManifestId: z.string().max(256),
      mcpDigest: z.string().max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal("created"), chat: created }).strict(),
  z
    .object({
      type: z.literal("changed"),
      title: z.string().trim().min(1).max(120).optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      settings: settings.optional(),
      provider: z.string().min(1).max(64).optional(),
      profileId: id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("draft"),
      textHash: hash,
      attachments: z.array(attachment).max(10),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn"),
      turn,
      title: z.string().trim().min(1).max(120).optional(),
      consumedDraftRevision: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("turn_status"), turnId: id, status: turnStatus, error: z.string().max(500).optional() })
    .strict(),
  z.object({ type: z.literal("content"), content }).strict(),
  z
    .object({
      type: z.literal("effective_settings"),
      turnId: id,
      model: z.string().max(160).optional(),
      effort: z.string().max(40).optional(),
    })
    .strict(),
  z.object({ type: z.literal("decision"), decision }).strict(),
  z.object({ type: z.literal("decision_status"), id, status: decision.shape.status }).strict(),
  z
    .object({
      type: z.literal("runtime"),
      runId: id,
      generation: z.number().int().positive(),
      state: z.enum(["prepared", "connected", "stopping", "stopped", "unknown"]),
      nativeId: z.string().max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      value: z.record(z.string().max(80), z.union([z.number().finite(), z.string().max(160), z.null()])),
    })
    .strict(),
  z.object({ type: z.literal("deleted") }).strict(),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
export interface ChatState extends z.infer<typeof created> {
  titleEdited?: boolean;
  revision: number;
  configRevision: number;
  draftRevision: number;
  draftHash?: string;
  draftAttachments: Attachment[];
  archived: boolean;
  pinned: boolean;
  deleted: boolean;
  updatedAt: string;
  turns: ChatTurn[];
  content: ChatContent[];
  decisions: ChatDecision[];
  runtime?: Extract<ChatEvent, { type: "runtime" }>;
  usage?: Record<string, number | string | null>;
}

function reduceChat(state: ChatState | undefined, event: ChatEvent, seq: number, at: string): ChatState {
  if (event.type === "created") {
    if (state) throw new Error("chat already created");
    return {
      ...event.chat,
      revision: seq,
      configRevision: 1,
      draftRevision: 0,
      draftAttachments: [],
      archived: false,
      pinned: false,
      deleted: false,
      updatedAt: at,
      turns: [],
      content: [],
      decisions: [],
    };
  }
  if (!state || state.deleted) throw new Error("chat unavailable");
  state.revision = seq;
  state.updatedAt = at;
  switch (event.type) {
    case "reauthorized": {
      const turn = state.turns.find((item) => item.id === event.turnId);
      if (!turn || turn.status !== "held" || turn.identityRevision !== event.identityRevision)
        throw new Error("only an undispatched held turn can renew its policy ticket");
      Object.assign(turn, {
        profileEpoch: event.profileEpoch,
        runtimeManifestId: event.runtimeManifestId,
        mcpDigest: event.mcpDigest,
      });
      break;
    }
    case "changed": {
      if (state.turns.length && (event.provider || event.profileId))
        throw new Error("started chat identity cannot change");
      const { type: _type, ...changes } = event;
      Object.assign(state, changes);
      if (event.title !== undefined) state.titleEdited = true;
      state.configRevision++;
      break;
    }
    case "draft":
      if (event.revision !== state.draftRevision + 1) throw new Error("invalid draft sequence");
      state.draftHash = event.textHash;
      state.draftAttachments = event.attachments;
      state.draftRevision = event.revision;
      break;
    case "turn":
      if (state.turns.some((t) => t.id === event.turn.id)) throw new Error("duplicate turn");
      if (event.title && !state.titleEdited && state.title === "New chat" && !state.turns.length)
        state.title = event.title;
      if (event.consumedDraftRevision !== undefined) {
        if (state.draftRevision !== event.consumedDraftRevision) throw new Error("draft changed before send");
        state.draftRevision++;
        state.draftHash = undefined;
        state.draftAttachments = [];
      }
      state.turns.push(event.turn);
      break;
    case "turn_status": {
      const target = state.turns.find((t) => t.id === event.turnId);
      if (!target) throw new Error("missing turn");
      const transitions: Record<TurnStatus, TurnStatus[]> = {
        accepted: ["queued", "held", "dispatching", "cancelled", "failed"],
        queued: ["held", "dispatching", "cancelled", "failed"],
        held: ["queued", "cancelled", "failed"],
        dispatching: ["running", "waiting", "stopping", "completed", "failed", "cancelled", "outcome_unknown"],
        running: ["waiting", "stopping", "completed", "failed", "cancelled", "outcome_unknown"],
        waiting: ["running", "stopping", "completed", "failed", "cancelled", "outcome_unknown"],
        stopping: ["cancelled", "outcome_unknown"],
        completed: [],
        failed: [],
        cancelled: [],
        outcome_unknown: [],
      };
      if (!transitions[target.status].includes(event.status)) throw new Error("invalid turn transition");
      target.status = event.status;
      target.error = event.error;
      break;
    }
    case "content": {
      if (!state.turns.some((t) => t.id === event.content.turnId)) throw new Error("missing content turn");
      const prior = state.content.find((c) => c.id === event.content.id && c.turnId === event.content.turnId);
      if (prior && event.content.kind !== "tool") prior.text += event.content.text;
      else if (prior) Object.assign(prior, event.content);
      else state.content.push(event.content);
      break;
    }
    case "effective_settings": {
      const target = state.turns.find((t) => t.id === event.turnId);
      if (!target) throw new Error("missing turn");
      target.effective = { model: event.model, effort: event.effort };
      break;
    }
    case "decision":
      if (state.decisions.some((d) => d.id === event.decision.id)) throw new Error("duplicate decision");
      state.decisions.push(event.decision);
      break;
    case "decision_status": {
      const target = state.decisions.find((d) => d.id === event.id);
      if (!target) throw new Error("missing decision");
      const allowed =
        target.status === "pending"
          ? ["reserved", "expired", "unknown"]
          : target.status === "reserved"
            ? ["answered", "unknown"]
            : [];
      if (!allowed.includes(event.status)) throw new Error("invalid decision transition");
      target.status = event.status;
      break;
    }
    case "runtime":
      if (state.runtime && event.generation < state.runtime.generation) throw new Error("stale runtime");
      state.runtime = { ...event, nativeId: event.nativeId ?? state.runtime?.nativeId };
      break;
    case "usage":
      state.usage = { ...state.usage, ...event.value };
      break;
    case "deleted":
      state.deleted = true;
      break;
  }
  return state;
}

export class ChatLog {
  readonly journal: IntentJournal<ChatEvent>;
  private stateValue?: ChatState;
  constructor(readonly root: string) {
    this.journal = new IntentJournal(join(root, "journal.jsonl"), chatEventSchema);
    try {
      for (const event of this.journal.records)
        this.stateValue = reduceChat(this.stateValue, event.data, event.seq, event.at);
    } catch {
      throw new ManagedAgentError("journal-corrupt", "Chat state cannot be replayed safely.", 503);
    }
  }
  get state(): ChatState {
    if (!this.stateValue) throw new ManagedAgentError("chat-not-found", "Chat was not found.", 404);
    return structuredClone(this.stateValue);
  }
  append(event: ChatEvent, request?: { id: string; input: unknown; result: unknown }): void {
    if (request && this.journal.receipt(request.id, request.input).found) return;
    // Validate semantic replay BEFORE persisting. The writer and reducer must agree.
    const next = reduceChat(
      structuredClone(this.stateValue),
      chatEventSchema.parse(event),
      this.journal.revision + 1,
      new Date().toISOString(),
    );
    const record = this.journal.append(event, request);
    next.updatedAt = record.at;
    this.stateValue = next;
  }
  text(hashValue?: string): string {
    return hashValue ? readBlob(join(this.root, "blobs"), hashValue).toString("utf8") : "";
  }
  blob(bytes: Uint8Array): string {
    return putBlob(join(this.root, "blobs"), bytes);
  }
}

export class AgentStore {
  readonly listeners = new Set<() => void>();
  private notify = () => {
    for (const listener of this.listeners) listener();
  };
  readonly control: IntentJournal<z.infer<typeof controlSchema>>;
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly capabilities = new Map<
    string,
    { epoch: number; manifestId: string; capabilities: AgentCapabilities }
  >();
  private readonly consents = new Map<string, boolean>();
  private readonly mcpOverrides = new Map<string, { revision: number; servers: AgentMcpServer[] | null }>();
  private readonly chats = new Map<string, ChatLog>();
  private readonly unreadable = new Set<string>();
  unreadableChatIds(): string[] {
    this.all();
    return [...this.unreadable];
  }
  private readonly deletedChats = new Map<string, { workspaceId: string; workspaceEpoch: string }>();
  private readonly associations = new Map<string, { workspaceId: string; workspaceEpoch: string }>();
  private readonly purges = new Map<string, string[]>();
  private readonly externals = new Map<string, Extract<z.infer<typeof controlSchema>, { type: "external" }>>();
  constructor(readonly root: string) {
    this.control = new IntentJournal(join(root, "control.jsonl"), controlSchema);
    this.control.listeners.add(this.notify);
    for (const record of this.control.records) this.applyControl(record.data);
  }
  private applyControl(event: z.infer<typeof controlSchema>): void {
    if (event.type === "profiles")
      for (const p of event.profiles) {
        const prior = this.profiles.get(p.id);
        if (prior && JSON.stringify(prior.mcpServers ?? []) !== JSON.stringify(p.mcpServers ?? []))
          for (const key of this.consents.keys()) if (key.startsWith(`${p.id}:`)) this.consents.set(key, false);
        this.profiles.set(p.id, p);
      }
    else if (event.type === "consent") {
      const prefix = `${event.profileId}:${event.workspaceId}:${event.workspaceEpoch}:`;
      if (!event.granted)
        for (const key of this.consents.keys()) if (key.startsWith(prefix)) this.consents.set(key, false);
      this.consents.set(`${prefix}${event.mcpDigest ?? ""}`, event.granted);
    } else if (event.type === "mcp_override")
      this.mcpOverrides.set(`${event.profileId}:${event.workspaceId}:${event.workspaceEpoch}`, event);
    else if (event.type === "capabilities") this.capabilities.set(event.profileId, event);
    else if (event.type === "external")
      this.externals.set(`${event.workspaceId}:${event.workspaceEpoch}:${event.sessionId}`, event);
    else if (event.type === "chat_registered") this.associations.set(event.chatId, event);
    else if (event.type === "purge_planned")
      this.purges.set(`${event.workspaceId}:${event.workspaceEpoch}`, event.chatIds);
    else this.deletedChats.set(event.chatId, event);
  }
  savedCapabilities(profileId: string) {
    return structuredClone(this.capabilities.get(profileId));
  }
  saveCapabilities(profileId: string, epoch: number, manifestId: string, capabilities: AgentCapabilities): void {
    const event = controlSchema.parse({ type: "capabilities", profileId, epoch, manifestId, capabilities });
    this.control.append(event);
    this.applyControl(event);
  }
  listProfiles(): AgentProfile[] {
    return structuredClone([...this.profiles.values()].filter((p) => !p.removed));
  }
  profile(profileId: string, includeRemoved = false): AgentProfile {
    const p = this.profiles.get(profileId);
    if (!p || (p.removed && !includeRemoved))
      throw new ManagedAgentError("profile-not-found", "Account was not found.", 404);
    return structuredClone(p);
  }
  saveProfiles(profiles: AgentProfile[], request?: { id: string; input: unknown; result: unknown }): void {
    if (request && this.control.receipt(request.id, request.input).found) return;
    const event = controlSchema.parse({ type: "profiles", profiles });
    const prospective = new Map(this.profiles);
    for (const p of profiles) prospective.set(p.id, p);
    const defaults = new Set<string>();
    for (const p of prospective.values()) {
      if (!p.isDefault || p.removed) continue;
      if (!p.enabled || defaults.has(p.provider))
        throw new ManagedAgentError("invalid-default", "Select at most one enabled default per agent.");
      defaults.add(p.provider);
    }
    const record = this.control.append(event, request);
    this.applyControl(record.data);
  }
  consent(profileId: string, workspaceId: string, workspaceEpoch: string, mcpDigest = ""): boolean {
    return this.consents.get(`${profileId}:${workspaceId}:${workspaceEpoch}:${mcpDigest}`) === true;
  }
  setConsent(profileId: string, workspaceId: string, workspaceEpoch: string, granted: boolean, mcpDigest = ""): void {
    const event = controlSchema.parse({
      type: "consent",
      profileId,
      workspaceId,
      workspaceEpoch,
      version: 1,
      granted,
      mcpDigest,
    });
    this.control.append(event);
    this.applyControl(event);
  }
  mcpPolicy(profileId: string, workspaceId: string, workspaceEpoch: string) {
    const override = this.mcpOverrides.get(`${profileId}:${workspaceId}:${workspaceEpoch}`);
    return {
      revision: override?.revision ?? 0,
      override: override?.servers ?? null,
      servers: structuredClone(override?.servers ?? this.profile(profileId).mcpServers ?? []),
    };
  }
  setMcpPolicy(
    profileId: string,
    workspaceId: string,
    workspaceEpoch: string,
    revision: number,
    servers: AgentMcpServer[] | null,
  ): void {
    const current = this.mcpPolicy(profileId, workspaceId, workspaceEpoch);
    if (current.revision !== revision)
      throw new ManagedAgentError(
        "stale-profile",
        "The workspace's MCP configuration changed. Refresh it before saving.",
      );
    const event = controlSchema.parse({
      type: "mcp_override",
      profileId,
      workspaceId,
      workspaceEpoch,
      revision: revision + 1,
      servers,
    });
    this.control.append(event);
    this.applyControl(event);
  }
  create(input: z.infer<typeof created>, requestId: string): ChatLog {
    const parsed = created.parse(input);
    if (this.purges.has(`${parsed.workspaceId}:${parsed.workspaceEpoch}`))
      throw new ManagedAgentError("workspace-stopping", "This workspace is being forgotten.");
    const association = this.associations.get(parsed.id);
    if (
      association &&
      (association.workspaceId !== parsed.workspaceId || association.workspaceEpoch !== parsed.workspaceEpoch)
    )
      throw new ManagedAgentError("chat-exists", "Chat already belongs to another workspace.");
    if (!association) {
      const event = {
        type: "chat_registered" as const,
        chatId: parsed.id,
        workspaceId: parsed.workspaceId,
        workspaceEpoch: parsed.workspaceEpoch,
      };
      this.control.append(event);
      this.applyControl(event);
    }
    const log = this.chat(parsed.id);
    if (log.journal.revision) {
      if (log.journal.receipt(requestId, parsed).found) return log;
      throw new ManagedAgentError("chat-exists", "Chat already exists.");
    }
    log.append({ type: "created", chat: parsed }, { id: requestId, input: parsed, result: { id: parsed.id } });
    return log;
  }
  chat(chatId: string): ChatLog {
    id.parse(chatId);
    if (this.deletedChats.has(chatId)) throw new ManagedAgentError("chat-not-found", "Chat was deleted.", 404);
    let log = this.chats.get(chatId);
    if (!log) {
      log = new ChatLog(join(this.root, "chats", chatId));
      log.journal.listeners.add(this.notify);
      this.chats.set(chatId, log);
    }
    return log;
  }
  all(): ChatState[] {
    const dir = join(this.root, "chats");
    const ids = existsSync(dir) ? readdirSync(dir).filter((value) => id.safeParse(value).success) : [];
    const result: ChatState[] = [];
    for (const chatId of new Set([...ids, ...this.chats.keys()])) {
      try {
        const state = this.chat(chatId).state;
        if (!state.deleted) result.push(state);
        this.unreadable.delete(chatId);
      } catch (error) {
        if (error instanceof ManagedAgentError && error.code === "journal-corrupt") this.unreadable.add(chatId);
        /* One corrupt chat cannot break the workspace's documents or other chats. */
      }
    }
    return result.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }
  list(workspaceId: string, workspaceEpoch: string): ChatState[] {
    return this.all().filter((chat) => chat.workspaceId === workspaceId && chat.workspaceEpoch === workspaceEpoch);
  }
  external(workspaceId: string, workspaceEpoch: string) {
    return structuredClone(
      [...this.externals.values()].filter(
        (item) =>
          item.workspaceId === workspaceId && item.workspaceEpoch === workspaceEpoch && !this.deletedChats.has(item.id),
      ),
    );
  }
  rememberExternal(workspaceId: string, workspaceEpoch: string, sessionId: string, provider: string) {
    const existing = this.external(workspaceId, workspaceEpoch).find((item) => item.sessionId === sessionId);
    if (existing) return existing;
    const event = controlSchema.parse({
      type: "external",
      id: randomUUID(),
      workspaceId,
      workspaceEpoch,
      sessionId,
      provider,
    }) as Extract<z.infer<typeof controlSchema>, { type: "external" }>;
    this.control.append(event);
    this.applyControl(event);
    return structuredClone(event);
  }
  /** A durable control tombstone precedes deletion; no transcript survives a completed purge. */
  deleteChat(chatId: string, workspaceId: string, workspaceEpoch: string): void {
    const prior = this.deletedChats.get(chatId);
    if (!prior) {
      const state = this.chat(chatId).state;
      if (state.workspaceId !== workspaceId || state.workspaceEpoch !== workspaceEpoch)
        throw new ManagedAgentError("chat-not-found", "Chat was not found.", 404);
      const event = { type: "chat_deleted" as const, chatId, workspaceId, workspaceEpoch };
      this.control.append(event);
      this.applyControl(event);
    } else if (prior.workspaceId !== workspaceId || prior.workspaceEpoch !== workspaceEpoch)
      throw new ManagedAgentError("chat-not-found", "Chat was not found.", 404);
    this.chats.get(chatId)?.journal.close();
    this.chats.delete(chatId);
    const path = join(this.root, "chats", chatId);
    if (existsSync(path)) {
      privateDirectory(path);
      rmSync(path, { recursive: true });
    }
  }
  preflightPurge(workspaceId: string, workspaceEpoch: string): string[] {
    const dir = join(this.root, "chats");
    if (existsSync(dir)) {
      privateDirectory(dir);
      for (const chatId of readdirSync(dir)) {
        if (!id.safeParse(chatId).success || (!this.associations.has(chatId) && !this.deletedChats.has(chatId)))
          throw new ManagedAgentError(
            "journal-corrupt",
            "Chat ownership must be recovered before deleting workspace data.",
            503,
          );
      }
    }
    const ids =
      this.purges.get(`${workspaceId}:${workspaceEpoch}`) ??
      [...this.associations]
        .filter(([, owner]) => owner.workspaceId === workspaceId && owner.workspaceEpoch === workspaceEpoch)
        .map(([chatId]) => chatId);
    for (const chatId of ids) {
      const path = join(dir, chatId);
      if (existsSync(path)) privateDirectory(path);
    }
    if (ids.length > 1000)
      throw new ManagedAgentError("input-too-large", "Archive fewer than 1000 chats before forgetting this workspace.");
    return [...ids];
  }
  purge(workspaceId: string, workspaceEpoch: string): void {
    const ids = this.preflightPurge(workspaceId, workspaceEpoch);
    if (!this.purges.has(`${workspaceId}:${workspaceEpoch}`)) {
      const event = { type: "purge_planned" as const, workspaceId, workspaceEpoch, chatIds: ids };
      this.control.append(event);
      this.applyControl(event);
    }
    for (const item of this.external(workspaceId, workspaceEpoch)) {
      const event = { type: "chat_deleted" as const, chatId: item.id, workspaceId, workspaceEpoch };
      this.control.append(event);
      this.applyControl(event);
    }
    const dir = join(this.root, "chats");
    for (const chatId of ids) {
      let marker = this.deletedChats.get(chatId);
      if (!marker) {
        const event = { type: "chat_deleted" as const, chatId, workspaceId, workspaceEpoch };
        this.control.append(event);
        this.applyControl(event);
        marker = event;
      }
      if (marker.workspaceId !== workspaceId || marker.workspaceEpoch !== workspaceEpoch) continue;
      this.chats.get(chatId)?.journal.close();
      this.chats.delete(chatId);
      const path = join(dir, chatId);
      if (!existsSync(path)) continue;
      privateDirectory(path);
      rmSync(path, { recursive: true });
    }
  }
  close(): void {
    this.listeners.clear();
    this.control.close();
    for (const log of this.chats.values()) log.journal.close();
  }
}

export function newProfile(provider: string, label: string): AgentProfile {
  return profileSchema.parse({
    id: randomUUID(),
    provider,
    label,
    enabled: true,
    isDefault: false,
    revision: 1,
    epoch: 0,
    identityRevision: 0,
    auth: { state: "unknown", observedAt: new Date().toISOString() },
    removed: false,
  });
}
