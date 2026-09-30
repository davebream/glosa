// SPDX-License-Identifier: Apache-2.0
// Explicit selection of the bundled app as the executable recorded for one Glosa home.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INSTALL_ID } from "../../daemon/src/lifecycle/install.ts";
import { fetchHandshake, probePortBindable, type HandshakeResponse } from "../../daemon/src/lifecycle/handshake.ts";
import { glosaHome, lockPath } from "../../daemon/src/lifecycle/home.ts";
import { readLock, type DaemonLock } from "../../daemon/src/lifecycle/lock.ts";
import { glosaPort } from "../../daemon/src/lifecycle/port.ts";
import { type CommandEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";
import { classifyInstall, currentPackageRoot, type InstallKind, recordingPlan } from "./install-kind.ts";
import {
  type RecordedExecutable,
  readPackageType,
  readRecordedExecutable,
  restoreAutomaticRecording,
  selectRecordedExecutable,
} from "./install-link.ts";

export type InstallAction = "select" | "auto";
export interface InstallSelectionDeps {
  home: () => string;
  port: () => number;
  installId: string;
  kind: InstallKind;
  executable: string;
  recorded: (home: string) => RecordedExecutable;
  lock: (home: string) => DaemonLock | null;
  handshake: (port: number) => Promise<HandshakeResponse | null>;
  bindable: (port: number) => Promise<boolean>;
  select: (home: string, executable: string) => string;
  auto: (home: string, executable: string) => string;
}

export interface InstallSelectionData {
  mode: "selected" | "automatic";
  executable: string;
  recorded: string;
}

function error(
  code: number,
  kind: string,
  message: string,
): CommandEnvelope<InstallSelectionData | Record<string, never>> {
  return {
    ok: false,
    command: "install",
    exitCode: code,
    data: {},
    warnings: [],
    error: { code: kind, kind, message },
  };
}

export function realInstallSelectionDeps(): InstallSelectionDeps {
  const root = currentPackageRoot();
  const kind = classifyInstall(root, existsSync(join(root, ".git")), readPackageType(root)).kind;
  const executable = recordingPlan(kind, root, join(root, "packages", "cli", "src", "main.ts")).executable;
  return {
    home: glosaHome,
    port: glosaPort,
    installId: INSTALL_ID,
    kind,
    executable,
    recorded: readRecordedExecutable,
    lock: (home) => readLock(lockPath(home)),
    handshake: (port) => fetchHandshake(port, 1000),
    bindable: probePortBindable,
    select: selectRecordedExecutable,
    auto: restoreAutomaticRecording,
  };
}

/** A selection never starts or stops a daemon. Unknown ownership is a refusal. */
export async function runInstallSelection(
  action: string,
  deps: InstallSelectionDeps = realInstallSelectionDeps(),
): Promise<CommandEnvelope<InstallSelectionData | Record<string, never>>> {
  if (action !== "select" && action !== "auto") {
    return error(EXIT_CODES.USAGE, "usage", "Expected `glosa install select` or `glosa install auto`.");
  }
  if (action === "select" && deps.kind !== "app-bundle" && deps.kind !== "pacman") {
    return error(EXIT_CODES.USAGE, "usage", "Run `glosa install select` with the CLI carried by the desktop app.");
  }
  const home = deps.home();
  const before = deps.recorded(home);
  if (before.state === "file") {
    return error(
      EXIT_CODES.FOREIGN_CONFIG_CONFLICT,
      "hand-pinned",
      `${before.path} is a hand-pinned file. Glosa will not replace it.`,
    );
  }
  if (action === "auto" && before.state !== "managed-pin") {
    return error(EXIT_CODES.USAGE, "not-selected", "There is no Glosa-managed install selection to reset.");
  }

  const lock = deps.lock(home);
  const port = lock?.port ?? deps.port();
  const handshake = await deps.handshake(port);
  if (handshake) {
    if (
      !lock ||
      lock.instance_id !== handshake.instance_id ||
      lock.pid !== handshake.pid ||
      lock.install_id !== handshake.install_id ||
      !handshake.install_id
    ) {
      return error(
        EXIT_CODES.FOREIGN_CONFIG_CONFLICT,
        "uncertain-daemon",
        `A daemon answers on port ${port}, but its lock and handshake do not prove one owner. Run glosa doctor before switching installs.`,
      );
    }
    if (handshake.install_id !== deps.installId) {
      const busy = handshake.managed_busy ? " Wait for its managed chats to finish." : "";
      return error(
        EXIT_CODES.FOREIGN_CONFIG_CONFLICT,
        "foreign-daemon",
        `Another install's daemon (PID ${handshake.pid}) owns port ${port}.${busy} Stop that verified process with \`kill -TERM ${handshake.pid}\`, wait for it to exit, then retry.`,
      );
    }
  } else if (lock || !(await deps.bindable(port))) {
    return error(
      EXIT_CODES.FOREIGN_CONFIG_CONFLICT,
      "uncertain-daemon",
      `Daemon ownership on port ${port} is uncertain. Run glosa doctor and resolve it before switching installs.`,
    );
  }

  try {
    const recorded = action === "select" ? deps.select(home, deps.executable) : deps.auto(home, deps.executable);
    return {
      ok: true,
      command: "install",
      exitCode: EXIT_CODES.OK,
      data: { mode: action === "select" ? "selected" : "automatic", executable: deps.executable, recorded },
      warnings: [],
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return error(EXIT_CODES.FOREIGN_CONFIG_CONFLICT, "install-selection", message);
  }
}

export function printInstallSelection(
  result: CommandEnvelope<InstallSelectionData | Record<string, never>>,
  json: boolean,
): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa install: ${result.error?.message ?? "selection failed"}\n`);
    return;
  }
  const data = result.data as InstallSelectionData;
  process.stdout.write(
    data.mode === "selected"
      ? `Selected ${data.executable} for this Glosa home.\n`
      : `Automatic install recording restored for this Glosa home.\n`,
  );
}
