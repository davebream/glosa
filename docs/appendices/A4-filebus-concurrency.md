# glosa v1 — file-bus & provenance concurrency spec (F04, F05, F21, F20, F25)

**Cross-cutting invariant: the daemon is the SOLE writer** of journal, shadow git, and registries.
CLI/hooks call the daemon HTTP API (mutation under an in-process async mutex keyed by immutable
registration ID); if daemon unreachable they FAIL LOUDLY, never do unsynchronized writes. Reuses this
repo's proven `withSessionLease` (`mcp-server/src/state/lock.ts`) for the pre-daemon lockfile fallback.

## F04 — journal-as-truth durability
- Every registration carries an absolute `<bus-path>`. Files:
  `<bus-path>/journal.ndjson` (append-only), `<bus-path>/inbox/<id>.json` (immutable,
  temp→fsync→rename), `<bus-path>/journal.quarantine.ndjson`, and redirected declarative
  metadata/config. A normal local directory uses `<work-tree>/.glosa`; redirected state uses
  `~/.glosa/state/<full-sha256-registration-id>`. Moving the bus does not alter journal authority.
- Event envelope: `{v, event_id:ULID, at, entry, event, by:daemon|watcher|session:<id>|human, idem?, detail}`. Types incl. entry_created, delivery_attempt, transition_committed, attention_committed, baseline_checkpoint, auto_checkpoint, apply_begin/end/expired, journal_tail_truncated, line_quarantined, git_index_lock_reclaimed, offline_catchup.
- MAX_EVENT_BYTES = 65536 incl trailing `\n`. **Diffs never in journal** — live in shadow git, referenced by sha → events stay small. Oversize serialization → reject `EVENT_TOO_LARGE`, never truncate into journal.
- Write: single `openSync(path,"a")` fd held at start; offset-advancing loop tolerating short writes; per-workspace mutex = single writer so records never interleave.
- fsync: `fsyncSync` BEFORE returning success for lifecycle-critical events (entry_created, transition_committed, attention_committed, apply_begin/end, baseline_checkpoint). High-freq delivery_attempt may batch-flush (loss = redundant re-nudge only). Dir fsync once at file creation.
- Torn final line (no trailing `\n`) = crash mid-append → `ftruncate` to lastNewline+1, append `journal_tail_truncated{bytes,hash}` (raw → quarantine). Safe because fsync-before-ACK means ACKed events always have their newline.
- Idempotent replay: pure left-fold in file order; duplicate event_id ignored; already-applied idem → no-op; replay twice = byte-identical state. `resolve` re-run folds to no-op.
- Corruption quarantine: a non-final bad/oversize/invalid line → append to quarantine file + `line_quarantined` event + SKIP + continue folding. One bad interior line never disables the bus. Journal never rewritten (append-only); derived state excludes it. Count surfaced in doctor/status.
- Startup reconcile (ordered): 1 torn-tail truncate; 2 replay→derived state; 3 inbox↔journal self-heal (creation order = inbox file atomically FIRST, then entry_created; on startup an inbox file with no entry_created → synthesize+append it; reverse gap impossible); 4 apply-lease reconcile (apply_begin w/o apply_end & expired → apply_expired, interval→unknown); 5 offline catch-up (diff HEAD vs worktree → auto_checkpoint attributed unknown + offline_catchup).
- **This is why `resolve` touches ONE file (a journal append) — dodges two-file atomicity entirely.**

## F05 — apply-lease proven attribution
- Exactly ONE active apply-lease/workspace; 2nd `apply-begin` while active → reject `LEASE_HELD` (retry), never queue.
- `apply-begin <entry> --session <sid>` (under git+journal mutex): checkpoint→`pre_sha`; append `apply_begin{lease_id,entry,session,pre_sha,expires_at=now+APPLY_LEASE_TTL_MS(15min)}`; fsync; return lease_id.
- `resolve <entry> applied|rejected|stale --session <sid>`: checkpoint→`post_sha`; `git diff pre_sha post_sha` = proven interval → `session:<sid>`; append `apply_end` + `transition_committed{to:resolved}`; fsync.
- Attribution: pre..post lease diff → session (proven); glosa-editor-API writes → human by construction; **EVERYTHING ELSE → unknown, never human**. Lease expiry → apply_expired, diff→unknown.
- Watcher: autonomous save-burst checkpoints during a lease still commit (full history), but the ATTRIBUTION edge is the single pre..post→session interval; intermediate commits are unattributed history folded inside, not false `unknown` slices.

## F21 — shadow-git mechanics
- Every git call = argv array (never shell),
  `--git-dir=<bus-path>/shadow.git --work-tree=<work-tree>`, env
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0`, constant identity
  `glosa <glosa@localhost>` (attribution in commit TRAILERS not author), `--` before every pathspec
  (+ `./` prefix for paths starting `-`).
- Deterministic init: `git init`; `git symbolic-ref HEAD refs/heads/glosa` (pin branch); config core.autocrlf false / safecrlf false / commit.gpgsign false / core.fileMode false; baseline `git add -A -- <matched>` + `git commit --allow-empty -m "checkpoint\n\nGlosa-Kind: baseline\nGlosa-Attribution: unknown"` → record baseline_checkpoint.
- ONE git mutex/workspace (daemon sole operator → never self-races index.lock).
- index.lock recovery: on startup / before first op, if index.lock exists AND singleton-lock proves we're the only daemon → unlink + `git_index_lock_reclaimed` (singleton invariant makes unlink safe).
- Delete/rename: stage `git add -A -- <current matched ∪ HEAD-tracked-under-ruleset>` (union needed to stage deletions); renames detected at read via `git diff -M`.
- Checkpoint idempotency: mutex → stage union → `git diff --cached --quiet` exit0 = nothing staged → return HEAD, NO commit (idempotent); else commit with trailers `Glosa-Attribution/Kind/Entry/Lease`.

## F20 — one canonical tracked-file resolver
- NO consumer holds its own glob or bounded-path logic. One
  `resolveTrackedFiles(registration) → {tracked, oversize}` produces the explicit normalized LIST
  used by chokidar filtering, sidebar/API/SSE, anchoring, reconciliation, and git staging. Directory
  registrations delegate to the canonical **picomatch** resolver (zero-dep, fs-free). Loose-file
  registrations return only their registered bounded relative paths; each current target must still
  be a regular non-symlink file, but extension/exclusion/size matcher rules do not apply. Git stages
  current tracked ∪ previously-tracked-under-policy so deletions remain visible. One list, zero drift.
- Normalize: walk with `lstat` (no symlink follow); **symlinks neither followed nor matched** (closes F24 escape) → diagnostic list; POSIX `/` rel paths no leading `./`; **NFC-normalize** comparison key (APFS returns NFD) keeping raw name for fs ops; **case-sensitive** on NFC (`nocase:false`, documented); include(OR) minus exclude; size threshold `maxFileBytes` 2MiB → over = `oversize`; deterministic byte-sort on NFC path.
- Size crossing: grow past → leave tracked, `file_untracked{reason:oversize}`, last checkpoint stands; shrink under → re-enter, `file_tracked`.
- Config: `{artifacts:{include:["**/*.md","**/*.html","**/*.txt"], exclude:[".glosa/**","**/node_modules/**",".*/**"], maxFileBytes:2097152, followSymlinks:false}}`, loaded from `<bus-path>/config.json`.

## Workspace ownership and aliases
- Open-target normalization is realpath→NFC→strip trailing slash. Ancestry checks are
  segment-aware and case-sensitive; the deepest registered directory root wins.
- A file inside that root reuses its registration only when the canonical tracked LIST contains it.
  Excluded, oversize, `.glosa/**`, and symlink targets fail with `artifact-not-tracked` or an
  unsupported-file error before a document surface is presented.
- With no owning root, compare BigInt `dev`/`ino` identities against registered tracked files.
  Hardlink aliases reuse the first registration and its durable representative focus path.
- Resolution, the final alias recheck, and new registration persist under the global index writer.
  Concurrent aliases therefore cannot create parallel buses, baselines, journals, or mutexes.

## F25 — slug
- Canonical path (realpath→NFC→strip trailing slash) = IDENTITY; slug = route label only.
- Base = `sanitized-basename-sha256(canonicalPath)hex[:6]`. 24 bits NOT collision-free → detection mandatory.
- Assign under global-index lock: no entry → use; same slug+same path → reuse (idempotent); same slug+different path → collision, **incumbent keeps slug, newcomer lengthens hex prefix (n+=2) until unique among different-path entries** (max full 64-hex). Deterministic + terminating. Store slug+slugLen. Moving dir → new path → new slug (intended).

## Registry-write serialization
- Primary: serialize through daemon (sole writer, temp→fsync→rename under per-file async mutex); slug assignment in same critical section. Concurrent hooks serialize behind mutex → no lost updates.
- Fallback (hook must write before daemon up): `O_EXCL` lockfile (`~/.glosa/.workspaces.lock`, `<ws>/.glosa/.registry.lock`) with EXACT `withSessionLease` semantics (openSync wx = atomic CAS; {token,pid,hostname,expiresAt}; bounded retries then fail; TTL + kill(pid,0) stale reclaim via unlink→re-openSync(wx); re-entrant process-local token map). RMW (load→modify→temp→fsync→rename) INSIDE the lease, never bare.
- Preconditions: local POSIX FS with atomic O_EXCL (no NFS); single host; TTL = staleness backstop.
