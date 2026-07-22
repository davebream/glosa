// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mountAttentionTray } from "../src/attention-tray.js";
import { installDom, type DomEnv } from "./dom-env.ts";

async function flush(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe("attention tray", () => {
  let dom: DomEnv;
  beforeEach(() => { dom = installDom(); });
  afterEach(() => dom.teardown());

  test("shows a workspace badge, marks requests seen on open, and renders action-aware controls", async () => {
    const calls: unknown[] = [];
    let status = "open";
    const dataAccess = {
      getInbox: async (slug: string) => ({ pending_count: 1, attention: [{ id: "a1", status, message: "Review this", action: "review", target: "draft.md" }] }),
      markAttentionSeen: async (slug: string, id: string) => {
        calls.push(["seen", slug, id]);
        status = "seen";
        return { id, status };
      },
      respondToAttention: async () => ({ status: "done" }),
    };
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, { dataAccess });
    tray.setWorkspace("ws-one");
    await flush();
    expect(host.querySelector(".glosa-attention-badge")?.textContent).toBe("1");

    (host.querySelector(".glosa-attention-trigger") as any).click();
    await flush();
    expect(calls).toEqual([["seen", "ws-one", "a1"]]);
    expect(Array.from(host.querySelectorAll(".glosa-attention-actions button")).map((button) => button.textContent)).toEqual(["Approve", "Request changes"]);
    expect(host.textContent).toContain("Seen");
  });

  test("generic requests show Done; Escape closes and restores focus", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({ pending_count: 1, attention: [{ id: "a1", status: "seen", message: "Continue", action: null, target: null }] }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => ({}),
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    const trigger = host.querySelector(".glosa-attention-trigger") as any;
    trigger.click();
    await flush();
    expect(Array.from(host.querySelectorAll(".glosa-attention-actions button")).map((button) => button.textContent)).toEqual(["Done"]);
    host.querySelector(".glosa-attention-tray")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect((host.querySelector(".glosa-attention-tray") as any).hidden).toBe(true);
    expect(dom.document.activeElement).toBe(trigger);
  });

  test("successful response keeps keyboard focus inside the refreshed tray", async () => {
    let pending = true;
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({
          pending_count: pending ? 1 : 0,
          attention: pending ? [{ id: "a1", status: "seen", message: "Review", action: "review", target: null }] : [],
        }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => {
          pending = false;
          return { status: "done" };
        },
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    const trigger = host.querySelector(".glosa-attention-trigger") as any;
    trigger.click();
    await flush();
    (host.querySelector(".glosa-primary-button") as any).click();
    await flush();

    expect(host.textContent).toContain("No requests need your attention.");
    const close = host.querySelector(".glosa-attention-close") as any;
    expect(dom.document.activeElement).toBe(close);
    host.querySelector(".glosa-attention-tray")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.document.activeElement).toBe(trigger);
  });

  test("failed response preserves input and returns focus for correction", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({ pending_count: 1, attention: [{ id: "a1", status: "seen", message: "Review", action: "review", target: null }] }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => { throw new Error("disk full"); },
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    (host.querySelector(".glosa-attention-trigger") as any).click();
    await flush();
    const input = host.querySelector(".glosa-attention-response") as any;
    input.value = "Keep this reply";
    (host.querySelector(".glosa-primary-button") as any).click();
    await flush();
    expect(input.value).toBe("Keep this reply");
    expect(host.textContent).toContain("disk full");
    expect(dom.document.activeElement).toBe(input);
  });
});
