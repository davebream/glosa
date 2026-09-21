// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationProviderError } from "@glosa/daemon";
import {
  keychainAddCommand,
  keychainFindCommand,
  readWisprFlowConfig,
  WISPR_FLOW_CONFIG_VERSION,
  WISPR_FLOW_CONSENT_VERSION,
  WISPR_FLOW_CONTEXT_LIMIT_BYTES,
  WISPR_FLOW_TOKEN_URL,
  type WisprFlowConfig,
  type WisprFlowCredentialStore,
  WisprFlowProvider,
  wisprFlowConfigPath,
  writeWisprFlowConfig,
} from "../src/index.ts";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

function config(enabled = true): WisprFlowConfig {
  return {
    version: WISPR_FLOW_CONFIG_VERSION,
    provider: "wispr-flow",
    enabled,
    consent_version: WISPR_FLOW_CONSENT_VERSION,
    consented_at: "2026-09-21T10:00:00.000Z",
    context_policy: "visible-prose",
    context_limit_bytes: WISPR_FLOW_CONTEXT_LIMIT_BYTES,
    client_id: CLIENT,
    keychain_account: ACCOUNT,
    configured_at: "2026-09-21T10:00:00.000Z",
  };
}

function credentials(value = "org-secret"): WisprFlowCredentialStore {
  return {
    has: async () => Boolean(value),
    read: async () => value || null,
    addInteractive: async () => {},
    remove: async () => true,
  };
}

describe("Wispr Flow configuration", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test("writes a mode-0600, versioned consent record atomically", () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-wispr-config-"));
    homes.push(home);
    writeWisprFlowConfig(home, config());
    expect(statSync(wisprFlowConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(readWisprFlowConfig(home)).toEqual({ state: "configured", config: config() });
  });

  test("a failed rename preserves the previously committed configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-wispr-config-"));
    homes.push(home);
    writeWisprFlowConfig(home, config());
    const before = readFileSync(wisprFlowConfigPath(home), "utf8");
    expect(() =>
      writeWisprFlowConfig(
        home,
        { ...config(), enabled: false },
        {
          rename: () => {
            throw new Error("no");
          },
          unlink: () => {},
        },
      ),
    ).toThrow("no");
    expect(readFileSync(wisprFlowConfigPath(home), "utf8")).toBe(before);
  });

  test("Keychain argv contains identifiers but never credential material", () => {
    expect(keychainFindCommand(ACCOUNT)).not.toContain("-w");
    expect(keychainAddCommand(ACCOUNT).at(-1)).toBe("-w");
    expect(keychainAddCommand(ACCOUNT).join(" ")).not.toContain("org-secret");
  });
});

describe("WisprFlowProvider", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function home() {
    const value = mkdtempSync(join(tmpdir(), "glosa-wispr-provider-"));
    homes.push(value);
    writeWisprFlowConfig(value, config());
    return value;
  }

  test("status checks local configuration and credential presence without external calls", async () => {
    let calls = 0;
    const provider = new WisprFlowProvider({
      home: home(),
      credentialStore: credentials(),
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    expect(await provider.status()).toMatchObject({ state: "ready", provider: "wispr-flow" });
    expect(calls).toBe(0);
  });

  test("the development environment key requires both source-checkout and explicit opt-in", async () => {
    const target = home();
    const noOptIn = new WisprFlowProvider({
      home: target,
      credentialStore: credentials(""),
      allowDevelopmentEnv: true,
      env: { WISPR_FLOW_API_KEY: "dev-secret" },
    });
    expect(await noOptIn.status()).toMatchObject({ state: "error", code: "credential-unavailable" });

    const noSourceCheckout = new WisprFlowProvider({
      home: target,
      credentialStore: credentials(""),
      allowDevelopmentEnv: false,
      env: { GLOSA_WISPR_FLOW_ALLOW_ENV_KEY: "1", WISPR_FLOW_API_KEY: "dev-secret" },
    });
    expect(await noSourceCheckout.status()).toMatchObject({ state: "error", code: "credential-unavailable" });

    const enabled = new WisprFlowProvider({
      home: target,
      credentialStore: credentials(""),
      allowDevelopmentEnv: true,
      env: { GLOSA_WISPR_FLOW_ALLOW_ENV_KEY: "1", WISPR_FLOW_API_KEY: "dev-secret" },
    });
    expect(await enabled.status()).toMatchObject({ state: "ready" });
  });

  test("session request sends only client UUID and 600-second lifetime", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new WisprFlowProvider({
      home: home(),
      credentialStore: credentials(),
      now: () => Date.parse("2026-09-21T10:00:00.000Z"),
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ access_token: "client-jwt", expires_in: 600 });
      },
    });
    const grant = await provider.createSession();
    const request = requests[0]!;
    expect(request.url).toBe(WISPR_FLOW_TOKEN_URL);
    expect(JSON.parse(String(request.init?.body))).toEqual({ client_id: CLIENT, duration_secs: 600 });
    expect(request.init?.headers).toEqual({ Authorization: "Bearer org-secret", "Content-Type": "application/json" });
    expect(grant).toEqual({
      provider: "wispr-flow",
      websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
      access_token: "client-jwt",
      expires_at: "2026-09-21T10:10:00.000Z",
    });
    expect(JSON.stringify(request)).not.toContain(ACCOUNT);
  });

  test.each([
    [401, "authentication-failed"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
  ])("maps HTTP %i to sanitized %s", async (status, code) => {
    const provider = new WisprFlowProvider({
      home: home(),
      credentialStore: credentials(),
      fetch: async () => new Response("provider secret detail", { status }),
    });
    try {
      await provider.createSession();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DictationProviderError);
      expect(String((error as DictationProviderError).code)).toBe(code);
      expect((error as Error).message).not.toContain("provider secret detail");
    }
  });

  test("times out once and never retries", async () => {
    let calls = 0;
    const provider = new WisprFlowProvider({
      home: home(),
      credentialStore: credentials(),
      tokenTimeoutMs: 1,
      fetch: (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    await expect(provider.createSession()).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(1);
  });
});
