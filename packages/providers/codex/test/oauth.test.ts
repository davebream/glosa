// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedOAuthBegin } from "../../../daemon/src/agents/oauth-interface.ts";
import { CodexChatGptOAuthBroker, CHATGPT_SCOPES } from "../src/oauth/index.ts";
import type { SecureCredentialStore } from "../../shared-credentials/src/index.ts";
import { MacKeychainCredentialStore } from "../../shared-credentials/src/keychain.ts";
import { OAuthMetadataStore } from "../src/oauth/storage.ts";
import type { CredentialHelperRequest } from "../../shared-credentials/src/secret-service.ts";

// The fixture signs real JWTs and exercises openid-client's production signature validation.
// HTTPS vendor endpoints are simulated; only the production callback listener uses real HTTP.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const metadata = {
  issuer: "https://auth.openai.com",
  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
  jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
  revocation_endpoint: "https://auth.openai.com/oauth/revoke",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(options: { discovery?: boolean; timeoutMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "glosa-chatgpt-oauth-"));
  const metadataPath = join(home, "oauth.json");
  const vault = new Map<string, string>();
  const requests: Array<{ url: string; form: URLSearchParams; headers: Headers }> = [];
  const authorizations = new Map<
    string,
    { nonce: string; clientId: string; verifierChallenge: string; redirectUri: string }
  >();
  let now = Date.now();
  let reads = 0;
  let writes = 0;
  let refreshes = 0;
  let claimsOverride: Record<string, unknown> = {};
  let corruptSignature = false;
  let scope = CHATGPT_SCOPES;
  let refreshError: string | undefined;
  let networkFailure = false;
  let revocationFailure = false;
  let walletLocked = false;
  let tokenGate: Promise<void> | undefined;
  let writeGate: Promise<void> | undefined;
  let writeStarted: (() => void) | undefined;
  const store: SecureCredentialStore = {
    has: async (id) => vault.has(id),
    read: async (id) => {
      reads++;
      if (walletLocked) throw new Error("wallet locked secret-leak");
      return vault.get(id) ?? null;
    },
    write: async (id, value) => {
      writes++;
      writeStarted?.();
      if (writeGate) await writeGate;
      if (walletLocked) throw new Error("wallet locked secret-leak");
      vault.set(id, value);
    },
    remove: async (id) => {
      if (walletLocked) return false;
      vault.delete(id);
      return true;
    },
  };
  const fetchMock = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const form = new URLSearchParams(String(init.body ?? ""));
    requests.push({ url, form, headers: new Headers(init.headers) });
    if (networkFailure) throw new Error("offline secret-leak");
    if (url.endsWith("openid-configuration")) return Response.json(metadata);
    if (url.endsWith("jwks.json"))
      return Response.json({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" }],
      });
    if (url.endsWith("revoke"))
      return revocationFailure ? new Response("secret-leak", { status: 503 }) : new Response(null, { status: 200 });
    if (url !== metadata.token_endpoint) throw new Error("unexpected fixture endpoint");
    if (tokenGate) await tokenGate;
    const refresh = form.get("grant_type") === "refresh_token";
    if (refresh) {
      refreshes++;
      if (refreshError)
        return Response.json({ error: refreshError, error_description: "secret-leak" }, { status: 400 });
    }
    const entry = refresh ? undefined : authorizations.get(form.get("code") ?? "");
    if (!refresh) {
      if (
        !entry ||
        form.get("redirect_uri") !== entry.redirectUri ||
        form.get("client_id") !== entry.clientId ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== entry.verifierChallenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const claims = {
      iss: metadata.issuer,
      aud: form.get("client_id"),
      sub: "subject-one",
      email: "writer@example.test",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(refresh ? {} : { nonce: entry!.nonce }),
      ...claimsOverride,
    };
    const encoded = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const idToken = `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), corruptSignature ? otherKey : privateKey).toString("base64url")}`;
    return Response.json({
      access_token: refresh ? `private-access-${refreshes}` : "private-access-initial",
      refresh_token: refresh ? `private-refresh-${refreshes}` : "private-refresh-initial",
      id_token: idToken,
      token_type: "Bearer",
      scope,
      expires_in: 3600,
    });
  }) as typeof fetch;
  const brokerOptions = {
    metadataPath,
    credentialStore: store,
    fetch: fetchMock,
    ...(options.discovery ? {} : { issuerMetadata: metadata }),
    now: () => now,
    attemptTimeoutMs: options.timeoutMs,
  };
  const broker = new CodexChatGptOAuthBroker(brokerOptions);
  cleanups.push(async () => {
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });
  async function callback(attempt: ManagedOAuthBegin, changes: Record<string, string | null> = {}) {
    const authorize = new URL(attempt.authorizationUrl);
    const uri = authorize.searchParams.get("redirect_uri")!;
    const clientId =
      authorize.searchParams.get("client_id") === "dynamic_agent_client"
        ? `oaiapp_${attempt.accountId.replaceAll("-", "")}`
        : authorize.searchParams.get("client_id")!;
    const code = `fixture-${attempt.attemptId}`;
    authorizations.set(code, {
      nonce: authorize.searchParams.get("nonce")!,
      clientId,
      verifierChallenge: authorize.searchParams.get("code_challenge")!,
      redirectUri: uri,
    });
    const url = new URL(uri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", authorize.searchParams.get("state")!);
    url.searchParams.set("client_id", clientId);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    return fetch(url);
  }
  async function terminal(attempt: ManagedOAuthBegin) {
    const deadline = Date.now() + 2500;
    for (;;) {
      const view = broker.status(attempt.attemptId);
      if (!["pending", "exchanging"].includes(view.status)) return view;
      if (Date.now() > deadline) throw new Error(`OAuth fixture did not finish: ${view.status}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  async function login() {
    const attempt = await broker.begin();
    expect((await callback(attempt)).status).toBe(200);
    const view = await terminal(attempt);
    expect(view.status).toBe("succeeded");
    return view.account!;
  }
  return {
    broker,
    brokerOptions,
    home,
    metadataPath,
    vault,
    requests,
    store,
    secret: (accountId: string) => vault.get(JSON.parse(readFileSync(metadataPath, "utf8")).credentialRefs[accountId]),
    callback,
    terminal,
    login,
    counts: () => ({ reads, writes, refreshes }),
    advance: (ms: number) => {
      now += ms;
    },
    claims: (value: Record<string, unknown>) => {
      claimsOverride = value;
    },
    corruptSignature: () => {
      corruptSignature = true;
    },
    setScope: (value: string) => {
      scope = value;
    },
    refreshError: (value: string | undefined) => {
      refreshError = value;
    },
    network: (fail: boolean) => {
      networkFailure = fail;
    },
    revocationFailure: () => {
      revocationFailure = true;
    },
    lockWallet: (locked: boolean) => {
      walletLocked = locked;
    },
    gateToken: (gate: Promise<void> | undefined) => {
      tokenGate = gate;
    },
    gateWrite: (gate: Promise<void> | undefined, started?: () => void) => {
      writeGate = gate;
      writeStarted = started;
    },
  };
}

test("construction and account listing perform no credential reads or external calls; first foreground authorization binds host, PKCE and exact callback", async () => {
  const f = fixture({ discovery: true });
  expect(f.broker.listAccounts()).toEqual([]);
  expect(f.requests).toHaveLength(0);
  expect(f.counts().reads).toBe(0);
  const attempt = await f.broker.begin();
  const url = new URL(attempt.authorizationUrl);
  expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
  expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(url.searchParams.get("agent_name_hint")).toBe("Glosa");
  expect(url.searchParams.get("scope")).toBe(CHATGPT_SCOPES);
  expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
  expect(url.searchParams.get("nonce")).not.toBe(url.searchParams.get("state"));
  expect(new URL(url.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
  expect(new URL(url.searchParams.get("redirect_uri")!).pathname).toBe("/auth/callback");
  const response = await f.callback(attempt);
  expect(await response.text()).not.toContain("private-");
  const view = await f.terminal(attempt);
  expect(view.status).toBe("succeeded");
  expect(f.requests.every((request) => request.headers.get("user-agent") === "glosa")).toBe(true);
  expect(f.requests.find((request) => request.url === metadata.token_endpoint)!.form.get("client_secret")).toBeNull();
  const lease = await f.broker.lease(attempt.accountId);
  expect(lease.accessToken).toBe("private-access-initial");
  const persisted = readFileSync(f.metadataPath, "utf8");
  expect(persisted).not.toContain("private-");
  expect(persisted).not.toContain("idToken");
  expect(statSync(f.metadataPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.home).sort()).toEqual(
    ["oauth.json", "oauth.json.metadata.lock", `oauth.json.${attempt.accountId}.lock`].sort(),
  );
  expect(JSON.stringify(f.broker.listAccounts())).not.toContain(lease.accessToken);
});

test("wrong state, duplicate state, wrong callback path and cross-origin requests never exchange a code", async () => {
  const f = fixture();
  const attempt = await f.broker.begin();
  const url = new URL(attempt.authorizationUrl);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  expect((await f.callback(attempt, { state: "wrong-state" })).status).toBe(400);
  callback.pathname = "/callback";
  expect((await fetch(callback)).status).toBe(400);
  callback.pathname = "/auth/callback";
  callback.search = `state=${url.searchParams.get("state")}&state=${url.searchParams.get("state")}`;
  expect((await fetch(callback)).status).toBe(400);
  expect((await fetch(callback, { headers: { origin: "https://attacker.test" } })).status).toBe(400);
  expect(f.requests).toHaveLength(0);
  expect(f.broker.status(attempt.attemptId).status).toBe("pending");
  await f.broker.cancel(attempt.attemptId);
  expect(f.broker.status(attempt.attemptId).status).toBe("cancelled");
  await expect(fetch(new URL(url.searchParams.get("redirect_uri")!))).rejects.toThrow();
});

test.each(["signature", "nonce", "issuer", "audience", "expiry", "subject"])(
  "invalid %s prevents any saved account or credential",
  async (guard) => {
    const f = fixture();
    const attempt = await f.broker.begin();
    if (guard === "signature") f.corruptSignature();
    if (guard === "nonce") f.claims({ nonce: "wrong" });
    if (guard === "issuer") f.claims({ iss: "https://attacker.test" });
    if (guard === "audience") f.claims({ aud: "oaiapp_other" });
    if (guard === "expiry") f.claims({ exp: 1 });
    if (guard === "subject") f.claims({ sub: "" });
    await f.callback(attempt);
    const result = await f.terminal(attempt);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("invalid-response");
    expect(f.broker.listAccounts()).toEqual([]);
    expect(f.vault.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private-");
  },
);

test("a new callback must supply an issued client ID; denial checks state and makes no token request", async () => {
  const f = fixture();
  const first = await f.broker.begin();
  await f.callback(first, { client_id: null });
  expect((await f.terminal(first)).error).toBe("invalid-response");
  const second = await f.broker.begin();
  await f.callback(second, { client_id: "dynamic_agent_client" });
  expect((await f.terminal(second)).error).toBe("invalid-response");
  const third = await f.broker.begin();
  await f.callback(third, { error: "access_denied", code: null });
  expect((await f.terminal(third)).error).toBe("access-denied");
  expect(f.requests).toHaveLength(0);
});

test("same email registrations remain separate; returning sign-in preserves host and issued client and rejects changed identity", async () => {
  const f = fixture();
  const first = await f.login();
  const second = await f.login();
  expect(first.email).toBe(second.email);
  expect(first.accountId).not.toBe(second.accountId);
  expect(first.clientId).not.toBe(second.clientId);
  expect(f.vault.size).toBe(2);
  const initialFirst = f.secret(first.accountId);
  const returning = await f.broker.begin({ accountId: first.accountId });
  const url = new URL(returning.authorizationUrl);
  expect(url.searchParams.get("client_id")).toBe(first.clientId);
  expect(url.searchParams.has("agent_name_hint")).toBe(false);
  expect(url.searchParams.has("id_token_hint")).toBe(false);
  expect(url.searchParams.get("ext_agent_host_id")).toBe(JSON.parse(readFileSync(f.metadataPath, "utf8")).hostId);
  f.claims({ sub: "other-subject" });
  await f.callback(returning);
  expect((await f.terminal(returning)).error).toBe("identity-mismatch");
  expect(f.secret(first.accountId)).toBe(initialFirst);
  expect(f.broker.getAccount(first.accountId)).toEqual(first);
  const changed = await f.broker.begin({ accountId: first.accountId });
  await f.callback(changed, { client_id: second.clientId });
  expect((await f.terminal(changed)).error).toBe("invalid-response");
  f.claims({});
  const valid = await f.broker.begin({ accountId: first.accountId });
  await f.callback(valid, { client_id: null });
  expect((await f.terminal(valid)).status).toBe("succeeded");
});

test("a valid identity without direct plan scope stays signed in and cannot lease a token", async () => {
  const f = fixture();
  f.setScope("openid profile email offline_access");
  const account = await f.login();
  expect(account.status).toBe("signed-in");
  expect(account.planEnabled).toBe(false);
  const reads = f.counts().reads;
  await expect(f.broker.lease(account.accountId)).rejects.toMatchObject({ code: "plan-disabled" });
  expect(f.counts().reads).toBe(reads);
  const reconsent = await f.broker.begin({ accountId: account.accountId, requestPlanConsent: true });
  const url = new URL(reconsent.authorizationUrl);
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
});

test("concurrent foreground leases across broker instances rotate once and persist the whole token record", async () => {
  const f = fixture();
  const account = await f.login();
  f.advance(3600_000);
  const other = new CodexChatGptOAuthBroker(f.brokerOptions);
  cleanups.push(() => other.close());
  const leases = await Promise.all([f.broker.lease(account.accountId), other.lease(account.accountId)]);
  expect(f.counts().refreshes).toBe(1);
  expect(leases[0]).toEqual(leases[1]);
  expect(leases[0]!.credentialVersion).not.toBe(account.credentialVersion);
  const saved = JSON.parse(f.secret(account.accountId)!);
  expect(saved.refreshToken).toBe("private-refresh-1");
  expect(saved.accessToken).toBe("private-access-1");
  expect(saved.credentialVersion).toBe(leases[0]!.credentialVersion);
  const refresh = f.requests.find((request) => request.form.get("grant_type") === "refresh_token")!;
  expect(refresh.form.get("client_id")).toBe(account.clientId);
  expect(refresh.form.get("resource")).toBe("https://api.openai.com/v1");
  expect(refresh.form.has("scope")).toBe(false);
});

test("cancellation after a refresh response commits the rotated credential but releases no token lease", async () => {
  const f = fixture(),
    account = await f.login();
  const before = JSON.parse(f.secret(account.accountId)!);
  const abort = new AbortController(),
    write = f.store.write.bind(f.store);
  f.store.write = async (id, value, signal) => {
    // This is the actual boundary after openid-client validated the signed refresh response.
    // Secure helpers honor abort before starting, so passing the foreground signal here loses
    // the replacement after the server has consumed the previous refresh token.
    abort.abort();
    signal?.throwIfAborted();
    await write(id, value, signal);
  };
  f.advance(3600_000);
  let rejected: unknown;
  try {
    await f.broker.lease(account.accountId, { signal: abort.signal });
  } catch (error) {
    rejected = error;
  } finally {
    f.store.write = write;
  }
  const stored = JSON.parse(f.secret(account.accountId)!);
  expect(stored.credentialVersion).not.toBe(before.credentialVersion);
  expect(stored.refreshToken).toBe("private-refresh-1");
  expect(f.broker.getAccount(account.accountId)?.credentialVersion).toBe(stored.credentialVersion);
  expect(rejected).toMatchObject({ code: "cancelled" });
  expect((await f.broker.lease(account.accountId)).accessToken).toBe("private-access-1");
  expect(f.counts().refreshes).toBe(1);
});

test("temporary refresh failures preserve credentials; confirmed invalidation clears them and retains registration", async () => {
  const f = fixture();
  const account = await f.login();
  const initial = f.secret(account.accountId);
  f.advance(3600_000);
  f.network(true);
  await expect(f.broker.lease(account.accountId)).rejects.toMatchObject({ code: "network" });
  expect(f.secret(account.accountId)).toBe(initial);
  expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-in");
  f.network(false);
  f.refreshError("invalid_grant");
  await expect(f.broker.lease(account.accountId)).rejects.toMatchObject({ code: "reauth-required" });
  expect(!!f.secret(account.accountId)).toBe(false);
  expect(f.broker.getAccount(account.accountId)).toMatchObject({
    clientId: account.clientId,
    subject: account.subject,
    status: "reauth-required",
    planEnabled: false,
  });
  const again = await f.broker.begin({ accountId: account.accountId });
  expect(new URL(again.authorizationUrl).searchParams.get("client_id")).toBe(account.clientId);
});

test("sign-out clears local tokens, reports unconfirmed remote revocation and stops future leases", async () => {
  const f = fixture();
  const account = await f.login();
  f.revocationFailure();
  expect(await f.broker.signOut(account.accountId)).toEqual({ localCleared: true, revocation: "unconfirmed" });
  expect(f.vault.size).toBe(0);
  expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-out");
  await expect(f.broker.lease(account.accountId)).rejects.toMatchObject({ code: "reauth-required" });
  const revocation = f.requests.find((request) => request.url.endsWith("revoke"))!;
  expect(revocation.form.get("client_id")).toBe(account.clientId);
  expect(revocation.form.get("token_type_hint")).toBe("refresh_token");
  expect(readFileSync(f.metadataPath, "utf8")).not.toContain("private-");
});

test("locked storage disables sign-out durably and exposes only safe retryable cleanup state", async () => {
  const f = fixture();
  const account = await f.login();
  f.lockWallet(true);
  expect(await f.broker.signOut(account.accountId)).toEqual({ localCleared: false, revocation: "unconfirmed" });
  expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-out");
  const nextProcess = new CodexChatGptOAuthBroker(f.brokerOptions);
  cleanups.push(() => nextProcess.close());
  await expect(nextProcess.lease(account.accountId)).rejects.toMatchObject({ code: "reauth-required" });
  f.lockWallet(false);
  expect(await f.broker.signOut(account.accountId)).toEqual({ localCleared: true, revocation: "confirmed" });
  expect(f.vault.size).toBe(0);
});

test("cancelling a code exchange prevents credential publication and callback listeners expire", async () => {
  const f = fixture();
  const attempt = await f.broker.begin();
  let release!: () => void;
  f.gateToken(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await f.callback(attempt);
  expect(f.broker.status(attempt.attemptId).status).toBe("exchanging");
  await f.broker.cancel(attempt.attemptId);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.broker.status(attempt.attemptId).status).toBe("cancelled");
  expect(f.vault.size).toBe(0);
  expect(f.broker.listAccounts()).toEqual([]);
  const timed = fixture({ timeoutMs: 10 });
  const expiring = await timed.broker.begin();
  const result = await timed.terminal(expiring);
  expect(result.status).toBe("expired");
  await expect(fetch(new URL(new URL(expiring.authorizationUrl).searchParams.get("redirect_uri")!))).rejects.toThrow();
});

test("discovery metadata cannot redirect token or JWKS requests outside the pinned issuer", () => {
  const f = fixture();
  expect(
    () =>
      new CodexChatGptOAuthBroker({
        ...f.brokerOptions,
        issuerMetadata: { ...metadata, jwks_uri: "https://attacker.test/keys" },
      }),
  ).toThrow();
  expect(
    () =>
      new CodexChatGptOAuthBroker({
        ...f.brokerOptions,
        issuerMetadata: { ...metadata, issuer: "https://attacker.test" },
      }),
  ).toThrow();
  expect(f.requests).toHaveLength(0);
});

test("cancelling reauthorization during secure-store write preserves the previous usable account", async () => {
  const f = fixture();
  const account = await f.login();
  const original = f.secret(account.accountId);
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.gateWrite(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
    started,
  );
  const attempt = await f.broker.begin({ accountId: account.accountId });
  await f.callback(attempt);
  await writing;
  await f.broker.cancel(attempt.attemptId);
  release();
  // A lease queues behind the outstanding write and observes its finished rollback.
  const lease = await f.broker.lease(account.accountId);
  expect(lease.accessToken).toBe("private-access-initial");
  expect(f.secret(account.accountId)).toBe(original);
  expect(f.broker.getAccount(account.accountId)).toEqual(account);
  expect(f.vault.size).toBe(1);
});

test("concurrent begin calls open one foreground attempt and reject the second", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.broker.begin(), f.broker.begin()]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "busy" });
});

test("sign-out during an outstanding refresh revokes the replacement token and releases no token lease", async () => {
  const f = fixture();
  const account = await f.login();
  f.advance(3600_000);
  let release!: () => void;
  f.gateToken(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const lease = f.broker.lease(account.accountId).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // Wait for the observable refresh boundary, not a presumed duration.
  const deadline = Date.now() + 1000;
  while (!f.requests.some((request) => request.form.get("grant_type") === "refresh_token")) {
    if (Date.now() > deadline) throw new Error("refresh request was not issued");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const signOut = f.broker.signOut(account.accountId);
  release();
  expect(await lease).toMatchObject({ ok: false, error: { code: "reauth-required" } });
  expect(await signOut).toEqual({ localCleared: true, revocation: "confirmed" });
  expect(f.requests.find((request) => request.url.endsWith("revoke"))!.form.get("token")).toBe("private-refresh-1");
  expect(f.vault.size).toBe(0);
});

test("sign-out fences a returning sign-in before its callback listener registers", async () => {
  const f = fixture(),
    account = await f.login();
  const reading = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const read = f.store.read.bind(f.store);
  f.store.read = async (...args) => {
    reading.resolve();
    await release.promise;
    return read(...args);
  };
  const begin = f.broker.begin({ accountId: account.accountId }).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const signOut = f.broker.signOut(account.accountId);
  try {
    await reading.promise;
    // The durable sign-out update is deliberately still blocked on its secure read. The local
    // epoch must fence begin before any callback exists for sign-out's cancellation scan to see.
    expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-in");
    const result = await begin;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error).toMatchObject({ code: "cancelled" });
  } finally {
    f.store.read = read;
    release.resolve();
    await signOut;
  }
  expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-out");
  expect(f.vault.size).toBe(0);
  // An explicit sign-in started after sign-out is still allowed.
  const fresh = await f.broker.begin({ accountId: account.accountId });
  await f.callback(fresh);
  expect((await f.terminal(fresh)).status).toBe("succeeded");
});

test("another broker's durable sign-out generation prevents a pending callback from reviving credentials", async () => {
  const f = fixture(),
    account = await f.login();
  const pending = await f.broker.begin({ accountId: account.accountId });
  const other = new CodexChatGptOAuthBroker(f.brokerOptions);
  try {
    expect(await other.signOut(account.accountId)).toMatchObject({ localCleared: true });
    await f.callback(pending);
    expect(await f.terminal(pending)).toMatchObject({ status: "failed", error: "cancelled" });
    expect(f.broker.getAccount(account.accountId)?.status).toBe("signed-out");
    expect(f.vault.size).toBe(0);
  } finally {
    await other.close();
  }
});

test("a secure helper that commits before reporting failure cannot leave an unowned staging credential", async () => {
  const f = fixture(),
    account = await f.login(),
    write = f.store.write.bind(f.store);
  f.store.write = async (...args) => {
    await write(...args);
    throw new Error("verification failed after commit");
  };
  const attempt = await f.broker.begin({ accountId: account.accountId });
  await f.callback(attempt);
  expect((await f.terminal(attempt)).status).toBe("failed");
  expect(f.vault.size).toBe(1);
  expect(JSON.parse(readFileSync(f.metadataPath, "utf8")).pendingCredentialRefs).toEqual({});
  expect(await f.broker.signOut(account.accountId)).toMatchObject({ localCleared: true });
  expect(f.vault.size).toBe(0);
});

test.each(["cancel", "restart"] as const)(
  "failed first sign-in retains cleanup ownership and %s retries after unlocking",
  async (recovery) => {
    const f = fixture(),
      write = f.store.write.bind(f.store),
      remove = f.store.remove.bind(f.store);
    let ownedBeforeWrite = false;
    f.store.write = async (id, value, signal) => {
      const data = JSON.parse(readFileSync(f.metadataPath, "utf8"));
      ownedBeforeWrite = Object.values(data.pendingCredentialRefs ?? {}).some(
        (refs) => Array.isArray(refs) && refs.includes(id),
      );
      await write(id, value, signal);
      throw new Error("verification failed after commit");
    };
    f.store.remove = async () => false;
    const attempt = await f.broker.begin();
    await f.callback(attempt);
    expect((await f.terminal(attempt)).status).toBe("failed");
    expect(ownedBeforeWrite).toBe(true);
    expect(f.broker.listAccounts()).toEqual([]);
    expect(f.vault.size).toBe(1);
    const persisted = readFileSync(f.metadataPath, "utf8");
    expect(JSON.parse(persisted).pendingCredentialRefs[attempt.accountId]).toHaveLength(1);
    expect(persisted).not.toContain("private-");
    if (recovery === "cancel") {
      await expect(f.broker.cancel(attempt.attemptId)).rejects.toMatchObject({ code: "secure-storage" });
      f.store.remove = remove;
      await f.broker.cancel(attempt.attemptId);
    } else {
      const restarted = new CodexChatGptOAuthBroker(f.brokerOptions);
      try {
        const before = f.counts().reads,
          requests = f.requests.length;
        await expect(restarted.begin()).rejects.toMatchObject({ code: "secure-storage" });
        expect(f.counts().reads).toBe(before);
        expect(f.requests).toHaveLength(requests);
        f.store.remove = remove;
        const next = await restarted.begin();
        expect(f.vault.size).toBe(0);
        await restarted.cancel(next.attemptId);
      } finally {
        await restarted.close();
      }
    }
    expect(f.vault.size).toBe(0);
    expect(f.broker.listAccounts()).toEqual([]);
    expect(JSON.parse(readFileSync(f.metadataPath, "utf8")).pendingCredentialRefs).toEqual({});
  },
);

test("sign-out reports uncleared retired credentials and a retry removes every tracked vault record", async () => {
  const f = fixture(),
    account = await f.login(),
    remove = f.store.remove.bind(f.store);
  f.store.remove = async () => false;
  const attempt = await f.broker.begin({ accountId: account.accountId });
  await f.callback(attempt);
  expect((await f.terminal(attempt)).status).toBe("succeeded");
  const result = await f.broker.signOut(account.accountId);
  expect(result).toEqual({ localCleared: false, revocation: "unconfirmed" });
  expect(f.vault.size).toBe(2);
  f.store.remove = remove;
  expect(await f.broker.signOut(account.accountId)).toMatchObject({ localCleared: true });
  expect(f.vault.size).toBe(0);
  const persisted = JSON.parse(readFileSync(f.metadataPath, "utf8"));
  expect(persisted.pendingCredentialRefs).toEqual({});
  expect(persisted.credentialRefs[account.accountId]).toBeUndefined();
});

test("a crashed metadata lock owner releases OS authority while a live contender stays exclusive", async () => {
  const f = fixture();
  const module = new URL("../src/oauth/storage.ts", import.meta.url).href;
  const code = `
    import { OAuthMetadataStore } from ${JSON.stringify(module)};
    process.stdout.write("ready\\n");
    await new OAuthMetadataStore(process.env.LOCK_FIXTURE_PATH).exclusive("metadata", async () => {
      process.stdout.write("acquired\\n");
      if (process.env.LOCK_FIXTURE_HOLD === "1") {
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    });
  `;
  const spawn = (hold: boolean) =>
    Bun.spawn([process.execPath, "-e", code], {
      env: { PATH: "/usr/bin:/bin", LOCK_FIXTURE_PATH: f.metadataPath, LOCK_FIXTURE_HOLD: hold ? "1" : "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  const children: ReturnType<typeof spawn>[] = [],
    captures: Promise<void>[] = [];
  async function capture(stream: ReadableStream<Uint8Array>, append: (value: string) => void) {
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  }
  const waitFor = async (predicate: () => boolean, output: () => string) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Lock fixture did not reach its boundary: ${output()}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  };
  let ownerOutput = "",
    contenderOutput = "",
    errors = "";
  try {
    const owner = spawn(true);
    children.push(owner);
    captures.push(
      capture(owner.stdout, (value) => {
        ownerOutput += value;
      }),
      capture(owner.stderr, (value) => {
        errors += value;
      }),
    );
    await waitFor(
      () => ownerOutput.includes("acquired"),
      () => ownerOutput + errors,
    );
    const path = `${f.metadataPath}.metadata.lock`,
      inode = statSync(path).ino;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const contender = spawn(false);
    children.push(contender);
    captures.push(
      capture(contender.stdout, (value) => {
        contenderOutput += value;
      }),
      capture(contender.stderr, (value) => {
        errors += value;
      }),
    );
    await waitFor(
      () => contenderOutput.includes("ready"),
      () => contenderOutput + errors,
    );
    // The sole real-time witness: cross the production 25ms contention retry while the owner
    // remains alive. This catches a missing OS lock even if the parent has an in-memory queue.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(contenderOutput).not.toContain("acquired");
    owner.kill("SIGKILL");
    expect(await owner.exited).toBe(137);
    expect(owner.signalCode).toBe("SIGKILL");
    await waitFor(
      () => contenderOutput.includes("acquired"),
      () => contenderOutput + errors,
    );
    expect(await contender.exited).toBe(0);
    expect(statSync(path).ino).toBe(inode);
    let entered = false;
    await new OAuthMetadataStore(f.metadataPath).exclusive("metadata", async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    expect(statSync(path).ino).toBe(inode);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.allSettled(captures);
  }
});

test("macOS secure updates carry credentials only on private stdin and atomically replace matching items", async () => {
  const calls: CredentialHelperRequest[] = [];
  const store = new MacKeychainCredentialStore({
    service: "ai.glosa.codex.chatgpt",
    env: { HOME: "/fixture", ANTHROPIC_API_KEY: "never-inherit", ACCESS_TOKEN: "never-inherit" },
    run: async (request) => {
      calls.push(request);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const account = "11111111-1111-4111-8111-111111111111";
  const record = JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh" });
  await store.write(account, record);
  expect(calls[0]!.argv).toEqual(["/usr/bin/security", "-i"]);
  expect(calls[0]!.input).toContain(" -U -X ");
  expect(calls[0]!.input).toContain(Buffer.from(record).toString("hex"));
  expect(calls.every((request) => !JSON.stringify(request.argv).includes("private-"))).toBe(true);
  expect(calls[0]!.env).toEqual({ HOME: "/fixture", PATH: "/usr/bin:/bin", LC_ALL: "C" });
  expect(calls[1]!.argv).toContain("find-generic-password");
  expect(calls[1]!.argv).not.toContain("-w");
});
