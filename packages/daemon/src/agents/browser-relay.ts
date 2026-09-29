// SPDX-License-Identifier: Apache-2.0
// Desk browser tabs for a managed chat's agent (#440). The daemon runs the agent's tools; the pages
// live in the desktop app, in a desk window's dock. This relay is the only path between them: a
// desk window in the desktop app registers its workspace stream as a host (`?browser=1`), the relay
// sends it one `browser_request` frame per tool call, and the window answers through
// `POST /w/:slug/browser-requests/:id`.
//
// Rules it holds, whatever the SPA does:
// - a request goes only to a window showing the chat's own workspace, the most recent one;
// - with no such window the tool is refused with a reason the agent can pass on, and nothing waits
//   (maintainer decision 2026-09-29: refuse, never queue, never load in the background);
// - an agent may drive only tabs it opened in this chat;
// - only web addresses, never glosa's own ports;
// - every call runs inside the chat run that asked (the caller's `assertActive`), which is a turn a
//   person started (docs/decisions.md 2026-09-29).
import { randomUUID } from "node:crypto";
import { z } from "zod";

export type BrowserAction =
  | { action: "open"; url: string }
  | { action: "navigate"; tab: string; url: string }
  | { action: "read"; tab: string; maxChars: number };

/** What a desk window is sent: one request, with the chat it is for so the tab can say who. */
export interface BrowserRequestFrame {
  id: string;
  chat_id: string;
  provider: string;
  action: BrowserAction["action"];
  url?: string;
  tab?: string;
  max_chars?: number;
}

/** What the agent's tool returns. A refusal is a result, not a thrown error, so its reason reaches
 * the agent (the managed MCP route turns every thrown error into one generic message). */
export type BrowserResult =
  | { ok: true; tab: string; url: string; title: string; text?: string; truncated?: boolean; failure?: string }
  | { ok: false; reason: string };

const answerSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      tab: z.string().min(1).max(64),
      url: z.string().max(8192),
      title: z.string().max(1024),
      text: z.string().max(200_000).optional(),
      truncated: z.boolean().optional(),
      failure: z.string().max(512).optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.string().min(1).max(512) }).strict(),
]);

export const BROWSER_REFUSALS = {
  noWindow:
    "No desk window in the glosa app shows this workspace, so there is no browser tab to use. Ask the person to open the workspace in the glosa desktop app.",
  notWeb: "Only http and https addresses open in a browser tab.",
  glosa: "That address is glosa's own; it does not open in a browser tab.",
  notYours: "That tab was not opened in this chat. Open a page with glosa_browser_open first.",
  closed: "The window closed before the page answered.",
  timeout: "The browser tab did not answer in time.",
} as const;

const TIMEOUT_MS: Record<BrowserAction["action"], number> = { open: 30_000, navigate: 30_000, read: 15_000 };

interface Host {
  send(frame: BrowserRequestFrame): void;
}

interface Pending {
  workspaceId: string;
  host: Host;
  settle: (result: BrowserResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserRelayOptions {
  newId?: () => string;
  timeoutMs?: Partial<Record<BrowserAction["action"], number>>;
}

export class BrowserRelay {
  private readonly hosts = new Map<string, Host[]>();
  private readonly pending = new Map<string, Pending>();
  private readonly tabs = new Map<string, Set<string>>();
  private glosaPorts: number[] = [];
  private readonly newId: () => string;
  private readonly timeoutMs: Record<BrowserAction["action"], number>;

  constructor(options: BrowserRelayOptions = {}) {
    this.newId = options.newId ?? randomUUID;
    this.timeoutMs = { ...TIMEOUT_MS, ...options.timeoutMs };
  }

  /** The daemon's SPA and class-F ports, known once it has bound them. */
  setGlosaPorts(ports: number[]): void {
    this.glosaPorts = [...ports];
  }

  /** A desk window in the desktop app that can host tabs for this workspace registration. The
   * newest registered window receives requests. Returns the unregister, which also fails anything
   * still waiting on that window. */
  register(workspaceId: string, send: (frame: BrowserRequestFrame) => void): () => void {
    const host: Host = { send };
    const list = this.hosts.get(workspaceId) ?? [];
    list.push(host);
    this.hosts.set(workspaceId, list);
    return () => {
      const remaining = (this.hosts.get(workspaceId) ?? []).filter((h) => h !== host);
      if (remaining.length) this.hosts.set(workspaceId, remaining);
      else this.hosts.delete(workspaceId);
      for (const [id, waiting] of this.pending) {
        if (waiting.host !== host) continue;
        this.finish(id, { ok: false, reason: BROWSER_REFUSALS.closed });
      }
    };
  }

  /** Whether a web address may be sent to a tab, and why not. */
  refusal(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return BROWSER_REFUSALS.notWeb;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return BROWSER_REFUSALS.notWeb;
    const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return loopback && this.glosaPorts.includes(port) ? BROWSER_REFUSALS.glosa : null;
  }

  /** One tool call for `chat`, answered by the newest desk window on its workspace. */
  async request(
    chat: { id: string; workspaceId: string; provider: string },
    call: BrowserAction,
    assertActive: () => void,
  ): Promise<BrowserResult> {
    if (call.action !== "read") {
      const refused = this.refusal(call.url);
      if (refused) return { ok: false, reason: refused };
    }
    if (call.action !== "open" && !this.tabs.get(chat.id)?.has(call.tab)) {
      return { ok: false, reason: BROWSER_REFUSALS.notYours };
    }
    const host = this.hosts.get(chat.workspaceId)?.at(-1);
    if (!host) return { ok: false, reason: BROWSER_REFUSALS.noWindow };
    assertActive();
    const id = this.newId();
    const frame: BrowserRequestFrame = {
      id,
      chat_id: chat.id,
      provider: chat.provider,
      action: call.action,
      ...(call.action !== "read" ? { url: call.url } : {}),
      ...(call.action !== "open" ? { tab: call.tab } : {}),
      ...(call.action === "read" ? { max_chars: call.maxChars } : {}),
    };
    const result = await new Promise<BrowserResult>((settle) => {
      const timer = setTimeout(
        () => this.finish(id, { ok: false, reason: BROWSER_REFUSALS.timeout }),
        this.timeoutMs[call.action],
      );
      this.pending.set(id, { workspaceId: chat.workspaceId, host, settle, timer });
      host.send(frame);
    });
    assertActive();
    if (result.ok && call.action === "open") {
      const opened = this.tabs.get(chat.id) ?? new Set<string>();
      opened.add(result.tab);
      this.tabs.set(chat.id, opened);
    }
    return result;
  }

  /** A desk window's answer to request `id`. False when there is no such request on this
   * workspace (already answered, timed out, or another workspace's), or the answer is malformed. */
  answer(workspaceId: string, id: string, raw: unknown): boolean {
    const waiting = this.pending.get(id);
    if (!waiting || waiting.workspaceId !== workspaceId) return false;
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) return false;
    this.finish(id, parsed.data);
    return true;
  }

  private finish(id: string, result: BrowserResult): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.settle(result);
  }
}
