// SPDX-License-Identifier: Apache-2.0
// Product-scoped MCP stdio server: durable inbox pull/get, metadata, session bind,
// delivery acknowledgement, and the Codex app-server attachment.

import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  JSONRPCMessage,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import { type GlosaApiClient, isApiError } from "./api-client.ts";
import type { DaemonClient, DrainResult } from "./daemon-client.ts";
import {
  askInputSchema,
  askOutputSchema,
  deliveryAckInputSchema,
  deliveryAckOutputSchema,
  inboxGetInputSchema,
  inboxGetOutputSchema,
  inboxPullInputSchema,
  inboxPullOutputSchema,
  metadataClearInputSchema,
  metadataClearOutputSchema,
  metadataSetInputSchema,
  metadataSetOutputSchema,
  metadataShowInputSchema,
  metadataShowOutputSchema,
  presentInputSchema,
  presentOutputSchema,
  sessionBindInputSchema,
  sessionBindOutputSchema,
  watchInputSchema,
  watchOutputSchema,
} from "./mcp-schemas.ts";
import { runOpenPresentation } from "./open-presentation.ts";
import { realRequestReviewDeps, runRequestReview } from "./request-review.ts";
import { CLI_VERSION } from "./version.ts";

interface PendingAck {
  client: DaemonClient;
  sessionId: string;
  deliveryId: string;
}

/** #153 Part 2: a watch ack is shaped differently from a drain delivery ack (a set of entry ids,
 * not one reservation token) but reaches stdout through the exact same `DeliveryAwareTransport`
 * boundary, so it shares `DeliveryAcknowledgements`' pending map rather than growing a second,
 * parallel bookkeeping structure. */
interface PendingWatchAck {
  apiClient: GlosaApiClient;
  sessionId: string;
  entryIds: string[];
}

export interface McpDeps {
  /**
   * `signal`, when given, is the shutdown owner's abort signal — bind it into the created
   * client so in-flight and future calls on that client reject when shutdown starts. Ordinary
   * (non-shutdown) calls are unaffected: the signal never fires until shutdown begins.
   */
  createDaemonClient: (signal?: AbortSignal) => Promise<DaemonClient>;

  createApiClient: (signal?: AbortSignal) => Promise<GlosaApiClient>;
  cwd?: () => string;
  sessionId?: () => string | undefined;
  session?: (provider?: string) => { session_id: string; provider: string; cwd: string } | null;
  startCodexAttachment?: (
    options: { sessionId: string; workspace: string; cwd: string },
    signal: AbortSignal,
  ) => Promise<void>;
}

export const GLOSA_MCP_TOOL_NAMES = [
  "glosa_inbox_pull",
  "glosa_inbox_get",
  "glosa_metadata_set",
  "glosa_metadata_show",
  "glosa_metadata_clear",
  "glosa_session_bind",
  "glosa_delivery_ack",
  "glosa_present",
  "glosa_ask",
  "glosa_watch",
] as const;

const readOnlyClosedWorld = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;

function stateChangingClosedWorld(options: { destructiveHint: boolean; idempotentHint: boolean }) {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructiveHint,
    idempotentHint: options.idempotentHint,
    openWorldHint: false,
  } as const;
}

/** MCP structuredContent plus JSON text fallback; inbox tools keep actionable presentation text. */
function toolResult(structuredContent: Record<string, unknown>, presentationText?: string): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (presentationText !== undefined) content.push({ type: "text", text: presentationText });
  content.push({ type: "text", text: JSON.stringify(structuredContent) });
  return { content, structuredContent };
}

function responseId(message: JSONRPCMessage): RequestId | undefined {
  if (!("id" in message) || (!("result" in message) && !("error" in message))) return undefined;
  return message.id;
}

function responseSucceeded(message: JSONRPCMessage): boolean {
  if (!("result" in message)) return false;
  const result = message.result;
  return (
    typeof result !== "object" ||
    result === null ||
    !("isError" in result) ||
    (result as { isError?: unknown }).isError !== true
  );
}

class DeliveryAcknowledgements {
  private readonly pending = new Map<RequestId, PendingAck>();
  private readonly pendingWatch = new Map<RequestId, PendingWatchAck>();

  reserve(requestId: RequestId, ack: PendingAck, signal: AbortSignal): void {
    this.pending.set(requestId, ack);
    signal.addEventListener(
      "abort",
      () => {
        void this.failed(requestId, "MCP request cancelled before its response was written").catch(() => {});
      },
      { once: true },
    );
  }

  /** #153 Part 2 (W4): registers `glosa_watch`'s pending `presented` ack, reached the SAME way a
   * drain delivery's is — through `DeliveryAwareTransport.send` after a successful stdout write.
   * A cancelled request records `failed` for the exact ids the watch response named, mirroring
   * `reserve`'s own cancellation handling. */
  reserveWatch(requestId: RequestId, ack: PendingWatchAck, signal: AbortSignal): void {
    this.pendingWatch.set(requestId, ack);
    const cancelled = () => {
      void this.watchFailed(requestId, "MCP request cancelled before its response was written").catch(() => {});
    };
    signal.addEventListener("abort", cancelled, { once: true });
    // A signal that aborted BEFORE this listener was attached calls nothing, and the reservation
    // would then sit pending forever rather than recording the `failed` it owes (review round 6).
    // Re-checked after registration, which is the same shape `services/watch.ts` uses for its own
    // listener gap.
    if (signal.aborted) cancelled();
  }

  private async watchPresented(requestId: RequestId): Promise<void> {
    const ack = this.pendingWatch.get(requestId);
    if (!ack) return;
    this.pendingWatch.delete(requestId);
    await ack.apiClient.watchAck?.(ack.sessionId, ack.entryIds, "presented");
  }

  private async watchFailed(requestId: RequestId, reason: string): Promise<void> {
    const ack = this.pendingWatch.get(requestId);
    if (!ack) return;
    this.pendingWatch.delete(requestId);
    await ack.apiClient.watchAck?.(ack.sessionId, ack.entryIds, "failed", reason);
  }

  async presented(requestId: RequestId): Promise<void> {
    const ack = this.pending.get(requestId);
    if (ack) {
      this.pending.delete(requestId);
      await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "presented");
      return;
    }
    await this.watchPresented(requestId);
  }

  async failed(requestId: RequestId, reason: string): Promise<void> {
    const ack = this.pending.get(requestId);
    if (ack) {
      this.pending.delete(requestId);
      await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "failed", reason);
      return;
    }
    await this.watchFailed(requestId, reason);
  }

  async failAll(reason: string): Promise<void> {
    await Promise.allSettled([
      ...[...this.pending.keys()].map((requestId) => this.failed(requestId, reason)),
      ...[...this.pendingWatch.keys()].map((requestId) => this.watchFailed(requestId, reason)),
    ]);
  }
}

/**
 * The SDK owns protocol framing. This decorator owns only glosa's durability boundary: a prepared
 * inbox delivery becomes presented after the corresponding JSON-RPC response reaches stdout.
 */
class DeliveryAwareTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;

  constructor(
    private readonly inner: Transport,
    private readonly acknowledgements: DeliveryAcknowledgements,
  ) {
    this.sessionId = inner.sessionId;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const requestId = responseId(message);
    try {
      await this.inner.send(message, options);
    } catch (error) {
      if (requestId !== undefined) {
        await this.acknowledgements
          .failed(requestId, error instanceof Error ? error.message : String(error))
          .catch(() => {});
      }
      throw error;
    }
    if (requestId === undefined) return;
    if (responseSucceeded(message)) {
      await this.acknowledgements.presented(requestId);
    } else {
      await this.acknowledgements.failed(requestId, "MCP tool response reported an error");
    }
  }

  async close(): Promise<void> {
    await this.acknowledgements.failAll("MCP transport closed before its response was written");
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}

/**
 * The SDK's stdio transport owns parsing and lifecycle. Its stock send resolves from write()
 * backpressure alone, though, so use the SDK serializer with a write callback to make a broken
 * stdout observable by DeliveryAwareTransport before glosa acknowledges presentation.
 */
class WriteConfirmedStdioServerTransport extends StdioServerTransport {
  private readonly handleOutputError = (error: Error) => this.onerror?.(error);

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    super(input, output);
  }

  override async start(): Promise<void> {
    this.output.on("error", this.handleOutputError);
    await super.start();
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  override async close(): Promise<void> {
    this.output.off("error", this.handleOutputError);
    await super.close();
  }
}

export interface GlosaMcpServer {
  server: McpServer;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/**
 * The shim's one total shutdown deadline (issue #140), entered by stdin EOF, SIGHUP, or the
 * parent poll noticing reparenting. Bounds intake stop and both clients' in-flight and pending
 * calls; when it expires the process ends anyway so no path can outlive it. Sized like `MCP_PUSH_MIN_DELAY_MS`: generous for an aborted fetch to unwind locally, far
 * short of anything a caller would perceive as a hang.
 */
export const MCP_SHUTDOWN_BUDGET_MS = 5_000;

/**
 * How often `runMcpServer` checks whether its real parent has changed. The poll cannot use
 * `process.ppid`: Bun resolves it once, on its first read, and returns that same value forever
 * after — so it can report the parent this process started with, but never that it changed.
 * Orphan detection therefore reads the live value from the OS via `getppid(2)`; see
 * `liveParentPid`.
 */
export const MCP_PARENT_POLL_MS = 1_000;

/** The pid every orphaned process is reparented to on macOS: launchd. */
export const REAPER_PID = 1;

const libSystem = dlopen("libSystem.B.dylib", { getppid: { args: [], returns: FFIType.i32 } });

/** The OS's current parent pid, read fresh every call — unlike `process.ppid` (see
 * `MCP_PARENT_POLL_MS`), this observes reparenting to launchd once the real host process exits. */
function liveParentPid(): number {
  return libSystem.symbols.getppid();
}

export function createMcpServer(deps: McpDeps): GlosaMcpServer {
  // Bound into every client an active tool handler creates. It fires immediately when shutdown
  // starts, so ordinary calls are unaffected until then; once it fires, in-flight and future calls
  // on those clients reject instead of hanging — this is what cancels a mid-flight `glosa_ask`
  // long poll or a stuck tool call. It is not the only thing that ends a hold: `glosa_ask` and
  // `glosa_watch` additionally bind their held read to the request's OWN cancellation, which
  // shutdown does not subsume — a client can give up on one call without the shim going away.
  const shutdownAbort = new AbortController();
  // Every currently-running tool call's whole lifecycle — registration/heartbeat included, not
  // just the handler — keyed by its own promise. `close()` waits for this set to drain (after
  // gating intake and aborting `shutdownAbort`) instead of abandoning in-flight work mid-request.
  const activeCalls = new Set<Promise<unknown>>();
  // Gated atomically, as `close()`'s own first statement — see `wrapped` below for why that
  // ordering is what makes the gate and the `activeCalls` snapshot agree with each other.
  let intakeClosed = false;
  const syntheticId = `mcp-${process.pid}-${randomUUID()}`;
  let explicitlyBound: { session_id: string; provider: string; cwd: string } | null = null;
  const host = (provider?: string) =>
    deps.session?.(provider) ??
    (explicitlyBound && (!provider || explicitlyBound.provider === provider) ? explicitlyBound : null) ??
    (deps.sessionId?.() ? { session_id: deps.sessionId()!, provider: "mcp", cwd: (deps.cwd ?? process.cwd)() } : null);
  const identity = (requested?: string, provider?: string, genericWorkspace?: string) => {
    const current = host(provider);
    if (current && requested && requested !== current.session_id)
      throw new Error("session_id does not match the MCP host session");
    if (current && provider && current.provider !== "mcp" && provider !== current.provider)
      throw new Error("provider does not match the MCP host session");
    return {
      session_id: current?.session_id ?? requested ?? syntheticId,
      provider: provider ?? current?.provider ?? "mcp",
      cwd: current?.cwd ?? (!requested ? genericWorkspace : undefined) ?? (deps.cwd ?? process.cwd)(),
    };
  };
  const registrations = new Map<string, Promise<void>>();
  const registered = new Map<string, string>();
  const ensureSession = async (requested?: string, provider?: string, genericWorkspace?: string) => {
    const session = identity(requested, provider, genericWorkspace);
    const registrationKey = JSON.stringify([session.provider, session.cwd]);
    // Serialize only activity for this identity; unrelated tool execution remains concurrent.
    const prior = registrations.get(session.session_id) ?? Promise.resolve();
    const activity = prior
      .catch(() => {})
      .then(async () => {
        const client = await deps.createDaemonClient(shutdownAbort.signal);
        if (registered.get(session.session_id) === registrationKey) {
          try {
            await client.heartbeat(session.session_id);
            return;
          } catch (error) {
            if (!isApiError(error) || error.status !== 404) throw error;
          }
        }
        await client.register({ ...session, source: "mcp" });
        registered.set(session.session_id, registrationKey);
      });
    registrations.set(session.session_id, activity);
    try {
      await activity;
    } finally {
      if (registrations.get(session.session_id) === activity) registrations.delete(session.session_id);
    }
  };
  const acknowledgements = new DeliveryAcknowledgements();
  let codexAttachAbort: AbortController | null = null;
  const codexAttachTasks = new Set<Promise<void>>();

  const server = new McpServer(
    { name: "glosa", version: CLI_VERSION },
    {
      instructions:
        "glosa monitor lines begin with [glosa <entry-id>]. Immediately call glosa_delivery_ack for that entry id before acting.",
    },
  );

  function registerTool<I extends z.ZodType, O extends z.ZodType>(
    name: string,
    config: Parameters<typeof server.registerTool<O, I>>[1],
    handler: (
      args: z.output<I>,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => Promise<CallToolResult>,
  ) {
    const wrapped = (args: z.output<I>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      // Checked and added to `activeCalls` synchronously, with no `await` in between — `close()`
      // sets `intakeClosed` as its own first, synchronous statement, so there is no interleaving
      // in which a request reads `intakeClosed === false` here but still lands outside the
      // snapshot `close()` later drains. A request either sees the gate and is rejected before it
      // does anything (no registration, no heartbeat), or is tracked for its whole lifetime.
      if (intakeClosed) return Promise.reject(new Error("glosa mcp is shutting down"));
      const hints = args as { session_id?: string; provider?: string; workspace?: string };
      const call = (async () => {
        await ensureSession(
          hints.session_id,
          hints.provider,
          name === "glosa_inbox_pull" ? hints.workspace : undefined,
        );
        return handler(args, extra);
      })();
      activeCalls.add(call);
      call.finally(() => activeCalls.delete(call)).catch(() => {});
      return call;
    };
    return server.registerTool(name, config, wrapped as ToolCallback<I>);
  }

  registerTool(
    "glosa_inbox_pull",
    {
      title: "Pull glosa inbox",
      description:
        "Pull the oldest pending actionable glosa inbox entries across the active session's routable workspaces (at most eight globally). Reserves delivery briefly; successful stdio write acknowledges presentation.",
      inputSchema: inboxPullInputSchema,
      outputSchema: inboxPullOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Pull glosa inbox" },
    },
    async ({ limit = 8, session_id: requestedSession, workspace }, extra) => {
      const hostSession = host()?.session_id;
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      // The generic path only: no host session bound AND no explicit session_id requested — the
      // one identity() rung where `workspace` decides `cwd` at all (issue #205). Every other pull
      // keeps calling `drain` exactly as before; only this rung's scope is even reachable to send.
      const generic = !hostSession && !requestedSession;
      const session = identity(requestedSession, undefined, generic ? workspace : undefined);
      const sessionId = session.session_id;
      const client = await deps.createDaemonClient(shutdownAbort.signal);
      // Sends the SAME cwd this call's own `ensureSession` registered (or re-registered) —
      // captured here rather than re-read from the registry row, which a concurrent generic pull
      // sharing this shim's one synthetic session id can legitimately move before this drain
      // reaches the daemon (contract "shape B"). No lock: the design stage rejected shim-local
      // serialization as insufficient, since the session id is not process-exclusive on the wire.
      const drained: DrainResult = generic
        ? await client.drainScoped(sessionId, { workspace: session.cwd, limit })
        : await client.drain(sessionId, { via: "mcp_pull", limit });
      const text =
        drained.count > 0 ? formatPresentationBatch(drained.drained) : "glosa inbox: no pending actionable entries";
      const structuredContent = {
        entries: drained.drained,
        count: drained.count,
        has_more: drained.has_more ?? false,
      };
      if (drained.delivery_id) {
        acknowledgements.reserve(
          extra.requestId,
          {
            client,
            sessionId,
            deliveryId: drained.delivery_id,
          },
          extra.signal,
        );
      }
      return toolResult(structuredContent, text);
    },
  );

  registerTool(
    "glosa_inbox_get",
    {
      title: "Get glosa inbox entry",
      description:
        "Retrieve one durable inbox entry presentation by id, optionally continuing from a truncation cursor. Does not perform delivery drain.",
      inputSchema: inboxGetInputSchema,
      outputSchema: inboxGetOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Get glosa inbox entry" },
    },
    async ({ id, cursor, workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const retrieved = await (await deps.createApiClient(shutdownAbort.signal)).getInboxPresentation(root, id, cursor);
      const structuredContent = { presentation: retrieved.presentation };
      return toolResult(structuredContent, retrieved.presentation.text);
    },
  );

  registerTool(
    "glosa_metadata_set",
    {
      title: "Set workspace metadata",
      description:
        "Register or replace this integration's WorkspaceMetadataDescriptor v1 for a workspace. Same id replaces atomically; a different id conflicts until clear.",
      inputSchema: metadataSetInputSchema,
      outputSchema: metadataSetOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Set workspace metadata",
      },
    },
    async ({ metadata, workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const structuredContent = await (await deps.createApiClient(shutdownAbort.signal)).setMetadata!(
        root,
        metadata as WorkspaceMetadataDescriptor,
      );
      return toolResult(structuredContent);
    },
  );

  registerTool(
    "glosa_metadata_show",
    {
      title: "Show workspace metadata",
      description:
        "Show the active declarative WorkspaceMetadataDescriptor for a workspace, or null when none is registered.",
      inputSchema: metadataShowInputSchema,
      outputSchema: metadataShowOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Show workspace metadata" },
    },
    async ({ workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const metadata = await (await deps.createApiClient(shutdownAbort.signal)).getMetadata!(root);
      return toolResult({ metadata });
    },
  );

  registerTool(
    "glosa_metadata_clear",
    {
      title: "Clear workspace metadata",
      description: "Clear the active declarative workspace metadata for a workspace.",
      inputSchema: metadataClearInputSchema,
      outputSchema: metadataClearOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: true, idempotentHint: true }),
        title: "Clear workspace metadata",
      },
    },
    async ({ workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const structuredContent = await (await deps.createApiClient(shutdownAbort.signal)).clearMetadata!(root);
      return toolResult(structuredContent);
    },
  );

  registerTool(
    "glosa_session_bind",
    {
      title: "Bind agent session",
      description:
        "Register or refresh an agent session and explicitly bind it to a workspace (authoritative routing).",
      inputSchema: sessionBindInputSchema,
      outputSchema: sessionBindOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Bind agent session",
      },
    },
    async ({ session_id: sessionId, workspace, provider }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const session = identity(sessionId, provider);
      const structuredContent = await (await deps.createApiClient(shutdownAbort.signal)).bindSession!(root, sessionId, {
        provider: session.provider,
        cwd: session.cwd,
        source: "mcp",
      });
      explicitlyBound = session;
      if (session.provider === "codex" && deps.startCodexAttachment) {
        codexAttachAbort?.abort();
        const attachAbort = new AbortController();
        codexAttachAbort = attachAbort;
        const signal = AbortSignal.any([shutdownAbort.signal, attachAbort.signal]);
        const task = deps.startCodexAttachment({ sessionId, workspace: root, cwd: session.cwd }, signal);
        codexAttachTasks.add(task);
        task
          .finally(() => {
            codexAttachTasks.delete(task);
            if (codexAttachAbort === attachAbort) codexAttachAbort = null;
          })
          .catch(() => {});
      }
      return toolResult(structuredContent);
    },
  );

  registerTool(
    "glosa_delivery_ack",
    {
      title: "Acknowledge pushed glosa entry",
      description:
        "Acknowledge that a glosa monitor entry reached this agent context. Use the entry id from the [glosa <entry-id>] line prefix.",
      inputSchema: deliveryAckInputSchema,
      outputSchema: deliveryAckOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Acknowledge pushed entry",
      },
    },
    async ({ entry_id: entryId, session_id: requestedSession }) => {
      const hostSession = host()?.session_id;
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const sessionId = hostSession ?? requestedSession;
      if (!sessionId) {
        throw new Error("glosa_delivery_ack requires an explicit session_id when the MCP host does not provide one");
      }
      const client = await deps.createDaemonClient(shutdownAbort.signal);
      if (!client.acknowledgePushed) throw new Error("pushed-entry acknowledgement is unavailable");
      await client.acknowledgePushed(sessionId, entryId, "presented");
      return toolResult({ entry_id: entryId, presented: true });
    },
  );

  registerTool(
    "glosa_present",
    {
      title: "Present an artifact",
      description:
        "Register/open an absolute file path and return a ready SPA URL. Never launches a browser. mode preview is preview-locked and session-independent; annotate/edit select an unlocked initial mode and bind the MCP host session or explicit session_id.",
      inputSchema: presentInputSchema,
      outputSchema: presentOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Present an artifact",
      },
    },
    async ({ path, mode, session_id: requestedSession }) => {
      const hostSession = host()?.session_id;
      const readLock = mode === "read";
      if (!readLock && hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const bindSessionId = readLock ? undefined : (hostSession ?? requestedSession);
      const result = await runOpenPresentation(
        path,
        undefined,
        "document",
        {
          createClient: () => deps.createApiClient(shutdownAbort.signal),
          ensureToken,
          glosaHome,
          openBrowser: () => {
            throw new Error("glosa_present must never launch a browser");
          },
          platform: () => process.platform,
          dirExists: (dir) => {
            try {
              return existsSync(dir) && lstatSync(dir).isDirectory();
            } catch {
              return false;
            }
          },
          fileExists: (p) => {
            try {
              return existsSync(p) && lstatSync(p).isFile();
            } catch {
              return false;
            }
          },
          isRegularFile: (p) => {
            try {
              const st = lstatSync(p);
              return st.isFile() && !st.isSymbolicLink();
            } catch {
              return false;
            }
          },
        },
        {
          launchBrowser: false,
          usePresentationToken: true,
          readLock,
          mode,
          bindSessionId,
        },
      );
      if (!result.ok) {
        throw new Error(result.error?.message ?? "glosa_present failed");
      }
      const data = result.data;
      if (
        !data.url ||
        !data.slug ||
        !data.path ||
        data.surface === undefined ||
        data.mode === undefined ||
        data.preview === undefined
      ) {
        throw new Error("glosa_present returned an incomplete presentation payload");
      }
      if (data.url.includes("#t=") || /[?&#]t=/.test(data.url)) {
        throw new Error("glosa_present must not return the durable pairing token");
      }
      return toolResult({
        url: data.url,
        slug: data.slug,
        path: data.path,
        ...(data.focus ? { focus: data.focus } : {}),
        surface: data.surface,
        mode: data.mode,
        preview: data.preview,
        ...(data.bound_session ? { bound_session: data.bound_session } : {}),
        ...(data.state_dir ? { state_dir: data.state_dir } : {}),
        warnings: result.warnings,
      });
    },
  );

  registerTool(
    "glosa_ask",
    {
      title: "Ask the human about a passage",
      description:
        "Mark a passage in an artifact and ask the human about it, in their margin, beside the words. BLOCKS " +
        "until they answer — this is a real wait, not a queued notification, so use it when you genuinely " +
        "cannot proceed without the answer. Omit `question` to point at a passage without asking anything; " +
        "that returns immediately. Supply `options` when the answer is one of a few things you can name, and " +
        "leave them out when it is open-ended; the human always keeps a free-text field either way. " +
        "If your call is cancelled before the human answers, the question is withdrawn from their margin — " +
        "nobody is waiting on it any more. A wait that merely runs out leaves it in place.",
      inputSchema: askInputSchema,
      outputSchema: askOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: false }),
        title: "Ask the human about a passage",
      },
    },
    async ({ workspace, path, question, quote, options, label, wait_seconds: waitSeconds }, extra) => {
      const dir = workspace ?? (deps.cwd ?? process.cwd)();
      // Same shape as glosa_watch below: the request's own cancellation has to reach the HELD
      // entry-status read, not only shutdown. Without it the shim keeps waiting out the rest of
      // `wait_seconds` after the client has stopped listening, holding its slot in `activeCalls`.
      const requestScope = AbortSignal.any(
        [shutdownAbort.signal, extra.signal].filter((signal): signal is AbortSignal => !!signal),
      );
      // One client for the whole call, bound to SHUTDOWN only — deliberately not to `requestScope`.
      // The withdrawal below runs after that scope has aborted, so a client bound to it could not
      // make the call at all, and a cancel landing mid-creation would leave no id to withdraw.
      // Memoised rather than created eagerly so `runRequestReview` keeps owning the
      // daemon-unreachable envelope its own `createClient()` failure produces.
      let apiClient: Promise<GlosaApiClient> | undefined;
      const createClient = () => (apiClient ??= deps.createApiClient(shutdownAbort.signal));
      const result = await runRequestReview(
        {
          dir,
          path,
          ...(question !== undefined ? { message: question } : {}),
          // Neither `approved` nor `changes_requested` is true of "the human answered a
          // question", and action `review` forces one of them. So a question is action `ask`,
          // which completes with `done` and asserts no verdict nobody gave; a bare pointer is
          // `point`, for the same reason. `review` stays what `glosa request-review` means.
          action: question === undefined ? "point" : "ask",
          ...(label !== undefined ? { agentLabel: label } : {}),
          ...(quote !== undefined ? { target: { quote } } : {}),
          ...(options !== undefined ? { answerOptions: options } : {}),
          // No question, no wait: pointing is a side effect, not a request for something back.
          ...(question === undefined ? {} : { waitMs: (waitSeconds ?? 600) * 1000 }),
        },
        realRequestReviewDeps(createClient, requestScope),
      );

      if (!result.ok && result.error?.kind !== "review_timeout") {
        throw new Error(result.error?.message ?? "glosa_ask failed");
      }
      const id = result.data.id;
      if (!id) throw new Error("glosa_ask did not create a request");
      if (question === undefined) return toolResult({ id, outcome: "posted", anchored: true });

      // Cancelled, not merely elapsed: the human told the agent to stop, so the question goes with
      // it — a question nobody will ever read is clutter that today can only be cleared by
      // answering it. Shutdown deliberately does NOT withdraw: see `close()` below on why this
      // shim must not put its bearer on the wire to an endpoint resolved earlier in the session.
      if (result.error?.kind === "review_timeout" && extra.signal?.aborted && !shutdownAbort.signal.aborted) {
        // The session `ensureSession` registered for this call: host session, explicit binding, or
        // this shim's own synthetic id.
        const session = identity().session_id;
        try {
          await (await createClient()).withdrawAttention?.(dir, id, session);
        } catch {
          // Best effort. A daemon that has gone away leaves the question open — the same gap
          // shutdown and a crash already leave, documented in A6 §F26 rather than papered over.
        }
        return toolResult({ id, outcome: "withdrawn", anchored: quote !== undefined });
      }

      const detail = result.data.detail;
      const answer = detail && "response" in detail && typeof detail.response === "string" ? detail.response : "";
      const chose = detail && "chose" in detail && typeof detail.chose === "string" ? detail.chose : undefined;
      // The three endings are genuinely different and the caller has to be able to tell them
      // apart: an answer, an explicit "I can't", and a wait that ran out with the question still
      // sitting in the margin. Collapsing the last two would have the agent report that the human
      // declined when nobody ever saw the question.
      const outcome =
        result.error?.kind === "review_timeout" ? "unanswered" : answer.length > 0 || chose ? "answered" : "declined";
      return toolResult({
        id,
        outcome,
        ...(answer.length > 0 ? { answer } : {}),
        ...(chose ? { chose } : {}),
        anchored: quote !== undefined,
      });
    },
  );

  registerTool(
    "glosa_watch",
    {
      title: "Watch for external edits",
      description:
        "Block until a tracked artifact changes on disk outside glosa (or the wait elapses), then return " +
        "the drift as external_edit entries this session has not yet seen. Requires the session to already " +
        "be explicitly bound to the workspace — call glosa_session_bind first if it has not bound yet. " +
        "Self-echo is NOT filtered: a returned entry may be this session's own un-leased write, not " +
        "necessarily someone else's change. Marks entries presented for THIS session only; no other " +
        "session is nudged by it. When has_more is true, call again WITHOUT since to drain the rest.",
      inputSchema: watchInputSchema,
      outputSchema: watchOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: false }),
        title: "Watch for external edits",
      },
    },
    async ({ workspace, path, since, wait_ms: waitMs, session_id: requestedSession }, extra) => {
      const hostSession = host()?.session_id;
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const sessionId = hostSession ?? requestedSession;
      if (!sessionId) {
        throw new Error("glosa_watch requires an explicit session_id when the MCP host does not provide one");
      }
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      // The request's own cancellation has to reach the HELD GET, not just the acknowledgement
      // reserved at the end (review round 6). A watch can sit for up to fifteen minutes, so a
      // client that cancels and gets nothing back would otherwise leave the daemon holding the
      // request for its full budget, and a cancellation arriving during the transport
      // acknowledgement would miss the `failed` this shim promises to record.
      const requestScope = AbortSignal.any(
        [shutdownAbort.signal, extra.signal].filter((signal): signal is AbortSignal => !!signal),
      );
      const apiClient = await deps.createApiClient(requestScope);
      if (!apiClient.watch) throw new Error("glosa_watch is unavailable");
      const result = await apiClient.watch(root, sessionId, { path, since, waitMs });
      const entryIds = result.entries.map((entry) => entry.id);
      // W4: transport acceptance is recorded once the HTTP body actually reached this shim —
      // right here, after `watch()` resolved — never merely on the daemon having built a response.
      if (entryIds.length > 0 && apiClient.watchTransportAck) {
        await apiClient.watchTransportAck(sessionId, entryIds);
      }
      const structuredContent = {
        entries: result.entries,
        latest_checkpoint: result.latest_checkpoint,
        has_more: result.has_more,
      };
      if (entryIds.length > 0) {
        acknowledgements.reserveWatch(extra.requestId, { apiClient, sessionId, entryIds }, extra.signal);
      }
      const text =
        result.entries.length > 0 ? formatPresentationBatch(result.entries) : "glosa watch: no new external edits";
      return toolResult(structuredContent, text);
    },
  );

  return {
    server,
    connect: (transport) => server.connect(new DeliveryAwareTransport(transport, acknowledgements)),
    close: async () => {
      // Intake is gated first and atomically — a synchronous statement, before anything else,
      // including the abort below. A request that starts concurrently with shutdown either sees
      // this and is rejected before touching registration/heartbeat, or was already running and
      // is in `activeCalls` by the time the snapshot below is taken; no third, ungated state
      // exists in between (see `wrapped`, above, for the matching synchronous check-and-track).
      intakeClosed = true;
      shutdownAbort.abort();
      codexAttachAbort?.abort();
      // Every admitted request still running — its registration and heartbeat included, not only
      // its handler — is bound to `shutdownAbort` through the client `ensureSession` created for
      // it, so aborting first means this settles quickly rather than abandoning it mid-flight.
      await Promise.allSettled([...activeCalls]);
      await server.close();
      await Promise.allSettled([...codexAttachTasks]);
      // Safe to run after the abort above, and only because of it: every pending acknowledgement
      // holds the client its delivery arrived on, which is bound to `shutdownAbort`. The call
      // therefore fails locally instead of putting the current bearer on the wire to an endpoint
      // resolved earlier in the session — the same hazard the removed deregistration had.
      await acknowledgements.failAll("MCP server closed before its response was written");
      // No deregistration is attempted, deliberately (issue #140).
      //
      // The session this shim registered is cleaned up by its LEASE EXPIRING, which A2 §F08 already
      // defines as what happens when a session's transport goes away. Sending a `deregister` here
      // would be faster, but it means putting the current bearer token on the wire to an endpoint
      // resolved long ago — at first registration, possibly hours earlier — and a port is not an
      // identity. After the daemon exits, any local process can take that port; the lock it left
      // behind is world-readable (0644 to the token's 0600), so a DIFFERENT-uid process can read
      // the instance id it published, echo it back through a handshake, and be handed a credential
      // it could never have read from disk.
      //
      // Verifying harder was tried and is not worth its weight: a port comparison is satisfied by
      // exactly that stale lock, and a tokenless handshake proving a replayable public id is too.
      // Proving ownership properly means a fresh lock read plus a live-PID check plus full
      // handshake agreement, inside a shutdown budget, in the one code path that must never hang —
      // machinery guarding a convenience whose absence costs one lease interval.
      //
      // `ensureDaemon` is not the precedent it looks like: it resolves the port it is about to use,
      // right then, and requires a currently live lock PID agreeing across instance, protocol,
      // build and install. Shutdown has none of that freshness, which is what makes the same
      // metadata safe there and unsafe here.
    },
  };
}

function waitForInputEnd(input: Readable): Promise<void> {
  if (input.readableEnded || input.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      input.off("end", done);
      input.off("close", done);
      resolve();
    };
    input.once("end", done);
    input.once("close", done);
  });
}

/**
 * Run `close` under a total deadline and end the process when it does not finish (issue #140).
 *
 * Its boundaries are injected rather than reached for, so the fallback is provable without
 * constructing a real hang: hand it a `close` that never settles and `exit` must be called. That
 * matters because the fallback is unfalsifiable through the real-process gate — when the budget
 * wins there, the shim happens to exit anyway as its event loop drains, so deleting this branch
 * changes nothing observable from outside. A defensive backstop nothing can observe is
 * indistinguishable from one that was never wired up, which is the whole failure this repository
 * treats as a review blocker.
 */
export async function closeWithinBudget(
  close: () => Promise<void>,
  budgetMs: number,
  exit: (code: number) => void,
): Promise<"closed" | "expired"> {
  let expired: ReturnType<typeof setTimeout> | undefined;
  const budgetExpired = new Promise<"expired">((resolve) => {
    expired = setTimeout(() => resolve("expired"), budgetMs);
    expired.unref?.();
  });
  const outcome = await Promise.race([close().then(() => "closed" as const), budgetExpired]);
  clearTimeout(expired);
  if (outcome === "expired") exit(0);
  return outcome;
}

/** Resolves once `signal` aborts — immediately if it already has. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export async function runMcpServer(
  deps: McpDeps,
  streams: { stdin?: Readable; stdout?: Writable } = {},
): Promise<void> {
  const input = streams.stdin ?? process.stdin;
  const output = streams.stdout ?? process.stdout;
  const runtime = createMcpServer(deps);

  // The shutdown owner. Three terminal signals — stdin EOF, SIGHUP, and a parent that has gone —
  // all enter the exact same bounded path below; none of them decides how shutdown happens, only
  // that it should start. Both the SIGHUP handler and the parent-poll baseline are installed
  // BEFORE the first await (`connect()`, below): either terminal signal can arrive during that
  // window, and installing a handler only after it would miss it — a SIGHUP would fall through to
  // the default disposition, bypassing the bounded shutdown entirely — no transport close, no
  // cancellation of in-flight work — and a parent that exits during connect() would already show
  // as this process's own parent (launchd) by the time a baseline read AFTER connect() ran, so the
  // poll below would never see it change.
  const trigger = new AbortController();
  const requestShutdown = () => trigger.abort();

  const onSighup = () => requestShutdown();
  process.on("SIGHUP", onSighup);

  // The baseline is captured HERE, before the first `await`, and that ordering is the whole fix:
  // taken any later, a parent that exits during startup would already have been replaced by the
  // reaper, the baseline would be the reaper, and the poll below could never see it change again.
  //
  // `process.ppid` and `liveParentPid()` return the same thing at this line, so the choice between
  // them is not what makes this correct — measured, `process.ppid` is resolved lazily on its first
  // read rather than captured at fork: a process that never touches it until after its parent has
  // gone reads 1, not the original pid. It is used here only because the poll below cannot use it
  // (it caches after that first read, so it can never report a change), which is also why
  // `liveParentPid()` exists at all.
  //
  // If the host double-forks — spawning `glosa mcp` through an intermediary that exits immediately
  // — the parent is already the reaper by the time this line runs and there is nothing left to
  // compare against. `glosa mcp` assumes it is spawned as a DIRECT child of its host (A2 §F08,
  // A5 §F13); a double-forking host is not covered by this mechanism and would need its own
  // lifetime channel rather than a getppid() poll.
  const startingParent = process.ppid;
  // The host is ALREADY gone (issue #140, F-4). Because `process.ppid` resolves on first read
  // rather than at fork, a direct parent that exits during Bun's module-loading window — before
  // the line above runs — leaves this reading the reaper. `startingParent` would then be the
  // reaper, `liveParentPid()` would agree with it forever, and the poll below could never fire:
  // an orphan holding someone else's stdin open, which is this issue's whole subject. There is
  // nothing to wait for, so shut down now rather than poll for a change that cannot come.
  // A double-forking host is indistinguishable here and is likewise not served by this process,
  // which is consistent with that topology being unsupported (see the comment above).
  if (startingParent === REAPER_PID) requestShutdown();
  const parentPoll = setInterval(() => {
    if (liveParentPid() !== startingParent) requestShutdown();
  }, MCP_PARENT_POLL_MS);
  parentPoll.unref?.();

  try {
    await runtime.connect(new WriteConfirmedStdioServerTransport(input, output));
    await Promise.race([waitForInputEnd(input), waitForAbort(trigger.signal)]);
  } finally {
    // Neither the signal listener nor the poll interval may itself be a reason the process
    // doesn't exit: remove/clear both before the bounded close, whichever trigger fired.
    process.off("SIGHUP", onSighup);
    clearInterval(parentPoll);

    // The one total deadline. `runtime.close()` aborts both clients and bounds the pending
    // acknowledgements; this is the fallback for anything that does not honour that — including
    // the SDK's own close — so no path can outlive the shim.
    await closeWithinBudget(
      () => runtime.close(),
      MCP_SHUTDOWN_BUDGET_MS,
      (code) => process.exit(code),
    );
  }
}
