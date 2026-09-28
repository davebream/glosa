# Install lifetime and restart: what a running daemon does when its install changes

Status: accepted by the maintainer on 2026-09-29 for #432, with the review answers in §8. Companion to
`2026-09-25-daemon-ownership-and-pairing-under-a-shell.md` (R-O1..R-O6, R-P1..R-P5), which it
amends in two places (R-O1, R-P5). The rules apply to every install channel, not only the Linux
package that prompted them.

## 1. The failure

The daemon is a detached per-user process that outlives every window (R-O4). Its install can
change underneath it: `pacman -U` or `pacman -R` on Linux, `brew upgrade --cask glosa` on macOS,
or `glosa update` for an npm/bun global install. Today:

- **Upgrade.** The old daemon keeps running. It holds its code in memory but reads the SPA from
  disk on every request (`serveShell` and `serveSpaAsset`, `packages/daemon/src/transport/http.ts`),
  so a page gets new files served by old server code. A page loaded earlier later pulls newer
  lazily imported modules into an older page. Workers (matcher, hardlink aliases) and the managed
  chat guardian are started from the changed tree. Nothing says glosa was updated.
- **The fix happens only by accident.** The install id is a hash of the package root's realpath
  (`lifecycle/install.ts`), unchanged by an in-place upgrade, so a newer package is a `newer-client`
  restart, but only when some CLI next calls `ensureDaemon`. The daemon never checks its own tree.
  A `glosa monitor` started before the upgrade rejects the newer daemon's `build_id` and retries
  forever, so push delivery stops silently.
- **Uninstall.** The daemon keeps running from memory with its files gone: page loads return 500,
  worker and guardian spawns fail. It holds the port and lock indefinitely; another install then
  sees a foreign daemon it may not stop, and there is no `glosa stop`. `GLOSA_HOME/bin/glosa`
  dangles, and an open desktop window falls through to whichever other `glosa` it finds on disk.

User documents are not at risk: all state lives in `GLOSA_HOME` or a workspace's `.glosa`, never
under the package root. The risks are a mixed-version app, the wrong install being used, and a
process nothing will stop.

## 2. Facts the rules rest on

Measured for #432 on an x86_64 Arch container (pacman 7.1, electron-builder 26.15.3):

- `pacman -U` gives **every** file a new inode, unchanged files and `bin/bun` included. A file held
  open keeps its old bytes and reads as `(deleted)`. Directory mtimes change.
- Archive (extraction) order is a directory walk: `resources/bin/bun` early, then
  `resources/glosa/package.json`, then `packages/spa/src/shell.html`, then
  `packages/daemon/src/index.ts`, with the Electron binary last. No single marker file is
  guaranteed to change first or last.
- `pacman -R` removes the whole tree, including the package-owned `/usr/bin/glosa` link.
- A package scriptlet runs as root. It cannot prove ownership of a per-user daemon (lock plus
  handshake plus quiesce, A5 §F13), and `GLOSA_HOME` is per user and overridable.
- Bun's `performance.timeOrigin` trails the kernel's exec time by a few hundred milliseconds under
  emulation. On Linux the exact process start is `/proc/self/stat` field 22.

## 3. Rules

**R-L1. An installed daemon reads its tree only at boot.** A daemon running from an installed tree
(not a source checkout, `isSourceCheckout()`) reads `shell.html`, every SPA allowlist entry and
every provider browser asset into memory before it binds, and serves those bytes for its whole
life. Its `build_id` then describes exactly what it serves.

**R-L2. A daemon only starts from a tree that held still.** Before binding, it records the identity
(dev, ino, size, mtime and ctime in nanoseconds, from `lstat`) of the package root, every directory
under it (symlinks not followed), a curated file set (`package.json`, worker entry files,
`guardian.ts`, `execution-host.ts`, runtime locks, provider browser assets, the pinned SPA files)
and `process.execPath`. If any entry's ctime is at or after process start minus a margin, the tree
changed while the process was loading: it logs `install changed during boot` and exits 5 without
binding. ctime cannot be set from userspace, and the margin only errs toward refusing.

**R-L3. Nothing new starts from a changed tree.** Every post-boot access to the tree re-verifies the
snapshot first: Worker creation (matcher, hardlink aliases), the guardian spawn, the runtime lock
read and install. A mismatch refuses the operation (`install-changed`, 503 for managed runs) and
**fences** the daemon. Fencing is one-way.

**R-L4. A changed install retires its daemon through the daemon's own drain.** Detection comes from
any guarded access or from a sweep (an unref'd timer doing local `lstat` only, 2 s). A fenced
daemon keeps serving its API and pinned SPA, reports `install_changed: true` in the handshake, and
waits until two sweeps agree (at most 30 s; none if the root is gone). Then, if managed chats are
not busy, it takes the existing quiesce fence and runs the same `shutdown()` the SIGTERM handler
runs: drain, SSE `bye` with reason `install-changed`, `releaseWorkspaceResourcesForExit`, its own
lock removed, exit 0. While chats are busy it stays fenced: running chats finish, new ones are
refused, and it retries on each sweep. It is never killed and never interrupts a write.

**R-L5. Only the user's own glosa processes stop a daemon.** No package scriptlet, root process or
foreign install enumerates or signals daemons. A daemon exits through R-L4, through `ensureDaemon`
from its own install (A5 §F13), through its stall watchdog, or because the user stops it.

**R-L6. A page runs one build.** The daemon stamps `shell.html` with its build hash
(`<meta name="glosa-build">`) and serves assets under `/app/@<hash>/…`; relative imports inherit the
prefix. A request for another hash gets `410 build-changed`, never another build's bytes. The page
sends `X-Contract-Version` on every request. When it learns the daemon changed (a `bye` with that
reason, a reconnect whose handshake `build_id` differs from the page's, a 410 or a 409) it shows
"glosa was updated. Reload to use the new version." It reloads only when the person clicks,
through the existing unsaved-changes guard.

**R-L7. Clients converge, and the stale side is named.** `decideDaemonBuild` restarts a same-install
daemon that reports `install_changed` unless it is `managed_busy` (then the client uses it);
foreign-install rules are unchanged. The monitor applies R-O2: it accepts a daemon from its own
install that speaks a compatible protocol, serves the socket and whose `build_id` equals the
install's on-disk build, and says once on stderr that it predates the install.

**R-L8. A shell window reconnects to its own install, or says why not.** On a `bye` with reason
`install-changed`, or the stream down for 3 s or more, the page asks the shell to ensure a daemon
(`glosaShell.ensureDaemon()`); the shell runs `glosa open <that window's folder> --url --json`
(R-O3), one call in flight per window. The result is: reconnected; a different install answered
(banner, no navigation); or failed (message in the banner). A packaged shell whose own bundled CLI
is gone never runs any other CLI: it says "glosa was removed or updated. Quit glosa and open it
again." This amends R-P5: a restart is a reconnect; re-pairing happens only after a revocation.

**R-L9. User state lives outside the package.** The package installs nothing under `$HOME` or
`/etc/skel`, marks nothing under `/opt/glosa/resources/glosa` as a pacman `backup` file, ships no
`packages/daemon/test` (it would switch R-L1..R-L4 off and move the home to `~/.glosa-dev`), and
ships `/usr/bin/glosa` as a package-owned symlink so `pacman -R` removes it. A reinstall at the same
path has the same install id, so the recorded executable resolves again and the pairing token
still works.

**R-L10. Source checkouts stay live.** A checkout gets no guard, no pinning and no retirement. The
`/app/@<hash>/` prefix uses the startup hash, so reloading after an edit still picks up new bytes.

| Requirement (#432) | Rules |
|---|---|
| No mixed-version resource loading | R-L1, R-L2, R-L3, R-L6 |
| No unsafe process termination | R-L4, R-L5 |
| No lost data | R-L4 (drain), R-L7 (monitor), R-L9 |
| No stale launcher silently selecting another install | R-L8, R-L9 |

## 4. What changes

| Component | Change |
|---|---|
| Daemon lifecycle | New `lifecycle/install-guard.ts` (snapshot, verify, pinned/fenced/retiring); boot check before bind; sweep after ready; retirement through `shutdown()`; exit code 5 |
| Daemon transport | New `transport/spa-assets.ts` (pinned and live sources, shared allowlist); `/app/@<hash>/` route and 410; handshake `install_changed`; `bye` carries `{reason}` |
| Spawn sites | Gate before matcher and hardlink Worker creation, the guardian spawn and the runtime lock read |
| Client decision | `decideDaemonBuild` rows for `install_changed`; `spawnAndWait` maps exit 5 to "glosa's files changed while it was starting. Run the command again when the update has finished." |
| Monitor | R-O2 acceptance of a same-install daemon whose build equals the on-disk build |
| SPA | `data-access.js` sends `X-Contract-Version`, compares build on reconnect, reads the `bye` reason, maps 409/410; a small lazy-module wrapper guards the lazily imported modules; update banner. Contract 1.22 to 1.23 |
| Shell | `ensureDaemon` IPC, per-window install id, packaged shell refuses a foreign CLI |
| Packaging | No `packages/daemon/test`, package-owned `/usr/bin/glosa`, no scriptlet logic |

Environment seams for tests follow the `GLOSA_STALL_WATCHDOG_MS` precedent:
`GLOSA_INSTALL_SWEEP_MS`, `GLOSA_INSTALL_BOOT_MARGIN_MS`.

## 5. Races and accepted residuals

- **Extraction in progress.** Files change one at a time in an order nobody controls. R-L1 means an
  old daemon never serves a new file. R-L2 means a daemon started mid-extraction refuses to bind
  rather than run mixed code. R-L3 checks each spawn's inputs at the moment of use.
- **A short-lived CLI started during extraction** may load mixed code and fail once; running it
  again fixes it, and R-L2 stops it from leaving a mixed daemon behind.
- **In-place writes** (`O_TRUNC`) to files outside the curated set are not detected. No package
  manager writes that way.
- **Dependencies outside the package root** (a bun global's shared hoisted tree) are not watched.
  `BUILD_ID` has the same blind spot today.
- **Lazy `require()` inside `node_modules`** between a change and the next sweep. None is known in
  the daemon.
- **The running Electron process** keeps its replaced `app.asar` and binary open until it quits. It
  only reaches the daemon over HTTP, so R-L6 and R-L8 cover what the person sees.

## 6. Proof

Deterministic tests (real filesystem, real subprocess daemon on a staged copy):

- `install-guard.test.ts`: rename-over, unlink, unlink plus create with the old mtime restored,
  added file, root replaced, root missing, `execPath` changed, symlinked `node_modules` not
  followed, the boot verdict, settle and busy deferral with a single retirement, and the in-place
  write residual named as not detected.
- `install-lifetime.test.ts`: T1 upgrade in place (old bytes still served, graceful exit within
  10 s, next CLI spawns the new build, state intact); T2 removal (never a 5xx, graceful exit); T3
  boot refusal (exit 5, retry message); control C1 with `packages/daemon/test` present (no guard).
- Ablations with a named red: `verify` always ok, pinned source swapped for live, margin check
  removed, scoped-hash check removed, monitor acceptance removed.

Installed-package smoke (Arch container, the real `.pacman`), with user state recorded first
(workspace, inbox entry, claim, star, token hash, journal prefix hash, recorded link):

| Check | Must hold |
|---|---|
| P-L1 close and reopen | Shell exits, daemon keeps pid and instance id; reopen reuses it, no pairing prompt |
| P-L2 `pacman -U` with a window open | Old daemon retires gracefully within 15 s; a 50 ms poller never sees a 5xx or new bytes from the old daemon; the new daemon's build equals the on-disk build; old-hash assets get 410; the banner shows; state intact |
| P-L3 `pacman -R` with a window open | Tree and `/usr/bin/glosa` gone; no daemon, lock or socket within 15 s; a decoy `~/.bun/bin/glosa` never runs; user state unchanged |
| P-L4 reinstall | Recorded link resolves again, same install id, workspace reopens without pairing |
| Named red | P-L2 and P-L3 against a package built from `main` fail |

## 7. Rejected alternatives

- **Check one marker file per read, answer 503.** Archive order makes any single marker unsafe, and
  a fenced daemon waiting on busy chats could not serve its own UI.
- **Serve from memory only, no retirement.** Never converges: after `pacman -R` the orphan holds the
  port and lock forever and every other install fails as foreign.
- **A pacman scriptlet signals daemons.** Runs as root without the lock, handshake and quiesce
  proof, bypasses `managed_busy`, and helps only pacman users.
- **Versioned install directories.** pacman deletes the old version's files at the end of `-U`
  anyway, and a root per version changes the install id every release, so every upgrade would look
  like a foreign install no client may stop.
- **The daemon spawns its successor.** Breaks A5's rule that clients spawn and daemons do not, and
  invites loops and surprise downgrades.
- **inotify or `fs.watch` as the trigger.** Linux-specific semantics, watch limits, and still
  asynchronous, so the stat check would remain.

## 8. Review answers (2026-09-29)

1. **Timing.** 2 s sweep and 30 s settle cap as proposed. The boot check measures from the kernel's
   process start on Linux (`/proc/self/stat`, 100 ms margin) and from `performance.timeOrigin`
   minus 500 ms on macOS. Retune after measurements on an x86_64 runner.
2. **A plain browser tab** (no desktop app) gets copy telling the person to run `glosa open`. The
   page never spawns a daemon.
3. **Unscoped `/app/<file>`** keeps answering indefinitely, for pages loaded before this change; a
   page served under this policy only requests the scoped route.
4. **Downgrading** with `pacman -U` to an older package is documented as unsupported, as A6 §F30
   already does for `glosa update --to`.
5. **T8.** `install-lifetime.test.ts` does not join the T8 fault suite in #432; that would change the
   approved release bar and is proposed separately.
6. **Doctor** reports a daemon that stays fenced because managed chats are busy, as a warn row.
