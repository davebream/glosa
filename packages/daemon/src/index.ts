// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — see docs/requirements.md + docs/appendices

export type { WorkspaceMetadataArtifact, WorkspaceMetadataDescriptor } from "./adapters/workspace-metadata.ts";
export {
  MAX_WORKSPACE_METADATA_BYTES,
  validateWorkspaceMetadata,
  WORKSPACE_METADATA_VERSION,
  WorkspaceMetadataError,
  WorkspaceMetadataRegistry,
  workspaceMetadataPath,
} from "./adapters/workspace-metadata.ts";
export type {
  DesiredInstallHook,
  InitScope,
  InstallBin,
  InstallRoots,
  ProviderDetectionDeps,
  ProviderId,
  ProviderInstallDescriptor,
  ProviderInstallTarget,
} from "./agent-provider/install.ts";
// NOTE: `DeliveryOutcome`/`DeliveryVia`/`DeliveryReason` are NOT re-listed here even though
// `agent-provider/interface.ts` also re-exports them — they already flow through from
// `bus/index.ts`'s star-export above (the canonical definition lives in `bus/lifecycle.ts`);
// naming them again from `agent-provider/interface.ts` would be a duplicate-export collision.
export type {
  AgentProvider,
  DeliverableEntry,
  DeliveryResult,
  Liveness as ProviderLiveness,
  ProviderCapabilities,
  ProviderConnectPrompt,
  ProviderConnectTarget,
  SessionBinding,
} from "./agent-provider/interface.ts";
export { AgentProviderRegistry, recordDelivery } from "./agent-provider/interface.ts";
export { SessionPushRegistry } from "./agent-provider/push-registry.ts";
export * from "./bus/index.ts";
export type { ParsedBuildId } from "./lifecycle/build-id.ts";
export { APP_VERSION, BUILD_ID, computeBuildId, parseBuildId, runtimeSourceFiles } from "./lifecycle/build-id.ts";
export type { DaemonConnection, EnsureDaemonResult } from "./lifecycle/daemon.ts";
export { bootDaemon, buildChildEnv, ensureDaemon } from "./lifecycle/daemon.ts";
export type { HandshakeResponse } from "./lifecycle/handshake.ts";
export { fetchHandshake, pollHandshake, probePortBound } from "./lifecycle/handshake.ts";
export { ensureHomeDir, glosaHome, lockPath, logPath } from "./lifecycle/home.ts";
export type { DaemonLock } from "./lifecycle/lock.ts";
export {
  isPidAlive,
  parseLock,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
} from "./lifecycle/lock.ts";
export type { ProtocolVersion } from "./lifecycle/protocol.ts";
export { PROTOCOL_VERSION, protocolCompatible } from "./lifecycle/protocol.ts";
export type { MatchedFile, MatcherArtifactsConfig, MatcherConfig, ResolveMatchedFilesResult } from "./matcher.ts";
// P5.1 — the CLI's `doctor` needs the SAME matcher the daemon uses for its "workspace" check
// (non-empty tracked set), rather than reimplementing a second, driftable copy of the include/
// exclude glob logic (A4 §F20: "no consumer is allowed to hold its own glob").
export { DEFAULT_MATCHER_CONFIG, loadMatcherConfig, resolveMatchedFiles } from "./matcher.ts";
export type {
  Liveness,
  RegisterInput,
  SessionRecord,
  SessionRegistryDeps,
} from "./registry/session-registry.ts";
export {
  isCwdAncestorOf,
  SessionRegistry,
} from "./registry/session-registry.ts";
export type { ClassifyInitTargetDeps, InitTargetRisk, InitTargetVerdict } from "./registry/workspace-root.ts";
// issue #96 — the single workspace-root rule. The CLI's `init`/`doctor` cwd defaults and the
// daemon's own open resolution must agree on what a path's workspace root is, so the rule lives
// here (cli -> daemon is the only allowed dependency direction) rather than in two copies.
export {
  classifyInitTarget,
  enclosingGitRoot,
  isGitRepoRoot,
  workspaceRootFor,
} from "./registry/workspace-root.ts";
export type { AuthorizeOptions, AuthorizeResult, RouteClass } from "./security/auth.ts";
export { authorizeRequest, isForeignOrigin } from "./security/auth.ts";
export type { ConfineResult } from "./security/confine-path.ts";
export { confinePath } from "./security/confine-path.ts";
export { classFCspHeaders, spaCspHeaders } from "./security/csp.ts";
export type { TokenMutationDeps, TokenSource } from "./security/token.ts";
export {
  ensureToken,
  loadToken,
  mintToken,
  revokeToken,
  rotateToken,
  TokenAuthority,
  tokenMatches,
  tokenPath,
} from "./security/token.ts";
export type { ConfineTranscriptResult } from "./transcript/root.ts";
// P5.1 — `glosa doctor`'s "transcript-root" check (A6 §F30) needs the SAME `$CLAUDE_CONFIG_DIR`
// resolution the daemon uses to confine a live session's transcript_path (A2 §F16) — never a
// second, independently-hardcoded `~/.claude` guess.
export { claudeConfigDir, claudeConfigRoots, confineTranscriptPath } from "./transcript/root.ts";
export type { ContractCheck } from "./transport/contract.ts";
export { CONTRACT_VERSION, checkContractVersion, DAEMON_VERSION } from "./transport/contract.ts";
export type { ApiContext, HandshakeBody } from "./transport/http.ts";
export { createApiFetch, createClassFFetch } from "./transport/http.ts";
export type { ProblemSlug } from "./transport/problem.ts";
export { internalErrorResponse, problem } from "./transport/problem.ts";
