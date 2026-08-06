// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentConnectPrompt, deriveAgentConnection, mountAgentFeedback } from "../src/agent-feedback.js";
import { installDom, type DomEnv } from "./dom-env.ts";

type HappyButton = InstanceType<DomEnv["window"]["HTMLButtonElement"]>;
type HappySelect = InstanceType<DomEnv["window"]["HTMLSelectElement"]>;
type HappyTextarea = InstanceType<DomEnv["window"]["HTMLTextAreaElement"]>;

const providers = [
  { provider: "claude-code", display_name: "Claude Code", instruction: "Use the current Claude session id." },
  { provider: "codex", display_name: "Codex", instruction: "Use the current Codex thread id." },
];

function statusFor(sessions: unknown[] = [], workspaceOverrides: Record<string, unknown> = {}) {
  return {
    workspaces: [
      {
        slug: "alpha",
        path: "/work/alpha",
        pending_count: 0,
        connect: {
          providers,
          cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
        },
        ...workspaceOverrides,
      },
    ],
    sessions,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    provider: "claude-code",
    cwd: "/elsewhere",
    workspace_binding: "/work/alpha",
    last_active_at: "2026-08-06T10:00:00.000Z",
    liveness: "alive",
    ...overrides,
  };
}

describe("deriveAgentConnection", () => {
  test("uses only explicit workspace_binding and lets any live binding outrank stale bindings", () => {
    const cwdOnly = session({ session_id: "cwd-only", cwd: "/work/alpha/child", workspace_binding: null });
    expect(deriveAgentConnection(statusFor([cwdOnly]), "alpha")?.state).toBe("unbound");

    const stale = session({ session_id: "stale", liveness: "stale" });
    expect(deriveAgentConnection(statusFor([cwdOnly, stale]), "alpha")?.state).toBe("stale");

    const live = session({ session_id: "live", provider: "codex" });
    const connection = deriveAgentConnection(statusFor([cwdOnly, stale, live]), "alpha")!;
    expect(connection.state).toBe("connected");
    expect(connection.sessions.map((candidate: { session_id: string }) => candidate.session_id)).toEqual([
      "live",
      "stale",
    ]);
  });

  test("builds a generic wrapper around provider-owned copy and the CLI fallback", () => {
    const connection = deriveAgentConnection(statusFor(), "alpha")!;
    const prompt = buildAgentConnectPrompt(connection, "codex");

    expect(prompt).toContain("Workspace: alpha");
    expect(prompt).toContain("Path: /work/alpha");
    expect(prompt).toContain("Use the current Codex thread id.");
    expect(prompt).toContain("glosa session bind <current-session-id> --workspace <workspace-path>");
    expect(buildAgentConnectPrompt(connection, "missing")).toBe("");
  });
});

describe("mountAgentFeedback", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  function mount(options: Record<string, unknown> = {}) {
    const host = dom.document.createElement("div");
    const overlays = dom.document.createElement("div");
    dom.document.body.append(host, overlays);
    const mounted = mountAgentFeedback(host, { overlayHost: overlays, ...options });
    return { host, overlays, mounted };
  }

  test("combines unbound, feedback-off, and queued state; multi-provider unbound requires a choice", async () => {
    const writes: string[] = [];
    const { host, overlays, mounted } = mount({
      clipboard: { writeText: async (text: string) => void writes.push(text) },
    });
    mounted.setState({
      slug: "alpha",
      wiring: { state: "unwired", pending_count: 2 },
      status: statusFor([], { pending_count: 2 }),
    });

    const trigger = host.querySelector(".glosa-agent-feedback-trigger") as HappyButton;
    expect(trigger.textContent).toBe("● Connect agent · feedback off · 2 queued");
    trigger.click();

    const select = overlays.querySelector("select") as HappySelect;
    const textarea = overlays.querySelector("textarea") as HappyTextarea;
    const copy = overlays.querySelector(".glosa-agent-feedback-copy") as HappyButton;
    expect(select.value).toBe("");
    expect(textarea.value).toBe("");
    expect(copy.disabled).toBe(true);
    expect(Array.from(overlays.querySelectorAll("button")).some((button) => button.textContent === "Wire it now")).toBe(
      true,
    );

    select.value = "codex";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await Promise.resolve();
    const selectedPrompt = (overlays.querySelector("textarea") as HappyTextarea).value;
    expect(selectedPrompt).toContain("Use the current Codex thread id.");
    (overlays.querySelector(".glosa-agent-feedback-copy") as HappyButton).click();
    await Promise.resolve();
    expect(writes).toEqual([selectedPrompt]);
    expect(overlays.querySelector('[role="status"]')?.textContent).toBe("Connect prompt copied.");
  });

  test("preselects the most recently active stale provider and shows every explicitly bound session", () => {
    const { host, overlays, mounted } = mount();
    mounted.setState({
      slug: "alpha",
      wiring: { state: "wired", pending_count: 0 },
      status: statusFor([
        session({ session_id: "claude-old", provider: "claude-code", liveness: "stale" }),
        session({
          session_id: "codex-recent",
          provider: "codex",
          liveness: "stale",
          last_active_at: "2026-08-06T11:00:00.000Z",
        }),
      ]),
    });

    (host.querySelector("button") as HappyButton).click();
    expect((overlays.querySelector("select") as HappySelect).value).toBe("codex");
    const sessions = Array.from(overlays.querySelectorAll(".glosa-agent-feedback-sessions li"));
    expect(sessions.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Codex"),
      expect.stringContaining("Claude Code"),
    ]);
  });

  test("auto-selects one provider, recovers from clipboard failure, and restores trigger focus on Escape", async () => {
    const { host, overlays, mounted } = mount({
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    mounted.setState({
      slug: "alpha",
      wiring: { state: "wired", pending_count: 0 },
      status: statusFor([], { connect: { providers: [providers[0]], cli_fallback: "fallback" } }),
    });

    const trigger = host.querySelector("button") as HappyButton;
    trigger.click();
    expect((overlays.querySelector("select") as HappySelect).value).toBe("claude-code");
    (overlays.querySelector(".glosa-agent-feedback-copy") as HappyButton).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const textarea = overlays.querySelector("textarea") as HappyTextarea;
    expect(overlays.querySelector('[role="status"]')?.textContent).toContain("selected so you can copy it manually");
    expect(dom.document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);

    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(trigger);
  });

  test("connected details include multiple live sessions and unwired keeps the consented action", async () => {
    let wireCalls = 0;
    const { host, overlays, mounted } = mount({ onWire: async () => void (wireCalls += 1) });
    mounted.setState({
      slug: "alpha",
      wiring: { state: "unwired", pending_count: 0 },
      status: statusFor([
        session({ session_id: "claude-live" }),
        session({ session_id: "codex-live", provider: "codex" }),
      ]),
    });

    (host.querySelector("button") as HappyButton).click();
    expect(overlays.querySelector(".glosa-agent-feedback-summary")?.textContent).toBe(
      "2 agent sessions are connected.",
    );
    expect(overlays.querySelectorAll(".glosa-agent-feedback-sessions li")).toHaveLength(2);
    const wire = Array.from(overlays.querySelectorAll("button")).find(
      (button) => button.textContent === "Wire it now",
    )!;
    wire.click();
    await Promise.resolve();
    expect(wireCalls).toBe(1);
  });

  test("workspace switching resets provider choice instead of carrying it across workspaces", () => {
    const { host, overlays, mounted } = mount();
    mounted.setState({
      slug: "alpha",
      wiring: { state: "wired", pending_count: 0 },
      status: statusFor([], { connect: { providers: [providers[0]], cli_fallback: "fallback" } }),
    });
    (host.querySelector("button") as HappyButton).click();
    expect((overlays.querySelector("select") as HappySelect).value).toBe("claude-code");

    mounted.setState({
      slug: "beta",
      wiring: { state: "wired", pending_count: 0 },
      status: {
        workspaces: [
          {
            slug: "beta",
            path: "/work/beta",
            pending_count: 0,
            connect: {
              providers,
              cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
            },
          },
        ],
        sessions: [],
      },
    });
    expect((overlays.querySelector("select") as HappySelect).value).toBe("");
    expect((overlays.querySelector("textarea") as HappyTextarea).value).toBe("");
  });
});
