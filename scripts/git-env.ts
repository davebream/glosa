// SPDX-License-Identifier: Apache-2.0
// A neutral environment for a spawned `git`, shared by the scripts and tests that shell out to it.
// Kept in its own module rather than in `test-plan.ts` (#316) so `version-sync.ts` — which runs in
// the pre-commit hook on every commit — can use it without importing the test planner and its
// timings fixture.

/**
 * Strips the variables that decide WHICH repository git talks to, and neutralizes git's own
 * configuration.
 *
 * `cwd` alone does not isolate a git subprocess: an inherited `GIT_DIR` overrides it silently.
 * That matters because git EXPORTS these into every hook's environment — a `pre-push` hook runs
 * with `GIT_DIR` already pointing at the invoking repository — so anything a hook spawns inherits
 * them, whatever directory it runs in.
 *
 * Issue #316 is what this prevents: under the pre-push hook, a test that built a throwaway
 * repository and asked for its staged blob was answered from THIS repository instead, and a
 * `git init` meant for a temp directory reinitialized the real one, flipping `core.bare` to true
 * and breaking every worktree at once.
 *
 * Use this whenever the repository is decided by `cwd` or an explicit path. Do NOT use it when the
 * ambient selectors are the point — `version-sync.ts`'s `indexReader` reading the index that a
 * `git rebase` is mid-way through committing is the one case in this repository that needs them.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(base).filter(([key]) => !key.startsWith("GIT_") && key !== "ANTHROPIC_API_KEY"),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}
