# glosa v1 — file-bus & provenance concurrency spec (F04, F05, F21, F20, F25)

**Cross-cutting invariant: the daemon is the SOLE writer** of journal, shadow git, and registries.
The CLI calls the daemon HTTP API; if the daemon is unreachable it FAILS LOUDLY, never doing
unsynchronized writes. Three distinct boundaries make that true, not one mutex shared across all
of them: the singleton daemon O_EXCL lock (A5 §F13) gives exactly one process in the machine
cross-process ownership of `GLOSA_HOME`; inside that one process, `WorkspaceIndex` serializes
every write to the global `workspaces.json` through its own single shared mutex (A5 §F19); and
each registration's own workspace bus (journal, shadow git) is serialized separately, by a
per-registration keyed mutex, so two different workspaces' writes never wait on each other while
two writes to the SAME workspace never interleave. There is no pre-daemon lockfile fallback
(removed with the hooks, #152).

## F04 — journal-as-truth durability
- Every registration carries an absolute `<bus-path>`. Files:
  `<bus-path>/journal.ndjson` (append-only), `<bus-path>/inbox/<id>.json` (immutable,
  temp→fsync→rename), `<bus-path>/journal.quarantine.ndjson`, and redirected declarative
  metadata/config. A normal local directory uses `<work-tree>/.glosa`; redirected state uses
  `~/.glosa/state/<full-sha256-registration-id>`. Moving the bus does not alter journal authority.
- Event envelope: `{v, event_id:ULID, at, entry, event, by:daemon|watcher|session:<id>|human, idem?, detail}`. Types incl. entry_created, delivery_attempt, transition_committed, attention_committed, baseline_checkpoint, auto_checkpoint, apply_begin/end/expired, journal_tail_truncated, line_quarantined, git_index_lock_reclaimed, offline_catchup, adoption_sealed, lineage_attached, entry_adopted, forget_sealed (issue #156 — `glosa forget`'s own atomic commit point, `WorkspaceBus.sealForForget`; idem `forget-seal:<bus-key>`). New attention-request `entry_created.detail` additively mirrors immutable approval identity as `{kind:"attention_request",approval_mode:boolean,target_path?}`; `target_path` is present when `approval_mode:true`, and these reserved identity keys always come from the immutable payload rather than caller-supplied event detail. Replay retains these facts in derived state. Legacy events without them remain valid and use the immutable inbox payload when approval uniqueness must be checked.
- Entry payload kinds (R3): `human_edit`, `annotation`, `attention_request`, `conversation_message`, `external_edit`. `entry_created.detail` additively mirrors the immutable payload's own kind as `payload_kind` — a RESERVED identity key like the approval pair above, written by all three producers of an entry (`WorkspaceBus.createEntryLocked`, adoption's `entry_adopted`, and reconcile's step-3 inbox self-heal, which reads it off the payload already on disk rather than synthesizing one). Distinct from `detail.kind`, which selects the replay transition table and on the adoption path carries the LIFECYCLE kind. It exists so a read-only journal fold can exclude an `external_edit` without reopening the inbox file — folds that run against a bare bus directory have no payload to read, and one that depended on the file being present would answer differently once it was not. Legacy events without it are valid and are never `external_edit`, which did not exist when they were written. `external_edit.detail` additionally carries `{since_checkpoint,until_checkpoint,source}`; `until_checkpoint` is the durable frontier the step-5b recovery below compares against shadow HEAD. Issue #153 Part 2's `glosa_watch` reads this same `until_checkpoint` fact to group entries by the checkpoint that produced them (contiguous by construction, since one capture creates every entry from one changed-path loop inside one mutex critical section) — its per-session "presented" mark is a `delivery_attempt{via:"watch"}` (A5 §F23), never a new journal event or a change to this kind's shape.
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
- **Editor-API save's own pre-capture boundary (#182).** `captureHumanEdit` (the glosa-editor-API
  write path) now captures any pending on-disk drift across the WHOLE workspace — the same scope
  `captureExternalEdit` itself stages, not just the save's own target path — as its OWN
  `unknown`-attributed checkpoint, under the same workspace mutex, immediately BEFORE mutating —
  exactly the watcher's own quiet-window capture, called inline rather than re-acquiring the mutex.
  Without it, a save whose write legitimately carries a concurrent writer's disk-only bytes into its
  own content (a three-way Keep-mine merge) would diff against a `before` that predates those bytes,
  folding them into the resulting `human_edit`. An active, unexpired apply-lease cannot be honestly
  pre-captured this way — that interval is `resolveEntry`'s to prove — so a save is refused, rather
  than attributed to the human, when its OWN target path specifically has pending drift under a live
  lease; a save proceeds normally when that path has no drift, lease or not. An EXPIRED lease is
  closed out first (same as `apply-begin`'s own handling of a dangling expired lease) and the save
  proceeds.
- **Line-ending normalization is identity-only (#251).** The concurrency identity is A5 §F10's
  `source_sha256` — that section defines the formula and is the only place it is stated. Six things
  read it: the editor's `If-Match` precondition (A1 §5.4a), the SPA's merge base, an approval's
  `revision_id`, class-F chunk freshness, the `artifact` SSE event, and the artifact listing. It is
  NEVER applied to content. A read serves the bytes as decoded, a save writes the submitted body
  verbatim, and a splice or a three-way merge copies each line ending from the source it came from,
  so a document with mixed endings comes back byte-for-byte. F21's `core.autocrlf false` makes every
  checkpoint byte-level on the same bytes. The consequence is stated rather than hidden: a disk
  change that ONLY swaps LF↔CRLF hashes identically, so it is not `source-changed`, raises no
  stale-save banner, and the next save overwrites it — while the pre-save boundary in the bullet
  above still checkpoints that drift as its own `unknown` `external_edit`, because that capture is
  byte-level and the identity hash never gates it. The listing's `stale` flag is mtime-based and
  does notice such a change; that difference is deliberate and must not be "unified" with identity.
- The fold carries `apply_end`'s `pre_sha` onto the entry (`rollbackPreSha`). It is the only place the proven "before" is stated, so a reader offered "undo what the session applied" gets the same target after a reload or a daemon restart as the tab that watched the lease close. `apply_expired` records none — the interval it closes is attributed to nobody.
- Watcher: the ATTRIBUTION edge during a lease is the single pre..post→session interval, and the watcher takes NO autonomous checkpoint inside it. **Corrected 2026-09-11 (#153).** This bullet previously read "autonomous save-burst checkpoints during a lease still commit (full history)", and that is not implementable against the same idempotent `checkpoint()` the lease uses: a save-burst commit taken mid-lease leaves `resolve`'s own checkpoint with nothing to stage, so it returns THAT commit's sha as `post_sha` and the journal records `session:<id>` for a commit trailered `Glosa-Attribution: unknown` — the forged provenance this section exists to prevent, and observed as a failing assertion, not reasoned about. Offline catch-up already declined to checkpoint under a live lease for exactly this reason; the live watcher now matches it. The lease's own `pre_apply`/`post_apply` pair brackets the interval, and the save-burst granularity inside it is not retained. **Lease invisibility to a watch (#153 Part 2):** because no `external_edit` entry is ever created for a lease-covered interval, `glosa_watch` cannot see it either — this is documented, not filtered; a watch has nothing of that interval's to exclude because nothing was ever produced for it in the first place.
- Watcher lifetime (#153, amendment): artifact watching is DAEMON-LIFETIME for registered workspaces, not scoped to an SSE subscription. The producer of `external_edit` must fire for an external editor plus an agent with no glosa tab open, which a subscription-scoped watcher cannot. A second, independent bound therefore applies: `DEFAULT_MAX_WATCHED_WORKSPACES` (64) caps live watchers ACROSS workspaces, which the per-workspace `DEFAULT_MAX_TRACKED_ARTIFACTS` (4,096) cap does not — it bounds the matcher walk one watcher's changes re-run, and aggregates nothing. Each watcher is one native recursive `fs.watch` on a directory workspace's root (a loose-file workspace: its files' parent directories, filtered to the registered paths), and every event passes the canonical matcher's path filter before it schedules a walk; there is no summed watch-entry bound, because a recursive watch is one handle however large the tree (decisions: "Artifact watching uses one native recursive watch per workspace"). Past the cross-workspace ceiling a workspace simply goes unwatched (one warning naming the constant); its drift is still committed and reported by reconcile step 5a/5b on the next start, so the degradation is latency, not loss.
- Quiet window: a live capture fires after `EXTERNAL_EDIT_QUIET_WINDOW_MS` (2s) of no change to any tracked artifact — long enough to absorb an atomic save's write/rename churn and an editor's autosave cadence, so one editing burst yields one `external_edit`. Distinct from the 50 ms matcher-rescan debounce, which decides when to re-ask which files match, not whether a person has stopped saving.

## F21 — shadow-git mechanics
- Every git call = argv array (never shell),
  `--git-dir=<bus-path>/shadow.git --work-tree=<work-tree>`, env
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0`, constant identity
  `glosa <glosa@localhost>` (attribution in commit TRAILERS not author), `--` before every pathspec
  (+ `./` prefix for paths starting `-`).
- Deterministic init: `git init`; `git symbolic-ref HEAD refs/heads/glosa` (pin branch); config core.autocrlf false (so a checkpoint is byte-level: a CRLF-only rewrite is drift, #251) / safecrlf false / commit.gpgsign false / core.fileMode false; baseline `git add -A -- <matched>` + `git commit --allow-empty -m "checkpoint\n\nGlosa-Kind: baseline\nGlosa-Attribution: unknown"` → record baseline_checkpoint.
- ONE git mutex/workspace (daemon sole operator → never self-races index.lock).
- index.lock recovery: on startup / before first op, if index.lock exists AND singleton-lock proves we're the only daemon → unlink + `git_index_lock_reclaimed` (singleton invariant makes unlink safe).
- Delete/rename: stage `git add -A -- <current matched ∪ HEAD-tracked-under-ruleset>` (union needed to stage deletions); renames detected at read via `git diff -M`.
- Checkpoint idempotency: mutex → stage union → `git diff --cached --quiet` exit0 = nothing staged → return HEAD, NO commit (idempotent); else commit with trailers `Glosa-Attribution/Kind/Entry/Lease`.

## F20 — one canonical tracked-file resolver
- NO consumer holds its own glob or bounded-path logic. One
  `resolveTrackedFiles(registration) → {tracked, oversize}` produces the explicit normalized LIST
  used by artifact-watch filtering, sidebar/API/SSE, anchoring, reconciliation, and git staging. Directory
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
- **Point membership, not a list walk (issue #281).** "Is this ONE path tracked by this
  registration?" — asked for owning-directory reuse, explicit focus, adoption candidate filtering,
  and enclosing-repository promotion — is answered by `matchTrackedFile`, the same canonical
  classifier `resolveMatchedFiles`/`resolveTrackedFiles` compile their include/exclude/prune
  predicates from (§F20). It walks only the queried path's own segments from the registration
  root — confined, readability- and symlink-checked at every intermediate, NFC-keyed, size/extension-gated for a
  matcher registration and exact-path/regular/non-symlink-gated for a bounded one — never the rest
  of the tree, so its answer can never disagree with the complete LIST for that same path.
  `focusFirst` (first tracked document in a directory) is the one deliberate exception: it is
  answered from the complete LIST, because "first" has no meaning without one.
- **Request-time complete lists stay off the daemon event loop.** Watcher initialization and first
  reconciliation resolve one complete matcher snapshot in a Worker. Offline catch-up passes that
  same snapshot through shadow-repository initialization and checkpointing; those steps never
  repeat the recursive matcher walk synchronously inside the HTTP transaction. Adoption's
  unpublished staging bus uses this same asynchronous matcher boundary rather than constructing a
  synchronous exception to the production bus registry.
- **Exact-path reuse before hardlink discovery.** Reopening a path that already has its own
  `loose-file` registration (`registration_id` is a pure function of `(kind, canonical_path)`, so
  this is a direct lookup, never a scan) refreshes that entry — `last_seen`, `present`, and a
  freshly-`lstat`ed `file_identity` — rather than recreating it, as long as its current bounded
  member still resolves. The same refresh re-announces the active registration so a soft-absent
  row restored after daemon startup immediately reacquires its daemon-lifetime watcher.
  `file_identity` is never trusted from what was last persisted; only one live, non-following
  regular-file snapshot of the current bounded path proves the registration and file still agree.
- **`nlink === 1` skips hardlink discovery entirely.** No second hardlink can exist for such a
  file, so there is nothing left to search once point membership and exact-path reuse have both
  missed — this is the common case, and issue #281's fix for it: no per-registration tree walk runs
  at all.
- **`nlink > 1` hardlink discovery runs off the main thread, inside the index mutex.** One ordered,
  read-only Worker scan — insertion order, the same deepest-owner exclusion the point/list
  resolvers apply — is awaited from inside the global index mutex's critical section (the mutex's
  ownership spans an `await`, so no concurrent registration mutation can interleave with the
  decision), bounded by one end-to-end deadline well inside the CLI's own discovery budget. Every
  stale-identity retry receives only the time remaining on that original deadline. The Worker is always
  terminated on exit — a match, a clean miss, a timeout, or a Worker-thread failure — and nothing is
  persisted while it runs. A found candidate is trusted only after the target's AND the candidate's
  live type, identity, and link count are both re-derived from non-following snapshots on the main
  thread and still agree; a mismatch retries the scan
  a bounded number of times before failing closed. Timeout, Worker failure, or an unresolved
  identity mismatch all fail the open with a retryable `alias-discovery-unavailable` error rather
  than silently creating a second registration for an inode another one may already own.
- Hardlink aliases reuse the first registration found and its durable representative focus path.
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

## Retention — append-only, deleted only whole (issue #156)
- Nothing a bus records expires. The journal is append-only (F04), inbox payloads are immutable, the
  shadow repository keeps every checkpointed version of every tracked artifact (F21), and a sealed
  loose-file source stays at its `~/.glosa/state/<registration-id>` path after adoption. All of it
  stays under `<bus-path>` — `<work-tree>/.glosa` for a directory workspace,
  `~/.glosa/state/<registration-id>` for redirected state — until the workspace is forgotten, or
  until a directory workspace's folder is deleted with its `.glosa` inside it. Index GC's
  hard-remove only drops the registration and closes the bus; it deletes no bus file.
- There is no partial purge. `human_edit` and `external_edit` entries name shadow commits by sha and
  an adopted target's `entry_adopted` aliases name entries in its sealed sources, so deleting some
  versions or some entries would leave references that resolve to nothing.
- `glosa forget <workspace>` (A6; `POST /api/workspaces/forget`, A1 §5.20) is the one deletion
  primitive: it removes the registration and its whole bus, including shadow history and every
  sealed source it adopted, and never touches work-tree files.

## F25 — slug
- Canonical path (realpath→NFC→strip trailing slash) = IDENTITY; slug = route label only.
- Base = `sanitized-basename-sha256(canonicalPath)hex[:6]`. 24 bits NOT collision-free → detection mandatory.
- Assign under global-index lock: no entry → use; same slug+same path → reuse (idempotent); same slug+different path → collision, **incumbent keeps slug, newcomer lengthens hex prefix (n+=2) until unique among different-path entries** (max full 64-hex). Deterministic + terminating. Store slug+slugLen. Moving dir → new path → new slug (intended).

## Registry-write serialization
- Serialize through the daemon (sole writer, temp→fsync→rename under per-file async mutex); slug assignment in the same critical section. Concurrent clients serialize behind the mutex → no lost updates. There is no pre-daemon lockfile fallback (removed with the hooks, #152): a client that cannot reach the daemon fails loudly rather than writing the registry directly.

### Explicit repair after shadow history loss (#226)

Ordinary initialization/capture verifies that the active HEAD names a readable commit, not merely
that a ref contains a SHA. Missing referenced objects, or a missing store/ref with surviving
checkpoint journal evidence, refuse with `SHADOW_HISTORY_LOST`. No automatic replacement occurs.
If neither Git nor journal evidence survives, prior initialization cannot be distinguished from
first use; the existing first-initialization behavior remains. This is not a full object-integrity audit.

Explicit repair requires the owning singleton daemon, the registration's shared bus mutex, a fresh
active-lifecycle/path check inside that mutex, and no active apply lease or journal seal. It stages
only the canonical registration's tracked files and creates a parentless, unknown-attributed commit.
It preserves surviving objects and immutable inbox/journal records; document bytes are never rewritten.
The ref update compares the previously observed head. Commit trailers retain a stable repair ID and
reason (`lost_history`, or `initialization_unknown` without prior evidence). An fsynced
`baseline_checkpoint` journal event uses that ID and records `repair_id`, `reason`, and `checkpoint`.

A published ref without its reason is `repair-pending`: checkpoints refuse until startup (after torn-tail
recovery) or explicit retry appends that same reason once. A crash before ref publication leaves the
old ref and may leave harmless unreachable objects. The repair baseline starts a new recovery epoch:
when an old external-edit frontier is missing or disconnected, restart scans from the recorded repair
baseline that is an ancestor of HEAD. Old entries remain unchanged. External writers do not take the
mutex; final durable racing bytes reach either the staged baseline or later watcher/restart capture.
Intermediate overwritten saves are subject to ordinary coalescing.
