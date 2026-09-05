// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — glosa home dir resolution. Everything the daemon owns (lock, log, later the
// journal/inbox/shadow-git) roots here. `GLOSA_HOME` is honored everywhere so tests are hermetic
// and never touch a real `~/.glosa` (see docs/appendices/A5-daemon-architecture.md §F13).
import { existsSync, mkdirSync } from "node:fs";
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
