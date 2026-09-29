// SPDX-License-Identifier: Apache-2.0
// Restricted tool implementation: the caller's session/workspace come from an in-memory run grant.
import { z } from "zod";
import type { PresentationClaim } from "../agent-provider/interface.ts";
import type { WorkspaceBus } from "../bus/bus.ts";
import { buildDeliveryPresentation } from "../delivery/presentation.ts";
import type { ChatState } from "../chats/store.ts";
import type { WorkspaceEntry } from "../registry/workspace-index.ts";
import type { BrowserRelay } from "./browser-relay.ts";
import { type ArtifactAccessDependencies, actionablePresentation } from "../services/artifact.ts";
import { ManagedAgentError } from "./interface.ts";

export interface ManagedToolContext {
  chat: ChatState;
  assertActive(): void;
  reservations: Set<string>;
  feedbackIds?: string[];
  origin?: string;
}
export interface ManagedTools {
  list: object[];
  pending?(context: ManagedToolContext): Promise<{ entryIds: string[]; hasMore: boolean }>;
  call(context: ManagedToolContext, name: string, args: unknown): Promise<unknown>;
}
const noScope = z.object({ session_id: z.string().optional(), workspace: z.string().optional() });
const schemas = {
  glosa_present: noScope
    .extend({ path: z.string().min(1).max(4096), mode: z.enum(["read", "annotate", "edit"]).default("annotate") })
    .strict(),
  glosa_inbox_pull: noScope.extend({ limit: z.number().int().min(1).max(8).default(8) }).strict(),
  glosa_inbox_get: noScope.extend({ id: z.string().min(1).max(512), cursor: z.string().max(1024).optional() }).strict(),
  glosa_delivery_ack: noScope.extend({ delivery_id: z.string().min(1).max(512) }).strict(),
  glosa_claim: noScope
    .extend({
      resources: z.array(z.string().min(1).max(1024)).min(1).max(32),
      mode: z.enum(["exclusive", "presence"]).default("exclusive"),
    })
    .strict(),
  glosa_release: noScope.extend({ claim_id: z.string().min(1).max(512) }).strict(),
  // Desk browser tabs (#440): the tab is a daemon-issued id from glosa_browser_open.
  glosa_browser_open: noScope.extend({ url: z.string().min(1).max(8192) }).strict(),
  glosa_browser_navigate: noScope.extend({ tab: z.string().min(1).max(64), url: z.string().min(1).max(8192) }).strict(),
  glosa_browser_read: noScope
    .extend({ tab: z.string().min(1).max(64), max_chars: z.number().int().min(1000).max(100_000).default(100_000) })
    .strict(),
  glosa_resolve: noScope
    .extend({
      entry_id: z.string().min(1).max(512),
      outcome: z.enum(["applied", "rejected", "stale"]),
      fence: z.number().int().positive().optional(),
      note: z.string().max(4096).optional(),
    })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  glosa_present:
    "Return a link to a tracked document in this workspace. Does not open a browser or move the reader. Cannot register another workspace.",
  glosa_inbox_pull:
    "Read pending feedback for this chat. After reading it, call glosa_delivery_ack with delivery_id. Never claim delivery before reading.",
  glosa_inbox_get: "Read one immutable feedback entry for this chat.",
  glosa_delivery_ack: "Confirm that this chat received the feedback returned by glosa_inbox_pull.",
  glosa_claim:
    "Claim entry:<id> or artifact:<path> before editing. An exclusive claim records the interval used to prove authorship.",
  glosa_release: "Release your own claim without claiming that changes were applied.",
  glosa_resolve:
    "Resolve a feedback entry after applying, rejecting or finding it stale. Applied requires the claim's fence; human edits win.",
  glosa_browser_open:
    "Open an http or https page in a new browser tab in the glosa desktop app's desk window for this workspace, beside the person's documents. The person sees the tab and that you opened it. Returns the tab id, the address the page settled on and its title, or a reason it could not open (for example, no desk window shows this workspace).",
  glosa_browser_navigate: "Load an http or https address in a browser tab you opened in this chat.",
  glosa_browser_read:
    "Read the visible text of a browser tab you opened in this chat, with its address and title. The text is sent to your model provider like a file you read, and may come from a page the person is signed in to. Long pages are cut at max_chars and say so.",
};
const BROWSER_TOOLS = new Set(["glosa_browser_open", "glosa_browser_navigate", "glosa_browser_read"]);
/** What a managed chat needs to deliver a note the way every HTTP delivery does: through
 * `actionablePresentation`, which reads the document as it stands, resolves the note's quote to a
 * source range and names its passage address (issue #411). Built without it, an entry carries no
 * address, no workspace line for its apply instructions to point at, and the default
 * `orphaned, no_source_map` resolution whether or not its words are still on the page. */
export interface ManagedDeliveryResolution {
  deps: ArtifactAccessDependencies;
  /** The chat's own workspace; throws, like `busFor`, when it has changed under the chat. */
  workspaceFor(chat: ChatState): WorkspaceEntry;
}

export function createManagedTools(
  busFor: (chat: ChatState) => Promise<WorkspaceBus>,
  present?: (chat: ChatState, path: string) => { slug: string; path: string; class: "R" | "F" },
  resolution?: ManagedDeliveryResolution,
  browser?: BrowserRelay,
): ManagedTools {
  const presentation = (
    chat: ChatState,
    id: string,
    payload: unknown,
    status: string,
    extra: { claims?: PresentationClaim[]; cursor?: string } = {},
  ) =>
    resolution
      ? actionablePresentation(resolution.deps, resolution.workspaceFor(chat), id, payload, status, extra.cursor, {
          ...(extra.claims ? { claims: extra.claims } : {}),
        })
      : buildDeliveryPresentation(id, payload, { status, ...extra });
  return {
    async pending(context) {
      context.assertActive();
      const bus = await busFor(context.chat);
      context.assertActive();
      const planned = await bus.previewDelivery(8, { session: context.chat.sessionId }, (id, value, status, extra) =>
        presentation(context.chat, id, value, status, extra),
      );
      context.assertActive();
      return { entryIds: planned.entries.map((entry) => entry.id), hasMore: planned.has_more };
    },
    list: Object.entries(schemas)
      .filter(([name]) => name !== "glosa_present" || present)
      .filter(([name]) => !BROWSER_TOOLS.has(name) || browser)
      .map(([name, schema]) => ({
        name,
        description: descriptions[name as keyof typeof schemas],
        inputSchema: z.toJSONSchema(schema, { target: "draft-7" }),
      })),
    async call(context, name, raw) {
      const schema = schemas[name as keyof typeof schemas];
      if (!schema) throw new ManagedAgentError("invalid-answer", "This tool is not available to a managed chat.", 403);
      const args = schema.parse(raw) as Record<string, any>;
      const { chat } = context;
      if (
        (args.session_id && args.session_id !== chat.sessionId) ||
        (args.workspace && args.workspace !== chat.workspacePath)
      )
        throw new ManagedAgentError("workspace-changed", "This grant cannot select another session or workspace.", 403);
      context.assertActive();
      if (BROWSER_TOOLS.has(name)) {
        if (!browser) throw new ManagedAgentError("managed-unavailable", "Browser tabs are unavailable.");
        const who = { id: chat.id, workspaceId: chat.workspaceId, provider: chat.provider };
        if (name === "glosa_browser_open")
          return browser.request(who, { action: "open", url: args.url }, context.assertActive);
        if (name === "glosa_browser_navigate")
          return browser.request(who, { action: "navigate", tab: args.tab, url: args.url }, context.assertActive);
        return browser.request(who, { action: "read", tab: args.tab, maxChars: args.max_chars }, context.assertActive);
      }
      const bus = await busFor(chat);
      context.assertActive();
      const ownedEntry = (id: string) => {
        const entry = bus.readEntry(id),
          payload = entry?.payload as Record<string, unknown> | undefined;
        if (!entry || (typeof payload?.target_session_id === "string" && payload.target_session_id !== chat.sessionId))
          throw new ManagedAgentError("chat-not-found", "Feedback entry is not available to this chat.", 404);
        return entry;
      };
      if (name === "glosa_present") {
        if (!present || !context.origin)
          throw new ManagedAgentError("managed-unavailable", "Presentation is unavailable.");
        const artifact = present(chat, args.path);
        context.assertActive();
        const url = new URL("/", context.origin);
        url.hash = new URLSearchParams({
          w: artifact.slug,
          a: artifact.path,
          mode: args.mode,
          ...(args.mode === "read" ? { preview: "1" } : {}),
        }).toString();
        return {
          url: url.href,
          slug: artifact.slug,
          path: artifact.path,
          class: artifact.class,
          mode: args.mode,
          session_id: chat.sessionId,
        };
      }
      if (name === "glosa_inbox_pull") {
        const batch = await bus.prepareDelivery(
          args.limit,
          {
            via: "mcp_pull",
            session: chat.sessionId,
            includeEntryIds: context.feedbackIds ? new Set(context.feedbackIds) : undefined,
            assertActive: context.assertActive,
          },
          (id, payload, status, extra) => presentation(chat, id, payload, status, extra),
        );
        context.assertActive();
        if (batch.delivery_id) context.reservations.add(batch.delivery_id);
        return batch;
      }
      if (name === "glosa_inbox_get") {
        const entry = ownedEntry(args.id);
        return presentation(chat, args.id, entry.payload, entry.status, { cursor: args.cursor });
      }
      if (name === "glosa_delivery_ack") {
        if (!context.reservations.has(args.delivery_id))
          throw new ManagedAgentError("stale-decision", "This delivery is not reserved by this run.");
        const acknowledged = await bus.acknowledgeDelivery(
          args.delivery_id,
          "presented",
          undefined,
          context.assertActive,
        );
        context.reservations.delete(args.delivery_id);
        return { acknowledged };
      }
      if (name === "glosa_claim") {
        for (const resource of args.resources) if (resource.startsWith("entry:")) ownedEntry(resource.slice(6));
        return bus.claim(args.resources, args.mode, chat.sessionId, `managed:${chat.sessionId}`, {
          assertActive: context.assertActive,
        });
      }
      if (name === "glosa_release") return bus.release(args.claim_id, "session", chat.sessionId, context.assertActive);
      ownedEntry(args.entry_id);
      return bus.resolveEntry(args.entry_id, args.outcome, chat.sessionId, {
        fence: args.fence,
        note: args.note,
        assertActive: context.assertActive,
      });
    },
  };
}
