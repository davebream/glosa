// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { glosaHome } from "@glosa/daemon";
import { isSourceCheckout } from "../../daemon/src/lifecycle/install.ts";
import {
  MacKeychainCredentialStore,
  readWisprFlowConfig,
  WISPR_FLOW_CONFIG_VERSION,
  WISPR_FLOW_CONSENT_VERSION,
  WISPR_FLOW_CONTEXT_LIMIT_BYTES,
  type WisprFlowConfig,
  type WisprFlowCredentialStore,
  writeWisprFlowConfig,
} from "../../providers/wispr-flow/src/index.ts";
import { confirmOnTty } from "./confirm.ts";
import { type CommandEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";

export type DictationAction = "configure" | "status" | "disable";

export interface DictationOptions {
  provider?: string;
  json?: boolean;
}

export interface DictationData {
  state?: "unconfigured" | "ready" | "disabled" | "error";
  provider?: "wispr-flow";
  display_name?: "Wispr Flow";
  consent_version?: number;
  context_limit_bytes?: number;
}

export interface DictationCommandDeps {
  home?: string;
  credentialStore?: WisprFlowCredentialStore;
  isTTY?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => Date;
  uuid?: () => string;
  platform?: NodeJS.Platform;
  developmentCredentialAvailable?: () => boolean;
}

const DISCLOSURE =
  "Wispr Flow dictation sends microphone audio and up to 256 KiB of visible Glosa text to Wispr " +
  "only after you click Dictate. Wispr API access and billing are separate. Inserted text remains a draft and is never submitted automatically.";

function failure(
  code: string,
  message: string,
  exitCode: number = EXIT_CODES.INTERNAL,
): CommandEnvelope<DictationData> {
  return {
    ok: false,
    command: "dictation",
    exitCode,
    data: { state: "error", provider: "wispr-flow", display_name: "Wispr Flow" },
    warnings: [],
    error: { code, kind: exitCode === EXIT_CODES.USAGE ? "usage" : "internal", message },
  };
}

function configuredConfig(now: Date, account: string, clientId: string): WisprFlowConfig {
  const timestamp = now.toISOString();
  return {
    version: WISPR_FLOW_CONFIG_VERSION,
    provider: "wispr-flow",
    enabled: true,
    consent_version: WISPR_FLOW_CONSENT_VERSION,
    consented_at: timestamp,
    context_policy: "visible-prose",
    context_limit_bytes: WISPR_FLOW_CONTEXT_LIMIT_BYTES,
    client_id: clientId,
    keychain_account: account,
    configured_at: timestamp,
  };
}

function developmentCredentialAvailable(deps: DictationCommandDeps): boolean {
  if (deps.developmentCredentialAvailable) return deps.developmentCredentialAvailable();
  return (
    isSourceCheckout() && Bun.env.GLOSA_WISPR_FLOW_ALLOW_ENV_KEY === "1" && Boolean(Bun.env.WISPR_FLOW_API_KEY?.trim())
  );
}

export async function runDictation(
  action: DictationAction,
  options: DictationOptions = {},
  deps: DictationCommandDeps = {},
): Promise<CommandEnvelope<DictationData>> {
  const home = deps.home ?? glosaHome();
  const credentialStore = deps.credentialStore ?? new MacKeychainCredentialStore();

  if (action === "status") {
    const result = readWisprFlowConfig(home);
    if (result.state === "missing") {
      return { ok: true, command: "dictation", exitCode: 0, data: { state: "unconfigured" }, warnings: [] };
    }
    if (result.state === "invalid") return failure("dictation-config-invalid", result.message);
    if (!result.config.enabled) {
      return {
        ok: true,
        command: "dictation",
        exitCode: 0,
        data: { state: "disabled", provider: "wispr-flow", display_name: "Wispr Flow" },
        warnings: [],
      };
    }
    if (!developmentCredentialAvailable(deps) && !(await credentialStore.has(result.config.keychain_account))) {
      return failure("dictation-credential-unavailable", "the Wispr Flow organization key is unavailable in Keychain");
    }
    return {
      ok: true,
      command: "dictation",
      exitCode: 0,
      data: {
        state: "ready",
        provider: "wispr-flow",
        display_name: "Wispr Flow",
        consent_version: result.config.consent_version,
        context_limit_bytes: result.config.context_limit_bytes,
      },
      warnings: [],
    };
  }

  if (action === "disable") {
    const result = readWisprFlowConfig(home);
    if (result.state === "missing") {
      return { ok: true, command: "dictation", exitCode: 0, data: { state: "unconfigured" }, warnings: [] };
    }
    if (result.state === "invalid") return failure("dictation-config-invalid", result.message);
    const disabled: WisprFlowConfig = {
      ...result.config,
      enabled: false,
      disabled_at: (deps.now ?? (() => new Date()))().toISOString(),
    };
    try {
      writeWisprFlowConfig(home, disabled);
    } catch {
      return failure(
        "dictation-disable-failed",
        "could not disable dictation; the previous configuration was preserved",
      );
    }
    let removed = true;
    try {
      removed = await credentialStore.remove(result.config.keychain_account);
    } catch {
      removed = false;
    }
    return {
      ok: true,
      command: "dictation",
      exitCode: 0,
      data: { state: "disabled", provider: "wispr-flow", display_name: "Wispr Flow" },
      warnings: removed
        ? []
        : [
            {
              code: "dictation-keychain-remove-failed",
              message: "dictation is disabled, but its Keychain item could not be removed",
            },
          ],
    };
  }

  if (options.provider !== "wispr-flow") {
    return failure("dictation-provider-unsupported", "configure requires --provider wispr-flow", EXIT_CODES.USAGE);
  }
  if ((deps.platform ?? process.platform) !== "darwin") {
    return failure("platform-unsupported", "Wispr Flow configuration requires macOS", EXIT_CODES.PLATFORM_UNSUPPORTED);
  }
  if (options.json || !(deps.isTTY ?? (() => Boolean(process.stdin.isTTY)))()) {
    return failure(
      "dictation-consent-required",
      "configure requires an interactive terminal so Glosa can show the disclosure and request consent",
      EXIT_CODES.USAGE,
    );
  }
  process.stderr.write(`${DISCLOSURE}\n`);
  if (!(await (deps.confirm ?? confirmOnTty)("Enable Wispr Flow dictation with this data policy?"))) {
    return failure("dictation-consent-declined", "Wispr Flow dictation was not configured", EXIT_CODES.USAGE);
  }

  const previous = readWisprFlowConfig(home);
  const account = previous.state === "configured" ? previous.config.keychain_account : (deps.uuid ?? randomUUID)();
  const clientId = previous.state === "configured" ? previous.config.client_id : (deps.uuid ?? randomUUID)();
  const useDevelopmentCredential = developmentCredentialAvailable(deps);
  let keychainItemAdded = false;
  try {
    if (!useDevelopmentCredential) {
      await credentialStore.addInteractive(account);
      keychainItemAdded = true;
    }
    writeWisprFlowConfig(home, configuredConfig((deps.now ?? (() => new Date()))(), account, clientId));
  } catch (error) {
    if (keychainItemAdded && previous.state !== "configured") {
      await credentialStore.remove(account).catch(() => false);
    }
    return failure(
      "dictation-configure-failed",
      error instanceof Error ? error.message : "could not configure Wispr Flow dictation",
    );
  }
  if (previous.state === "configured" && previous.config.keychain_account !== account) {
    await credentialStore.remove(previous.config.keychain_account).catch(() => false);
  }
  return {
    ok: true,
    command: "dictation",
    exitCode: 0,
    data: {
      state: "ready",
      provider: "wispr-flow",
      display_name: "Wispr Flow",
      consent_version: WISPR_FLOW_CONSENT_VERSION,
      context_limit_bytes: WISPR_FLOW_CONTEXT_LIMIT_BYTES,
    },
    warnings: [],
  };
}

export function printDictationResult(result: CommandEnvelope<DictationData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa dictation: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  const label = result.data.display_name ? ` (${result.data.display_name})` : "";
  process.stdout.write(`glosa dictation: ${result.data.state}${label}\n`);
  for (const warning of result.warnings) process.stderr.write(`glosa dictation: warning: ${warning.message}\n`);
}
