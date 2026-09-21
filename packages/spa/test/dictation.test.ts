// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildDictationContext,
  createDictationController,
  DICTATION_CONTEXT_LIMIT_BYTES,
  DICTATION_MAX_DURATION_MS,
} from "../src/dictation.js";
import { type DomEnv, installDom } from "./dom-env.ts";

const CLIENT_MODULE = "/app/providers/wispr-flow/browser.js";

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("dictation context policy", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("selected text wins, nearest field context follows, and total plaintext stays within 256 KiB", () => {
    const field = dom.document.createElement("textarea");
    field.value = `before-${"a".repeat(200_000)}SELECTED${"b".repeat(200_000)}-after`;
    const start = field.value.indexOf("SELECTED");
    field.setSelectionRange(start, start + "SELECTED".length);
    const context = buildDictationContext(field, {
      surfaceBlocks: ["artifact".repeat(100_000), "hidden/path/must/not/be-added-by-policy"],
      conversationMessages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "new" },
      ],
    });
    const textBytes = new TextEncoder().encode(
      context.textboxContents.selectedText +
        context.textboxContents.beforeText +
        context.textboxContents.afterText +
        context.contentText +
        context.conversationMessages.flatMap((message) => [message.role, message.content]).join(""),
    ).length;
    expect(context.textboxContents.selectedText).toBe("SELECTED");
    expect(context.textboxContents.beforeText.endsWith("a")).toBe(true);
    expect(context.textboxContents.afterText.startsWith("b")).toBe(true);
    expect(textBytes).toBeLessThanOrEqual(DICTATION_CONTEXT_LIMIT_BYTES);
  });

  test("conversation truncation retains newest messages but returns them chronologically", () => {
    const field = dom.document.createElement("textarea");
    const context = buildDictationContext(
      field,
      {
        conversationMessages: [
          { role: "user", content: "oldest" },
          { role: "assistant", content: "middle" },
          { role: "user", content: "newest" },
        ],
      },
      24,
    );
    expect(context.conversationMessages.at(-1)?.content).toBe("newest");
    expect(context.conversationMessages.map((message) => message.content)).not.toContain("oldest");
  });
});

describe("DictationController", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  function setup({ transcript = "dictated words", maximumDurationMs = DICTATION_MAX_DURATION_MS } = {}) {
    const track = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    let rejectProviderError: (error: Error) => void = () => {};
    const providerError = new Promise<never>((_resolve, reject) => {
      rejectProviderError = reject;
    });
    providerError.catch(() => {});
    const provider = {
      stops: 0,
      cancels: 0,
      context: null as unknown,
      fail: (error: Error) => rejectProviderError(error),
    };
    const dataAccess = {
      getDictationStatus: async () => ({
        state: "ready",
        provider: "wispr-flow",
        display_name: "Wispr Flow",
        client_module: CLIENT_MODULE,
      }),
      createDictationSession: async () => ({
        provider: "wispr-flow",
        websocket_url: "wss://platform-api.wisprflow.ai/ws",
        access_token: "jwt",
        expires_at: "2026-09-21T10:10:00.000Z",
      }),
    };
    const scope = {
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
      AudioContext: class {},
      AudioWorkletNode: class {},
      WebSocket: class {},
      Event: dom.window.Event,
      MutationObserver: dom.window.MutationObserver,
    };
    const controller = createDictationController({
      dataAccess,
      scope: scope as any,
      document: dom.document as any,
      maximumDurationMs,
      loadModule: async () => ({
        createWisprFlowSession: async ({ context }: { context: unknown }) => {
          provider.context = context;
          return {
            stop: async () => {
              provider.stops += 1;
              track.stop();
              return transcript;
            },
            cancel: async () => {
              provider.cancels += 1;
              track.stop();
            },
            error: providerError,
          };
        },
      }),
    });
    return { controller, provider, track };
  }

  test("keeps controls hidden when required browser recording APIs are unavailable", async () => {
    let statusCalls = 0;
    const controller = createDictationController({
      dataAccess: {
        getDictationStatus: async () => {
          statusCalls += 1;
          return { state: "ready", provider: "wispr-flow", client_module: CLIENT_MODULE };
        },
      },
      scope: { Event: dom.window.Event, MutationObserver: dom.window.MutationObserver } as any,
      document: dom.document as any,
    });
    const field = dom.document.createElement("textarea");
    dom.document.body.append(field);
    controller.attachField(field as any);
    await controller.readiness;
    expect((dom.document.querySelector(".glosa-dictation") as any).hidden).toBe(true);
    expect(statusCalls).toBe(0);
    controller.destroy();
  });

  test("replaces the exact selection only after final text and dispatches one bubbling input", async () => {
    const { controller } = setup({ transcript: "world" });
    const field = dom.document.createElement("textarea");
    const submit = dom.document.createElement("button");
    field.value = "hello there";
    field.setSelectionRange(6, 11);
    dom.document.body.append(field, submit);
    let inputs = 0;
    dom.document.body.addEventListener("input", () => (inputs += 1));
    controller.attachField(field as any, {
      controls: [submit] as any,
      getContext: () => ({ surfaceBlocks: ["visible"] }),
    });
    await controller.readiness;
    const button = dom.document.querySelector(".glosa-dictation-toggle") as any;
    expect(button.hidden).toBe(false);
    button.click();
    await flush();
    expect(button.textContent).toBe("Stop dictation");
    expect(field.readOnly).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(field.value).toBe("hello there");
    button.click();
    await flush();
    expect(field.value).toBe("hello world");
    expect(inputs).toBe(1);
    expect(field.readOnly).toBe(false);
    expect(submit.disabled).toBe(false);
    controller.destroy();
  });

  test("Escape cancels without changing the draft and releases the single-session lock", async () => {
    const { controller, provider } = setup();
    const first = dom.document.createElement("textarea");
    const second = dom.document.createElement("textarea");
    first.value = "keep me";
    dom.document.body.append(first, second);
    controller.attachField(first as any);
    controller.attachField(second as any);
    await controller.readiness;
    const buttons = [...dom.document.querySelectorAll(".glosa-dictation-toggle")] as any[];
    buttons[0]!.click();
    await flush();
    expect(buttons[1]!.disabled).toBe(true);
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(first.value).toBe("keep me");
    expect(provider.cancels).toBe(1);
    expect(buttons[1]!.disabled).toBe(false);
    controller.destroy();
  });

  test("permission denial restores the field and exposes a user-triggered retry", async () => {
    const scope = {
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new DOMException("denied", "NotAllowedError");
          },
        },
      },
      AudioContext: class {},
      AudioWorkletNode: class {},
      WebSocket: class {},
      Event: dom.window.Event,
      MutationObserver: dom.window.MutationObserver,
    };
    const controller = createDictationController({
      dataAccess: {
        getDictationStatus: async () => ({ state: "ready", provider: "wispr-flow", client_module: CLIENT_MODULE }),
      },
      scope: scope as any,
      document: dom.document as any,
    });
    const field = dom.document.createElement("textarea");
    field.value = "unchanged";
    dom.document.body.append(field);
    controller.attachField(field as any);
    await controller.readiness;
    const button = dom.document.querySelector(".glosa-dictation-toggle") as any;
    button.click();
    await flush();
    expect(field.value).toBe("unchanged");
    expect(field.readOnly).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Start dictation");
    expect(dom.document.querySelector(".glosa-dictation-status")?.textContent).toContain("permission");
    controller.destroy();
  });

  test("a provider disconnect restores the exact draft and unlocks the field", async () => {
    const { controller, provider } = setup();
    const field = dom.document.createElement("textarea");
    const submit = dom.document.createElement("button");
    field.value = "keep this draft";
    field.setSelectionRange(5, 9);
    dom.document.body.append(field, submit);
    controller.attachField(field as any, { controls: [submit] as any });
    await controller.readiness;
    const button = dom.document.querySelector(".glosa-dictation-toggle") as any;
    button.click();
    await flush();
    provider.fail(new Error("Wispr Flow disconnected before returning a final transcript"));
    await flush();
    expect(field.value).toBe("keep this draft");
    expect(field.selectionStart).toBe(5);
    expect(field.selectionEnd).toBe(9);
    expect(field.readOnly).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(button.textContent).toBe("Start dictation");
    controller.destroy();
  });

  test("the maximum duration finalizes automatically at five minutes forty-five seconds", async () => {
    expect(DICTATION_MAX_DURATION_MS).toBe(5 * 60_000 + 45_000);
    const { controller, provider } = setup({ maximumDurationMs: 1 });
    const field = dom.document.createElement("textarea");
    dom.document.body.append(field);
    controller.attachField(field as any);
    await controller.readiness;
    (dom.document.querySelector(".glosa-dictation-toggle") as any).click();
    await Bun.sleep(5);
    await flush();
    expect(provider.stops).toBe(1);
    expect(field.value).toBe("dictated words");
    controller.destroy();
  });

  test("a value mismatch restores the pre-recording draft instead of inserting", async () => {
    const { controller } = setup();
    const field = dom.document.createElement("textarea");
    field.value = "original";
    dom.document.body.append(field);
    controller.attachField(field as any);
    await controller.readiness;
    const button = dom.document.querySelector(".glosa-dictation-toggle") as any;
    button.click();
    await flush();
    field.value = "changed elsewhere";
    button.click();
    await flush();
    expect(field.value).toBe("original");
    expect(dom.document.querySelector(".glosa-dictation-status")?.textContent).toContain("changed");
    controller.destroy();
  });
});

describe("dictation surface allowlist", () => {
  test("only the four prose surfaces opt in; editors, search, and command UI do not", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source("../src/artifact-pane.js").match(/attachField\(/g)).toHaveLength(2);
    expect(source("../src/conversation.js").match(/attachField\(/g)).toHaveLength(1);
    expect(source("../src/attention-tray.js").match(/attachField\(/g)).toHaveLength(1);
    for (const excluded of ["../src/rich-editor.js", "../src/palette.js", "../src/outline.js"]) {
      expect(source(excluded)).not.toContain("attachField(");
    }
  });
});
