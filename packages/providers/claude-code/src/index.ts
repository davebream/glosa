// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-claude-code — see docs/requirements.md R4/R7 + docs/appendices/A2-claude-code-integration.md
export { ClaudeCodeProvider } from "./provider.ts";
export type { ClaudeCodeProviderDeps, MonitorSender, SessionLivenessSource } from "./provider.ts";
export { looksLikeClaudeHookInput } from "./hook-types.ts";
export {
  deriveMonitorTranscriptPath,
  monitorRetryDelay,
  MONITOR_MAX_DELAY_MS,
  MONITOR_MIN_DELAY_MS,
  registeredWorkspaceForProject,
  runClaudeMonitor,
} from "./monitor.ts";
export type { MonitorDeps, MonitorOptions } from "./monitor.ts";
export type {
  ClaudeHookInput,
  NotificationHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopHookBlockOutput,
  StopHookInput,
  UserPromptSubmitHookInput,
  UserPromptSubmitHookOutput,
} from "./hook-types.ts";
