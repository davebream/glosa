# Releasing glosa

How a release reaches people: what a tag produces, the secrets it needs, how to rehearse it, how to
check a shipped build, and how the Homebrew cask is bumped.

## What a tag produces

Pushing a tag `v<version>` that matches `package.json` runs `.github/workflows/release.yml`:

1. The same test jobs as CI, with the full profile forced, plus the secret and dependency scans.
2. `release`: publishes `@davebream/glosa` to npm with provenance and creates the GitHub release.
3. `app`: builds the desktop app for Apple Silicon (`arm64`) and Intel (`x64`) and smoke-tests it.
   When every signing secret is present, it signs, notarizes and uploads to the GitHub release:
   `glosa-<version>-arm64.dmg`, `glosa-<version>-arm64.zip`, `glosa-<version>-x64.dmg`,
   `glosa-<version>-x64.zip` and `SHA256SUMS`. It then opens the Homebrew tap pull request.
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
| `HOMEBREW_TAP_TOKEN` | Fine-grained token for the tap; see "Homebrew cask" below. |

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

### The signing switch

`release.yml` sets `APP_SIGNING_REQUIRED: "false"` on the `app` job. While it is false and the
secrets are missing, the job still builds and smokes an unsigned app, leaves a warning
("No signing secrets; building an unsigned app for verification only"), keeps the DMGs as run
artifacts for 14 days, and uploads nothing to the release. An unsigned app never reaches a release:
macOS 15.1 and later refuse to open an unsigned download, and Homebrew 5.0 deprecated unsigned casks.

Once the secrets exist, set `APP_SIGNING_REQUIRED` to `"true"`. From then on a tag with missing
secrets fails instead of quietly building an unsigned app.

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

`spctl` should report `source=Notarized Developer ID`, and `stapler` should report that the
validate action worked.

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

## Homebrew cask

The desktop app ships through a Homebrew cask in a separate tap repository,
[`davebream/homebrew-glosa`](https://github.com/davebream/homebrew-glosa), at `Casks/glosa.rb`.
The maintainer creates that repository once, by hand. People install with:

```sh
brew install --cask davebream/glosa/glosa
brew upgrade --cask glosa
```

The cask is a signed and notarized app only. Homebrew 5.0 deprecated casks that fail Gatekeeper
and the `--no-quarantine` flag, so no cask is published for an unsigned build.

What the cask does on a person's machine:

- It installs `glosa.app` and links the CLI inside it,
  `glosa.app/Contents/Resources/bin/glosa`, into Homebrew's bin. That CLI runs on the Bun runtime
  the app carries, so the machine needs no separate Bun.
- It never writes into an agent's configuration. The Claude Code plugin is installed the same way
  as for any other install.
- Its `zap` stanza removes only the app's own Electron folders under `~/Library` for
  `dev.glosa.app`. It never removes `~/.glosa`, which holds journals, version history and the
  pairing token.

### Bumping the cask automatically

Once the release workflow builds the desktop app (the next step of #371), it runs
`scripts/cask-bump.ts` after uploading the DMGs and `SHA256SUMS` to the GitHub release. The script reads both DMG digests from `SHA256SUMS`, renders `Casks/glosa.rb`, pushes a
`glosa-<version>` branch to the tap and opens a pull request there.

It needs one repository secret, `HOMEBREW_TAP_TOKEN`: a fine-grained personal access token scoped to
`davebream/homebrew-glosa` only, with **Contents** and **Pull requests** set to read and write.
Without it the script refuses, and the release job leaves a warning asking for a manual bump.

### Bumping the cask by hand

From a checkout of the tap:

```sh
bun run /path/to/glosa/scripts/cask-bump.ts --version 0.1.0-alpha.32 --dry-run > Casks/glosa.rb
brew audit --cask --online Casks/glosa.rb
git switch -c glosa-0.1.0-alpha.32
git commit -am "glosa 0.1.0-alpha.32"
git push -u origin glosa-0.1.0-alpha.32
gh pr create --fill
```

`--dry-run` downloads `SHA256SUMS` from the GitHub release unless you pass `--sums <path>`, and
fails by name if either DMG digest is missing. `brew audit` needs the cask inside a tap, which a
checkout of the tap already is.
