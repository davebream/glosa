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
  SessionBinding,
} from "./agent-provider/interface.ts";
export { AgentProviderRegistry, recordDelivery } from "./agent-provider/interface.ts";
export { SessionPushRegistry } from "./agent-provider/push-registry.ts";
export type { AuthorizeOptions, AuthorizeResult, RouteClass } from "./auth.ts";
export { authorizeRequest, isForeignOrigin } from "./auth.ts";
export type { ParsedBuildId } from "./build-id.ts";
export { APP_VERSION, BUILD_ID, computeBuildId, parseBuildId, runtimeSourceFiles } from "./build-id.ts";
export * from "./bus/index.ts";
export type { ConfineResult } from "./confine-path.ts";
export { confinePath } from "./confine-path.ts";
export type { ContractCheck } from "./contract.ts";
export { CONTRACT_VERSION, checkContractVersion, DAEMON_VERSION } from "./contract.ts";
export { classFCspHeaders, spaCspHeaders } from "./csp.ts";
export type { HandshakeResponse } from "./handshake.ts";
export { fetchHandshake, pollHandshake, probePortBound } from "./handshake.ts";
export { ensureHomeDir, glosaHome, lockPath, logPath } from "./home.ts";
export type { ApiContext, HandshakeBody } from "./http.ts";
export { createApiFetch, createClassFFetch } from "./http.ts";
export type { DaemonConnection, EnsureDaemonResult } from "./lifecycle.ts";
export { bootDaemon, buildChildEnv, ensureDaemon } from "./lifecycle.ts";
export type { DaemonLock } from "./lock.ts";
export {
  isPidAlive,
  parseLock,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
} from "./lock.ts";
export type { MatchedFile, MatcherArtifactsConfig, MatcherConfig, ResolveMatchedFilesResult } from "./matcher.ts";
// P5.1 — the CLI's `doctor` needs the SAME matcher the daemon uses for its "workspace" check
// (non-empty tracked set), rather than reimplementing a second, driftable copy of the include/
// exclude glob logic (A4 §F20: "no consumer is allowed to hold its own glob").
export { DEFAULT_MATCHER_CONFIG, loadMatcherConfig, resolveMatchedFiles } from "./matcher.ts";
export type { ProblemSlug } from "./problem.ts";
export { internalErrorResponse, problem } from "./problem.ts";
export type { ProtocolVersion } from "./protocol.ts";
export { PROTOCOL_VERSION, protocolCompatible } from "./protocol.ts";
export type { RouteResult } from "./registry/routing.ts";
export { route } from "./registry/routing.ts";
export type {
  Liveness,
  RegisterInput,
  RegisterResult,
  SessionRecord,
  SessionRegistryDeps,
} from "./registry/session-registry.ts";
export {
  isCwdAncestorOf,
  SessionRegistry,
} from "./registry/session-registry.ts";
export type { TokenMutationDeps, TokenSource } from "./token.ts";
export {
  ensureToken,
  loadToken,
  mintToken,
  revokeToken,
  rotateToken,
  TokenAuthority,
  tokenMatches,
  tokenPath,
} from "./token.ts";
export type { ConfineTranscriptResult } from "./transcript/root.ts";
// P5.1 — `glosa doctor`'s "transcript-root" check (A6 §F30) needs the SAME `$CLAUDE_CONFIG_DIR`
// resolution the daemon uses to confine a live session's transcript_path (A2 §F16) — never a
// second, independently-hardcoded `~/.claude` guess.
export { claudeConfigDir, confineTranscriptPath } from "./transcript/root.ts";
