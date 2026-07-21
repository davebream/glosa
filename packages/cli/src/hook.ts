// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa hook <event>` (A6 §F26's hook entries + A2's per-event roles). Every
// handler here is deliberately thin: parse the hook JSON on stdin, call the injected
// `DaemonHookClient`/`RewakeCoordinator`, print the right hook JSON on stdout, return the right
// exit code. Nothing here writes the transcript or any glosa state file directly — the daemon API
// (or, for the rewake lease, the coordinator's own lease file — a CLI-local watcher-liveness
// concern, not workspace state) is the only thing that ever gets mutated.
import { ClaudeCodeProvider } from "../../providers/claude-code/src/index.ts";
import type { RewakeCoordinator, RewakeLeaseStore } from "../../providers/claude-code/src/index.ts";
import type { DaemonHookClient } from "./daemon-client.ts";

export type HookEvent = "session-start" | "rewake-watch" | "session-end" | "user-prompt-submit" | "stop" | "notification";

export interface HookDeps {
  daemonClient: DaemonHookClient;
  rewake: RewakeCoordinator;
  /** `rewake-watch` only — the SAME lease store backing `rewake`, so the watcher can release its
   * OWN lease the instant it decides to wake Claude (rather than waiting out `staleMs` for the
   * Stop hook's rearm to notice it's gone). Optional: omitting it just means the Stop hook's
   * rearm is delayed until the lease goes stale, still correct, just slower. */
  leases?: RewakeLeaseStore;
  /** `rewake-watch` only — how many times to poll before giving up for this invocation (Claude
   * Code owns re-invocation for a fresh SessionStart; the Stop-hook rearm, not a longer poll
   * loop, is what covers every entry AFTER the first — see rewake.ts's header comment). Real
   * live-session behavior is the P5.4 rehearsal's job; this just has to poll correctly. */
  rewakePollAttempts?: number;
  rewakePollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const provider = new ClaudeCodeProvider({ liveness: { liveness: () => "stale" } }); // detectSession/liveness delegate is unused for detectSession itself

function ok(stdout = ""): HookOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}
function usageError(message: string): HookOutcome {
  return { exitCode: 2, stdout: "", stderr: message };
}

async function handleSessionStart(input: unknown, deps: HookDeps): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("session-start: hook input missing session_id/cwd");

  await deps.daemonClient.register({
    session_id: session.session_id,
    provider: "claude-code",
    cwd: session.workspace,
    source: session.source,
    ...(session.transcript_path !== undefined ? { transcript_path: session.transcript_path } : {}),
  });
  deps.rewake.onSessionStart(session.session_id);
  // A2 §F08: "the next SessionStart in the SAME workspace automatically drains" any parked
  // entries — draining here (rather than waiting for the first UserPromptSubmit/Stop) is what
  // makes that drain immediate rather than delayed one full turn. SessionStart surfaces via the
  // same additionalContext shape UserPromptSubmit does, so it shares that `via` value.
  const drained = await deps.daemonClient.drain(session.session_id, { via: "userprompt" });
  if (drained.count === 0) return ok();
  return ok(JSON.stringify(userPromptSubmitContext(drained.drained)));
}

async function handleSessionEnd(input: unknown, deps: HookDeps): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("session-end: hook input missing session_id/cwd");
  await deps.daemonClient.deregister(session.session_id);
  deps.rewake.onSessionEnd(session.session_id);
  return ok();
}

function userPromptSubmitContext(drained: { id: string; kind: string }[]): unknown {
  const summary = drained.map((e) => `${e.kind} ${e.id}`).join(", ");
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `glosa: ${drained.length} inbox entr${drained.length === 1 ? "y" : "ies"} pending (${summary})`,
    },
  };
}

async function handleUserPromptSubmit(input: unknown, deps: HookDeps): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("user-prompt-submit: hook input missing session_id/cwd");
  await deps.daemonClient.heartbeat(session.session_id);
  const drained = await deps.daemonClient.drain(session.session_id, { via: "userprompt" });
  if (drained.count === 0) return ok();
  return ok(JSON.stringify(userPromptSubmitContext(drained.drained)));
}

async function handleStop(input: unknown, deps: HookDeps): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("stop: hook input missing session_id/cwd");
  await deps.daemonClient.heartbeat(session.session_id);
  // Bounded drain (A6 §F26: "≤8"; the daemon route itself also caps at 8 — belt and suspenders).
  await deps.daemonClient.drain(session.session_id, { limit: 8, via: "stop" });
  // The asyncRewake rearm (A2 §F07) — the one-shot watcher launched at SessionStart has very
  // likely already exited by now; this is what re-arms it for the NEXT entry.
  deps.rewake.onStop(session.session_id);
  return ok();
}

async function handleNotification(input: unknown, deps: HookDeps): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("notification: hook input missing session_id/cwd");
  await deps.daemonClient.heartbeat(session.session_id);
  // R9's "hook-fed attention state" — the daemon-side attention model (open/delivered/seen/
  // done|expired|stale) is F12/P4.4 scope; this hook's OWN job ends at keeping the session's
  // lease fresh so it doesn't go stale while Claude is between turns waiting on the user.
  return ok();
}

/** `rewake-watch` (A2 §F07) — polls up to `rewakePollAttempts` times (default a handful, fast
 * interval) for anything this session's workspace has waiting that has never been drained. Finds
 * something → releases its OWN lease (so the Stop hook's next `armIfNeeded` sees "not active" and
 * rearms promptly instead of waiting out `staleMs`) and exits 2 with the F07 stderr reminder.
 * Finds nothing after every attempt → exits 0 (F07: "normal, no new entries yet"). */
async function handleRewakeWatch(input: unknown, deps: HookDeps, watcherPid: number): Promise<HookOutcome> {
  const session = provider.detectSession(input);
  if (!session) return usageError("rewake-watch: hook input missing session_id/cwd");

  const attempts = deps.rewakePollAttempts ?? 1;
  const intervalMs = deps.rewakePollIntervalMs ?? 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i++) {
    const drained = await deps.daemonClient.drain(session.session_id, { limit: 1, via: "asyncRewake" });
    if (drained.count > 0) {
      // Release THIS watcher's own lease by pid (not `rewake.onSessionEnd`, which is a different
      // event entirely — the session ending, not this one watcher exiting) so the Stop hook's
      // rearm sees "not active" immediately rather than waiting out `staleMs`.
      deps.leases?.release(session.session_id, watcherPid);
      const entry = drained.drained[0];
      return {
        exitCode: 2,
        stdout: "",
        stderr: `glosa: inbox/${entry?.id ?? "?"} pending (via asyncRewake) [watcher pid ${watcherPid}]`,
      };
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return ok();
}

export async function runHook(event: string, input: unknown, deps: HookDeps, watcherPid = process.pid): Promise<HookOutcome> {
  switch (event as HookEvent) {
    case "session-start":
      return handleSessionStart(input, deps);
    case "session-end":
      return handleSessionEnd(input, deps);
    case "user-prompt-submit":
      return handleUserPromptSubmit(input, deps);
    case "stop":
      return handleStop(input, deps);
    case "notification":
      return handleNotification(input, deps);
    case "rewake-watch":
      return handleRewakeWatch(input, deps, watcherPid);
    default:
      return usageError(`glosa hook: unknown event '${event}'`);
  }
}
