# @glosa/shell

The desktop shell: one Electron window on the SPA that the glosa daemon already serves. It adds
what a browser tab cannot have (a native folder picker, pairing without a URL, OS notifications)
and nothing else. The daemon and SPA are whatever the recorded executable (`~/.glosa/bin/glosa`,
or `$GLOSA_HOME/bin/glosa`) is; the shell never updates or stops them. A packaged app also carries
a CLI, the daemon, the SPA and a Bun runtime under `Contents/Resources`, and uses them only when
nothing is recorded, so a downloaded app is complete on its own (#371).

The shell looks for a CLI in this order and runs the first one that exists: `GLOSA_SHELL_CLI`
(used as given), the recorded executable, the CLI a packaged app carries, `~/.bun/bin/glosa`,
`/opt/homebrew/bin/glosa`, `/usr/local/bin/glosa`, then `glosa` on PATH. A recorded link whose
target is gone counts as absent.

This package is deliberately **not** a member of the root workspaces: Electron is a 100 MB
download that the CLI, the daemon and the SPA must never pull in. Install it on its own.

```sh
bun install --cwd packages/shell          # downloads Electron 44 and brands its bundle as glosa
bun run --cwd packages/shell start -- ~/some/folder   # or omit the folder to get the picker
bun test packages/shell                    # policy tests; the Electron suite skips if Electron is absent
```

The Dock, the app switcher and the menu bar take an app's name and icon from its bundle, so the
install's `postinstall` (`scripts/brand-electron.ts`) rewrites node_modules/electron's Electron.app
to say glosa and carry glosa's icon, then re-signs it ad hoc. Run `bun run --cwd packages/shell
brand` again after reinstalling Electron. Packaged, `productName` in package.json does the same.

Contracts: `docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md`,
`docs/research/2026-09-25-desktop-shell-readiness.md`, A3 "Desktop shell". The main process is
unbundled TypeScript (erasable syntax only, Electron's Node strips types); the preload is plain
CommonJS because a sandboxed preload is not loaded by Node.

## Packaging

Packaging (`.app`, signing, notarization) is the one build step glosa has. Nothing is bundled or
transpiled: the app carries the published sources and runs them with the Bun it ships.

```
glosa.app/Contents/Resources/
├── app.asar            the shell: src/, two icons, package.json
├── bin/
│   ├── bun             Bun at the root packageManager pin, checked against Bun's SHASUMS256.txt
│   └── glosa           launcher: bin/bun --no-install glosa/packages/cli/src/main.ts "$@"
├── glosa/              exactly what npm publishes, plus production node_modules
└── licenses/           Electron's, Chromium's and Bun's license texts
```

```sh
bun run --cwd packages/shell package -- --arch arm64 --unsigned --smoke   # what CI runs on pull requests
bun run --cwd packages/shell package -- --arch all                        # both architectures, signed if CSC_* is set
bun run --cwd packages/shell smoke -- --app dist/arm64/mac-arm64/glosa.app
```

- `scripts/package-app.ts` stages the sources with `npm pack`, installs production dependencies
  from the lockfile beside the checkout, and refuses a tree with a test directory under
  `packages/`, a `.git` entry, a symlink or a missing dependency. It then fetches and verifies Bun,
  writes the launcher, and runs electron-builder.
- `scripts/after-pack.cjs` copies that staged tree into the bundle before signing. electron-builder's
  `extraResources` would drop the top-level `node_modules`.
- The launcher passes `--no-install` so a bundle with a missing package fails instead of letting Bun
  fetch it from the npm registry.
- `scripts/app-smoke.ts` copies the app out of the checkout, so nothing above it can supply a
  `node_modules`, and runs it with no Bun on `PATH`. It checks the bundle against the staged tree,
  the version, the signature, what the CLI records at `GLOSA_HOME/bin/glosa`, `glosa doctor`'s
  `install` row, the home directory, and that `glosa open` pairs with a daemon running on the bundled
  Bun.
- `--unsigned` builds are signed ad hoc and are for verification only. A release build needs a
  Developer ID (`CSC_LINK`, `CSC_KEY_PASSWORD`) and, to notarize, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Bun is re-signed under that identity with
  `assets/entitlements.mac.plist`, which keeps its JIT.
