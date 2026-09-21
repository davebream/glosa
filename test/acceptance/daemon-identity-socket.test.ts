// SPDX-License-Identifier: Apache-2.0
//
// T8 security suite — A3 §5 attack #11: a local process takes the loopback port a resolved client
// is still using (issue #207).
//
// What this file exists to observe is NOT "does the helper return false for a dead pid". It is the
// only thing that matters: **does the pairing credential reach the impostor**. Every case below
// therefore asserts on what the squatter actually received, from a server the test controls, and
// not on any internal verdict.
//
// The squatter runs at the SAME uid as the daemon, because a test cannot become another user. It
// reproduces the cross-uid attacker's CAPABILITY SET instead: it reads the world-readable lock and
// the tokenless handshake, and nothing else. Two assertions keep that honest rather than assumed —
// it never opens the 0600 token path and never writes the lock path — so a pass cannot come from a
// capability the real attacker does not have.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { BUILD_ID } from "../../packages/daemon/src/lifecycle/build-id.ts";
import { daemonPeerMismatchReason } from "../../packages/daemon/src/lifecycle/daemon.ts";
import { fetchHandshake, probePortBindable } from "../../packages/daemon/src/lifecycle/handshake.ts";
import { apiSocketPath, lockPath, runDir } from "../../packages/daemon/src/lifecycle/home.ts";
import { INSTALL_ID } from "../../packages/daemon/src/lifecycle/install.ts";
import { isPidAlive, readLock } from "../../packages/daemon/src/lifecycle/lock.ts";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { createHttpDaemonClient } from "../../packages/cli/src/daemon-client.ts";
import {
  cleanupHome,
  freshHome,
  randomPort,
  spawnDaemon,
  waitForHandshake,
  waitUntil,
} from "../../packages/daemon/test/helpers.ts";

/** `waitUntil` takes a synchronous predicate; releasing a listening socket is observable only by
 * an async bind probe. Bounded, and its boolean is ASSERTED at every call site — a discarded
 * false would turn "the port never freed" into a baffling mismatch three lines later. */
async function waitUntilBindable(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probePortBindable(port)) return true;
    await Bun.sleep(50);
  }
  return false;
}

const TOKEN = "daemon-identity-socket-test-token-0123456789";
const FIXTURE = new URL("../../packages/daemon/test/fixtures/versioned-daemon.ts", import.meta.url).pathname;

/** Everything the squatter saw. `auth` is the whole point: a null in every row is the pass. */
interface Seen {
  path: string;
  auth: string | null;
}

/**
 * A server that echoes a dead (or displaced) daemon's handshake byte for byte, which is exactly
 * what a cross-uid attacker can do with nothing but a read of the 0644 lock.
 */
function squat(port: number, handshakeBody: unknown, seen: Seen[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get("Authorization") });
      return Response.json(url.pathname === "/api/handshake" ? handshakeBody : { ok: true });
    },
  });
}

/** One FRESH connect(2) — never `fetch`, whose connection pool answers without reconnecting and
 * makes a permission probe report the opposite of the truth. */
function tryConnect(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve("CONNECTED");
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(`REFUSED ${err.code}`);
    });
  });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function useHome(home = freshHome()): { home: string; port: number } {
  const port = randomPort();
  writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
  const savedHome = process.env.GLOSA_HOME;
  const savedPort = process.env.GLOSA_PORT;
  process.env.GLOSA_HOME = home;
  process.env.GLOSA_PORT = String(port);
  cleanups.push(() => {
    if (savedHome === undefined) delete process.env.GLOSA_HOME;
    else process.env.GLOSA_HOME = savedHome;
    if (savedPort === undefined) delete process.env.GLOSA_PORT;
    else process.env.GLOSA_PORT = savedPort;
    cleanupHome(home);
  });
  return { home, port };
}

describe("A3 §5 attack #11 — the loopback port is not where the credential goes", () => {
  test("the socket is 0600 inside a 0700 directory, and the kernel enforces both", async () => {
    // Keep this permission witness below Darwin's Unix-socket pathname limit. Bun can
    // connect to a long path while its parents are traversable, then report EINVAL when
    // chmod prevents its path resolution. That would test path handling, not EACCES.
    // mkdtemp owns this private fixture even when the outer harness has a deeply nested TMPDIR.
    const { home, port } = useHome(mkdtempSync("/tmp/glosa-socket-mode-"));
    const daemon = spawnDaemon(home, port);
    cleanups.push(async () => {
      daemon.kill("SIGKILL");
      await daemon.exited;
    });
    expect(await waitForHandshake(port, 20_000, daemon)).not.toBeNull();
    const socket = apiSocketPath(home);
    expect(await waitUntil(() => existsSync(socket), 5000)).toBe(true);

    expect(statSync(runDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(await tryConnect(socket)).toBe("CONNECTED");

    expect(Buffer.byteLength(socket)).toBeLessThan(100);
    // Each permission is enforced independently, so each is asserted independently.
    try {
      chmodSync(socket, 0o000);
      expect(await tryConnect(socket)).toBe("REFUSED EACCES");
      chmodSync(socket, 0o600);
      chmodSync(runDir(home), 0o000);
      expect(await tryConnect(socket)).toBe("REFUSED EACCES");
    } finally {
      // Restore traversal before cleanup even when a permission assertion fails.
      chmodSync(runDir(home), 0o700);
      chmodSync(socket, 0o600);
    }
  }, 40_000);

  test("a squatter echoing a dead daemon's handshake receives no Authorization header", async () => {
    const { home, port } = useHome();
    const daemon = spawnDaemon(home, port);
    expect(await waitForHandshake(port, 20_000, daemon)).not.toBeNull();
    expect(await waitUntil(() => existsSync(apiSocketPath(home)), 5000)).toBe(true);

    const client = await createHttpDaemonClient({ ensureTimeoutMs: 10_000 });
    const lock = readLock(lockPath(home));
    expect(lock).not.toBeNull();
    const handshakeBody = await (await fetch(`http://127.0.0.1:${port}/api/handshake`)).json();

    // SIGKILL, never SIGTERM: a graceful stop removes the lock, and a surviving lock is the
    // premise of the whole attack.
    daemon.kill("SIGKILL");
    await daemon.exited;
    expect(existsSync(lockPath(home))).toBe(true);
    expect(await waitUntilBindable(port, 5000)).toBe(true);

    const seen: Seen[] = [];
    const impostor = squat(port, handshakeBody, seen);
    cleanups.push(() => void impostor.stop(true));

    // The impostor really is indistinguishable by the values a client could compare — this is
    // asserted, not assumed, because it is what makes the rest of the test mean anything.
    const echoed = await fetchHandshake(port, 1000);
    expect(echoed?.instance_id).toBe(lock!.instance_id);
    expect(daemonPeerMismatchReason(lock!, echoed!)).toBeNull();
    expect(echoed?.build_id).toBe(BUILD_ID);
    expect(echoed?.install_id).toBe(INSTALL_ID);

    // Deliberately not `rejects.toMatchObject` around the call: the claim this test exists to
    // defend is "the impostor got no credential", and that must be the FIRST assertion to fail
    // when the mechanism is removed. Asserting the error type first would red on the error shape
    // instead and say nothing about what crossed the wire.
    const outcome = await client.sessionStreamStatus!("s-207").then(
      () => null,
      (error: unknown) => error,
    );

    expect(seen.filter((row) => row.auth !== null)).toEqual([]);
    expect(seen.map((row) => row.path)).toEqual(["/api/handshake"]);
    expect(outcome).toMatchObject({ code: "DAEMON_UNREACHABLE" });
  }, 60_000);

  test("during the shutdown window — port free, PID alive, lock correct — the credential still does not go there", async () => {
    const { home, port } = useHome();
    // `__daemon` in argv so `isGlosaDaemonProcess` passes: this fixture reproduces the state a
    // real daemon is in between closing its listeners and releasing its lock, and the point is
    // that EVERY check the rejected design would have made succeeds here.
    const peer = Bun.spawn({
      cmd: [process.execPath, FIXTURE, "__daemon"],
      env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), GLOSA_FIXTURE_BUILD_ID: BUILD_ID } as Record<
        string,
        string
      >,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    cleanups.push(async () => {
      peer.kill("SIGKILL");
      await peer.exited;
    });
    expect(await waitForHandshake(port, 20_000)).not.toBeNull();
    expect(await waitUntil(() => existsSync(apiSocketPath(home)), 5000)).toBe(true);

    const client = await createHttpDaemonClient({ ensureTimeoutMs: 10_000 });
    const lock = readLock(lockPath(home));
    const handshakeBody = await (await fetch(`http://127.0.0.1:${port}/api/handshake`)).json();

    // Enter the window and hold it: TCP listener closed, process alive, lock untouched.
    writeFileSync(`${home}/fixture-drop-tcp`, "");
    expect(await waitUntilBindable(port, 5000)).toBe(true);
    expect(isPidAlive(peer.pid)).toBe(true);

    const seen: Seen[] = [];
    const impostor = squat(port, handshakeBody, seen);
    cleanups.push(() => void impostor.stop(true));

    // Every precondition the rejected "re-verify before every use" design relied on holds RIGHT
    // NOW, which is precisely why it would have handed this impostor the credential.
    const currentLock = readLock(lockPath(home));
    expect(currentLock).toMatchObject({ instance_id: lock!.instance_id, pid: lock!.pid, port });
    expect(isPidAlive(currentLock!.pid)).toBe(true);
    const echoed = await fetchHandshake(port, 1000);
    expect(daemonPeerMismatchReason(currentLock!, echoed!)).toBeNull();

    // The client is unaffected: its traffic never went to the port in the first place.
    await client.sessionStreamStatus!("s-207-window");
    await client.sessionStreamStatus!("s-207-window");

    expect(seen.filter((row) => row.auth !== null)).toEqual([]);
  }, 60_000);

  test("with the socket gone the call fails closed instead of falling back to the port", async () => {
    const { home, port } = useHome();
    const daemon = spawnDaemon(home, port);
    cleanups.push(async () => {
      daemon.kill("SIGKILL");
      await daemon.exited;
    });
    expect(await waitForHandshake(port, 20_000, daemon)).not.toBeNull();
    expect(await waitUntil(() => existsSync(apiSocketPath(home)), 5000)).toBe(true);

    // Removed BEFORE this process has ever spoken to it. Bun pools connections by socket path, so
    // unlinking the file after a successful request would leave an established connection that
    // keeps working — correct behaviour, and it would make this test observe nothing.
    unlinkSync(apiSocketPath(home));

    const client = await createHttpDaemonClient({ ensureTimeoutMs: 10_000 });
    await expect(client.sessionStreamStatus!("s-207-nofallback")).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });

    // The daemon is alive and answering on the port this whole time — a fallback would have
    // "worked", which is exactly why there is none: anything that can make the socket look absent
    // would otherwise get the credential over TCP.
    expect(await fetchHandshake(port, 1000)).not.toBeNull();
  }, 60_000);

  test("the squatter used only what a different uid could read — never the 0600 token, never the lock", async () => {
    // A same-uid test process COULD read the token and rewrite the lock; the real attacker cannot.
    // Reading the source is how this stays true as the file changes, rather than a comment
    // asserting it about code nobody re-checks.
    const source = readFileSync(new URL(import.meta.url).pathname, "utf8");
    const squatBody = source.slice(source.indexOf("function squat("), source.indexOf("/** One FRESH connect(2)"));
    expect(squatBody).not.toContain("tokenPath");
    expect(squatBody).not.toContain("lockPath");
    expect(squatBody).not.toContain("writeFileSync");
    // The only inputs it takes are a port, a handshake body read from the tokenless endpoint, and
    // an array to record into.
    expect(squatBody).toContain("function squat(port: number, handshakeBody: unknown, seen: Seen[])");
  });
});
