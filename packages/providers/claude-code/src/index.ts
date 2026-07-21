// @glosa/providers-claude-code — see docs/requirements.md R4/R7 + docs/appendices/A2-claude-code-integration.md
export { ClaudeCodeProvider } from "./provider.ts";
export type { ChannelSender, ClaudeCodeProviderDeps, RewakeSignal, SessionLivenessSource } from "./provider.ts";
export { RewakeCoordinator, RewakeLeaseStore } from "./rewake.ts";
export type { RearmResult, RewakeCoordinatorDeps, RewakeLeaseStoreDeps, WatcherLease } from "./rewake.ts";
export { looksLikeClaudeHookInput } from "./hook-types.ts";
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
