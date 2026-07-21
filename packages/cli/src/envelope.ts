// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — the shared `--json` envelope shape + stable exit codes (A6 §F26). Every P5.1
// command builds a `CommandEnvelope<T>` and hands it to `printJsonEnvelope`/its own human-mode
// printer, so every command's `--json` output is byte-for-byte the same shape `init` already
// established in index.ts's `printInitResult` — this file exists so that shape has ONE definition
// instead of six drifting copies.
export interface CommandWarning {
  code: string;
  message: string;
}

export interface CommandError {
  code: string;
  kind: string;
  message: string;
  hint?: string;
}

export interface CommandEnvelope<T> {
  ok: boolean;
  command: string;
  exitCode: number;
  data: T;
  warnings: CommandWarning[];
  error?: CommandError | null;
}

/** A6 §F26's stable exit codes — append-only, `1` reserved/never emitted. */
export const EXIT_CODES = {
  OK: 0,
  USAGE: 2,
  DAEMON_UNREACHABLE: 3,
  NOT_A_WORKSPACE: 4,
  PLATFORM_UNSUPPORTED: 5,
  FOREIGN_CONFIG_CONFLICT: 6,
  REVIEW_TIMEOUT: 7,
  ENTRY_ERROR: 8,
  DEGRADED: 9,
  PROTOCOL_MISMATCH: 10,
  RESTORE_CONFLICT: 11,
  LEASE_CONFLICT: 12,
  INTERNAL: 70,
} as const;

export function printJsonEnvelope<T>(env: CommandEnvelope<T>): void {
  process.stdout.write(
    `${JSON.stringify({
      glosa_json: 1,
      ok: env.ok,
      command: env.command,
      exit_code: env.exitCode,
      data: env.data,
      warnings: env.warnings,
      error: env.error ?? null,
    })}\n`,
  );
}

/** A usage-error envelope (exit 2) — the shape every command's "missing/bad argument" path
 * returns before it ever tries to reach the daemon. */
export function usageEnvelope(command: string, message: string): CommandEnvelope<Record<string, never>> {
  return {
    ok: false,
    command,
    exitCode: EXIT_CODES.USAGE,
    data: {},
    warnings: [],
    error: { code: "usage", kind: "usage", message },
  };
}

/** A daemon-unreachable envelope (exit 3) — every command that talks to the daemon returns this
 * when `createClient()` (or the specific call it makes) throws a non-API error (network refused,
 * `ensureDaemon` failed, spawn timed out, ...). */
export function daemonUnreachableEnvelope(command: string, message: string): CommandEnvelope<Record<string, never>> {
  return {
    ok: false,
    command,
    exitCode: EXIT_CODES.DAEMON_UNREACHABLE,
    data: {},
    warnings: [],
    error: { code: "daemon-unreachable", kind: "daemon_unreachable", message },
  };
}

/** Parses `--wait`'s duration argument: a bare integer is seconds; `<n>ms|s|m|h` is an explicit
 * unit. Returns `null` for anything unparseable (the caller turns that into a usage error) rather
 * than silently defaulting — a mistyped `--wait 5mm` must not silently wait 5 seconds instead. */
export function parseDurationMs(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] ?? "s";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit] as number;
  return Math.round(n * factor);
}
