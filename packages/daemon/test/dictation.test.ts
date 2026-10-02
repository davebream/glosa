// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DictationProvider,
  DictationProviderError,
  DictationProviderRegistry,
} from "../src/dictation/interface.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { ensureToken, rotateToken, TokenAuthority } from "../src/security/token.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";

const PORT = 4646;
const TOKEN = "dictation-route-token";

const settings = {
  enabled: true,
  context: true,
  cleanup: false,
  credential_present: true,
  revision: "r1",
  consent_version: 1,
};
function provider(overrides: Partial<DictationProvider> = {}): DictationProvider {
  return {
    id: "fake",
    status: async () => ({ ...settings, state: "ready" }),
    settings: async () => settings,
    update: async () => settings,
    remove: async () => ({ ...settings, enabled: false, credential_present: false }),
    transcribe: async () => ({ text: "Hello", cleanup: "off" }),
    dispose() {},
    ...overrides,
  };
}
function request(path: string, method = "GET", body?: BodyInit) {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    method,
    body,
    headers: {
      Host: `127.0.0.1:${PORT}`,
      Authorization: `Bearer ${TOKEN}`,
      ...(method !== "GET" ? { Origin: `http://127.0.0.1:${PORT}` } : {}),
    },
  });
}
function audioForm() {
  const form = new FormData();
  form.set("revision", "r1");
  form.set("audio", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])], { type: "audio/webm" }), "audio.webm");
  return form;
}
function harness(registry?: DictationProviderRegistry, token: ApiContext["token"] = TOKEN) {
  return createApiFetch({
    port: PORT,
    classFPort: PORT + 1,
    token,
    instanceId: "gl-test",
    startedAt: "2026-09-21T10:00:00.000Z",
    capabilityStore: new CapabilityStore(),
    dictationRegistry: registry,
  } as ApiContext);
}

describe("dictation HTTP contract", () => {
  test("zero-provider core has safe defaults and no browser egress", async () => {
    const response = await harness()(request("/api/dictation/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "unconfigured", enabled: false, cleanup: false });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self';");
  });
  test("authenticated local status exposes no token, module or external origin", async () => {
    const registry = new DictationProviderRegistry();
    registry.register(provider());
    const handle = harness(registry);
    const response = await handle(request("/api/dictation/status"));
    expect(await response.json()).toEqual({ ...settings, state: "ready" });
    const unauth = request("/api/dictation/status");
    unauth.headers.delete("Authorization");
    expect((await handle(unauth)).status).toBe(401);
    expect((await handle(request("/api/dictation/session", "POST"))).status).toBe(404);
  });
  test("multipart transcription is authenticated, no-store and normalizes the audio container", async () => {
    let received: any;
    const registry = new DictationProviderRegistry();
    registry.register(
      provider({
        transcribe: async (input) => {
          received = input;
          return { text: "Cześć", cleanup: "off" };
        },
      }),
    );
    const response = await harness(registry)(request("/api/dictation/transcribe", "POST", audioForm()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Cześć", cleanup: "off" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(received.mediaType).toBe("audio/webm");
    const badOrigin = request("/api/dictation/transcribe", "POST", audioForm());
    badOrigin.headers.set("Origin", "https://evil.example");
    expect((await harness(registry)(badOrigin)).status).toBe(403);
  });
  test.each(["duplicate", "context", "format", "unknown"])(
    "malformed %s upload is rejected before provider execution",
    async (kind) => {
      let calls = 0;
      const registry = new DictationProviderRegistry();
      registry.register(
        provider({
          transcribe: async () => {
            calls++;
            return { text: "unexpected", cleanup: "off" };
          },
        }),
      );
      const form = audioForm();
      if (kind === "duplicate") form.append("revision", "r2");
      if (kind === "context") form.set("context", "ą".repeat(4097));
      if (kind === "format") form.set("audio", new Blob(["not audio"]), "audio.webm");
      if (kind === "unknown") form.set("api_key", "must-not-accept");
      expect((await harness(registry)(request("/api/dictation/transcribe", "POST", form))).status).toBe(400);
      expect(calls).toBe(0);
    },
  );
  test("settings mutations reject cross-origin and unexpected fields; key is not echoed", async () => {
    let calls = 0;
    const registry = new DictationProviderRegistry();
    registry.register(
      provider({
        update: async () => {
          calls++;
          return settings;
        },
      }),
    );
    const handle = harness(registry);
    const body = JSON.stringify({ ...settings, api_key: "private-key" });
    expect((await handle(request("/api/dictation/settings", "PUT", body))).status).toBe(400);
    const response = await handle(
      request(
        "/api/dictation/settings",
        "PUT",
        JSON.stringify({
          revision: "r1",
          enabled: true,
          context: true,
          cleanup: false,
          consent_version: 1,
          api_key: "private-key",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("private-key");
    expect(calls).toBe(1);
  });
  test("provider errors never expose key or prose", async () => {
    for (const error of [new DictationProviderError("rate-limited", "private-key"), new Error("private-key")]) {
      const registry = new DictationProviderRegistry();
      registry.register(
        provider({
          transcribe: async () => {
            throw error;
          },
        }),
      );
      const response = await harness(registry)(request("/api/dictation/transcribe", "POST", audioForm()));
      expect(response.status).toBe(error instanceof DictationProviderError ? 429 : 502);
      expect(await response.text()).not.toContain("private-key");
    }
  });
  test("request cancellation aborts provider work", async () => {
    const registry = new DictationProviderRegistry();
    const started = Promise.withResolvers<AbortSignal>();
    registry.register(
      provider({
        transcribe: async ({ signal }) => {
          started.resolve(signal);
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          throw new DictationProviderError("cancelled");
        },
      }),
    );
    const abort = new AbortController();
    const pending = harness(registry)(
      new Request(request("/api/dictation/transcribe", "POST", audioForm()), { signal: abort.signal }),
    );
    const signal = await started.promise;
    abort.abort();
    await pending;
    expect(signal.aborted).toBe(true);
  });
});

test("daemon shutdown aborts a pending dictation settings mutation", async () => {
  const registry = new DictationProviderRegistry(),
    shutdown = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  registry.register(
    provider({
      update: async (_settings, signal) => {
        started.resolve(signal!);
        await new Promise((resolve) => signal!.addEventListener("abort", resolve, { once: true }));
        throw new DictationProviderError("cancelled");
      },
    }),
  );
  const handle = createApiFetch({
    port: PORT,
    classFPort: PORT + 1,
    token: TOKEN,
    instanceId: "dictation-shutdown",
    startedAt: "now",
    capabilityStore: new CapabilityStore(),
    dictationRegistry: registry,
    shutdownSignal: shutdown.signal,
  } as ApiContext);
  const pending = handle(
    request(
      "/api/dictation/settings",
      "PUT",
      JSON.stringify({ revision: "r1", enabled: true, context: true, cleanup: false, consent_version: 1 }),
    ),
  );
  const signal = await started.promise;
  shutdown.abort();
  expect((await pending).status).toBe(409);
  expect(signal.aborted).toBe(true);
});
test("transcription has its own bounded upload allowance, checked before provider work", async () => {
  let calls = 0;
  const registry = new DictationProviderRegistry();
  registry.register(
    provider({
      transcribe: async (input) => {
        calls++;
        return { text: String(input.audio.length), cleanup: "off" };
      },
    }),
  );
  const handle = harness(registry),
    form = audioForm();
  const audio = new Uint8Array(2 * 1024 * 1024);
  audio.set([0x1a, 0x45, 0xdf, 0xa3]);
  form.set("audio", new Blob([audio], { type: "audio/webm" }), "audio.webm");
  const accepted = await handle(request("/api/dictation/transcribe", "POST", form));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ text: String(audio.length) });
  const oversized = request("/api/dictation/transcribe", "POST", "bounded");
  oversized.headers.set("Content-Length", String(12 * 1024 * 1024 + 65537));
  expect((await handle(oversized)).status).toBe(413);
  expect(calls).toBe(1);
});

test("token rotation aborts a pending transcription and rejects its stale response", async () => {
  const home = mkdtempSync(join(tmpdir(), "glosa-dictation-auth-"));
  const token = ensureToken(home),
    authority = new TokenAuthority(home);
  const registry = new DictationProviderRegistry();
  const started = Promise.withResolvers<AbortSignal>();
  registry.register(
    provider({
      transcribe: async ({ signal }) => {
        started.resolve(signal);
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { text: "must not insert", cleanup: "off" };
      },
    }),
  );
  try {
    const handle = harness(registry, authority);
    const upload = request("/api/dictation/transcribe", "POST", audioForm());
    upload.headers.set("Authorization", `Bearer ${token}`);
    const pending = handle(upload);
    const signal = await started.promise;
    const replacement = rotateToken(home);
    expect(authority.current()).toBe(replacement);
    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(401);
  } finally {
    authority.close();
    rmSync(home, { recursive: true, force: true });
  }
});
