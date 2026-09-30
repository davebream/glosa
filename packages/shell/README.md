# @glosa/shell

The desktop shell: one Electron window on the SPA that the glosa daemon already serves. It adds
what a browser tab cannot have (a native folder picker, pairing without a URL, OS notifications,
Reveal in Finder, `glosa://` links, and a Check for Updates… that asks GitHub on click whether a
newer app exists, installing nothing) and nothing else. A packaged shell uses the recorded executable
(`~/.glosa/bin/glosa`, or `$GLOSA_HOME/bin/glosa`) and never updates or stops its daemon. An unpackaged
shell uses the CLI in its own checkout. A packaged app also carries a CLI, the daemon, the SPA and a
Bun runtime under `Contents/Resources`, and uses them only when
nothing is recorded, so a downloaded app is complete on its own (#371).

`GLOSA_SHELL_CLI` overrides CLI selection. Without it, an unpackaged shell runs only its checkout's
CLI and fails if it is missing. A packaged shell tries the recorded executable, its own launcher,
`~/.bun/bin/glosa`, `/opt/homebrew/bin/glosa`, `/usr/local/bin/glosa`, then `glosa` on PATH. A
recorded link whose target is gone counts as absent.

This package is deliberately **not** a member of the root workspaces: Electron is a 100 MB
download that the CLI, the daemon and the SPA must never pull in. Install it on its own.

```sh
bun install --cwd packages/shell          # downloads Electron and brands its bundle as glosa dev
bun run --cwd packages/shell start -- ~/some/folder   # or omit the folder to get the picker
bun test packages/shell                    # policy tests; the Electron suite skips if Electron is absent
```

The unpackaged shell uses a separate Electron profile per checkout, so it can run beside the installed
app without sharing browser storage or the single-instance lock. The Dock, app switcher and menu bar
take the name and icon from its bundle. The install's `postinstall` (`scripts/brand-electron.ts`)
brands Electron.app as glosa dev with glosa's icon, then re-signs it ad hoc. Run
`bun run --cwd packages/shell brand` again after reinstalling Electron. Packaged, `productName` in
package.json names the app glosa.

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
bun run --cwd packages/shell package -- --arch all --unsigned --smoke     # what CI runs on pull requests
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
- `--unsigned` builds are signed ad hoc. Releases publish them until a Developer ID exists, and
  macOS asks each person to allow the app once (`docs/release.md`, "Ad hoc or notarized"). A
  notarized build needs a Developer ID (`CSC_LINK`, `CSC_KEY_PASSWORD`) and `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Bun is re-signed under that identity with
  `assets/entitlements.mac.plist`, which keeps its JIT.

### Linux: the pacman package (#432, experimental)

On an x86_64 Linux host the same script builds `dist/x64/glosa-<version>-x64.pacman` from the same
staged tree. It installs to `/opt/glosa`:

```
/opt/glosa/
├── glosa               Electron, named glosa so the desktop file is glosa.desktop
├── chrome-sandbox      root-owned, mode 4755 (the SUID fallback when user namespaces are off)
└── resources/
    ├── app.asar
    ├── bin/bun         Bun's baseline build (every x86_64 CPU), checked against SHASUMS256.txt
    ├── bin/glosa       the same launcher
    ├── glosa/          exactly what npm publishes, plus production node_modules
    ├── licenses/
    └── package-type    "pacman": the marker the CLI classifies its install kind from
/usr/bin/glosa          a package-owned symlink to resources/bin/glosa
/usr/share/applications/glosa.desktop   Exec=/opt/glosa/glosa %U, handles glosa://
```

```sh
sudo apt-get install -y libarchive-tools zstd                   # Ubuntu; Arch and Manjaro already have both
bun run --cwd packages/shell package -- --arch x64 --smoke      # what CI runs; needs Docker for the smoke
sudo pacman -U ./dist/x64/glosa-<version>-x64.pacman            # install it on Arch or Manjaro
```

- The package owns every file it installs, and its install and remove scripts do nothing
  (`assets/linux/`): nothing to drift across upgrades, and `pacman -R` removes exactly what it
  installed. Your `~/.glosa` and every workspace's `.glosa` stay.
- The version is mapped for pacman (`0.1.0-alpha.36` becomes `0.1.0alpha.36`), so a prerelease sorts
  before its release. Git and the Electron libraries are declared dependencies.
- `scripts/linux-package-smoke.ts` checks the built package on the host, then installs it in fresh,
  digest-pinned Arch Linux containers that get nothing but the package files. It runs the CLI and
  MCP on the bundled Bun, the recorded-executable rules, doctor, the update refusal, a missing
  dependency failing without the network, and a running daemon across an upgrade, a removal and a
  reinstall (`docs/design/2026-09-29-install-lifetime-and-restart.md`). A second container runs the
  desktop app on a virtual display: opening a folder, the Chromium sandbox, a `glosa://` link to the
  running app, and reopening onto the same daemon. Container evidence does not qualify a Manjaro
  desktop; that is #435's.
