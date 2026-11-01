// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";
import type {
  ManagedOAuthAccount,
  ManagedOAuthAttempt,
  ManagedOAuthBegin,
  ManagedOAuthBroker,
  ManagedOAuthSignOut,
  ManagedOAuthTokenLease,
} from "../../../../daemon/src/agents/oauth-interface.ts";
import { createSecureCredentialStore, type SecureCredentialStore } from "../../../shared-credentials/src/index.ts";
import { OAuthBrokerError, safeFailure } from "./errors.ts";
import { ACCOUNT_ID, CLIENT_ID, ISSUER, OAuthMetadataStore, publicAccount } from "./storage.ts";

export const CHATGPT_KEYCHAIN_SERVICE = "ai.glosa.codex.chatgpt";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const ATTEMPT_MS = 5 * 60_000;
const MAX_RECORD_BYTES = 48 * 1024;

interface CredentialRecord {
  version: 1;
  accountId: string;
  clientId: string;
  issuer: string;
  subject: string;
  credentialVersion: string;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  tokenType: "bearer";
  scopes: string[];
  expiresAt: string;
}

interface PendingAttempt {
  view: ManagedOAuthAttempt;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  selected?: ManagedOAuthAccount;
  authorizationEpoch: number;
  authorizationGeneration?: string;
  exchangeActive?: boolean;
  metadata?: oidc.ServerMetadata;
  server: Bun.Server<undefined>;
  timer: ReturnType<typeof setTimeout>;
  abort: AbortController;
}

export interface CodexOAuthBrokerOptions {
  metadataPath: string;
  credentialStore?: SecureCredentialStore;
  /** Test seam only. Production always discovers the pinned OpenAI issuer in a foreground action. */
  issuerMetadata?: oidc.ServerMetadata;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  attemptTimeoutMs?: number;
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function boundedString(value: unknown, max = 24576): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateMetadata(value: unknown): oidc.ServerMetadata {
  if (!value || typeof value !== "object") throw new OAuthBrokerError("invalid-response");
  const metadata = value as oidc.ServerMetadata;
  if (
    metadata.issuer !== ISSUER ||
    metadata.authorization_endpoint !== `${ISSUER}/api/accounts/authorize` ||
    metadata.token_endpoint !== `${ISSUER}/api/accounts/oauth/token`
  )
    throw new OAuthBrokerError("invalid-response");
  for (const endpoint of [metadata.jwks_uri, metadata.revocation_endpoint]) {
    if (!endpoint) throw new OAuthBrokerError("invalid-response");
    const url = new URL(endpoint);
    if (url.origin !== ISSUER || url.username || url.password || url.hash)
      throw new OAuthBrokerError("invalid-response");
  }
  return {
    issuer: ISSUER,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    jwks_uri: metadata.jwks_uri,
    revocation_endpoint: metadata.revocation_endpoint,
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

/** No network, credential reads, timers or listeners until an explicitly requested operation. */
export class CodexChatGptOAuthBroker implements ManagedOAuthBroker {
  private readonly metadata: OAuthMetadataStore;
  private readonly credentials: SecureCredentialStore;
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly revoked = new Set<string>();
  private readonly authorizationEpochs = new Map<string, number>();
  private readonly now: () => number;
  private issuerMetadata?: oidc.ServerMetadata;
  private closed = false;
  private beginning = false;

  constructor(private readonly options: CodexOAuthBrokerOptions) {
    this.metadata = new OAuthMetadataStore(options.metadataPath);
    this.credentials =
      options.credentialStore ??
      createSecureCredentialStore({ service: CHATGPT_KEYCHAIN_SERVICE, label: "Glosa ChatGPT account" });
    this.now = options.now ?? Date.now;
    if (options.issuerMetadata) this.issuerMetadata = validateMetadata(options.issuerMetadata);
  }

  listAccounts(): ManagedOAuthAccount[] {
    return (this.metadata.read()?.accounts ?? []).map(publicAccount);
  }
  getAccount(accountId: string): ManagedOAuthAccount | undefined {
    this.checkAccountId(accountId);
    return this.listAccounts().find((account) => account.accountId === accountId);
  }

  private checkAccountId(accountId: string): void {
    if (!ACCOUNT_ID.test(accountId)) throw new OAuthBrokerError("not-found");
  }

  private assertAuthorization(
    accountId: string,
    ticket: { authorizationEpoch: number; authorizationGeneration?: string },
    data = this.metadata.read(),
  ): void {
    if (
      (this.authorizationEpochs.get(accountId) ?? 0) !== ticket.authorizationEpoch ||
      data?.authorizationGenerations[accountId] !== ticket.authorizationGeneration
    )
      throw new OAuthBrokerError("cancelled");
  }

  /** Call only while holding this account's lock. Never remove an active credential on rollback. */
  private async cleanupReferences(accountId: string, refs: readonly string[], includeActive = false): Promise<boolean> {
    const active = this.metadata.read()?.credentialRefs[accountId];
    const cleared = new Set<string>();
    for (const ref of new Set(refs)) {
      if (!includeActive && ref === active) continue;
      try {
        if (await this.credentials.remove(ref)) cleared.add(ref);
      } catch {
        /* The durable ledger remains available for a foreground retry. */
      }
    }
    if (cleared.size)
      await this.metadata.update(async (data) => {
        const pending = data.pendingCredentialRefs[accountId]?.filter((ref) => !cleared.has(ref)) ?? [];
        if (pending.length) data.pendingCredentialRefs[accountId] = pending;
        else delete data.pendingCredentialRefs[accountId];
        if (includeActive && cleared.has(data.credentialRefs[accountId] ?? "")) delete data.credentialRefs[accountId];
      });
    return refs.every((ref) => cleared.has(ref));
  }

  private async cleanupPending(accountId: string): Promise<boolean> {
    return this.metadata.exclusive(accountId, async () =>
      this.cleanupReferences(accountId, this.metadata.read()?.pendingCredentialRefs[accountId] ?? []),
    );
  }

  /** An explicit new sign-in is also the recovery action for unpublished credentials after a crash. */
  private async cleanupBeforeSignIn(): Promise<void> {
    for (const accountId of Object.keys(this.metadata.read()?.pendingCredentialRefs ?? {}))
      if (!(await this.cleanupPending(accountId))) throw new OAuthBrokerError("secure-storage");
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== ISSUER || target.username || target.password || target.hash)
      throw new OAuthBrokerError("invalid-response");
    const headers = new Headers(init.headers);
    headers.set("user-agent", "glosa");
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15_000)]),
      });
    } catch {
      throw new OAuthBrokerError("network");
    }
    // Keep provider-controlled response data bounded and private, including errors.
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) {
          await reader.cancel();
          throw new OAuthBrokerError("invalid-response");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async discover(signal?: AbortSignal): Promise<oidc.ServerMetadata> {
    if (this.issuerMetadata) return this.issuerMetadata;
    const response = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, { signal });
    if (!response.ok) throw new OAuthBrokerError("network");
    this.issuerMetadata = validateMetadata(await response.json());
    return this.issuerMetadata;
  }

  private configuration(metadata: oidc.ServerMetadata, clientId: string, signal?: AbortSignal): oidc.Configuration {
    const config = new oidc.Configuration(
      metadata,
      clientId,
      { id_token_signed_response_alg: "RS256", [oidc.clockTolerance]: 0 },
      oidc.None(),
    );
    config.timeout = 15;
    config[oidc.customFetch] = (url, init) =>
      this.fetch(url, {
        ...init,
        body: init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body,
        signal: AbortSignal.any([...(init.signal ? [init.signal] : []), ...(signal ? [signal] : [])]),
      });
    // openid-client otherwise trusts TLS without checking the JWT signature. This is required.
    oidc.enableNonRepudiationChecks(config);
    return config;
  }

  async begin(options: { accountId?: string; requestPlanConsent?: boolean } = {}): Promise<ManagedOAuthBegin> {
    if (this.closed) throw new OAuthBrokerError("cancelled");
    if (options.accountId) this.checkAccountId(options.accountId);
    // Capture account and authority from one metadata read before the first await. A concurrent
    // sign-out must also fence attempts that have not registered their callback listener yet.
    const data = options.accountId ? this.metadata.read() : undefined;
    const selected = data?.accounts.find((account) => account.accountId === options.accountId);
    if (options.accountId && !selected) throw new OAuthBrokerError("not-found");
    const ticket = {
      authorizationEpoch: selected ? (this.authorizationEpochs.get(selected.accountId) ?? 0) : 0,
      authorizationGeneration: selected ? data?.authorizationGenerations[selected.accountId] : undefined,
    };
    // One foreground browser attempt at a time. Saved accounts stay active until validation succeeds.
    if (
      this.beginning ||
      [...this.attempts.values()].some((attempt) => ["pending", "exchanging"].includes(attempt.view.status))
    )
      throw new OAuthBrokerError("busy");
    this.beginning = true;
    try {
      await this.cleanupBeforeSignIn();
      return await this.prepareAttempt(selected, options, ticket);
    } finally {
      this.beginning = false;
    }
  }

  private async prepareAttempt(
    selected: ManagedOAuthAccount | undefined,
    options: { requestPlanConsent?: boolean },
    ticket: { authorizationEpoch: number; authorizationGeneration?: string },
  ): Promise<ManagedOAuthBegin> {
    const hostId = await this.metadata.update(async (data) => data.hostId);
    if (this.closed) throw new OAuthBrokerError("cancelled");
    if (selected) this.assertAuthorization(selected.accountId, ticket);
    // Keep only a bounded history of terminal attempts in daemon memory.
    for (const [id, old] of this.attempts)
      if (this.attempts.size >= 64 && !["pending", "exchanging"].includes(old.view.status)) this.attempts.delete(id);
    const attemptId = randomUUID();
    const accountId = selected?.accountId ?? randomUUID();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = oidc.randomPKCECodeVerifier();
    const abort = new AbortController();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.callback(attemptId, request) });
    const expiresAt = new Date(this.now() + (this.options.attemptTimeoutMs ?? ATTEMPT_MS)).toISOString();
    const attempt: PendingAttempt = {
      view: { attemptId, accountId, status: "pending", expiresAt },
      state,
      nonce,
      verifier,
      redirectUri: `http://127.0.0.1:${server.port}/auth/callback`,
      clientId: selected?.clientId ?? "dynamic_agent_client",
      selected,
      ...ticket,
      server,
      abort,
      timer: setTimeout(() => {
        void this.finish(attemptId, "expired", "expired");
      }, this.options.attemptTimeoutMs ?? ATTEMPT_MS),
    };
    this.attempts.set(attemptId, attempt);
    try {
      attempt.metadata = await this.discover(abort.signal);
      if (attempt.view.status !== "pending") throw new OAuthBrokerError("cancelled");
      const url = new URL(attempt.metadata.authorization_endpoint!);
      const parameters: Record<string, string> = {
        client_id: attempt.clientId,
        ext_agent_host_id: hostId,
        response_type: "code",
        redirect_uri: attempt.redirectUri,
        scope: CHATGPT_SCOPES,
        resource: CHATGPT_RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      };
      if (!selected) parameters.agent_name_hint = "Glosa";
      if (selected?.email) parameters.login_hint = selected.email;
      if (options.requestPlanConsent) parameters.prompt = "consent";
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      return { ...this.status(attemptId), authorizationUrl: url.href };
    } catch (error) {
      await this.finish(attemptId, "failed", safeFailure(error));
      throw new OAuthBrokerError(safeFailure(error));
    }
  }

  status(attemptId: string): ManagedOAuthAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new OAuthBrokerError("not-found");
    return { ...attempt.view, ...(attempt.view.account ? { account: publicAccount(attempt.view.account) } : {}) };
  }

  async cancel(attemptId: string): Promise<ManagedOAuthAttempt> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new OAuthBrokerError("not-found");
    await this.finish(attemptId, "cancelled", "cancelled");
    // An active exchange owns its rollback and may still be unwinding an interrupted helper.
    // A later explicit Cancel/Close retries any residue without waiting behind that exchange.
    if (!attempt.exchangeActive && !(await this.cleanupPending(attempt.view.accountId)))
      throw new OAuthBrokerError("secure-storage");
    return this.status(attemptId);
  }

  private async finish(
    attemptId: string,
    status: ManagedOAuthAttempt["status"],
    error?: ManagedOAuthAttempt["error"],
  ): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || !["pending", "exchanging"].includes(attempt.view.status)) return;
    attempt.view.status = status;
    if (error) attempt.view.error = error;
    clearTimeout(attempt.timer);
    attempt.abort.abort();
    attempt.state = "";
    attempt.nonce = "";
    attempt.verifier = "";
    await attempt.server.stop(false);
  }

  private async callback(attemptId: string, request: Request): Promise<Response> {
    const headers = {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    };
    const reply = (text: string, status = 200) => new Response(text, { status, headers });
    const attempt = this.attempts.get(attemptId);
    if (attempt?.view.status !== "pending") return reply("This sign-in attempt is no longer active.", 409);
    const url = new URL(request.url);
    const expected = new URL(attempt.redirectUri);
    if (
      request.method !== "GET" ||
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      request.headers.get("host") !== expected.host ||
      request.headers.has("origin")
    )
      return reply("Invalid callback request.", 400);
    if (
      url.search.length > 16384 ||
      ["state", "code", "client_id", "error", "iss"].some((key) => url.searchParams.getAll(key).length > 1) ||
      !equalSecret(url.searchParams.get("state") ?? "", attempt.state)
    )
      return reply("Invalid sign-in state. Return to Glosa and try again.", 400);
    if (new Date(attempt.view.expiresAt).getTime() <= this.now()) {
      queueMicrotask(() => {
        void this.finish(attemptId, "expired", "expired");
      });
      return reply("Sign-in expired. Return to Glosa.", 400);
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      queueMicrotask(() => {
        void this.finish(attemptId, "failed", oauthError === "access_denied" ? "access-denied" : "invalid-response");
      });
      return reply("Sign-in was not completed. Return to Glosa.", 400);
    }
    const issued = url.searchParams.get("client_id");
    if (
      !boundedString(url.searchParams.get("code"), 8192) ||
      (!attempt.selected && (!issued || !CLIENT_ID.test(issued))) ||
      (attempt.selected && issued !== null && issued !== attempt.clientId)
    ) {
      queueMicrotask(() => {
        void this.finish(attemptId, "failed", "invalid-response");
      });
      return reply("Invalid registration response. Return to Glosa.", 400);
    }
    if (issued) attempt.clientId = issued;
    attempt.view.status = "exchanging";
    // Return no codes, identity or credential material to browser content. The exchange is private.
    attempt.exchangeActive = true;
    void this.exchange(attempt, url).finally(() => {
      attempt.exchangeActive = false;
    });
    return reply("You can return to Glosa. Sign-in is being completed.");
  }

  private async exchange(attempt: PendingAttempt, callback: URL): Promise<void> {
    try {
      const config = this.configuration(attempt.metadata!, attempt.clientId, attempt.abort.signal);
      const tokens = await oidc.authorizationCodeGrant(
        config,
        callback,
        {
          expectedState: attempt.state,
          expectedNonce: attempt.nonce,
          pkceCodeVerifier: attempt.verifier,
          idTokenExpected: true,
        },
        { resource: CHATGPT_RESOURCE },
      );
      const claims = tokens.claims();
      if (!claims || !boundedString(claims.sub, 1024)) throw new OAuthBrokerError("invalid-response");
      if (attempt.selected && (claims.sub !== attempt.selected.subject || claims.iss !== attempt.selected.issuer))
        throw new OAuthBrokerError("identity-mismatch");
      if (attempt.view.status !== "exchanging") return;
      const record = this.record(tokens, attempt.view.accountId, attempt.clientId, claims.sub);
      const account: ManagedOAuthAccount = {
        accountId: record.accountId,
        clientId: record.clientId,
        issuer: ISSUER,
        subject: claims.sub,
        ...(boundedString(claims.email, 320) ? { email: claims.email } : {}),
        label: `${boundedString(claims.email, 320) ? claims.email : "ChatGPT account"} · ${record.clientId.slice(-8)}`,
        status: "signed-in",
        planEnabled: record.scopes.includes(PLAN_SCOPE),
        credentialVersion: record.credentialVersion,
      };
      await this.metadata.exclusive(account.accountId, async () => {
        if (attempt.view.status !== "exchanging") return;
        this.assertAuthorization(account.accountId, attempt);
        // Reauthorization stages a new vault item. Cancellation cannot erase or overwrite
        // the selected account's still-active credential record.
        const credentialRef = randomUUID();
        const previousRef = this.metadata.read()?.credentialRefs[account.accountId];
        // Record ownership before a helper can commit and then fail, or the process can crash.
        await this.metadata.update(async (data) => {
          this.assertAuthorization(account.accountId, attempt, data);
          (data.pendingCredentialRefs[account.accountId] ??= []).push(credentialRef);
        });
        try {
          await this.credentials.write(credentialRef, JSON.stringify(record), attempt.abort.signal);
          if (attempt.view.status !== "exchanging") return;
          await this.metadata.update(
            async (data) => {
              if (attempt.view.status !== "exchanging") throw new OAuthBrokerError("cancelled");
              this.assertAuthorization(account.accountId, attempt, data);
              const current = data.accounts.findIndex((candidate) => candidate.accountId === account.accountId);
              if (current < 0) data.accounts.push(account);
              else data.accounts[current] = account;
              data.credentialRefs[account.accountId] = credentialRef;
              data.authorizationGenerations[account.accountId] = randomUUID();
              const pending = data.pendingCredentialRefs[account.accountId]!.filter((ref) => ref !== credentialRef);
              if (previousRef && previousRef !== credentialRef && !pending.includes(previousRef))
                pending.push(previousRef);
              if (pending.length) data.pendingCredentialRefs[account.accountId] = pending;
              else delete data.pendingCredentialRefs[account.accountId];
            },
            () => {
              this.revoked.delete(account.accountId);
              attempt.view.account = account;
              // Mark success synchronously with durable metadata publication so cancellation
              // cannot claim success while newly committed credentials remain active.
              void this.finish(attempt.view.attemptId, "succeeded");
            },
          );
        } finally {
          // Metadata rename may have committed before a directory fsync failed. Never delete
          // the newly active record merely because publication returned an error.
          if (this.metadata.read()?.credentialRefs[account.accountId] !== credentialRef)
            await this.cleanupReferences(account.accountId, [credentialRef]).catch(() => false);
        }
        if (previousRef && previousRef !== credentialRef)
          await this.cleanupReferences(account.accountId, [previousRef]).catch(() => false);
      });
      await this.finish(attempt.view.attemptId, "succeeded");
    } catch (error) {
      await this.finish(attempt.view.attemptId, "failed", safeFailure(error));
    }
  }

  private record(
    tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
    accountId: string,
    clientId: string,
    subject: string,
    previous?: CredentialRecord,
  ): CredentialRecord {
    if (
      !boundedString(tokens.access_token) ||
      !boundedString(tokens.id_token ?? previous?.idToken) ||
      (tokens.refresh_token !== undefined && !boundedString(tokens.refresh_token)) ||
      tokens.token_type.toLowerCase() !== "bearer" ||
      typeof tokens.expires_in !== "number" ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      tokens.expires_in > 366 * 24 * 3600 ||
      (tokens.scope !== undefined && typeof tokens.scope !== "string")
    )
      throw new OAuthBrokerError("invalid-response");
    const scopes =
      tokens.scope === undefined ? (previous?.scopes ?? []) : tokens.scope.trim().split(/\s+/).filter(Boolean);
    if (scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)) || scopes.length > 64)
      throw new OAuthBrokerError("invalid-response");
    const record: CredentialRecord = {
      version: 1,
      accountId,
      clientId,
      issuer: ISSUER,
      subject,
      credentialVersion: randomUUID(),
      accessToken: tokens.access_token,
      ...((tokens.refresh_token ?? previous?.refreshToken)
        ? { refreshToken: tokens.refresh_token ?? previous?.refreshToken }
        : {}),
      idToken: (tokens.id_token ?? previous?.idToken)!,
      tokenType: "bearer",
      scopes,
      expiresAt: new Date(this.now() + tokens.expires_in * 1000).toISOString(),
    };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new OAuthBrokerError("invalid-response");
    return record;
  }

  private async readRecord(account: ManagedOAuthAccount, signal?: AbortSignal): Promise<CredentialRecord> {
    let raw: string | null;
    const ref = this.metadata.read()?.credentialRefs[account.accountId];
    if (!ref) throw new OAuthBrokerError("reauth-required");
    try {
      raw = await this.credentials.read(ref, signal);
    } catch {
      throw new OAuthBrokerError("secure-storage");
    }
    if (!raw) throw new OAuthBrokerError("reauth-required");
    try {
      if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error();
      const value = JSON.parse(raw) as CredentialRecord;
      if (
        value.version !== 1 ||
        value.accountId !== account.accountId ||
        value.clientId !== account.clientId ||
        value.issuer !== account.issuer ||
        value.subject !== account.subject ||
        !ACCOUNT_ID.test(value.credentialVersion) ||
        !boundedString(value.accessToken) ||
        !boundedString(value.idToken) ||
        (value.refreshToken !== undefined && !boundedString(value.refreshToken)) ||
        value.tokenType !== "bearer" ||
        !Array.isArray(value.scopes) ||
        !value.scopes.every((scope) => typeof scope === "string") ||
        !Number.isFinite(Date.parse(value.expiresAt))
      )
        throw new Error();
      return value;
    } catch {
      throw new OAuthBrokerError("secure-storage");
    }
  }

  async lease(accountId: string, options: { signal?: AbortSignal } = {}): Promise<ManagedOAuthTokenLease> {
    this.checkAccountId(accountId);
    if (this.closed || this.revoked.has(accountId)) throw new OAuthBrokerError("reauth-required");
    try {
      return await this.metadata.exclusive(accountId, async () => {
        options.signal?.throwIfAborted();
        const account = this.getAccount(accountId);
        if (account?.status !== "signed-in" || this.revoked.has(accountId))
          throw new OAuthBrokerError("reauth-required");
        if (!account.planEnabled) throw new OAuthBrokerError("plan-disabled");
        let record = await this.readRecord(account, options.signal);
        if (!record.scopes.includes(PLAN_SCOPE)) throw new OAuthBrokerError("plan-disabled");
        if (Date.parse(record.expiresAt) <= this.now() + 60_000) {
          if (!record.refreshToken) {
            await this.disable(accountId);
            throw new OAuthBrokerError("reauth-required");
          }
          try {
            const config = this.configuration(await this.discover(options.signal), record.clientId, options.signal);
            const tokens = await oidc.refreshTokenGrant(config, record.refreshToken, { resource: CHATGPT_RESOURCE });
            const identity = tokens.claims();
            if (identity && (identity.sub !== account.subject || identity.iss !== account.issuer))
              throw new OAuthBrokerError("identity-mismatch");
            record = this.record(tokens, accountId, record.clientId, account.subject, record);
            // Replace the whole vault record before metadata. Its version is authoritative:
            // a metadata-write failure must not discard a newly rotated refresh token.
            const ref = this.metadata.read()?.credentialRefs[accountId];
            if (!ref) throw new OAuthBrokerError("reauth-required");
            // The server may already have invalidated the previous refresh token. Once a valid
            // replacement arrives, caller cancellation must not prevent its local durable commit.
            // The credential helper has its own deadline; cancellation only suppresses the lease.
            await this.credentials.write(ref, JSON.stringify(record));
            await this.metadata.update(async (data) => {
              const current = data.accounts.find((candidate) => candidate.accountId === accountId);
              if (current?.status !== "signed-in") throw new OAuthBrokerError("reauth-required");
              current.credentialVersion = record.credentialVersion;
              current.planEnabled = record.scopes.includes(PLAN_SCOPE);
            });
          } catch (error) {
            const code = safeFailure(error);
            if (["reauth-required", "identity-mismatch"].includes(code)) await this.disable(accountId);
            throw new OAuthBrokerError(code);
          }
        }
        if (this.revoked.has(accountId) || this.closed) throw new OAuthBrokerError("reauth-required");
        if (options.signal?.aborted) throw new OAuthBrokerError("cancelled");
        if (!record.scopes.includes(PLAN_SCOPE)) throw new OAuthBrokerError("plan-disabled");
        return {
          accessToken: record.accessToken,
          expiresAt: record.expiresAt,
          credentialVersion: record.credentialVersion,
        };
      });
    } catch (error) {
      throw new OAuthBrokerError(safeFailure(error));
    }
  }

  private async disable(accountId: string): Promise<void> {
    this.revoked.add(accountId);
    await this.metadata.update(async (data) => {
      const account = data.accounts.find((candidate) => candidate.accountId === accountId);
      if (account) {
        account.status = "reauth-required";
        account.planEnabled = false;
        delete account.credentialVersion;
      }
    });
    const ref = this.metadata.read()?.credentialRefs[accountId];
    if (ref) await this.credentials.remove(ref).catch(() => false);
  }

  async signOut(accountId: string): Promise<ManagedOAuthSignOut> {
    this.checkAccountId(accountId);
    this.revoked.add(accountId);
    this.authorizationEpochs.set(accountId, (this.authorizationEpochs.get(accountId) ?? 0) + 1);
    for (const attempt of this.attempts.values())
      if (attempt.view.accountId === accountId) await this.finish(attempt.view.attemptId, "cancelled", "cancelled");
    return this.metadata.exclusive(accountId, async () => {
      const account = this.getAccount(accountId);
      const pendingRefs = this.metadata.read()?.pendingCredentialRefs[accountId] ?? [];
      if (!account && !pendingRefs.length) throw new OAuthBrokerError("not-found");
      let record: CredentialRecord | undefined;
      try {
        if (account) record = await this.readRecord(account);
      } catch {
        /* disabling must survive unavailable storage */
      }
      // Disable use durably before external revocation or a wallet prompt can fail.
      await this.metadata.update(async (data) => {
        const selected = data.accounts.find((candidate) => candidate.accountId === accountId);
        if (selected) {
          selected.status = "signed-out";
          selected.planEnabled = false;
          delete selected.credentialVersion;
        }
        data.authorizationGenerations[accountId] = randomUUID();
      });
      let revocation: ManagedOAuthSignOut["revocation"] = !record || record.refreshToken ? "unconfirmed" : "not-needed";
      if (record?.refreshToken && account) {
        try {
          const config = this.configuration(await this.discover(), account.clientId);
          await oidc.tokenRevocation(config, record.refreshToken, { token_type_hint: "refresh_token" });
          // Staging residue may belong to a newer, unadopted grant. Revoking the active
          // record alone does not establish revocation of every staged credential.
          revocation = pendingRefs.length ? "unconfirmed" : "confirmed";
        } catch {
          /* fixed safe result below; never expose the vendor response */
        }
      }
      const ref = this.metadata.read()?.credentialRefs[accountId];
      const localCleared = await this.cleanupReferences(accountId, [...(ref ? [ref] : []), ...pendingRefs], true);
      return { localCleared, revocation };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.attempts.keys()].map((id) => this.finish(id, "cancelled", "cancelled")));
  }
}
