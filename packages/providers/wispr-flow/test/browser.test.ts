// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createWisprFlowSession, encodePcmWav, resampleTo16Khz, toWisprContext } from "../src/browser.js";

test("PCM conversion clamps samples and emits a mono 16-bit 16 kHz WAV", () => {
  const pcm = resampleTo16Khz(new Float32Array([-2, -1, 0, 1, 2]), 16_000);
  expect([...pcm]).toEqual([-32768, -32768, 0, 32767, 32767]);
  const wav = encodePcmWav(pcm);
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint16(34, true)).toBe(16);
});

test("Wispr context excludes identities and maps only plaintext fields", () => {
  expect(
    toWisprContext({
      textboxContents: { beforeText: "before", selectedText: "selected", afterText: "after" },
      contentText: "visible",
      conversationMessages: [{ role: "assistant", content: "hello" }],
    }),
  ).toEqual({
    textbox_contents: { before_text: "before", selected_text: "selected", after_text: "after" },
    content_text: "visible",
    conversation: { messages: [{ role: "assistant", content: "hello" }] },
  });
});

class FakeAudioContext {
  sampleRate = 48_000;
  state = "suspended";
  audioWorklet = { addModule: async () => {} };
  destination = {};
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  async close() {}
  async resume() {
    this.state = "running";
  }
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

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static finalMode: "explicit" | "clean-close" = "explicit";
  readonly sent: Array<Record<string, any>> = [];
  readonly url: string;
  private listeners = new Map<string, Array<(event: any) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(name: string, listener: (event: any) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "auth") queueMicrotask(() => this.message({ status: "auth" }));
    if (frame.type === "commit") {
      queueMicrotask(() => this.message({ status: "info", message: { event: "commit_received" } }));
      queueMicrotask(() =>
        this.message({ status: "text", final: FakeWebSocket.finalMode === "explicit", body: { text: "final words" } }),
      );
      if (FakeWebSocket.finalMode === "clean-close") {
        queueMicrotask(() => this.emit("close", { code: 1000, wasClean: true }));
      }
    }
  }
  close() {}
  abnormalClose() {
    this.emit("close", { code: 1006, wasClean: false });
  }
  protected message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
  protected emit(name: string, event: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class SilentWebSocket extends FakeWebSocket {
  override send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
  }
}

class MalformedWebSocket extends FakeWebSocket {
  override send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "auth") queueMicrotask(() => this.emit("message", { data: "{" }));
  }
}

class NoFinalWebSocket extends FakeWebSocket {
  override send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (frame.type === "auth") queueMicrotask(() => this.message({ status: "auth" }));
    if (frame.type === "commit") {
      queueMicrotask(() => this.message({ status: "info", message: { event: "commit_received" } }));
      queueMicrotask(() => this.message({ status: "text", final: false, body: { text: "interim only" } }));
    }
  }
}

function stream() {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  return { value: { getTracks: () => [track] }, track };
}

describe("Wispr browser stream", () => {
  test("an already-aborted session never starts and releases the microphone", async () => {
    const media = stream();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWisprFlowSession({
        grant: {
          websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
          access_token: "jwt-secret",
        },
        stream: media.value,
        context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
        signal: controller.signal,
        WebSocketImpl: FakeWebSocket,
        AudioContextImpl: FakeAudioContext,
        AudioWorkletNodeImpl: FakeWorkletNode,
      }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(media.track.stopped).toBe(true);
  });

  test("bounds a WebSocket that never authenticates and releases the microphone", async () => {
    const media = stream();
    await expect(
      createWisprFlowSession({
        grant: {
          websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
          access_token: "jwt-secret",
        },
        stream: media.value,
        context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
        WebSocketImpl: SilentWebSocket,
        AudioContextImpl: FakeAudioContext,
        AudioWorkletNodeImpl: FakeWorkletNode,
        authTimeoutMs: 1,
      }),
    ).rejects.toThrow("did not authenticate");
    expect(media.track.stopped).toBe(true);
  });

  test("rejects malformed provider frames before recording starts", async () => {
    const media = stream();
    await expect(
      createWisprFlowSession({
        grant: {
          websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
          access_token: "jwt-secret",
        },
        stream: media.value,
        context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
        WebSocketImpl: MalformedWebSocket,
        AudioContextImpl: FakeAudioContext,
        AudioWorkletNodeImpl: FakeWorkletNode,
      }),
    ).rejects.toThrow("malformed response");
    expect(media.track.stopped).toBe(true);
  });

  test("reports an abnormal disconnect during recording", async () => {
    const media = stream();
    const session = await createWisprFlowSession({
      grant: {
        websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
        access_token: "jwt-secret",
      },
      stream: media.value,
      context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
      WebSocketImpl: FakeWebSocket,
      AudioContextImpl: FakeAudioContext,
      AudioWorkletNodeImpl: FakeWorkletNode,
    });
    FakeWebSocket.last?.abnormalClose();
    await expect(session.error).rejects.toThrow("disconnected before returning a final transcript");
    await session.cancel();
    expect(media.track.stopped).toBe(true);
  });

  test("times out when commit receives no final transcript", async () => {
    const media = stream();
    const session = await createWisprFlowSession({
      grant: {
        websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
        access_token: "jwt-secret",
      },
      stream: media.value,
      context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
      WebSocketImpl: NoFinalWebSocket,
      AudioContextImpl: FakeAudioContext,
      AudioWorkletNodeImpl: FakeWorkletNode,
      finalTimeoutMs: 1,
    });
    await expect(session.stop()).rejects.toThrow("did not return a final transcript");
    expect(media.track.stopped).toBe(true);
  });

  test.each(["explicit", "clean-close"] as const)(
    "sends exact one-second packets and accepts %s final",
    async (mode) => {
      FakeWebSocket.finalMode = mode;
      const media = stream();
      const session = await createWisprFlowSession({
        grant: {
          websocket_url: "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
          access_token: "jwt-secret",
        },
        stream: media.value,
        context: { textboxContents: { beforeText: "", selectedText: "", afterText: "" } },
        WebSocketImpl: FakeWebSocket,
        AudioContextImpl: FakeAudioContext,
        AudioWorkletNodeImpl: FakeWorkletNode,
      });
      FakeWorkletNode.last?.port.onmessage?.({ data: new Float32Array(72_000).fill(0.25) });
      const text = await session.stop();
      expect(text).toBe("final words");
      expect(media.track.stopped).toBe(true);

      const socket = FakeWebSocket.last!;
      expect(socket.url).toContain("client_key=Bearer+jwt-secret");
      const appends = socket.sent.filter((frame) => frame.type === "append");
      expect(appends.map((frame) => frame.position)).toEqual([0, 1]);
      expect(socket.sent.at(-1)).toEqual({ type: "commit", total_packets: 2 });
      for (const append of appends) {
        const wav = Uint8Array.from(atob(append.audio_packets.packets[0]), (character) => character.charCodeAt(0));
        expect(wav.byteLength).toBe(44 + 16_000 * 2);
        expect(append.audio_packets.packet_duration).toBe(1);
      }
      const finalWav = Uint8Array.from(atob(appends[1]!.audio_packets.packets[0]), (character) =>
        character.charCodeAt(0),
      );
      const finalView = new DataView(finalWav.buffer);
      expect(finalView.getInt16(44 + 15_999 * 2, true)).toBe(0);
    },
  );
});
