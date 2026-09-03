// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { sourceSha256 } from "../artifact-render.ts";
import { ApprovalConflictError, ApprovalUniquenessUnprovableError, type AttentionVerdict } from "../bus/bus.ts";
import { readInboxEntry } from "../bus/inbox.ts";
import { isTerminal } from "../bus/lifecycle.ts";
import { peekJournal } from "../bus/peek.ts";
import { confinePath } from "../confine-path.ts";
import { resolveTrackedFiles } from "../matcher.ts";
import { canonicalize } from "../registry/slug.ts";
import type { WorkspaceIndex } from "../registry/workspace-index.ts";
import { findWorkspace, type WorkspaceAccess, workspaceBus } from "./workspace-access.ts";

export interface AttentionDependencies extends WorkspaceAccess {
  workspaceRegistration: Pick<WorkspaceIndex, "upsertWorkspace" | "get">;
}

export type AttentionErrorCode =
  | "invalid-workspace-path"
  | "message-too-large"
  | "action-too-large"
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
  revisionId?: string;
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
      return {
        id,
        created_at: createdAt.get(id) ?? "",
        status: item.status,
        message: typeof payload.message === "string" ? payload.message : null,
        action: typeof payload.action === "string" ? payload.action : null,
        target: targetPath,
        target_path: targetPath,
        approval_mode: payload.approval_mode === true,
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
  try {
    const verdict: AttentionVerdict = {
      outcome: input.outcome,
      ...(input.response !== undefined ? { response: input.response } : {}),
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
}

export async function createAttention(deps: AttentionDependencies, input: CreateAttentionInput) {
  const root = canonicalWorkspace(input.path);
  if (input.message !== undefined && Buffer.byteLength(input.message, "utf8") > 4096) {
    throw new AttentionError("message-too-large");
  }
  if (Buffer.byteLength(input.action, "utf8") > 64) throw new AttentionError("action-too-large");
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
