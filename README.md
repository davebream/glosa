# glosa

glosa is a local-first writing and review workspace for people working with AI coding agents. It runs a local daemon, opens a browser workspace, and integrates with Claude Code and Codex without uploading your documents to a glosa service.

> [!WARNING]
> glosa `0.1.0-alpha.0` is experimental software. Back up important work. The generic T8
> compatibility rehearsal and token rotation/revocation gate are not yet maintainer-approved.

## Requirements

- macOS 13 or newer on Apple silicon or Intel
- [Bun](https://bun.sh/) 1.2.7 or newer
- Git 2.30 or newer
- A modern browser

## Install

```sh
bun add --global @davebream/glosa@alpha
```

The durable install is required for `glosa init`, because its generated agent hooks and MCP
configuration must keep working offline after the current shell exits. `npx @davebream/glosa`
and `bunx @davebream/glosa` are suitable for one-shot commands, but are not persisted by `init`.

Maintainers can run the checkout directly with `bun run packages/cli/src/main.ts`; `init` records
the absolute Bun executable and checkout entrypoint for that build.

Open glosa in the current workspace:

```sh
glosa open
```

To create the optional project configuration first:

```sh
glosa init
glosa open
```

Run `glosa --help` for all commands or `glosa complete --help` for shell completion setup.

External integrations use the public `glosa metadata set` and `glosa session bind` contracts. glosa
does not import their packages or embed their workflow logic.

## Privacy and security

glosa binds its daemon to loopback and keeps workspace state on your Mac. AI-agent integrations may still send content to their own providers under those tools' terms and settings. Do not expose the daemon port or place access tokens in a repository.

If a local bearer token may have leaked, run `glosa token revoke`, then `glosa open <directory>` to
create and pair a replacement. Use `glosa token rotate` when you want to replace it immediately.
Token commands never print credential material.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/davebream/glosa/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).

## Development

```sh
bun install --frozen-lockfile
bun run setup:hooks
bun run typecheck
bun test
bun run audit:licenses
bun run package:check
```

The implementation contract is in `AGENTS.md`; the authoritative requirements are in `docs/requirements.md`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for accepted product direction and the public
[Glosa Roadmap project](https://github.com/users/davebream/projects/5) for live execution status.
The requirements under `docs/` are the normative v1 technical contract, not the current work queue.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The license does not grant rights to project names or trademarks.
