// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — glosa home dir resolution. Everything the daemon owns (lock, log, later the
// journal/inbox/shadow-git) roots here. `GLOSA_HOME` is honored everywhere so tests are hermetic
// and never touch a real `~/.glosa` (see docs/appendices/A5-daemon-architecture.md §F13).
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INSTALL_ID, isSourceCheckout } from "./install.ts";

/**
 * A source checkout never shares `~/.glosa` with a published install: they would share one lock,
 * one pairing token and one workspace index, and each would evict the other's daemon.
 *
 * OUTSIDE the working tree, deliberately. Putting this under the checkout would leave a plaintext
 * bearer credential inside a git repository, where `.gitignore` protects only git-mediated paths —
 * not backup/sync, and above all not the coding agents that read a whole repository, which is
 * exactly the tooling glosa is built to sit beside.
 */
function devHome(): string {
  return join(homedir(), ".glosa-dev", INSTALL_ID);
}

export function glosaHome(): string {
  const explicit = Bun.env.GLOSA_HOME;
  if (explicit !== undefined) return explicit;
  return isSourceCheckout() ? devHome() : join(homedir(), ".glosa");
}

export function ensureHomeDir(home: string = glosaHome()): string {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export function lockPath(home: string = glosaHome()): string {
  return join(home, "daemon.lock");
}

export function logPath(home: string = glosaHome()): string {
  return join(home, "daemon.log");
}

/**
 * The Unix socket every programmatic client authenticates over (A3 §3.2). It lives in its OWN
 * directory rather than beside the lock, and that directory is the load-bearing permission:
 * `Bun.serve({unix})` creates the socket at 0755 and the `chmod` to 0600 necessarily lands after
 * it, so for that instant only the parent's traversal bit stands between another uid and the
 * API. `<GLOSA_HOME>` itself is created with no explicit mode and inherits whatever umask the
 * daemon happened to run under, so nothing here may lean on it.
 *
 * Verified on Darwin 25.2 with fresh unpooled `connect(2)`: the kernel enforces BOTH the socket's
 * own mode and the parent directory's traversal bit — `chmod 000` on either yields EACCES. (A
 * probe written with `fetch` reports otherwise, because Bun's connection pool answers without
 * ever calling `connect`.)
 */
export function runDir(home: string = glosaHome()): string {
  return join(home, "run");
}

export function apiSocketPath(home: string = glosaHome()): string {
  return join(runDir(home), "api.sock");
}

/** Creates the run directory at 0700, and returns an already-existing one to that mode. The
 * repair is not paranoia: a run dir that has drifted looser is the single state that reopens the
 * window the directory exists to close, and unlike `<GLOSA_HOME>` this directory is glosa's own
 * artifact, so tightening it cannot surprise anyone who put something there. */
export function ensureRunDir(home: string = glosaHome()): string {
  const dir = runDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Where a Claude Code session monitor takes its singleton lock (issue #306). Its OWN directory,
 * not `run/`: `ensureRunDir` repairs that directory's mode, and a monitor that repaired daemon
 * state would contradict its own contract ("never starts, stops, or repairs a daemon"). The
 * monitor creates this one and nothing else does.
 *
 * The session id is hashed rather than interpolated. `CLAUDE_CODE_SESSION_ID` arrives from the
 * host environment and nothing upstream constrains it — the only validation in the tree lives
 * inside `deriveMonitorTranscriptPath`, which RETURNS UNDEFINED rather than refusing, so a raw id
 * here would be a path-traversal primitive. Hashing also bounds the name's length.
 *
 * `GLOSA_HOME` is the whole of the scoping, deliberately: a monitor can only reach the daemon
 * named by its own home's lock, so two homes are two daemons and two push registries, with no
 * session-slot contention to guard against.
 */
export function monitorLockDir(home: string = glosaHome()): string {
  return join(home, "monitors");
}

export function monitorLockPath(home: string, sessionId: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(monitorLockDir(home), `${digest}.lock`);
}
