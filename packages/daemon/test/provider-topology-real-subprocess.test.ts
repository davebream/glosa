// SPDX-License-Identifier: Apache-2.0
// T8 explicit-binding/provider fidelity: production CodexProvider inside a real daemon process,
// controlled entirely through localhost API calls. No Codex executable, model, network, user
// credential, hook installation, or MCP configuration participates.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const MAIN_PATH = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
import { tokenPath } from "../src/security/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "provider-topology-real-process-token-0123456789";
const roots: string[] = [];

describe("T8 live MCP process recovers after daemon restart (#141)", () => {
  for (const [provider, identityVariable] of [
    ["claude-code", "CLAUDE_CODE_SESSION_ID"],
    ["codex", "CODEX_THREAD_ID"],
  ] as const) {
    test(`${provider}: first tool registers, restart recovers, explicit bind restores routing`, async () => {
      const home = freshHome();
      const agentCwd = realpathSync(mkdtempSync(join(tmpdir(), "glosa-recovery-agent-")));
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), "glosa-recovery-target-")));
      roots.push(home, agentCwd, workspace);
      writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
      writeFileSync(join(workspace, "notes.md"), "# Recovery fixture\n");
      const port = randomPort();
      const sessionId = `recovery-${provider}`;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined && !["ANTHROPIC_API_KEY", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key),
        ),
      ) as Record<string, string>;
      Object.assign(env, { GLOSA_HOME: home, GLOSA_PORT: String(port), [identityVariable]: sessionId });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MAIN_PATH, "mcp"],
        cwd: agentCwd,
        env,
        stderr: "pipe",
      });
      const client = new Client({ name: "recovery-fixture", version: "1" });
      let daemon = spawnDaemon(home, port);
      const status = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          sessions: Array<{
            session_id: string;
            provider: string;
            cwd: string;
            workspace_binding: string | null;
            source: string;
          }>;
        };
      };
      try {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        await client.connect(transport);
        // A non-pull tool must register too; no SessionStart participates.
        expect((await client.callTool({ name: "glosa_metadata_show", arguments: { workspace } })).isError).not.toBe(
          true,
        );
        expect((await status()).sessions).toContainEqual(
          expect.objectContaining({
            session_id: sessionId,
            provider,
            cwd: agentCwd,
            source: "mcp",
            workspace_binding: null,
          }),
        );
        expect(
          (await client.callTool({ name: "glosa_session_bind", arguments: { session_id: sessionId, workspace } }))
            .isError,
        ).not.toBe(true);
        expect((await status()).sessions.find((s) => s.session_id === sessionId)?.workspace_binding).toBe(workspace);
        daemon.kill("SIGKILL");
        await daemon.exited;
        daemon = spawnDaemon(home, port);
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        expect((await status()).sessions).toHaveLength(0);
        // The SAME client and stdio process survive. Heartbeat 404 triggers registration.
        expect((await client.callTool({ name: "glosa_inbox_pull", arguments: {} })).isError).not.toBe(true);
        expect((await status()).sessions).toContainEqual(
          expect.objectContaining({ session_id: sessionId, provider, workspace_binding: null }),
        );
        expect(
          (await client.callTool({ name: "glosa_session_bind", arguments: { session_id: sessionId, workspace } }))
            .isError,
        ).not.toBe(true);
        expect((await status()).sessions.find((s) => s.session_id === sessionId)?.workspace_binding).toBe(workspace);
        // CLI also recovers an entirely unknown identity using only explicit metadata.
        const cliEnv = { ...env };
        delete cliEnv[identityVariable];
        const cli = Bun.spawn(
          [process.execPath, MAIN_PATH, "session", "bind", "manual-recovery", "--workspace", workspace, "--json"],
          { cwd: agentCwd, env: cliEnv, stdout: "pipe", stderr: "pipe" },
        );
        const output = await new Response(cli.stdout).text();
        expect(await cli.exited).toBe(0);
        expect(JSON.parse(output)).toMatchObject({ ok: true, data: { bound: true, session_id: "manual-recovery" } });
        expect((await status()).sessions).toContainEqual(
          expect.objectContaining({
            session_id: "manual-recovery",
            provider: "mcp",
            cwd: agentCwd,
            workspace_binding: workspace,
          }),
        );
      } finally {
        await client.close();
        await transport.close();
        await stopDaemon(home, daemon);
        cleanupHome(home);
      }
    }, 45_000);
  }
});

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
