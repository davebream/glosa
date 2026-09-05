# Design — surviving a machine that runs glosa more than once

**Date:** 2026-09-05
**Status:** PR A implemented. PR B and PR C are confirmed direction, not yet built.
Revised after adversarial and security review (§8) before any code was written.
**Surfaces:** `packages/daemon/src/lifecycle`, `packages/daemon/src/transport`,
`packages/daemon/src/transcript`, `packages/cli/src`, `packages/providers/claude-code/src`,
`packages/spa/src`
**Amends:** A3 §3/§55 (token lifecycle), A5 §F13 (lock/handshake), A6 §F26 (init roots),
A2 §F16 (transcript root)

---

## 1. The problem

glosa assumes one glosa install and one Claude Code config directory per machine. The first is
false on any machine where glosa is developed; the second is false on any machine running a Claude
account switcher. When either breaks, glosa does not degrade — it evicts a running daemon, drops a
browser tab's pairing with no way back, and wires an agent config the user's sessions never read.

| # | Defect | Ships in |
|---|---|---|
| D1 | A source checkout defaults to `~/.glosa` and port 4646, shared with the release install | PR A |
| D2 | Any build difference ⇒ SIGTERM the running daemon, whoever started it | PR A |
| D3 | No record of *why* a request was rejected, so a de-pair cannot be diagnosed after the fact | PR A |
| D4 | The SPA treats any 401 as credential revocation, with no recovery path | PR B |
| D5 | `init` and transcript confinement resolve exactly one Claude root | PR C |

## 2. Evidence

Reproduced 2026-09-05 against isolated homes on ports 4791/4792; the user's daemon was untouched.

- **D1/D2 reproduced.** One `bun packages/cli/src/main.ts status` from a checkout SIGTERMed a
  release-build daemon and replaced it. `~/.glosa/daemon.log` (2898 lines) holds 5 ×
  `same-version-different-build`, several × `newer-client`, 18 shutdowns, 20 boots, 2362 ×
  `EADDRINUSE … no glosa peer answering`.
- **A same-home takeover does not unpair.** 400 authenticated polls across two takeovers:
  330 × `200`, 70 × `000` (refused), **0 × 401**. The tab sees an outage, then recovers.
- **A different-home daemon on the same port does unpair.** The old token against a daemon booted
  with a second `GLOSA_HOME` on the same port: `401 missing or invalid bearer token`.
- **D4 is terminal.** `data-access.js:314` removes `sessionStorage.glosa_token`, then
  `window.location.reload()`. Bootstrap already stripped `#t=`, so nothing restores it.
- **Independently observed storm.** A second session found 7+ daemons from 3 source trees
  contending for 4646 — including two 2-day-old daemons from an archived Conductor worktree — with
  the process count going 12 → 4 in five seconds, and a listener bound while answering nothing
  (`lock pid N alive, port 4646 bound but not answering the glosa handshake`, alternating with
  `port 4646 is free — treating lock as stale`). The bound-but-silent window is the drain path:
  `graceful drain exceeded 3000ms` appears in the same log. Removing the mutual-kill engine
  (D1/D2) closes that window; it is not separately fixed.
- **D5 confirmed on disk.** ccs launches Claude with `CLAUDE_CONFIG_DIR=~/.ccs/instances/<name>`
  (`@kaitranntt/ccs/dist/auth/commands/create-command.js:207`). `rootsFor()`
  (`packages/cli/src/scoped-init.ts:151`) uses `homedir()` and never reads it; `claudeConfigDir()`
  (`packages/daemon/src/transcript/root.ts:25`) reads it once, from the *daemon's* env. All four
  instances symlink `settings.json` to one shared file; each keeps its own `.claude.json` and its
  own `projects/` tree (35 project dirs).

## 3. PR A — one machine, many glosa installs

### A1. Install identity

`INSTALL_ID = sha256(realpath(<package root>)).slice(0, 16)`, in `build-id.ts` beside `BUILD_ID`,
computed from the same root `BUILD_ID` already hashes.

Published as an **optional** `install_id` on `DaemonLock` and on the handshake body /
`HandshakeResponse`, exactly as `build_id` was introduced.

Required detail the first draft left open:

- **Shape guards.** `isDaemonLockShape` (`lock.ts:20`) and `isHandshakeShape` (`handshake.ts:16`)
  accept unknown keys, so `install_id: 42` would parse and then compare unequal to every string
  forever. Both gain `(v.install_id === undefined || typeof v.install_id === "string")`, mirroring
  the `build_id` guard at `lock.ts:28`.
- **Absent-vs-present rule.** In `daemonPeerMismatchReason`, lock and handshake are written by the
  same process, so absent-on-both is agreement and present-on-one is a mismatch — the same rule
  `build_id` already follows. The check goes **after** the build check so
  `build-id.test.ts:129-131`'s `.toContain("build")` assertions keep their reason strings.
- **`sameLockInstance`** (`daemon.ts:484`) gains `install_id` too. It is the predicate that decides
  whether it is safe to delete a lock (`removeLockIfOwned`, `daemon.ts:792`); leaving install
  identity out of it would let one install delete another's ownership record.
- **`toConnection`/`DaemonConnection`** carry `installId`, so callers past `ensureDaemon` can see it.

*A hash, not the path.* `/api/handshake` is tokenless. Truncated sha256 of a guessable path is not
confidential — an attacker with a dictionary of plausible install paths can hash each and compare.
It is an **integrity** signal against accident, not a secrecy boundary, and A3's threat model is
hostile web content, not a same-uid process. A same-uid attacker can read `~/.glosa/token`
(mode 0600) directly, so nothing here is load-bearing against them. Recorded in `decisions.md`.

*Bun realpaths `import.meta.url`*, so a `bun link`ed install and the checkout it points at hash
identically. That is correct — they are one install. Moving or renaming a checkout changes its
`INSTALL_ID` and orphans a running daemon; the failure names the PID and the recovery command.

### A2. A client only ever stops a daemon its own install started

The first draft guarded one branch. That was wrong: `~/.glosa/daemon.log` shows cross-install kills
under `newer-client` too, which that draft left untouched. The rule is uniform.

```
decideDaemonBuild({ clientBuildId, clientInstallId, daemonBuildId, daemonInstallId, daemonProtocol })
```

An options object, not two extra positional parameters, so all ten existing call sites fail loudly
at typecheck rather than silently defaulting, and the unknown-install case is nameable.

| Daemon | Today | After |
|---|---|---|
| no `build_id` (legacy) | restart | restart *(unchanged — one-time, and a stale pre-`install_id` daemon should go)* |
| client version newer, **same install** | restart | restart |
| client version newer, **different install** | restart | **fail** |
| same version, different hash, **same install** | restart | restart *(a developer edited their own source)* |
| same version, different hash, **different install** | restart | **fail** |
| identical build | use | use |
| client older | protocol check | protocol check *(unchanged — no kill either way)* |

`daemonInstallId === undefined` on a non-legacy daemon means unknown identity, which is **not**
"same install": it fails. Two `undefined`s never compare equal for this purpose.

Both degraded error paths the review found are fixed with it:

- `locklessHandshakeResult` (`daemon.ts:543`) branches on `action === "restart"` to attach the
  manual-recovery text. The new `fail` gets its own, more specific message naming the other
  install and the exact `lsof`/`kill -TERM` recovery — the most informative case must not lose it.
- The `fail` return at `daemon.ts:728` omits `logPath`, unlike its neighbours at `:723`/`:745`. It
  gains one, and the refusal is logged, so a refusal is as traceable as a restart is today.

### A3. A source checkout gets its own home and port

`isSourceCheckout()` ⇔ `<package root>/packages/daemon/test` exists. The npm tarball excludes
`test/` — `scripts/package-smoke.ts:80` asserts it — so this is a property of the artifact, not a
guess about the environment, and it does not depend on symlink shape. Cached per process: the
layout of the running package cannot change mid-process. Env is re-read on every call, because
`daemon-identity.ts:23` documents that `glosaHome()` is re-derived per use and tests mutate
`process.env` between cases.

When running from a checkout **and** the variable is unset:

```
GLOSA_HOME  → ~/.glosa-dev/<sha256(realpath(packageRoot)).slice(0,16)>
GLOSA_PORT  → 60000 + (sha256(realpath(packageRoot)) mod 2750) * 2     # even; class-F = +1
```

**The home lives outside the working tree.** The first draft put it at
`<packageRoot>/.glosa-dev/home`. That places a plaintext bearer credential inside a git checkout,
where `.gitignore` protects only git-mediated paths — not Time Machine, not Dropbox, and above all
not the coding agents that read a whole repository, which is precisely the tooling glosa exists to
work alongside. `~/.glosa-dev/<hash>` keeps per-checkout isolation with none of that exposure.

**The port range is disjoint from the test allocator.** `packages/daemon/test/helpers.ts:137-142`
reserves 20000–59999 in four-port blocks with a sentinel per block. A hash-derived port inside that
range has no reservation and could be handed to a test while a dev daemon holds it. 60000–65498
avoids it, and even offsets keep `port` and `port + 1` inside one checkout's own pair.

**Both port consumers, plus class-F.** `daemon.ts:177` (the daemon's own bind) and `daemon.ts:642`
(`seedPort` in `ensureDaemon`) must use the same resolver, or client and daemon look in different
places and every discovery lands in the fail-closed branch at `daemon.ts:691`. `GLOSA_CLASSF_PORT`
keeps deriving as `port + 1`. `buildChildEnv` (`daemon.ts:806`) pins already-resolved values from
its `opts`, so the spawned child inherits the parent's decision and `env.test.ts:20` /
`init-runner.test.ts:80` keep asserting their explicit literals.

**Existing state is not migrated, and that is the point.** A developer whose checkout previously
used `~/.glosa` will see an empty workspace list. One stderr line on first use per process names
both derived values and how to override, and `GLOSA_HOME=~/.glosa` restores the old behaviour
exactly. Documented in `CHANGELOG.md` and `CONTRIBUTING.md`.

*Why both A2 and A3.* A3 is prevention — it removes the collision, and after it two checkouts share
neither lock nor port. A2 is the invariant, and it is not made redundant: it still covers an
explicit `GLOSA_HOME=~/.glosa` from a checkout, two release installs at different paths, and every
daemon already running from before this change.

### A4. The daemon records why it rejected a request

One line per 401: the reason (`no-token-on-daemon` / `bearer-mismatch`) and a suppressed count.
**No request path and no credential** — the path is attacker-controlled, which makes it both a log
injection vector and unbounded key cardinality. The review's specific catch: a throttle keyed on
`(path, reason)` is defeated by varying the path, giving one fresh bucket per request and
unbounded `daemon.log` growth. The key is the **reason alone**; the first occurrence logs
immediately, then at most one line per 60 s carrying the count suppressed.

Scoped to the SPA/API listener. Class-F carries its capability in the URL path, so its rejections
must never reach a logger that might one day be told to include one.

### A5. Actionable recovery

`ensureDaemon`'s "bound but not answering" failure (`daemon.ts:691`) already knows the port and,
where a lock exists, the PID. It gains the same `lsof -nP -iTCP:<port> -sTCP:LISTEN` /
`kill -TERM <pid>` recovery text that `locklessHandshakeResult` prints, and `glosa doctor` gains a
check for a lock whose PID is alive while its handshake fails.

### A6. Tests

| Area | Test |
|---|---|
| install id | deterministic; differs across roots; stable across calls |
| shape guards | non-string `install_id` rejected in lock and handshake, mirroring `lock.test.ts:51` |
| peer mismatch | present-on-one-side is a mismatch; absent-on-both is agreement; `build` reason string unchanged |
| `decideDaemonBuild` | one case per row of the A2 table, including both new fails and unknown-install |
| error paths | the cross-install fail carries `logPath`, the PID, and the kill command |
| dev default | checkout ⇒ derived home/port; explicit env wins; release layout ⇒ `~/.glosa`:4646 |
| port derivation | even, in 60000–65498, stable, disjoint from the test allocator range |
| 401 log | throttled per reason, never contains the path or the token |
| regression | a second install's daemon is refused, not killed *(real subprocess)* |

## 4. PR B — a daemon swap is not a revocation

Depends on `install_id` reaching the handshake (A1).

**What the tab knows.** `scrubSecrets` stores the token; `main()` then fetches the handshake and
records `sessionStorage.glosa_install` (non-secret) beside it. A tab paired before this change has
a token and no recorded install — unknown identity, so it behaves exactly as today and records the
identity on its next successful load.

**Load path.** `selectScreen(handshake, token, pairedInstall)` gains a `foreign-daemon` result:
token present, `paired: true`, both install ids known and different. Without this, a fresh load
against a foreign daemon renders `ready` and 401s on its first call (`bootstrap.js:165`).

**401 path.** On any 401, probe the tokenless handshake once, then:

```
unreachable                        → existing "down" path, credential untouched
paired:false                       → genuinely unpaired  → wipe + unpaired      (A3 §55 unchanged)
paired:true, same/unknown install  → credential rejected → wipe + unpaired      (A3 §55 unchanged)
paired:true, different install     → foreign daemon      → see below
```

**The foreign-daemon state stops sending the credential.** It renders a distinct screen, sends no
further authed request, and polls only the *tokenless* handshake. This is what makes retaining the
credential safe, and it is strictly better than today: the current code re-sends the token on every
stream reconnect against whatever holds the port. On identity match it calls
`window.location.reload()` — the page re-bootstraps with the retained token, which sidesteps
`connectOnce`'s terminal `stopped = true` (`data-access.js:161`) entirely. There is no in-place
stream resume to design. After a bounded window (10 minutes) it gives up, wipes, and shows the
unpaired screen with the re-pair instruction.

**Plumbing the review found missing.** The handshake body never leaves `bootstrap.js:222`, and
`createDataAccess()` is called argument-less from `viewer.js:73` (a parameter default), with
`history.js:76` following the same pattern. The expected install id is threaded through `mountApp`
into `createDataAccess`, and separately into `openEventStream` — `connectOnce`
(`data-access.js:152-165`) is a module-scope function that does its own wipe and does **not** go
through `handleUnauthorized` (`:313`). Both entry points call one shared decision function.
`unauthorizedHandled` (`:306`) is never reset, so it must not latch before the branch is chosen.

The genuinely-unpaired screen also renders the workspace slug from the surviving `#w=` fragment, so
recovery names the workspace instead of saying `glosa open <directory>`.

**Normative updates:** A3 §55 gains the identity precondition; `decisions.md` records why retaining
a credential we have stopped transmitting is not a weakening.

## 5. PR C — one init, every Claude config root

1. **Honour `CLAUDE_CONFIG_DIR`.** `rootsFor()` resolves the active root as
   `$CLAUDE_CONFIG_DIR ?? ~/.claude`. Running `glosa init --scope user` inside a ccs session today
   wires `~/.claude`, which that session never reads. Plain bug fix; lands first.
2. **Transcript confinement takes a set.** `claudeConfigDir()` becomes `claudeConfigRoots()`:
   `$CLAUDE_CONFIG_DIR`, `~/.claude`, and `~/.ccs/instances/*`. `confineTranscriptPath` admits a
   path under any root, each realpath-confined as today. Without it every ccs session's
   `transcript_path` is refused `400 invalid-path`.
3. **The provider discovers its own roots.** Claude-specific knowledge belongs in
   `packages/providers/claude-code/src/install.ts`, not the CLI core (invariant 1). `targets()`
   gains a filesystem capability from the generic core and emits one target per root with distinct
   manifest keys; `files` is already `Record<string, …>`.
4. **Dedupe by real file, confined.** All four ccs instances symlink `settings.json` to one shared
   file, so writing per declared path would insert glosa's hooks four times. The core dedupes by
   `realpath`. Critically — and unlike the first draft — the resolved path must still land under
   one of the discovered roots, mirroring `confine-path.ts`, or the write is refused. Every other
   write surface in this codebase confines; a dedupe that follows a symlink and writes wherever it
   lands is an arbitrary-write primitive if any tool sharing that directory ever repoints it. The
   `--print` consent diff renders **resolved** paths, so approval is informed.
5. **Find hooks by content, not array index.** The manifest addresses hooks as JSON pointers plus a
   sha256; ccs reorders those arrays on re-adopt (~35 `.ccs-adopted-recovery-*` snapshots beside
   the shared file). Resolve by digest first, fall back to the pointer, so a reorder cannot strand
   glosa's entries and make uninstall a silent no-op.
6. **`doctor` reports discovered roots** and which are wired, so an unwired instance is visible.

## 6. Invariants

| Invariant | How this holds |
|---|---|
| 1 — generic core, declarative providers | ccs/Claude discovery lives in the claude-code provider; dedupe, confinement and capability stay generic |
| 2 — journal is truth | untouched |
| 3 — honest provenance | untouched; A1 makes *daemon* identity honest, which provenance already assumes |
| 4 — no cmux | untouched |
| 5 — local-first, zero egress | no new network calls; `install_id` is hashed so no path reaches an unauthenticated endpoint; the 401 log records no request content |
| 6 — one SPA data-access module | the 401 decision lives in `data-access.js`; bootstrap passes identity in and adds no second path |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Derived dev port collides with something | range disjoint from the test allocator; explicit `GLOSA_PORT` overrides; a real collision surfaces as today's EADDRINUSE diagnostic |
| A developer's checkout stops seeing `~/.glosa` | loud first-use notice naming both values; `GLOSA_HOME=~/.glosa` restores it; CHANGELOG + CONTRIBUTING |
| Cross-install `fail` where today's silent restart "worked" | the message names the other install, the PID and the kill command; a same-path upgrade still restarts |
| Retaining a credential after a foreign 401 | the tab stops transmitting it and polls tokenless; bounded to 10 minutes; recorded in `decisions.md` |
| Multi-root init writes more files | dedupe by real file, confined to discovered roots, consent diff shows resolved paths, manifest records every alias |
| `install_id` is guessable | stated as an integrity signal, not a secrecy boundary; a same-uid attacker already holds the token |

## 8. Review record

Adversarially reviewed and revised before implementation. Findings adopted:

- **Security, HIGH** — a dev home inside the working tree exposes the token to repo-wide agent
  reads and non-git backups. → §A3 moves it to `~/.glosa-dev/<hash>`.
- **Security, HIGH** — gating resumption on a self-reported `instance_id` makes the tab a standing
  credential oracle for anything that wins the port. → §4 gates on `install_id`, stops transmitting
  entirely while foreign, and bounds the window.
- **Security, HIGH** — dedupe-by-realpath is an unconfined write. → §5.4 confines to discovered
  roots and renders consent against resolved paths.
- **Security, MEDIUM** — a per-path 401 throttle is trivially defeated. → §A4 keys on reason alone
  and logs no request content.
- **Implementability** — the first draft guarded one restart branch while the logs show
  cross-install kills under `newer-client`. → §A2 is now uniform.
- **Implementability** — two positional parameters would break ten call sites silently. → options
  object; `undefined` install id is explicitly not "same install".
- **Implementability** — one `DEFAULT_PORT` consumer named, three exist; the test allocator owns
  20000–59999. → §A3 names all three and moves the range.
- **Implementability** — missing shape guards, unstated absent-vs-present rule, `sameLockInstance`
  left out, two error paths degraded. → §A1, §A2.
- **Implementability** — the SPA change is not two files: the handshake never leaves `main()`,
  `createDataAccess()` is called argument-less, and `connectOnce` is a separate terminal path. →
  §4 plumbs explicitly and recovers by reload rather than in-place resume.

## 9. Sequencing

1. **PR A** — done. A1 → A2 → A3 → A4 → A5, each with tests, then `decisions.md`, the A5
   appendix, `CHANGELOG.md`, `CONTRIBUTING.md`.
2. **PR B** — the SPA foreign-daemon state (needs A1's handshake field).
3. **PR C** — Claude config roots, transcripts first.

Gate for each: the narrowest relevant suites, then `bun run typecheck`, `bun test`, `bun run lint`,
`bun run format:check`. None gets auto-merge — all three touch surfaces AGENTS.md marks
review-blocking.
