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
