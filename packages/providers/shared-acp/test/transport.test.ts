// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import type { AgentEvent, ProcessLauncher, SessionLaunchSpec } from "../../../daemon/src/agents/interface.ts";
import { waitUntil } from "../../../daemon/test/helpers.ts";
import { ACP_GATES, ACP_QUALIFICATIONS, acpQualificationStatus } from "../src/qualification.ts";
import { connectManagedAcp, type AcpProviderPolicy } from "../src/transport.ts";

// Local wire fixture, not a vendor translator. It proves the shared SDK projection and lifecycle.
function fixture(transportFailure = false) {
  const sent: Record<string, any>[] = [];
  let output: (frame: object) => void = () => {};
  let promptId: number | string | undefined;
  let starts = 0,
    fenced = false,
    stopped = false;
  const launcher: ProcessLauncher = {
    async spawn(options) {
      starts++;
      output = (frame) => options.onData("stdout", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`));
      return {
        pid: 123,
        exited: new Promise(() => {}),
        resize() {},
        async fence() {
          fenced = true;
        },
        async stop() {
          stopped = true;
        },
        async write(data) {
          const frame = JSON.parse(data);
          sent.push(frame);
          if (frame.method === "initialize")
            output({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          if (frame.method === "session/new") output({ id: frame.id, result: { sessionId: "native-a" } });
          if (frame.method === "session/prompt") {
            promptId = frame.id;
            output({
              method: "session/update",
              params: {
                sessionId: "native-a",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before permission" } },
              },
            });
            output({
              method: "session/update",
              params: {
                sessionId: "other-session",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrong session" } },
              },
            });
            output({
              method: "session/update",
              params: {
                sessionId: "native-a",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tool",
                  title: "Read",
                  kind: "read",
                  status: "pending",
                },
              },
            });
            output({
              id: "approval",
              method: "session/request_permission",
              params: {
                sessionId: "native-a",
                toolCall: { toolCallId: "tool", title: "Read outside" },
                options: [
                  { kind: "allow_always", optionId: "always", name: "Allow always" },
                  { kind: "allow_once", optionId: "once", name: "Allow once" },
                  { kind: "reject_once", optionId: "deny", name: "Deny" },
                ],
              },
            });
          }
          if (frame.id === "approval" && frame.result?.outcome?.outcome === "selected")
            output(
              transportFailure
                ? {
                    id: promptId,
                    error: {
                      code: -32603,
                      message: "Internal error",
                      data: { details: "Upstream cause: synthetic-access-token Bearer abc.def.ghi" },
                    },
                  }
                : { id: promptId, result: { stopReason: "end_turn", _meta: { nativeFailure: true } } },
            );
          if (frame.method === "session/cancel") output({ id: promptId, result: { stopReason: "cancelled" } });
        },
      };
    },
  };
  const spec = {
    profile: { provider: "codex" },
    cwd: "/workspace",
    configRoot: "/private/profile",
    runId: "attempt",
    generation: 1,
  } as SessionLaunchSpec;
  const policy: AcpProviderPolicy = {
    qualification: {
      ...ACP_QUALIFICATIONS.codex,
      blockers: [],
      evidence: Object.fromEntries(ACP_GATES.map((gate) => [gate, { passed: true, reference: "fixture-only" }])),
    },
    launch: () => ({
      command: "/fixture/adapter",
      args: [],
      env: { HOME: "/private", ACCESS_TOKEN: "synthetic-access-token" },
    }),
    async configure(connection, launch) {
      const session = await connection.agent.request("session/new", { cwd: launch.cwd, mcpServers: [] });
      return {
        sessionId: session.sessionId,
        capabilities: { models: [], images: false, questions: false, permissions: true, resume: false, mcp: false },
        prepare: async () => {},
        terminal: (result) =>
          (result as { stopReason: string }).stopReason === "cancelled"
            ? "cancelled"
            : { code: "fixture-native-failed", message: "Native turn failed" },
      };
    },
  };
  const input = {
    turnId: "logical",
    text: "Review",
    settings: { model: "model", effort: "high", permissionMode: "workspace" as const },
    attachments: [],
  };
  return { launcher, policy, spec, sent, input, starts: () => starts, fenced: () => fenced, stopped: () => stopped };
}

test("released ACP tuples remain disabled before launch and every qualification gate is required", async () => {
  for (const qualification of Object.values(ACP_QUALIFICATIONS)) {
    const f = fixture();
    f.policy.qualification = qualification;
    f.spec.profile.provider = qualification.provider;
    expect(acpQualificationStatus(qualification)).toMatchObject({
      qualified: false,
      warmReuse: false,
      missing: [...ACP_GATES],
    });
    await expect(connectManagedAcp(f.spec, f.launcher, () => {}, f.policy)).rejects.toThrow(
      "awaiting provider qualification",
    );
    expect(f.starts()).toBe(0);
  }
  const f = fixture();
  for (const gate of ACP_GATES) {
    const evidence = { ...f.policy.qualification.evidence, [gate]: { passed: false, reference: "fixture-only" } };
    expect(acpQualificationStatus({ ...f.policy.qualification, evidence }).qualified).toBe(false);
  }
});

test("shared ACP stdio streams before a human decision, scopes sessions and preserves native failure over end_turn", async () => {
  const f = fixture(),
    events: AgentEvent[] = [];
  const connection = await connectManagedAcp(f.spec, f.launcher, (event) => events.push(event), f.policy);
  try {
    await connection.startTurn(f.input);
    expect(await waitUntil(() => events.some((event) => event.type === "decision"))).toBe(true);
    const decision = events.find((event) => event.type === "decision")!;
    expect(decision.type === "decision" && decision.decision.choices).toEqual([
      { id: "allow", label: "Allow once" },
      { id: "deny", label: "Deny" },
    ]);
    expect(events.filter((event) => event.type === "text")).toMatchObject([{ text: "Before permission" }]);
    expect(events.some((event) => event.type === "tool" && event.name === "Read")).toBe(true);
    await connection.answer("tool", "deny");
    expect(await waitUntil(() => events.some((event) => event.type === "failed"))).toBe(true);
    expect(events.some((event) => event.type === "failed" && event.code === "fixture-native-failed")).toBe(true);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(f.sent.find((frame) => frame.id === "approval")!.result.outcome).toEqual({
      outcome: "selected",
      optionId: "deny",
    });
    await expect(connection.startTurn(f.input)).rejects.toThrow("already accepted a message");
    expect(f.sent.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
    const init = f.sent.find((frame) => frame.method === "initialize")!.params;
    expect(init.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  } finally {
    await connection.close();
  }
  expect(f.starts()).toBe(1);
  expect(f.fenced()).toBe(true);
  expect(f.stopped()).toBe(true);
});

test("ACP preparation failure prevents prompt dispatch and cancellation retires an unanswered decision", async () => {
  const f = fixture(),
    events: AgentEvent[] = [];
  const configure = f.policy.configure;
  let ready = false;
  f.policy.configure = async (...args) => ({
    ...(await configure(...args)),
    async prepare() {
      if (!ready) throw new Error("Required tools unavailable");
    },
  });
  const connection = await connectManagedAcp(f.spec, f.launcher, (event) => events.push(event), f.policy);
  try {
    await expect(connection.startTurn(f.input)).rejects.toThrow("Required tools unavailable");
    expect(f.sent.some((frame) => frame.method === "session/prompt")).toBe(false);
    ready = true;
    await connection.startTurn(f.input);
    expect(await waitUntil(() => events.some((event) => event.type === "decision"))).toBe(true);
    await connection.interrupt();
    expect(
      await waitUntil(() => events.some((event) => event.type === "failed" && event.code === "native-cancelled")),
    ).toBe(true);
    await expect(connection.answer("tool", "allow")).rejects.toThrow("no longer needs");
    expect(f.sent.find((frame) => frame.id === "approval")!.result.outcome).toEqual({ outcome: "cancelled" });
  } finally {
    await connection.close();
  }
  expect(f.stopped()).toBe(true);
});

test("shared ACP retains structured upstream details while removing credentials from diagnostics", async () => {
  const f = fixture(true),
    events: AgentEvent[] = [];
  const connection = await connectManagedAcp(f.spec, f.launcher, (event) => events.push(event), f.policy);
  try {
    await connection.startTurn(f.input);
    expect(await waitUntil(() => events.some((event) => event.type === "decision"))).toBe(true);
    await connection.answer("tool", "deny");
    expect(await waitUntil(() => events.some((event) => event.type === "failed"))).toBe(true);
    expect(events.find((event) => event.type === "failed")).toMatchObject({
      code: "acp-provider-failed",
      details: "Upstream cause: [redacted] Bearer [redacted]",
      outcomeUnknown: true,
    });
  } finally {
    await connection.close();
  }
});
