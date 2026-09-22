// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createArtifactPane } from "../src/artifact-pane.js";
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

  // Attaching to a field whose subtree is not in the page yet. Not an edge case: it is how every
  // caller works, because a render function builds its form and RETURNS it for someone else to
  // append. `attachField` ends by refreshing, refreshing began by pruning, and pruning read "not in
  // the document" as "abandoned" — so the binding was created and deleted inside the same call, and
  // dictation was unreachable everywhere it was offered while the provider reported `ready`.
  //
  // Every other test in this file appends the field FIRST, which is the one ordering the product
  // never uses. That is why a green suite meant nothing here.
  test("a field attached before its subtree reaches the page keeps its button", async () => {
    const { controller } = setup();
    const form = dom.document.createElement("form");
    const field = dom.document.createElement("textarea");
    form.append(field);

    controller.attachField(field as any);
    await controller.readiness;
    // Asserted on the detached form, before anything is appended: surviving its own attach is the
    // property, and checking after the append would let a re-created binding pass for a kept one.
    expect(form.querySelector(".glosa-dictation"), "the binding did not survive its own attach").toBeTruthy();

    dom.document.body.append(form);
    await flush();
    const host = form.querySelector(".glosa-dictation") as any;
    expect(host.hidden).toBe(false);
    expect(host.textContent).toContain("Start dictation");
    controller.destroy();
  });

  test("a field that WAS in the page and then leaves still takes its button with it", async () => {
    // The behaviour the prune exists for, stated so the fix can never be "stop pruning".
    const { controller } = setup();
    const field = dom.document.createElement("textarea");
    dom.document.body.append(field);
    controller.attachField(field as any);
    await controller.readiness;
    expect(dom.document.querySelectorAll(".glosa-dictation")).toHaveLength(1);

    field.remove();
    await flush();
    expect(dom.document.querySelectorAll(".glosa-dictation")).toHaveLength(0);
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

// The test that would have caught it. Everything above exercises the CONTROLLER; this exercises the
// surface a reader actually touches — open a note on a passage and look for the button. The defect
// was invisible to every controller test because they all append the field before attaching, and
// invisible to the surface allowlist test because counting `attachField(` call sites proves the
// calls exist, never that they produce anything.
describe("dictation reaches the annotation composer", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  const paint = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  };

  test("opening a note on a passage gives the writer a dictate button", async () => {
    const dataAccess = {
      async getArtifact() {
        return {
          source_path: "notes.md",
          content: "A paragraph to annotate.\n",
          rendered_html: '<p id="para" data-line="0">A paragraph to annotate.</p>',
          source_sha256: "sha-1",
          rendered_sha256: "r-1",
          class: "R",
        };
      },
      async getAnnotations() {
        return { annotations: [] };
      },
      async getCheckpoints() {
        return [];
      },
      async getDictationStatus() {
        return { state: "ready", provider: "wispr-flow", display_name: "Wispr Flow", client_module: CLIENT_MODULE };
      },
    };
    const scope = {
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
      AudioContext: class {},
      AudioWorkletNode: class {},
      WebSocket: class {},
      Event: dom.window.Event,
      MutationObserver: dom.window.MutationObserver,
    };
    const dictationController = createDictationController({
      dataAccess,
      scope: scope as any,
      document: dom.document as any,
    });
    // Resolved before the pane mounts, which is the real ordering: the status request is in flight
    // from first paint, long before a reader selects anything.
    await dictationController.readiness;

    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host as any, {
      dataAccess,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "review",
      dictationController,
    });
    await pane.ready;
    await paint();

    // The reader's own gesture: drag across words. That is what opens the composer, and the composer
    // is the only thing that ever creates a dictate button.
    const textNode = (host.querySelector("#para") as any).firstChild;
    const range = dom.document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 11);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    host.querySelector(".glosa-content")!.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    await paint();

    expect(host.querySelectorAll(".glosa-composer-input"), "the composer never opened").toHaveLength(1);
    const button = host.querySelector(".glosa-dictation-toggle") as any;
    expect(button, "the composer opened with no dictate button in it").toBeTruthy();
    // Present is not enough: the defect this guards left a hidden host behind on other paths.
    expect((button.closest(".glosa-dictation") as any).hidden).toBe(false);
    expect(button.textContent).toBe("Start dictation");

    pane.destroy();
    dictationController.destroy();
  });
});
