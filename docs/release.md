# Releasing glosa

How a release reaches people. This page grows with #371; today it covers the Homebrew cask.

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
