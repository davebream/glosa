// SPDX-License-Identifier: Apache-2.0
import { accessSync, constants } from "node:fs";
import { WISPR_FLOW_KEYCHAIN_SERVICE, type WisprFlowCredentialStore } from "./keychain.ts";

export type CredentialFailure = "locked" | "unavailable" | "denied" | "cancelled" | "timeout" | "invalid";
const MESSAGES: Record<CredentialFailure, string> = {
  locked: "Unlock your desktop wallet, then retry dictation. Glosa does not unlock it in the background.",
  unavailable:
    "Secure storage is unavailable. Install libsecret and systemd utilities, enable KWallet Secret Service, and start Glosa in your desktop D-Bus session.",
  denied: "Desktop wallet access was denied. Allow Glosa access in your wallet settings, then retry.",
  cancelled: "The desktop wallet operation was cancelled. Retry configuration when ready.",
  timeout: "The desktop wallet did not respond. Check your desktop session and wallet, then retry.",
  invalid: "The desktop wallet returned an invalid credential result. Configure Wispr Flow again.",
};

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialFailure) {
    super(MESSAGES[code]);
    this.name = "CredentialStoreError";
  }
}

/** No provider/cloud credentials, shell startup files or D-Bus address discovery from another process. */
export function credentialHelperEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  for (const key of [
    "HOME",
    "USER",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
  ]) {
    const value = base[key];
    if (value) env[key] = value;
  }
  if (env.DBUS_SESSION_BUS_ADDRESS?.split(";").some((address) => !address.startsWith("unix:"))) {
    throw new CredentialStoreError("unavailable");
  }
  return env;
}

export interface CredentialHelperRequest {
  argv: string[];
  env: Record<string, string>;
  interactive: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
}
export interface CredentialHelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Output is private and bounded even when a helper fails. Never include it in an Error. */
export async function runCredentialHelper(request: CredentialHelperRequest): Promise<CredentialHelperResult> {
  request.signal?.throwIfAborted();
  let child: Bun.Subprocess<"inherit" | "ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(request.argv, {
      env: request.env,
      stdin: request.interactive ? "inherit" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new CredentialStoreError("unavailable");
  }
  let failure: CredentialFailure | undefined;
  const stop = (code: CredentialFailure) => {
    failure ??= code;
    child.kill("SIGKILL");
  };
  const abort = () => stop("cancelled");
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
  let size = 0;
  async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > 65536) {
        stop("invalid");
        continue;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
    if (failure) throw new CredentialStoreError(failure);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

function checked(result: CredentialHelperResult): string {
  if (result.code === 0) return result.stdout;
  // Recognize only known categories. Raw service errors may contain credential material.
  const error = result.stderr;
  if (/dismiss|cancel/i.test(error)) throw new CredentialStoreError("cancelled");
  if (/denied|not authorized|not permitted/i.test(error)) throw new CredentialStoreError("denied");
  if (/locked|IsLocked/i.test(error)) throw new CredentialStoreError("locked");
  throw new CredentialStoreError("unavailable");
}

export class LinuxSecretServiceCredentialStore implements WisprFlowCredentialStore {
  constructor(
    private readonly deps: {
      platform?: NodeJS.Platform;
      env?: NodeJS.ProcessEnv;
      run?: (request: CredentialHelperRequest) => Promise<CredentialHelperResult>;
      executable?: (path: string) => boolean;
    } = {},
  ) {}

  private async command(argv: string[], signal?: AbortSignal, interactive = false): Promise<string> {
    if ((this.deps.platform ?? process.platform) !== "linux") throw new CredentialStoreError("unavailable");
    const executable =
      this.deps.executable ??
      ((path: string) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (!["/usr/bin/secret-tool", "/usr/bin/busctl"].every(executable)) throw new CredentialStoreError("unavailable");
    return checked(
      await (this.deps.run ?? runCredentialHelper)({
        argv,
        env: credentialHelperEnv(this.deps.env ?? process.env),
        signal,
        interactive,
        timeoutMs: interactive ? 120_000 : 5_000,
      }),
    );
  }

  private attributes(account: string): string[] {
    if (!/^[0-9a-f-]{36}$/i.test(account)) throw new CredentialStoreError("invalid");
    return ["service", WISPR_FLOW_KEYCHAIN_SERVICE, "account", account];
  }

  private async items(account: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.command(
      [
        "/usr/bin/busctl",
        "--user",
        "--json=short",
        "--auto-start=no",
        "call",
        "org.freedesktop.secrets",
        "/org/freedesktop/secrets",
        "org.freedesktop.Secret.Service",
        "SearchItems",
        "a{ss}",
        "2",
        ...this.attributes(account),
      ],
      signal,
    );
    let result: { type?: string; data?: unknown };
    try {
      result = JSON.parse(output);
    } catch {
      throw new CredentialStoreError("invalid");
    }
    if (
      result.type !== "aoao" ||
      !Array.isArray(result.data) ||
      result.data.length !== 2 ||
      !result.data.every(
        (paths) =>
          Array.isArray(paths) &&
          paths.every((path) => typeof path === "string" && /^\/org\/freedesktop\/secrets\/[A-Za-z0-9_/]+$/.test(path)),
      )
    ) {
      throw new CredentialStoreError("invalid");
    }
    const [unlocked, locked] = result.data as [string[], string[]];
    if (locked.length) throw new CredentialStoreError("locked");
    if (unlocked.length > 1) throw new CredentialStoreError("invalid");
    return unlocked;
  }

  async has(account: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.items(account, signal)).length === 1;
  }

  async read(account: string, signal?: AbortSignal): Promise<string | null> {
    if (!(await this.has(account, signal))) return null;
    // lookup automatically unlocks. search without --unlock never requests unlocking, even if
    // the wallet locks between SearchItems and this call. Its output MUST remain a private pipe.
    const output = await this.command(["/usr/bin/secret-tool", "search", ...this.attributes(account)], signal);
    const secrets = output.split("\n").filter((line) => line.startsWith("secret = "));
    if (secrets.length !== 1) throw new CredentialStoreError("locked");
    const secret = secrets[0]!.slice("secret = ".length).trim();
    if (!secret || secret.length > 8192) throw new CredentialStoreError("invalid");
    return secret;
  }

  async addInteractive(account: string): Promise<void> {
    // secret-tool uses getpass on inherited TTY input. No key passes through argv or a file.
    await this.command(
      ["/usr/bin/secret-tool", "store", "--label=Glosa Wispr Flow", ...this.attributes(account)],
      undefined,
      true,
    );
  }

  async remove(account: string, options: { interactive?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    if (options.interactive) {
      await this.command(["/usr/bin/secret-tool", "clear", ...this.attributes(account)], options.signal, true);
      return true;
    }
    // Delete may return a prompt object. Never invoke it during rollback or JSON/non-TTY disable.
    for (const path of await this.items(account, options.signal)) {
      const output = await this.command(
        [
          "/usr/bin/busctl",
          "--user",
          "--json=short",
          "--auto-start=no",
          "call",
          "org.freedesktop.secrets",
          path,
          "org.freedesktop.Secret.Item",
          "Delete",
        ],
        options.signal,
      );
      try {
        const result = JSON.parse(output);
        if (result.type !== "o" || result.data?.[0] !== "/") return false;
      } catch {
        throw new CredentialStoreError("invalid");
      }
    }
    return true;
  }
}
