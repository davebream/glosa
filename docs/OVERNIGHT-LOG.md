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
both readiness (F13) and contract negotiation (A1). **Decision:** P1.3 reshapes the handshake response to
A1 §5.1 (`contract_version` == the `PROTOCOL_VERSION` constant), keeps `protocol_version` in the lock file,
and `ensureDaemon()`'s proto-compat check reads `contract_version` from the handshake JSON (major must
match). Note this when delegating P1.3.

---

## Blocked — needs Dawid

- **P5.3 format-sermon companion diffs (HITL)** — pre-marked ⛔; touches `~/.claude/skills/format-sermon/`
  outside the repo. Will prepare proposed diffs as a doc, not apply.
- **P5.4 manual rehearsal (T8)** — pre-marked ⛔; needs a live Claude session + Dawid's eyes.

---

## SUMMARY

<!-- filled when the goal clears -->
