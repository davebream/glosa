# glosa — overnight build log

Running narrative of the autonomous overnight build. Newest entries appended at the bottom of each
section. Source of truth for *progress* is `docs/BUILD-PLAN.md` (checkboxes); this file is the *why*
and the audit trail.

---

## Session log

### Session 1 — start 2026-07-21

**Phase 0 probes (green):**
- `bun --version` → 1.2.7 (meets ≥1.2.7 floor).
- `git status` → clean, on `main`, tracking `origin/main`.
- Branch policy resolver → `direct-to-main` (commit straight to main; no branch/PR).
- `bun test` → 1 pass (scaffold smoke), 0 fail.
- `bun run typecheck` (`tsc --noEmit`) → clean.
- Read `requirements.md` (R1–R9, T0–T8) fully; read `BUILD-PLAN.md`; skimmed appendix headings.
- Scaffold state: root `package.json` (workspaces `packages/*`), `tsconfig.json` (strict,
  noUncheckedIndexedAccess), each package has `package.json` + placeholder `src/index.ts`.

Starting the loop at **P1.1**.

---

## Per-task entries

<!-- one entry per task as it lands -->

### P1.1 monorepo scaffold — ✅ (commit 908379e)
- **Built (self, not delegated — light scaffold config, plan says "extend, don't recreate"):** fleshed
  out all six `packages/*` `package.json` (description + `exports` map); CLI gets `bin.glosa` + a real
  `src/main.ts` executable entry (the GLOSA_BIN target, A6 §F26) delegating to `run()` in `index.ts`
  (stub: `--version`→0, `--help`→0, unknown→exit 2). Root `prepare` script installs the git hook.
- **Real fix found:** root `workspaces` glob was `["packages/*"]`, which does **not** match the nested
  `packages/providers/*` and `packages/adapters/*` — those three packages were never symlinked. Fixed
  the globs; `bun install` now links all six. `test/workspace.test.ts` proves every package resolves by
  name (this test failed before the glob fix — real, not theater).
- **Pre-commit gate:** dependency-free `.githooks/pre-commit` (runs `bun run typecheck` + `bun test`),
  wired via `core.hooksPath=.githooks` (no lefthook binary → honors no-native-deps). Verified it fires
  and exits 0.
- **tsconfig:** added `allowImportingTsExtensions: true` (typecheck caught `main.ts`'s `./index.ts`
  import; idiomatic for no-build-step Bun).
- **Tests:** 3 pass / 0 fail; typecheck clean. CC: no (no adversarial pass needed).

### P1.2 daemon lifecycle + lock — ✅ (commit a1066c9) — CC, adversarially reviewed
- **Built (Sonnet subagent):** `packages/daemon/src/{home,lock,protocol,handshake,lifecycle,index}.ts` +
  `packages/cli/src/{index,main}.ts` wiring `__daemon`. `bootDaemon()` = bind 127.0.0.1:port → O_EXCL
  lock CAS → ignore SIGHUP/SIGINT, SIGTERM graceful → serve readiness handshake; exit codes 0/3/4 per
  F13. `ensureDaemon()` = client find-or-spawn (detached, unref, scrubbed env, poll ≤5s). Hermetic via
  `GLOSA_HOME` env override.
- **Adversarial pass (kombajn-dev:critic + my own review) found + fixed:**
  - **CRITICAL (R1 singleton):** original `ensureDaemon` did an unconditional `unlinkSync` + respawn on
    ambient `GLOSA_PORT` when the lock's pid was alive but the handshake didn't answer — could orphan a
    live daemon's lock or, when ports differ, run **two daemons**. **Fixed:** added `probePortBound()`
    (node:net) — reclaim only when the port is provably free (ECONNREFUSED); if bound-but-silent → **fail
    closed** (no unlink, no spawn); fallback spawn now always targets the authoritative `lock.port`.
  - **MAJOR:** the `ANTHROPIC_API_KEY` scrub (invariant #5, "the $1,800 footgun") had **zero** test
    coverage. **Fixed:** extracted pure `buildChildEnv()` + a **real OS round-trip** test that spawns a
    child and reads back its actual `process.env` (asserts the key is `<<ABSENT>>`).
  - Minors fixed: poll budget tightened to ≤5s; `shutdown()` async + awaits `server.stop()`;
    `parseProtocolVersion` hardened (rejects `""`/`"1"`/`"1.2.3"`); added tests for the live-peer EEXIST
    branch and the new fail-closed path.
- **Tests:** 33 pass / 0 fail (30 in daemon: real subprocess fault/concurrency — two-spawn race,
  stale-lock reclaim ×3, port authority, SIGTERM guard, SIGINT/SIGHUP ignore, proto mismatch,
  fail-closed, scrub round-trip). Typecheck clean. Verified helpers + gate independently before commit.

---

## Decisions made

<!-- small autonomous calls + rationale -->

### D1 — Host-mismatch vs Origin-mismatch HTTP status (for P1.3)
A1 §1/§9 says "Origin/Host not allowlisted → 403"; A3 §4 Rule 1 explicitly says **Host** mismatch →
**400, close, no body**. Between two appendices with no stated precedence, the security appendix (A3)
owns the Host/Origin auth table and is more specific. **Decision:** Host literal mismatch → **400**;
foreign **Origin** rejection → **403**. Coherent split; satisfies A3's explicit rule and A1's 403 table
for Origin. Apply in P1.3.

### P1.3 HTTP skeleton + auth — ✅ (commit 5909d71) — CC, security + adversarial review
- **Built (Sonnet subagent):** two loopback `Bun.serve` listeners (4646 API + 4647 class-F, both
  Host-checked); `auth.ts` `authorizeRequest` (pure, route-class-scoped Origin/Bearer per A3 §4 — Bearer
  before Origin so no-token→401 regardless of origin); `confine-path.ts` `confinePath` (realpaths nearest
  existing ancestor → catches symlink escape even for not-yet-created files; tracked-artifact glob check
  deferred to P2.2); `token.ts` (constant-time `timingSafeEqual`, length-oracle-safe); `contract.ts`
  (X-Contract-Version major-mismatch→409, minor→stale-minor warning); `problem.ts` (RFC 9457 envelope);
  `csp.ts` (SPA + class-F CSP strings, verified verbatim vs A3); handshake body = D2 superset (keeps P1.2
  fields, adds contract_version/daemon_version/paired).
- **Adversarial pass — security-auditor (no critical/high; CSP verbatim, DNS-rebinding defeated, tokens
  constant-time) + critic (2 blockers) + my review:**
  - **BLOCKER 1 (route-enumeration side channel):** unmatched route returned 404 before the Origin check →
    foreign origin got 403 on real routes, 404 on fake. **Fixed:** foreign Origin → 403 before 404 (D3).
  - **BLOCKER 2 (latent info-leak):** no global try/catch → a future throwing handler would leak Bun's
    dev-error HTML (source, no CSP). **Fixed:** whole pipeline try/catch on both listeners → detail-free
    `internalErrorResponse` (500 problem+json + CSP) + a Bun.serve `error:` callback.
  - **Real bug the subagent found while fixing the test flake:** `development: false` on `Bun.serve`
    (Bun 1.2.7) silently breaks cross-process EADDRINUSE detection → two racing daemons both bind →
    **R1 singleton violation**. It correctly REFUSED my `development:false` instruction, kept only the
    `error:` callback (which alone suppresses the dev overlay), and documented it. Verified: two-concurrent-
    spawn test green across 3 runs.
  - Decisions logged: D3 (origin-on-unmatched), D4 (malformed contract-version → lenient).
  - Test-infra: fixed a **pre-existing P1.2 port-collision flake** (random-port step bumped to 4 so the
    class-F `port+1` derivation can't collide; per-test local home state). Ran full suite 3× post-fix →
    102 pass / 0 fail every time, typecheck clean.

### P1.4 pairing + SPA shell — ✅ (commit d63d192) — CC: no
- **Built (Sonnet subagent):** `token.ts` `mintToken`/`ensureToken` (128-bit, atomic tmp+fsync+rename,
  0600, never overwrites); daemon serves `GET /` (SPA shell) + `GET /app/<file>` (static ES modules,
  allowlist-keyed), both **navigation** class (no Bearer), SPA CSP + nosniff. SPA: `packages/spa/src/
  shell.html` (four hidden `data-screen` containers) + `bootstrap.js` (**plain .js, not .ts** — no build
  step means nothing transpiles between disk and browser; added `allowJs:true` to tsconfig). `scrubToken`
  + `selectScreen` are pure/injectable; `main()` guarded by `typeof window`.
- **Decision D5 applied:** pairing fragment is `#t=<token>` (A1/A3 wire format), not A6's looser
  `#<capability>`. Comment in http.ts.
- **My review found + fixed (myself, 1-liner):** `SPA_ASSETS[name]` lookup let a prototype key
  (`__proto__`/`constructor`) resolve to a truthy inherited value, slipping past the `undefined` guard →
  `readFileSync` → 500 instead of 404. Hardened to `Object.hasOwn` + added a regression test (`/app/
  __proto__` → 404). Not a file-disclosure (allowlist still blocks path escape), just robustness.
- **Security property tested:** `scrubToken` fake-location/storage/history test asserts token → sessionStorage,
  localStorage untouched, `replaceState` strips `t=` (the "token never in history/localStorage" invariant).
- **Tests:** 125 pass / 0 fail; typecheck clean. Real-browser E2E (vs fakes) deferred to T8/rehearsal.

### P2.1 journal-as-truth — ✅ (commit 7ab393a) — CC, the correctness core, doubly adversarially reviewed
- **Built (Sonnet subagent):** `packages/daemon/src/bus/` — `ulid.ts` (monotonic Crockford ULID, injectable
  clock/random), `mutex.ts` (FIFO `AsyncMutex` + per-workspace `KeyedMutex`), `io.ts` (short-write loop +
  dir-fsync), `journal.ts` (append-only, fsync-before-ACK for lifecycle events, MAX_EVENT_BYTES=65536
  oversize-reject-before-fd-touch), `inbox.ts` (immutable write-once), `quarantine.ts`, `replay.ts` (pure
  fold, event_id + idem dedup, pluggable reducer — P2.5 swaps the full transition table in), `reconcile.ts`
  (ordered startup: torn-tail truncate → replay → inbox↔journal self-heal; steps 4–5 apply-lease/offline
  are typed stubs for P2.3), `bus.ts` (WorkspaceBus facade). Fault suite truncates at **every byte offset
  of every record** → asserts recovery is exactly one of {before, after} state, never partial.
- **Two parallel adversarial reviews (concurrency-expert + critic), both probe-verified — 1 blocker + 3
  durability fixes, all fixed:**
  - **BLOCKER (idempotency):** `replayJournal` re-appended a `line_quarantined` event + re-copied the bad
    line on EVERY replay (a malformed line has no event_id to dedup on) → journal + quarantine file grew
    unboundedly per daemon restart. Derived state stayed byte-identical, which is why the original tests
    missed it. **Fixed:** `line_quarantined.detail.hash = sha256(raw line)`; replay pre-scans existing
    hashes and skips the re-append. Regression: reconcile ×2 → identical journal + event counts.
  - **Durability (inbox):** `renameSync` silently overwrites (no syscall write-once) AND wasn't dir-fsynced
    → on power loss the rename could un-happen *after* `entry_created` was durable = the "reverse gap"
    reconcile assumes impossible. **Fixed:** `linkSync` (atomic EEXIST) + `unlinkSync(temp)` +
    `fsyncContainingDir` before returning.
  - **Durability (torn-tail):** `truncateSync` relied on a later append's fsync. **Fixed:** explicit
    `fsyncSync` right after truncate.
  - **Robustness (mid-process):** a partial `writeAllSync` (e.g. transient ENOSPC) left torn tail bytes
    while the daemon kept running → next append concatenated into a garbled line. **Fixed:** capture size
    before write, `ftruncateSync` back on throw. Plus `WorkspaceBus.close()` now drains via the mutex +
    a `closed` flag so post-close writes throw.
  - Deferred with notes: one-WorkspaceBus-per-root registry (P2.4, not wired yet); KeyedMutex eviction.
- **Tests:** 159 pass / 0 fail (34 in bus/), 2× stable, typecheck clean. The fault suite was independently
  judged genuinely rigorous (real strict two-state invariant, all offsets), not theater.

### P2.2 picomatch matcher — ✅ (commit 4df10cc) — CC: no
- **Built (Sonnet subagent):** `packages/daemon/src/matcher.ts` — the ONE canonical file LIST (A4 §F20).
  `resolveMatchedFiles(root) → {tracked, oversize, skippedSymlinks}`; `lstat`-only walk (symlinks neither
  followed nor matched — closes F24 escape); NFC comparison key (`path`) + raw on-disk `rawPath` for fs ops
  (APFS NFD gotcha); picomatch include-minus-exclude, `nocase:false`; strict-over-2MiB → oversize;
  deterministic `Buffer.compare` byte-sort; `diffSnapshots` emits file_tracked/file_untracked{oversize|
  deleted} crossing descriptors; `loadMatcherConfig` deep-merges `.glosa/config.json` (throws on bad JSON).
  Added `picomatch` dep (A4 sanctions it — pure JS). Strong edge tests: NFC/NFD, symlink safety, size
  boundary, byte-sort-vs-locale, config override.
- **My review + fix (myself):** the walk didn't prune — it `lstat`'d into `node_modules`/`.glosa` and only
  filtered per-file, a predictable perf cliff once P2.3 fills `.glosa/shadow.git`. **Fixed:** derive
  directory-prune patterns from the SAME exclude list (`P/**` → prune dirs matching `P`) — single source of
  truth, no second glob. Added a behavioral test (symlink inside a pruned subtree is never discovered).
- **Deferred (noted):** `followSymlinks` config field is carried but intentionally NOT wired — no-follow is a
  hardcoded security invariant per F20.
- **Tests:** 199 pass / 0 fail (40 matcher); typecheck clean.

### P2.3 shadow-git + apply-lease — ✅ (commit cd6e6a1) — CC, the provenance core, doubly adversarially reviewed
- **Built (Sonnet subagent):** `packages/daemon/src/git/shadow.ts` (argv-safe `runGit` — never a shell,
  `--git-dir/--work-tree` injected, isolated env; `safePathspec` + `--` for argv safety; deterministic
  init → `refs/heads/glosa` + baseline; `checkpoint` idempotent via `diff --cached --quiet`; trailers
  Glosa-Attribution/Kind/Entry/Lease; constant `glosa <glosa@localhost>` identity; `reclaimIndexLock`) +
  `bus/lease.ts` (TTL, typed errors) + `WorkspaceBus.applyBegin/resolveEntry` (pre/post checkpoints →
  proven `pre..post` = `session:<id>`) + reconcile steps 4–5 (`reconcileApplyLeases`, `offlineCatchUp`).
- **Two parallel adversarial reviews (concurrency-expert + critic), all probe-verified — 4 CRITICAL
  false-attribution/provenance bugs + 2 should-fix, all fixed:**
  - **C1 forgery:** `resolveEntry` never checked the caller's session against the lease holder → any
    caller could resolve another session's lease and be credited. Fixed: `LEASE_SESSION_MISMATCH` guard +
    attribute via **`lease.session`**, never the caller arg.
  - **C2 overwrite:** `offlineCatchUp` checkpointed even during an open lease → committed the in-flight
    edit as `unknown`, so the durable git trailer contradicted the journal. Fixed: skip when `applyLease`
    is present (active).
  - **C3 self-staging:** `checkpoint`'s empty-union `else git add -A` recursively staged `.glosa/shadow.git`'s
    own object store + the journal. Fixed: empty union → return HEAD, no add.
  - **C4 DoS:** `trackedUnion`'s non-`-z` `ls-tree` split bricked `checkpoint` forever for a filename with a
    tab/newline (git C-quotes those regardless of `quotepath`). Fixed: `ls-tree -r -z` + split `\0`.
  - **S5 trailer forgery:** unescaped trailer values let a `\n` forge a `Glosa-Attribution: human` line.
    Fixed: reject control chars in trailer values (`TRAILER_INJECTION`).
  - **S6 env config injection:** ambient `GIT_CONFIG_COUNT/KEY/VALUE` outranked `GIT_CONFIG_GLOBAL=/dev/null`.
    Fixed as part of the isolation fix below.
- **Bug the pre-commit hook itself caught (mine to fix):** the first commit attempt FAILED — the hook runs
  `bun test` WHILE git has `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` set, and those leaked into the
  shadow-git subprocesses (33 failures), hijacking them onto the main repo's index. Real isolation bug, not
  a test artifact. **Fixed:** `isolatedEnv` now strips the **entire `GIT_` namespace** (shadow ops pass
  `--git-dir/--work-tree` on argv, so they need zero inherited git vars), then re-pins only what it wants.
  Added a regression test that runs init+checkpoint under leaked `GIT_DIR/INDEX_FILE/WORK_TREE` and proves
  the op hits the shadow repo. **Lesson for the handoff:** any git-subprocess code must strip `GIT_*`.
- **Tests:** 235 pass / 0 fail (incl. the full suite green UNDER the simulated hook env); typecheck clean.
- **Deferred → P2.4:** single-WorkspaceBus-per-root registry (both reviewers: the single-writer guarantee
  is convention-only; wire reconcile + the live bus to share one mutex/instance at P2.4).

### P2.4 registry + workspace index + routing — ✅ (commit 32f89d5) — CC, doubly adversarially reviewed
- **Built (Sonnet subagent):** `packages/daemon/src/registry/` — `slug.ts` (canonicalize + F25 collision-
  lengthening), `workspace-index.ts` (`<GLOSA_HOME>/workspaces.json`, AsyncMutex-serialized, atomic
  temp→fsync→rename, GC with grace + `hasLiveSession` predicate), `session-registry.ts` (in-memory, liveness
  = lease/heartbeat, **never** `kill(pid,0)`), `routing.ts` (explicit-binding > cwd-ancestor, park/drain,
  picker-not-guess), `lockfile-fallback.ts` (jethro's `withSessionLease` ported — O_EXCL CAS + stale reclaim,
  proven with a 5-process×8-increment cross-process test). `bus/workspace-bus-registry.ts` (the deferred
  single-WorkspaceBus-per-root registry — closes P2.3's convention-only single-writer gap).
- **Two parallel adversarial reviews (concurrency-expert + critic) — NO blockers; 6 should-fix hardening
  items applied:** (1) `WorkspaceBusRegistry` bus leak on GC hard-remove → `onHardRemove` hook + `evict()`;
  (2) cwd-ancestor fallback now scopes to the **nearest (deepest) ancestor** (A2 §F08) instead of surfacing
  a needless picker; (3) `register()` rolls back the in-memory session if the index upsert throws (no
  routable-but-unindexed session); (4) corrupt `workspaces.json` is now **quarantined** (`.corrupt.<ts>` +
  warn) instead of silently discarded (matches the journal convention); (5) an **unwired GC** (predicate not
  set) now soft-deletes only, never hard-removes a possibly-live workspace; (6) sync-invariant comments on
  the mutex-bypassing park set. Reviewers verified adversarially: routing precedence both directions, park/
  drain keying, slug determinism/termination, GC AND-logic + grace boundary, fallback CAS, liveness boundary.
- **Deferred (`// P4.3:` notes in-code):** daemon-side index writes must share the O_EXCL fallback lease with
  the hook-side writer once that caller exists (not reachable yet); slug 64-hex-cap duplicate (negligible).
- **Tests:** 309 pass / 0 fail (incl. full suite green UNDER the git-hook env → pre-commit safe); typecheck clean.

### P2.5 lifecycle state machine — ✅ (commit 5b0cc36) — CC, doubly adversarially reviewed → **Phase 2 COMPLETE**
- **Built (Sonnet subagent):** `packages/daemon/src/bus/lifecycle.ts` — the full guarded transition reducer
  (two axes/tables selected by entry `kind`: common `pending→delivered→seen→{applied|rejected|stale}`,
  attention `open→delivered→seen→{done|expired|stale}`), guarded (transition applies only from a legal
  `from`, else ignored on replay = idempotent), first-terminal-wins, `delivery_attempt` structurally off the
  status axis. Swapped into P2.1's pluggable `Reducer`. D7 (generic `transition_committed`/`attention_committed
  {to}` events) + D8 (A5 §F23 terminal vocabulary) applied.
- **Two parallel adversarial reviews (critic + concurrency-expert) — 1 blocker + release-gate fix + should-fix,
  all fixed:**
  - **BLOCKER:** entry-kind was read from `entry_created.detail.kind`, but `kind` lives in the inbox payload
    and `createEntry` never copied it → attention entries silently got the COMMON guard table → all
    `attention_committed{done|expired}` ignored → status stuck → R9 `--wait` would hang forever. Fixed:
    `createEntry` derives the event `detail.kind` from `payload.kind`; test drives a real attention entry to `done`.
  - **HIGH (release gate):** the P2.1 fault-injection suite — the project's *actual* release gate — ran
    `reconcileWorkspace` with the minimal placeholder reducer, so it validated crash-recovery against the WRONG
    reducer. Fixed: `reconcileWorkspace` defaults to `lifecycleReducer`; the fault suite's reference fold uses it
    too → the gate now tests the production guarded reducer.
  - **D8 conformance:** dropped the `applied→resolved` remap (`to = outcome`); common terminals are now
    literally `applied/rejected/stale` per A5 §F23 (updated ~15 test sites).
  - **should-fix:** auto-vivify now guards the `to` value (no limbo entries); added live-bus==restart round-trip
    test + wrong-axis tests; `recordDeliveryAttempt` now carries the F23 `detail` fields.
  - Confirmed sound by review: live-fold == replay-fold is *mechanically* identical (same `applyEvent`, same
    mutex-serialized order), replay-twice byte-identical.
- **Tests:** 341 pass / 0 fail (incl. full suite green UNDER the git-hook env); typecheck clean.

### P3.1 full HTTP route catalog + daemon-boot wiring — ✅ (commit b2a5464) — CC: no, focused security review
- **Built (Sonnet subagent):** the full A1 §5 `/w/:slug/…` route catalog in `http.ts`, integrating the Phase-2
  backends. `buildBackend` (lifecycle.ts) constructs the daemon's ONE `WorkspaceIndex`+`SessionRegistry`+
  `WorkspaceBusRegistry` and wires the P2.4-deferred predicates (`setLiveSessionPredicate`,
  `setOnHardRemove`→`evict`). Fully wired: workspaces, artifacts (matcher), artifacts/:path (raw + `?render=html`
  via new `artifact-render.ts` markdown-it + `data-line` stamps, `sourceSha256` = SHA256 after `\r\n→\n`),
  annotations POST (→ WorkspaceBus.createEntry, 201), diff (shadow-git + trailer attribution via
  `checkpoint-diff.ts`), inbox, session-binding. GETs use a **read-only journal peek-fold** (no git/writes).
  Shells (full auth pipeline, 501): stream (P3.2), transcript/stream (P4.2), capability (P4.1), inbox-response
  (F12). Added `markdown-it` dep.
- **Focused critic review — all 9 security invariants confirmed holding** (slug-gate-first, confinePath +
  tracked-membership on every path, class-F never served through class-R, full auth pipeline on shells,
  argv-safe validated diff, read-only peek). **2 should-fix bugs found + fixed:**
  - **honest-kind violation:** annotations handler spread the raw client body after `kind:"annotation"`, so a
    client could POST `kind:"attention_request"` and forge a fake attention entry. Fixed: explicit picked
    fields only.
  - **reconcile-cache landmine:** the reconcile-once gate was a module-level Set keyed by root string, so
    after `forget`/GC evict + reopen a fresh bus was never reconciled (state not replayed). Fixed: moved
    `reconciledOnce` onto the `WorkspaceBus` instance. + capability shell now confinePath-checks (P4.1 prep).
- **Tests:** 392 pass / 0 fail (incl. full suite green UNDER the git-hook env); typecheck clean.

### P3.2 streaming SSE — ✅ (commit 652a739) — CC, doubly adversarially reviewed
- **Built (Sonnet subagent):** `src/sse.ts` (frame encode + client fetch-streaming parser, NOT EventSource),
  `src/bus/tail.ts` (journal-line count + `readJournalEventsSince`), `src/stream.ts` (`GET /w/:slug/stream`:
  first-connect snapshot at the current cursor, reconnect resume from a journal-line cursor via
  `Last-Event-ID`/`?since`, live push via a new in-process `WorkspaceBus.subscribe` notifier, chokidar v4
  artifact watch, 15s heartbeat + `server.timeout(req,0)` scoped to the response). Cursor = physical journal
  line offset, recomputed from disk so it's stable across restart. Added `chokidar` dep.
- **Reviews (concurrency-expert + critic) — core no-loss/no-dup/restart invariant CONFIRMED sound** (Bun runs
  `ReadableStream.start()` synchronously → subscribe→cursor-read is atomic; append+notify is one sync unit
  under the bus mutex). **2 HIGH bugs found + fixed:**
  - a numeric-but-out-of-range cursor (`≤ -2`) crashed the reconnect (500) + leaked a listener → guard
    `sinceSeq >= -1` (else first-connect) + clamp in `readJournalEventsSince`.
  - `notify()` had no per-listener isolation → a throwing listener rejected the write (500-ing a client whose
    data saved) AND skipped later listeners (event loss for other SSE clients) → try/catch per listener.
  - + defensive teardown-on-throw in `start()`.
- **Tests:** 431 pass / 0 fail (verified 4× incl. git-hook env). **⚠ FLAKE watch:** the subagent saw one
  transient artifact in the idle-timeout-override test ("bogus multi-billion-ms duration in Bun's reporter")
  on one run — did NOT reproduce in my 4 runs; treated as a Bun runner/timing artifact, not a logic bug.
  If the pre-commit hook ever flakes there, it's this real-timer test under parallel load.
- **Follow-ups noted in-code (`// P3.3:`/`// follow-up:`):** (a) one chokidar watcher per SSE connection →
  share per-root later; (b) no `desiredSize` backpressure (stalled-but-connected client grows memory);
  (c) **P3.3 must re-fetch `GET /w/:slug/artifacts` after every SSE reconnect** — artifact frames aren't
  journaled, so a file change missed during a disconnect isn't replayed (spec-faithful, A1 §8.2 case 3).

### Plan change observed (Dawid edited BUILD-PLAN.md mid-run) — P6.1 supersedes P4.5
Dawid added **Phase 6 / P6.1** and marked P4.5 superseded. Substance: glosa exposes a **generic**
adapter-registration protocol (session→artifact binding, derived-from edges, data-path recognition,
class-F manifest resolution) registered by *external* code at runtime. Prove it with a **neutral in-repo
fixture adapter only**; **delete the `packages/adapters/jethro` stub**; NO `jethro` identifier anywhere
under `packages/daemon` or `packages/spa`. Real jethro integration lives in the **jethro repo** (jethro
CLI + hook + skills) — OUT OF SCOPE here; leave a jethro-side handoff note in this log at P6.1 time.
Dependency arrow jethro→glosa only. CC: yes. **Action items:** (a) when I reach P4.5, do P6.1 instead;
(b) at P6.1, drop `packages/adapters/jethro` from the workspace globs + delete the package; (c) re-read
BUILD-PLAN.md at each task pickup since Dawid may edit it again overnight.

### D7 — lifecycle event representation (P2.5)
A5 §F23 lists distinct event names (created/delivered/seen/resolved/done/staled/expired). P2.1 reserved +
P2.3 already emits the generic `transition_committed{to}` / `attention_committed{to}`. **Decision:** the
lifecycle reducer standardizes on those generic transition events; the A5 names become `to` values + the
guard table (keyed off the entry's stored `kind`, common vs attention). Keeps P2.3's emission unchanged.

### D8 — terminal status vocabulary conforms to A5 §F23 (P2.5 review)
The code had mapped resolve outcome `applied → status "resolved"` (rejected/stale mapped to themselves).
A5 §F23 says common terminals are **applied/rejected/stale**. **Decision:** conform to the spec —
`resolveEntry` emits `to = outcome` (status becomes `applied`), `COMMON_TERMINALS = {applied,rejected,stale}`.
CLAUDE.md treats appendix conformance as review-blocking, so we conform rather than ratify the deviation.
(P2.5 mid-revision as of this note: also fixing an entry-kind blocker — attention entries were silently
getting the common guard table — and pointing the release-gate fault suite at the real `lifecycleReducer`.)

### D2 — handshake body shape reconciliation (for P1.3)
P1.2 gave `/api/handshake` an internal readiness body `{protocol_version, instance_id, pid, started_at}`.
A1 §5.1 mandates the **public** body `{contract_version, daemon_version, paired}`. Same endpoint serves
both readiness (F13) and contract negotiation (A1). **Decision (as built in P1.3):** the handshake body is
a **superset** — `{contract_version, daemon_version, paired}` (A1 §5.1, for the SPA) PLUS P1.2's
`{protocol_version, instance_id, pid, started_at}` (for lifecycle readiness). `contract_version` ==
`protocol_version` == `PROTOCOL_VERSION` ("1.0") today. **Correction (per P1.3 adversarial review):**
`ensureDaemon()` intentionally still reads/validates **`protocol_version`** (lifecycle compat), NOT
`contract_version` — lifecycle-compat and API-contract-compat are kept as two separate concerns that happen
to share one route (`protocol.ts` vs `contract.ts`). This is more correct than my original note; the two
version constants may legitimately diverge later. No code change needed — the superset keeps P1.2's client
working unchanged.

### D3 — Origin allowlist on unmatched routes (P1.3 review, BLOCKER 1)
A1 §1 ("Origin allowlisted first, 403 regardless of route") vs A3 §4/R5 ("Origin check is route-class-
scoped"). The original P1.3 returned 404 for unmatched routes before any Origin check → a foreign origin
could distinguish real routes (403) from fake (404) = a route-enumeration side channel. **Decision:** an
unmatched route with a present-and-foreign `Origin` → **403 invalid-origin** before the 404; absent/self
Origin → normal 404. Satisfies A1 §1 without weakening A3 §4's per-class rules on matched routes.

### D4 — malformed `X-Contract-Version` (P1.3 review, SHOULD-FIX 3)
A1 §3 only blesses leniency for a *missing* header. **Decision:** unparseable/partial versions (`""`, `"1"`,
`"1.0.0"`, `"abc"`) are treated as "missing → lenient, same major assumed" (A1 §3's stated intent for
non-SPA clients like a future CLI); only a **well-formed value whose major differs** from PROTOCOL_VERSION →
409. Documented in a `contract.ts` comment + a `contract.test.ts` matrix.

---

## Blocked — needs Dawid

- **P5.3 format-sermon companion diffs (HITL)** — pre-marked ⛔; touches `~/.claude/skills/format-sermon/`
  outside the repo. Will prepare proposed diffs as a doc, not apply.
- **P5.4 manual rehearsal (T8)** — pre-marked ⛔; needs a live Claude session + Dawid's eyes.

---

## SUMMARY

<!-- filled when the goal clears -->
