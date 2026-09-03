// SPDX-License-Identifier: Apache-2.0
//
// Membership of the T8 deterministic acceptance gate — the single source of truth.
//
// `docs/requirements.md` §5 (T8) names the mandatory suites. This file maps each named
// suite to the files that discharge it. Three consumers read this one table, so a suite
// cannot quietly fall out of the gate:
//
//   1. `scripts/test-acceptance.ts` — the runner behind `bun run test:acceptance`.
//   2. `test/acceptance/gate-membership.test.ts` — the guard: every path must exist, every
//      named suite must be non-empty, and the table in `test/acceptance/T8-GATE.md` must
//      match this file exactly.
//   3. `test/acceptance/T8-GATE.md` — the human-readable gate, kept honest by the guard.
//
// Adding a file here adds it to the gate. Renaming or deleting a file without updating
// this table fails the guard *and* fails the runner (Bun exits non-zero on a `./`-prefixed
// path that does not resolve). Neither failure is silent.

/**
 * Suite ids, verbatim from `docs/requirements.md` §5 T8 "Deterministic suites (mandatory)".
 * `AGENTS.md` summarizes the same gate but omits `delivery`; `requirements.md` governs.
 */
export const REQUIRED_SUITES = [
  "fault",
  "concurrency",
  "delivery",
  "security",
  "anchor",
  "transcript",
  "explicit-binding-topology",
] as const;

export type SuiteName = (typeof REQUIRED_SUITES)[number];

/** The requirement clause each suite exists to discharge, quoted from `docs/requirements.md` §5. */
export const SUITE_CLAUSES: Record<SuiteName, string> = {
  fault: "storage/fault (kill daemon at each write step → one legal recovered state)",
  concurrency: "concurrency",
  delivery: "delivery (channels on/off, asyncRewake rearm, boundary, parked/resumed)",
  security: "browser security (the A3 §5 attacks)",
  anchor: "anchor corpus (Polish combining chars, md markup, duplicate quotes, stale hashes, transformed HTML)",
  transcript: "transcript suite",
  "explicit-binding-topology":
    "explicit-binding topology (agent cwd differs from the artifact workspace and routing still succeeds)",
};

/** Suite → the test files that discharge it. Paths are repo-root-relative and POSIX-separated. */
export const ACCEPTANCE_SUITES: Record<SuiteName, readonly string[]> = {
  fault: [
    "packages/daemon/test/bus/journal.test.ts",
    "packages/daemon/test/bus/inbox.test.ts",
    "packages/daemon/test/bus/replay.test.ts",
    "packages/daemon/test/bus/lifecycle.test.ts",
    "packages/daemon/test/bus/reconcile-fault.test.ts",
    "packages/daemon/test/bus/reconcile-fault-lease.test.ts",
    "packages/daemon/test/bus/real-daemon-fault.test.ts",
  ],
  concurrency: [
    "packages/daemon/test/bus/concurrency.test.ts",
    "packages/daemon/test/bus/mutex.test.ts",
    "packages/daemon/test/bus/approval-uniqueness.test.ts",
    "packages/daemon/test/concurrency-real-subprocess.test.ts",
    "packages/daemon/test/git/lease.test.ts",
  ],
  delivery: [
    "packages/daemon/test/bus/delivery-reservation.test.ts",
    "packages/daemon/test/delivery/presentation.test.ts",
    "packages/daemon/test/agent-provider/push-registry.test.ts",
    "packages/providers/claude-code/test/provider.test.ts",
    "packages/providers/claude-code/test/rewake.test.ts",
    "packages/providers/claude-code/test/delivery-journal.test.ts",
    "packages/providers/codex/test/provider.test.ts",
    "test/agent-provider-conformance.test.ts",
  ],
  security: [
    "test/acceptance/security-attack-matrix.test.ts",
    "packages/daemon/test/auth.test.ts",
    "packages/daemon/test/csp.test.ts",
    "packages/daemon/test/confine-path.test.ts",
    "packages/daemon/test/matcher/symlinks.test.ts",
    "packages/daemon/test/presentation-token.test.ts",
    "packages/daemon/test/token-lifecycle.test.ts",
    "test/acceptance/browser-security-real-engine.test.ts",
  ],
  anchor: [
    "packages/daemon/test/anchoring/class-f.test.ts",
    "packages/daemon/test/anchoring/class-r-basic.test.ts",
    "packages/daemon/test/anchoring/class-r-never-feedback.test.ts",
    "packages/daemon/test/anchoring/duplicates.test.ts",
    "packages/daemon/test/anchoring/markup-boundaries.test.ts",
    "packages/daemon/test/anchoring/nfc-nfd.test.ts",
    "packages/daemon/test/anchoring/stale-hashes.test.ts",
    "packages/daemon/test/anchoring/totality.test.ts",
    "packages/daemon/test/anchoring/whitespace-fold.test.ts",
  ],
  transcript: [
    "packages/daemon/test/transcript/normalize.test.ts",
    "packages/daemon/test/transcript/stream.test.ts",
    "packages/spa/test/conversation.test.ts",
  ],
  "explicit-binding-topology": [
    "packages/daemon/test/adapters/adapter-topology.test.ts",
    "packages/daemon/test/registry/session-registry.test.ts",
    "packages/daemon/test/sessions-routes.test.ts",
    "packages/daemon/test/provider-topology-real-subprocess.test.ts",
  ],
};

/** The guard itself runs inside the gate, so a broken mapping fails the gate rather than the full suite. */
export const GATE_GUARD_FILE = "test/acceptance/gate-membership.test.ts";

/** Every file the gate runs, in suite order, guard last. No duplicates. */
export function acceptanceFiles(): string[] {
  const files = REQUIRED_SUITES.flatMap((suite) => [...ACCEPTANCE_SUITES[suite]]);
  files.push(GATE_GUARD_FILE);
  return files;
}
