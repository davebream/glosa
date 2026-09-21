// SPDX-License-Identifier: Apache-2.0

const OUTPUT_RATE = 16_000;
const AUTH_TIMEOUT_MS = 10_000;
const FINAL_TIMEOUT_MS = 60_000;

export function resampleTo16Khz(input, sourceRate) {
  if (!(input instanceof Float32Array) || input.length === 0) return new Int16Array();
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new Error("invalid audio sample rate");
  const outputLength = Math.max(1, Math.round((input.length * OUTPUT_RATE) / sourceRate));
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = (index * sourceRate) / OUTPUT_RATE;
    const lower = Math.min(input.length - 1, Math.floor(sourcePosition));
    const upper = Math.min(input.length - 1, lower + 1);
    const fraction = sourcePosition - lower;
    const sample = Math.max(-1, Math.min(1, input[lower] * (1 - fraction) + input[upper] * fraction));
    output[index] = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
  }
  return output;
}

export function encodePcmWav(samples, sampleRate = OUTPUT_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index], true);
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function volumeOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32_768) ** 2;
  return Math.sqrt(sum / samples.length);
}

function tokenizedWebSocketUrl(endpoint, token) {
  const url = new URL(endpoint);
  url.searchParams.set("client_key", `Bearer ${token}`);
  return url.toString();
}

export function toWisprContext(context) {
  const textbox = context?.textboxContents ?? {};
  return {
    textbox_contents: {
      before_text: textbox.beforeText ?? "",
      selected_text: textbox.selectedText ?? "",
      after_text: textbox.afterText ?? "",
    },
    ...(context?.contentText ? { content_text: context.contentText } : {}),
    ...(context?.conversationMessages?.length ? { conversation: { messages: context.conversationMessages } } : {}),
  };
}

export async function createWisprFlowSession(options) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const AudioContextImpl = options.AudioContextImpl ?? AudioContext;
  const AudioWorkletNodeImpl = options.AudioWorkletNodeImpl ?? AudioWorkletNode;
  const audioContext = new AudioContextImpl();
  await audioContext.audioWorklet.addModule(new URL("./wispr-flow-worklet.js", import.meta.url));

  const socket = new WebSocketImpl(tokenizedWebSocketUrl(options.grant.websocket_url, options.grant.access_token));
  const sourceChunks = [];
  let sourceSampleCount = 0;
  let packetCount = 0;
  let authenticated = false;
  let committed = false;
  let commitReceived = false;
  let latestText = "";
  let settled = false;
  let node;
  let source;
  let authTimer;
  let finalTimer;

  let resolveAuthenticated;
  let rejectAuthenticated;
  const authenticatedPromise = new Promise((resolve, reject) => {
    resolveAuthenticated = resolve;
    rejectAuthenticated = reject;
  });
  let resolveFinal;
  let rejectFinal;
  const finalPromise = new Promise((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  let rejectSessionError;
  const sessionError = new Promise((_resolve, reject) => {
    rejectSessionError = reject;
  });
  // Cancellation may end a session without a caller ever awaiting `stop()`. Keep that expected
  // rejection handled while preserving the original promise for callers that do await it.
  finalPromise.catch(() => {});
  sessionError.catch(() => {});

  const stopTracks = () => {
    for (const track of options.stream.getTracks()) track.stop();
  };
  const reject = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(authTimer);
    clearTimeout(finalTimer);
    rejectAuthenticated(error);
    rejectFinal(error);
    rejectSessionError(error);
  };
  const finish = (text) => {
    if (settled) return;
    settled = true;
    clearTimeout(authTimer);
    clearTimeout(finalTimer);
    resolveFinal(text);
  };
  const sendPacket = (samples) => {
    const padded = new Int16Array(OUTPUT_RATE);
    padded.set(samples.subarray(0, OUTPUT_RATE));
    socket.send(
      JSON.stringify({
        type: "append",
        position: packetCount,
        audio_packets: {
          packets: [bytesToBase64(encodePcmWav(padded))],
          volumes: [volumeOf(padded)],
          packet_duration: 1,
          audio_encoding: "wav",
          byte_encoding: "base64",
        },
      }),
    );
    packetCount += 1;
  };
  const consumeSource = (count) => {
    const output = new Float32Array(count);
    let offset = 0;
    while (offset < count && sourceChunks.length > 0) {
      const first = sourceChunks[0];
      const needed = count - offset;
      if (first.length <= needed) {
        output.set(first, offset);
        offset += first.length;
        sourceChunks.shift();
      } else {
        output.set(first.subarray(0, needed), offset);
        sourceChunks[0] = first.slice(needed);
        offset += needed;
      }
    }
    sourceSampleCount -= count;
    return output;
  };
  const appendSource = (chunk) => {
    sourceChunks.push(chunk);
    sourceSampleCount += chunk.length;
    const oneSecond = Math.round(audioContext.sampleRate);
    while (sourceSampleCount >= oneSecond && !committed) {
      sendPacket(resampleTo16Khz(consumeSource(oneSecond), audioContext.sampleRate));
    }
  };

  socket.addEventListener("open", () => {
    if (settled) return;
    try {
      socket.send(
        JSON.stringify({
          type: "auth",
          access_token: options.grant.access_token,
          context: toWisprContext(options.context),
        }),
      );
    } catch {
      reject(new Error("Wispr Flow connection failed"));
    }
  });
  socket.addEventListener("message", (event) => {
    if (settled) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      reject(new Error("Wispr Flow returned a malformed response"));
      return;
    }
    if (frame.status === "auth") {
      authenticated = true;
      clearTimeout(authTimer);
      resolveAuthenticated();
      return;
    }
    if (frame.status === "error") {
      reject(new Error("Wispr Flow ended the dictation session"));
      return;
    }
    if (frame.status === "info" && frame.message?.event === "commit_received") {
      commitReceived = true;
      return;
    }
    if (frame.status === "text" && typeof frame.body?.text === "string") {
      latestText = frame.body.text;
      if (frame.final === true && committed) finish(latestText);
    }
  });
  socket.addEventListener("error", () => reject(new Error("Wispr Flow connection failed")));
  socket.addEventListener("close", (event) => {
    if (settled) return;
    if (committed && commitReceived && (event.wasClean || event.code === 1000 || event.code === 1005)) {
      finish(latestText);
      return;
    }
    reject(new Error("Wispr Flow disconnected before returning a final transcript"));
  });

  const cancelForAbort = () => {
    reject(new DOMException("Dictation was cancelled", "AbortError"));
    socket.close(1000, "cancelled");
  };
  options.signal?.addEventListener("abort", cancelForAbort, { once: true });
  authTimer = setTimeout(
    () => reject(new Error("Wispr Flow did not authenticate the dictation session")),
    options.authTimeoutMs ?? AUTH_TIMEOUT_MS,
  );
  if (options.signal?.aborted) cancelForAbort();

  try {
    await authenticatedPromise;
    if (!authenticated) throw new Error("Wispr Flow authentication failed");
    if (audioContext.state === "suspended") await audioContext.resume();
    source = audioContext.createMediaStreamSource(options.stream);
    node = new AudioWorkletNodeImpl(audioContext, "glosa-wispr-capture");
    node.port.onmessage = (event) => {
      try {
        appendSource(new Float32Array(event.data));
      } catch {
        reject(new Error("Wispr Flow connection failed"));
      }
    };
    source.connect(node);
    node.connect(audioContext.destination);
  } catch (error) {
    stopTracks();
    await audioContext.close().catch(() => {});
    throw error;
  }

  const stop = async () => {
    if (committed) return finalPromise;
    committed = true;
    source?.disconnect();
    node?.disconnect();
    stopTracks();
    try {
      if (sourceSampleCount > 0) sendPacket(resampleTo16Khz(consumeSource(sourceSampleCount), audioContext.sampleRate));
      socket.send(JSON.stringify({ type: "commit", total_packets: packetCount }));
      finalTimer = setTimeout(
        () => reject(new Error("Wispr Flow did not return a final transcript")),
        options.finalTimeoutMs ?? FINAL_TIMEOUT_MS,
      );
    } catch {
      reject(new Error("Wispr Flow connection failed"));
    }
    try {
      return await finalPromise;
    } finally {
      options.signal?.removeEventListener("abort", cancelForAbort);
      socket.close(1000, "complete");
      await audioContext.close().catch(() => {});
    }
  };

  const cancel = async () => {
    reject(new DOMException("Dictation was cancelled", "AbortError"));
    source?.disconnect();
    node?.disconnect();
    stopTracks();
    socket.close(1000, "cancelled");
    options.signal?.removeEventListener("abort", cancelForAbort);
    await audioContext.close().catch(() => {});
  };

  return { stop, cancel, error: sessionError };
}
