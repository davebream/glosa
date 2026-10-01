// SPDX-License-Identifier: Apache-2.0
// Offline Linux integration: real libsecret/D-Bus storage and a real detached Glosa daemon.
// Run under dbus-run-session. Private HOME and keyring; never use the desktop's live wallet.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LinuxSecretServiceCredentialStore, writeWisprFlowConfig } from "../packages/providers/wispr-flow/src/index.ts";
import { credentialHelperEnv } from "../packages/providers/wispr-flow/src/secret-service.ts";

const mode = process.argv[2];
const account = process.argv[3] ?? crypto.randomUUID();
const cli = resolve(import.meta.dir, "../packages/cli/src/main.ts");
if (mode === "--store") {
  await new LinuxSecretServiceCredentialStore().addInteractive(account);
} else if (mode === "--read") {
  const expected = await Bun.stdin.text();
  assert.equal(await new LinuxSecretServiceCredentialStore().read(account), expected, "real Secret Service read");
} else if (mode === "--parent") {
  const expected = await Bun.stdin.text();
  const child = Bun.spawn([process.execPath, import.meta.path, "--daemon"], {
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    stdin: new Blob([expected]),
    stdout: "ignore",
    stderr: "ignore",
  });
  process.stdout.write(String(child.pid));
  child.unref();
} else if (mode === "--daemon") {
  const expected = await Bun.stdin.text();
  // Exercise the actual daemon/provider/storage path after the launcher exits. Only the paid
  // HTTP transport is substituted, and every unrecognized outbound request fails closed.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token") {
        throw new Error("offline fixture refuses outbound request");
      }
      if (new Headers(init?.headers).get("Authorization") !== `Bearer ${expected}`) {
        return new Response(null, { status: 401 });
      }
      return Response.json({ access_token: "offline-detached-grant", expires_in: 60 });
    },
    { preconnect() {} },
  ) as typeof fetch;
  Bun.argv.splice(1, Bun.argv.length - 1, cli, "__daemon");
  await import(cli);
} else {
  assert.equal(process.platform, "linux", "this integration check requires Linux");
  assert.ok(
    process.env.DBUS_SESSION_BUS_ADDRESS,
    "start with dbus-run-session -- bun run scripts/linux-secret-service-smoke.ts",
  );
  const root = mkdtempSync(join(tmpdir(), "glosa-secret-service-"));
  const home = join(root, "glosa");
  const env = {
    ...credentialHelperEnv(process.env),
    HOME: root,
    XDG_RUNTIME_DIR: join(root, "run"),
    GLOSA_HOME: home,
    GLOSA_PORT: String(20000 + Math.floor(Math.random() * 20000)),
    GLOSA_LOG_LEVEL: "error",
    ANTHROPIC_API_KEY: undefined,
  };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const keyring = Bun.spawn(["/usr/bin/gnome-keyring-daemon", "--foreground", "--components=secrets", "--unlock"], {
    env,
    stdin: new Blob(["disposable-wallet-password\n"]),
    stdout: "ignore",
    stderr: "ignore",
  });
  const store = new LinuxSecretServiceCredentialStore({ env });
  const secret = `disposable-${crypto.randomUUID()}`;
  let daemonPid: number | undefined;
  const stages: string[] = [];
  async function child(flag: string, input?: string): Promise<string> {
    const proc = Bun.spawn([process.execPath, import.meta.path, flag, account], {
      env,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret), "child output contains no disposable secret");
    assert.equal(code, 0, `${flag} child exits successfully`);
    return stdout;
  }
  async function until(check: () => Promise<boolean>, message: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) return;
      await Bun.sleep(50);
    }
    throw new Error(message);
  }
  try {
    await until(async () => !(await store.has(account)), "Secret Service did not become ready");
    stages.push("service-ready");
    await child("--store", secret);
    assert.equal(await store.has(account), true);
    await child("--read", secret);
    stages.push("store-metadata-read");
    const token = crypto.randomUUID();
    writeFileSync(join(home, "token"), token, { mode: 0o600 });
    writeWisprFlowConfig(home, {
      version: 1,
      provider: "wispr-flow",
      enabled: true,
      consent_version: 1,
      consented_at: new Date().toISOString(),
      context_policy: "visible-prose",
      context_limit_bytes: 262144,
      client_id: crypto.randomUUID(),
      keychain_account: account,
      configured_at: new Date().toISOString(),
    });
    daemonPid = Number(await child("--parent", secret));
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 1, "parent reports owned child PID and exits");
    await until(async () => {
      const response = await fetch("http://localhost/api/dictation/status", {
        unix: join(home, "run/api.sock"),
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      const body = (await response.json()) as { state?: string };
      return response.ok && body.state === "ready";
    }, "detached daemon cannot reach credential metadata after parent exit");
    assert.equal(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8")).pid, daemonPid);
    stages.push("detached-daemon-status-after-parent-exit");
    const origin = `http://127.0.0.1:${env.GLOSA_PORT}`;
    const grant = await fetch(`${origin}/api/dictation/session`, {
      unix: join(home, "run/api.sock"),
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(grant.status, 200, "detached daemon reads the real credential without its launching parent");
    assert.equal(((await grant.json()) as { access_token?: string }).access_token, "offline-detached-grant");
    stages.push("detached-daemon-read-with-offline-token-transport");
    function checkFiles(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) checkFiles(path);
        else if (entry.isFile())
          assert.ok(!readFileSync(path).includes(Buffer.from(secret)), "no secret in Glosa files");
      }
    }
    checkFiles(home);
    assert.equal(await store.remove(account), true);
    assert.equal(await store.has(account), false);
    stages.push("delete-and-no-application-secret");
    // A real locked service, not an exit-code mock. This private keyring is owned by the run.
    await child("--store", secret);
    const lock = Bun.spawn(
      [
        "/usr/bin/busctl",
        "--user",
        "call",
        "org.freedesktop.secrets",
        "/org/freedesktop/secrets",
        "org.freedesktop.Secret.Service",
        "Lock",
        "ao",
        "1",
        "/org/freedesktop/secrets/collection/login",
      ],
      { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    assert.equal(await lock.exited, 0);
    await assert.rejects(store.has(account), { code: "locked" });
    await assert.rejects(store.read(account), { code: "locked" });
    stages.push("locked-does-not-prompt");
    process.stdout.write(
      `${JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version, stages, paidRequests: 0 })}\n`,
    );
  } finally {
    try {
      if (daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          /* already gone */
        }
        await until(async () => !existsSync(join(home, "run/api.sock")), "owned daemon did not shut down");
      }
    } finally {
      keyring.kill();
      await keyring.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }
}
