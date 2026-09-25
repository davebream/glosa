# Daemon ownership and pairing under a desktop shell

Companion to the feature map (`2026-09-25-desktop-shell-feature-map.md`, decisions 1 and 2) and
the readiness note (`docs/research/2026-09-25-desktop-shell-readiness.md`). Status: proposal. It
turns two one-line decisions into a contract, and it starts from a failure observed on 2026-09-25
that any long-lived client, shell or not, can hit today.

## 1. The failure that makes this concrete

A glosa process computes `BUILD_ID` once, at start, by hashing its runtime sources. A process that
outlives a change to those sources (an MCP server held open by an editor session, a
`glosa monitor`) then carries a hash the tree no longer has. `decideDaemonBuild`
(`packages/daemon/src/lifecycle/daemon.ts`) reads "same version, different bytes, same install" as
a developer editing their own source and restarts the daemon. So the stale client evicts the daemon
it just spawned, because that daemon hashed the current tree; the single permitted spawn attempt is
spent; the call fails with `daemon ownership was not established`. A fresh CLI restarts the daemon
the other way, and two clients of one install take turns evicting a healthy daemon.

Observed in `~/.glosa-dev/<install>/daemon.log` after the previous day's merges:

```
refreshing gl-9f6f…: same-version-different-build (…-65775bc2… -> …-3295d86b…)   # fresh CLI evicts the old daemon
gl-0a94… serving 127.0.0.1:63202
refreshing gl-0a94…: same-version-different-build (…-3295d86b… -> …-65775bc2…)   # stale monitor evicts the new one
gl-7203… serving 127.0.0.1:63202
refreshing gl-7203…: same-version-different-build (…-3295d86b… -> …-65775bc2…)   # and then the one it spawned itself
gl-7203… graceful shutdown complete
```

Every process was the same install (`~/.glosa/bin/glosa` and the global package are symlinks into
the checkout), so the foreign-install guard did not apply. A shell that stays open for days is the
longest-lived client glosa will ever have.

## 2. Ownership rules

**R-O1. The install of truth is the CLI.** The daemon's version is whatever `bun install -g` (or
the recorded executable in `GLOSA_HOME/bin`) put on disk. The shell never installs, upgrades or
downgrades it. A6 §F30 holds because the shell never writes the install.

**R-O2. Restart only what is proven stale, never what is merely different.** On the
same-version-different-build path the client re-derives the install's current on-disk build id
before deciding. This is the rare path, so hashing is affordable there even though `install.ts`
keeps it off the handshake hot path.

- Daemon build equals the on-disk build: the client is stale. Decision `use`. Log once that this
  process predates the tree it runs from and should be restarted.
- Daemon build differs from the on-disk build: the daemon is stale. Decision `restart`, as today.

Regression test: a client whose in-memory `BUILD_ID` differs from the on-disk hash must not restart
a daemon whose build equals the on-disk hash. Ablation: with the rule removed, the test must show
the eviction.

**R-O3. Spawn only when absent; track what you spawned.** The shell first tries the handshake. Only
on no answer does it spawn `glosa __daemon` detached (`stdio: ignore`, unref), and it records that
pid with the daemon's instance id. A daemon discovered by a successful handshake is never the
shell's to stop.

**R-O4. The daemon outlives the shell.** On quit the shell stops nothing by default. It may stop a
daemon it spawned itself only when the daemon reports no bound session and no held claim
(`GET /api/status`), and it says so in its own log. This replaces "kill children on quit" in #160.

**R-O5. Compatibility is checked, not repaired.** The shell carries a minimum daemon version. A
daemon below it produces a blocking screen with the exact CLI command to run; a daemon above it
with an incompatible protocol produces the same screen the other way round. The shell never
attempts a mutation to fix either.

**R-O6. Supervision is a separate decision.** A launchd user agent would keep the daemon available
across logins and let launchd own restarts; it also means the shell owns a plist in the user's
`LaunchAgents`, which the CLI then has to know about. A detached child satisfies R-O3 and R-O4 with
no new files. Spike both before choosing; the readiness note lists the trade.

## 3. Pairing rules

Today `glosa open --url` mints a presentation token and puts it in the URL fragment; the SPA
redeems it and rewrites the URL without it. The Electron spike confirms the fragment is absent from
session history after load. Two things change under a shell.

**R-P1. The shell mints and redeems the token itself.** The main process runs the same
registration the CLI runs (`glosa open <path> --url` or the API it wraps), receives the token, and
hands it to the page over the preload channel once after `did-finish-load`, as a one-shot IPC
reply. The page redeems it exactly as it does today. The fragment path stays for browsers and for
`glosa open` in a terminal; the shell does not use it, so a crash reporter, a `did-navigate`
listener or Chromium's own URL logging never sees a token.

**R-P2. One token per window load; none survives a reload.** A reload asks the main process for a
fresh token. The main process never caches one.

**R-P3. The preload is a per-origin capability.** It is attached only to the SPA window, exposes
nothing unless `location.origin` equals the shell's configured SPA origin exactly, and every
`ipcMain` handler verifies `event.senderFrame.origin` before acting. The class-F frame never
receives a preload.

**R-P4. Several windows, one daemon.** Each window pairs on its own load; the daemon's pairing
state is per token and unaffected by window count. Layout per window is decision 3 in the feature
map and is not changed here.

**R-P5. A daemon restart under an open window is a re-pair, not a crash.** The SPA already shows the
reconnecting banner; when the daemon answers again the window asks the main process for a new token
and redeems it. The shell never keeps a window on a daemon it did not pair with.

## 4. What this asks of the daemon

- `decideDaemonBuild` gains the on-disk comparison (R-O2). Everything else in this document is
  shell-side and needs no new daemon route.
- `GET /api/status` already reports sessions and claims; R-O4 reads it and needs nothing added.
- The presentation-token mint the CLI uses is the one the shell calls; no second mint path.

## 5. Out of scope

Launching agent sessions from the shell (#157), Windows and Linux (ROADMAP "Later"), and any
change to the browser path: `glosa open` in a terminal keeps minting into the fragment.
