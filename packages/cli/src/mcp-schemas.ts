// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const workspacePath = z
  .string()
  .min(1)
  .describe("Absolute or relative workspace directory path; defaults to the MCP process cwd when omitted.");

const sessionId = z.string().min(1).describe("Registered agent session identity.");
const inboxId = z.string().min(1).describe("Durable inbox entry id.");
const messageId = z.string().min(1).describe("Targeted conversation message id.");
const presentationCursor = z
  .string()
  .min(1)
  .describe("Opaque continuation cursor from a prior truncated presentation.");

const workspaceMetadataArtifactSchema = z
  .object({
    path: z.string().min(1).max(4096).describe("Workspace-relative artifact path."),
    class: z.enum(["R", "F"]).optional().describe("Optional artifact class hint (R = markdown, F = foreign HTML)."),
    order: z.number().int().min(0).optional().describe("Optional sidebar ordering key."),
    derived_from: z
      .object({
        path: z.string().min(1).max(4096).describe("Workspace-relative source artifact path."),
        via: z.string().min(1).max(256).describe("Producer-declared process label for the derived-from edge."),
      })
      .strict()
      .optional(),
    manifest: z
      .object({
        path: z.string().min(1).max(4096).describe("Workspace-relative class-F manifest path."),
        component: z.string().min(1).max(256).describe("Manifest component identity for this artifact."),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe("One declarative artifact entry in WorkspaceMetadataDescriptor v1.");

export const workspaceMetadataDescriptorSchema = z
  .object({
    version: z.literal(1).describe("Descriptor schema version; must be 1."),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .describe("Stable integration-owned descriptor id."),
    artifacts: z
      .array(workspaceMetadataArtifactSchema)
      .max(2048)
      .describe("Ordered artifact descriptors for this workspace."),
  })
  .strict()
  .describe("WorkspaceMetadataDescriptor v1 — durable declarative adapter input.");

const presentationTruncationSchema = z
  .object({
    truncated: z.boolean(),
    omitted_bytes: z.number().int().min(0),
    omitted_hunks: z.number().int().min(0),
  })
  .strict();

const presentationRetrievalSchema = z
  .object({
    command: z.string().min(1).describe("CLI retrieval instruction."),
    mcp_tool: z.literal("glosa_inbox_get").describe("MCP retrieval tool name."),
    cursor: presentationCursor.optional(),
  })
  .strict();

const presentationBaseShape = {
  id: inboxId,
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe("Canonical absolute workspace path from contract 1.6+; also included in presentation text."),
  status: z.string().min(1).describe("Derived inbox status at presentation time."),
  text: z.string().describe("Bounded actionable presentation text."),
  bytes: z.number().int().min(0).describe("UTF-8 byte length of text."),
  truncation: presentationTruncationSchema,
  retrieval: presentationRetrievalSchema,
  detail: z.record(z.string(), z.unknown()).describe("Kind-specific presentation detail; shape varies by entry kind."),
};

export const inboxPresentationSchema = z.discriminatedUnion("kind", [
  z.object({ ...presentationBaseShape, kind: z.literal("annotation") }).strict(),
  z.object({ ...presentationBaseShape, kind: z.literal("human_edit") }).strict(),
  // #153 Part 2: was already reachable (unvalidated) through `glosa_inbox_get` on any
  // `external_edit` id a session already knew about — `glosa_watch` is what first RETURNS one
  // proactively, which is why this variant is added now rather than earlier.
  z.object({ ...presentationBaseShape, kind: z.literal("external_edit") }).strict(),
  z.object({ ...presentationBaseShape, kind: z.literal("attention_request") }).strict(),
  z
    .object({
      ...presentationBaseShape,
      kind: z.literal("conversation_message"),
      message: z.string().describe("Exact unmodified composer UTF-8 text."),
      message_bytes: z.number().int().min(0),
      target_session_id: sessionId,
      provider: z.string().min(1),
    })
    .strict(),
]);

export const inboxPullInputSchema = z
  .object({
    workspace: workspacePath.optional(),
    limit: z.number().int().min(1).max(8).optional().describe("Maximum entries to pull; defaults to 8."),
    session_id: sessionId
      .optional()
      .describe("Explicit registered session for targeted messages. Must match the MCP host session when provided."),
  })
  .strict();

export const inboxPullOutputSchema = z
  .object({
    entries: z
      .array(inboxPresentationSchema)
      .max(8)
      .describe(
        "Pulled actionable presentations in global durable created/adopted order, each labelled with its canonical workspace.",
      ),
    count: z.number().int().min(0).max(8).describe("Number of returned entries."),
    has_more: z.boolean().describe("True when more eligible entries remain."),
  })
  .strict();

export const inboxGetInputSchema = z
  .object({
    id: inboxId,
    cursor: presentationCursor.optional(),
    workspace: workspacePath.optional(),
  })
  .strict();

export const inboxGetOutputSchema = z.object({ presentation: inboxPresentationSchema }).strict();

export const metadataSetInputSchema = z
  .object({
    workspace: workspacePath.optional(),
    metadata: workspaceMetadataDescriptorSchema.describe("Complete WorkspaceMetadataDescriptor v1 document."),
  })
  .strict();

export const metadataSetOutputSchema = z
  .object({
    metadata: workspaceMetadataDescriptorSchema,
    replaced: z.boolean().describe("True when an existing same-id descriptor was replaced."),
  })
  .strict();

export const metadataShowInputSchema = z.object({ workspace: workspacePath.optional() }).strict();
export const metadataShowOutputSchema = z
  .object({
    metadata: workspaceMetadataDescriptorSchema
      .nullable()
      .describe("Active descriptor, or null when none is registered."),
  })
  .strict();

export const metadataClearInputSchema = z.object({ workspace: workspacePath.optional() }).strict();
export const metadataClearOutputSchema = z
  .object({
    cleared: z.boolean().describe("True when a descriptor was removed; false when already clear."),
  })
  .strict();

export const sessionBindInputSchema = z
  .object({
    session_id: sessionId,
    provider: z.string().min(1).optional(),
    workspace: workspacePath.optional(),
  })
  .strict();

export const sessionBindOutputSchema = z
  .object({
    bound: z.literal(true).describe("Always true on success."),
    session_id: sessionId,
  })
  .strict();

export const deliveryAckInputSchema = z
  .object({
    entry_id: inboxId,
    session_id: sessionId.optional().describe("Required only when the MCP host provides no session identity."),
  })
  .strict();

export const deliveryAckOutputSchema = z
  .object({
    entry_id: inboxId,
    presented: z.literal(true).describe("Always true on success."),
  })
  .strict();

const absoluteFilePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), { message: "path must be absolute" })
  .describe("Absolute path to an existing regular file to present.");

export const askInputSchema = z
  .object({
    workspace: workspacePath.optional(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe("Workspace-relative artifact the question concerns. Required — a question needs a document."),
    question: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "What you want the human to answer. OMIT IT to simply point at a passage: the mark appears in their " +
          "margin with nothing to answer, and the call returns immediately instead of waiting.",
      ),
    quote: z
      .object({
        exact: z
          .string()
          .min(1)
          .max(2048)
          .describe("Text copied verbatim from the artifact SOURCE. glosa maps it onto the rendered passage."),
        prefix: z
          .string()
          .max(256)
          .optional()
          .describe("Source text immediately before `exact`. Supply it when the quote may occur more than once."),
        suffix: z.string().max(256).optional().describe("Source text immediately after `exact`."),
      })
      .strict()
      .optional()
      .describe("The passage to mark. Omit for a question about the artifact as a whole."),
    options: z
      .array(z.string().min(1).max(96))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "Answer choices in your own words, when the question has a small set of sensible answers " +
          '("covered", "thin", "missing"). glosa ALWAYS adds a free-text field beside them, so ' +
          "offering options never stops the human answering something you did not anticipate. Omit for an " +
          "open question.",
      ),
    label: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "A short name for this session shown beside your provider ('api-refactor'). glosa renders it as a " +
          "claim, not a verified identity.",
      ),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(900)
      .optional()
      .describe(
        "How long to block waiting for the answer. Defaults to 600. The call returns as soon as the human " +
          "answers. On timeout it returns outcome 'unanswered' and the question STAYS in their margin, so a " +
          "later answer still reaches you through the inbox.",
      ),
  })
  .strict();

const watchCheckpointSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("Full 40-hex shadow-git checkpoint sha.");

export const watchInputSchema = z
  .object({
    workspace: workspacePath.optional().describe("Workspace directory to watch; defaults to the MCP process cwd."),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Workspace-relative artifact to scope the watch to. Omit to watch the whole workspace."),
    since: watchCheckpointSha
      .optional()
      .describe(
        "A full checkpoint sha previously returned as latest_checkpoint. Entries at or before it are " +
          "excluded. Omit it to resume from wherever this session left off; when has_more is true, re-call " +
          "WITHOUT since rather than with an old cursor, so no unpresented entry sharing a split checkpoint " +
          "is skipped.",
      ),
    wait_ms: z
      .number()
      .int()
      .min(0)
      .max(900_000)
      .optional()
      .describe(
        "How long to hold the call waiting for a new external_edit, in milliseconds (cap 900000 = 15 " +
          "minutes). 0 or omitted returns immediately with whatever is already pending. Every entry this " +
          "call returns is marked presented to THIS session only — no other session is nudged by it.",
      ),
    session_id: sessionId
      .optional()
      .describe(
        "Registered session to watch as. Must match the MCP host session when provided, and must already " +
          "be explicitly bound to the target workspace (glosa_session_bind) — an unbound session cannot watch.",
      ),
  })
  .strict();

export const watchOutputSchema = z
  .object({
    entries: z
      .array(inboxPresentationSchema)
      .describe(
        "Unpresented external_edit entries in scope, oldest first. Self-echo is not filtered: an entry " +
          "may be this session's own un-leased write, not necessarily someone else's change.",
      ),
    latest_checkpoint: watchCheckpointSha
      .nullable()
      .describe(
        "A safe resume watermark: the newest checkpoint every one of whose in-scope entries is now either " +
          "presented to this session or already was. Pass it back as since on a LATER call once this " +
          "response's has_more is false; null when no such checkpoint exists yet.",
      ),
    has_more: z.boolean().describe("True when unpresented entries remain; re-call without since to drain them."),
  })
  .strict();

export const askOutputSchema = z
  .object({
    id: inboxId,
    outcome: z
      .enum(["answered", "declined", "unanswered", "posted"])
      .describe(
        "answered: the human replied. declined: they explicitly could not answer. unanswered: the wait " +
          "elapsed and the question is still open in glosa. posted: no question was asked, so nothing was " +
          "waited for.",
      ),
    answer: z.string().optional().describe("What the human typed, when they typed anything."),
    chose: z.string().optional().describe("The option they picked, when the question offered options."),
    anchored: z.boolean().describe("False when the quote could not be located in the current text."),
  })
  .strict();

/** Accepts both vocabularies and emits only the current one, so an agent written against the
 * Preview/Annotate names keeps working while the wire converges on Read/Review. */
const presentationMode = z
  .enum(["read", "review", "edit", "preview", "annotate"])
  .transform((value) => (value === "preview" ? "read" : value === "annotate" ? "review" : value))
  .pipe(z.enum(["read", "review", "edit"]));

export const presentInputSchema = z
  .object({
    path: absoluteFilePath,
    mode: presentationMode.describe(
      "Initial presentation mode. read creates a read-locked visit; review and edit select an unlocked initial " +
        "mode. The former names preview and annotate are accepted and normalize to read and review.",
    ),
    session_id: sessionId
      .optional()
      .describe("Session to bind for review/edit when the MCP host does not provide one; ignored for mode read."),
  })
  .strict();

export const presentOutputSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .describe("Ready SPA URL with a short-TTL presentation token (p=), never the durable pairing token."),
    slug: z.string().min(1),
    path: z.string().min(1).describe("Workspace work-tree path."),
    focus: z.string().min(1).optional().describe("Workspace-relative artifact path when known."),
    surface: z.enum(["document", "workspace"]),
    mode: z.enum(["read", "review", "edit"]),
    preview: z.boolean().describe("True when the visit is preview-locked."),
    bound_session: z
      .string()
      .min(1)
      .optional()
      .describe("Session id when annotate/edit binding succeeded; omitted for mode preview."),
    state_dir: z.string().min(1).optional().describe("Redirected state directory when applicable."),
    warnings: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .describe("Nonfatal warnings such as bind-failed or preview-bind-conflict; omitted for mode preview."),
  })
  .strict();
