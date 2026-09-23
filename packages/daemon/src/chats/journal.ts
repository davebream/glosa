// SPDX-License-Identifier: Apache-2.0
// Private, fail-closed executable-intent journal. Workspace bus recovery remains unchanged.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ManagedAgentError } from "../agents/interface.ts";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";

const MAX_RECORD = 65_536;
const envelope = z
  .object({
    schema: z.literal(1),
    seq: z.number().int().positive(),
    eventId: z.uuid(),
    at: z.iso.datetime(),
    requestId: z.uuid().optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    data: z.unknown(),
    result: z.unknown().optional(),
  })
  .strict();
export type JournalRecord<T> = Omit<z.infer<typeof envelope>, "data"> & { data: T };

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("private state requires an absolute path");
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    const parent = dirname(absolute);
    if (parent !== absolute) privateDirectory(parent);
    mkdirSync(absolute, { mode: 0o700 });
    fsyncContainingDir(absolute);
  }
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new ManagedAgentError("unsafe-state-path", "Managed state has an unsafe directory.", 503);
  }
  return absolute;
}

function assertPrivateFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe managed state file");
  fchmodSync(fd, 0o600);
}

export class IntentJournal<T> {
  readonly records: JournalRecord<T>[] = [];
  readonly receipts = new Map<string, JournalRecord<T>>();
  readonly listeners = new Set<(record: JournalRecord<T>) => void>();
  private fd: number | undefined;
  private failed = false;

  constructor(
    readonly path: string,
    private readonly schema: z.ZodType<T>,
  ) {
    // Opening history never creates files or launches a process.
    if (!existsSync(path)) return;
    privateDirectory(dirname(path));
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      assertPrivateFile(fd);
      if (fstatSync(fd).size > 64 * 1024 * 1024) throw new Error("journal exceeds replay capacity");
      const bytes = readFileSync(fd);
      let start = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end);
        if (line.length >= MAX_RECORD) throw new Error("oversize journal record");
        const record = envelope.parse(JSON.parse(line.toString("utf8")));
        if (record.seq !== this.records.length + 1) throw new Error("journal sequence mismatch");
        if (!!record.requestId !== !!record.digest) throw new Error("incomplete journal receipt");
        const typed = { ...record, data: schema.parse(record.data) };
        if (record.requestId && this.receipts.has(record.requestId)) throw new Error("duplicate receipt");
        this.records.push(typed);
        if (record.requestId) this.receipts.set(record.requestId, typed);
        start = end + 1;
      }
      if (start !== bytes.length) {
        const quarantine = `${path}.torn-${randomUUID()}`;
        const tail = openSync(quarantine, "wx", 0o600);
        try {
          writeAllSync(tail, bytes.subarray(start));
          fsyncSync(tail);
        } finally {
          closeSync(tail);
        }
        fsyncContainingDir(quarantine);
        ftruncateSync(fd, start);
        fsyncSync(fd);
      }
    } catch {
      this.failed = true;
      throw new ManagedAgentError("journal-corrupt", "This chat's journal needs recovery; execution is blocked.", 503);
    } finally {
      closeSync(fd);
    }
  }

  get revision(): number {
    return this.records.length;
  }

  receipt(requestId: string, input: unknown): { found: boolean; result?: unknown } {
    z.uuid().parse(requestId);
    const record = this.receipts.get(requestId);
    if (!record) return { found: false };
    if (record.digest !== digest(input))
      throw new ManagedAgentError("idempotency-conflict", "Request ID was reused with different input.");
    return { found: true, result: structuredClone(record.result) };
  }

  append(data: T, request?: { id: string; input: unknown; result: unknown }): JournalRecord<T> {
    if (this.failed) throw new ManagedAgentError("journal-unavailable", "Managed state is unavailable.", 503);
    const validated = this.schema.parse(data);
    if (request && this.receipt(request.id, request.input).found) return this.receipts.get(request.id)!;
    const record: JournalRecord<T> = {
      schema: 1,
      seq: this.revision + 1,
      eventId: randomUUID(),
      at: new Date().toISOString(),
      data: validated,
      ...(request ? { requestId: request.id, digest: digest(request.input), result: request.result } : {}),
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > MAX_RECORD)
      throw new ManagedAgentError("event-too-large", "Managed event exceeds its size limit.", 413);
    if (this.fd === undefined) {
      privateDirectory(dirname(this.path));
      const existed = existsSync(this.path);
      this.fd = openSync(
        this.path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      assertPrivateFile(this.fd);
      if (!existed) fsyncContainingDir(this.path);
    }
    const before = fstatSync(this.fd).size;
    if (before + bytes.length > 64 * 1024 * 1024)
      throw new ManagedAgentError(
        "storage-unavailable",
        "This journal reached its storage limit. Export the chat and start a new one.",
        507,
      );
    try {
      writeAllSync(this.fd, bytes);
      fsyncSync(this.fd);
    } catch {
      this.failed = true;
      try {
        ftruncateSync(this.fd, before);
        fsyncSync(this.fd);
      } catch {
        /* replay remains fail-closed */
      }
      throw new ManagedAgentError("storage-unavailable", "Could not persist managed state. Execution is stopped.", 503);
    }
    this.records.push(record);
    if (request) this.receipts.set(request.id, record);
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        try {
          listener(record);
        } catch {
          /* a disconnected subscriber never reverses committed state */
        }
      }
    });
    return record;
  }

  close(): void {
    this.listeners.clear();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    this.failed = true;
  }
}

export function putBlob(root: string, bytes: Uint8Array): string {
  if (bytes.byteLength > 10 * 1024 * 1024)
    throw new ManagedAgentError("attachment-too-large", "Attachment exceeds 10 MiB.", 413);
  const hash = createHash("sha256").update(bytes).digest("hex");
  privateDirectory(root);
  const path = join(root, hash);
  if (existsSync(path)) {
    readBlob(root, hash);
    return hash;
  }
  const storedBytes = readdirSync(root).reduce((total, name) => {
    const stat = lstatSync(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new ManagedAgentError("unsafe-state-path", "Attachment storage needs recovery.", 503);
    return total + stat.size;
  }, 0);
  if (storedBytes + bytes.byteLength > 256 * 1024 * 1024)
    throw new ManagedAgentError(
      "storage-unavailable",
      "This chat reached its 256 MiB attachment limit. Export it and start a new chat.",
      507,
    );
  const temp = join(root, `.pending-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeAllSync(fd, Buffer.from(bytes));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncContainingDir(path);
  return hash;
}

export function readBlob(root: string, hash: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new ManagedAgentError("invalid-blob", "Invalid attachment.", 422);
  const fd = openSync(join(root, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivateFile(fd);
    if (fstatSync(fd).size > 10 * 1024 * 1024)
      throw new ManagedAgentError("attachment-too-large", "Attachment exceeds its size limit.", 413);
    const bytes = readFileSync(fd);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("attachment integrity mismatch");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
