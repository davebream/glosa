// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { ensureToken, revokeToken, rotateToken } from "../src/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

function authedRead(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/workspaces`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Contract-Version": "1.0",
    },
  });
}

describe("live token lifecycle", () => {
  test("running daemon rejects stale concurrent requests after rotate/revoke and honors offline changes on restart", async () => {
    const home = freshHome();
    const port = randomPort();
    const first = ensureToken(home);
    let daemon = spawnDaemon(home, port);
    try {
      expect(await waitForHandshake(port)).not.toBeNull();
      expect((await authedRead(port, first)).status).toBe(200);

      const second = rotateToken(home);
      const staleAfterRotate = await Promise.all(Array.from({ length: 16 }, () => authedRead(port, first)));
      expect(staleAfterRotate.every((response) => response.status === 401)).toBe(true);
      const currentAfterRotate = await Promise.all(Array.from({ length: 16 }, () => authedRead(port, second)));
      expect(currentAfterRotate.every((response) => response.status === 200)).toBe(true);

      revokeToken(home);
      const staleAfterRevoke = await Promise.all(Array.from({ length: 16 }, () => authedRead(port, second)));
      expect(staleAfterRevoke.every((response) => response.status === 401)).toBe(true);
      const revokedHandshake = await (await fetch(`http://127.0.0.1:${port}/api/handshake`)).json();
      expect(revokedHandshake.paired).toBe(false);

      await stopDaemon(home, daemon);
      const offlineToken = rotateToken(home);
      daemon = spawnDaemon(home, port);
      expect(await waitForHandshake(port)).not.toBeNull();
      expect((await authedRead(port, second)).status).toBe(401);
      expect((await authedRead(port, offlineToken)).status).toBe(200);
    } finally {
      await stopDaemon(home, daemon);
      cleanupHome(home);
    }
  });
});
