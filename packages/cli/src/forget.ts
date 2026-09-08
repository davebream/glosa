// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa forget <workspace> [--yes] [--json]` (issue #156): the one supported
// whole-bus deletion primitive. `<workspace>` is a SLUG (`glosa status --json` names one), not a
// path — the whole point of `forget` is that it must still work once a workspace's on-disk path
// is gone. Work-tree files are never touched; only the registration and its bus (journal, inbox,
// shadow-git, and any historical sealed loose-file source adopted into it) are removed.
//
// Interactive use previews the exact paths a deletion would remove and asks once before any side
// effect occurs — the daemon's `confirm:false` call is a pure preview (see
// `forget-workspace.ts`'s own docstring) so showing that preview never itself commits to
// anything. `--yes` skips the prompt and goes straight to the same guarded deletion. A
// non-interactive caller (no TTY, or `--json` — which must never block on a prompt it cannot
// render) without `--yes` is a usage error: there is no safe default for "the user did not say
// which way to go" on an irreversible action.
import type { ForgetBlocker, ForgetBusEntry, GlosaApiClient } from "./api-client.ts";
import { isApiError } from "./api-client.ts";
import {
  type CommandEnvelope,
  EXIT_CODES,
  daemonUnreachableEnvelope,
  printJsonEnvelope,
  usageEnvelope,
} from "./envelope.ts";

export interface ForgetDeps {
  createClient: () => Promise<GlosaApiClient>;
  /** Injectable TTY confirmation — defaults to `confirmOnTty` from `./confirm.ts`. Never called
   * when `--yes` was passed or the session is non-interactive. */
  confirm?: (question: string) => Promise<boolean>;
  /** Defaults to `process.stdin.isTTY`. Injectable so tests never depend on the real stdin. */
  isTTY?: () => boolean;
}

export interface ForgetArgs {
  slug?: string;
  yes?: boolean;
  json?: boolean;
}

export interface ForgetData {
  slug?: string;
  /** Present only when the workspace named on the command line was a sealed adopted source — the
   * daemon resolved it to the owning target and forgot the complete unit instead (issue #156
   * revised approach: a source is never an independent provenance unit). */
  requestedSlug?: string;
  cancelled?: boolean;
  removed?: ForgetBusEntry[];
  blockers?: ForgetBlocker[];
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { confirmOnTty } = await import("./confirm.ts");
  return confirmOnTty(question);
}

function previewQuestion(slug: string, entries: ForgetBusEntry[]): string {
  const paths = entries.map((entry) => `  ${entry.bus_path}`).join("\n");
  return (
    `glosa forget: this permanently deletes workspace '${slug}' — its registration, journal, ` +
    `inbox, and shadow-git history (work-tree files are never touched):\n${paths}\nProceed?`
  );
}

function mapForgetFailure(err: unknown): CommandEnvelope<ForgetData> {
  if (isApiError(err)) {
    if (err.status === 404) {
      return {
        ok: false,
        command: "forget",
        exitCode: EXIT_CODES.NOT_A_WORKSPACE,
        data: {},
        warnings: [],
        error: {
          code: "not-a-workspace",
          kind: "not_a_workspace",
          message: err.problem?.title ?? "unknown workspace",
        },
      };
    }
    if (err.status === 409 && err.problem?.type?.includes("forget-stale-preview")) {
      return {
        ok: false,
        command: "forget",
        exitCode: EXIT_CODES.LEASE_CONFLICT,
        data: {},
        warnings: [],
        error: {
          code: "forget-stale-preview",
          kind: "lease_conflict",
          message:
            err.problem?.title ??
            "the previewed member set changed before confirmation — re-run `glosa forget` to preview again",
        },
      };
    }
    if (err.status === 409 && err.problem?.type?.includes("forget-blocked")) {
      const blockers = ((err.problem as { blockers?: ForgetBlocker[] }).blockers ?? []) as ForgetBlocker[];
      return {
        ok: false,
        command: "forget",
        exitCode: EXIT_CODES.LEASE_CONFLICT,
        data: { blockers },
        warnings: [],
        error: {
          code: "forget-blocked",
          kind: "lease_conflict",
          message: err.problem?.title ?? "workspace has a live bound session or an unexpired apply lease",
        },
      };
    }
    return {
      ok: false,
      command: "forget",
      exitCode: EXIT_CODES.INTERNAL,
      data: {},
      warnings: [],
      error: { code: "forget-failed", kind: "internal", message: err.problem?.title ?? err.message },
    };
  }
  return { ...daemonUnreachableEnvelope("forget", (err as Error).message), data: {} };
}

export async function runForget(args: ForgetArgs, deps: ForgetDeps): Promise<CommandEnvelope<ForgetData>> {
  if (!args.slug) return usageEnvelope("forget", "forget: missing <workspace>");

  const interactive = !args.json && (deps.isTTY ?? (() => Boolean(process.stdin.isTTY)))();
  if (!args.yes && !interactive) {
    return usageEnvelope(
      "forget",
      "forget: refusing to delete without --yes outside an interactive terminal (no TTY, or --json)",
    );
  }

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("forget", (err as Error).message), data: {} };
  }

  // Held-review finding: interactive confirmation must be bound to the EXACT member set the human
  // was shown — carried below as `previewFingerprint` and echoed on the `confirm:true` call so the
  // daemon can refuse a stale confirmation (an adoption committing a new sealed source between the
  // preview and this point) instead of silently deleting a set the human never saw. `--yes` skips
  // the preview entirely, so there is nothing to bind and this stays `undefined`.
  let previewFingerprint: string | undefined;

  if (!args.yes) {
    let preview: Awaited<ReturnType<GlosaApiClient["forgetWorkspace"]>>;
    try {
      preview = await client.forgetWorkspace(args.slug, { confirm: false });
    } catch (err) {
      return mapForgetFailure(err);
    }
    const requestedSlug = preview.requested_slug;
    if (preview.confirmed) {
      // Defensive: `confirm:false` always answers `confirmed:false` server-side. Treat an
      // unexpected `true` as already-done rather than asking about paths already gone.
      return {
        ok: true,
        command: "forget",
        exitCode: EXIT_CODES.OK,
        data: { slug: preview.slug, requestedSlug, removed: preview.removed },
        warnings: [],
      };
    }
    previewFingerprint = preview.member_fingerprint;
    const proceed = await (deps.confirm ?? defaultConfirm)(previewQuestion(preview.slug, preview.would_remove));
    if (!proceed) {
      return {
        ok: true,
        command: "forget",
        exitCode: EXIT_CODES.OK,
        data: { slug: preview.slug, requestedSlug, cancelled: true },
        warnings: [],
      };
    }
  }

  try {
    const result = await client.forgetWorkspace(args.slug, { confirm: true, memberFingerprint: previewFingerprint });
    return {
      ok: true,
      command: "forget",
      exitCode: EXIT_CODES.OK,
      data: {
        slug: result.slug,
        requestedSlug: result.requested_slug,
        removed: result.confirmed ? result.removed : [],
      },
      warnings: [],
    };
  } catch (err) {
    return mapForgetFailure(err);
  }
}

export function printForgetResult(result: CommandEnvelope<ForgetData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa forget: ${result.error?.message ?? "failed"}\n`);
    for (const blocker of result.data.blockers ?? []) {
      process.stderr.write(
        blocker.kind === "live-session"
          ? `  blocked by live session ${blocker.session_id}\n`
          : blocker.kind === "apply-lease"
            ? `  blocked by apply lease ${blocker.lease_id} (expires ${blocker.expires_at})\n`
            : "  blocked by an adoption already in progress for this workspace\n",
      );
    }
    return;
  }
  if (result.data.requestedSlug) {
    process.stdout.write(
      `glosa forget: '${result.data.requestedSlug}' is a sealed source adopted into workspace '${result.data.slug}' — forgetting the complete workspace instead\n`,
    );
  }
  if (result.data.cancelled) {
    process.stdout.write("glosa forget: cancelled, nothing was removed\n");
    return;
  }
  process.stdout.write(`glosa forget: removed workspace '${result.data.slug}'\n`);
  for (const entry of result.data.removed ?? []) process.stdout.write(`  ${entry.bus_path}\n`);
}
