// SPDX-License-Identifier: Apache-2.0
// Integration coverage for realUpdateDeps. The registry is a loopback-only HTTPS fixture; the
// installer and post-install probe stay injected so this test never invokes a package manager or
// reaches the external network.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realUpdateDeps, runUpdate, type UpdateDeps } from "../src/update.ts";

test("realUpdateDeps fetches and verifies a local release with static requests and safe install wiring", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "glosa-update-registry-"));
  const keyPath = join(fixtureDir, "key.pem");
  const certPath = join(fixtureDir, "cert.pem");
  const openssl = Bun.spawnSync({
    cmd: [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(openssl.success, openssl.stderr.toString("utf8")).toBe(true);

  const targetVersion = "0.1.0-alpha.9";
  const tarballBytes = Buffer.from("local verified tarball fixture", "utf8");
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const requests: Array<{ path: string; headers: Headers }> = [];
  let registryOrigin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, headers: new Headers(request.headers) });
      if (url.pathname === "/@davebream/glosa") {
        return Response.json({
          "dist-tags": { alpha: targetVersion, latest: targetVersion },
          versions: {
            [targetVersion]: {
              version: targetVersion,
              dist: {
                integrity,
                tarball: `${registryOrigin}/@davebream/glosa/-/glosa-${targetVersion}.tgz`,
              },
            },
          },
        });
      }
      if (url.pathname === `/@davebream/glosa/-/glosa-${targetVersion}.tgz`) {
        return new Response(tarballBytes);
      }
      return new Response("not found", { status: 404 });
    },
  });
  registryOrigin = `https://127.0.0.1:${server.port}`;

  const previousTls = Bun.env.NODE_TLS_REJECT_UNAUTHORIZED;
  Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const real = realUpdateDeps();
  const spawned: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
  let downloadedPath: string | undefined;
  const packageRoot = join(fixtureDir, "install", "global", "node_modules", "@davebream", "glosa");
  const deps: UpdateDeps = {
    ...real,
    platform: () => "darwin",
    packageRoot: () => packageRoot,
    pathExists: () => false,
    isWritable: () => true,
    env: () => undefined,
    envAll: () => ({ PATH: "/fixture/bin", ANTHROPIC_API_KEY: "must-be-scrubbed" }),
    currentVersion: () => "0.1.0-alpha.8",
    which: (command) => (command === "bun" ? "/fixture/bin/bun" : command === "glosa" ? "/fixture/bin/glosa" : null),
    runVersionProbe: () => `glosa ${targetVersion}`,
    readDaemonLock: () => null,
    spawnInstaller: async (argv, env) => {
      spawned.push({ argv, env });
      if (argv.includes("add")) {
        downloadedPath = argv.at(-1);
        expect(downloadedPath).toBeDefined();
        expect(downloadedPath && readFileSync(downloadedPath)).toEqual(tarballBytes);
      }
      return { exitCode: 0 };
    },
    writeStdout: () => {},
    writeStderr: () => {},
    flushStdout: async () => {},
  };

  try {
    expect(real.platform()).toBe(process.platform);
    expect(realpathSync(real.packageRoot())).toBe(realpathSync(resolve(import.meta.dir, "../../..")));

    const result = await runUpdate({ registry: registryOrigin }, deps);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      action: "updated",
      target_version: targetVersion,
      integrity_verified: true,
      installer_exit_code: 0,
      probe: { reported_version: targetVersion, matched: true },
    });
    expect(requests.map((request) => request.path)).toEqual([
      "/@davebream/glosa",
      `/@davebream/glosa/-/glosa-${targetVersion}.tgz`,
    ]);
    for (const request of requests) {
      expect(request.headers.get("user-agent")).toBe("glosa-update");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
      expect([...request.headers.values()].join(" ")).not.toContain("0.1.0-alpha.8");
    }
    expect(requests[0]?.headers.get("accept")).toBe("application/vnd.npm.install-v1+json");

    expect(downloadedPath).toBeDefined();
    const installedTarball = downloadedPath as string;
    expect(spawned.map(({ argv }) => argv)).toEqual([
      ["/fixture/bin/bun", "remove", "--global", "@davebream/glosa"],
      ["/fixture/bin/bun", "add", "--global", "--", installedTarball],
    ]);
    expect(installedTarball.startsWith("/")).toBe(true);
    expect(existsSync(installedTarball)).toBe(false);
    expect(spawned[1]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned[1]?.env.BUN_INSTALL_GLOBAL_DIR).toBe(join(fixtureDir, "install", "global"));
  } finally {
    server.stop(true);
    if (previousTls === undefined) delete Bun.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
