// SPDX-License-Identifier: Apache-2.0
// Issue 178 / #151 / #152: the plugin monitor's reconnect loop depends on this file's
// `openSessionStream` for every one of its retry signals — a clean EOF that falls through without
// throwing, a thrown stream failure, and (crucially) telling a registered/alive/unbound session
// (409) apart from an unknown/dead one (404) so the loop never confuses the two. The monitor suite
// fakes the client, so none of that ever runs through the real HTTP surface this file implements.
// These tests exercise the real thing against a real daemon subprocess (this suite's supplied
// process-test helper, never a live GLOSA_HOME) so the 409/404/clean-EOF/abort claims are about the
// actual production code path, not a stand-in for it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isApiError } from "../src/api-client.ts";
import { createHttpDaemonClient, type DaemonHookClient } from "../src/daemon-client.ts";
import { tokenPath } from "../../daemon/src/security/token.ts";
import {
  cleanupHome,
  freshHome,
  randomPort,
  spawnDaemon,
  stopDaemon,
  waitForHandshake,
} from "../../daemon/test/helpers.ts";

const TOKEN = "daemon-client-session-stream-real-token-0123456789";

interface RealDaemon {
  port: number;
  home: string;
  client: DaemonHookClient;
  register(body: Record<string, unknown>): Promise<void>;
}

async function withRealDaemon(fn: (daemon: RealDaemon) => Promise<void>): Promise<void> {
  const home = freshHome();
  const port = randomPort();
  writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
  const daemon = spawnDaemon(home, port);
  const priorHome = process.env.GLOSA_HOME;
  const priorPort = process.env.GLOSA_PORT;
  process.env.GLOSA_HOME = home;
  process.env.GLOSA_PORT = String(port);
  try {
    expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
    const client = await createHttpDaemonClient();
    await fn({
      port,
      home,
      client,
      async register(body) {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/register`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
      },
    });
  } finally {
    if (priorHome === undefined) delete process.env.GLOSA_HOME;
    else process.env.GLOSA_HOME = priorHome;
    if (priorPort === undefined) delete process.env.GLOSA_PORT;
    else process.env.GLOSA_PORT = priorPort;
    await stopDaemon(home, daemon);
    cleanupHome(home);
  }
}

function realDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "glosa-session-stream-")));
}

describe("createHttpDaemonClient() carries no Channel-era surface (#152)", () => {
  test("neither openConversationPush nor acknowledgeConversation exists on the client", async () => {
    await withRealDaemon(async ({ client }) => {
      expect("openConversationPush" in client).toBe(false);
      expect("acknowledgeConversation" in client).toBe(false);
    });
  }, 30_000);
});

describe("createHttpDaemonClient().openSessionStream against a real daemon (issue 178, #151)", () => {
  test("unknown/dead session is 404, registered/alive/unbound is 409 — never confused", async () => {
    await withRealDaemon(async ({ client, register }) => {
      const agentCwd = realDir();
      let opens = 0;
      const onOpen = () => {
        opens++;
      };

      let deadError: unknown;
      try {
        await client.openSessionStream!(
          "never-registered",
          "monitor",
          async () => {},
          new AbortController().signal,
          onOpen,
        );
      } catch (error) {
        deadError = error;
      }
      expect(isApiError(deadError)).toBe(true);
      expect((deadError as { status: number }).status).toBe(404);

      await register({ session_id: "unbound-session", provider: "claude-code", cwd: agentCwd, source: "mcp" });
      let unboundError: unknown;
      try {
        await client.openSessionStream!(
          "unbound-session",
          "monitor",
          async () => {},
          new AbortController().signal,
          onOpen,
        );
      } catch (error) {
        unboundError = error;
      }
      expect(isApiError(unboundError)).toBe(true);
      expect((unboundError as { status: number }).status).toBe(409);
      // Neither rejection ever got a response worth calling "established" — the monitor's
      // reconnect loop must be able to tell these apart from a connection that actually opened.
      expect(opens).toBe(0);
    });
  }, 30_000);

  test("onOpen fires once the stream response is actually established, before any entry arrives", async () => {
    await withRealDaemon(async ({ client, register }) => {
      const agentCwd = realDir();
      const workspace = realDir();
      await register({
        session_id: "onopen-session",
        provider: "claude-code",
        cwd: agentCwd,
        source: "mcp",
        workspace_binding: workspace,
      });

      let openedAt: number | null = null;
      const abort = new AbortController();
      const push = client.openSessionStream!(
        "onopen-session",
        "monitor",
        async () => {},
        abort.signal,
        () => {
          openedAt = Date.now();
        },
      );
      await Bun.sleep(300); // let the real HTTP response actually land
      expect(openedAt).not.toBeNull();

      abort.abort();
      await push.catch(() => {});
    });
  }, 30_000);

  test("a replacement connection closes the prior one cleanly — openSessionStream returns, it does not throw", async () => {
    await withRealDaemon(async ({ client, register }) => {
      const agentCwd = realDir();
      const workspace = realDir();
      await register({
        session_id: "bound-session",
        provider: "claude-code",
        cwd: agentCwd,
        source: "mcp",
        workspace_binding: workspace,
      });

      let firstSettled: "resolved" | "rejected" | null = null;
      const firstAbort = new AbortController();
      const first = client.openSessionStream!("bound-session", "monitor", async () => {}, firstAbort.signal)
        .then(() => {
          firstSettled = "resolved";
        })
        .catch(() => {
          firstSettled = "rejected";
        });

      // Give the first connection time to actually establish before the registry replaces it —
      // otherwise this proves nothing about a live connection being closed.
      await Bun.sleep(300);
      expect(firstSettled).toBeNull();

      // A2/A1 §5.12: a second stream for the SAME session replaces the first, which the daemon's
      // SessionPushRegistry closes cleanly (production replacement path, not a test seam).
      const secondAbort = new AbortController();
      const second = client.openSessionStream!("bound-session", "monitor", async () => {}, secondAbort.signal);

      await first;
      // TS's control-flow narrowing tracks `firstSettled`'s declaration-site literal straight
      // through the `.then`/`.catch` closures above; the cast just restates its real declared
      // type so the assertion below type-checks against what the closures can actually assign.
      expect(firstSettled as "resolved" | "rejected" | null).toBe("resolved"); // clean EOF: fell through, never threw

      secondAbort.abort();
      await second.catch(() => {});
    });
  }, 30_000);

  test("aborting the signal tears down the real connection promptly, even though the stream never ends on its own", async () => {
    await withRealDaemon(async ({ client, register }) => {
      const agentCwd = realDir();
      const workspace = realDir();
      await register({
        session_id: "abort-session",
        provider: "claude-code",
        cwd: agentCwd,
        source: "mcp",
        workspace_binding: workspace,
      });

      const abort = new AbortController();
      const push = client.openSessionStream!("abort-session", "monitor", async () => {}, abort.signal);
      await Bun.sleep(200); // let the stream actually open before cancelling it

      const abortedAt = Date.now();
      abort.abort();
      await push.catch(() => {});
      expect(Date.now() - abortedAt).toBeLessThan(2_000);
    });
  }, 30_000);
});
