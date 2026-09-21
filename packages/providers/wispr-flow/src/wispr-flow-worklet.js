// SPDX-License-Identifier: Apache-2.0

class GlosaWisprCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor("glosa-wispr-capture", GlosaWisprCaptureProcessor);
