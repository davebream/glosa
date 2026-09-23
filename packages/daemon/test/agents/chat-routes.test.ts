// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import type { ManagedChatService } from "../../src/chats/service.ts";
import { chatRoutes } from "../../src/routes/chats.ts";
import type { BunServer } from "../../src/routes/types.ts";
import { CapabilityStore } from "../../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../../src/transport/http.ts";

function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:4646${path}`, {
    method,
    headers: {
      Host: "127.0.0.1:4646",
      Authorization: "Bearer paired-test-browser",
      ...(method === "POST" ? { Origin: "http://127.0.0.1:4646" } : {}),
      ...headers,
    },
  });
}
function harness() {
  return createApiFetch({
    port: 4646,
    classFPort: 4647,
    token: "paired-test-browser",
    instanceId: "fixture",
    startedAt: "2026-09-23T00:00:00.000Z",
    capabilityStore: new CapabilityStore(),
  } as ApiContext);
}
test("zero-provider status exposes availability without loading or launching a provider", async () => {
  const response = await harness()(request("/api/agents/status"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ available: false, profiles: [], providers: [] });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
test("agent account routes reject an unpaired browser and class-F origin before handling operations", async () => {
  const fetch = harness();
  expect((await fetch(request("/api/agents/status", "GET", { Authorization: "" }))).status).toBe(401);
  expect((await fetch(request("/api/agents/profiles", "POST", { Origin: "http://127.0.0.1:4647" }))).status).toBe(403);
  expect((await fetch(request("/api/agents/profiles", "POST", { Origin: "https://outside.example" }))).status).toBe(
    403,
  );
});

test("runtime install disables HTTP idle expiry before awaiting the bounded installer", async () => {
  let complete!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const timeouts: unknown[][] = [];
  const req = request("/api/agents/runtimes/codex/install", "POST");
  const route = chatRoutes(
    {
      workspaceIndex: {
        getBySlug() {
          throw new Error("install must not access a workspace");
        },
        getWorkspaceByRegistration() {
          throw new Error("install must not access a workspace");
        },
        forgetOperationForSlug() {
          throw new Error("install must not access a workspace");
        },
        activeForgetOperationForCanonicalPath() {
          throw new Error("install must not access a workspace");
        },
      },
      getWorkspaceBus() {
        throw new Error("install must not access a workspace");
      },
      service: {
        bindAuthorization() {},
        install() {
          return pending;
        },
      } as unknown as ManagedChatService,
    },
    "POST",
    new URL(req.url).pathname,
  )!;
  const response = route.handle(req, {
    timeout(...args: unknown[]) {
      timeouts.push(args);
    },
  } as unknown as BunServer);
  try {
    expect(timeouts).toEqual([[req, 0]]);
  } finally {
    complete({ installed: true });
    expect(await (await response).json()).toEqual({ installed: true });
  }
});

test("conversation transfer freezes only visible user and assistant text with exact preview metadata", async () => {
  const chatId = "11111111-1111-4111-8111-111111111111";
  const path = `/w/test/chats/${chatId}/transfer`;
  const route = chatRoutes(
    {
      workspaceIndex: {
        getBySlug: () => ({ registration_id: "a".repeat(64), first_seen: "epoch", canonical_path: "/tmp/fixture" }),
      },
      service: {
        bindAuthorization() {},
        snapshot: () => ({
          title: "Résumé",
          turns: [{ id: "first", text: "Visible question" }],
          content: [
            { turnId: "first", kind: "text", role: "assistant", text: "Visible answer" },
            { turnId: "first", kind: "reasoning", role: "assistant", text: "PRIVATE REASONING" },
            { turnId: "first", kind: "tool", role: "tool", text: "PRIVATE TOOL RESULT" },
            { turnId: "first", kind: "status", role: "system", text: "PRIVATE CONTROL" },
          ],
        }),
      },
    } as unknown as Parameters<typeof chatRoutes>[0],
    "GET",
    path,
  )!;
  const response = await route.handle(request(path));
  expect(response.status).toBe(200);
  const preview = (await response.json()) as { title: string; turnCount: number; bytes: number; text: string };
  expect(preview.title).toBe("Résumé");
  expect(preview.turnCount).toBe(1);
  expect(preview.text).toContain("Visible question");
  expect(preview.text).toContain("Visible answer");
  expect(preview.text).not.toContain("PRIVATE");
  expect(preview.bytes).toBe(Buffer.byteLength(preview.text));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
