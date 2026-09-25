# @glosa/shell

The desktop shell: one Electron window on the SPA that the glosa daemon already serves. It adds
what a browser tab cannot have (a native folder picker, pairing without a URL, OS notifications)
and nothing else. The daemon and SPA are whatever the CLI installed; the shell never installs,
updates or stops them.

This package is deliberately **not** a member of the root workspaces: Electron is a 100 MB
download that the CLI, the daemon and the SPA must never pull in. Install it on its own.

```sh
bun install --cwd packages/shell          # downloads Electron 44
bun run --cwd packages/shell start -- ~/some/folder   # or omit the folder to get the picker
bun test packages/shell                    # policy tests; the Electron suite skips if Electron is absent
```

Contracts: `docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md`,
`docs/research/2026-09-25-desktop-shell-readiness.md`, A3 "Desktop shell". The main process is
unbundled TypeScript (erasable syntax only, Electron's Node strips types); the preload is plain
CommonJS because a sandboxed preload is not loaded by Node. Packaging (asar, `.app`, signing,
notarization) is the one build step glosa has, and it is not wired yet.
