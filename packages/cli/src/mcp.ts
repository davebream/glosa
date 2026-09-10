// SPDX-License-Identifier: Apache-2.0
// Product-scoped MCP stdio server: durable inbox pull/get, metadata, session bind,
// conversation acknowledgement, and the optional Claude Channel notification rung.
import { existsSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { dlopen, FFIType } from "bun:ffi";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { z } from "zod";
import type {
  CallToolResult,
  JSONRPCMessage,
  RequestId,
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import { isApiError, type GlosaApiClient } from "./api-client.ts";
import type { DaemonHookClient, DrainResult } from "./daemon-client.ts";
import {
  askInputSchema,
  askOutputSchema,
  conversationAckInputSchema,
  conversationAckOutputSchema,
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
} from "./mcp-schemas.ts";
import { runOpenPresentation } from "./open-presentation.ts";
import { realRequestReviewDeps, runRequestReview } from "./request-review.ts";
import { CLI_VERSION } from "./version.ts";

interface PendingAck {
  client: DaemonHookClient;
  sessionId: string;
  deliveryId: string;
}

export interface McpDeps {
  /**
   * `signal`, when given, is the shutdown owner's abort signal — bind it into the created
   * client so in-flight and future calls on that client reject when shutdown starts. Ordinary
   * (non-shutdown) calls are unaffected: the signal never fires until shutdown begins.
   */
  createHookClient: (signal?: AbortSignal) => Promise<DaemonHookClient>;

  createApiClient: (signal?: AbortSignal) => Promise<GlosaApiClient>;
  cwd?: () => string;
  sessionId?: () => string | undefined;
  session?: (provider?: string) => { session_id: string; provider: string; cwd: string; channelPush?: boolean } | null;
}

export const GLOSA_MCP_TOOL_NAMES = [
  "glosa_inbox_pull",
  "glosa_inbox_get",
  "glosa_metadata_set",
  "glosa_metadata_show",
  "glosa_metadata_clear",
  "glosa_session_bind",
  "glosa_conversation_ack",
  "glosa_present",
  "glosa_ask",
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

  async presented(requestId: RequestId): Promise<void> {
    const ack = this.pending.get(requestId);
    if (!ack) return;
    this.pending.delete(requestId);
    await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "presented");
  }

  async failed(requestId: RequestId, reason: string): Promise<void> {
    const ack = this.pending.get(requestId);
    if (!ack) return;
    this.pending.delete(requestId);
    await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "failed", reason);
  }

  async failAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.pending.keys()].map((requestId) => this.failed(requestId, reason)));
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
 * MCP conversation-push reconnect policy (issue 178). The SPA's SSE reconnect (A1 §8.3, 250ms
 * base / 5s cap) is a *different* stream serving a browser tab a human is watching; this stream
 * feeds an agent turn, so a tight floor would spin the daemon and the agent's own token budget
 * for no observable benefit. Every retry path below — clean EOF, a broken stream, and
 * createHookClient/daemon-discovery failure — shares one bounded exponential/jittered wait:
 * floor 5,000ms (the issue's explicit minimum), doubling per consecutive short-lived attempt,
 * capped at MCP_PUSH_MAX_DELAY_MS. Jitter is added on top of the target delay only (never
 * subtracted), so the floor and cap can never be violated by randomness.
 */
export const MCP_PUSH_MIN_DELAY_MS = 5_000;
export const MCP_PUSH_MAX_DELAY_MS = 60_000;
export const MCP_PUSH_BACKOFF_FACTOR = 2;
export const MCP_PUSH_JITTER_RATIO = 0.2;
/**
 * A push-stream connection refreshes its session lease every 20s while open (A1 §5.12).
 * Staying connected for at least one refresh cycle is treated as genuine recovery and resets
 * backoff to the floor; anything shorter (including a clean EOF that closes immediately) is
 * treated as a failed attempt so a daemon that keeps accepting-then-dropping the connection
 * cannot reset backoff into a reconnect storm.
 */
export const MCP_PUSH_RECOVERY_MS = 20_000;
/**
 * Registered/alive/unbound (409 `conflict`) means the daemon knows this session but no workspace
 * is explicitly bound to it yet — only a human/agent action (`glosa_session_bind`, `glosa_present`
 * with an unlocked mode) resolves that, never the passage of time. Retrying on the normal capped
 * backoff would still poll pointlessly every minute forever, so this state instead uses one long,
 * fixed, bounded interval — a deliberately different, truthful reason from "the last attempt
 * failed" — and never escalates further. Recovery is preserved: once a bind lands, the very next
 * attempt on this interval succeeds normally.
 */
export const MCP_PUSH_UNBOUND_RETRY_MS = 300_000;

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

/**
 * The issue's expected behavior is explicit: a shim that cannot bind "backs off to a long
 * interval and says why". stdout is the JSON-RPC channel a broken write here would corrupt, so
 * this goes to stderr via `console.error` — the same channel/mechanism the daemon already uses
 * for its own operator-facing diagnostics — never stdout, and never on every ordinary retry.
 */
function logUnboundPushRetry(sessionId: string): void {
  console.error(
    `glosa mcp: session ${sessionId} is registered but not bound to a workspace; push retries move to a fixed ` +
      `${MCP_PUSH_UNBOUND_RETRY_MS}ms interval until a bind resolves it (glosa_session_bind or glosa_present)`,
  );
}

/** Bounded exponential backoff, jitter added on top of the target only — floor/cap are exact. */
export function pushReconnectDelayMs(attempt: number): number {
  const target = Math.min(MCP_PUSH_MIN_DELAY_MS * MCP_PUSH_BACKOFF_FACTOR ** attempt, MCP_PUSH_MAX_DELAY_MS);
  const jitter = Math.random() * target * MCP_PUSH_JITTER_RATIO;
  return Math.min(MCP_PUSH_MAX_DELAY_MS, target + jitter);
}

/** The reset condition: a connection held for one lease-refresh cycle counts as recovered. */
export function nextPushAttempt(previousAttempt: number, connectedMs: number): number {
  return connectedMs >= MCP_PUSH_RECOVERY_MS ? 0 : previousAttempt + 1;
}

/** Resolves after `ms` or immediately on abort; always releases its timer and listener. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMcpServer(deps: McpDeps): GlosaMcpServer {
  // Bound into every client an active tool handler creates. It fires immediately when shutdown
  // starts, so ordinary calls are unaffected until then; once it fires, in-flight and future calls
  // on those clients reject instead of hanging — this is what cancels a mid-flight `glosa_ask`
  // long poll or a stuck hook call.
  const shutdownAbort = new AbortController();
  // Every currently-running tool call's whole lifecycle — registration/heartbeat included, not
  // just the handler — keyed by its own promise. `close()` waits for this set to drain (after
  // gating intake and aborting `shutdownAbort`) instead of abandoning in-flight work mid-request.
  const activeCalls = new Set<Promise<unknown>>();
  // Gated atomically, as `close()`'s own first statement — see `wrapped` below for why that
  // ordering is what makes the gate and the `activeCalls` snapshot agree with each other.
  let intakeClosed = false;
  const syntheticId = `mcp-${process.pid}-${randomUUID()}`;
  const host = (provider?: string) =>
    deps.session?.(provider) ??
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
        const client = await deps.createHookClient(shutdownAbort.signal);
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
  const pushAbort = new AbortController();
  let pushTask: Promise<void> | null = null;

  const server = new McpServer(
    { name: "glosa", version: CLI_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions:
        "glosa conversation messages arrive as channel events with a message_id. Immediately call glosa_conversation_ack for that message_id before acting; hook delivery remains the safety fallback.",
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
      const client = await deps.createHookClient(shutdownAbort.signal);
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
      return toolResult(structuredContent);
    },
  );

  registerTool(
    "glosa_conversation_ack",
    {
      title: "Acknowledge conversation message",
      description:
        "Acknowledge that a targeted glosa conversation message reached this agent context (presented). Required after channel delivery; hook delivery remains the safety fallback.",
      inputSchema: conversationAckInputSchema,
      outputSchema: conversationAckOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Acknowledge conversation message",
      },
    },
    async ({ message_id: messageId, session_id: requestedSession }) => {
      const hostSession = host()?.session_id;
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const sessionId = hostSession ?? requestedSession;
      if (!sessionId) {
        throw new Error(
          "glosa_conversation_ack requires an explicit session_id when the MCP host does not provide one",
        );
      }
      const client = await deps.createHookClient(shutdownAbort.signal);
      if (!client.acknowledgeConversation) throw new Error("conversation acknowledgement is unavailable");
      await client.acknowledgeConversation(sessionId, messageId, "presented");
      return toolResult({ message_id: messageId, delivered: true });
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
        "leave them out when it is open-ended; the human always keeps a free-text field either way.",
      inputSchema: askInputSchema,
      outputSchema: askOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: false }),
        title: "Ask the human about a passage",
      },
    },
    async ({ workspace, path, question, quote, options, label, wait_seconds: waitSeconds }) => {
      const dir = workspace ?? (deps.cwd ?? process.cwd)();
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
        realRequestReviewDeps(() => deps.createApiClient(shutdownAbort.signal), shutdownAbort.signal),
      );

      if (!result.ok && result.error?.kind !== "review_timeout") {
        throw new Error(result.error?.message ?? "glosa_ask failed");
      }
      const id = result.data.id;
      if (!id) throw new Error("glosa_ask did not create a request");
      if (question === undefined) return toolResult({ id, outcome: "posted", anchored: true });

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

  const startPush = () => {
    let session: ReturnType<typeof host>;
    try {
      session = host();
    } catch {
      return;
    } // conflicting identity is reported by the next tool call
    const sessionId = session?.session_id;
    if (!sessionId || pushTask || !(session?.channelPush || deps.sessionId)) return;
    pushTask = (async () => {
      // -1 means "no failed attempt recorded yet" — nextPushAttempt(-1, …) yields 0, i.e. the
      // very first retry after a failure uses the floor delay, not an already-doubled one.
      let attempt = -1;
      while (!pushAbort.signal.aborted) {
        let unbound = false;
        // Set only once the stream response is actually established (see daemon-client.ts's
        // `onOpen`) — never at loop-top. A slow `createHookClient`/daemon-discovery, or a request
        // that stalls and fails without ever getting a response, must escalate backoff like any
        // other failed attempt, not be mistaken for a held-open connection nearing the recovery
        // threshold just because a lot of wall-clock time passed.
        let connectedAt: number | null = null;
        try {
          const client = await deps.createHookClient(shutdownAbort.signal);
          if (!client.openConversationPush || !client.acknowledgeConversation) return;
          await client.openConversationPush(
            sessionId,
            async (entry) => {
              if (entry.kind !== "conversation_message") return;
              await server.server.notification({
                method: "notifications/claude/channel",
                params: { content: entry.message, meta: { message_id: entry.id } },
              } as never);
              await client.acknowledgeConversation?.(sessionId, entry.id, "transport_accepted");
            },
            pushAbort.signal,
            () => {
              connectedAt = Date.now();
            },
          );
          // Clean EOF (daemon restart, deliberate close): falls through to the same
          // recovery/backoff accounting as a thrown stream failure below.
        } catch (error) {
          if (pushAbort.signal.aborted) return;
          // 409 conflict ("session is not explicitly bound") is a distinct, non-transient state
          // from 404 ("unknown live session") — never let one masquerade as the other.
          unbound = isApiError(error) && error.status === 409;
        }
        if (pushAbort.signal.aborted) return;
        if (unbound) {
          attempt = -1;
          logUnboundPushRetry(sessionId);
          await abortableDelay(MCP_PUSH_UNBOUND_RETRY_MS, pushAbort.signal);
          continue;
        }
        const connectedMs = connectedAt === null ? 0 : Date.now() - connectedAt;
        attempt = nextPushAttempt(attempt, connectedMs);
        await abortableDelay(pushReconnectDelayMs(attempt), pushAbort.signal);
      }
    })();
  };

  server.server.oninitialized = startPush;

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
      pushAbort.abort();
      // Every admitted request still running — its registration and heartbeat included, not only
      // its handler — is bound to `shutdownAbort` through the client `ensureSession` created for
      // it, so aborting first means this settles quickly rather than abandoning it mid-flight.
      await Promise.allSettled([...activeCalls]);
      await server.close();
      if (pushTask) await pushTask.catch(() => {});
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
