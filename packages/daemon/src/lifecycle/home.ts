// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — glosa home dir resolution. Everything the daemon owns (lock, log, later the
// journal/inbox/shadow-git) roots here. `GLOSA_HOME` is honored everywhere so tests are hermetic
// and never touch a real `~/.glosa` (see docs/appendices/A5-daemon-architecture.md §F13).
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function glosaHome(): string {
  return Bun.env.GLOSA_HOME ?? join(homedir(), ".glosa");
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
