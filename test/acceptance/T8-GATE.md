# T8 release gate — deterministic acceptance suite index

This is the single place to answer "is the release gate green" without re-deriving coverage from
memory. `docs/requirements.md`'s T8 section names seven mandatory deterministic suites (plus a
manual rehearsal, P5.3/P5.4, explicitly out of scope for this document — Dawid-only). For each
category below: the exact test file(s)/describe blocks that satisfy it, and an honest verdict —
ALREADY SATISFIED (pre-existing coverage, verified not just trusted), BUILT (new coverage added by
this pass, P5.2), or KNOWN GAP (named explicitly, not glossed over).

Run `bun test` from the repo root for the full suite; `bun run typecheck` for types. Both must be
clean (a single `bootDaemon — subprocess fault/concurrency > stale lock...` failure under full-
suite system load is a known pre-existing flake — passes standalone and clears on rerun; not a
regression).

---

## 1. Storage/fault — "kill daemon at each write step → one legal recovered state"

| Write path | Verdict | Test(s) |
|---|---|---|
| Journal (append/torn-tail/interior-quarantine) | ALREADY SATISFIED | `packages/daemon/test/bus/journal.test.ts` (mid-write rollback, fsync-before-ACK critical list); `packages/daemon/test/bus/replay.test.ts` (interior-line quarantine, idempotent re-quarantine); `packages/daemon/test/bus/reconcile-fault.test.ts` — exhaustive byte-offset truncation sweep over a real 4-event journal, every offset recovers to exactly one of two legal record-boundary states |
| Inbox (write-once rename) | ALREADY SATISFIED | `packages/daemon/test/bus/inbox.test.ts` (EEXIST round-trip, orphan `*.tmp` sweep); `packages/daemon/test/bus/reconcile-fault.test.ts`'s "inbox <-> journal crash scenarios" describe (crash-before-rename → no phantom entry; crash-after-rename-before-journal → self-heals via synthesized `entry_created`, idempotent across restarts) |
| Shadow-git checkpoint | ALREADY SATISFIED | `packages/daemon/test/git/shadow.test.ts`'s "index.lock reclaim" describe — a pre-existing `index.lock` (the actual on-disk artifact a mid-git-operation kill leaves behind) is reclaimed and the next op succeeds; "checkpoint — idempotency" and "empty union never self-stages" cover the no-op/re-run cases |
| Workspace-index (`workspaces.json`) | ALREADY SATISFIED (by construction) | `packages/daemon/test/registry/workspace-index.test.ts` — `persist()` uses temp(`wx`)→fsync→rename, so a kill can only ever leave the OLD or the NEW content at the final path, never torn (POSIX `rename` is atomic); "every intermediate on-disk snapshot ... never torn" proves this across N sequential writes, "a corrupt on-disk workspaces.json is tolerated" proves recovery from a corrupted starting state. Minor non-blocking gap noted below. |
| Apply-lease lifecycle (`apply_begin`/`apply_end`, the A4 §F05 honest-provenance crux) | **BUILT** (genuine gap: the existing journal fault sweep's reference journal never contained a real lease — only `entry_created`/`transition_committed`) | `packages/daemon/test/bus/reconcile-fault-lease.test.ts` — builds a REAL `createEntry → applyBegin → resolveEntry('applied')` journal via `WorkspaceBus`, then exhaustively truncates every byte offset across the lease-critical span (apply_begin's record through apply_end's), reconciling from BOTH sides of the lease's own expiry. Asserts: entries always match a legal record-boundary snapshot; a recovered lease is never a partial/corrupt shape; `status: "applied"` never appears without the lease already closed; an expired lease auto-closes without ever fabricating a completed status. |

**Known non-blocking gap:** `registry/workspace-index.ts`'s `persist()` has no orphan-`.tmp`-file
sweep (unlike `inbox.ts`'s `cleanupOrphanInboxTempFiles`) — a kill between `openSync`/`writeSync`
and `renameSync` leaves a `.workspaces.<pid>.<ts>.<rand>.tmp` file on disk forever. This is a disk-
hygiene leak, not a state-legality violation (the derived state/`workspaces.json` itself is always
one of the two legal values per the atomicity argument above) — out of T8's "one legal recovered
state" bar, flagged here rather than silently ignored.

---

## 2. Concurrency

ALREADY SATISFIED at the in-process level + **BUILT** the genuine multi-process gap.

- **In-process concurrent-Promise coverage** (real, but the daemon is single-process so this
  exercises the actual event-loop interleaving that matters for its own mutex code):
  `packages/daemon/test/bus/concurrency.test.ts` (N concurrent `createEntry`/mixed-event-kind
  writers stay serialized, non-interleaved), `packages/daemon/test/bus/mutex.test.ts`
  (`AsyncMutex`/`KeyedMutex` FIFO + per-key independence + throw-still-releases),
  `packages/daemon/test/registry/lockfile-fallback.test.ts`,
  `packages/daemon/test/registry/workspace-index.test.ts` (N concurrent `upsertWorkspace`),
  `packages/daemon/test/git/lease.test.ts`'s "concurrency — checkpoint/applyBegin serialize
  through the shared workspace mutex" (N concurrent checkpoints never race `index.lock`),
  `packages/daemon/test/sessions-routes.test.ts`'s "two concurrent drain calls ... never double-
  select."
- **Real two-OS-process daemon-BOOT race** (genuine subprocess spawning, but scoped to the lock
  file, not workspace writes): `packages/daemon/test/lifecycle.test.ts`'s "bootDaemon — subprocess
  fault/concurrency" describe.
- **Genuine gap, confirmed and closed**: nothing previously spun up a real daemon subprocess and
  hit the SAME workspace's inbox/journal/lease with genuinely concurrent HTTP requests over real
  sockets (as two real client processes, or a CLI call racing a hook, would in production) — every
  existing "concurrent" test either stayed in-process (mocked `createApiFetch`, no network) or
  tested daemon-boot locking specifically. **BUILT**:
  `packages/daemon/test/concurrency-real-subprocess.test.ts` — reuses the same `spawnDaemon`/
  `waitForHandshake`/`stopDaemon` real-subprocess helpers `http.test.ts`/`lifecycle.test.ts` already
  use. Two tests against one real, separately-running `glosa __daemon` process: (1) N concurrent
  `POST /api/workspaces/apply-begin` requests for the SAME entry from N different sessions, fired
  over real loopback sockets via `Promise.all(fetch(...))` — exactly one 201, everyone else a real
  409, and the on-disk journal (read directly, not through the API) ends up with exactly one
  `apply_begin` line, never zero (lost write) or N (mutex didn't hold), never a torn/corrupt line;
  (2) the SAME race across TWO DIFFERENT real workspace roots proves the lease mutex is genuinely
  workspace-scoped, not an accidental global daemon-wide lock. Stable across repeated runs (checked
  4×).

*(HTTP/TCP carries no OS-process identity to the server, so a daemon bug in serializing concurrent
writes would be equally exposed by two real client processes or by concurrent `fetch()` calls from
one client process against a real subprocess daemon — the property that matters, and that no other
test covered, is genuine concurrent SOCKET I/O against a real, separate daemon process, which this
now provides.)*

---

## 3. Delivery — "channels on/off, asyncRewake rearm, boundary, parked/resumed"

ALREADY SATISFIED — genuinely end-to-end, not just capability-flag unit tests:

- **Channels on/off, full R4 ladder**: `packages/providers/claude-code/test/provider.test.ts`'s
  "ClaudeCodeProvider.deliver — the R4 ladder" describe (rungs 1-4, a channel throw records
  `outcome:'failed'` without silent fallback) and its nested "channels disabled — the fallback
  rungs still deliver" describe (no `channelsEnabled`/`sendChannel` deps at all; `channelsEnabled()`
  returns false; channels+asyncRewake both unavailable; every capability false → `outcome:'failed'`,
  never a thrown promise). `packages/providers/claude-code/test/delivery-journal.test.ts` proves the
  SAME ladder end-to-end against a REAL `WorkspaceBus`/journal (not a mock) — rung 1 success, a
  failed rung, and explicitly "channels-OFF: the fallback rung's delivery_attempt still records a
  legal A5 §F23 outcome."
- **asyncRewake rearm**: `packages/providers/claude-code/test/rewake.test.ts` — rearm across three
  sequential inbox entries (never zero, never two watchers), a Stop-while-still-armed no-op,
  claim-before-spawn lease ordering, and a same-process-two-coordinators-one-shared-lease-file test
  simulating two racing `glosa hook stop` OS processes (via the real atomic `wx`-exclusive-create
  lock file — see the concurrency section's caveat on what this does and doesn't prove).
- **Boundary drain + parked/resumed, through the REAL HTTP route** (not a unit call to the bus
  method): `packages/daemon/test/sessions-routes.test.ts`'s "POST /api/sessions/:id/drain" describe
  — drains pending entries with A5 §F23-conformant outcomes, a 2nd drain never re-returns
  already-attempted entries, an already-terminal entry is never drained, a FAILED-only prior attempt
  IS re-drained, a successfully-delivered one is NOT, two concurrent drain calls never double-select.
  `packages/daemon/test/registry/routing.test.ts` — "park -> drain: a parked workspace's next
  register() drains it, and routes correctly after" (real parked→resumed round trip).
  `packages/daemon/test/sessions-routes.test.ts`'s "register -> drained_workspaces surfaces a
  previously-parked workspace" proves the same round trip through `POST /api/sessions/register`.
- **Cross-provider conformance**: `test/agent-provider-conformance.test.ts` — the shared
  `AgentProvider` contract suite run against BOTH Claude Code and Codex providers, plus an explicit
  "the R7 capability split is real, not just documented" check (Claude has push/channels; Codex
  doesn't; both agree on gate+boundaryDrain+mcpPull).

---

## 4. Browser security — the A3 §5 attacks

**BUILT** — `test/acceptance/security-attack-matrix.test.ts`: one consolidated file, one describe
block per numbered A3 §5 attack (1-8), calling the SAME production functions the scattered
per-mechanism tests already exercise (not reimplementing them) — a literal, runnable checklist.
Deeper per-mechanism coverage this file deliberately does NOT duplicate:
`packages/daemon/test/{auth,csp,confine-path,classf-bridge,classf-serve,classf-listener,http,
token}.test.ts`, `packages/spa/test/{classf-viewer,bootstrap}.test.ts`.

| # | Attack | Verdict |
|---|---|---|
| 1 | Open class-F in new tab | covered (`classFCspHeaders` sandbox string; real-socket depth in `classf-listener.test.ts`). This proves the header VALUE the daemon sends is correct; whether a real sandboxed tab actually honors that `sandbox` string is out of a deterministic suite's reach by construction — correctly deferred to the P5.4 manual rehearsal, same class of gap as attack #7. |
| 2 | Remote img/fetch/WS/form in doc | covered (`connect-src none`/`form-action none`/`default-src none` asserted directly). Same caveat as #1: this proves the CSP directive VALUES are correct, not that a real browser's CSP engine actually blocks the remote img/fetch/WS/form load — that enforcement is likewise correctly deferred to the P5.4 manual rehearsal. |
| 3 | Forged postMessage | covered (`isTrustedInitEvent`/`checkEventSource`/`checkNonce` + bridge-side `bridgeShouldAcceptInit` nonce-once gate) |
| 4 | Symlink escape | covered (`confinePath` rejects a file-symlink AND a directory-symlink escape; exhaustive matrix in `confine-path.test.ts`) |
| 5 | Leading-`-`/control-char filename | covered (`confinePath` control-char/NUL rejection here; git argv-safety depth in `git/shadow.test.ts`) |
| 6 | Injected HTML (name/md/annotation/transcript/tool_result) | covered — `renderMarkdown` escapes a `<script>` in markdown source (class R, `html:false`); `validateBridgeMessage` carries a script/HTML quote as inert plain text (class-F overlay); a NEW DOM-level proof that `mountConversationPane` renders prose/tool_input/tool_result via `textContent` only — no `<script>`/`<img onerror>` ever becomes a live element, and the DOM itself re-serializes the payload HTML-escaped |
| 7 | Local site navigates/frames class-F/handshake | covered — foreign-Origin-present-on-handshake rejection, authed-read 401-regardless-of-Origin, class-F `frame-ancestors 'self' <SPA origin>`, SPA `frame-ancestors 'none'`; real-socket/real-subprocess depth in `classf-listener.test.ts`/`http.test.ts`. Actual browser-enforced iframe-blocking behavior is out of a deterministic suite's reach by construction — correctly deferred to the P5.4 manual rehearsal (`mountClassFViewer`'s own test comment says as much). |
| 8 | Fragment token in history/localStorage | **partially covered, KNOWN GAP flagged** — `scrubToken` proof: hash empty after scrub, no `t=` survives into `history.replaceState`, token lands in `sessionStorage` only, never `localStorage`. **The "revoke → old Bearer 401" half is UNTESTED because it is UNIMPLEMENTED**: `packages/daemon/src/token.ts`'s own top comment states "Rotation and revocation are P5.1's job"; grepping `packages/daemon/src` and `packages/cli/src` for `rotate`/`revoke` finds nothing — no HTTP route, no CLI command. This is a real product gap, not a test gap; nothing to assert until it ships. |

---

## 5. Anchor corpus — Polish combining chars, md markup, duplicate quotes, stale hashes, transformed HTML

ALREADY SATISFIED — verified directly (not just trusting the P3.4 log claim), by reading the test
bodies and counting cases, not inferring from filenames:

- **Polish combining chars (NFC/NFD)**: `packages/daemon/test/anchoring/nfc-nfd.test.ts` — real
  Polish decomposed sequences (ż/ą) resolve against NFC source text via normalized fold; a
  duplicate-outside-scope case proves the fold stays correctly scoped.
- **Markdown markup boundaries**: `packages/daemon/test/anchoring/markup-boundaries.test.ts` (6
  cases — quotes crossing block boundaries, inline markup, etc.).
- **Duplicate quotes**: `packages/daemon/test/anchoring/duplicates.test.ts` (4 cases: duplicate
  across the doc but unique in its own block resolves there; second occurrence resolves to its OWN
  block; doc-wide duplicate with no scope → `orphaned{ambiguous}`, never a coin-flip; a duplicate
  even within one block falls through to block_range guidance).
- **Stale hashes**: `packages/daemon/test/anchoring/stale-hashes.test.ts` (5 cases: mismatched
  `capturedRenderedSha256` widens to whole-doc search; no hash supplied treated as stale — "no
  proof, no trust"; stale + doc-wide duplicate → ambiguous; a fresh hash DOES trust position —
  contrast case; sanity that `renderedSha256` actually changes on re-render).
- **Transformed HTML (class-F)**: `packages/daemon/test/anchoring/class-f.test.ts` (13 cases across
  three describes — no-manifest/no-chunk, `transformed:false` verbatim search incl. a duplicate-
  within-chunk ambiguous case and TWO independent staleness paths (per-chunk `source_sha256` and
  whole-manifest hash), and `transformed:true` always routing to `pipeline_feedback` with no search
  attempted even when the quote WOULD be findable — intent never rescues a transformed miss).
- **Totality/fuzz** (the "45-case" claim): `packages/daemon/test/anchoring/totality.test.ts` —
  counted directly: 22 garbage-annotation `test.each` cases + 12 garbage-artifact cases + 7
  garbage-ctx cases = 41 fuzz cases (close to the claimed 45; real, not padding — includes a
  200,000-char oversize quote, `NaN`/`Infinity` positions, non-integer positions, wrong-typed
  fields, bare primitives as the whole input) — every one asserts `resolve()` never throws AND
  always returns a structurally valid `Resolution`. Plus a dedicated uniqueness-gate describe (0 or
  ≥2 matches never auto-apply) and a lone-surrogate/astral-character sanitization describe.
- Also present: `class-r-basic.test.ts`, `class-r-never-feedback.test.ts` (Class R structurally can
  never return `pipeline_feedback`, checked across intent variations), `whitespace-fold.test.ts`
  (NBSP, doubled internal spaces, embedded newlines, leading/trailing trim).

`bun test packages/daemon/test/anchoring/` — all green.

---

## 6. Transcript suite

ALREADY SATISFIED — verified against the specific fault modes named in P4.2's log entry, by
reading the test bodies directly:

| Fault mode | Verdict | Evidence |
|---|---|---|
| Partial-line buffering | covered | `packages/daemon/test/transcript/normalize.test.ts`'s "partial final line (A2 §F16 CRITICAL)" describe: a chunk with no trailing newline is buffered and completes on the next chunk; a line split exactly at a multi-byte UTF-8 character boundary still decodes correctly; three accumulating partial feeds |
| Unknown/corrupt-line quarantine | covered | "unknown event quarantine" describe (unrecognized `type` quarantined+counted, good events still emitted; unknown raw preview capped at 200 chars; a well-formed-but-nothing-renderable record yields zero events, NOT unknown) + "corrupt/malformed lines" describe (invalid JSON, non-object JSON, `null`, a blank line correctly NOT counted as unknown, and a dedicated "NEVER THROWS: a battery of adversarial lines" test) |
| Resume/clear/compact | covered | a describe literally named "resume/clear/compact (A2 §F16 state-transition table)": a `summary` record (`/compact`) becomes a hidden `meta{kind:"compact"}` event with parsing continuing normally after it; `reset()` (the tailer's `/clear`/`/resume` resync signal) discards the buffered partial line and resets line numbering WITHOUT resetting the lifetime `quarantinedCount`; a full pre-compact → compact → reset(`/clear`) → post-reset sequence in one normalizer lifetime, nothing thrown. `transcript/stream.test.ts` separately covers a `/resume`-triggered file-swap to a NEW inode (identity change even with the same path) |
| Fail-soft `mirror_unavailable` | covered | `packages/daemon/test/transcript/stream.test.ts`: "a fresh session with no transcript bytes yet → mirror_unavailable, not an error" (raw SSE bytes asserted, not just a parsed helper) |

`bun test packages/daemon/test/transcript/` — all green.

---

## 7. Adapter-topology (per D10 — reinterpreted from "actual jethro topology")

**BUILT.** `test/adapters/interface.test.ts`'s own `resolveSessionBinding` describe already unit-
tests `AdapterRegistry.resolveSessionBinding` in isolation — necessary but not sufficient, since it
never proves the real `POST /api/sessions/register` route (`handleSessionRegister` in `http.ts`)
actually wires an `AdapterRegistry` into its decision end to end.

`packages/daemon/test/adapters/adapter-topology.test.ts` (new) proves the full topology through the
REAL HTTP route (`createApiFetch` + real `SessionRegistry`/`WorkspaceIndex`, no direct calls to
`AdapterRegistry.resolveSessionBinding`):

1. Adapter loaded, hook-reported `cwd` mismatched from the adapter's own real data root → registers
   to the adapter's answer, not `cwd`, and not the cwd-ancestor fallback either (the mismatch target
   isn't even an ancestor of the real root, so a buggy fallback would show up as neither value).
2. No `AdapterRegistry` configured at all, `cwd` matches nothing known → falls back to `cwd` itself,
   honestly — never silently mis-routed to some OTHER real workspace.
3. Adapter loaded but has no opinion on THIS session → same honest `cwd` fallback, proving one
   session's binding never leaks onto a different session.
4. An explicit `workspace_binding` in the request body wins outright over the adapter's own answer
   (matches `http.ts`'s own documented precedence).

This required extending `packages/daemon/test/fixtures/adapter/fixture-adapter.ts` (the shared
P6.1 fixture, per D10's explicit instruction to reuse/extend it rather than inventing a second one)
with an opt-in `sessionBindingFor` map — omitted by every pre-existing fixture-adapter test, so
their behavior is unchanged (verified: `fixture-adapter.test.ts` still 10/10 green).

---

## Summary

| # | Category | Verdict |
|---|---|---|
| 1 | Storage/fault | ALREADY SATISFIED (4/5 paths) + BUILT (apply-lease lifecycle gap closed); 1 known non-blocking hygiene gap (workspace-index orphan tmp) |
| 2 | Concurrency | ALREADY SATISFIED (in-process + daemon-boot) + BUILT (real multi-process workspace-write race) |
| 3 | Delivery | ALREADY SATISFIED |
| 4 | Browser security | BUILT (consolidated matrix); 1 known gap (token rotate/revoke unimplemented) |
| 5 | Anchor corpus | ALREADY SATISFIED (verified directly — 41-case totality fuzz + full markup/duplicate/stale/class-F matrices) |
| 6 | Transcript suite | ALREADY SATISFIED (verified directly — all 4 named fault modes covered) |
| 7 | Adapter-topology | BUILT |

`bun test` (root, at time of writing): **1038 pass, 0 fail** across 91 files, run clean twice in a
row. `bun run typecheck`: clean (0 errors).
