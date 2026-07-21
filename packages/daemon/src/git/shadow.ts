// @glosa/daemon — shadow-git mechanics (A4 §F21). The daemon is the SOLE git operator for a
// workspace's `.glosa/shadow.git`, serialized by the same per-workspace mutex the journal uses
// (bus.ts wraps every call here in `KeyedMutex.runExclusive` — this module itself holds no lock,
// it just assumes one is already held by the caller, exactly like `journal.ts`'s append does).
//
// Every git invocation goes through `runGit`: an argv array (never a shell string), always pinned
// at this workspace's shadow repo via `--git-dir`/`--work-tree`, with an isolated config
// environment so the user's own `~/.gitconfig` can never leak in and change behavior underneath
// us. Attribution/kind/entry/lease ride in commit TRAILERS, never in the git author/committer
// identity — that identity is the constant `glosa <glosa@localhost>` regardless of who's credited
// for the content (A4 §F21: "attribution in commit TRAILERS not author").
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { appendEvent, type JournalWriter } from "../bus/journal.ts";
import { shadowGitDir } from "../bus/paths.ts";
import { resolveMatchedFiles } from "../matcher.ts";

export const GLOSA_BRANCH = "glosa";
const GIT_IDENTITY_NAME = "glosa";
const GIT_IDENTITY_EMAIL = "glosa@localhost";

/** Content attribution — what the `Glosa-Attribution` trailer carries. Distinct from
 * `journal.ts`'s `EventBy` (which is about who performed a *daemon action*, and additionally
 * allows `daemon`/`watcher`): this is specifically "who is credited for this file content",
 * where the only proven answer is a lease-bracketed `session:<id>`; everything the daemon can't
 * prove stays `unknown`, never falsely `human` (A4 §F05). glosa-editor-API writes being `human`
 * by construction is a caller concern (P2.4+), not this module's. */
export type Attribution = "human" | "unknown" | `session:${string}`;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitFailedError extends Error {
  code: "GIT_FAILED";
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitFailedError(argv: string[], result: GitResult): GitFailedError {
  const err = new Error(
    `git ${argv.slice(1).join(" ")} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`,
  ) as GitFailedError;
  err.code = "GIT_FAILED";
  err.argv = argv;
  err.exitCode = result.exitCode;
  err.stdout = result.stdout;
  err.stderr = result.stderr;
  return err;
}

/** Builds the env every shadow-git call runs under: `ANTHROPIC_API_KEY` scrubbed (never let a
 * spawned child inherit it — docs/CLAUDE.md invariant 5, mirrors `home.ts#buildChildEnv`); and
 * **every ambient `GIT_*` var dropped during the copy** — not just `GIT_CONFIG_*`. This is a hard
 * isolation requirement, not a nicety: `runGit` always passes `--git-dir`/`--work-tree` on argv, so
 * shadow-git needs ZERO inherited git vars, and a leaked one actively breaks correctness:
 *   - `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_OBJECT_DIRECTORY` can redirect the op to the
 *     wrong repo; `GIT_INDEX_FILE` forces a foreign index (this is exactly what happens when the
 *     daemon/tests run inside a git hook — e.g. our own pre-commit hook sets these, hijacking the
 *     shadow ops onto the main repo's index);
 *   - `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` + `GIT_CONFIG_PARAMETERS` are
 *     an env-based config source that OUTRANKS `GIT_CONFIG_GLOBAL=/dev/null`.
 * So we strip the whole `GIT_` namespace, then re-pin only the exact vars a shadow op wants below.
 * `extra` layers on top for the one case (committing) that also needs `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
 * pinned to the constant glosa identity. */
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && key !== "ANTHROPIC_API_KEY" && !key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  return { ...env, ...extra };
}

/** Guards a pathspec argument against being misread as a git option (A3 §5 attack #5, applied at
 * the git layer): a path starting with `-` gets a `./` prefix so git's argv parser can never treat
 * it as a flag. Combined with every pathspec always following a literal `--` (below), this is what
 * makes a tracked file literally named `-weird.md` safe to stage. */
export function safePathspec(path: string): string {
  return path.startsWith("-") ? `./${path}` : path;
}

export interface RunGitOptions {
  /** Exit codes besides 0 that are meaningful outcomes, not failures — e.g. `diff --quiet`'s 1
   * ("differs") or `rev-parse --verify -q`'s 1 ("no such ref yet"). Defaults to `[0]`. */
  allowExitCodes?: number[];
  env?: Record<string, string>;
}

/** Spawns system git as an argv array — NEVER a shell string — always scoped to this workspace's
 * shadow repo. `args` are everything after `git`; `--git-dir`/`--work-tree` are injected here so
 * no call site can forget them (and thus accidentally operate on the user's own repo, if the
 * workspace happens to be one). */
export async function runGit(root: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const argv = ["git", `--git-dir=${shadowGitDir(root)}`, `--work-tree=${root}`, ...args];
  const proc = Bun.spawn({
    cmd: argv,
    cwd: root,
    env: opts.env ?? isolatedEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result: GitResult = { stdout, stderr, exitCode };
  const allowed = opts.allowExitCodes ?? [0];
  if (!allowed.includes(exitCode)) throw gitFailedError(argv, result);
  return result;
}

export function indexLockPath(root: string): string {
  return `${shadowGitDir(root)}/index.lock`;
}

export interface ReclaimIndexLockDeps {
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
}

/** If `index.lock` is present, unlinks it and records `git_index_lock_reclaimed`. Safe
 * unconditionally: the daemon-singleton invariant (A5 §F13) guarantees this process is the ONLY
 * git operator for this workspace, so a leftover lock can only be a stale remnant of a git
 * process that died mid-operation on a PREVIOUS run — never a concurrent live writer racing us
 * right now (A4 §F21). Call before the first git op of a session and again at reconcile. */
export function reclaimIndexLock(root: string, deps: ReclaimIndexLockDeps): boolean {
  const lockFile = indexLockPath(root);
  if (!existsSync(lockFile)) return false;
  unlinkSync(lockFile);
  // Force fsync despite not being in journal.ts's lifecycle-critical set — this is a rare
  // startup/repair event (mirrors truncateTornTail's own reasoning for journal_tail_truncated),
  // so the repair itself should be durable before anything downstream trusts the reclaimed state.
  appendEvent(
    deps.writer,
    {
      v: 1,
      event_id: deps.ulid(),
      at: (deps.now?.() ?? new Date()).toISOString(),
      event: "git_index_lock_reclaimed",
      by: "daemon",
    },
    { fsync: true },
  );
  return true;
}

interface CommitOptions {
  message: string;
  trailers: Record<string, string>;
  allowEmpty?: boolean;
}

export interface TrailerInjectionError extends Error {
  code: "TRAILER_INJECTION";
  key: string;
}

function trailerInjectionError(key: string): TrailerInjectionError {
  const err = new Error(
    `refusing to commit: trailer value for "${key}" contains a control character (\\n/\\r) — this could forge a second, independently-parseable trailer line in the commit message`,
  ) as TrailerInjectionError;
  err.code = "TRAILER_INJECTION";
  err.key = key;
  return err;
}

async function commit(root: string, opts: CommitOptions): Promise<string> {
  // A trailer value with an embedded `\n`/`\r` could inject its own `Key: Value` line (e.g. an
  // attribution value of `unknown\nGlosa-Attribution: human` would forge a second,
  // independently-parseable `Glosa-Attribution: human` trailer below the real one) — this is the
  // provenance layer, so it defends its own message format even though nothing outside this
  // module calls `checkpoint()` with attacker-controlled values today.
  for (const [key, value] of Object.entries(opts.trailers)) {
    if (/[\r\n]/.test(value)) throw trailerInjectionError(key);
  }
  const trailerLines = Object.entries(opts.trailers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const fullMessage = `${opts.message}\n\n${trailerLines}\n`;
  const identityEnv = isolatedEnv({
    GIT_AUTHOR_NAME: GIT_IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: GIT_IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY_EMAIL,
  });
  await runGit(root, ["commit", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", fullMessage], {
    env: identityEnv,
  });
  return headSha(root);
}

export async function headSha(root: string): Promise<string> {
  const result = await runGit(root, ["rev-parse", "HEAD"]);
  return result.stdout.trim();
}

/** `git diff -M a b` — renames surface here (`-M`), not at write time; nothing about staging
 * needs to know about them. */
export async function diffShas(root: string, a: string, b: string): Promise<string> {
  const result = await runGit(root, ["diff", "-M", a, b]);
  return result.stdout;
}

/** The union `resolveMatchedFiles(root).tracked ∪ HEAD-tracked-under-ruleset` (A4 §F21) — needed
 * so a deletion (file no longer on disk, so absent from `tracked`, but still present in HEAD's
 * tree) still gets staged by `git add -A -- <union>` instead of being silently left uncommitted.
 * Reads HEAD's tree directly (`ls-tree`, not `ls-files`/the index) so a partially-staged index
 * from an interrupted previous call can't skew the union.
 *
 * Uses `-z` (NUL-delimited, never C-quoted) rather than plain newline-delimited output: git
 * C-quotes a filename containing a tab/newline/quote/backslash REGARDLESS of `core.quotepath`
 * (that setting only controls quoting of non-ASCII bytes — see `initShadowRepo`'s comment on
 * that). A tracked file with a literal `\n` in its name would otherwise come back from plain
 * `ls-tree` as a quoted string like `"evil\nname.md"` that can never match `currentTracked`'s
 * real path — poisoning the union so the next `git add -- <union>` fatals on a pathspec that
 * doesn't exist, wedging every future checkpoint for this workspace. `-z` output is raw bytes,
 * never quoted, so this holds for ANY filename git can track. */
async function trackedUnion(root: string, currentTracked: string[]): Promise<string[]> {
  const result = await runGit(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], { allowExitCodes: [0, 128] });
  const headTracked = result.exitCode === 0 ? result.stdout.split("\0").filter((line) => line.length > 0) : [];
  return [...new Set([...currentTracked, ...headTracked])].sort();
}

export interface InitShadowRepoDeps {
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
}

/** Deterministic init (A4 §F21): `git init`, pin `HEAD` to `refs/heads/glosa` (never whatever
 * `init.defaultBranch` would otherwise pick), the fixed repo-local config, then a baseline commit
 * capturing whatever's on disk right now — attributed `unknown` because nothing proves who put it
 * there. Idempotent: `git init`/`git config` on an already-initialized repo are themselves no-ops,
 * and the baseline commit is skipped once `HEAD` already resolves to something (this call, or any
 * later checkpoint). Safe to call before every lease/checkpoint operation, not just once at
 * startup — the redundant `init`/`config` calls are cheap and this is never a hot loop. */
export async function initShadowRepo(root: string, deps: InitShadowRepoDeps): Promise<void> {
  mkdirSync(shadowGitDir(root), { recursive: true });
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["symbolic-ref", "HEAD", `refs/heads/${GLOSA_BRANCH}`]);
  await runGit(root, ["config", "core.autocrlf", "false"]);
  await runGit(root, ["config", "core.safecrlf", "false"]);
  await runGit(root, ["config", "commit.gpgsign", "false"]);
  await runGit(root, ["config", "core.fileMode", "false"]);
  // Not in F21's explicit config list, but load-bearing for `trackedUnion` below: without this,
  // git octal-quotes any path with a non-ASCII byte in plain (non-`-z`) `ls-tree`/`ls-files`
  // output (e.g. `"a caf\303\251 note.md"`), which would never match `resolveMatchedFiles`'s real
  // path string — silently breaking the union for exactly the unicode filenames A3 §5 attack #5
  // is meant to cover.
  await runGit(root, ["config", "core.quotepath", "false"]);

  const head = await runGit(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowExitCodes: [0, 1] });
  if (head.exitCode === 0) return; // a baseline (or later) commit already exists

  const tracked = resolveMatchedFiles(root).tracked.map((f) => f.path);
  if (tracked.length > 0) await runGit(root, ["add", "-A", "--", ...tracked.map(safePathspec)]);
  await commit(root, {
    message: "checkpoint",
    trailers: { "Glosa-Attribution": "unknown", "Glosa-Kind": "baseline" },
    allowEmpty: true,
  });
  appendEvent(deps.writer, {
    v: 1,
    event_id: deps.ulid(),
    at: (deps.now?.() ?? new Date()).toISOString(),
    event: "baseline_checkpoint",
    by: "daemon",
  });
}

export interface CheckpointOptions {
  attribution: Attribution;
  /** Free-form `Glosa-Kind` trailer value — this module doesn't constrain the vocabulary, but
   * callers in this codebase use `baseline` (init only, via `commit()` directly, not this
   * function), `pre_apply`/`post_apply` (lease boundaries), and `auto_checkpoint` (offline
   * catch-up / any autonomous save outside a lease). */
  kind: string;
  entry?: string;
  lease?: string;
}

/** Stages the tracked∪HEAD union and commits iff something actually changed — otherwise returns
 * the current HEAD sha without creating a commit (A4 §F21's idempotency rule: "nothing staged ->
 * return current HEAD sha, DO NOT commit"). Assumes `initShadowRepo` has already run for this
 * root (so `HEAD` resolves) — callers are responsible for that ordering, same as they are for
 * holding the mutex. */
export async function checkpoint(root: string, opts: CheckpointOptions): Promise<string> {
  const tracked = resolveMatchedFiles(root).tracked.map((f) => f.path);
  const union = await trackedUnion(root, tracked);
  // An empty union means nothing is tracked and nothing was ever committed under the ruleset —
  // there is NOTHING to stage. A bare `git add -A` (no pathspec) would stage the entire
  // work-tree, including `.glosa/shadow.git/` itself (its own object store, refs, the journal) —
  // self-staging the shadow repo into its own history. Skip staging outright and fall through to
  // the same "nothing staged" idempotent return below.
  if (union.length > 0) await runGit(root, ["add", "-A", "--", ...union.map(safePathspec)]);

  const staged = await runGit(root, ["diff", "--cached", "--quiet"], { allowExitCodes: [0, 1] });
  if (staged.exitCode === 0) return headSha(root); // nothing staged -> idempotent, no commit

  const trailers: Record<string, string> = {
    "Glosa-Attribution": opts.attribution,
    "Glosa-Kind": opts.kind,
  };
  if (opts.entry !== undefined) trailers["Glosa-Entry"] = opts.entry;
  if (opts.lease !== undefined) trailers["Glosa-Lease"] = opts.lease;
  return commit(root, { message: "checkpoint", trailers });
}
