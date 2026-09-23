// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ManagedAgentError } from "../agents/interface.ts";
import type { ChatWorkspace, ManagedChatService } from "../chats/service.ts";
import type { WorkspaceEntry } from "../registry/workspace-index.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import { findWorkspace, type WorkspaceAccess, WorkspaceLookupError } from "../services/workspace-access.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export function chatWorkspace(entry: WorkspaceEntry): ChatWorkspace {
  return { id: entry.registration_id, epoch: entry.first_seen, path: entry.canonical_path };
}
interface Dependencies extends WorkspaceAccess {
  service?: ManagedChatService;
  instanceId?: string;
  shutdownSignal?: AbortSignal;
  sessionRegistry?: SessionRegistry;
}
const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
const nil = () => json({ ok: true });

export function chatRoutes(deps: Dependencies, method: string, path: string): RouteMatch | null {
  const agent = /^\/api\/agents(?:\/(.*))?$/.exec(path);
  const chat = /^\/w\/([^/]+)\/chats(?:\/(external|events|[a-f0-9-]{36})(?:\/(.*))?)?$/.exec(path);
  if ((!agent && !chat) || !["GET", "POST"].includes(method)) return null;
  const upload = chat?.[3] === "attachments" && method === "POST";
  return {
    routeClass: method === "GET" ? "authed-read" : "state-changing",
    ...(upload ? { bodyLimit: 10 * 1024 * 1024 } : {}),
    handle: async (req, server, authSignal) => {
      try {
        const service = deps.service;
        if (!service) {
          if (agent && (!agent[1] || agent[1] === "status") && method === "GET")
            return json({
              available: false,
              providers: [],
              profiles: [],
              reason: "Managed agents are not configured.",
            });
          throw new ManagedAgentError("managed-unavailable", "Managed agents are not configured.", 503);
        }
        if (authSignal?.aborted || deps.shutdownSignal?.aborted)
          throw new ManagedAgentError("managed-stopping", "This connection is no longer active.", 503);
        service.bindAuthorization(authSignal);
        if (agent) {
          const tail = agent[1] ?? "status";
          if (tail === "quiesce" && method === "POST") {
            const input = z
              .object({ instanceId: z.string() })
              .strict()
              .parse(await req.json());
            if (!deps.instanceId || input.instanceId !== deps.instanceId)
              throw new ManagedAgentError("managed-stopping", "The daemon instance changed.");
            service.quiesce();
            return json({ ok: true, instanceId: deps.instanceId });
          }
          if (tail === "status" && method === "GET") return json(service.status());
          if (tail === "profiles" && method === "POST") return json(service.createProfile(await req.json()));
          const installation = /^runtimes\/([a-z][a-z0-9-]{0,63})\/install$/.exec(tail);
          if (installation && method === "POST") {
            // Downloads have their own bounded deadline and owned-process cleanup.
            // Keep the response alive while the foreground installer is running.
            server?.timeout(req, 0);
            return json(await service.install(installation[1]!));
          }
          const policy = /^profiles\/([a-f0-9-]{36})\/mcp$/.exec(tail);
          const mcpLogin = /^profiles\/([a-f0-9-]{36})\/mcp-login$/.exec(tail);
          if (mcpLogin && method === "POST") {
            const input = z
              .object({ workspace: z.string().min(1), serverId: z.string().max(80).optional() })
              .strict()
              .parse(await req.json());
            return json(
              await service.login(mcpLogin[1]!, chatWorkspace(findWorkspace(deps, input.workspace)), input.serverId),
            );
          }
          if (policy) {
            const slug = new URL(req.url).searchParams.get("workspace");
            if (!slug)
              throw new ManagedAgentError("workspace-changed", "Choose the workspace for this MCP configuration.", 422);
            const workspace = chatWorkspace(findWorkspace(deps, slug));
            return json(
              method === "GET"
                ? service.mcpPolicy(workspace, policy[1]!)
                : await service.changeMcpPolicy(workspace, policy[1]!, await req.json()),
            );
          }
          const profile = /^profiles\/([a-f0-9-]{36})(?:\/(login|logout|probe|consent|models))?$/.exec(tail);
          if (profile && method === "POST") {
            if (!profile[2]) return json(await service.updateProfile(profile[1]!, await req.json()));
            if (profile[2] === "probe") return json(await service.probeProfile(profile[1]!));
            if (profile[2] === "models") return json(await service.discoverModels(profile[1]!));
            if (profile[2] === "logout") return json(await service.signOut(profile[1]!, await req.json()));
            if (profile[2] === "login") {
              const result = await service.login(profile[1]!);
              const signal = combinedSignal(deps.shutdownSignal, authSignal);
              const stop = () => {
                void service.finishLogin(result.id, result.secret).catch(() => {});
              };
              if (signal?.aborted) {
                stop();
                throw new ManagedAgentError("login-cancelled", "This login was cancelled.");
              }
              signal?.addEventListener("abort", stop, { once: true });
              return json(result);
            }
            const input = z
              .object({ workspace: z.string().min(1), granted: z.boolean(), version: z.literal(1) })
              .strict()
              .parse(await req.json());
            await service.consent(chatWorkspace(findWorkspace(deps, input.workspace)), profile[1]!, input.granted);
            return nil();
          }
          const login = /^logins\/([a-f0-9-]{36})(?:\/(input|resize|finish))?$/.exec(tail);
          if (login) {
            const secret = req.headers.get("X-Glosa-Operation") ?? "";
            if (!login[2] && method === "GET") {
              const offset = z.coerce
                .number()
                .int()
                .nonnegative()
                .parse(new URL(req.url).searchParams.get("offset") ?? 0);
              return json(service.loginOutput(login[1]!, secret, offset));
            }
            if (login[2] === "input" && method === "POST") {
              const input = z
                .object({ data: z.string().max(16_384) })
                .strict()
                .parse(await req.json());
              await service.loginInput(login[1]!, secret, input.data);
              return nil();
            }
            if (login[2] === "resize" && method === "POST") {
              const input = z
                .object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(3).max(200) })
                .strict()
                .parse(await req.json());
              service.loginResize(login[1]!, secret, input.cols, input.rows);
              return nil();
            }
            if (login[2] === "finish" && method === "POST") {
              await service.finishLogin(login[1]!, secret);
              return nil();
            }
          }
        }
        if (chat) {
          const workspace = chatWorkspace(findWorkspace(deps, decodeURIComponent(chat[1]!)));
          const id = chat[2],
            action = chat[3];
          if (id === "events" && method === "GET") {
            service.list(workspace);
            server?.timeout(req, 0);
            return listStream(service, workspace, req, combinedSignal(deps.shutdownSignal, authSignal));
          }
          if (id === "external" && method === "POST") {
            const input = z
              .object({ sessionId: z.string().min(1).max(512) })
              .strict()
              .parse(await req.json());
            service.list(workspace); // Validate registration and lifecycle before storing an association.
            const session = deps.sessionRegistry
              ?.forWorkspace(workspace.path)
              .find((item) => item.session_id === input.sessionId && item.source !== "managed-chat");
            if (!session)
              throw new ManagedAgentError(
                "chat-not-found",
                "This external session is not registered in this workspace.",
                404,
              );
            return json(
              service.store.rememberExternal(workspace.id, workspace.epoch, session.session_id, session.provider),
            );
          }
          if (!id && method === "GET") {
            const params = new URL(req.url).searchParams;
            const query = z
                .string()
                .max(256)
                .parse(params.get("q") ?? ""),
              after = z
                .string()
                .max(36)
                .parse(params.get("after") ?? "");
            return json({
              external: service.store.external(workspace.id, workspace.epoch),
              ...service.search(workspace, query, after, params.get("archived") === "true"),
            });
          }
          if (!id && method === "POST") return json(service.create(workspace, await req.json()));
          if (id && !action && method === "GET") return json(service.snapshot(workspace, id, historyCursor(req)));
          if (id && !action && method === "POST") return json(service.change(workspace, id, await req.json()));
          if (id && action === "draft" && method === "POST")
            return json(service.saveDraft(workspace, id, await req.json()));
          if (id && action === "move-draft" && method === "POST")
            return json(service.moveDraft(workspace, id, await req.json()));
          if (id && action === "mcp" && method === "POST") {
            z.object({})
              .strict()
              .parse(await req.json());
            return json(await service.nativeMcp(workspace, id));
          }
          if (id && action === "turns" && method === "POST") return json(service.send(workspace, id, await req.json()));
          if (id && action === "feedback")
            return json(
              method === "GET"
                ? await service.feedback(workspace, id)
                : await service.sendFeedback(workspace, id, await req.json()),
            );
          if (id && action === "delete" && method === "POST") {
            service.deleteChat(workspace, id);
            return nil();
          }
          if (id && action === "decisions" && method === "POST") {
            await service.answer(workspace, id, await req.json());
            return nil();
          }
          if (id && action === "stop" && method === "POST") {
            const input = z
              .object({ turnId: z.uuid().optional() })
              .strict()
              .parse(await req.json());
            await service.stop(workspace, id, input.turnId);
            return nil();
          }
          if (id && action === "resume" && method === "POST") {
            const input = z
              .object({ turnId: z.uuid() })
              .strict()
              .parse(await req.json());
            service.resume(workspace, id, input.turnId);
            return nil();
          }
          if (id && action === "attachments" && method === "POST") {
            const bytes = new Uint8Array(await req.arrayBuffer());
            const name = decodeURIComponent(req.headers.get("X-Glosa-Filename") ?? "attachment");
            return json(
              service.upload(workspace, id, name, req.headers.get("Content-Type") ?? "application/octet-stream", bytes),
            );
          }
          if (id && action === "events" && method === "GET") {
            server?.timeout(req, 0);
            return chatStream(service, workspace, id, req, combinedSignal(deps.shutdownSignal, authSignal));
          }
          if (id && action === "export" && method === "GET") {
            const state = service.snapshot(workspace, id, undefined, true);
            const markdown = [
              `# ${state.title}`,
              `Agent: ${state.provider}`,
              ...state.turns.flatMap((turn) => [
                "## You",
                turn.text,
                ...state.content
                  .filter((item) => item.turnId === turn.id)
                  .flatMap((item) => [`## ${item.role === "tool" ? (item.name ?? "Tool") : "Assistant"}`, item.text]),
              ]),
            ].join("\n\n");
            return new Response(markdown, {
              headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                "Content-Disposition": `attachment; filename="chat-${id}.md"`,
                "Cache-Control": "no-store",
              },
            });
          }
        }
        return problem(404, "not-found", "Route was not found.", undefined, path);
      } catch (error) {
        if (error instanceof ManagedAgentError)
          return problem(error.status, error.code, error.message, undefined, path);
        if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError)
          return problem(
            422,
            "invalid-agent-request",
            "The request contains invalid agent or chat data.",
            undefined,
            path,
          );
        if (error instanceof WorkspaceLookupError)
          return problem(
            error.code === "not-found" ? 404 : 409,
            error.code,
            "Workspace is unavailable.",
            undefined,
            path,
          );
        return problem(503, "managed-operation-failed", "The agent operation could not be completed.", undefined, path);
      }
    },
  };
}

function historyCursor(req: Request): string | undefined {
  return z
    .string()
    .max(1024)
    .optional()
    .parse(new URL(req.url).searchParams.get("before") ?? undefined);
}
function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  return present.length ? AbortSignal.any(present) : undefined;
}

function chatStream(
  service: ManagedChatService,
  workspace: ChatWorkspace,
  id: string,
  req: Request,
  signal?: AbortSignal,
): Response {
  const log = service.chat(workspace, id),
    encoder = new TextEncoder();
  let closed = false,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let dispose: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = log.journal.revision;
      const frame = (event: string, data: unknown, seq: number) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < -100) {
          dispose();
          return;
        }
        controller.enqueue(encoder.encode(`id: ${id}:1:${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const listener: Parameters<typeof log.journal.listeners.add>[0] = (record) => {
        if (record.seq <= sequence) return;
        sequence = record.seq;
        try {
          service.chat(workspace, id);
          frame("chat_event", record, record.seq);
        } catch {
          dispose();
        }
      };
      dispose = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        log.journal.listeners.delete(listener);
        signal?.removeEventListener("abort", dispose);
        req.signal.removeEventListener("abort", dispose);
        try {
          controller.close();
        } catch {
          /* disconnected */
        }
      };
      log.journal.listeners.add(listener);
      // Snapshot and listener are installed without yielding: no gap or duplicate window.
      // A reconnect receives a replacement snapshot, never a blind replay of native work.
      frame("chat_snapshot", service.snapshot(workspace, id, historyCursor(req)), sequence);
      heartbeat = setInterval(() => {
        try {
          service.chat(workspace, id);
          frame("heartbeat", { seq: sequence }, sequence);
        } catch {
          dispose();
        }
      }, 15_000);
      if (signal?.aborted || req.signal.aborted) dispose();
      else {
        signal?.addEventListener("abort", dispose, { once: true });
        req.signal.addEventListener("abort", dispose, { once: true });
      }
    },
    cancel() {
      dispose();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

function listStream(
  service: ManagedChatService,
  workspace: ChatWorkspace,
  req: Request,
  signal?: AbortSignal,
): Response {
  let close = () => {};
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false,
          pending: ReturnType<typeof setTimeout> | undefined;
        const send = () => {
          pending = undefined;
          if (ended) return;
          try {
            service.list(workspace);
            if ((controller.desiredSize ?? 0) < -4) {
              close();
              return;
            }
            controller.enqueue(encoder.encode("event: chats_changed\ndata: {}\n\n"));
          } catch {
            close();
          }
        };
        const changed = () => {
          if (!pending && !ended) pending = setTimeout(send, 250);
        };
        const heartbeat = setInterval(send, 15000);
        close = () => {
          if (ended) return;
          ended = true;
          clearInterval(heartbeat);
          clearTimeout(pending);
          service.store.listeners.delete(changed);
          signal?.removeEventListener("abort", close);
          req.signal.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            /* disconnected */
          }
        };
        service.store.listeners.add(changed);
        if (signal?.aborted || req.signal.aborted) close();
        else {
          signal?.addEventListener("abort", close, { once: true });
          req.signal.addEventListener("abort", close, { once: true });
          send();
        }
      },
      cancel() {
        close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } },
  );
}
