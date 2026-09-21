// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "../../daemon/src/security/capability.ts";
import { DictationProviderRegistry } from "../../daemon/src/dictation/interface.ts";
import { type ApiContext, createApiFetch } from "../../daemon/src/transport/http.ts";
import {
  type WisprFlowConfig,
  type WisprFlowCredentialStore,
  WisprFlowProvider,
  writeWisprFlowConfig,
} from "../../providers/wispr-flow/src/index.ts";
import { createWisprFlowSession } from "../../providers/wispr-flow/src/browser.js";
import { createDictationController } from "../src/dictation.js";
import { type DomEnv, installDom } from "./dom-env.ts";

const PORT = 4646;
const TOKEN = "dictation-e2e-token";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const NativeRequest = globalThis.Request;
const homes: string[] = [];
const doms: DomEnv[] = [];

afterEach(() => {
  for (const dom of doms.splice(0)) dom.teardown();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

class FakeAudioContext {
  sampleRate = 48_000;
  state = "suspended";
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  async resume() {
    this.state = "running";
  }
  async close() {}
}

class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
  constructor() {
    FakeWorkletNode.last = this;
  }
  connect() {}
  disconnect() {}
}

class FakeWisprSocket {
  static last: FakeWisprSocket | null = null;
  readonly frames: Array<Record<string, any>> = [];
  readonly url: string;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWisprSocket.last = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  send(raw: string) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    if (frame.type === "auth") queueMicrotask(() => this.message({ status: "auth" }));
    if (frame.type === "commit") {
      queueMicrotask(() => this.message({ status: "info", message: { event: "commit_received" } }));
      queueMicrotask(() => this.message({ status: "text", final: true, body: { text: "dictated end to end" } }));
    }
  }

  close() {}

  private message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(name: string, event: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

test("fake Wispr service covers permission through final draft insertion", async () => {
  const home = mkdtempSync(join(tmpdir(), "glosa-dictation-e2e-"));
  const dom: DomEnv = installDom();
  homes.push(home);
  doms.push(dom);

  const config: WisprFlowConfig = {
    version: 1,
    provider: "wispr-flow",
    enabled: true,
    consent_version: 1,
    consented_at: "2026-09-21T10:00:00.000Z",
    context_policy: "visible-prose",
    context_limit_bytes: 262_144,
    client_id: CLIENT,
    keychain_account: ACCOUNT,
    configured_at: "2026-09-21T10:00:00.000Z",
  };
  writeWisprFlowConfig(home, config);

  const credentialStore: WisprFlowCredentialStore = {
    has: async () => true,
    read: async () => "org-secret",
    addInteractive: async () => {},
    remove: async () => true,
  };
  const tokenRequests: Array<{ url: string; body: unknown }> = [];
  const provider = new WisprFlowProvider({
    home,
    credentialStore,
    now: () => Date.parse("2026-09-21T10:00:00.000Z"),
    fetch: async (url, init) => {
      tokenRequests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ access_token: "client-jwt", expires_in: 600 });
    },
  });
  const registry = new DictationProviderRegistry();
  registry.register(provider);
  const apiFetch = createApiFetch({
    port: PORT,
    classFPort: PORT + 1,
    token: TOKEN,
    instanceId: "dictation-e2e",
    startedAt: "2026-09-21T10:00:00.000Z",
    capabilityStore: new CapabilityStore(),
    dictationRegistry: registry,
  } as ApiContext);
  const requestJson = async (path: string, method = "GET") => {
    const response = await apiFetch(
      new NativeRequest(`http://127.0.0.1:${PORT}${path}`, {
        method,
        headers: {
          Host: `127.0.0.1:${PORT}`,
          Authorization: `Bearer ${TOKEN}`,
          ...(method === "POST" ? { Origin: `http://127.0.0.1:${PORT}` } : {}),
        },
      }),
    );
    if (!response.ok) throw new Error(`local route returned ${response.status}`);
    return response.json();
  };

  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const scope = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    WebSocket: FakeWisprSocket,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
  };
  expect(await requestJson("/api/dictation/status")).toEqual({
    state: "ready",
    provider: "wispr-flow",
    display_name: "Wispr Flow",
    client_module: "/app/providers/wispr-flow/browser.js",
  });
  expect(tokenRequests).toHaveLength(0);
  const controller = createDictationController({
    dataAccess: {
      getDictationStatus: () => requestJson("/api/dictation/status"),
      createDictationSession: () => requestJson("/api/dictation/session", "POST"),
    },
    scope: scope as any,
    document: dom.document as any,
    loadModule: async () => ({
      createWisprFlowSession: (options: any) =>
        createWisprFlowSession({
          ...options,
          WebSocketImpl: FakeWisprSocket,
          AudioContextImpl: FakeAudioContext,
          AudioWorkletNodeImpl: FakeWorkletNode,
        }),
    }),
  });

  const field = dom.document.createElement("textarea");
  field.value = "Start here";
  field.setSelectionRange(6, 10);
  dom.document.body.append(field);
  controller.attachField(field as any, { getContext: () => ({ surfaceBlocks: ["Visible artifact"] }) });
  await controller.readiness;
  const button = dom.document.querySelector(".glosa-dictation-toggle") as any;
  button.click();
  await flush();
  expect({
    label: button.textContent,
    status: dom.document.querySelector(".glosa-dictation-status")?.textContent,
  }).toEqual({ label: "Stop dictation", status: "Listening…" });
  FakeWorkletNode.last?.port.onmessage?.({ data: new Float32Array(24_000).fill(0.25) });
  button.click();
  await flush();

  expect(field.value).toBe("Start dictated end to end");
  expect(track.stopped).toBe(true);
  expect(tokenRequests).toEqual([
    {
      url: "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token",
      body: { client_id: CLIENT, duration_secs: 600 },
    },
  ]);
  expect(FakeWisprSocket.last?.url).toContain("client_key=Bearer+client-jwt");
  expect(FakeWisprSocket.last?.frames.map((frame) => frame.type)).toEqual(["auth", "append", "commit"]);
  controller.destroy();
});
