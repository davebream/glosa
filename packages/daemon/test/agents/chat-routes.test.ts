// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
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
