// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, BUILD_ID, computeBuildId, parseBuildId, runtimeSourceFiles } from "../src/lifecycle/build-id.ts";
import { daemonPeerMismatchReason, decideDaemonBuild } from "../src/lifecycle/daemon.ts";
import type { HandshakeResponse } from "../src/lifecycle/handshake.ts";
import type { DaemonLock } from "../src/lifecycle/lock.ts";

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

  const mine = "aaaaaaaaaaaaaaaa";
  const theirs = "bbbbbbbbbbbbbbbb";

  /** One decider per daemon identity. Three named helpers rather than an optional parameter,
   * because a defaulted parameter cannot express "explicitly unknown" — passing `undefined` would
   * silently select the default, which is the exact confusion this rule exists to prevent. */
  const decideAgainst =
    (daemonInstallId: string | undefined) =>
    (clientBuildId: string, daemonBuildId: string | undefined, daemonProtocol: string) =>
      decideDaemonBuild({ clientBuildId, clientInstallId: mine, daemonBuildId, daemonInstallId, daemonProtocol });

  const decide = decideAgainst(mine);
  const decideForeign = decideAgainst(theirs);
  const decideUnknown = decideAgainst(undefined);

  test("restarts legacy, lower-semver, and same-semver-different builds from its OWN install", () => {
    expect(decide(`1.0.0-${hashA}`, undefined, "1.0")).toEqual({ action: "restart", reason: "legacy" });
    expect(decide(`2.0.0-${hashA}`, `1.0.0-${hashB}`, "99.0")).toEqual({
      action: "restart",
      reason: "newer-client",
    });
    expect(decide(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0")).toEqual({
      action: "restart",
      reason: "same-version-different-build",
    });
    expect(decide(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "99.0")).toEqual({
      action: "restart",
      reason: "same-version-different-build",
    });
  });

  test("never stops a daemon another install started", () => {
    // The storm this rule ends: a checkout and a release install of the same version each see the
    // other as "different build" and SIGTERM it, forever.
    const sameVersion = decideForeign(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0");
    expect(sameVersion.action).toBe("fail");
    if (sameVersion.action === "fail") {
      expect(sameVersion.foreignInstall).toBe(true);
      expect(sameVersion.reason).toContain("different glosa install");
    }
    // An upgrade is not exempt: the logs show cross-install kills under `newer-client` too.
    const upgrade = decideForeign(`2.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0");
    expect(upgrade.action).toBe("fail");
    if (upgrade.action === "fail") expect(upgrade.foreignInstall).toBe(true);
  });

  test("an unknown install id is not 'mine' at equal versions, but does not block an upgrade", () => {
    // Equal version + different bytes is ambiguous (own edit, or a second install sharing a home),
    // so it needs PROOF of ownership and an absent id must resolve to the safe answer.
    const ambiguous = decideUnknown(`1.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0");
    expect(ambiguous.action).toBe("fail");
    if (ambiguous.action === "fail") expect(ambiguous.foreignInstall).toBe(true);

    // A strictly newer client replacing a daemon that predates install identity is the documented
    // upgrade path. Refusing here would break every user's upgrade exactly once.
    expect(decideUnknown(`2.0.0-${hashA}`, `1.0.0-${hashB}`, "1.0")).toEqual({
      action: "restart",
      reason: "newer-client",
    });
  });

  test("uses a newer compatible daemon and rejects a newer incompatible daemon", () => {
    expect(decide(`1.0.0-${hashA}`, `2.0.0-${hashB}`, "1.0")).toEqual({ action: "use" });
    // An older client never stops anything, so a foreign install changes nothing here.
    expect(decideForeign(`1.0.0-${hashA}`, `2.0.0-${hashB}`, "1.0")).toEqual({ action: "use" });
    const incompatible = decide(`1.0.0-${hashA}`, `2.0.0-${hashB}`, "99.0");
    expect(incompatible.action).toBe("fail");
    if (incompatible.action === "fail") expect(incompatible.reason).toContain("incompatible glosa versions installed");
  });

  test("uses an identical compatible build and fails closed on malformed identities", () => {
    expect(decide(`1.0.0-${hashA}`, `1.0.0-${hashA}`, "1.0")).toEqual({ action: "use" });
    // Identical bytes means one install by construction; identity is not consulted.
    expect(decideForeign(`1.0.0-${hashA}`, `1.0.0-${hashA}`, "1.0")).toEqual({ action: "use" });
    expect(decide(`1.0.0-${hashA}`, `1.0.0-${hashA}`, "99.0").action).toBe("fail");
    expect(decide(`1.0.0-${hashA}`, "malformed", "1.0").action).toBe("fail");
    expect(decide("malformed", `1.0.0-${hashA}`, "1.0").action).toBe("fail");
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

  test("install identity must agree between lock and handshake, and absent-on-both is agreement", () => {
    // Lock and handshake are written by the same process, so a one-sided value is a genuine
    // disagreement — the rule build_id already follows.
    const lock: DaemonLock = {
      instance_id: "gl-1",
      pid: 42,
      port: 4646,
      protocol_version: "1.0",
      build_id: `1.0.0-${hashA}`,
      install_id: mine,
      started_at: "2026-07-21T00:00:00.000Z",
      host: "127.0.0.1",
      bun: Bun.version,
    };
    const handshake: HandshakeResponse = {
      protocol_version: lock.protocol_version,
      build_id: lock.build_id,
      install_id: lock.install_id,
      instance_id: lock.instance_id,
      pid: lock.pid,
      started_at: lock.started_at,
    };
    expect(daemonPeerMismatchReason(lock, handshake)).toBeNull();
    expect(daemonPeerMismatchReason(lock, { ...handshake, install_id: theirs })).toContain("install");
    expect(daemonPeerMismatchReason(lock, { ...handshake, install_id: undefined })).toContain("install");
    expect(daemonPeerMismatchReason({ ...lock, install_id: undefined }, handshake)).toContain("install");
    // A peer that predates install identity entirely still reconciles.
    expect(
      daemonPeerMismatchReason({ ...lock, install_id: undefined }, { ...handshake, install_id: undefined }),
    ).toBeNull();
  });
});
