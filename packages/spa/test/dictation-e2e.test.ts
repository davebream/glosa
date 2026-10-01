// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore } from "../../daemon/src/security/capability.ts";
import { DictationProviderRegistry } from "../../daemon/src/dictation/interface.ts";
import { type ApiContext, createApiFetch } from "../../daemon/src/transport/http.ts";
import {
  type OpenAIDictationConfig,
  type OpenAIDictationCredentialStore,
  OpenAITranscriptionProvider,
  writeOpenAIDictationConfig,
} from "../../providers/openai-transcription/src/index.ts";
import { createDictationController } from "../src/dictation.js";
import { type DomEnv, installDom } from "./dom-env.ts";

const NativeEvent = globalThis.Event;
const PORT = 4646;
const TOKEN = "dictation-e2e-token";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const NativeRequest = globalThis.Request;
const nativeNetwork = { Request, Response, FormData, Blob, File, Headers, AbortController, AbortSignal };
const homes: string[] = [];
const doms: DomEnv[] = [];

afterEach(() => {
  for (const dom of doms.splice(0)) dom.teardown();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

class FakeRecorder extends EventTarget {
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state = "inactive";
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      const event = new NativeEvent("dataavailable");
      Object.assign(event, { data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])], { type: this.mimeType }) });
      this.dispatchEvent(event);
      this.dispatchEvent(new NativeEvent("stop"));
    });
  }
}
test("offline OpenAI transport covers permission through final draft insertion", async () => {
  const home = mkdtempSync(join(tmpdir(), "glosa-dictation-e2e-"));
  const dom: DomEnv = installDom();
  Object.assign(globalThis, nativeNetwork, { window: undefined });
  // Provider executes in Bun, not the Happy DOM window. Controller receives its DOM explicitly.
  homes.push(home);
  doms.push(dom);

  const config: OpenAIDictationConfig = {
    version: 1,
    enabled: true,
    context: true,
    cleanup: false,
    consent_version: 1,
    revision: CLIENT,
    keychain_account: ACCOUNT,
  };
  writeOpenAIDictationConfig(home, config);

  const credentialStore: OpenAIDictationCredentialStore = {
    has: async () => true,
    read: async () => "org-secret",
    write: async () => {},
    remove: async () => true,
  };
  const tokenRequests: Array<{ url: string; body: unknown }> = [];
  const provider = new OpenAITranscriptionProvider({
    home,
    credentialStore,
    fetch: (async (url, init) => {
      tokenRequests.push({ url: String(url), body: await new NativeRequest(String(url), init).formData() });
      return Response.json({ text: "dictated end to end" });
    }) as typeof fetch,
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
  const requestJson = async (path: string, method = "GET", body?: BodyInit) => {
    const response = await apiFetch(
      new NativeRequest(`http://127.0.0.1:${PORT}${path}`, {
        method,
        body,
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
    addEventListener() {},
    stop() {
      this.stopped = true;
    },
  };
  const scope = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    MediaRecorder: FakeRecorder,
    Blob,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
  };
  expect(await requestJson("/api/dictation/status")).toMatchObject({ state: "ready", revision: CLIENT });
  expect(tokenRequests).toHaveLength(0);
  const controller = createDictationController({
    dataAccess: {
      getDictationStatus: () => requestJson("/api/dictation/status"),
      transcribeDictation: (audio: Blob, context: string, revision: string) => {
        const form = new FormData();
        form.set("audio", audio, "audio.webm");
        form.set("context", context);
        form.set("revision", revision);
        return requestJson("/api/dictation/transcribe", "POST", form);
      },
    },
    scope: scope as any,
    document: dom.document as any,
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
  expect(button.getAttribute("aria-label")).toBe("Stop dictation");
  button.click();
  for (let attempt = 0; attempt < 100 && field.readOnly; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));

  expect(field.value, dom.document.querySelector(".glosa-dictation-status")?.textContent ?? "").toBe(
    "Start dictated end to end",
  );
  expect(track.stopped).toBe(true);
  expect(tokenRequests).toHaveLength(1);
  expect(tokenRequests[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect((tokenRequests[0]!.body as FormData).get("prompt")).toContain("Visible artifact");
  controller.destroy();
});
