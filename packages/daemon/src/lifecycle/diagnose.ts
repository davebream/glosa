// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — read-only diagnosis of why no daemon could be reached (issue #139). Spawns
// nothing, signals nothing, writes nothing: this exists so `glosa doctor` can NAME the state a
// user is in, and the report that prompted it described a machine where every command said
// "daemon unreachable" while a live process sat on the port. "Unreachable" is a symptom shared by
// four unrelated situations, and only one of them wants a human to kill something.
import { fetchHandshake, probePortBindable } from "./handshake.ts";
import { lockPath } from "./home.ts";
import { isPidAlive, readLock } from "./lock.ts";
import { glosaPort } from "./port.ts";

const DIAGNOSIS_HANDSHAKE_MS = 1000;

export type DaemonDiagnosisKind =
  /** A live process holds the port and answers nothing — the state issue #139 reported. */
  | "wedged"
  /** Something holds the port, but no ownership record claims it. */
  | "port-occupied"
  /** An ownership record survives a daemon that does not. */
  | "stale-lock"
  /** The port answers a glosa handshake; whatever failed was not reachability. */
  | "answering"
  /** Nothing is running and nothing is in the way. */
  | "no-daemon";

export interface DaemonDiagnosis {
  kind: DaemonDiagnosisKind;
  port: number;
  pid?: number;
  /** One sentence a user can act on, or ignore knowingly. */
  detail: string;
}

/** Classifies the local daemon state from the lock, PID liveness, a handshake, and — decisively —
 * whether the port can be bound. The bind is what separates "wedged" from "stale lock": a daemon
 * that has stopped accepting refuses connections while still holding the address, so connecting is
 * not evidence of anything (see `probePortBindable`). */
export async function diagnoseDaemon(home: string, seedPort: number = glosaPort()): Promise<DaemonDiagnosis> {
  const lock = readLock(lockPath(home));
  const port = lock?.port ?? seedPort;

  const handshake = await fetchHandshake(port, DIAGNOSIS_HANDSHAKE_MS);
  if (handshake) {
    return {
      kind: "answering",
      port,
      pid: handshake.pid,
      detail:
        `a glosa daemon (PID ${handshake.pid}) is answering on 127.0.0.1:${port}, so this failure ` +
        "is not about reaching it",
    };
  }

  const bindable = await probePortBindable(port);
  if (!bindable) {
    if (lock && isPidAlive(lock.pid)) {
      return {
        kind: "wedged",
        port,
        pid: lock.pid,
        detail:
          `the glosa daemon (PID ${lock.pid}) still holds 127.0.0.1:${port} but answers nothing — ` +
          "it is wedged, and it cannot run its own shutdown, so `kill -TERM " +
          `${lock.pid}\` will not end it either. \`kill -9 ${lock.pid}\` releases the port and the ` +
          "next glosa command starts a replacement",
      };
    }
    return {
      kind: "port-occupied",
      port,
      detail:
        `something holds 127.0.0.1:${port} without answering the glosa handshake, and no glosa ` +
        `ownership record claims it — find it with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\``,
    };
  }

  if (lock) {
    return {
      kind: "stale-lock",
      port,
      pid: lock.pid,
      detail:
        `${lockPath(home)} still names PID ${lock.pid} on port ${port}, but nothing is listening ` +
        "there; the next glosa command reclaims the record and starts a daemon",
    };
  }
  return {
    kind: "no-daemon",
    port,
    detail: `no glosa daemon is running and 127.0.0.1:${port} is free — the next glosa command starts one`,
  };
}
