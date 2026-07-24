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
      .describe("Pulled actionable presentations in journal creation order."),
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
    workspace: workspacePath.optional(),
  })
  .strict();

export const sessionBindOutputSchema = z
  .object({
    bound: z.literal(true).describe("Always true on success."),
    session_id: sessionId,
  })
  .strict();

export const conversationAckInputSchema = z
  .object({
    message_id: messageId,
    session_id: sessionId.optional().describe("Required only when the MCP host provides no session identity."),
  })
  .strict();

export const conversationAckOutputSchema = z
  .object({
    message_id: messageId,
    delivered: z.literal(true).describe("Always true on success."),
  })
  .strict();

const absoluteFilePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), { message: "path must be absolute" })
  .describe("Absolute path to an existing regular file to present.");

export const presentInputSchema = z
  .object({
    path: absoluteFilePath,
    mode: z
      .enum(["preview", "annotate", "edit"])
      .describe(
        "Initial presentation mode. preview creates a preview-locked visit; annotate and edit select an unlocked initial mode.",
      ),
    session_id: sessionId
      .optional()
      .describe(
        "Session to bind for annotate/edit when the MCP host does not provide one; ignored for mode preview.",
      ),
  })
  .strict();

export const presentOutputSchema = z
  .object({
    url: z.string().min(1).describe("Ready SPA URL with a short-TTL presentation token (p=), never the durable pairing token."),
    slug: z.string().min(1),
    path: z.string().min(1).describe("Workspace work-tree path."),
    focus: z.string().min(1).optional().describe("Workspace-relative artifact path when known."),
    surface: z.enum(["document", "workspace"]),
    mode: z.enum(["preview", "annotate", "edit"]),
    preview: z.boolean().describe("True when the visit is preview-locked."),
    bound_session: z
      .string()
      .min(1)
      .optional()
      .describe("Session id when annotate/edit binding succeeded; omitted for mode preview."),
    state_dir: z.string().min(1).optional().describe("Redirected state directory when applicable."),
    warnings: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .describe(
        "Nonfatal warnings such as bind-failed or preview-bind-conflict; omitted for mode preview.",
      ),
  })
  .strict();
