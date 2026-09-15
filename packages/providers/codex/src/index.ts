// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-codex — see docs/requirements.md R4/R7 + docs/research/codex-contract.md (T2a)
export { CodexProvider } from "./provider.ts";
export {
  CODEX_ATTACH_MAX_DELAY_MS,
  CODEX_ATTACH_MIN_DELAY_MS,
  CodexJsonRpcClient,
  codexAttachmentRuntime,
  codexAttachRetryDelay,
  codexControlSocketPath,
  runCodexAttachment,
} from "./app-server.ts";
export type { CodexAttachDeps, CodexAttachOptions, CodexControlClient } from "./app-server.ts";
export { UnixWebSocket } from "./unix-websocket.ts";
export { codexInstallDescriptor } from "./install.ts";
export type { CodexProviderDeps, SessionLivenessSource } from "./provider.ts";
export { looksLikeCodexHookInput } from "./hook-types.ts";
export type {
  CodexHookInput,
  CodexSessionEndHookInput,
  CodexSessionStartHookInput,
  CodexStopHookBlockOutput,
  CodexStopHookInput,
  CodexUserPromptSubmitHookInput,
} from "./hook-types.ts";
