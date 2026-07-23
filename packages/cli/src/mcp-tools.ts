// SPDX-License-Identifier: Apache-2.0
// Declarative MCP 2025-11-25 tool contract for glosa's product-scoped stdio shim.
// Schemas describe the wire shape only; daemon semantic validation remains authoritative.

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

export type JsonSchema = Record<string, unknown>;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: McpToolAnnotations;
  execution: { taskSupport: "forbidden" };
}

const workspacePath: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Absolute or relative workspace directory path; defaults to the MCP process cwd when omitted.",
};

const sessionId: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Registered agent session identity.",
};

const inboxId: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Durable inbox entry id.",
};

const messageId: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Targeted conversation message id.",
};

const presentationCursor: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Opaque continuation cursor from a prior truncated presentation.",
};

const workspaceMetadataArtifact: JsonSchema = {
  type: "object",
  title: "WorkspaceMetadataArtifact",
  description: "One declarative artifact entry in WorkspaceMetadataDescriptor v1.",
  required: ["path"],
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description: "Workspace-relative artifact path.",
    },
    class: {
      type: "string",
      enum: ["R", "F"],
      description: "Optional artifact class hint (R = markdown, F = foreign HTML).",
    },
    order: {
      type: "integer",
      minimum: 0,
      description: "Optional sidebar ordering key.",
    },
    derived_from: {
      type: "object",
      required: ["path", "via"],
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Workspace-relative source artifact path.",
        },
        via: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Producer-declared process label for the derived-from edge.",
        },
      },
    },
    manifest: {
      type: "object",
      required: ["path", "component"],
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Workspace-relative class-F manifest path.",
        },
        component: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Manifest component identity for this artifact.",
        },
      },
    },
  },
};

export const workspaceMetadataDescriptorSchema: JsonSchema = {
  type: "object",
  title: "WorkspaceMetadataDescriptor",
  description: "WorkspaceMetadataDescriptor v1 — durable declarative adapter input.",
  required: ["version", "id", "artifacts"],
  additionalProperties: false,
  properties: {
    version: {
      const: 1,
      description: "Descriptor schema version; must be 1.",
    },
    id: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      description: "Stable integration-owned descriptor id.",
    },
    artifacts: {
      type: "array",
      maxItems: 2048,
      description: "Ordered artifact descriptors for this workspace.",
      items: workspaceMetadataArtifact,
    },
  },
};

const presentationTruncation: JsonSchema = {
  type: "object",
  required: ["truncated", "omitted_bytes", "omitted_hunks"],
  additionalProperties: false,
  properties: {
    truncated: { type: "boolean" },
    omitted_bytes: { type: "integer", minimum: 0 },
    omitted_hunks: { type: "integer", minimum: 0 },
  },
};

const presentationRetrieval: JsonSchema = {
  type: "object",
  required: ["command", "mcp_tool"],
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1, description: "CLI retrieval instruction." },
    mcp_tool: { const: "glosa_inbox_get", description: "MCP retrieval tool name." },
    cursor: presentationCursor,
  },
};

const presentationBaseProperties: Record<string, JsonSchema> = {
  id: inboxId,
  status: { type: "string", minLength: 1, description: "Derived inbox status at presentation time." },
  text: { type: "string", description: "Bounded actionable presentation text." },
  bytes: { type: "integer", minimum: 0, description: "UTF-8 byte length of text." },
  truncation: presentationTruncation,
  retrieval: presentationRetrieval,
  detail: {
    type: "object",
    description: "Kind-specific presentation detail; shape varies by entry kind.",
    additionalProperties: true,
  },
};

export const inboxPresentationSchema: JsonSchema = {
  title: "InboxPresentation",
  description: "Provider-neutral bounded actionable inbox presentation.",
  oneOf: [
    {
      type: "object",
      required: ["id", "kind", "status", "text", "bytes", "truncation", "retrieval", "detail"],
      additionalProperties: false,
      properties: {
        ...presentationBaseProperties,
        kind: { const: "annotation" },
      },
    },
    {
      type: "object",
      required: ["id", "kind", "status", "text", "bytes", "truncation", "retrieval", "detail"],
      additionalProperties: false,
      properties: {
        ...presentationBaseProperties,
        kind: { const: "human_edit" },
      },
    },
    {
      type: "object",
      required: ["id", "kind", "status", "text", "bytes", "truncation", "retrieval", "detail"],
      additionalProperties: false,
      properties: {
        ...presentationBaseProperties,
        kind: { const: "attention_request" },
      },
    },
    {
      type: "object",
      required: [
        "id",
        "kind",
        "status",
        "text",
        "bytes",
        "truncation",
        "retrieval",
        "detail",
        "message",
        "message_bytes",
        "target_session_id",
        "provider",
      ],
      additionalProperties: false,
      properties: {
        ...presentationBaseProperties,
        kind: { const: "conversation_message" },
        message: { type: "string", description: "Exact unmodified composer UTF-8 text." },
        message_bytes: { type: "integer", minimum: 0 },
        target_session_id: sessionId,
        provider: { type: "string", minLength: 1 },
      },
    },
  ],
};

function objectSchema(
  title: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    title,
    description,
    properties,
    required,
    additionalProperties: false,
  };
}

const readOnlyClosedWorld: McpToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

const stateChangingClosedWorld = (opts: {
  title: string;
  destructiveHint: boolean;
  idempotentHint: boolean;
}): McpToolAnnotations => ({
  title: opts.title,
  readOnlyHint: false,
  destructiveHint: opts.destructiveHint,
  idempotentHint: opts.idempotentHint,
  openWorldHint: false,
});

const forbiddenTasks = { taskSupport: "forbidden" as const };

export const GLOSA_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "glosa_inbox_pull",
    title: "Pull glosa inbox",
    description:
      "Pull the oldest pending actionable glosa inbox entries for a workspace (at most eight). Reserves delivery briefly; successful stdio write acknowledges presentation.",
    inputSchema: objectSchema(
      "GlosaInboxPullInput",
      "Arguments for glosa_inbox_pull.",
      {
        workspace: workspacePath,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Maximum entries to pull; defaults to 8.",
        },
        session_id: {
          ...sessionId,
          description:
            "Explicit registered session for targeted messages. Must match the MCP host session when the host provides one.",
        },
      },
    ),
    outputSchema: objectSchema(
      "GlosaInboxPullOutput",
      "Structured pull result: bounded presentations plus pagination flags.",
      {
        entries: {
          type: "array",
          maxItems: 8,
          description: "Pulled actionable presentations in journal creation order.",
          items: inboxPresentationSchema,
        },
        count: { type: "integer", minimum: 0, maximum: 8, description: "Number of returned entries." },
        has_more: { type: "boolean", description: "True when more eligible entries remain." },
      },
      ["entries", "count", "has_more"],
    ),
    annotations: { ...readOnlyClosedWorld, title: "Pull glosa inbox" },
    execution: forbiddenTasks,
  },
  {
    name: "glosa_inbox_get",
    title: "Get glosa inbox entry",
    description:
      "Retrieve one durable inbox entry presentation by id, optionally continuing from a truncation cursor. Does not perform delivery drain.",
    inputSchema: objectSchema(
      "GlosaInboxGetInput",
      "Arguments for glosa_inbox_get.",
      {
        id: inboxId,
        cursor: presentationCursor,
        workspace: workspacePath,
      },
      ["id"],
    ),
    outputSchema: objectSchema(
      "GlosaInboxGetOutput",
      "Structured get result wrapping one presentation.",
      {
        presentation: inboxPresentationSchema,
      },
      ["presentation"],
    ),
    annotations: { ...readOnlyClosedWorld, title: "Get glosa inbox entry" },
    execution: forbiddenTasks,
  },
  {
    name: "glosa_metadata_set",
    title: "Set workspace metadata",
    description:
      "Register or replace this integration's WorkspaceMetadataDescriptor v1 for a workspace. Same id replaces atomically; a different id conflicts until clear.",
    inputSchema: objectSchema(
      "GlosaMetadataSetInput",
      "Arguments for glosa_metadata_set.",
      {
        workspace: workspacePath,
        metadata: {
          ...workspaceMetadataDescriptorSchema,
          description: "Complete WorkspaceMetadataDescriptor v1 document.",
        },
      },
      ["metadata"],
    ),
    outputSchema: objectSchema(
      "GlosaMetadataSetOutput",
      "Result of registering or replacing workspace metadata.",
      {
        metadata: workspaceMetadataDescriptorSchema,
        replaced: {
          type: "boolean",
          description: "True when an existing same-id descriptor was replaced.",
        },
      },
      ["metadata", "replaced"],
    ),
    annotations: stateChangingClosedWorld({
      title: "Set workspace metadata",
      destructiveHint: false,
      idempotentHint: true,
    }),
    execution: forbiddenTasks,
  },
  {
    name: "glosa_metadata_show",
    title: "Show workspace metadata",
    description: "Show the active declarative WorkspaceMetadataDescriptor for a workspace, or null when none is registered.",
    inputSchema: objectSchema(
      "GlosaMetadataShowInput",
      "Arguments for glosa_metadata_show.",
      {
        workspace: workspacePath,
      },
    ),
    outputSchema: objectSchema(
      "GlosaMetadataShowOutput",
      "Active workspace metadata, if any.",
      {
        metadata: {
          anyOf: [workspaceMetadataDescriptorSchema, { type: "null" }],
          description: "Active descriptor, or null when unset.",
        },
      },
      ["metadata"],
    ),
    annotations: { ...readOnlyClosedWorld, title: "Show workspace metadata" },
    execution: forbiddenTasks,
  },
  {
    name: "glosa_metadata_clear",
    title: "Clear workspace metadata",
    description: "Clear the active declarative workspace metadata for a workspace.",
    inputSchema: objectSchema(
      "GlosaMetadataClearInput",
      "Arguments for glosa_metadata_clear.",
      {
        workspace: workspacePath,
      },
    ),
    outputSchema: objectSchema(
      "GlosaMetadataClearOutput",
      "Result of clearing workspace metadata.",
      {
        cleared: {
          type: "boolean",
          description: "True when a descriptor was removed; false when already clear.",
        },
      },
      ["cleared"],
    ),
    annotations: stateChangingClosedWorld({
      title: "Clear workspace metadata",
      destructiveHint: true,
      idempotentHint: true,
    }),
    execution: forbiddenTasks,
  },
  {
    name: "glosa_session_bind",
    title: "Bind agent session",
    description: "Explicitly bind a live registered agent session to a workspace (authoritative routing).",
    inputSchema: objectSchema(
      "GlosaSessionBindInput",
      "Arguments for glosa_session_bind.",
      {
        session_id: sessionId,
        workspace: workspacePath,
      },
      ["session_id"],
    ),
    outputSchema: objectSchema(
      "GlosaSessionBindOutput",
      "Result of an explicit session bind.",
      {
        bound: { const: true, description: "Always true on success." },
        session_id: sessionId,
      },
      ["bound", "session_id"],
    ),
    annotations: stateChangingClosedWorld({
      title: "Bind agent session",
      destructiveHint: false,
      idempotentHint: true,
    }),
    execution: forbiddenTasks,
  },
  {
    name: "glosa_conversation_ack",
    title: "Acknowledge conversation message",
    description:
      "Acknowledge that a targeted glosa conversation message reached this agent context (presented). Required after channel delivery; hook delivery remains the safety fallback.",
    inputSchema: objectSchema(
      "GlosaConversationAckInput",
      "Arguments for glosa_conversation_ack.",
      {
        message_id: messageId,
        session_id: {
          ...sessionId,
          description: "Required only when the MCP host provides no session identity.",
        },
      },
      ["message_id"],
    ),
    outputSchema: objectSchema(
      "GlosaConversationAckOutput",
      "Result of acknowledging a conversation message as presented.",
      {
        message_id: messageId,
        delivered: { const: true, description: "Always true on success." },
      },
      ["message_id", "delivered"],
    ),
    annotations: stateChangingClosedWorld({
      title: "Acknowledge conversation message",
      destructiveHint: false,
      idempotentHint: true,
    }),
    execution: forbiddenTasks,
  },
] as const;

export const GLOSA_MCP_TOOL_BY_NAME: ReadonlyMap<string, McpToolDefinition> = new Map(
  GLOSA_MCP_TOOLS.map((tool) => [tool.name, tool]),
);

export function listMcpTools(): McpToolDefinition[] {
  return GLOSA_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    execution: tool.execution,
  }));
}
