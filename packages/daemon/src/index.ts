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
