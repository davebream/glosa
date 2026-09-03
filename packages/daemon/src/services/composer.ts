// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  type AgentProviderRegistry,
  type DeliveryResult,
  recordDelivery,
  type SessionBinding,
} from "../agent-provider/interface.ts";
import { buildDeliveryPresentation } from "../delivery/presentation.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import { findWorkspace, type WorkspaceAccess, workspaceBus } from "./workspace-access.ts";

export interface ComposerDependencies extends WorkspaceAccess {
  sessionRegistry: Pick<SessionRegistry, "explicitlyBoundForWorkspace" | "liveness">;
  providerRegistry?: Pick<AgentProviderRegistry, "get">;
}

export interface ComposerSendInput {
  messageId?: string;
  text: string;
  sessionHint?: string;
}

export interface ComposerResult {
  message_id: string;
  accepted: true;
  delivered: boolean;
  state: "presented" | "transport_accepted" | "failed" | "queued";
  delivery?: { via: unknown; outcome: unknown };
}

export type ComposerErrorCode =
  | "idempotency-conflict"
  | "no-bound-session"
  | "bound-session-stale"
  | "session-selection-required"
  | "delivery-unavailable"
  | "message-too-large"
  | "delivery-failed"
  | "message-not-found"
  | "internal";

export class ComposerError extends Error {
  constructor(
    readonly code: ComposerErrorCode,
    readonly data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function candidates(records: ReturnType<SessionRegistry["forWorkspace"]>) {
  return records.map((record) => ({
    session_id: record.session_id,
    provider: record.provider,
    last_active_at: record.last_active_at,
  }));
}

function resultBody(
  messageId: string,
  state: { status: string; deliveryAttempts?: unknown },
  fallback?: DeliveryResult,
): ComposerResult {
  const attempts = Array.isArray(state.deliveryAttempts)
    ? (state.deliveryAttempts as Array<Record<string, unknown>>)
    : [];
  const latest = attempts.at(-1) ?? fallback;
  const delivered =
    state.status === "delivered" ||
    (latest !== undefined && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "presented");
  return {
    message_id: messageId,
    accepted: true,
    delivered,
    state: delivered
      ? "presented"
      : latest && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "transport_accepted"
        ? "transport_accepted"
        : latest && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "failed"
          ? "failed"
          : "queued",
    ...(latest
      ? {
          delivery: {
            via: (latest as Record<string, unknown>).via,
            outcome: (latest as Record<string, unknown>).outcome,
          },
        }
      : {}),
  };
}

export async function sendComposerMessage(
  deps: ComposerDependencies,
  slug: string,
  input: ComposerSendInput,
): Promise<ComposerResult> {
  const workspace = findWorkspace(deps, slug);
  const messageId = input.messageId ?? randomUUID();
  const bus = await workspaceBus(deps, workspace);
  const existingEntry = bus.readEntry(messageId);
  let immutableTargetSession: string | undefined;
  let immutableProvider: string | undefined;

  if (existingEntry !== null) {
    const payload =
      existingEntry.payload && typeof existingEntry.payload === "object"
        ? (existingEntry.payload as Record<string, unknown>)
        : null;
    if (
      payload?.kind !== "conversation_message" ||
      payload.text !== input.text ||
      typeof payload.target_session_id !== "string" ||
      typeof payload.provider !== "string" ||
      (input.sessionHint !== undefined && input.sessionHint !== payload.target_session_id)
    ) {
      throw new ComposerError("idempotency-conflict");
    }
    immutableTargetSession = payload.target_session_id;
    immutableProvider = payload.provider;
    const state = bus.state.entries[messageId];
    if (!state) throw new ComposerError("internal");
    const current = resultBody(messageId, state);
    const latest = Array.isArray(state.deliveryAttempts) ? state.deliveryAttempts.at(-1) : undefined;
    if (state.status === "delivered" || latest?.outcome !== "failed") return current;
  }

  const allBound = deps.sessionRegistry.explicitlyBoundForWorkspace(workspace.canonical_path, { includeStale: true });
  const liveBound = allBound.filter((record) => deps.sessionRegistry.liveness(record.session_id) === "alive");
  if (allBound.length === 0) {
    throw new ComposerError("no-bound-session", {
      recovery: "Start or resume an agent session and bind it to this workspace.",
    });
  }
  if (liveBound.length === 0) {
    throw new ComposerError("bound-session-stale", { recovery: "Resume the bound agent session and try again." });
  }

  let target = immutableTargetSession
    ? liveBound.find((record) => record.session_id === immutableTargetSession && record.provider === immutableProvider)
    : input.sessionHint
      ? liveBound.find((record) => record.session_id === input.sessionHint)
      : undefined;
  if (immutableTargetSession && !target) {
    throw new ComposerError("bound-session-stale", {
      title: "the target session is not live",
      recovery: "Resume the originally targeted agent session and try again.",
    });
  }
  if (!immutableTargetSession && input.sessionHint && !target) {
    throw new ComposerError("session-selection-required", {
      title: "the selected session is not a live binding",
      candidates: candidates(liveBound),
    });
  }
  if (!target && liveBound.length > 1) {
    throw new ComposerError("session-selection-required", { candidates: candidates(liveBound) });
  }
  target ??= liveBound[0];
  if (!target) {
    throw new ComposerError("bound-session-stale", {
      title: "the selected session is not live",
      candidates: candidates(liveBound),
    });
  }

  const provider = deps.providerRegistry?.get(target.provider);
  if (!provider) {
    throw new ComposerError("delivery-unavailable", { provider: target.provider, retryable: true });
  }

  const payload = {
    kind: "conversation_message",
    text: input.text,
    target_session_id: target.session_id,
    provider: target.provider,
  } as const;
  const preview = buildDeliveryPresentation(messageId, payload, { status: "pending" });
  if (!preview || preview.bytes > 16 * 1024) {
    throw new ComposerError("message-too-large", { max_bytes: 16 * 1024 });
  }
  if (existingEntry === null) {
    await bus.createEntry(messageId, payload, { idem: `conversation:${messageId}:created` });
  }

  const session: SessionBinding = {
    session_id: target.session_id,
    workspace: target.workspace_binding as string,
    source: target.source,
    ...(target.transcript_path ? { transcript_path: target.transcript_path } : {}),
  };
  let delivery: DeliveryResult;
  try {
    const deliverable = buildDeliveryPresentation(messageId, payload, { status: "pending" });
    if (!deliverable) throw new Error("invalid_conversation_message");
    delivery = await provider.deliver(session, deliverable);
  } catch {
    delivery = { via: "gate", outcome: "failed", error: "provider_delivery_failed" };
  }
  if (delivery.outcome === "failed") delivery = { ...delivery, error: "provider_delivery_failed" };
  const priorAttempts = bus.state.entries[messageId]?.deliveryAttempts;
  const attemptCount = Array.isArray(priorAttempts) ? priorAttempts.length : 0;
  const latestRecorded = Array.isArray(priorAttempts) ? priorAttempts.at(-1) : undefined;
  if (
    bus.state.entries[messageId]?.status !== "delivered" &&
    (latestRecorded?.via !== delivery.via || latestRecorded?.outcome !== delivery.outcome)
  ) {
    await recordDelivery(bus, messageId, session, delivery, {
      durable: true,
      idem: `conversation:${messageId}:delivery:${attemptCount + 1}`,
    });
  }

  const state = bus.state.entries[messageId];
  if (!state) throw new ComposerError("internal");
  const body = resultBody(messageId, state, delivery);
  if (delivery.outcome === "failed") throw new ComposerError("delivery-failed", { ...body, retryable: true });
  return body;
}

export async function composerMessageStatus(
  deps: ComposerDependencies,
  slug: string,
  messageId: string,
): Promise<ComposerResult> {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  const record = bus.readEntry(messageId);
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).kind !== "conversation_message") {
    throw new ComposerError("message-not-found");
  }
  const state = bus.state.entries[messageId];
  if (!state) throw new ComposerError("message-not-found");
  return resultBody(messageId, state);
}
