// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import type { ManagedOAuthAccount } from "../../../../daemon/src/agents/oauth-interface.ts";
import { OAuthBrokerError } from "./errors.ts";

export const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLIENT_ID = /^oaiapp_[A-Za-z0-9_-]{1,240}$/;
export const ISSUER = "https://auth.openai.com";
const queues = new Map<string, Promise<void>>();
let lockLibrary: ReturnType<typeof loadLockLibrary> | undefined;
function loadLockLibrary() {
  return dlopen(process.platform === "linux" ? "libc.so.6" : "libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

function tryLock(fd: number): boolean {
  // LOCK_EX | LOCK_NB have the same values on Darwin and Linux. Loading libc is foreground-only.
  try {
    return (lockLibrary ??= loadLockLibrary()).symbols.flock(fd, 2 | 4) === 0;
  } catch {
    throw new OAuthBrokerError("secure-storage");
  }
}
export interface AccountMetadata {
  version: 1;
  hostId: string;
  accounts: ManagedOAuthAccount[];
  credentialRefs: Record<string, string>;
  authorizationGenerations: Record<string, string>;
  pendingCredentialRefs: Record<string, string[]>;
}

function safeFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  ) {
    throw new OAuthBrokerError("secure-storage");
  }
}

export class OAuthMetadataStore {
  constructor(readonly path: string) {}

  read(): AccountMetadata | undefined {
    try {
      safeFile(this.path);
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
      const value = data as Partial<AccountMetadata>;
      if (
        value.version !== 1 ||
        typeof value.hostId !== "string" ||
        !/^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId) ||
        !Array.isArray(value.accounts)
      )
        throw new Error();
      const ids = new Set<string>();
      for (const account of value.accounts) {
        if (
          !account ||
          !ACCOUNT_ID.test(account.accountId) ||
          ids.has(account.accountId) ||
          !CLIENT_ID.test(account.clientId) ||
          account.issuer !== ISSUER ||
          typeof account.subject !== "string" ||
          !account.subject ||
          account.subject.length > 1024 ||
          typeof account.label !== "string" ||
          account.label.length > 320 ||
          (account.email !== undefined && (typeof account.email !== "string" || account.email.length > 320)) ||
          !["signed-in", "signed-out", "reauth-required"].includes(account.status) ||
          typeof account.planEnabled !== "boolean" ||
          (account.credentialVersion !== undefined && !ACCOUNT_ID.test(account.credentialVersion))
        )
          throw new Error();
        // Reconstruct the exact public shape, never pass through unexpected persisted fields.
        ids.add(account.accountId);
      }
      if (
        !value.credentialRefs ||
        typeof value.credentialRefs !== "object" ||
        Array.isArray(value.credentialRefs) ||
        Object.entries(value.credentialRefs).some(
          ([accountId, ref]) => !ACCOUNT_ID.test(accountId) || !ACCOUNT_ID.test(ref),
        )
      )
        throw new Error();
      const generations = value.authorizationGenerations ?? {};
      if (
        typeof generations !== "object" ||
        Array.isArray(generations) ||
        Object.entries(generations).some(
          ([accountId, generation]) => !ACCOUNT_ID.test(accountId) || !ACCOUNT_ID.test(generation),
        )
      )
        throw new Error();
      const pendingRefs = value.pendingCredentialRefs ?? {};
      if (
        typeof pendingRefs !== "object" ||
        Array.isArray(pendingRefs) ||
        Object.entries(pendingRefs).some(
          ([accountId, refs]) =>
            !ACCOUNT_ID.test(accountId) ||
            !Array.isArray(refs) ||
            refs.some((ref) => typeof ref !== "string" || !ACCOUNT_ID.test(ref)) ||
            new Set(refs).size !== refs.length,
        )
      )
        throw new Error();
      return {
        version: 1,
        hostId: value.hostId,
        accounts: value.accounts.map(publicAccount),
        credentialRefs: { ...value.credentialRefs },
        authorizationGenerations: { ...generations },
        pendingCredentialRefs: Object.fromEntries(
          Object.entries(pendingRefs).map(([accountId, refs]) => [accountId, [...refs]]),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new OAuthBrokerError("secure-storage");
    }
  }

  write(data: AccountMetadata): void {
    const pending = `${this.path}.${randomUUID()}.pending`;
    let fd: number | undefined;
    try {
      fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, `${JSON.stringify(data)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(pending, this.path);
      const directory = openSync(dirname(this.path), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      throw new OAuthBrokerError("secure-storage");
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(pending);
      } catch {
        /* already renamed */
      }
    }
  }

  /** OS ownership ends on descriptor close or process death, without stale-PID or timeout stealing. */
  async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (key !== "metadata" && !ACCOUNT_ID.test(key)) throw new OAuthBrokerError("secure-storage");
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.mode & 0o022 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new OAuthBrokerError("secure-storage");
    const path = `${this.path}.${key}.lock`;
    const previous = queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(path, turn);
    await previous;
    let fd: number | undefined;
    try {
      // Keep the inode permanently: unlinking it lets a new opener lock a different inode while
      // an existing contender still holds the old one. All participants lock this same file.
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const owner = fstatSync(fd);
      if (
        !owner.isFile() ||
        owner.nlink !== 1 ||
        owner.mode & 0o077 ||
        (process.getuid && owner.uid !== process.getuid())
      )
        throw new OAuthBrokerError("secure-storage");
      const deadline = Date.now() + 30_000;
      while (!tryLock(fd)) {
        if (Date.now() >= deadline) throw new OAuthBrokerError("busy");
        await Bun.sleep(25);
      }
      return await action();
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        release();
        if (queues.get(path) === turn) queues.delete(path);
      }
    }
  }

  async update<T>(action: (data: AccountMetadata) => Promise<T>, committed?: () => void): Promise<T> {
    return this.exclusive("metadata", async () => {
      const data = this.read() ?? {
        version: 1 as const,
        hostId: `urn:uuid:${randomUUID()}`,
        accounts: [],
        credentialRefs: {},
        authorizationGenerations: {},
        pendingCredentialRefs: {},
      };
      const result = await action(data);
      this.write(data);
      committed?.();
      return result;
    });
  }
}

export function publicAccount(account: ManagedOAuthAccount): ManagedOAuthAccount {
  return {
    accountId: account.accountId,
    clientId: account.clientId,
    issuer: account.issuer,
    subject: account.subject,
    ...(account.email === undefined ? {} : { email: account.email }),
    label: account.label,
    status: account.status,
    planEnabled: account.planEnabled,
    ...(account.planEnabled ? { planLabel: "ChatGPT plan" } : {}),
    ...(account.credentialVersion === undefined ? {} : { credentialVersion: account.credentialVersion }),
  };
}
