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

## F30 — platform
- **macOS-only v1** (Apple Silicon + Intel); Linux/Windows out of scope (non-Darwin → exit5). Pinned floors: macOS 13 (Ventura), Bun 1.2.7, Git 2.30, Claude Code 2.1.80 (channel floor; asyncRewake works from 2.1.0 but the channel push needs 2.1.80; rec ≥2.1.200), browser Chromium≥111/Safari≥16.4. (No cmux — glosa is cmux-decoupled; the SPA runs in any browser over localhost.)
- API `protocol_version` describes wire compatibility (same major and supported minor); content-derived `build_id` identifies the exact runtime source plus root package semver. Compatibility permits an older client to reuse a newer daemon, but identity policy can still refresh an older or same-semver-different daemon. An incompatible newer daemon is never downgraded (exit10).
- "No build step / zero native deps" = no bundle/transpile (`bun run` direct, no dist/) AND no native addons (no node-gyp/C/Rust/.node/postinstall-compile). Does NOT mean zero prerequisites: Bun, system git (child process, not a module), and a browser are required host software validated by doctor.

## F31 — checkpoint query & restore (USER CHOSE FULL/3.B — history: compare + restore)
- `glosa checkpoints <path> [--since <when>] [--limit N] [--json]` — list; `<when>` = yesterday|today|ISO|<checkpoint-id>; day-boundary words resolve in HOST LOCAL TZ, ISO honors offset. Rows `{checkpoint_id, at, by:human|session:<id>|unknown, summary, bytes_changed}`.
- `glosa diff <path> [--from <cp>] [--to <cp|working>] [--json]` — unified diff any two checkpoints or checkpoint↔working; defaults from baseline to working.
- `glosa restore <path> --to <checkpoint-id> [--force] [--json]` — restore artifact bytes into working tree; refuses if dirty vs latest checkpoint unless --force (prints would-be-lost diff); records restore as NEW by:human checkpoint (append-only, never rewrites history); dirty refusal = exit11.
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
| `resolve` | `<id> <applied\|rejected\|deferred\|stale> --session <sid> [--note]` | lifecycle transition (journal append) + close apply-begin lease (post-checkpoint); deferred = re-surface, not terminal | 0;3;8;2 |
| `apply-begin` | `<id> --session <sid>` | F05 lease: pre-checkpoint + attribution lease; prints lease token | 0;3;8;12;2 |
| `request-review` | `<path> [--message] [--action] [--wait <dur>]` | create attention_request; --wait blocks to resolution | 0(verdict in data);7 timeout;3;4;2 |
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
