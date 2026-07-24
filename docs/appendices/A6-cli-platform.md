# glosa v1 — CLI / install / packaging / terminology spec (F26, F30, F31, F32)

## F26 — `--json` envelope + exit codes
- Every subcommand accepts `--json` → exactly one JSON object on stdout: `{glosa_json:1, ok, command, exit_code, data, warnings:[{code,message}], error:{code,kind,message,hint}|null}`. Human mode = prose stdout + diagnostics stderr. Non-TTY does NOT auto-enable --json (explicit flag only).
- Stable exit codes (append-only, `1` reserved/never emitted): 0 ok · 2 usage · 3 daemon_unreachable · 4 not_a_workspace · 5 platform_unsupported · 6 foreign_config_conflict · 7 review_timeout · 8 entry_error · 9 degraded · 10 protocol_mismatch · 11 restore_conflict · 12 lease_conflict · 70 internal.

## F26 — `glosa init` merge/ownership/uninstall
- Touches only `<ws>/.claude/settings.json` (Claude hooks), `<ws>/.mcp.json` (Claude MCP),
  `<ws>/.codex/hooks.json` (Codex hooks), `<ws>/.codex/config.toml` (Codex MCP), and
  `<ws>/.claude/.glosa-init.json` (glosa's authoritative ownership manifest).
- Ownership dual mechanism (JSON has no comments): manifest records per-file `{path, created, backup, inserted:[{pointer, sha256}]}`; in-band signature fallback = hook commands begin literal `glosa hook ` and MCP key literally `glosa`. Never inject marker keys into Claude schemas.
- GLOSA_BIN resolution (recorded in manifest): persist the current process's absolute Bun executable plus `run --silent <glosaRoot>/packages/cli/src/main.ts`. Pinning both the runtime and entrypoint keeps hooks working when Claude Code supplies a narrower PATH than the launching shell and avoids relying on the installed script's `#!/usr/bin/env bun` lookup. The same form supports the published package and maintainers running a checkout. Stored so uninstall matches + doctor detects drift. `npx`/`bunx` are one-shot launchers, not persisted hook commands: users running `init` need a durable global or project-local installation, and an obvious package-cache invocation is rejected before any configuration write. `glosa --build-id` prints only the identity and exits without starting a daemon; `glosa --version` remains the root package version.
- Hook entries written: SessionStart (matcher `startup|resume|clear|compact`) → `glosa hook session-start` (timeout 10) + `glosa hook rewake-watch` (`asyncRewake:true`, default command-hook timeout); SessionEnd → `glosa hook session-end` (timeout 5); UserPromptSubmit → `glosa hook user-prompt-submit` (10); Stop → `glosa hook stop` (10); Notification → `glosa hook notification` (5). Roles: session-start registers {session_id,cwd,transcript_path,source} + drains parked; rewake-watch = rung-2 (rearmed by stop hook via per-session lease, since asyncRewake is one-shot); user-prompt-submit = rung-3 additionalContext; stop = rung-3 drain (≤8) + rewake rearm; session-end releases lease; notification = hook-fed attention state (preferred over transcript permission heuristic). Omitting `timeout` is deliberate: Claude Code 2.1.217 rejects an explicit zero despite its schema diagnostic, while the documented default is ten minutes.
- MCP entry: `{mcpServers:{glosa:{type:"stdio", command:"glosa", args:["mcp"]}}}` (GLOSA_BIN form).
- Retrieval command: `glosa inbox get <id> [--cursor <opaque>] [--workspace <path>]`; it is read-only
  and returns the same bounded presentation pages as MCP `glosa_inbox_get`. Metadata and explicit
  binding are exposed by `glosa metadata set|show|clear`, `glosa session bind`, and the equivalent MCP
  tools. The stdio shim is a client of the singleton daemon and acknowledges MCP presentation only
  after its response write.
- Codex project integration uses owned entries in `.codex/hooks.json` for SessionStart, SessionEnd,
  UserPromptSubmit, and Stop plus an owned `[mcp_servers.glosa]` block in `.codex/config.toml`.
  Installation participates in the same backup/rollback/foreign-entry rules as Claude configuration.
- Optional Channel command printed (F06 LOCKED): `claude --dangerously-load-development-channels server:glosa` — NEVER `--channels`. MCP consent or organization policy may block it; hook/MCP fallback is the required compatibility path and doctor must not treat unavailable Channels as a failure.
- Merge algo (transactional, per file, order settings→mcp→manifest): parse (absent→create; invalid JSON→abort exit6 touch nothing); backup `<file>.glosa-backup-<UTC-ISO>` (skip if identical to newest; retain 5); idempotent inserts by identity (hook = exact command string; MCP = key glosa; foreign non-glosa siblings untouched; foreign glosa-key differs & not-owned→exit6 unless --force); atomic temp+fsync+rename preserving indent; update manifest. Second init unchanged → no backup, exit0 data.changed:false. Mid-run failure → restore this-run backups, exit nonzero (no half-install).
- Flags: `--print/--dry-run` (unified-diff, no write), `--force`, `--uninstall`, `--restore-backup`, `--json`.
- Uninstall: per recorded node, re-hash current node vs recorded — match→remove + prune empty parents; mismatch (externally edited)→leave + warn + exit9. created:true file now empty→delete. Atomic per file; backups retained; manifest deleted on clean removal. Reminder to relaunch Claude without the dev flag.

## F24/F26 — `glosa token` rotation and revocation

- `glosa token rotate [--json]` writes a fresh 128-bit mode-0600 token through A3's atomic
  temp→fsync→rename commit. It invalidates the previous API token, all class-F capabilities, and
  credential-bound streams with no grace period. It works whether the daemon is running or stopped.
- `glosa token revoke [--json]` removes the active token (idempotent when already absent), invalidates
  all browser/API credentials, and leaves glosa unpaired. `glosa open` creates a new token when needed
  and is the only documented re-pairing path.
- Successful human output is stable and contains no credential material:
  - rotate: `glosa token: rotated; all existing credentials are invalid` then
    ``Run `glosa open` to re-pair.`` on the next line.
  - revoke: `glosa token: revoked; all existing credentials are invalid` then the same re-pair line.
    An already-revoked repeat inserts ` (already revoked)` after `revoked`.
- Successful `--json` output uses the normal F26 envelope. Rotate data is
  `{state:"active",invalidated:"all",re_pair_command:"glosa open"}`. Revoke data is
  `{state:"revoked",invalidated:"all",already_revoked:<bool>,re_pair_command:"glosa open"}`.
  Neither output surface may contain the token, its digest, or its filesystem contents.
- Exit codes: `0` success (including repeated revoke); `2` missing/unknown action; `70` filesystem
  mutation failure. Exit 70 uses `token-rotate-failed` or `token-revoke-failed` and means the prior
  durable token state was preserved. The command does not emit `3`: it is a local credential-state
  operation and does not require a live daemon.

## F33 — `glosa update` self-update

- **The one documented exception to invariant 5's "zero external runtime calls".** The daemon and SPA
  runtime still make no outbound requests at all. `glosa update` is **explicitly invoked only** —
  never a background or passive check, never a startup probe — and sends no identifying data: a
  static `User-Agent` of `glosa-update`, no version beacon, and no cache file that could become a
  heartbeat. **`glosa update` never prompts**; the absence of a confirmation is a CI-safety contract.
- **Environment resilience is the point.** The release is resolved with a plain HTTPS `fetch` that
  reads no npm or bun configuration, so a scope mapping such as
  `@davebream:registry=https://npm.pkg.github.com` cannot redirect it. A scope mapping outranks the
  `--registry` flag, and bun has no scoped-registry flag at all, which is why name-based resolution
  through a package manager is not used.
- **Install detection.** `bun-global` (`…/install/global/node_modules/@davebream/glosa`, pinned with
  `BUN_INSTALL_GLOBAL_DIR`) and `npm-global` (`…/lib/node_modules/@davebream/glosa`, pinned with
  `--prefix=`) are upgradeable. `ephemeral`, `source-checkout`, `project-local`, `volta`, `pnpm`,
  `yarn`, and `unknown` are refused at exit 2 with an exact copy-pasteable manual command in
  `data.manual_command`. Volta is matched **before** the `/lib/node_modules/` marker: its layout
  matches, but writing there bypasses the shim, so a naive classification would report success while
  `glosa --version` still printed the old version. A `.git` marker at the package root beats every
  other signal.
- **Integrity.** glosa downloads the tarball itself into a mode-0700 temp directory, hashes it with
  sha512, and compares against the `dist.integrity` digest from the packument before handing the
  installer a local absolute path. A missing or non-sha512 digest is a **refusal**, never a pass.
  Honest limits, which this spec states rather than papers over: the digest is trusted from the
  packument response *including any redirects that response followed*, and glosa does not verify npm
  provenance attestations or `dist.signatures`. This defends against a redirected or misconfigured
  registry and against corruption in transit — **not** against a registry compromised at the point of
  publication, where the digest and the bytes would both come from the attacker.
- **Tarball origin pinning.** The resolved `dist.tarball` must share hostname and effective port with
  the **configured** registry (not the response URL, so a cross-origin redirect cannot move the
  target), and its path must match `/@davebream/glosa/-/glosa-<resolved-version>.tgz`. Comparison is
  via the URL parser, never string containment. `--allow-offsite-tarball` overrides the origin check
  for a mirror that legitimately rewrites tarball URLs; it widens *where*, never *how* (https stays
  mandatory), it is **never** readable from the environment, and it is refused at exit 2 unless an
  explicit non-default registry is also configured.
- **bun requires a remove-then-add sequence; npm does not.** `bun add --global <tarball>` fails with
  `error: An internal error occurred (DependencyLoop)` whenever the package is already installed
  globally under a different recorded resolution, and it silently leaves the old version in place.
  Measured against bun 1.2.7, and it reproduces identically with an absolute tarball **URL**, so it
  is not a consequence of installing from a verified local file — every non-registry spec hits it.
  `glosa update` therefore runs `bun remove --global @davebream/glosa` first and ignores that step's
  exit code ("it was not installed" is a fine state to proceed from). The cost is a window in which
  glosa is uninstalled, which is why the recovery command is printed and flushed before any of it
  runs, and why the human pre-spawn block says so explicitly. `npm install --global --prefix=<p>
  <tarball>` upgrades in place and needs no pre-step.
- **Verification executes the truth.** After a successful install glosa spawns `glosa --version` and
  compares the parsed version to the target. This deliberately replaces reading
  `<packageRoot>/package.json`, which would prove *a directory* changed rather than that the user's
  `glosa` changed, and which reads a stale path under Volta or any content-addressed store. Note
  `Bun.which` cannot see shell aliases or functions by construction, so the resolved binary path is
  printed rather than pretending otherwise.
- **Flags and environment.** `--registry` > `GLOSA_UPDATE_REGISTRY` > `https://registry.npmjs.org`,
  mirroring the `--port`/`GLOSA_PORT` precedence. There is deliberately **no `GLOSA_UPDATE_CHANNEL`**:
  a registry is a machine property, but a channel is per-invocation intent, and an env-pinned channel
  would silently change what a bare `glosa update` installs. `--to` and `--channel` are mutually
  exclusive. `--check --force` is legal and means "show me what `--force` would install".
- **`--check` never exits non-zero when an update is available.** Availability lives in
  `data.update_available` and `data.action`. This sentence is normative: without it someone will
  later "improve" the command into a non-zero exit and silently break the append-only exit contract.
- **`data` carries the same key set in every mode and every terminal state**: `action`
  (`updated|already-current|checked|downgrade-refused|refused`), `update_available`,
  `current_version`, `target_version`, `latest_version`, `comparison`, `channel`, `channel_source`,
  `install_kind`, `install_dir`, `registry`, `tarball_url`, `integrity_verified`, `dry_run`,
  `would_install`, `daemon_running`, `daemon_pid`, `installer_exit_code`, `probe`, `manual_command`.
  `install_kind` is `null` — never a fabricated `"unknown"` — on envelopes that return before
  classification, because `"unknown"` is a real result meaning "we looked and did not recognize this
  layout". Machine-readable warning codes: `daemon-restart-required`, `newer-stable-available`,
  `reshim-required`, `downgrade-refused`.
- **`--json` output.** Exactly one JSON object on stdout (§F26). Installer stdout and stderr are
  forwarded to **stderr** as they arrive, line-buffered and redacted per A3 §61 — npm echoes the
  effective registry URL, which frequently carries `//host/:_authToken` or basic-auth userinfo, and a
  regex over a raw chunk would let a credential split across two chunks through. Only
  `installer_exit_code` enters `data`. `--check --quiet` prints only the target version (empty when
  already current), reusing the plain-output convention `open --url` sets.
- **Running daemon.** `update` reads the daemon lock and gates it on `isPidAlive` — a lock file alone
  is not liveness, and a stale pid would otherwise produce a `kill <pid>` naming a recycled process.
  It never calls `ensureDaemon`, which would *start* a daemon as a side effect of asking whether one
  runs. A live daemon yields `data.daemon_running`, `data.daemon_pid`, and a
  `daemon-restart-required` warning naming `glosa open`; normal upgrades self-heal because
  `decideDaemonBuild` restarts an older or same-version-different-hash daemon. **The forced-downgrade
  case is the wedge:** a newer daemon is never downgraded by design (§F30, exit 10) and there is no
  `glosa stop`, so `update` prints the pid and the `kill` command in the pre-spawn block. There is a
  narrow window during the package-directory swap in which an in-flight `glosa hook …` child can
  fail.
- **Recovery output precedes the spawn.** The versions, install kind, install dir, tarball URL, exact
  recovery command, and any daemon pid line are written and flushed **before** the installer starts,
  because a failure partway through ~115 transitive dependencies can leave the user with no working
  `glosa` *and* no working `glosa update`.
- Exit codes reuse §F26's stable set — **no new codes** — with `error.code` as the discriminator, the
  same pattern this appendix already uses for `token`'s two distinct exit-70 failures. `0` updated /
  already current / `--check` / downgrade-refused. `2` usage, `update-unmanaged-install` (matching the
  `durable-install-required` precedent in `glosa init`), `update-unknown-channel`,
  `update-unknown-version`, `update-invalid-registry`, `update-suspicious-flag-combo`. `5` non-Darwin.
  `9` `update-unverified` (the probe reported a different version) or `update-unverified-probe-failed`
  (the probe produced no usable version — these are distinct so glosa never describes a mismatch it
  did not observe). `70` `registry-unreachable`, `registry-http-error`, `registry-malformed-response`,
  `registry-inconsistent`, `update-offsite-tarball-refused`, `tarball-download-failed`,
  `tarball-integrity-mismatch`, `installer-not-found`, `installer-permission-denied`,
  `installer-failed`. Exit `3` is never emitted: it means *glosa's own daemon* is unreachable, which
  has nothing to do with a registry. Exit 70 does **not** imply `kind:"internal"` — a disconnected
  laptop is `network`, an EACCES is `permission`, a missing package manager is `environment`.

## F30 — platform
- **macOS-only v1** (Apple Silicon + Intel); Linux/Windows out of scope (non-Darwin → exit5). Pinned floors: macOS 13 (Ventura), Bun 1.2.7, Git 2.30, Claude Code 2.1.80 (channel floor; asyncRewake works from 2.1.0 but the channel push needs 2.1.80; rec ≥2.1.200), browser Chromium≥111/Safari≥16.4. (No cmux — glosa is cmux-decoupled; the SPA runs in any browser over localhost.)
- API `protocol_version` describes wire compatibility (same major and supported minor); content-derived `build_id` identifies the exact runtime source plus root package semver. Compatibility permits an older client to reuse a newer daemon, but identity policy can still refresh an older or same-semver-different daemon. An incompatible newer daemon is never downgraded (exit10).
- "No build step / zero native deps" = no bundle/transpile (`bun run` direct, no dist/) AND no native addons (no node-gyp/C/Rust/.node/postinstall-compile). Does NOT mean zero prerequisites: Bun, system git (child process, not a module), and a browser are required host software validated by doctor.

## F31 — checkpoint query & restore (USER CHOSE FULL/3.B — history: compare + restore)
- `glosa checkpoints <path> [--since <when>] [--limit N] [--json]` — list; `<when>` = yesterday|today|ISO|<checkpoint-id>; day-boundary words resolve in HOST LOCAL TZ, ISO honors offset. Rows `{checkpoint_id, at, by:human|session:<id>|unknown, summary, bytes_changed, origin:workspace|lineage, lineage_id?}`. A directory adopted from loose files lists imported lineage commits alongside its active history.
- `glosa diff <path> [--from <cp>] [--to <cp|working>] [--json]` — unified diff any two checkpoints or checkpoint↔working; defaults from baseline to working.
- `glosa restore <path> --to <checkpoint-id> [--force] [--json]` — restore artifact bytes into working tree; refuses if dirty vs latest checkpoint unless --force (prints would-be-lost diff); records restore as NEW by:human checkpoint (append-only, never rewrites history); dirty refusal = exit11. For a lineage checkpoint, the daemon resolves the recorded source→target artifact mapping before reading the imported Git object.
- APIs (authed, path-confined): `GET /w/<slug>/checkpoints`, `GET /w/<slug>/diff` (from/to), `POST /w/<slug>/restore` {path,to,force}. Diff pane bases must name exactly what the API supports.
- Acceptance: DST day-boundary tests, dirty-worktree refusal, restore-creates-checkpoint, restore-then-diff-clean.

## F32 — terminology fixes
- "renders verbatim" → **"source-preserving (bridge-augmented)"**: daemon serves the doc's own HTML/CSS/JS unmodified except a single namespaced glosa bridge (`<script>`+scoped `<style>`) appended before `</body>`; preserved subject to class-F sandbox+CSP (F03); injects only the bridge, never rewrites content.
- "byte-identical visual regression" → **"rendered-output regression within tolerance"**: compare rendered region (screenshot/DOM snapshot) vs reference within tolerance, bridge overlay excluded; asserts rendering equivalence, not byte identity.
- "read-only mirror + composer" → **"read-only transcript view with out-of-band message composer"**: read-only render of transcript JSONL, never writes it; composer sends a new user message to the live terminal session out-of-band via the delivery ladder (injects into running session, does NOT append/edit the transcript file).

## Full command surface (global flags: --json --quiet --verbose --port/GLOSA_PORT --help --version --build-id)
| cmd | args | does | exit |
|---|---|---|---|
| `open` | `[target] [focus] [--document\|--workspace] [--preview] [--bind <session-id>] [--url]` | ensure daemon + register target + optional session bind; open browser by default or print URL with `--url`. File → document surface; dir → workspace surface; explicit surface flags override inference. Directory opens select the first normalized tracked artifact; `--document` requires one. `--preview` locks Preview (UI affordance, not authorization). | 0;2;3;5 |
| `init` | `[dir]` `--print/--force/--uninstall/--restore-backup` | §F26 merge/uninstall | 0;2;6;9;5 |
| `update` | `[--check\|--dry-run] [--force] [--channel <tag>] [--to <version>] [--registry <url>] [--allow-offsite-tarball]` | §F33 self-update: resolve the release over a config-independent HTTPS request, verify the tarball against the registry's published sha512, install through the detected package manager, then verify by probing the installed binary | 0;2;5;9;70 |
| `resolve` | `<id> <applied\|rejected\|deferred\|stale> --session <sid> [--note]` | lifecycle transition (journal append) + close apply-begin lease (post-checkpoint); deferred = re-surface, not terminal | 0;3;8;2 |
| `apply-begin` | `<id> --session <sid>` | F05 lease: pre-checkpoint + attribution lease; prints lease token | 0;3;8;12;2 |
| `request-review` | `<path> [--message] [--action] [--require-approval] [--wait <dur>]` | create attention_request; approval mode binds final approval to the saved artifact revision; --wait blocks to resolution | 0(verdict in data);7 timeout;8 approval conflict;3;4;2 |
| `metadata` | `set <descriptor.json>\|show\|clear [--workspace <path>]` | register/read/clear durable workspace metadata v1 | 0;2;3;4;8 |
| `session` | `bind <session-id> [--workspace <path>]` | explicitly bind a registered session to the artifact workspace | 0;2;3;4;8 |
| `token` | `rotate\|revoke` | atomically rotate or revoke the local pairing credential; never prints token material | 0;2;70 |
| `doctor` | `[dir] --json` | 13 enumerated checks | 0(warns ok);9 any FAIL;5 |
| `status` | `[dir] --json` | daemon+workspaces+sessions+pending; never fails on daemon-down (state in data) | 0;70 |
| `mcp` | internal | stdio MCP (rung-1 channel + tools) | — |
| `hook <event>` | internal | CC hook entry point | per hook |
| `complete <bash\|zsh\|fish\|powershell>` | shell utility | generate the selected shell's completion script on stdout | 0;2 |
- `open` auto-creates `.glosa/` scaffold — distinct from `init` (installs CC hook/MCP integration). A workspace can be opened+annotated WITHOUT init (SPA-only, no agent delivery).
- `open --url` performs the same token, daemon, registration, optional file deep-link, surface/mode,
  and bind work without invoking the macOS browser launcher. Plain success output is exactly the URL
  plus a newline; `--json` retains the F26 envelope with
  `data:{slug,path,url,focus?,surface,mode,preview,bound_session?,state_dir?}`.
- `--bind` after successful registration is nonfatal on unknown/stale sessions: the URL is still
  returned, a `bind-failed` warning is appended, and the exit code stays 0. `--preview --bind`
  additionally emits `preview-bind-conflict` (feedback controls hidden while wiring feedback routing)
  but is not hard-blocked.
- Preview lock is an **affordance expressing intent ("not for review")**, not access control: the
  annotation API continues to accept authenticated POSTs for the artifact.
- doctor 12 checks: platform, bun, git, claude-code(WARN if absent), browser, daemon+proto, token/pairing(0600), workspace(.glosa+baseline+matcher non-empty), hooks(manifest hash match/drift), mcp, optional Channel status (SKIP when unverifiable), transcript-root(under allowed CLAUDE_CONFIG_DIR).

## Metadata and binding output

- Every command uses the stable F26 envelope in JSON mode and concise deterministic prose otherwise.
- `metadata show` returns only the descriptor; set/clear results contain no token or canonical path.
- `metadata set` validates local JSON syntax before contacting the daemon. Daemon validation remains
  authoritative and failed replacement never clears the prior descriptor.
- Same-id set and repeated clear are idempotent. A different active id is an explicit conflict.
- MCP parity tools are `glosa_inbox_pull`, `glosa_inbox_get`, `glosa_metadata_set`,
  `glosa_metadata_show`, `glosa_metadata_clear`, `glosa_session_bind`, `glosa_conversation_ack`, and
  `glosa_present`; their arguments and returned data match the CLI/API contract.
- `glosa_present {path, mode, session_id?}` registers an absolute existing file, returns a ready URL
  with a short-TTL single-use presentation token (`p=`), never launches a browser, and never returns
  the durable pairing token. Annotations: mutating, non-destructive, idempotent, closed-world.
  `mode:"preview"` is preview-locked; `annotate`/`edit` select an unlocked initial mode.

### Shell completion setup

`complete` is a fixed text/protocol utility, not one of the seven domain commands covered by the
F26 JSON envelope. Install the generated script once for the user's shell:

```bash
# Bash
mkdir -p ~/.local/share/bash-completion/completions
glosa complete bash > ~/.local/share/bash-completion/completions/glosa

# Zsh
mkdir -p ~/.zsh/completions
glosa complete zsh > ~/.zsh/completions/_glosa
# Add `fpath=(~/.zsh/completions $fpath)` and `autoload -Uz compinit && compinit` to ~/.zshrc.

# Fish
mkdir -p ~/.config/fish/completions
glosa complete fish > ~/.config/fish/completions/glosa.fish
```

```powershell
# PowerShell: add the generated registration script to the current user's profile.
glosa complete powershell >> $PROFILE
```
