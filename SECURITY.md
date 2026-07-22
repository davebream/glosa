# Security Policy

## Supported versions

Security fixes are provided on a best-effort basis for the latest published `0.1.x` prerelease. Earlier alpha builds are unsupported.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/davebream/glosa/security/advisories/new). Do not open a public issue or include real tokens, manuscripts, transcripts, or other sensitive data in a report.

Include the affected version, macOS and Bun versions, reproduction steps, impact, and any suggested mitigation. You may use synthetic data and redact local paths. The maintainer will coordinate validation, remediation, and disclosure through the private advisory.

## Invalidate a leaked local token

If a glosa browser/API token may have leaked, invalidate it immediately:

```sh
glosa token revoke
```

This invalidates the active Bearer token, open credential-bound streams, and all class-F capability
URLs. Existing tabs return to the unpaired screen. When it is safe to create a replacement, run
`glosa open <directory>` to re-pair.

To replace the token immediately instead, run `glosa token rotate`, then `glosa open <directory>`.
Neither token command prints credential material, including with `--json`. Both commands work while
the daemon is stopped; a filesystem failure leaves the previous token state unchanged and exits 70.
