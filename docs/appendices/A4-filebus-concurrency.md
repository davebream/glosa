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
- Event envelope: `{v, event_id:ULID, at, entry, event, by:daemon|watcher|session:<id>|human, idem?, detail}`. Types incl. entry_created, delivery_attempt, transition_committed, attention_committed, baseline_checkpoint, auto_checkpoint, apply_begin/end/expired, journal_tail_truncated, line_quarantined, git_index_lock_reclaimed, offline_catchup, adoption_sealed, lineage_attached, entry_adopted, forget_sealed (issue #156 — `glosa forget`'s own atomic commit point, `WorkspaceBus.sealForForget`; idem `forget-seal:<bus-key>`). New attention-request `entry_created.detail` additively mirrors immutable approval identity as `{kind:"attention_request",approval_mode:boolean,target_path?}`; `target_path` is present when `approval_mode:true`, and these reserved identity keys always come from the immutable payload rather than caller-supplied event detail. Replay retains these facts in derived state. Legacy events without them remain valid and use the immutable inbox payload when approval uniqueness must be checked.
- Entry payload kinds (R3): `human_edit`, `annotation`, `attention_request`, `conversation_message`, `external_edit`. `entry_created.detail` additively mirrors the immutable payload's own kind as `payload_kind` — a RESERVED identity key like the approval pair above, written by all three producers of an entry (`WorkspaceBus.createEntryLocked`, adoption's `entry_adopted`, and reconcile's step-3 inbox self-heal, which reads it off the payload already on disk rather than synthesizing one). Distinct from `detail.kind`, which selects the replay transition table and on the adoption path carries the LIFECYCLE kind. It exists so a read-only journal fold can exclude an `external_edit` without reopening the inbox file — folds that run against a bare bus directory have no payload to read, and one that depended on the file being present would answer differently once it was not. Legacy events without it are valid and are never `external_edit`, which did not exist when they were written. `external_edit.detail` additionally carries `{since_checkpoint,until_checkpoint,source}`; `until_checkpoint` is the durable frontier the step-5b recovery below compares against shadow HEAD.
- MAX_EVENT_BYTES = 65536 incl trailing `\n`. **Diffs never in journal** — live in shadow git, referenced by sha → events stay small. Oversize serialization → reject `EVENT_TOO_LARGE`, never truncate into journal.
- Write: single `openSync(path,"a")` fd held at start; offset-advancing loop tolerating short writes; per-workspace mutex = single writer so records never interleave.
- fsync: `fsyncSync` BEFORE returning success for lifecycle-critical events (entry_created, transition_committed, attention_committed, apply_begin/end, baseline_checkpoint, forget_sealed). High-freq delivery_attempt may batch-flush (loss = redundant re-nudge only). Dir fsync once at file creation.
- Torn final line (no trailing `\n`) = crash mid-append → `ftruncate` to lastNewline+1, append `journal_tail_truncated{bytes,hash}` (raw → quarantine). Safe because fsync-before-ACK means ACKed events always have their newline.
- Idempotent replay: pure left-fold in file order; duplicate event_id ignored; already-applied idem → no-op; replay twice = byte-identical state. `resolve` re-run folds to no-op.
- Corruption quarantine: a non-final bad/oversize/invalid line → append to quarantine file + `line_quarantined` event + SKIP + continue folding. One bad interior line never disables the bus. Journal never rewritten (append-only); derived state excludes it. Count surfaced in doctor/status.
- Startup reconcile (ordered): 1 torn-tail truncate; 2 replay→derived state; 3 inbox↔journal self-heal (creation order = inbox file atomically FIRST, then entry_created; on startup an inbox file with no entry_created → synthesize+append it; the reverse gap — entry_created with no inbox payload, reachable by hand-removing the file (issue #142) — is never self-healed: no payload is synthesized and the journal is never rewritten; `doctor`/`status` surface it as `orphaned_entry_count` and `glosa inbox dismiss` is the supported reconciliation); 4 apply-lease reconcile (apply_begin w/o apply_end & expired → apply_expired, interval→unknown); 5a offline catch-up (diff HEAD vs worktree → auto_checkpoint attributed unknown + offline_catchup); 5b report drift as `external_edit` — every `Glosa-Kind: auto_checkpoint` commit reachable from shadow HEAD that no `external_edit` entry's `until_checkpoint` names becomes one entry per artifact changed in it, `source:"offline_catchup"`, inbox file atomically first then `entry_created` (same order as step 3's own creation rule). Step 5a captures drift honestly and says nothing about it in the inbox, which is what let those hunks reach delivery labelled `human_edit` (#144); 5b is the half that names them. The SAME scan is the recovery for the live watcher's crash gap: the quiet-window capture must commit before the entry that names the commit, and a crash between the two is PERMANENT rather than transient, because checkpoint idempotency (F21) means no later checkpoint ever sees that diff again. Shadow history retains the commit either way, so the last emitted `until_checkpoint` compared against current shadow HEAD is the durable signal, and one idempotent scan serves both jobs. Skipped entirely while an apply-lease is live (the interval is that lease's), and guarded like 5a so a broken git toolchain degrades to "nothing reported this pass" rather than failing every request against the workspace. A replayed `adoption_sealed` OR `forget_sealed` stops at step 2 (issue #156 held-review finding: a resumed `forget_sealed` bus must run no self-heal, lease-expiry append, or offline Git catch-up before its deletion resumes — its bus is moments from removal, and appending to it would both violate the seal's own "no writes past this point" contract and durably record events for a bus about to vanish): torn-tail repair/replay remain valid, but no later reconciliation step may append to a historical source or a sealed forget target.
- **This is why `resolve` touches ONE file (a journal append) — dodges two-file atomicity entirely.**

## F05 — apply-lease proven attribution
- Exactly ONE active apply-lease/workspace; 2nd `apply-begin` while active → reject `LEASE_HELD` (retry), never queue.
- `apply-begin <entry> --session <sid>` (under git+journal mutex): reject `UNKNOWN_ENTRY` (404) when the workspace has no such entry — a lease over a foreign entry proves nothing and would still consume the one slot; then checkpoint→`pre_sha`; append `apply_begin{lease_id,entry,session,pre_sha,expires_at=now+APPLY_LEASE_TTL_MS(15min)}`; fsync; return lease_id.
- `resolve <entry> applied|rejected|stale --session <sid>`: checkpoint→`post_sha`; `git diff pre_sha post_sha` = proven interval → `session:<sid>`; append `apply_end{lease_id,pre_sha,post_sha}` (BOTH ends — the interval must be computable from the event that declares it) + `transition_committed{to:resolved}`; fsync.
- Attribution: pre..post lease diff → session (proven); glosa-editor-API writes → human by construction; **EVERYTHING ELSE → unknown, never human**. Lease expiry → apply_expired, diff→unknown.
- The fold carries `apply_end`'s `pre_sha` onto the entry (`rollbackPreSha`). It is the only place the proven "before" is stated, so a reader offered "undo what the session applied" gets the same target after a reload or a daemon restart as the tab that watched the lease close. `apply_expired` records none — the interval it closes is attributed to nobody.
- Watcher: the ATTRIBUTION edge during a lease is the single pre..post→session interval, and the watcher takes NO autonomous checkpoint inside it. **Corrected 2026-09-11 (#153).** This bullet previously read "autonomous save-burst checkpoints during a lease still commit (full history)", and that is not implementable against the same idempotent `checkpoint()` the lease uses: a save-burst commit taken mid-lease leaves `resolve`'s own checkpoint with nothing to stage, so it returns THAT commit's sha as `post_sha` and the journal records `session:<id>` for a commit trailered `Glosa-Attribution: unknown` — the forged provenance this section exists to prevent, and observed as a failing assertion, not reasoned about. Offline catch-up already declined to checkpoint under a live lease for exactly this reason; the live watcher now matches it. The lease's own `pre_apply`/`post_apply` pair brackets the interval, and the save-burst granularity inside it is not retained.
- Watcher lifetime (#153, amendment): artifact watching is DAEMON-LIFETIME for registered workspaces, not scoped to an SSE subscription. The producer of `external_edit` must fire for an external editor plus an agent with no glosa tab open, which a subscription-scoped watcher cannot. A second, independent bound therefore applies: `DEFAULT_MAX_WATCHED_WORKSPACES` (64) caps live watchers ACROSS workspaces, which the per-workspace `DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES` path cap does not — it bounds paths within one watcher and aggregates nothing. Past the cross-workspace ceiling a workspace simply goes unwatched (one warning naming the constant); its drift is still committed and reported by reconcile step 5a/5b on the next start, so the degradation is latency, not loss.
- Quiet window: a live capture fires after `EXTERNAL_EDIT_QUIET_WINDOW_MS` (2s) of no change to any tracked artifact — long enough to absorb an atomic save's write/rename churn and an editor's autosave cadence, so one editing burst yields one `external_edit`. Distinct from the 50 ms matcher-rescan debounce, which decides when to re-ask which files match, not whether a person has stopped saving.

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
  An explicitly named regular non-symlink file excluded by that list opens through a bounded
  `loose-file` registration instead; exact-path and hardlink aliases reuse an existing loose
  registration before a new one is created. The parent directory's tracked LIST is unchanged.
  Symlinks remain unsupported, and an explicit directory focus outside its tracked LIST still
  fails with `artifact-not-tracked`.
- With no owning root, compare BigInt `dev`/`ino` identities against registered tracked files.
  Hardlink aliases reuse the first registration and its durable representative focus path.
- Resolution, the final alias recheck, and new registration persist under the global index writer.
  Concurrent aliases therefore cannot create parallel buses, baselines, journals, or mutexes.

## Loose-file adoption — seal and link
- When a directory workspace opens over contained loose-file registrations, the global index records
  one durable adoption plan. A daemon-scoped mutex keyed by target registration ID holds the complete
  seal/build/publish transaction, so parallel opens serialize before either can clean or write the
  unpublished staging bus. Ordinary routes for that adopting target fail closed with
  `409 workspace-adopting`. The daemon holds every source registration mutex in stable lexical order,
  preflights every apply lease, and only then appends lifecycle-critical
  `adoption_sealed{adoption_id,target_registration_id}` events. Any live lease or existing target
  state fails closed before a source is sealed.
- A sealed source is permanently read-only historical evidence: its immutable inbox, journal, and
  shadow repo remain at their original `~/.glosa/state/<registration-id>` path. The target imports
  each source head to `refs/glosa/lineages/<source-registration-id>/head`; it never creates a
  synthetic merge commit or rewrites the target branch.
- The target journal records `lineage_attached` with source/target path mapping and imported heads,
  then `entry_adopted` aliases for every non-terminal source entry. Source journals remain the
  truth for pre-adoption history; the aliases are new target lifecycle events with explicit source
  registration and entry provenance. No source is recursively moved, deleted, or garbage-collected
  as part of adoption.

## F25 — slug
- Canonical path (realpath→NFC→strip trailing slash) = IDENTITY; slug = route label only.
- Base = `sanitized-basename-sha256(canonicalPath)hex[:6]`. 24 bits NOT collision-free → detection mandatory.
- Assign under global-index lock: no entry → use; same slug+same path → reuse (idempotent); same slug+different path → collision, **incumbent keeps slug, newcomer lengthens hex prefix (n+=2) until unique among different-path entries** (max full 64-hex). Deterministic + terminating. Store slug+slugLen. Moving dir → new path → new slug (intended).

## Registry-write serialization
- Primary: serialize through daemon (sole writer, temp→fsync→rename under per-file async mutex); slug assignment in same critical section. Concurrent hooks serialize behind mutex → no lost updates.
- Fallback (hook must write before daemon up): `O_EXCL` lockfile (`~/.glosa/.workspaces.lock`, `<ws>/.glosa/.registry.lock`) with EXACT `withSessionLease` semantics (openSync wx = atomic CAS; {token,pid,hostname,expiresAt}; bounded retries then fail; TTL + kill(pid,0) stale reclaim via unlink→re-openSync(wx); re-entrant process-local token map). RMW (load→modify→temp→fsync→rename) INSIDE the lease, never bare.
- Preconditions: local POSIX FS with atomic O_EXCL (no NFS); single host; TTL = staleness backstop.
