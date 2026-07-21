// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, BUILD_ID, computeBuildId, parseBuildId, runtimeSourceFiles } from "../src/build-id.ts";
import { daemonPeerMismatchReason, decideDaemonBuild } from "../src/lifecycle.ts";
import type { DaemonLock } from "../src/lock.ts";
import type { HandshakeResponse } from "../src/handshake.ts";

const roots: string[] = [];

function fixtureRoot(files: Array<[string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "glosa-build-id-"));
  roots.push(root);
  for (const directory of [
    "packages/daemon/src",
    "packages/cli/src",
    "packages/spa/src",
    "packages/providers/example/src",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const [path, content] of files) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("build identity", () => {
  test("is deterministic across creation order and sorts repository-relative paths", () => {
    const files: Array<[string, string]> = [
      ["packages/daemon/src/z.ts", "daemon"],
      ["packages/cli/src/a.ts", "cli"],
      ["packages/spa/src/shell.html", "spa"],
      ["packages/providers/example/src/provider.ts", "provider"],
    ];
    const first = fixtureRoot(files);
    const second = fixtureRoot([...files].reverse());

    expect(computeBuildId(first, "1.2.3")).toBe(computeBuildId(second, "1.2.3"));
    expect(runtimeSourceFiles(first).map((path) => path.slice(first.length + 1))).toEqual(
      [...files.map(([path]) => path)].sort((a, b) => a.localeCompare(b, "en")),
    );
  });

  test("changes for content, path, and package-version changes", () => {
    const first = fixtureRoot([["packages/daemon/src/a.ts", "one"]]);
    const second = fixtureRoot([["packages/daemon/src/a.ts", "two"]]);
    const third = fixtureRoot([["packages/daemon/src/b.ts", "one"]]);

    const base = computeBuildId(first, "1.0.0");
    expect(computeBuildId(second, "1.0.0")).not.toBe(base);
    expect(computeBuildId(third, "1.0.0")).not.toBe(base);
    expect(computeBuildId(first, "1.0.1")).not.toBe(base);
  });

  test("uses the canonical app version and rejects malformed identities", () => {
    expect(parseBuildId(BUILD_ID)?.version).toBe(APP_VERSION);
    expect(parseBuildId(BUILD_ID)?.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    for (const malformed of ["", "1.0.0", "1.0.0-nope", "x-0000000000000000", "1.0.0-ABCDEF0000000000"]) {
      expect(parseBuildId(malformed)).toBeNull();
    }
  });
});

describe("daemon build decision", () => {
  const hashA = "0000000000000000";
  const hashB = "1111111111111111";

  test("restarts legacy, lower-semver, and same-semver-different builds", () => {
    expect(decideDaemonBuild(`1.0.0-${hashA}`, undefined, "1.0")).toEqual({ action: "restart", reason: "legacy" });
    expect(decideDaemonBuild(`2.0.0-${hashA}`, `1.0.0-${hashB}`, "99.0")).toEqual({
      action: "restart",
      reason: "newer-client",
    });
    expect(decideDaemonBuild(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0")).toEqual({
      action: "restart",
      reason: "same-version-different-build",
    });
    expect(decideDaemonBuild(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "99.0")).toEqual({
      action: "restart",
      reason: "same-version-different-build",
    });
  });

  test("uses a newer compatible daemon and rejects a newer incompatible daemon", () => {
    expect(decideDaemonBuild(`1.0.0-${hashA}`, `2.0.0-${hashB}`, "1.0")).toEqual({ action: "use" });
    const incompatible = decideDaemonBuild(`1.0.0-${hashA}`, `2.0.0-${hashB}`, "99.0");
    expect(incompatible.action).toBe("fail");
    if (incompatible.action === "fail") expect(incompatible.reason).toContain("incompatible glosa versions installed");
  });

  test("uses an identical compatible build and fails closed on malformed identities", () => {
    expect(decideDaemonBuild(`1.0.0-${hashA}`, `1.0.0-${hashA}`, "1.0")).toEqual({ action: "use" });
    expect(decideDaemonBuild(`1.0.0-${hashA}`, `1.0.0-${hashA}`, "99.0").action).toBe("fail");
    expect(decideDaemonBuild(`1.0.0-${hashA}`, "malformed", "1.0").action).toBe("fail");
    expect(decideDaemonBuild("malformed", `1.0.0-${hashA}`, "1.0").action).toBe("fail");
  });

  test("requires lock and handshake identity, PID, instance, and protocol to agree", () => {
    const lock: DaemonLock = {
      instance_id: "gl-1",
      pid: 42,
      port: 4646,
      protocol_version: "1.0",
      build_id: `1.0.0-${hashA}`,
      started_at: "2026-07-21T00:00:00.000Z",
      host: "127.0.0.1",
      bun: Bun.version,
    };
    const handshake: HandshakeResponse = {
      protocol_version: lock.protocol_version,
      build_id: lock.build_id,
      instance_id: lock.instance_id,
      pid: lock.pid,
      started_at: lock.started_at,
    };
    expect(daemonPeerMismatchReason(lock, handshake)).toBeNull();
    expect(daemonPeerMismatchReason(lock, { ...handshake, instance_id: "gl-2" })).toContain("different processes");
    expect(daemonPeerMismatchReason(lock, { ...handshake, pid: 43 })).toContain("different processes");
    expect(daemonPeerMismatchReason(lock, { ...handshake, protocol_version: "1.1" })).toContain("protocol");
    expect(daemonPeerMismatchReason(lock, { ...handshake, build_id: `1.0.0-${hashB}` })).toContain("build");
    expect(daemonPeerMismatchReason({ ...lock, build_id: undefined }, handshake)).toContain("build");
  });
});
