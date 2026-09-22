// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa resolve <id> <applied|rejected|deferred|stale> --session <sid> [--note]` and
// `glosa apply-begin <id> --session <sid>` (A4 §F05 / A6 §F26).
import { describe, expect, test } from "bun:test";
import {
  printApplyBeginResult,
  printResolveResult,
  runApplyBegin,
  runResolve,
  type ResolveDeps,
} from "../src/resolve.ts";
import type { GlosaApiClient } from "../src/api-client.ts";
import { printClaimResult, printReleaseResult, runClaim, runRelease } from "../src/claim.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

function makeClientDeps(client: FakeGlosaApiClient = new FakeGlosaApiClient()) {
  return { deps: { createClient: async () => client as unknown as GlosaApiClient }, client };
}

describe("cross-workspace scoping (the entry names the workspace, not the cwd)", () => {
  // An agent working in its own repo while reviewing documents elsewhere must be able to act on
  // its own inbox. Before `--workspace`, both commands were scoped to the caller's cwd, so such a
  // call silently targeted whatever workspace that directory belonged to and failed inside it.
  test("apply-begin sends the named workspace, not the caller's directory", async () => {
    const { deps, client } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/vault/notes", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    expect(client.calls[0]).toMatchObject({ method: "applyBegin", args: ["/vault/notes", "inb-1", "sess-1"] });
    expect((client.calls[0] as { args: string[] }).args[0]).not.toBe(process.cwd());
  });

  test("resolve sends the named workspace, not the caller's directory", async () => {
    const { deps, client } = makeClientDeps();
    const result = await runResolve({ dir: "/vault/notes", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    expect((client.calls[0] as { args: string[] }).args[0]).toBe("/vault/notes");
  });
});

describe("glosa resolve", () => {
  test("missing <id> -> exit 2 (usage), never touches the daemon", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("missing --session -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("bad <status> value -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "maybe-later", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps = {
      createClient: async () => {
        throw daemonUnreachable();
      },
    };
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(3);
    expect(result.error?.kind).toBe("daemon_unreachable");
  });

  test("unknown id (no matching apply-begin lease) -> exit 8 (entry_error)", async () => {
    const client = new FakeGlosaApiClient();
    client.resolveEntryImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/conflict",
        title: "no matching apply-begin lease for this entry/session",
      });
    };
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-unknown", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(8);
    expect(result.error?.kind).toBe("entry_error");
  });

  // A4 §F05: an apply-lease past its 15-minute TTL can no longer prove its interval, so the
  // daemon refuses the resolve (409 `conflict`) instead of attributing unproven drift. A6 §F26
  // keeps `resolve`'s exit set at 0;3;8;2 — so this is exit 8 like every other entry failure,
  // NOT apply-begin's exit 12. What has to survive the trip is the recovery step: `runResolve`
  // reports `problem.title` and never reads `detail`, so the title is where it must live.
  test("expired apply-lease -> exit 8 (entry_error) and the message still tells the operator to re-run apply-begin", async () => {
    const client = new FakeGlosaApiClient();
    client.resolveEntryImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/conflict",
        title: "the apply-lease for this entry expired — re-run apply-begin, then resolve again",
        detail: "past its TTL the lease could no longer prove its pre..post interval",
      });
    };
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(8);
    expect(result.error?.kind).toBe("entry_error");
    expect(result.error?.message).toContain("expired");
    expect(result.error?.message).toContain("apply-begin");
  });

  test("applied: calls resolveEntry with the note threaded through, returns exit 0", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runResolve(
      { dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1", note: "looks good" },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(client.calls[0]).toMatchObject({
      method: "resolveEntry",
      args: ["/repo", "inb-1", "applied", "sess-1", "looks good"],
    });
  });

  test("deferred: still calls resolveEntry (the daemon route decides not to touch the lease) and succeeds", async () => {
    const client = new FakeGlosaApiClient();
    client.resolveEntryImpl = async (path, entry) => ({ entry, status: "delivered", to: "deferred" });
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "deferred", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.data.to).toBe("deferred");
    expect(result.data.status).toBe("delivered"); // status did NOT move to a terminal value
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    const out = captureStdout(() => printResolveResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(
      ["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort(),
    );
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "resolve", exit_code: 0 });
  });
});

describe("glosa apply-begin", () => {
  test("missing <id> -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("missing --session -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps: ResolveDeps = {
      createClient: async () => {
        throw daemonUnreachable();
      },
    };
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(3);
  });

  test("another session holds the entry (contract 1.17 claim-held) -> exit 12, holder named in the message", async () => {
    // Issue #155 renamed the conflict. Ablating either half of the slug match drops that half to
    // the generic exit 8 and reds one of these two tests.
    const client = new FakeGlosaApiClient();
    client.applyBeginImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/claim-held",
        title: "session sess-A holds an exclusive claim on this until 2026-09-22T12:15:00.000Z",
      });
    };
    const { deps } = makeClientDeps(client);
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(12);
    expect(result.error).toMatchObject({ code: "claim-held", kind: "lease_conflict" });
    expect(result.error?.message).toContain("sess-A");
  });

  test("already-leased entry from an N-1 daemon (lease-conflict) -> still exit 12 (lease_conflict)", async () => {
    const client = new FakeGlosaApiClient();
    client.applyBeginImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/lease-conflict",
        title: "an apply-lease is already active for this workspace",
      });
    };
    const { deps } = makeClientDeps(client);
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(12);
    expect(result.error?.kind).toBe("lease_conflict");
  });

  test("success: prints the bare lease token in human mode", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    const out = captureStdout(() => printApplyBeginResult(result, false));
    expect(result.data.lease_id).toBeTruthy();
    expect(out.trim()).toBe(result.data.lease_id as string);
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    const out = captureStdout(() => printApplyBeginResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(
      ["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort(),
    );
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "apply-begin", exit_code: 0 });
  });
});

// Issue #155 — `glosa claim` / `glosa release`. Kept beside apply-begin, which is the one-entry
// shorthand for the same exclusive claim and shares its exit contract.
describe("glosa claim", () => {
  test("claims the named resources for the session, in the given mode, and prints the bare claim id", async () => {
    const { deps, client } = makeClientDeps();
    const result = await runClaim(
      { dir: "/repo", resources: ["entry:inb-1", "artifact:notes.md"], session: "sess-1", mode: "presence" },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(client.calls.find((call) => call.method === "claim")?.args).toEqual([
      "/repo",
      ["entry:inb-1", "artifact:notes.md"],
      "sess-1",
      { mode: "presence" },
    ]);
    const out = captureStdout(() => printClaimResult(result, false));
    expect(out.trim()).toBe("claim-1");
  });

  test("another session holding the files -> exit 12 (lease_conflict), holder named", async () => {
    const client = new FakeGlosaApiClient();
    client.claimImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/claim-held",
        title: "session sess-A holds an exclusive claim on this until 2026-09-22T12:15:00.000Z",
      });
    };
    const { deps } = makeClientDeps(client);
    const result = await runClaim({ dir: "/repo", resources: ["entry:inb-1"], session: "sess-1" }, deps);
    expect(result.exitCode).toBe(12);
    expect(result.error).toMatchObject({ code: "claim-held", kind: "lease_conflict" });
    expect(result.error?.message).toContain("sess-A");
  });

  test("any other daemon refusal -> exit 8 (entry_error)", async () => {
    const client = new FakeGlosaApiClient();
    client.claimImpl = async () => {
      throw apiError(404, { type: "https://glosa.local/errors/not-found", title: "no such inbox entry" });
    };
    const { deps } = makeClientDeps(client);
    expect((await runClaim({ dir: "/repo", resources: ["entry:nope"], session: "s" }, deps)).exitCode).toBe(8);
  });

  test("usage: no resources, a malformed resource, a bad mode, or no session -> exit 2, with no daemon call", async () => {
    for (const args of [
      { dir: "/repo", resources: [], session: "s" },
      { dir: "/repo", resources: ["notes.md"], session: "s" },
      { dir: "/repo", resources: ["entry:inb-1"], session: "s", mode: "loud" },
      { dir: "/repo", resources: ["entry:inb-1"] },
    ]) {
      const { deps, client } = makeClientDeps();
      const result = await runClaim(args, deps);
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 2 });
      expect(client.calls.filter((call) => call.method === "claim")).toHaveLength(0);
    }
  });
});

describe("glosa release", () => {
  test("releases the claim for the session; an already-ended claim is reported, not an error", async () => {
    const client = new FakeGlosaApiClient();
    let released = true;
    client.releaseClaimImpl = async (_path, claimId) => ({ claim_id: claimId, released });
    const { deps } = makeClientDeps(client);

    const first = await runRelease({ dir: "/repo", claimId: "claim-1", session: "sess-1" }, deps);
    expect(first.exitCode).toBe(0);
    expect(captureStdout(() => printReleaseResult(first, false))).toContain("released claim-1");

    released = false;
    const again = await runRelease({ dir: "/repo", claimId: "claim-1", session: "sess-1" }, deps);
    expect(again.exitCode).toBe(0);
    expect(captureStdout(() => printReleaseResult(again, false))).toContain("already released");
  });

  test("another session's claim -> exit 12, and a missing id or session -> exit 2", async () => {
    const client = new FakeGlosaApiClient();
    client.releaseClaimImpl = async () => {
      throw apiError(409, { type: "https://glosa.local/errors/claim-held", title: "session sess-A holds this" });
    };
    const { deps } = makeClientDeps(client);
    expect((await runRelease({ dir: "/repo", claimId: "claim-1", session: "sess-B" }, deps)).exitCode).toBe(12);
    expect((await runRelease({ dir: "/repo", session: "sess-B" }, deps)).exitCode).toBe(2);
    expect((await runRelease({ dir: "/repo", claimId: "claim-1" }, deps)).exitCode).toBe(2);
  });
});
