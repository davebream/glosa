// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — see docs/requirements.md + docs/appendices
export { bootDaemon, buildChildEnv, ensureDaemon } from "./lifecycle.ts";
export type { DaemonConnection, EnsureDaemonResult } from "./lifecycle.ts";
export { APP_VERSION, BUILD_ID, computeBuildId, parseBuildId, runtimeSourceFiles } from "./build-id.ts";
export type { ParsedBuildId } from "./build-id.ts";
export { PROTOCOL_VERSION, protocolCompatible } from "./protocol.ts";
export type { ProtocolVersion } from "./protocol.ts";
export { ensureHomeDir, glosaHome, lockPath, logPath } from "./home.ts";
export {
  isPidAlive,
  parseLock,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
} from "./lock.ts";
export type { DaemonLock } from "./lock.ts";
export { fetchHandshake, pollHandshake, probePortBound } from "./handshake.ts";
export type { HandshakeResponse } from "./handshake.ts";
export { authorizeRequest, isForeignOrigin } from "./auth.ts";
export type { AuthorizeOptions, AuthorizeResult, RouteClass } from "./auth.ts";
export { confinePath } from "./confine-path.ts";
export type { ConfineResult } from "./confine-path.ts";
export {
  MAX_WORKSPACE_METADATA_BYTES,
  WORKSPACE_METADATA_VERSION,
  WorkspaceMetadataError,
  WorkspaceMetadataRegistry,
  validateWorkspaceMetadata,
  workspaceMetadataPath,
} from "./adapters/workspace-metadata.ts";
export type { WorkspaceMetadataArtifact, WorkspaceMetadataDescriptor } from "./adapters/workspace-metadata.ts";
// P5.1 — `glosa doctor`'s "transcript-root" check (A6 §F30) needs the SAME `$CLAUDE_CONFIG_DIR`
// resolution the daemon uses to confine a live session's transcript_path (A2 §F16) — never a
// second, independently-hardcoded `~/.claude` guess.
export { claudeConfigDir, confineTranscriptPath } from "./transcript/root.ts";
export type { ConfineTranscriptResult } from "./transcript/root.ts";
export { checkContractVersion, CONTRACT_VERSION, DAEMON_VERSION } from "./contract.ts";
export type { ContractCheck } from "./contract.ts";
export { classFCspHeaders, spaCspHeaders } from "./csp.ts";
export { createApiFetch, createClassFFetch } from "./http.ts";
export type { ApiContext, HandshakeBody } from "./http.ts";
export { internalErrorResponse, problem } from "./problem.ts";
export type { ProblemSlug } from "./problem.ts";
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
export type { TokenMutationDeps, TokenSource } from "./token.ts";
export * from "./bus/index.ts";
// P5.1 — the CLI's `doctor` needs the SAME matcher the daemon uses for its "workspace" check
// (non-empty tracked set), rather than reimplementing a second, driftable copy of the include/
// exclude glob logic (A4 §F20: "no consumer is allowed to hold its own glob").
export { DEFAULT_MATCHER_CONFIG, loadMatcherConfig, resolveMatchedFiles } from "./matcher.ts";
export type { MatchedFile, MatcherArtifactsConfig, MatcherConfig, ResolveMatchedFilesResult } from "./matcher.ts";
// NOTE: `DeliveryOutcome`/`DeliveryVia`/`DeliveryReason` are NOT re-listed here even though
// `providers/interface.ts` also re-exports them — they already flow through from
// `bus/index.ts`'s star-export above (the canonical definition lives in `bus/lifecycle.ts`);
// naming them again from `providers/interface.ts` would be a duplicate-export collision.
export type {
  AgentProvider,
  DeliverableEntry,
  DeliveryResult,
  Liveness as ProviderLiveness,
  ProviderCapabilities,
  SessionBinding,
} from "./providers/interface.ts";
export { recordDelivery } from "./providers/interface.ts";
export {
  isCwdAncestorOf,
  SessionRegistry,
} from "./registry/session-registry.ts";
export type {
  RegisterInput,
  RegisterResult,
  SessionRecord,
  SessionRegistryDeps,
  Liveness,
} from "./registry/session-registry.ts";
export { route } from "./registry/routing.ts";
export type { RouteResult } from "./registry/routing.ts";
