// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationProviderError } from "@glosa/daemon";
import { createCredentialStore } from "../src/credentials.ts";
import { MacKeychainCredentialStore } from "../src/keychain.ts";
import {
  CredentialStoreError,
  credentialHelperEnv,
  LinuxSecretServiceCredentialStore,
  runCredentialHelper,
  type CredentialHelperRequest,
  type CredentialHelperResult,
} from "../src/secret-service.ts";
import {
  OpenAITranscriptionProvider,
  readOpenAIDictationConfig,
  openAIDictationConfigPath,
  writeOpenAIDictationConfig,
  type OpenAIDictationCredentialStore,
} from "../src/index.ts";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

describe("Linux Secret Service", () => {
  function fixture(results: CredentialHelperResult[]) {
    const calls: CredentialHelperRequest[] = [];
    const store = new LinuxSecretServiceCredentialStore({
      platform: "linux",
      executable: () => true,
      env: {
        HOME: "/fixture",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
        ANTHROPIC_API_KEY: "never-inherit",
        OPENAI_DICTATION_API_KEY: "never-inherit",
      },
      run: async (request) => {
        calls.push(request);
        return results.shift() ?? { code: 1, stdout: "", stderr: "unexpected call" };
      },
    });
    return { store, calls };
  }
  const present = {
    code: 0,
    stdout: JSON.stringify({ type: "aoao", data: [["/org/freedesktop/secrets/collection/test/item1"], []] }),
    stderr: "",
  };
  const absent = { code: 0, stdout: JSON.stringify({ type: "aoao", data: [[], []] }), stderr: "" };

  test("platform selection preserves macOS and selects secure Linux storage", () => {
    expect(createCredentialStore("darwin")).toBeInstanceOf(MacKeychainCredentialStore);
    expect(createCredentialStore("linux")).toBeInstanceOf(LinuxSecretServiceCredentialStore);
  });
  test("missing secure-store utilities fail before metadata access", async () => {
    let called = false;
    const store = new LinuxSecretServiceCredentialStore({
      platform: "linux",
      executable: (path) => !path.endsWith("secret-tool"),
      run: async () => {
        called = true;
        return present;
      },
    });
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "unavailable" });
    expect(called).toBe(false);
  });
  test("status reads metadata only and distinguishes missing from locked storage", async () => {
    const { store, calls } = fixture([
      present,
      absent,
      {
        ...present,
        stdout: JSON.stringify({ type: "aoao", data: [[], ["/org/freedesktop/secrets/collection/test/item1"]] }),
      },
    ]);
    expect(await store.has(ACCOUNT)).toBe(true);
    expect(await store.has(ACCOUNT)).toBe(false);
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "locked" });
    expect(
      calls.every(
        (call) => call.argv[0] === "/usr/bin/busctl" && call.argv.includes("SearchItems") && !call.interactive,
      ),
    ).toBe(true);
    expect(calls[0]!.env).toEqual({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      HOME: "/fixture",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
    });
  });
  test("foreground reads use a private non-unlocking search, never lookup", async () => {
    const { store, calls } = fixture([
      present,
      {
        code: 0,
        stdout: "[item1]\nlabel = Glosa OpenAI\nsecret = disposable-secret\ncreated = today\n",
        stderr: "",
      },
    ]);
    expect(await store.read(ACCOUNT)).toBe("disposable-secret");
    expect(calls[1]!.argv.slice(0, 2)).toEqual(["/usr/bin/secret-tool", "search"]);
    expect(calls[1]!.argv).not.toContain("--unlock");
    expect(JSON.stringify(calls)).not.toContain("disposable-secret");
    expect(calls[1]!.interactive).toBe(false);
  });
  test("a wallet locking between metadata and read fails without unlocking", async () => {
    const { store, calls } = fixture([
      present,
      { code: 0, stdout: "[item1]\nlabel = Glosa OpenAI\n", stderr: "IsLocked" },
    ]);
    await expect(store.read(ACCOUNT)).rejects.toMatchObject({ code: "locked" });
    expect(calls).toHaveLength(2);
  });
  test.each([
    ["AccessDenied secret-value", "denied"],
    ["Prompt dismissed secret-value", "cancelled"],
    ["ServiceUnknown secret-value", "unavailable"],
  ])("sanitizes helper failure %s as %s", async (stderr, code) => {
    const { store } = fixture([{ code: 1, stdout: "secret-value", stderr }]);
    try {
      await store.has(ACCOUNT);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain("secret-value");
    }
  });
  test("configuration pipes the secret privately while noninteractive removal never invokes a prompt", async () => {
    const { store, calls } = fixture([
      { code: 0, stdout: "", stderr: "" },
      present,
      { code: 0, stdout: JSON.stringify({ type: "o", data: ["/org/freedesktop/secrets/prompt/p1"] }), stderr: "" },
    ]);
    await store.write(ACCOUNT, "private-key");
    expect(calls[0]!.input).toBe("private-key");
    expect(calls[0]!.argv.join(" ")).not.toContain("private-key");
    expect(calls[0]!.interactive).toBe(false);
    expect(calls[0]!.argv).toContain("store");
    expect(await store.remove(ACCOUNT)).toBe(false);
    expect(calls.slice(1).every((call) => !call.interactive && !call.argv.includes("Prompt"))).toBe(true);
  });
  test("rejects malformed metadata and nonlocal bus addresses", async () => {
    const { store } = fixture([{ code: 0, stdout: "secret-value", stderr: "" }]);
    await expect(store.has(ACCOUNT)).rejects.toMatchObject({ code: "invalid" });
    expect(() => credentialHelperEnv({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=example.com" })).toThrow(
      CredentialStoreError,
    );
  });
  test("real helper execution bounds output, times out and handles already cancelled calls", async () => {
    const base = { env: credentialHelperEnv(process.env), interactive: false, timeoutMs: 1000 };
    await expect(
      runCredentialHelper({
        ...base,
        argv: [process.execPath, "-e", 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runCredentialHelper({ ...base, timeoutMs: 20, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      runCredentialHelper({ ...base, argv: ["/must/not/run"], signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(extra: Partial<ConstructorParameters<typeof OpenAITranscriptionProvider>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "glosa-openai-test-"));
  homes.push(home);
  const keys = new Map<string, string>();
  let reads = 0;
  const store: OpenAIDictationCredentialStore = {
    has: async (account) => keys.has(account),
    read: async (account) => {
      reads++;
      return keys.get(account) ?? null;
    },
    write: async (account, key) => {
      keys.set(account, key);
    },
    remove: async (account) => {
      keys.delete(account);
      return true;
    },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OpenAITranscriptionProvider({
    home,
    credentialStore: store,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ text: "Hello, cześć, hallo, hola." });
    }) as typeof fetch,
    ...extra,
  });
  const configure = async (cleanup = false) =>
    provider.update({
      revision: "unconfigured",
      consent_version: 1,
      enabled: true,
      context: true,
      cleanup,
      api_key: "private-key",
    });
  const audio = (revision: string) => ({
    audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]),
    mediaType: "audio/webm" as const,
    revision,
    signal: new AbortController().signal,
  });
  return { home, keys, store, provider, configure, calls, audio, reads: () => reads };
}
test("saving and status have no cloud calls or secret reads; config has only a secure reference", async () => {
  const f = fixture();
  const settings = await f.configure();
  expect(await f.provider.status()).toMatchObject({ state: "ready", cleanup: false });
  expect(f.calls).toHaveLength(0);
  expect(f.reads()).toBe(0);
  expect(settings).not.toHaveProperty("api_key");
  const path = openAIDictationConfigPath(f.home);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain("private-key");
  expect(f.keys.size).toBe(1);
});
test("SDK sends only consented audio/context to the fixed endpoint with no retry or language override", async () => {
  const f = fixture();
  const settings = await f.configure();
  expect(await f.provider.transcribe({ ...f.audio(settings.revision), context: "Visible names" })).toEqual({
    text: "Hello, cześć, hallo, hola.",
    cleanup: "off",
  });
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0]!;
  expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(call.init?.redirect).toBe("error");
  const form = await new Request(call.url, call.init).formData();
  expect(form.get("model")).toBe("gpt-transcribe");
  expect(form.get("prompt")).toBe("Visible names");
  expect(form.has("language")).toBe(false);
  expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer private-key");
});
test("a failed atomic config replacement preserves previous key and removes the candidate", async () => {
  const f = fixture();
  const before = await f.configure();
  const replacement = new OpenAITranscriptionProvider({
    home: f.home,
    credentialStore: f.store,
    writeConfig: () => {
      throw new Error("disk failure");
    },
  });
  await expect(replacement.update({ ...before, api_key: "new-secret" })).rejects.toBeInstanceOf(DictationProviderError);
  expect(f.keys.size).toBe(1);
  expect([...f.keys.values()]).toEqual(["private-key"]);
  expect(await f.provider.settings()).toEqual(before);
});
test("removal disables before a failed deletion and can be retried", async () => {
  const f = fixture();
  const before = await f.configure();
  const remove = f.store.remove;
  f.store.remove = async () => false;
  await expect(f.provider.remove(before.revision)).rejects.toMatchObject({ code: "credential-unavailable" });
  const disabled = await f.provider.settings();
  expect(disabled.enabled).toBe(false);
  expect(disabled.credential_present).toBe(true);
  f.store.remove = remove;
  expect((await f.provider.remove(disabled.revision)).credential_present).toBe(false);
});
test("stale settings, disabled context and oversized data are refused before reading the key", async () => {
  const f = fixture();
  const settings = await f.configure();
  const disabledContext = await f.provider.update({ ...settings, context: false });
  await expect(f.provider.transcribe(f.audio(settings.revision))).rejects.toMatchObject({ code: "stale-settings" });
  await expect(
    f.provider.transcribe({ ...f.audio(disabledContext.revision), context: "private prose" }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  await expect(
    f.provider.transcribe({ ...f.audio(disabledContext.revision), audio: new Uint8Array(12 * 1024 * 1024 + 1) }),
  ).rejects.toMatchObject({ code: "invalid-input" });
  expect(f.reads()).toBe(0);
  expect(f.calls).toHaveLength(0);
});
test.each(["failure", "empty", "incomplete", "success"])(
  "cleanup %s preserves raw fallback and sends store false",
  async (mode) => {
    const requests: RequestInit[] = [];
    const f = fixture({
      fetch: (async (_url, init) => {
        requests.push(init!);
        if (requests.length === 1) return Response.json({ text: "Cześć, no, hola." });
        if (mode === "failure")
          return Response.json({ error: { message: "private-key private prose" } }, { status: 500 });
        return Response.json({
          object: "response",
          status: mode === "incomplete" ? "incomplete" : "completed",
          output:
            mode === "empty"
              ? []
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Cześć, hola.", annotations: [] }],
                  },
                ],
        });
      }) as typeof fetch,
    });
    const settings = await f.configure(true);
    const result = await f.provider.transcribe(f.audio(settings.revision));
    expect(result).toEqual(
      mode === "success"
        ? { text: "Cześć, hola.", cleanup: "applied" }
        : { text: "Cześć, no, hola.", cleanup: "failed" },
    );
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]!.body))).toMatchObject({
      store: false,
      reasoning: { effort: "none" },
      max_output_tokens: 8192,
    });
  },
);
test.each([401, 403, 429, 500])("provider failure %i is sanitized and never retried", async (status) => {
  let count = 0;
  const f = fixture({
    fetch: (async (_url, _init) => {
      count++;
      return Response.json({ error: { message: "private-key private prose" } }, { status });
    }) as typeof fetch,
  });
  const settings = await f.configure();
  await expect(f.provider.transcribe(f.audio(settings.revision))).rejects.toBeInstanceOf(DictationProviderError);
  expect(count).toBe(1);
});
test("one processing request at a time, cancellation propagates and releases the lock", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const f = fixture({
    fetch: (async (_url, init) => {
      started.resolve(init!.signal!);
      return await new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new DOMException("abort", "AbortError"))),
      );
    }) as typeof fetch,
  });
  const settings = await f.configure();
  const abort = new AbortController();
  const pending = f.provider.transcribe({ ...f.audio(settings.revision), signal: abort.signal });
  const signal = await started.promise;
  await expect(f.provider.transcribe(f.audio(settings.revision))).rejects.toMatchObject({ code: "busy" });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(signal.aborted).toBe(true);
  await expect(f.provider.transcribe(f.audio("stale"))).rejects.toMatchObject({ code: "stale-settings" });
});
test("foreground settings change cancels an in-flight request", async () => {
  const started = Promise.withResolvers<void>();
  const f = fixture({
    fetch: (async (_url, init) => {
      started.resolve();
      return await new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new DOMException("abort", "AbortError"))),
      );
    }) as typeof fetch,
  });
  const settings = await f.configure();
  const pending = f.provider.transcribe(f.audio(settings.revision));
  const settled = pending.catch((error) => error);
  await started.promise;
  await f.provider.update({ ...settings, enabled: false });
  expect(await settled).toMatchObject({ code: "cancelled" });
  expect(readOpenAIDictationConfig(f.home)?.enabled).toBe(false);
});

test("a locked wallet keeps settings editable and removal disables before secure-store failure", async () => {
  const f = fixture();
  const before = await f.configure();
  const has = f.store.has,
    remove = f.store.remove;
  f.store.has = async () => {
    throw new CredentialStoreError("locked");
  };
  f.store.remove = async () => {
    throw new CredentialStoreError("locked");
  };
  const locked = await f.provider.settings();
  expect(locked).toMatchObject({ enabled: true, revision: before.revision, credential_present: false });
  expect(locked.credential_error).toContain("Unlock");
  expect((await f.provider.status()).state).toBe("error");
  await expect(f.provider.remove(locked.revision)).rejects.toMatchObject({ code: "credential-unavailable" });
  const disabled = await f.provider.settings();
  expect(disabled.enabled).toBe(false);
  f.store.has = has;
  f.store.remove = remove;
  expect((await f.provider.remove(disabled.revision)).credential_present).toBe(false);
  expect(f.calls).toHaveLength(0);
  expect(f.reads()).toBe(0);
});
test("transcription deadline aborts its SDK request and returns a safe timeout", async () => {
  let requestSignal: AbortSignal | undefined;
  const f = fixture({
    transcriptionTimeout: 20,
    fetch: (async (_url, init) => {
      requestSignal = init!.signal!;
      return await new Promise((_resolve, reject) =>
        requestSignal!.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true }),
      );
    }) as typeof fetch,
  });
  const settings = await f.configure();
  const pending = f.provider.transcribe(f.audio(settings.revision)).catch((error) => error);
  try {
    // The real SDK deadline is the behavior under observation. A separate bound gives an ablation a named red.
    const result = await Promise.race([pending, Bun.sleep(300).then(() => ({ code: "missing-timeout" }))]);
    expect(result).toMatchObject({ code: "timeout" });
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    f.provider.dispose();
    await pending;
  }
});
