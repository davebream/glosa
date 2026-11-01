// SPDX-License-Identifier: Apache-2.0
/** Safe account metadata. Credentials and token leases never cross the HTTP boundary. */
export interface ManagedOAuthAccount {
  accountId: string;
  clientId: string;
  issuer: string;
  subject: string;
  email?: string;
  label: string;
  status: "signed-in" | "signed-out" | "reauth-required";
  planEnabled: boolean;
  planLabel?: string;
  credentialVersion?: string;
}

export type ManagedOAuthFailure =
  | "cancelled"
  | "expired"
  | "access-denied"
  | "invalid-response"
  | "identity-mismatch"
  | "secure-storage"
  | "network"
  | "reauth-required"
  | "invalid-client"
  | "plan-disabled"
  | "busy"
  | "not-found";

export interface ManagedOAuthAttempt {
  attemptId: string;
  accountId: string;
  status: "pending" | "exchanging" | "succeeded" | "failed" | "cancelled" | "expired";
  expiresAt: string;
  account?: ManagedOAuthAccount;
  error?: ManagedOAuthFailure;
}

export interface ManagedOAuthBegin extends ManagedOAuthAttempt {
  authorizationUrl: string;
}

/** Internal foreground capability. Never serialize this value into a response or journal. */
export interface ManagedOAuthTokenLease {
  accessToken: string;
  expiresAt: string;
  credentialVersion: string;
}

export interface ManagedOAuthSignOut {
  localCleared: boolean;
  revocation: "confirmed" | "unconfirmed" | "not-needed";
}

/** Provider-neutral seam: constructing or listing a broker performs no vendor requests. */
export interface ManagedOAuthBroker {
  begin(options?: { accountId?: string; requestPlanConsent?: boolean }): Promise<ManagedOAuthBegin>;
  status(attemptId: string): ManagedOAuthAttempt;
  cancel(attemptId: string): Promise<ManagedOAuthAttempt>;
  listAccounts(): ManagedOAuthAccount[];
  getAccount(accountId: string): ManagedOAuthAccount | undefined;
  lease(accountId: string, options?: { signal?: AbortSignal }): Promise<ManagedOAuthTokenLease>;
  signOut(accountId: string): Promise<ManagedOAuthSignOut>;
  close(): Promise<void>;
}
