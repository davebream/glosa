// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mountAttentionTray } from "../src/attention-tray.js";
import { installDom, type DomEnv } from "./dom-env.ts";

async function flush(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe("attention tray", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("shows a workspace badge, marks requests seen on open, and renders action-aware controls", async () => {
    const calls: unknown[] = [];
    let status = "open";
    const dataAccess = {
      getInbox: async (slug: string) => ({
        pending_count: 1,
        attention: [{ id: "a1", status, message: "Review this", action: "review", target: "draft.md" }],
      }),
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
    // A request about an artifact is answered in that artifact's margin, next to the words it
    // concerns. The tray finds it; it does not offer a second, contextless place to answer.
    expect(
      Array.from(host.querySelectorAll(".glosa-attention-actions button")).map((button) => button.textContent),
    ).toEqual(["Go to the passage"]);
    expect(host.querySelector(".glosa-attention-response")).toBeNull();
    expect(host.textContent).toContain("Seen");
  });

  test("a request with no artifact keeps its inline answer — it has no margin to be sent to", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const responded: Array<Record<string, unknown>> = [];
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({
          pending_count: 1,
          attention: [{ id: "a1", status: "open", message: "Is the release note accurate?", action: "review" }],
        }),
        markAttentionSeen: async (_slug: string, id: string) => ({ id, status: "seen" }),
        respondToAttention: async (_slug: string, id: string, body: Record<string, unknown>) => {
          responded.push({ id, ...body });
          return { status: "done" };
        },
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    (host.querySelector(".glosa-attention-trigger") as any).click();
    await flush();

    // The residue case: nowhere to send the reader, so the tray stays answerable rather than
    // leaving a workspace-level question with no way to answer it at all.
    const input = host.querySelector(".glosa-attention-response") as any;
    expect(input).not.toBeNull();
    input.value = "Yes, it matches the changelog.";
    (host.querySelector(".glosa-attention-actions button") as any).click();
    await flush();
    expect(responded).toEqual([{ id: "a1", outcome: "approved", response: "Yes, it matches the changelog." }]);
  });

  test("generic requests show Done; Escape closes and restores focus", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({
          pending_count: 1,
          attention: [{ id: "a1", status: "seen", message: "Continue", action: null, target: null }],
        }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => ({}),
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    const trigger = host.querySelector(".glosa-attention-trigger") as any;
    trigger.click();
    await flush();
    expect(
      Array.from(host.querySelectorAll(".glosa-attention-actions button")).map((button) => button.textContent),
    ).toEqual(["Done"]);
    host
      .querySelector(".glosa-attention-tray")
      ?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect((host.querySelector(".glosa-attention-tray") as any).hidden).toBe(true);
    expect(dom.document.activeElement).toBe(trigger);
  });

  test("approval-mode requests navigate to the artifact and never render terminal response controls", async () => {
    const opened: string[] = [];
    const entry = {
      id: "approval-1",
      status: "seen",
      message: "Check citations",
      action: "proofread",
      target_path: "draft.md",
      approval_mode: true,
    };
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({ pending_count: 1, attention: [entry] }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => {
          throw new Error("approval must not be completed from the tray");
        },
      },
      getCurrentArtifact: () => null,
      onOpenArtifact: async (path: string) => {
        opened.push(path);
        return true;
      },
    });
    tray.setWorkspace("ws-one");
    await flush();
    (host.querySelector(".glosa-attention-trigger") as any).click();
    await flush();

    expect(host.querySelector(".glosa-attention-response")).toBeNull();
    expect(
      Array.from(host.querySelectorAll(".glosa-attention-actions button")).map((button) => button.textContent),
    ).toEqual(["Open artifact"]);
    (host.querySelector(".glosa-primary-button") as any).click();
    await flush();
    expect(opened).toEqual(["draft.md"]);
    expect((host.querySelector(".glosa-attention-tray") as any).hidden).toBe(true);
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
    host
      .querySelector(".glosa-attention-tray")
      ?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.document.activeElement).toBe(trigger);
  });

  test("failed response preserves input and returns focus for correction", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const tray = mountAttentionTray(host, {
      dataAccess: {
        getInbox: async () => ({
          pending_count: 1,
          attention: [{ id: "a1", status: "seen", message: "Review", action: "review", target: null }],
        }),
        markAttentionSeen: async () => ({}),
        respondToAttention: async () => {
          throw new Error("disk full");
        },
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
