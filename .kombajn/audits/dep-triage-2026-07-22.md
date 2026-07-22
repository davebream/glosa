# Dependency Triage Report — 2026-07-22

**Repo / base:** davebream/glosa @ `main` (head `a40ef29`)
**Ecosystem / bot(s):** npm (via Bun 1.2.7) + github_actions; Dependabot only (`author.is_bot: true`, `app/dependabot`, `dependabot/*` branches — all 5 confirmed)
**Commands:** install=`bun install --frozen-lockfile` typecheck=`bun run typecheck` (`tsc --noEmit`) test=`bun test` (run twice in CI; plus `bun run audit:licenses`, `bun run package:check`)

**Verdict:** Merge the three github_actions bumps (#11, #12, #13) — all mergeable, both required checks green, only `BEHIND`. The two npm majors (#14 typescript, #15 chokidar) are blocked by a Dependabot/Bun lockfile-sync failure that masks the real migration question — route to manual review, do not merge.

## Queue

| PR | Package(s) | From → To | Type | mergeable | mergeStateStatus |
|---|---|---|---|---|---|
| #15 | chokidar (dep; `@glosa/daemon` + root) | 4.0.3 → 5.0.0 | npm MAJOR | MERGEABLE | BLOCKED (ci fail) |
| #14 | typescript (devDep) | 5.9.3 → 7.0.2 | npm MAJOR | MERGEABLE | BLOCKED (ci fail) |
| #13 | google/osv-scanner-action | 8dc0919 → a82132c (SHA) | actions | MERGEABLE | BEHIND |
| #12 | actions/checkout | 6.0.3 → 7.0.1 | actions MAJOR | MERGEABLE | BEHIND |
| #11 | actions/setup-node | 6.5.0 → 7.0.0 | actions MAJOR | MERGEABLE | BEHIND |

`mergeable` for #11/#12/#13 required polling — first query returned `UNKNOWN/UNKNOWN`, resolved to `MERGEABLE/BEHIND` on the second pass.

Corrections to initial assumptions, verified in-repo:
- **`actions/setup-node` IS used** — `.github/workflows/release.yml:51` (v6.5.0). Not in ci.yml. PR #11 is a live reference, not dead config; it edits release.yml only.
- Nested `package.json` files exist (`packages/{cli,spa,daemon}`, `packages/providers/{claude-code,codex}`). `chokidar ^4` is a direct dep of `@glosa/daemon` as well as root.
- `actions/checkout` (#12) and `osv-scanner-action` (#13) each appear in **both** ci.yml and release.yml.

## Coupling

**No coupling — no peer graph exists.** Peer metadata pulled from each locked version's registry packument (LOCKED versions from bun.lock, not package.json ranges):

| Package | Locked (bun.lock) | peerDependencies at from | peerDependencies at to |
|---|---|---|---|
| chokidar | `chokidar@4.0.3` | none | none; adds `engines: node >= 20.19.0` |
| typescript | `typescript@5.9.3` | none | none; `engines: node >= 16.20.0` |

No workspace package declares `peerDependencies`. github_actions bumps have no peer graph. Zero cross-PR coupling sets — every PR is independent. Dependabot config declares no `groups`, so the dependabot-core#14202 grouped-major-suppression bug does not apply.

## Base branch health

Green and observable. `ci.yml` ran on main's current head `a40ef29` via `push`, conclusion `success` (2026-07-21T22:51Z). Independently reconfirmed by local worktree run below.

## Machinery

- `allow_auto_merge: false` (repo-level). Squash-only, `required_linear_history: true`, `allow_update_branch: true`.
- Classic branch protection on `main`: required status checks `ci` + `security`, `strict: true` (require up-to-date — this is what makes #11/#12/#13 `BEHIND`), `enforce_admins: true`, `required_approving_review_count: 0`, `required_conversation_resolution: true`.
- Rulesets: `[]`; effective rules (`/rules/branches/main`): `[]` — both protection paths checked, no ruleset false-negative.
- Check runs: #11/#12/#13 → `ci` pass + `security` pass (BEHIND is the only blocker). #14/#15 → `ci` **fail**, `security` pass.

## Local verification

Isolated worktree (detached from `origin/main`), candidate = PR #13 (osv-scanner SHA bump) merged into main. Merge clean, diff = 2 lines (SHA in ci.yml + release.yml), zero change to package.json/bun.lock.

```
bun install --frozen-lockfile   → rc=0  (172 packages, lockfile intact)
bun run typecheck (tsc --noEmit) → rc=0
bun test                         → 1109 pass, 0 fail, 10346 expect() calls  → rc=0
```

Worktree removed afterward; working tree confirmed clean. #14/#15 were **not** locally built (see Gaps).

**Why #14 and #15 fail CI** (from `--log-failed`, read-only): both die at the install step, identically:
```
error: lockfile had changes, but lockfile is frozen
note: try re-running without --frozen-lockfile and commit the updated lockfile
```
Dependabot bumped `package.json` but did not regenerate `bun.lock` (no native Bun-lockfile support). CI never reaches typecheck or test, so TS7 / chokidar-5 code compatibility is **untested, not disproven**.

## Merge plan

1. **PR #13 — osv-scanner SHA bump.** Mergeable, both required checks green, workflow-only, no dep-graph impact, only `BEHIND`. Locally verified: install+typecheck+1109 tests pass; diff is 2 SHA lines. Class: mechanical.
2. **PR #12 — actions/checkout 6.0.3 → 7.0.1.** Mergeable, `ci`+`security` green on the PR, `BEHIND` only. Touches ci.yml + release.yml but non-overlapping lines with #11/#13. Class: mechanical (major action version, but self-testing — the PR's own CI already exercised the new checkout and passed).
3. **PR #11 — actions/setup-node 6.5.0 → 7.0.0.** Mergeable, green, `BEHIND` only; edits release.yml only. Note: required `ci`/`security` checks on the PR do not exercise release.yml's setup-node — see Gaps. Class: mechanical, with the release-path caveat below.
4. **PR #15 — chokidar 4 → 5** and **PR #14 — typescript 5 → 7.** Required `ci` failing; failure is a stale-lockfile block hiding the real migration question. Major runtime dep (file-watcher used in the daemon's file-bus layer) and the compiler itself. Class: needs-review → route to `/plan` + a TS7/chokidar-5 changelog read once the lockfile is regenerated. **Do not merge as-is.**

**Sequencing note:** because `strict: true`, each merge makes the remaining PRs `BEHIND` — "Update branch" (re-triggers ~1m50s CI) is needed before the next merge. Order 1→2→3 is otherwise interchangeable; nothing couples them. `allow_auto_merge: false` means every merge is manual.

## Config fixes (proposals only — not applied, route policy calls to `/oss-maintain`)

1. **Dependabot leaves `bun.lock` stale on every npm bump** — root cause of #14/#15 install failures, and will recur for all future npm PRs. Options: regenerate `bun.lock` manually per npm PR before merge, or run a workflow that does `bun install` + commits the lockfile back onto the Dependabot branch.
2. **Optional:** group the github_actions ecosystem so BEHIND-churn is one round instead of three:
   ```diff
      - package-ecosystem: github-actions
        directory: /
        schedule:
          interval: weekly
   +    groups:
   +      github-actions:
   +        patterns: ["*"]
   ```
   (No `update-types` filter — not barred by dependabot-core#14202.)
3. **`allow_auto_merge: false`** — enabling it would be safe here (required checks genuinely exist, so `gh pr merge --auto` would queue rather than merge-on-contact), but this is auto-merge policy, not this triage's call.

## Gaps / uncertainty

- **#14/#15 real compatibility is unknown.** CI dies at frozen-lockfile before typecheck/test; the migration reviewer must first regenerate `bun.lock` on the branch, then run typecheck/test to surface actual TS7 / chokidar-5 breakage. The failing CI is necessary-but-not-sufficient evidence of a real code break.
- **Release-path actions (#11, #12 in release.yml) aren't covered by PR CI** — `release.yml` triggers only on `v*` tags, so required checks never exercise setup-node@7 / checkout@7 in the release job. Low-risk but unverified until the next tagged release.
- `audit:licenses` and `package:check` were not run locally (justified — #13 is workflow-only, touches no production deps or tarball); both ran green on the PR's own GitHub CI.
- **Labels:** `dependabot.yml` sets `labels: [dependencies]` but all 5 PRs return `labels: []` — likely the label doesn't exist in the repo (Dependabot silently drops unknown labels). Cosmetic.

## Constraints honored

Nothing was merged, closed, commented on, approved, or auto-merge-enabled. All `gh` calls were read-only. Local verification ran in an isolated worktree that was removed afterward.
