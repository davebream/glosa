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
- Event envelope: `{v, event_id:ULID, at, entry, event, by:daemon|watcher|session:<id>|human, idem?, detail}`. Types incl. entry_created, delivery_attempt, transition_committed, attention_committed, baseline_checkpoint, auto_checkpoint, claim_taken/renewed/released/expired (issue #155, F05), apply_begin/end/expired (apply_begin and apply_expired are no longer written but still fold, so an older journal replays unchanged), journal_tail_truncated, line_quarantined, git_index_lock_reclaimed, offline_catchup, adoption_sealed, lineage_attached, entry_adopted, forget_sealed (issue #156 — `glosa forget`'s own atomic commit point, `WorkspaceBus.sealForForget`; idem `forget-seal:<bus-key>`). New attention-request `entry_created.detail` additively mirrors immutable approval identity as `{kind:"attention_request",approval_mode:boolean,target_path?}`; `target_path` is present when `approval_mode:true`, and these reserved identity keys always come from the immutable payload rather than caller-supplied event detail. Replay retains these facts in derived state. Legacy events without them remain valid and use the immutable inbox payload when approval uniqueness must be checked.
- Entry payload kinds (R3): `human_edit`, `annotation`, `attention_request`, `conversation_message`, `external_edit`. `entry_created.detail` additively mirrors the immutable payload's own kind as `payload_kind` — a RESERVED identity key like the approval pair above, written by all three producers of an entry (`WorkspaceBus.createEntryLocked`, adoption's `entry_adopted`, and reconcile's step-3 inbox self-heal, which reads it off the payload already on disk rather than synthesizing one). Distinct from `detail.kind`, which selects the replay transition table and on the adoption path carries the LIFECYCLE kind. It exists so a read-only journal fold can exclude an `external_edit` without reopening the inbox file — folds that run against a bare bus directory have no payload to read, and one that depended on the file being present would answer differently once it was not. Legacy events without it are valid and are never `external_edit`, which did not exist when they were written. `external_edit.detail` additionally carries `{since_checkpoint,until_checkpoint,source}`; `until_checkpoint` is the durable frontier the step-5b recovery below compares against shadow HEAD. Issue #153 Part 2's `glosa_watch` reads this same `until_checkpoint` fact to group entries by the checkpoint that produced them (contiguous by construction, since one capture creates every entry from one changed-path loop inside one mutex critical section) — its per-session "presented" mark is a `delivery_attempt{via:"watch"}` (A5 §F23), never a new journal event or a change to this kind's shape.
- MAX_EVENT_BYTES = 65536 incl trailing `\n`. **Diffs never in journal** — live in shadow git, referenced by sha → events stay small. Oversize serialization → reject `EVENT_TOO_LARGE`, never truncate into journal.
- Write: single `openSync(path,"a")` fd held at start; offset-advancing loop tolerating short writes; per-workspace mutex = single writer so records never interleave.
- fsync: `fsyncSync` BEFORE returning success for lifecycle-critical events (entry_created, transition_committed, attention_committed, apply_begin/end, claim_taken, claim_released, baseline_checkpoint, forget_sealed). `claim_renewed` only extends a window that exists and `claim_expired` is re-derivable from the TTL, so neither needs it. High-freq delivery_attempt may batch-flush (loss = redundant re-nudge only). Dir fsync once at file creation.
- Torn final line (no trailing `\n`) = crash mid-append → `ftruncate` to lastNewline+1, append `journal_tail_truncated{bytes,hash}` (raw → quarantine). Safe because fsync-before-ACK means ACKed events always have their newline.
- Idempotent replay: pure left-fold in file order; duplicate event_id ignored; already-applied idem → no-op; replay twice = byte-identical state. A `resolve` retried by the session that closed the entry is answered as a replay and appends nothing — decided from the fold's `terminalBy` under the mutex, before any write (F05), not by an idempotency key.
- Corruption quarantine: a non-final bad/oversize/invalid line → append to quarantine file + `line_quarantined` event + SKIP + continue folding. One bad interior line never disables the bus. Journal never rewritten (append-only); derived state excludes it. Count surfaced in doctor/status.
- Startup reconcile (ordered): 1 torn-tail truncate; 2 replay→derived state; 3 inbox↔journal self-heal (creation order = inbox file atomically FIRST, then entry_created; on startup an inbox file with no entry_created → synthesize+append it; the reverse gap — entry_created with no inbox payload, reachable by hand-removing the file (issue #142) — is never self-healed: no payload is synthesized and the journal is never rewritten; `doctor`/`status` surface it as `orphaned_entry_count` and `glosa inbox dismiss` is the supported reconciliation); 4 claim reconcile (every claim past its TTL → `claim_expired{claim_id,holder_session,reason:"ttl"}` naming the holder, interval→unknown; a holder session going stale needs the session registry, which reconcile does not have, so that expiry belongs to the daemon's claim sweeper, F05); 5a offline catch-up (diff HEAD vs worktree on every path no live claim covers → auto_checkpoint attributed unknown + offline_catchup; a claim with no recorded paths covers the whole workspace and skips 5a entirely); 5b report drift as `external_edit` — every `Glosa-Kind: auto_checkpoint` commit reachable from shadow HEAD that no `external_edit` entry's `until_checkpoint` names (or `claim_expired`/`claim_released`, the abandoned interval of a claim that ended without a resolve, F05) becomes one entry per artifact changed in it, `source:"offline_catchup"`, inbox file atomically first then `entry_created` (same order as step 3's own creation rule). Step 5a captures drift honestly and says nothing about it in the inbox, which is what let those hunks reach delivery labelled `human_edit` (#144); 5b is the half that names them. The SAME scan is the recovery for the live watcher's crash gap: the quiet-window capture must commit before the entry that names the commit, and a crash between the two is PERMANENT rather than transient, because checkpoint idempotency (F21) means no later checkpoint ever sees that diff again. Shadow history retains the commit either way, so the last emitted `until_checkpoint` compared against current shadow HEAD is the durable signal, and one idempotent scan serves both jobs. Not gated on live claims: it only reports drift-kind commits, and no producer writes one for a path a live claim covers, so a claim's own `pre_apply`/`post_apply` never reaches it. Guarded like 5a so a broken git toolchain degrades to "nothing reported this pass" rather than failing every request against the workspace. A replayed `adoption_sealed` OR `forget_sealed` stops at step 2 (issue #156 held-review finding: a resumed `forget_sealed` bus must run no self-heal, lease-expiry append, or offline Git catch-up before its deletion resumes — its bus is moments from removal, and appending to it would both violate the seal's own "no writes past this point" contract and durably record events for a bus about to vanish): torn-tail repair/replay remain valid, but no later reconciliation step may append to a historical source or a sealed forget target.
- **This is why `resolve` touches ONE file (a journal append) — dodges two-file atomicity entirely.**

## F05 — claims: proven attribution per resource (issue #155)
- **Resources and modes.** A claim covers resources: `entry:<inbox id>` and `artifact:<workspace-relative path>`. Every claim has a normalized path set — an `entry:` resource implies the artifact(s) its immutable payload names — and an entry that names no path makes the claim cover the WHOLE workspace, because its checkpoints cannot be scoped. `exclusive` = "I am editing this"; `presence` = "I am looking at this", which blocks nobody and takes no checkpoint. Claims are not access control (A3 is unchanged: any bearer may claim anything) and do not stop out-of-band disk writes; the guarantee is honesty about who can be credited.
- **Disjointness.** Under the git+journal mutex, a new exclusive claim is refused `CLAIM_HELD` — the holder inline: `{claim_id, holder_session, holder_principal, mode, since, expires_at, fence}` — when its path set intersects another session's live exclusive claim (an empty path set intersects everything). The same session re-claiming resources it already holds RENEWS (`claim_renewed`, fence unchanged), never conflicts. Bounds, not authorization: TTL capped at the mode's TTL, ≤ 32 live claims per session and ≤ 256 per workspace (`CLAIM_LIMIT`). A refused claim appends nothing.
- **Fence.** Each resource carries a monotonic fence: a new holder gets `1 + max(fence ever issued over its resources)`; renewal keeps it. It is ALWAYS read from `claim_taken`, never recomputed by the fold — a fold that inferred "the Nth claim gets fence N" would hand one number to two holders the moment an event was skipped or quarantined. Legacy `apply_begin` leases fold as claims with `fence: null`, which passes every fence check.
- **Taking an exclusive claim** (`claim()`, or `apply-begin <entry> --session <sid>` as its one-entry alias; `lease_id` = claim id): refuse `UNKNOWN_ENTRY` (404) for an entry this workspace does not own; close out any TTL-lapsed claim over the same ground first (`claim_expired`, below); if the claimed paths already have drift, report it as `external_edit`/`unknown`; then checkpoint scoped to the claimed paths → `pre_sha` (`Glosa-Kind: pre_apply`, `Glosa-Lease: <claim_id>`); append `claim_taken{claim_id,resources,paths,mode,session,principal,fence,since,expires_at,pre_sha}`; fsync.
- **Lifetime.** TTL 15 min exclusive, 5 min presence; renewing extends from now. A claim also dies with its session: the daemon's claim sweeper visits every OPEN bus every 30 s and expires a claim whose TTL lapsed (`reason:"ttl"`) or whose holder session has been stale for ≥ 120 s (`reason:"holder_stale"` — twice the session registry's 60 s lease, so one missed heartbeat never costs a working session its claim). A holder that never registered with the daemon is bounded by the TTL alone. Every expiry appends `claim_expired{claim_id,holder_session,reason}` FIRST, then checkpoints the claim's paths as `unknown` (`Glosa-Kind: claim_expired`) and reports what the holder left as `external_edit` — event before checkpoint for the reason the old lease expiry gave: a crash between them recovers to "claim dead, drift not yet captured", which step 5 finishes, never to "commit exists, claim still open".
- **`resolve <entry> applied|rejected|stale --session <sid> [--fence n]`** evaluates a refusal ladder in full under the mutex, BEFORE any checkpoint; a refusal appends nothing and commits nothing (the one exception is `git_index_lock_reclaimed`, plus lazy expiry of the caller's own dead claim):
  0. unknown entry → `UNKNOWN_ENTRY` (404);
  1. terminal, closed by THIS session with THIS outcome → a replay: the original `lease_id`/`post_sha`, `replayed:true`;
  2. terminal otherwise → `ENTRY_RESOLVED{terminal_by, entry_status}`;
  3. the caller's claim has ended (or its presented fence is not the live one) → `CLAIM_REVOKED` / `CLAIM_EXPIRED` / `CLAIM_SUPERSEDED`, read from the resource's tombstone;
  3′. the caller's claim lapsed its TTL but nothing has closed it yet, within one sweeper interval (30 s) → renew and proceed (a resolve that queued behind the mutex while the clock ran out); past that it expires here and answers `CLAIM_EXPIRED` — the answer the sweeper would already have given, so the outcome never depends on timer jitter or a suspended laptop;
  4. another session holds the entry's paths → `CLAIM_HELD` (a non-holder never drives another session's claim to expiry);
  5. no claim of mine → `NO_CLAIM`;
  6. checkpoint scoped to the claim's paths → `post_sha` (`Glosa-Attribution: session:<sid>`); append `apply_end{claim_id,lease_id,fence,paths,pre_sha,post_sha,interval_attribution}` (BOTH ends — the interval must be computable from the event that declares it) + `transition_committed{to:<outcome>}`; fsync.
- **Attribution.** The claim's scoped `pre..post` interval → the claim's holder (proven); glosa-editor-API writes → human by construction; **EVERYTHING ELSE → unknown, never human**. `diffShas(pre, post, paths)` reads an interval back scoped to the claim's paths from the full `-M` diff, so a rename stays paired when either side is claimed. **Interval guard:** at rung 6, any commit in `pre..post` that touched the claimed paths and is neither trailered `session:<holder>` nor the claim's own (`Glosa-Lease`) makes the interval `interval_attribution:"unknown"`, `reason:"foreign-commit-in-interval"`; the entry still transitions. Two exclusive claims on different artifacts therefore produce two clean, disjoint intervals.
- **Terminal facts.** The fold records `terminalBy` — the `by` of the transition that made the entry terminal, set only on the winning side of the guard — and promotes the preceding `apply_end` to `appliedInterval` only when the same `by` closed the entry; a loser's `apply_end`, or one orphaned by a crash between the two appends, stays unattributed. No journal field `idem` participates in any of this. Every close — resolve, dismiss, defer, withdraw — shares one in-mutex terminal guard; replay is offered only to `resolve`, because `by:"human"` names every person at once and a second human close is not provably the same person retrying.
- **The human wins (supersedes #182's refusal).** A person is never blocked by an agent. A glosa-editor save or restore (`captureHumanEdit`) on a path under another session's live exclusive claim WITH drift on that path releases the claim `claim_released{by:"human",reason:"released_by_human"}`, checkpoints the holder's bytes on the claim's paths as `unknown` (`Glosa-Kind: claim_released`) and reports them as `external_edit`, and only then saves — against a base that already holds them, so the human is credited with exactly what they typed and the holder with nothing. The holder's late resolve answers `CLAIM_REVOKED`. With NO drift on the path the claim is left alone; the human's commit lands inside the holder's interval and the interval guard records that interval `unknown`. A human `dismiss` or SPA withdraw over a claimed entry releases the claim the same way before closing the entry. Before any of this, the save's pre-capture boundary stages drift on every tracked path no live claim covers, as its own `unknown` checkpoint under the same mutex — exactly the watcher's quiet-window capture, called inline — so a Keep-mine merge that carries a concurrent writer's disk-only bytes never folds them into the resulting `human_edit`.
- **The save checks its own bytes.** `mutate()` returns the bytes it wrote; if the file no longer holds them when re-read, another writer landed in the same instant. There is no truthful `human` checkpoint for that state: disk is captured as `unknown` and the save answers `source-changed` (409), so the SPA's Keep-mine / Take-disk / Compare dialog runs again rather than reporting a save that no longer describes the file.
- A claim ended without a resolve by its holder (`glosa release`) is captured the same way as an expiry: `claim_released{by:"session"}`, then its paths as `unknown`.
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
- The fold carries `apply_end`'s `pre_sha` onto the entry (`rollbackPreSha`). It is the only place the proven "before" is stated, so a reader offered "undo what the session applied" gets the same target after a reload or a daemon restart as the tab that watched the claim close. `claim_expired`/`claim_released` (and the legacy `apply_expired`) record none — the interval they close is attributed to nobody.
- Watcher: the ATTRIBUTION edge on a claimed path is the single pre..post→session interval, and the watcher takes NO autonomous checkpoint of a path a live claim covers — it stages every other tracked path, so a second agent's untouched files are still captured while the first one works (issue #155; before claims, one lease deferred the whole workspace). A TTL-lapsed claim still excludes its paths until the sweeper closes it and reports its bytes in the holder's name. **Corrected 2026-09-11 (#153).** This bullet previously read "autonomous save-burst checkpoints during a lease still commit (full history)", and that is not implementable against the same idempotent `checkpoint()` the lease uses: a save-burst commit taken mid-lease leaves `resolve`'s own checkpoint with nothing to stage, so it returns THAT commit's sha as `post_sha` and the journal records `session:<id>` for a commit trailered `Glosa-Attribution: unknown` — the forged provenance this section exists to prevent, and observed as a failing assertion, not reasoned about. Offline catch-up already declined to checkpoint under a live lease for exactly this reason; the live watcher now matches it. The lease's own `pre_apply`/`post_apply` pair brackets the interval, and the save-burst granularity inside it is not retained. **Claim invisibility to a watch (#153 Part 2):** because no `external_edit` entry is ever created for a claim-covered interval while the claim is live, `glosa_watch` cannot see it either — this is documented, not filtered; a watch has nothing of that interval's to exclude because nothing was ever produced for it in the first place.
- Watcher lifetime (#153, amendment; allocation #219): artifact watching is DAEMON-LIFETIME for registered workspaces, not scoped to an SSE subscription. The producer of `external_edit` must fire for an external editor plus an agent with no glosa tab open, which a subscription-scoped watcher cannot. A second, independent bound therefore applies: `DEFAULT_MAX_WATCHED_WORKSPACES` (64) caps live watchers ACROSS workspaces, which the per-workspace `DEFAULT_MAX_TRACKED_ARTIFACTS` (4,096) cap does not — it bounds the matcher walk one watcher's changes re-run, and aggregates nothing. Each watcher is one native recursive `fs.watch` on a directory workspace's root (a loose-file workspace: its files' parent directories, filtered to the registered paths), and every event passes the canonical matcher's path filter before it schedules a walk; there is no summed watch-entry bound, because a recursive watch is one handle however large the tree (decisions: "Artifact watching uses one native recursive watch per workspace"). The selected 64 are recomputed by live routed session first, then newest `last_seen`, then registration id; boot insertion/warm-up order has no authority. Demotion uses the same eviction path as removal, cancelling reconcile and quiet-window timers. Past the ceiling a workspace simply goes unwatched and reports `live_updates:{state:"offline_catchup",reason:"workspace_budget"}`; its drift is still committed and reported by reconcile step 5a/5b on the next start, so the degradation is latency, not loss.
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


## Managed chat journals and workspace authority (2026-09-23)

Workspace inbox/journal authority is unchanged. Managed control and per-chat intent journals live
under the daemon home, separately from workspace provenance. Their schema-1 sequence, request UUID,
canonical-input digest, fsync-before-ack and replay validation decide what the UI accepted. Prompt
and attachment blobs are content-addressed. Torn tails are quarantined; interior corruption blocks
that chat. Corrupt control state disables managed execution while document review remains available.
No cross-file atomicity is claimed: deletion writes a durable tombstone before repeatable directory
cleanup; a crash cannot resurrect deleted chats. Orphaned unreferenced blob bytes count toward quota.

A turn freezes account identity/epoch, native manifest, model/effort, MCP digest and attachments.
Restart holds undispatched turns and marks potentially handed-off turns outcome-unknown. Never
blindly resend. Decisions reserve their response durably before one native write; an uncertain
response cannot be resubmitted as a new decision. Invalid multi-field answers are rejected before
reservation. An unsuccessful turn holds queued work for explicit continuation.

Managed feedback uses immutable inbox IDs and the existing delivery reservation/acknowledgment
path. Grants cannot claim another chat's targeted feedback. Claims/resolve use the ordinary workspace
mutex and proven pre/post interval; native tool events/diffs alone prove no authorship. Human saves
retain precedence. Forget/adoption fence admission before async cleanup and refuse live/held/unknown
work. Managed history remains tied to registration ID plus epoch, never rebound by matching a slug.

Bounds: 64 KiB serialized journal records; 64 MiB per intent journal; 256 MiB blob bytes per chat;
10 MiB per attachment, ten attachments and 20 MiB aggregate per send. Display/history paging does
not delete original durable messages. Disk errors stop admission instead of acknowledging lost intent.
