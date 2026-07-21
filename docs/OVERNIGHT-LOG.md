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
