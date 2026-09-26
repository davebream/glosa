# Releasing glosa

How a release reaches people: what a tag produces, the secrets it needs, how to rehearse it, how to
check a shipped build, and how the Homebrew cask is bumped.

## What a tag produces

Pushing a tag `v<version>` that matches `package.json` runs `.github/workflows/release.yml`:

1. The same test jobs as CI, with the full profile forced, plus the secret and dependency scans.
2. `release`: publishes `@davebream/glosa` to npm with provenance and creates the GitHub release.
3. `app`: builds the desktop app for Apple Silicon (`arm64`) and Intel (`x64`), smoke-tests it,
   and uploads to the GitHub release: `glosa-<version>-arm64.dmg`, `glosa-<version>-arm64.zip`,
   `glosa-<version>-x64.dmg`, `glosa-<version>-x64.zip` and `SHA256SUMS`. It then commits the
   new cask and formula to the Homebrew tap. With the Developer ID secrets the app is signed and notarized;
   without them it is signed ad hoc (see "Ad hoc or notarized" below).
4. `released`: fails the run unless both `release` and `app` succeeded, so a tag that published npm
   but produced no app is red.

The app carries the published npm file set, its production dependencies and a Bun runtime at the
`packageManager` pin. Nothing is transpiled or bundled; packaging, signing and notarization are the
desktop shell's one exception to the no-build-step rule.

## Secrets

Set these under the repository's Settings, Secrets and variables, Actions.

| Secret | What it is |
|---|---|
| `NPM_TOKEN` | npm automation token for `@davebream/glosa`. Already in use. |
| `CSC_LINK` | The Developer ID Application certificate and its private key, as a base64 `.p12`. |
| `CSC_KEY_PASSWORD` | The password chosen when exporting that `.p12`. |
| `APPLE_ID` | The Apple ID email of the developer account, used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID. |
| `APPLE_TEAM_ID` | The 10-character Team ID of the developer account. |
| `HOMEBREW_TAP_DEPLOY_KEY` | Private half of an SSH deploy key with write access to `davebream/homebrew-tap` only; see "Bumping the tap automatically" below. |

Only the step that signs and notarizes receives the five Apple secrets. A test in
`test/quality-gates.test.ts` pins that.

### One-time Developer ID setup

1. Enrol in the Apple Developer Program (paid).
2. Create a **Developer ID Application** certificate: Xcode, Settings, Accounts, Manage Certificates,
   then `+`. Or create a certificate signing request in Keychain Access and upload it at
   developer.apple.com under Certificates.
3. In Keychain Access, find the certificate, expand it to include its private key, select both and
   export them as a `.p12` with a password.
4. Copy it into `CSC_LINK` and its password into `CSC_KEY_PASSWORD`:

   ```sh
   base64 -i glosa-developer-id.p12 | pbcopy
   ```

5. At account.apple.com, under Sign-In and Security, App-Specific Passwords, generate one for
   notarization. Put it in `APPLE_APP_SPECIFIC_PASSWORD`, and the Apple ID email in `APPLE_ID`.
6. Copy the Team ID from the Membership page at developer.apple.com into `APPLE_TEAM_ID`.

Delete the local `.p12` once the secret is saved.

### Ad hoc or notarized

glosa does not require the Apple Developer Program. Without its secrets the `app` job signs the app
ad hoc, which uses no certificate, publishes it all the same, and leaves a notice saying so.

An ad-hoc signed app runs, but macOS quarantines anything downloaded, and a cask install counts.
Gatekeeper then blocks the app, and the `glosa` command line inside it, until the person allows it.
That happens after the first install and again after every upgrade. There are two ways to allow it:

```sh
xattr -dr com.apple.quarantine /Applications/glosa.app
```

Or open the app once, then choose Open Anyway in System Settings, Privacy & Security. The command
above also clears the Bun runtime inside the app, which the command line runs on; Open Anyway is
confirmed to unblock the app window, and whether it also clears the nested Bun is not verified.
The cask's caveats and the README say the same.

Homebrew 5.0 disables casks that fail Gatekeeper only in the official `Homebrew/homebrew-cask`
repository, and deprecated the `--no-quarantine` flag everywhere. A personal tap may carry an
ad-hoc signed cask; Homebrew still quarantines what it installs.

A Developer ID removes the prompt: the app is signed and notarized, and the cask drops its
quarantine instructions (the release job passes `--notarized` to `scripts/cask-bump.ts` only
then). Once the secrets exist, set `APP_SIGNING_REQUIRED` in `release.yml` to `"true"`, so that a
tag with a missing secret fails instead of falling back to an ad-hoc build.

## Rehearsing locally

An unsigned build of the current checkout, then its smoke test:

```sh
bun install --cwd packages/shell --frozen-lockfile
bun run --cwd packages/shell package -- --arch arm64 --unsigned --smoke
```

The smoke runs the bundled CLI with no Bun on `PATH`, checks the app's version and signature,
confirms the CLI records its launcher at `~/.glosa/bin/glosa` in a scratch home, and opens a scratch
folder to prove the daemon it starts runs on the bundled Bun.

## Checking a shipped release

Download the DMG or zip for your architecture and `SHA256SUMS` from the release, then:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
spctl --assess --type execute -vv /Applications/glosa.app
xcrun stapler validate /Applications/glosa.app
```

For a notarized build, `spctl` should report `source=Notarized Developer ID`, and `stapler` should
report that the validate action worked. An ad-hoc build is expected to fail both: `spctl` reports
`rejected` and there is no ticket to staple. Its checksum is what you verify.

## When notarization fails

The build log names the submission id. Read Apple's report for it:

```sh
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

The usual causes are a binary without the hardened runtime or a missing entitlement. The app signs
with `packages/shell/assets/entitlements.mac.plist`: `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` (Electron's V8 and Bun's JavaScriptCore
both compile code at run time) and `com.apple.security.device.audio-input` (dictation). If the
bundled Bun is killed at launch under the hardened runtime, the next candidate is
`com.apple.security.cs.disable-executable-page-protection`. Record what the first signed build
needed here.

## Homebrew tap

glosa ships through the maintainer's tap repository,
[`davebream/homebrew-tap`](https://github.com/davebream/homebrew-tap), which also holds other
formulae; the bump script touches only glosa's two files:

| File | What it installs | Command |
|---|---|---|
| `Casks/glosa.rb` | The desktop app, with the command line inside it | `brew install --cask davebream/tap/glosa` |
| `Formula/glosa.rb` | The command line only, on Homebrew's Bun | `brew install davebream/tap/glosa` |

Install one or the other. Both link `glosa` into Homebrew's bin, so the second fails to link, and
Homebrew has no way for a cask to declare a conflict with a formula (its cask `conflicts_with`
accepts only other casks). Both files' caveats say so.

### The formula

The formula installs the published npm tarball: `bun add --global` into the keg, with Homebrew's
Bun. The CLI starts with `#!/usr/bin/env bun`, so `bin/glosa` is a small wrapper that puts
Homebrew's Bun first on `PATH`; without it, a bare `PATH` such as a Dock launch fails with
`env: bun: No such file or directory`. Its digest is the npm tarball's sha256. `glosa update`
refuses a formula install and answers with `brew upgrade glosa` (#379), because writing into the
keg would put it out of step with what brew recorded.

This shape was verified on 2026-09-26 by installing it from a throwaway tap: `brew test` passed,
`glosa --version` answered with `PATH=/usr/bin:/bin`, and `glosa open` started a daemon on the
keg's Bun.

### The cask

The tap carries the ad-hoc signed app until a Developer ID exists (see "Ad hoc or notarized"),
with caveats that tell people how to allow it. A notarized release renders the cask without them.

What the cask does on a person's machine:

- It installs `glosa.app` and links the CLI inside it,
  `glosa.app/Contents/Resources/bin/glosa`, into Homebrew's bin. That CLI runs on the Bun runtime
  the app carries, so the machine needs no separate Bun.
- It never writes into an agent's configuration. The Claude Code plugin is installed the same way
  as for any other install.
- Its `zap` stanza removes only the app's own Electron folders under `~/Library` for
  `dev.glosa.app`. It never removes `~/.glosa`, which holds journals, version history and the
  pairing token.

### Bumping the tap automatically

The release workflow's `app` job runs `scripts/cask-bump.ts` after uploading the DMGs and
`SHA256SUMS` to the GitHub release. The script reads both DMG digests from `SHA256SUMS`, downloads
the npm tarball and hashes it (retrying while the registry catches up with a fresh publish),
renders `Casks/glosa.rb` and `Formula/glosa.rb`, and commits both to the tap's default branch.
Re-running for a version the tap already carries changes nothing.

It needs one repository secret, `HOMEBREW_TAP_DEPLOY_KEY`: the private half of an SSH deploy key
whose public half is registered on `davebream/homebrew-tap` with write access. A deploy key reaches
that one repository and nothing else, and does not expire. It can push but cannot open pull requests,
which is why the bump is a direct commit. The script pins GitHub's SSH host key and refuses any other.
Without the secret the release job leaves a warning asking for a manual bump.

To replace the key:

```sh
ssh-keygen -q -t ed25519 -N "" -C "glosa release job to homebrew-tap" -f tapkey
gh repo deploy-key add tapkey.pub --repo davebream/homebrew-tap --allow-write --title "glosa release job"
gh secret set HOMEBREW_TAP_DEPLOY_KEY --repo davebream/glosa < tapkey
rm tapkey tapkey.pub
```

Then delete the old key under the tap's Settings, Deploy keys.

### Bumping the tap by hand

From a checkout of the tap:

```sh
bun run /path/to/glosa/scripts/cask-bump.ts --version 0.1.0-alpha.32 --dry-run > Casks/glosa.rb
bun run /path/to/glosa/scripts/cask-bump.ts --version 0.1.0-alpha.32 --dry-run --formula > Formula/glosa.rb
brew audit --cask --online Casks/glosa.rb
brew audit --online Formula/glosa.rb
git switch -c glosa-0.1.0-alpha.32
git add Casks/glosa.rb Formula/glosa.rb
git commit -m "glosa 0.1.0-alpha.32"
git push -u origin glosa-0.1.0-alpha.32
gh pr create --fill
```

For the cask, `--dry-run` downloads `SHA256SUMS` from the GitHub release unless you pass
`--sums <path>`, and fails by name if either DMG digest is missing. For the formula, it downloads
the npm tarball unless you pass `--npm-tarball <path>`. `brew audit` needs both files inside a tap,
which a checkout of the tap already is. Add `--notarized` to the cask command only for a build
signed with a Developer ID.
