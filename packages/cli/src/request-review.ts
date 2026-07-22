// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa request-review <path> [--message] [--action] [--wait <duration>]` (A5 §F23's
// attention axis, A6 §F26). Creates an `attention_request` entry in the CURRENT WORKING
// DIRECTORY's workspace (same cwd-scoping convention `resolve`/`apply-begin` use); `<path>` names
// the artifact the review concerns and rides along as informational payload only — no anchoring
// (that's `POST /w/:slug/annotations`'s job, a different entry kind; see
// `handleWorkspaceAttentionRequest`'s docstring in http.ts). `--wait` polls
// `GET /api/workspaces/entry-status` until the entry reaches a terminal attention status
// (`done|expired|stale`, A5 §F23) and reports the verdict in `data`; without it, returns
// immediately after creating the entry. Review requests default to action `review`; the terminal
// journal detail carries the structured outcome and optional response.
import { type ApiError, type EntryStatus, type GlosaApiClient, isApiError } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, daemonUnreachableEnvelope, printJsonEnvelope, usageEnvelope } from "./envelope.ts";

export interface RequestReviewArgs {
  dir: string;
  path?: string;
  message?: string;
  action?: string;
  waitMs?: number; // undefined = don't wait
}

export interface RequestReviewData {
  id?: string;
  slug?: string;
  status?: string;
  detail?: Record<string, unknown> | null;
}

export interface RequestReviewDeps {
  createClient: () => Promise<GlosaApiClient>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
}

export function realRequestReviewDeps(createClient: () => Promise<GlosaApiClient>): RequestReviewDeps {
  return {
    createClient,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 1000,
  };
}

const ATTENTION_TERMINALS: ReadonlySet<string> = new Set(["done", "expired", "stale"]);

export async function runRequestReview(args: RequestReviewArgs, deps: RequestReviewDeps): Promise<CommandEnvelope<RequestReviewData>> {
  if (!args.path) return usageEnvelope("request-review", "request-review: missing <path>");

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("request-review", (err as Error).message), data: {} };
  }

  let created: { id: string; slug: string; status: string };
  try {
    created = await client.createAttentionRequest(args.dir, { message: args.message, action: args.action ?? "review", targetPath: args.path });
  } catch (err) {
    if (isApiError(err)) {
      return {
        ok: false,
        command: "request-review",
        exitCode: EXIT_CODES.NOT_A_WORKSPACE,
        data: {},
        warnings: [],
        error: { code: "not-a-workspace", kind: "not_a_workspace", message: (err as ApiError).problem?.title ?? err.message },
      };
    }
    return { ...daemonUnreachableEnvelope("request-review", (err as Error).message), data: {} };
  }

  if (args.waitMs === undefined) {
    return {
      ok: true,
      command: "request-review",
      exitCode: EXIT_CODES.OK,
      data: { id: created.id, slug: created.slug, status: created.status },
      warnings: [],
    };
  }

  const deadline = deps.now() + args.waitMs;
  for (;;) {
    let entryStatus: EntryStatus | null;
    try {
      entryStatus = await client.getEntryStatus(args.dir, created.id);
    } catch {
      entryStatus = null; // a transient poll failure isn't fatal — keep polling until the deadline
    }
    if (entryStatus && ATTENTION_TERMINALS.has(entryStatus.status)) {
      return {
        ok: true,
        command: "request-review",
        exitCode: EXIT_CODES.OK,
        data: { id: created.id, slug: created.slug, status: entryStatus.status, detail: entryStatus.detail },
        warnings: [],
      };
    }
    if (deps.now() >= deadline) {
      return {
        ok: false,
        command: "request-review",
        exitCode: EXIT_CODES.REVIEW_TIMEOUT,
        data: { id: created.id, slug: created.slug, status: entryStatus?.status ?? created.status },
        warnings: [],
        error: {
          code: "review-timeout",
          kind: "review_timeout",
          message: `request-review: timed out waiting for a verdict on ${created.id}`,
        },
      };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

export function printRequestReviewResult(result: CommandEnvelope<RequestReviewData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa request-review: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  const outcome = typeof result.data.detail?.outcome === "string" ? `: ${result.data.detail.outcome}` : "";
  const response = typeof result.data.detail?.response === "string" ? ` — ${result.data.detail.response}` : "";
  process.stdout.write(`glosa request-review: ${result.data.id} (${result.data.status}${outcome})${response}\n`);
}
