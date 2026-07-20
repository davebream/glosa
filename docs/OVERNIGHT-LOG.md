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

---

## Decisions made

<!-- small autonomous calls + rationale -->

---

## Blocked — needs Dawid

- **P5.3 format-sermon companion diffs (HITL)** — pre-marked ⛔; touches `~/.claude/skills/format-sermon/`
  outside the repo. Will prepare proposed diffs as a doc, not apply.
- **P5.4 manual rehearsal (T8)** — pre-marked ⛔; needs a live Claude session + Dawid's eyes.

---

## SUMMARY

<!-- filled when the goal clears -->
