// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type DictationProvider,
  DictationProviderError,
  DictationProviderRegistry,
} from "../src/dictation/interface.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";

const PORT = 4646;
const TOKEN = "dictation-route-token";

function provider(overrides: Partial<DictationProvider> = {}): DictationProvider {
  return {
    id: "fake",
    displayName: "Fake Dictation",
    clientModule: "/app/providers/fake/browser.js",
    isEnabled: () => true,
    connectOrigins: () => ["wss://dictation.example"],
    status: async () => ({
      state: "ready",
      provider: "fake",
      display_name: "Fake Dictation",
      client_module: "/app/providers/fake/browser.js",
    }),
    createSession: async () => ({
      provider: "fake",
      websocket_url: "wss://dictation.example/ws",
      access_token: "jwt-secret",
      expires_at: "2026-09-21T10:10:00.000Z",
    }),
    browserAssets: () => [],
    ...overrides,
  };
}

function request(path: string, method = "GET") {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      Host: `127.0.0.1:${PORT}`,
      Authorization: `Bearer ${TOKEN}`,
      ...(method === "POST" ? { Origin: `http://127.0.0.1:${PORT}` } : {}),
    },
  });
}

function harness(registry?: DictationProviderRegistry) {
  return createApiFetch({
    port: PORT,
    classFPort: PORT + 1,
    token: TOKEN,
    instanceId: "gl-test",
    startedAt: "2026-09-21T10:00:00.000Z",
    capabilityStore: new CapabilityStore(),
    dictationRegistry: registry,
  } as ApiContext);
}

describe("dictation HTTP contract", () => {
  test("zero-provider core reports unconfigured and makes no external call", async () => {
    const response = await harness()(request("/api/dictation/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "unconfigured" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("ready status is authenticated, local-only, and exposes the fixed browser module", async () => {
    let sessionCalls = 0;
    const registry = new DictationProviderRegistry();
    registry.register(
      provider({
        createSession: async () => {
          sessionCalls += 1;
          throw new Error("not called");
        },
      }),
    );
    const response = await harness(registry)(request("/api/dictation/status"));
    expect(await response.json()).toMatchObject({ state: "ready", client_module: "/app/providers/fake/browser.js" });
    expect(sessionCalls).toBe(0);
  });

  test("foreground session grant is no-store and keeps provider errors typed", async () => {
    const registry = new DictationProviderRegistry();
    registry.register(provider());
    const response = await harness(registry)(request("/api/dictation/session", "POST"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ provider: "fake", access_token: "jwt-secret" });

    const failing = new DictationProviderRegistry();
    failing.register(
      provider({
        createSession: async () => {
          throw new DictationProviderError("rate-limited", "secret");
        },
      }),
    );
    const failure = await harness(failing)(request("/api/dictation/session", "POST"));
    expect(failure.status).toBe(429);
    expect(await failure.text()).not.toContain("secret");
  });

  test("conditional SPA CSP allows only the consented WSS origin", async () => {
    const registry = new DictationProviderRegistry();
    registry.register(provider());
    const enabled = await harness(registry)(request("/api/dictation/status"));
    expect(enabled.headers.get("Content-Security-Policy")).toContain("connect-src 'self' wss://dictation.example;");

    const disabledRegistry = new DictationProviderRegistry();
    disabledRegistry.register(provider({ isEnabled: () => false }));
    const disabled = await harness(disabledRegistry)(request("/api/dictation/status"));
    expect(disabled.headers.get("Content-Security-Policy")).toContain("connect-src 'self';");
    expect(disabled.headers.get("Content-Security-Policy")).not.toContain("dictation.example");
  });
});
