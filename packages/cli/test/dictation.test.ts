// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWisprFlowConfig, type WisprFlowCredentialStore } from "../../providers/wispr-flow/src/index.ts";
import { runDictation } from "../src/dictation.ts";

function store() {
  const values = new Set<string>();
  const api: WisprFlowCredentialStore & { values: Set<string> } = {
    values,
    has: async (account) => values.has(account),
    read: async (account) => (values.has(account) ? "secret" : null),
    addInteractive: async (account) => {
      values.add(account);
    },
    remove: async (account) => values.delete(account),
  };
  return api;
}

function testUuid(value: number): string {
  return `${String(value).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

describe("glosa dictation", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function home() {
    const value = mkdtempSync(join(tmpdir(), "glosa-cli-dictation-"));
    homes.push(value);
    return value;
  }

  test("configure is TTY-gated, records current consent, and never accepts a key argument", async () => {
    const credentials = store();
    const target = home();
    let ids = 0;
    const result = await runDictation(
      "configure",
      { provider: "wispr-flow" },
      {
        home: target,
        credentialStore: credentials,
        isTTY: () => true,
        confirm: async () => true,
        now: () => new Date("2026-09-21T10:00:00.000Z"),
        uuid: () => testUuid(++ids),
      },
    );
    expect(result).toMatchObject({ ok: true, data: { state: "ready", consent_version: 1 } });
    const config = readWisprFlowConfig(target);
    expect(config.state).toBe("configured");
    if (config.state === "configured") {
      expect(credentials.values.has(config.config.keychain_account)).toBe(true);
      expect(config.config).not.toHaveProperty("api_key");
    }
  });

  test("configure refuses noninteractive and JSON invocations before touching Keychain", async () => {
    const credentials = store();
    const target = home();
    const noninteractive = await runDictation(
      "configure",
      { provider: "wispr-flow" },
      {
        home: target,
        credentialStore: credentials,
        isTTY: () => false,
      },
    );
    expect(noninteractive.exitCode).toBe(2);
    expect(credentials.values.size).toBe(0);

    const json = await runDictation(
      "configure",
      { provider: "wispr-flow", json: true },
      {
        home: target,
        credentialStore: credentials,
        isTTY: () => true,
      },
    );
    expect(json.exitCode).toBe(2);
    expect(credentials.values.size).toBe(0);
  });

  test("a first-time configuration write failure removes the staged Keychain item", async () => {
    const credentials = store();
    const parent = home();
    const invalidHome = join(parent, "not-a-directory");
    writeFileSync(invalidHome, "occupied");
    let ids = 0;
    const result = await runDictation(
      "configure",
      { provider: "wispr-flow" },
      {
        home: invalidHome,
        credentialStore: credentials,
        isTTY: () => true,
        confirm: async () => true,
        uuid: () => testUuid(++ids),
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "dictation-configure-failed" } });
    expect(credentials.values.size).toBe(0);
  });

  test("an explicit source-checkout environment override avoids storing the development key", async () => {
    const credentials = store();
    const target = home();
    let ids = 0;
    const result = await runDictation(
      "configure",
      { provider: "wispr-flow" },
      {
        home: target,
        credentialStore: credentials,
        isTTY: () => true,
        confirm: async () => true,
        developmentCredentialAvailable: () => true,
        uuid: () => testUuid(++ids),
      },
    );
    expect(result).toMatchObject({ ok: true, data: { state: "ready" } });
    expect(credentials.values.size).toBe(0);
    expect(
      await runDictation(
        "status",
        {},
        {
          home: target,
          credentialStore: credentials,
          developmentCredentialAvailable: () => true,
        },
      ),
    ).toMatchObject({ ok: true, data: { state: "ready" } });
  });

  test("reconfiguration preserves the per-install Keychain account and provider client ID", async () => {
    const credentials = store();
    const target = home();
    let ids = 0;
    const deps = {
      home: target,
      credentialStore: credentials,
      isTTY: () => true,
      confirm: async () => true,
      uuid: () => testUuid(++ids),
    };
    await runDictation("configure", { provider: "wispr-flow" }, deps);
    const first = readWisprFlowConfig(target);
    await runDictation("configure", { provider: "wispr-flow" }, deps);
    const second = readWisprFlowConfig(target);
    expect(first.state).toBe("configured");
    expect(second.state).toBe("configured");
    if (first.state === "configured" && second.state === "configured") {
      expect(second.config.keychain_account).toBe(first.config.keychain_account);
      expect(second.config.client_id).toBe(first.config.client_id);
    }
    expect(ids).toBe(2);
  });

  test("status and disable are local-only; disable commits inactive before credential removal", async () => {
    const credentials = store();
    const target = home();
    let ids = 0;
    await runDictation(
      "configure",
      { provider: "wispr-flow" },
      {
        home: target,
        credentialStore: credentials,
        isTTY: () => true,
        confirm: async () => true,
        uuid: () => testUuid(++ids),
      },
    );
    expect(await runDictation("status", {}, { home: target, credentialStore: credentials })).toMatchObject({
      ok: true,
      data: { state: "ready" },
    });

    let disabledBeforeRemoval = false;
    const remove = credentials.remove;
    credentials.remove = async (account) => {
      const current = readWisprFlowConfig(target);
      disabledBeforeRemoval = current.state === "configured" && !current.config.enabled;
      return remove(account);
    };
    const disabled = await runDictation("disable", {}, { home: target, credentialStore: credentials });
    expect(disabled).toMatchObject({ ok: true, data: { state: "disabled" } });
    expect(disabledBeforeRemoval).toBe(true);
    const config = readWisprFlowConfig(target);
    expect(config.state === "configured" && config.config.enabled).toBe(false);
    expect(credentials.values.size).toBe(0);
  });
});
