// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationProviderError } from "@glosa/daemon";
import { createCredentialStore } from "../src/credentials.ts";
import { MacKeychainCredentialStore } from "../src/keychain.ts";
import {
  CredentialStoreError,
  credentialHelperEnv,
  LinuxSecretServiceCredentialStore,
  runCredentialHelper,
  type CredentialHelperRequest,
  type CredentialHelperResult,
} from "../src/secret-service.ts";
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

describe("Linux Secret Service", () => {
  function fixture(results: CredentialHelperResult[]) {
    const calls: CredentialHelperRequest[] = [];
    const store = new LinuxSecretServiceCredentialStore({
      platform: "linux",
      executable: () => true,
      env: {
        HOME: "/fixture",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
        ANTHROPIC_API_KEY: "never-inherit",
        WISPR_FLOW_API_KEY: "never-inherit",
      },
      run: async (request) => {
        calls.push(request);
        return results.shift() ?? { code: 1, stdout: "", stderr: "unexpected call" };
      },
    });
    return { store, calls };
  }
  const present = {
    code: 0,
    stdout: JSON.stringify({ type: "aoao", data: [["/org/freedesktop/secrets/collection/test/item1"], []] }),
    stderr: "",
  };
  const absent = { code: 0, stdout: JSON.stringify({ type: "aoao", data: [[], []] }), stderr: "" };

  test("platform selection preserves macOS and selects secure Linux storage", () => {
    expect(createCredentialStore("darwin")).toBeInstanceOf(MacKeychainCredentialStore);
    expect(createCredentialStore("linux")).toBeInstanceOf(LinuxSecretServiceCredentialStore);
  });
  test("missing secure-store utilities fail before metadata access", async () => {
    let called = false;
    const store = new LinuxSecretServiceCredentialStore({
      platform: "linux",
      executable: (path) => !path.endsWith("secret-tool"),
      run: async () => {
        called = true;
        return present;
      },
    });
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "unavailable" });
    expect(called).toBe(false);
  });
  test("status reads metadata only and distinguishes missing from locked storage", async () => {
    const { store, calls } = fixture([
      present,
      absent,
      {
        ...present,
        stdout: JSON.stringify({ type: "aoao", data: [[], ["/org/freedesktop/secrets/collection/test/item1"]] }),
      },
    ]);
    expect(await store.has(ACCOUNT)).toBe(true);
    expect(await store.has(ACCOUNT)).toBe(false);
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "locked" });
    expect(
      calls.every(
        (call) => call.argv[0] === "/usr/bin/busctl" && call.argv.includes("SearchItems") && !call.interactive,
      ),
    ).toBe(true);
    expect(calls[0]!.env).toEqual({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      HOME: "/fixture",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
    });
  });
  test("foreground reads use a private non-unlocking search, never lookup", async () => {
    const { store, calls } = fixture([
      present,
      {
        code: 0,
        stdout: "[item1]\nlabel = Glosa Wispr Flow\nsecret = disposable-secret\ncreated = today\n",
        stderr: "",
      },
    ]);
    expect(await store.read(ACCOUNT)).toBe("disposable-secret");
    expect(calls[1]!.argv.slice(0, 2)).toEqual(["/usr/bin/secret-tool", "search"]);
    expect(calls[1]!.argv).not.toContain("--unlock");
    expect(JSON.stringify(calls)).not.toContain("disposable-secret");
    expect(calls[1]!.interactive).toBe(false);
  });
  test("a wallet locking between metadata and read fails without unlocking", async () => {
    const { store, calls } = fixture([
      present,
      { code: 0, stdout: "[item1]\nlabel = Glosa Wispr Flow\n", stderr: "IsLocked" },
    ]);
    await expect(store.read(ACCOUNT)).rejects.toMatchObject({ code: "locked" });
    expect(calls).toHaveLength(2);
  });
  test.each([
    ["AccessDenied secret-value", "denied"],
    ["Prompt dismissed secret-value", "cancelled"],
    ["ServiceUnknown secret-value", "unavailable"],
  ])("sanitizes helper failure %s as %s", async (stderr, code) => {
    const { store } = fixture([{ code: 1, stdout: "secret-value", stderr }]);
    try {
      await store.has(ACCOUNT);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("secret-value");
    }
  });
  test("interactive configuration inherits input while noninteractive removal never invokes a prompt", async () => {
    const { store, calls } = fixture([
      { code: 0, stdout: "", stderr: "" },
      present,
      { code: 0, stdout: JSON.stringify({ type: "o", data: ["/org/freedesktop/secrets/prompt/p1"] }), stderr: "" },
    ]);
    await store.addInteractive(ACCOUNT);
    expect(calls[0]!.interactive).toBe(true);
    expect(calls[0]!.argv).toContain("store");
    expect(await store.remove(ACCOUNT)).toBe(false);
    expect(calls.slice(1).every((call) => !call.interactive && !call.argv.includes("Prompt"))).toBe(true);
  });
  test("rejects malformed metadata and nonlocal bus addresses", async () => {
    const { store } = fixture([{ code: 0, stdout: "secret-value", stderr: "" }]);
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "invalid" });
    expect(() => credentialHelperEnv({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=example.com" })).toThrow(
      CredentialStoreError,
    );
  });
  test("real helper execution bounds output, times out and handles already cancelled calls", async () => {
    const base = { env: credentialHelperEnv(process.env), interactive: false, timeoutMs: 1000 };
    await expect(
      runCredentialHelper({
        ...base,
        argv: [process.execPath, "-e", 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runCredentialHelper({ ...base, timeoutMs: 20, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      runCredentialHelper({ ...base, argv: ["/must/not/run"], signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

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

  test("locked storage is actionable and cancellation during credential read prevents token exchange", async () => {
    const abort = new AbortController();
    let fetches = 0;
    const store = credentials();
    store.has = async () => {
      throw new CredentialStoreError("locked");
    };
    store.read = async (_account, signal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      return "secret";
    };
    const provider = new WisprFlowProvider({
      home: home(),
      credentialStore: store,
      fetch: async () => {
        fetches++;
        return Response.json({});
      },
    });
    expect(await provider.status()).toMatchObject({ state: "error", message: expect.stringContaining("Unlock") });
    await expect(provider.createSession(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetches).toBe(0);
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
