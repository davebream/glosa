// @glosa/daemon — see docs/requirements.md + docs/appendices
export { bootDaemon, buildChildEnv, ensureDaemon } from "./lifecycle.ts";
export type { DaemonConnection, EnsureDaemonResult } from "./lifecycle.ts";
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
export { checkContractVersion, CONTRACT_VERSION, DAEMON_VERSION } from "./contract.ts";
export type { ContractCheck } from "./contract.ts";
export { classFCspHeaders, spaCspHeaders } from "./csp.ts";
export { createApiFetch, createClassFFetch } from "./http.ts";
export type { ApiContext, HandshakeBody } from "./http.ts";
export { internalErrorResponse, problem } from "./problem.ts";
export type { ProblemSlug } from "./problem.ts";
export { loadToken, tokenMatches, tokenPath } from "./token.ts";
export * from "./bus/index.ts";
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
