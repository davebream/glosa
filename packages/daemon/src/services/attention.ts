// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { sourceSha256 } from "../artifact-render.ts";
import {
  ApprovalConflictError,
  ApprovalUniquenessUnprovableError,
  type AttentionTarget,
  type AttentionVerdict,
} from "../bus/bus.ts";
import { readInboxEntry } from "../bus/inbox.ts";
import { type EntryKind, isTerminal } from "../bus/lifecycle.ts";
import { peekJournal } from "../bus/peek.ts";
import { resolveTrackedFiles } from "../matcher.ts";
import { canonicalize } from "../registry/slug.ts";
import type { WorkspaceIndex } from "../registry/workspace-index.ts";
import { confinePath } from "../security/confine-path.ts";
import { findWorkspace, type WorkspaceAccess, workspaceBus } from "./workspace-access.ts";

export interface AttentionDependencies extends WorkspaceAccess {
  workspaceRegistration: Pick<WorkspaceIndex, "upsertWorkspace" | "get">;
}

/** Bounds for the session-supplied half of a request. Each is a hard cap, not a hint: the payload
 * is written once and immutably, so an unbounded field is an unbounded file. */
export const AGENT_LABEL_MAX_BYTES = 64;
export const QUOTE_MAX_BYTES = 2048;
export const QUOTE_CONTEXT_MAX_BYTES = 256;
export const ANSWER_OPTIONS_MAX = 8;
export const ANSWER_OPTION_MAX_BYTES = 96;

export type AttentionErrorCode =
  | "invalid-workspace-path"
  | "message-too-large"
  | "action-too-large"
  | "agent-label-too-large"
  | "invalid-target"
  | "quote-too-large"
  | "invalid-answer-options"
  | "unoffered-choice"
  | "invalid-target-path"
  | "approval-target-required"
  | "approval-target-unavailable"
  | "approval-conflict"
  | "approval-uniqueness-unprovable"
  | "unknown-attention"
  | "invalid-review-outcome"
  | "invalid-generic-outcome"
  | "approval-outcome-required"
  | "approval-response-forbidden"
  | "invalid-revision"
  | "approval-target-missing"
  | "artifact-revision-changed"
  | "conflict"
  | "entry-not-found";

export class AttentionError extends Error {
  constructor(
    readonly code: AttentionErrorCode,
    readonly data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface AttentionResponseInput {
  outcome: "done" | "approved" | "changes_requested";
  response?: string;
  chose?: string;
  revisionId?: string;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Validates and normalizes a session-supplied passage anchor. Total: returns the stored shape or
 * throws a typed error, never a half-built target. Empty context strings are dropped rather than
 * stored, so a payload never carries a field that says nothing. */
function normalizeTarget(raw: unknown): AttentionTarget {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AttentionError("invalid-target");
  const quote = (raw as Record<string, unknown>).quote;
  if (quote === null || typeof quote !== "object" || Array.isArray(quote)) throw new AttentionError("invalid-target");
  const { exact, prefix, suffix } = quote as Record<string, unknown>;
  if (typeof exact !== "string" || exact.length === 0) throw new AttentionError("invalid-target");
  if (prefix !== undefined && typeof prefix !== "string") throw new AttentionError("invalid-target");
  if (suffix !== undefined && typeof suffix !== "string") throw new AttentionError("invalid-target");
  if (bytes(exact) > QUOTE_MAX_BYTES) throw new AttentionError("quote-too-large");
  if (typeof prefix === "string" && bytes(prefix) > QUOTE_CONTEXT_MAX_BYTES) {
    throw new AttentionError("quote-too-large");
  }
  if (typeof suffix === "string" && bytes(suffix) > QUOTE_CONTEXT_MAX_BYTES) {
    throw new AttentionError("quote-too-large");
  }
  return {
    quote: {
      exact,
      ...(typeof prefix === "string" && prefix.length > 0 ? { prefix } : {}),
      ...(typeof suffix === "string" && suffix.length > 0 ? { suffix } : {}),
    },
  };
}

/** Answer options are a session's own vocabulary, so they are bounded and deduplicated but never
 * rewritten. Duplicates are rejected rather than silently collapsed: two identical buttons is a
 * caller bug, and quietly dropping one would make the human's answer ambiguous. */
function normalizeAnswerOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AttentionError("invalid-answer-options");
  if (raw.length === 0 || raw.length > ANSWER_OPTIONS_MAX) throw new AttentionError("invalid-answer-options");
  const seen = new Set<string>();
  for (const option of raw) {
    if (typeof option !== "string" || option.length === 0) throw new AttentionError("invalid-answer-options");
    if (bytes(option) > ANSWER_OPTION_MAX_BYTES) throw new AttentionError("invalid-answer-options");
    if (seen.has(option)) throw new AttentionError("invalid-answer-options");
    seen.add(option);
  }
  return [...raw] as string[];
}

function entryId(): string {
  return `inb-${Math.floor(Date.now() / 1000)}-${randomBytes(2).toString("hex")}`;
}

function canonicalWorkspace(rawPath: string): string {
  try {
    const real = canonicalize(realpathSync(rawPath));
    if (!statSync(real).isDirectory()) throw new Error("not_directory");
    return real;
  } catch {
    throw new AttentionError("invalid-workspace-path");
  }
}

export function listAttention(deps: AttentionDependencies, slug: string) {
  const workspace = findWorkspace(deps, slug);
  const { state, createdAt } = peekJournal(workspace);
  const attention = Object.entries(state.entries)
    .filter(([, item]) => item.kind === "attention" && !isTerminal("attention", item.status))
    .map(([id, item]) => {
      let payload: Record<string, unknown> = {};
      try {
        const raw = readInboxEntry(workspace, id);
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) payload = raw as Record<string, unknown>;
      } catch {
        // Journal state remains authoritative when immutable payload recovery fails.
      }
      const targetPath =
        typeof payload.target_path === "string"
          ? payload.target_path
          : typeof payload.path === "string"
            ? payload.path
            : null;
      // `target` is the legacy path alias the tray already reads; the anchored passage rides
      // alongside it as `passage` so neither name has to mean two things.
      const passage =
        payload.target !== null && typeof payload.target === "object" && !Array.isArray(payload.target)
          ? (payload.target as AttentionTarget)
          : null;
      return {
        id,
        created_at: createdAt.get(id) ?? "",
        status: item.status,
        message: typeof payload.message === "string" ? payload.message : null,
        action: typeof payload.action === "string" ? payload.action : null,
        target: targetPath,
        target_path: targetPath,
        approval_mode: payload.approval_mode === true,
        agent_label: typeof payload.agent_label === "string" ? payload.agent_label : null,
        passage,
        answer_options: Array.isArray(payload.answer_options) ? (payload.answer_options as string[]) : null,
      };
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { pending_count: attention.length, attention };
}

export async function markAttentionSeen(deps: AttentionDependencies, slug: string, id: string) {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  try {
    return { id, ...(await bus.markAttentionSeen(id)) };
  } catch {
    throw new AttentionError("unknown-attention");
  }
}

export async function completeAttention(
  deps: AttentionDependencies,
  slug: string,
  id: string,
  input: AttentionResponseInput,
) {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  const entry = bus.readEntry(id);
  if (!entry || typeof entry.payload !== "object" || entry.payload === null) {
    throw new AttentionError("unknown-attention");
  }
  const payload = entry.payload as Record<string, unknown>;
  const action = payload.action;
  const approvalMode = payload.approval_mode === true;
  if (approvalMode) {
    if (input.outcome !== "approved") throw new AttentionError("approval-outcome-required");
    if (input.response !== undefined) throw new AttentionError("approval-response-forbidden");
    if (input.revisionId === undefined || !/^[a-f0-9]{64}$/.test(input.revisionId)) {
      throw new AttentionError("invalid-revision");
    }
    if (entry.status === "done") return { id, ...(await bus.completeAttention(id)) };
    const targetPath = payload.target_path;
    if (typeof targetPath !== "string") throw new AttentionError("approval-target-missing");
    const tracked = resolveTrackedFiles(bus.workspace).tracked.find((file) => file.path === targetPath);
    if (!tracked) throw new AttentionError("artifact-revision-changed", { unavailable: true });
    let currentRevision: string;
    try {
      currentRevision = sourceSha256(readFileSync(tracked.rawPath));
    } catch {
      throw new AttentionError("artifact-revision-changed", { unavailable: true });
    }
    if (currentRevision !== input.revisionId) throw new AttentionError("artifact-revision-changed");
    const verdict: AttentionVerdict = {
      outcome: "approved",
      target_path: targetPath,
      revision_id: input.revisionId,
      completed_at: new Date().toISOString(),
    };
    try {
      return { id, ...(await bus.completeAttention(id, verdict)) };
    } catch (error) {
      throw new AttentionError("conflict", { message: (error as Error).message });
    }
  }
  if (action === "review" && input.outcome === "done") throw new AttentionError("invalid-review-outcome");
  if (action !== "review" && input.outcome !== "done") throw new AttentionError("invalid-generic-outcome");
  // A chosen option must be one this request actually offered. Accepting an unlisted string would
  // let a client invent a verdict the session never wrote, which is the same class of dishonesty
  // as attributing an edit to a human who did not make it.
  if (input.chose !== undefined) {
    const offered = Array.isArray(payload.answer_options) ? (payload.answer_options as unknown[]) : [];
    if (!offered.includes(input.chose)) throw new AttentionError("unoffered-choice");
  }
  try {
    const verdict: AttentionVerdict = {
      outcome: input.outcome,
      ...(input.response !== undefined ? { response: input.response } : {}),
      ...(input.chose !== undefined ? { chose: input.chose } : {}),
    };
    return { id, ...(await bus.completeAttention(id, verdict)) };
  } catch (error) {
    throw new AttentionError("conflict", { message: (error as Error).message });
  }
}

export interface CreateAttentionInput {
  path: string;
  message?: string;
  action: string;
  targetPath?: string;
  approvalMode: boolean;
  agentLabel?: string;
  /** Raw session-supplied anchor; validated by `normalizeTarget` before it is stored. */
  target?: unknown;
  /** Raw session-supplied options; validated by `normalizeAnswerOptions` before they are stored. */
  answerOptions?: unknown;
}

export async function createAttention(deps: AttentionDependencies, input: CreateAttentionInput) {
  const root = canonicalWorkspace(input.path);
  if (input.message !== undefined && Buffer.byteLength(input.message, "utf8") > 4096) {
    throw new AttentionError("message-too-large");
  }
  if (Buffer.byteLength(input.action, "utf8") > 64) throw new AttentionError("action-too-large");
  if (input.agentLabel !== undefined && bytes(input.agentLabel) > AGENT_LABEL_MAX_BYTES) {
    throw new AttentionError("agent-label-too-large");
  }
  // Validated up front, before any workspace is registered or any entry id is minted: a rejected
  // request must leave nothing behind.
  const normalizedTarget = input.target !== undefined ? normalizeTarget(input.target) : undefined;
  const normalizedOptions = input.answerOptions !== undefined ? normalizeAnswerOptions(input.answerOptions) : undefined;
  const confinedTarget = input.targetPath !== undefined ? confinePath(root, input.targetPath) : null;
  if (input.targetPath !== undefined && !confinedTarget?.ok) throw new AttentionError("invalid-target-path");
  if (input.approvalMode && input.targetPath === undefined) throw new AttentionError("approval-target-required");

  const workspace = await deps.workspaceRegistration.upsertWorkspace(root, "glosa-open");
  const bus = await workspaceBus(deps, workspace);
  let normalizedTargetPath = input.targetPath;
  if (input.approvalMode) {
    if (!confinedTarget?.ok || !existsSync(confinedTarget.realPath)) {
      throw new AttentionError("approval-target-unavailable");
    }
    let requestedRealPath: string;
    try {
      requestedRealPath = realpathSync(confinedTarget.realPath);
    } catch {
      throw new AttentionError("approval-target-unavailable");
    }
    const match = resolveTrackedFiles(bus.workspace).tracked.find((file) => {
      try {
        return realpathSync(file.rawPath) === requestedRealPath;
      } catch {
        return false;
      }
    });
    if (!match) throw new AttentionError("approval-target-unavailable");
    normalizedTargetPath = match.path;
  }

  const id = entryId();
  try {
    await bus.createAttentionRequest(id, {
      kind: "attention_request",
      ...(input.message !== undefined ? { message: input.message } : {}),
      action: input.action,
      ...(input.approvalMode
        ? { target_path: normalizedTargetPath!, approval_mode: true }
        : input.targetPath !== undefined
          ? { path: input.targetPath }
          : {}),
      ...(input.agentLabel !== undefined ? { agent_label: input.agentLabel } : {}),
      ...(normalizedTarget !== undefined ? { target: normalizedTarget } : {}),
      ...(normalizedOptions !== undefined ? { answer_options: normalizedOptions } : {}),
    });
  } catch (error) {
    if (error instanceof ApprovalConflictError) throw new AttentionError("approval-conflict");
    if (error instanceof ApprovalUniquenessUnprovableError) {
      throw new AttentionError("approval-uniqueness-unprovable", { entries: error.entries });
    }
    throw error;
  }
  return { id, slug: workspace.slug, status: "open" as const };
}

export async function attentionEntryStatus(deps: AttentionDependencies, rawPath: string, id: string) {
  const root = canonicalWorkspace(rawPath);
  const bus = await workspaceBus(deps, deps.workspaceRegistration.get(root) ?? root);
  const state = bus.state.entries[id];
  if (!state) throw new AttentionError("entry-not-found");
  return { id, kind: state.kind, status: state.status, detail: state.detail ?? null };
}

/** The longest a single wait may hold a connection. A caller that wants longer reissues the
 * request; an unbounded hold would turn a forgotten agent turn into a socket leak. */
export const MAX_ENTRY_WAIT_MS = 15 * 60 * 1000;

export interface EntryWaitDeps {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export const realEntryWaitDeps: EntryWaitDeps = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Resolves when `id` reaches a terminal status, when `signal` aborts, or when `waitMs` elapses —
 * whichever happens first. This is what makes an agent's wait an actual block: one held request
 * woken by the journal write, rather than a client re-asking on a timer.
 *
 * The subscribe-then-recheck order is load-bearing and deliberately not the obvious one. The entry
 * can go terminal between the initial read and the subscription, and that gap would strand the
 * caller until its deadline. Subscribing FIRST and re-reading after closes it: a transition inside
 * the gap is caught by the re-read, and one after it by the listener. `bus.subscribe` delivers
 * synchronously inside the appending write's own critical section, so there is no third case.
 */
export async function waitForEntryTerminal(
  deps: AttentionDependencies,
  rawPath: string,
  id: string,
  waitMs: number,
  signal?: AbortSignal,
  timers: EntryWaitDeps = realEntryWaitDeps,
) {
  const root = canonicalWorkspace(rawPath);
  const bus = await workspaceBus(deps, deps.workspaceRegistration.get(root) ?? root);
  // The journal's own kind vocabulary, narrowed the way `lifecycle.ts` narrows it: anything
  // outside the two named kinds folds to "common", never to a guess.
  const kindOf = (raw: unknown): EntryKind =>
    raw === "attention" ? "attention" : raw === "conversation" ? "conversation" : "common";
  const read = () => {
    const state = bus.state.entries[id];
    if (!state) throw new AttentionError("entry-not-found");
    return { id, kind: state.kind, status: state.status, detail: state.detail ?? null };
  };
  const terminal = (entry: { kind?: unknown; status: string }) => isTerminal(kindOf(entry.kind), entry.status);

  const settled = read();
  if (terminal(settled) || waitMs <= 0 || signal?.aborted) {
    return { ...settled, waited: false };
  }

  return await new Promise<ReturnType<typeof read> & { waited: boolean }>((resolve) => {
    let done = false;
    const finish = (waited: boolean) => {
      if (done) return;
      done = true;
      unsubscribe();
      timers.clearTimer(timer);
      signal?.removeEventListener("abort", onAbort);
      // A terminal entry cannot become unknown, so re-reading here is always safe.
      resolve({ ...read(), waited });
    };
    const onAbort = () => finish(true);
    const unsubscribe = bus.subscribe(({ event }) => {
      if (event.entry !== id) return;
      const current = bus.state.entries[id];
      if (current && terminal(current)) finish(true);
    });
    const timer = timers.setTimer(() => finish(true), Math.min(waitMs, MAX_ENTRY_WAIT_MS));
    signal?.addEventListener("abort", onAbort, { once: true });

    const afterSubscribe = bus.state.entries[id];
    if (afterSubscribe && terminal(afterSubscribe)) finish(false);
  });
}
