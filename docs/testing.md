# Testing convention

Tests protect observable behavior at the cheapest boundary that can detect its failure.
The acceptance contract in [requirements](requirements.md) and [T8 membership](../test/acceptance/T8-GATE.md)
remains authoritative. This convention governs how that evidence is written, scheduled and reviewed.

## Before writing a test

Answer these questions in the change description or review evidence; a separate report is unnecessary:

1. What user outcome or invariant fails, and what concrete input triggers it?
2. Which existing test owns that behavior? Extend it unless a new failure boundary needs its own test.
3. What is the cheapest real observation that would distinguish the broken implementation from the fix?
4. What does the fixture simulate, and which claim therefore remains unproved?
5. What time, process and shared-state costs does the test add? What named failure proves it is effective?

An issue number is useful context, not a test's specification. Name tests by trigger and expected
behavior. Prefer an externally observable result over private call counts or source spelling.

## Choose the observation boundary

| Layer | Use it to prove | Fixture and assertion |
|---|---|---|
| Unit | Parsing, routing decisions, transforms, state transitions | Real production function; small inputs or a deterministic corpus; exact outputs and boundary cases |
| Integration | Filesystem, journal, Git, HTTP/socket, provider transport, lifecycle | Real affected components; isolated temporary state; observe committed bytes, response, event or owned process exit |
| Browser | Input, focus, layout, scrolling, iframe lifetime, editor DOM round trips | Installed real engine; real input/navigation; assert visible state and saved bytes |
| Static contract | Import boundaries, packaging, configuration and declarations | Parsed structure or explicit manifest; do not describe it as execution evidence |

Happy DOM is useful for DOM wiring and events; it cannot prove layout, visibility, scroll or browser
security. A mocked provider proves the local protocol, not compatibility with a live vendor session.
Keep external providers offline in CI. Live-provider support and T8 maintainer sign-off retain their
separate attended gates.

TypeScript's `tsc --noEmit` is a separate required check for behavior changes: `bun test` executes
TypeScript without establishing type correctness. Do not mirror compiler guarantees with trivial tests.

## Ownership and overlap

Use one primary test for each behavior at each necessary boundary. A parser corpus plus a browser
save test is complementary: the first explores input combinations; the second proves actual input
survives the composed application. Repeating the same inputs against the same function in another
file needs a stated reason. Requirements-to-test membership should link existing tests, not clone them.

Before removing apparent duplication, name what would stop being observed and ablate the relevant
mechanism (temporarily bypass it). Retain a named red, restore exact source, then obtain green.
Do this for new or repaired critical guards and for changes to test selection/report verification.
Never delete an assertion, skip a failing scenario, or retry to green to meet a deadline.

Keep exhaustive combinations in cheap deterministic tests; retain representative real-boundary
scenarios for wiring, failure/recovery and cleanup. A fixture population change needs explanation.
Source-text assertions can pin declarations; they cannot substitute for executing a behavioral guard.

## Time and isolation

Wait for observable readiness with a bounded deadline and useful diagnostics. Use an injected clock,
barrier or controllable dependency for scheduling logic. A fixed sleep is justified only when elapsed
real time is itself the contract, such as crossing the server's idle timeout; state that reason next to
it. Keep one real-time witness for that boundary and move combinatorial timing cases to controllable
clocks. Do not shorten a wait below the failure threshold it is meant to observe.

| Resource | Rule |
|---|---|
| Files and Git | Unique temporary directories; sanitized Git environment; never inherit repository selectors from hooks |
| Daemons and browsers | Private homes/config/profiles and owned ports; scrub credentials; await verified cleanup on success, failure and timeout |
| Globals, clocks and environment | Restore in `finally`/teardown; no test-order dependency; register teardown before a setup step can fail |
| Shared fixtures | Share immutable setup only; each test owns mutable state; do not share a live daemon/browser merely to hide setup costs |
| Diagnostics | Capture both streams; retain command, deadline and owned process identity; distinguish expected-red child fixtures from actual suite failures |

Do not enable global `--concurrent`: it overlaps tests sharing one file's fixtures. The pinned Bun
supports `--parallel` (files in separate workers) and `--isolate` (fresh globals/module registries).
Neither isolates disk paths or external resources. Change execution mode only after representative
serial/parallel measurements, equal executed identities, clean ownership and named negative controls.
See [Bun's execution modes](https://bun.com/docs/test/parallel). Keep the supported toolchain pinned
in the package manifest and both CI workflows; the application's older runtime floor is separate.

## Commands and execution frequency

| Situation | Required selection |
|---|---|
| Editing a behavior | Explicit `bun test ./path/to/affected.test.ts`; related boundary tests and typecheck as needed |
| Before submitting a code candidate | `bun run check`; includes lint, typecheck, one complete partitioned pass, version and format checks |
| Code PR CI | Three disjoint duration-balanced partitions, independent stability, quality and security jobs |
| Documentation-only PR CI | Defined docs consumers, package/format and security checks; not a T8 result |
| Main, release or manual full validation | PR gates plus the unpartitioned `test:full` interaction check; T8 manual work remains separate |

`test:ci` runs all three partitions sequentially on a developer machine and in separate CI jobs on
GitHub. `test:acceptance` is a standalone diagnostic/release selection of named requirements; do not
run it again immediately after `test:ci` on unchanged contents and call that additional coverage.
`test:stability` repeats the explicit lifecycle/helper selection in fresh processes; every attempt
must pass. It is intentional repetition, not retry-on-failure. Keep the unpartitioned full pass until
cross-file interaction coverage has an evidenced replacement.

Use explicit `./` file paths for focused checks; bare arguments are name filters. Name-filtered runs
must prove the intended cases executed. Zero tests, an unexpected skip, missing JUnit, a cancelled job
or malformed evidence is a failed gate. Do not infer success from a printed membership list.

## Scheduling and timing evidence

Acceptance membership and execution partitioning are separate. All inventory files, including
acceptance, are balanced across `ci-1`, `ci-2`, `ci-3`. Their union must be complete and disjoint;
acceptance retains its own unchanged requirements map and standalone command.

The reviewed baseline in `scripts/test-timings.json` uses seconds, unlike Bun's native timing files,
which use milliseconds. Record source run URLs, commits, toolchain and aggregation method. Compare
successful runs on the same runner class and runtime. Failed runs are diagnostic evidence, not a new
scheduling baseline. Never silently regenerate the committed baseline during CI.

New test files must receive a positive `estimates` entry with a concrete reason until repeated CI
measurements are available. Remove their estimate when recording a measured duration. Deleted files
must leave the baseline too. The planner rejects missing, stale, overlapping and invalid entries;
there is no growing count allowance for unmeasured files.

Treat latency budgets as review targets, not flaky assertions against shared CI hosts: focused unit
feedback should take seconds; aim for a test partition below three minutes. Investigate a file above
ten seconds, a real-time test above five seconds, or a sustained partition imbalance above 20%.
Record why a necessary slow witness remains and optimize the dominant cost first. Report test wall
time separately from CI queue, installation, fixture setup and cleanup.

## Delivery and review

Builders read this convention before selecting or adding tests. Reviewers check the failure boundary,
existing coverage, added cost, isolation and named negative evidence. The parent selects final gates
from current scripts and workflow configuration; historical manifests are not authority for extra runs.

Reuse a passing receipt only when the base, effective source/test/config contents, runtime and command
still match. Staging or committing unchanged bytes alone does not invalidate it. A repair invalidates
affected evidence; run focused checks during iteration and one complete required gate on the final
candidate. Do not multiply full runs across builder, reviewer and parent without a concrete reason.

Mechanical enforcement consists of: Biome errors for focused/skipped tests; exact inventory and timing
validation before CI scheduling; JUnit inventory/failure/skip validation; and the required CI aggregate.
These do not prove semantic test quality. Review and temporary ablation remain necessary. Do not turn
this prose into a catalogue of brittle source-string assertions or waive a red check with prose.

Keep timing reports, raw logs, expected-red runs and audit notes in ignored local evidence directories.
Public descriptions contain a self-contained behavior/evidence summary, not private paths or fixtures.
