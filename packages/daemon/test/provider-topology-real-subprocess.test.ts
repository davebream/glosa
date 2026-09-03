// SPDX-License-Identifier: Apache-2.0
// T8 explicit-binding/provider fidelity: production CodexProvider inside a real daemon process,
// controlled entirely through localhost API calls. No Codex executable, model, network, user
// credential, hook installation, or MCP configuration participates.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../src/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "provider-topology-real-process-token-0123456789";
const roots: string[] = [];

function request(port: number, path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: `http://127.0.0.1:${port}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function post(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(request(port, path, body));
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("T8 real daemon + production provider + divergent cwd topology", () => {
  test("CodexProvider queues across an explicit cross-directory binding, survives SIGKILL, then Stop presents it", async () => {
    const home = freshHome();
    const artifactWorkspace = mkdtempSync(join(tmpdir(), "glosa-provider-artifacts-"));
    const agentCwd = mkdtempSync(join(tmpdir(), "glosa-provider-agent-cwd-"));
    roots.push(home, artifactWorkspace, agentCwd);
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    writeFileSync(join(artifactWorkspace, "notes.md"), "# Cross-directory target\n");
    const port = randomPort();
    const sessionId = "controlled-codex-session";
    const messageId = "11111111-1111-4111-8111-111111111111";

    let daemon = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    try {
      expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();

      const openedResponse = await post(port, "/api/workspaces/open", { path: artifactWorkspace });
      expect(openedResponse.status).toBe(200);
      const opened = (await openedResponse.json()) as { slug: string; path: string };
      expect(opened.path).toBe(realpathSync(artifactWorkspace));

      const registered = await post(port, "/api/sessions/register", {
        session_id: sessionId,
        provider: "codex",
        cwd: agentCwd,
        source: "controlled-local-fixture",
      });
      expect(registered.status).toBe(200);
      expect((await registered.json()).workspace).toBe(realpathSync(agentCwd));

      const bound = await post(port, `/w/${opened.slug}/session-binding`, { session_id: sessionId });
      expect(bound.status).toBe(200);

      const composed = await post(port, `/w/${opened.slug}/transcript/compose`, {
        message_id: messageId,
        text: "provider boundary survives a daemon restart",
      });
      expect(composed.status).toBe(202);
      expect(await composed.json()).toMatchObject({
        message_id: messageId,
        state: "queued",
        delivery: { via: "gate", outcome: "attempted" },
      });

      const journalPath = join(artifactWorkspace, ".glosa", "journal.ndjson");
      const beforeKill = readFileSync(journalPath, "utf8");
      expect(beforeKill).toContain(`"entry":"${messageId}"`);
      expect(beforeKill).toContain(`"via":"gate"`);
      expect(beforeKill).toContain(`"outcome":"attempted"`);

      daemon.kill("SIGKILL");
      await daemon.exited;
      daemon = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });

      expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
      const reopened = await post(port, "/api/workspaces/open", { path: artifactWorkspace });
      expect(reopened.status).toBe(200);
      const reRegistered = await post(port, "/api/sessions/register", {
        session_id: sessionId,
        provider: "codex",
        cwd: agentCwd,
        source: "controlled-local-fixture-resume",
      });
      expect(reRegistered.status).toBe(200);
      expect((await post(port, `/w/${opened.slug}/session-binding`, { session_id: sessionId })).status).toBe(200);

      const drainedResponse = await post(port, `/api/sessions/${sessionId}/drain`, { via: "stop" });
      expect(drainedResponse.status).toBe(200);
      const drained = (await drainedResponse.json()) as {
        delivery_id: string;
        count: number;
        drained: Array<{ id: string; workspace: string; target_session_id?: string }>;
      };
      expect(drained.count).toBe(1);
      expect(drained.drained[0]).toMatchObject({
        id: messageId,
        workspace: realpathSync(artifactWorkspace),
        target_session_id: sessionId,
      });

      const ack = await post(port, `/api/sessions/${sessionId}/deliveries/${drained.delivery_id}/ack`, {
        outcome: "presented",
      });
      expect(ack.status).toBe(200);

      const afterRestart = readFileSync(journalPath, "utf8");
      expect(afterRestart).toContain(`"via":"stop"`);
      expect(afterRestart).toContain(`"outcome":"presented"`);
      expect(afterRestart).toContain(`"to":"delivered"`);
    } finally {
      await stopDaemon(home, daemon);
      cleanupHome(home);
    }
  }, 30_000);
});
