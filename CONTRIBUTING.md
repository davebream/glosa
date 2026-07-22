# Contributing to glosa

glosa is an experimental public alpha. Bug reports, focused fixes, tests, and documentation improvements are welcome.

## Before you start

- Search existing issues and pull requests.
- Use a private security advisory for vulnerabilities; do not disclose them in an issue.
- Keep sensitive manuscripts, transcripts, tokens, and local paths out of reports and fixtures.
- Discuss large behavior or protocol changes in an issue before implementation.

## Development setup

Requirements are macOS 13+, Bun 1.2.7+, and Git 2.30+.

```sh
git clone https://github.com/davebream/glosa.git
cd glosa
bun install --frozen-lockfile
bun run setup:hooks
```

Run the release gates before submitting a change:

```sh
bun run typecheck
bun test
bun run audit:licenses
bun run package:check
```

Tests that use real subprocesses can take longer than unit tests. A behavior change should include focused coverage and preserve the invariants in `AGENTS.md` and `docs/requirements.md`.

## AI-assisted contributions

AI tools are allowed, but they do not reduce the contributor's responsibility for a change.

- Disclose substantial AI assistance in the pull request, naming the tool and the code, tests, or
  documentation it helped produce. Routine completion of a few tokens does not need disclosure.
- Review and understand every submitted change, be able to explain it, and run the same verification
  expected for a human-written contribution.
- Take responsibility for correctness, security, licensing, and maintenance regardless of which tool
  produced the first draft.
- Never expose private manuscripts, transcripts, credentials, tokens, or other sensitive local data to
  an AI tool or include them in a prompt, issue, fixture, commit, or pull request.

Maintainers may close opaque bulk-generated contributions that the author cannot explain or support.

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Add or update tests for changed behavior.
- Update public documentation and `CHANGELOG.md` when appropriate.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects.
- Confirm that no secrets or private document content are included.
- Complete the pull request template's AI-assistance disclosure and responsibility confirmation.

By contributing, you agree that your contributions are licensed under Apache-2.0.
