# glosa v1 — CLI / install / packaging / terminology spec (F26, F30, F31, F32)

## F26 — `--json` envelope + exit codes
- Every subcommand accepts `--json` → exactly one JSON object on stdout: `{glosa_json:1, ok, command, exit_code, data, warnings:[{code,message}], error:{code,kind,message,hint}|null}`. Human mode = prose stdout + diagnostics stderr. Non-TTY does NOT auto-enable --json (explicit flag only).
- Stable exit codes (append-only, `1` reserved/never emitted): 0 ok · 2 usage · 3 daemon_unreachable · 4 not_a_workspace · 5 platform_unsupported · 6 foreign_config_conflict · 7 review_timeout · 8 entry_error · 9 degraded · 10 protocol_mismatch · 11 restore_conflict · 12 lease_conflict · 70 internal.

## F26 — install surface (no `glosa init`, #152)
- **Claude Code** installs through `/plugin marketplace add davebream/glosa` then `/plugin install
  glosa`. The plugin carries the MCP server, the `glosa-connect` skill and one per-session monitor;
  the launcher resolves a local glosa without a `PATH` lookup or download (A2 §F06, A3 §3). Monitor
  availability is session-scoped; MCP pull remains available when Claude suppresses monitors.
- **Codex** installs with `codex mcp add glosa -- glosa mcp`. Push additionally needs a separately
  running app-server control socket (A2 F07 "Codex app-server transport"); glosa never starts it.
- glosa writes **no agent configuration** — no hooks, no `.mcp.json`, no `config.toml` entries, no
  ownership manifest, no backups. `glosa open` creates only the `.glosa/` scaffold. `glosa init`,
  `--print/--force/--uninstall/--restore-backup`, `open --init/--no-init` and the
  `not-initialized`/`init-drifted` warnings do not exist.
- **One-release stub.** `glosa hook <event> [--provider <id>]` stays as a silent exit-0 no-op (reads
  nothing, prints nothing, never discovers a daemon) so a machine still carrying the old
  `settings.json` / `.codex/hooks.json` entries never shows a failing hook on every prompt. It is
  deleted in the release after this one. `doctor`'s `legacy-config` check names every leftover
  glosa entry (`<ws>/.claude/settings*.json`, `$CLAUDE_CONFIG_DIR/settings.json`, `<ws>/.mcp.json`,
  `.codex/hooks.json`, `[mcp_servers.glosa]` in `.codex/config.toml`, and the old
  `init-manifest.json` / `.glosa-init.json` files) so the user can delete them; doctor never edits
  them.
- **Workspace-root resolution (issue #96/#146).** With no `dir` positional, `doctor` resolves the
  cwd to its enclosing git repository — the same rule `glosa open` applies when it resolves an
  unowned file (requirements.md R1) — never the user's home directory or an ancestor of it. An
  explicit `dir` is always honoured literally; if it sits inside a repo without being that repo's
  root, `doctor` reports a `not-repository-root` warning naming the root and proceeds.
- Retrieval command: `glosa inbox get <id> [--cursor <opaque>] [--workspace <path>]`; it is read-only
  and returns the same bounded presentation pages as MCP `glosa_inbox_get`. Metadata and explicit
  binding are exposed by `glosa metadata set|show|clear`, `glosa session bind`, and the equivalent MCP
  tools. The stdio shim is a client of the singleton daemon and acknowledges MCP presentation only
  after its response write.
- `glosa inbox list [--all] [--workspace <path>]` lists an entry's id/kind/status/age/target path from
  the same journal fold, flagging one whose immutable payload has gone missing with `[no payload]`;
  `--all` includes terminal entries. `glosa inbox dismiss <id> [--note] [--workspace <path>]` closes
  an entry `by:"human"` with no `--session` anywhere in its shape — the supported way to reconcile an
  orphaned journal entry (A4 §F04, issue #142) — sharing `resolve`'s entry-error mapping.

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

## F34 — opt-in dictation configuration

- `glosa dictation configure --provider wispr-flow` is macOS- and TTY-gated. Before changing state it
  discloses that microphone audio and up to 256 KiB of visible Glosa plaintext may be sent to Wispr,
  API approval/billing is separate, recording begins only after clicking Dictate, and the result is a
  draft that is never submitted automatically. Declining or using a noninteractive terminal/`--json`
  fails before a credential prompt or write.
- The organization key is entered through the inherited macOS Keychain prompt, never as a command
  argument. Service is `ai.glosa.dictation.wispr-flow`; account and provider client ID are independent
  random UUIDs. Packaged Glosa uses Keychain exclusively. A source checkout may use
  `WISPR_FLOW_API_KEY` only when `GLOSA_WISPR_FLOW_ALLOW_ENV_KEY=1` explicitly enables the development
  override; tests inject a credential reader.
- Durable state is one atomic mode-0600 file in `GLOSA_HOME` containing only schema version, enabled
  state, provider ID, consent version/time, `visible-prose` context policy and 262,144-byte cap,
  client UUID, Keychain account UUID, configuration time, and optional disabled time. A new consent
  version invalidates old configuration rather than silently widening it.
- `glosa dictation status [--json]` reads configuration and Keychain item presence only. It never
  contacts Wispr. `glosa dictation disable [--json]` commits inactive state before attempting to
  remove the Keychain item; removal failure is a warning because egress is already disabled.
- The future Electron shell reuses the daemon-served SPA and browser-direct adapter. It must provide
  macOS microphone usage metadata and surface permission failures, but owns no alternate dictation
  transport.

## F33 — `glosa update` self-update

- **One explicit external action under invariant 5.** `glosa update` is **explicitly invoked only** —
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
  `durable-install-required` precedent in the former `glosa init`), `update-unknown-channel`,
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
- **Build/test toolchain:** Bun 1.4.2, pinned in `package.json`'s `packageManager` and both CI/release workflows (#230). JUnit reporting commands (`test:ci`, `test:acceptance`, `test:docs`, `test:full`, `test:stability`) require Bun >=1.4.2 and refuse older versions before starting a child. This is the verified tooling floor, not a claim about the first upstream fix. Bun 1.2.7 reproduces an isolated 10,000-passing-test reporter abort while the plain run succeeds; 1.4.2 emits a complete report. The reporter's internal error is not inferred from its out-of-memory message. Contributor checks and hooks use the toolchain pin. The application runtime floor below remains unchanged.
- **macOS-only v1** (Apple Silicon + Intel); Linux/Windows out of scope (non-Darwin → exit5). Pinned floors: macOS 13 (Ventura), Bun 1.2.7, Git 2.30, Claude Code 2.1.80 (plugin floor; rec ≥2.1.200), browser Chromium≥111/Safari≥16.4. (No cmux — glosa is cmux-decoupled; the SPA runs in any browser over localhost.)
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
| `open` | `[target] [focus] [--document\|--workspace] [--preview] [--bind <session-id>] [--url]` | ensure daemon + register target + optional session bind; open browser by default or print URL with `--url`. File → document surface; dir → workspace surface; explicit surface flags override inference. An unowned tracked file inside a git repository registers the repo root as a directory workspace, not a loose file over its containing directory (issue #96) — never the user's home directory or an ancestor of it (issue #146: falls through to the bounded loose-file path instead), and an already-registered `directory` workspace naming home or an ancestor is never silently reused for a new file lookup either, surfaced by slug with remediation instead. An explicitly named file excluded by an existing parent workspace opens as a bounded loose document without entering the parent's file list; a directory's explicit focus remains strict. Directory opens select the first normalized tracked artifact; `--document` requires one. `--preview` locks Preview (UI affordance, not authorization). Never writes agent configuration and emits no init/wiring warning (#152). | 0;2;3;5 |
| `update` | `[--check\|--dry-run] [--force] [--channel <tag>] [--to <version>] [--registry <url>] [--allow-offsite-tarball]` | §F33 self-update: resolve the release over a config-independent HTTPS request, verify the tarball against the registry's published sha512, install through the detected package manager, then verify by probing the installed binary | 0;2;5;9;70 |
| `resolve` | `<id> <applied\|rejected\|deferred\|stale> --session <sid> [--note] [--workspace <path>]` | lifecycle transition (journal append) + close the session's claim (post-checkpoint of the claimed paths); a repeat of the session's own completed resolve replays without appending; another session's resolve is told who closed it or who holds it (issue #155); deferred = re-surface, not terminal. `--workspace` defaults to the cwd; an entry id names one workspace already, so an agent working elsewhere names it rather than being silently scoped to whatever directory it stands in | 0;3;8;2 |
| `apply-begin` | `<id> --session <sid> [--workspace <path>]` | F05: exclusive claim on the entry (pre-checkpoint of its paths); prints the claim id as the lease token; the same session again renews; another session holding the paths → exit 12 naming the holder. `--workspace` as for `resolve` | 0;3;8;12;2 |
| `claim` | `<entry:<id>\|artifact:<path>…> --session <sid> [--mode exclusive\|presence] [--workspace <path>]` | issue #155: claim resources so other sessions see who is working on them; prints the claim id; exclusive claims are disjoint over files between sessions, presence claims block nobody | 0;2;3;8;12 |
| `release` | `<claim_id> --session <sid> [--workspace <path>]` | issue #155: give up a claim this session holds without resolving; an already-ended claim is reported, not an error | 0;2;3;8;12 |
| `request-review` | `<path> [--message] [--action] [--require-approval] [--wait <dur>]` | create attention_request; approval mode binds final approval to the saved artifact revision; --wait blocks to resolution | 0(verdict in data);7 timeout;8 approval conflict;3;4;2;70 |
| `inbox` | `list [--all] [--workspace <path>]` \| `get <id> [--cursor <opaque>] [--workspace <path>]` \| `dismiss <id> [--note] [--workspace <path>]` | list/retrieve/close entries from the journal fold (issue #142); list flags a payload-missing row `[no payload]`; get is read-only and returns the same bounded presentation as MCP `glosa_inbox_get`; dismiss transitions `by:"human"`, no `--session`, first-terminal-wins, and releases any claim on the entry (the human wins); list shows who holds each entry | list 0;2;3;70 — get 0;2;3;8 — dismiss 0;2;3;8 |
| `metadata` | `set <descriptor.json>\|show\|clear [--workspace <path>]` | register/read/clear durable workspace metadata v1 | 0;2;3;4;8 |
| `session` | `bind <session-id> [--workspace <path>] [--provider <id>]` | register or refresh a session and explicitly bind it to the artifact workspace; provider-owned environment discovery supplies identity, with generic MCP fallback when unavailable | 0;2;3;4;8 |
| `token` | `rotate\|revoke` | atomically rotate or revoke the local pairing credential; never prints token material | 0;2;70 |
| `dictation` | `configure --provider wispr-flow\|status\|disable` | disclose and configure a Keychain-backed provider, report local availability without a provider call, or disable egress before credential removal | 0;2;5;70 |
| `forget` | `<workspace> [--yes]` | issue #156: the one supported whole-bus deletion primitive, addressed by slug (see `status --json`), never a path — a workspace's on-disk path may already be gone. Naming a historical loose-file source sealed into a directory workspace resolves to the owning target and forgets the complete unit, never just the source. Removes the registration, journal, inbox, and shadow-git history, including any historical loose-file source sealed into it by adoption; never touches work-tree files. Refuses before any deletion when a live bound session, a live claim (named with its holder), or an in-progress adoption exists, naming each blocker (adoption AND new session register/bind on the same target refuse symmetrically while a forget is committing — one shared per-workspace lock). Interactive use previews the exact paths first and asks once; `--yes` skips the prompt; a non-interactive caller (no TTY, or `--json`) without `--yes` is a usage error. Confinement is proven for every member of the deletion set before a durable marker is written or a single file is touched. `glosa doctor`/`glosa status` name an interrupted run explicitly with its exact resume command, even once the workspace's own directory is gone; re-running `forget` on the same slug (or a since-forgotten source's own slug) finishes it and still reports the complete original set of removed paths | 0;2;3;4;12;70 |
| `doctor` | `[dir] --json [--workspace <registered-slug>] [--repair-baseline]` | 17 enumerated checks, incl. live artifact-update state (#219), the resolved workspace root (#146), and leftover `glosa init` config (#152) | 0(warns ok);9 any FAIL;5 |
| `status` | `[dir] --json` | daemon+workspaces+sessions+pending; workspace rows may include additive provider-owned connect prompts and live-update state; never fails on daemon-down (state in data) | 0;70 |
| `mcp` | internal | plugin stdio MCP tools and pull fallback | — |
| `monitor` | internal | plugin session stream transport; requires `--plugin-root` and `--project-dir` | — |
| `codex-attach` | internal | foreground Codex app-server stream transport; requires exact thread id and accepts `--workspace`, `--cwd`, and `--socket` | — |
| `hook <event>` | internal | removed (#152); silent exit-0 stub for one release, then deleted | 0 |
| `complete <bash\|zsh\|fish\|powershell>` | shell utility | generate the selected shell's completion script on stdout | 0;2 |
- `open` auto-creates the `.glosa/` scaffold and nothing else. A workspace can be opened+annotated with no agent connected (SPA-only); the SPA badge says "no session connected — annotations wait here" and `doctor`'s `pending-delivery` line says "N entries queued, no live session". Neither names an install step, because there is none (#152).
- `open --url` performs the same token, daemon, registration, optional file deep-link, surface/mode,
  and bind work without invoking the macOS browser launcher. Plain success output is exactly the URL
  plus a newline; `--json` retains the F26 envelope with
  `data:{slug,path,url,focus?,surface,mode,preview,bound_session?,state_dir?}`.
- A document URL renders a single pane with the navigator hidden. Opening it in an already-mounted
  tab, including hash/history navigation, uses the same bootstrap after the existing pane discard
  guards consent. Cancellation keeps unsaved editor text and the current secret-free URL; document
  visits do not replace the saved workspace layout. Surface, mode and read lock are honored on both
  initial and reused-tab opens (R6).
- `--bind` after successful registration is nonfatal on unknown/stale sessions: the URL is still
  returned, a `bind-failed` warning is appended, and the exit code stays 0. `--preview --bind`
  additionally emits `preview-bind-conflict` (a preview-only visit does not promise a feedback
  workflow) but is not hard-blocked.
- `glosa open <target> --bind <own-session-id>` is the provider-facing open-and-connect direction:
  it completes workspace registration first and then performs the same explicit bind as `session bind`
  over HTTP. A successful result includes `bound_session`; no alternate persistence path is created.
- Preview lock is an **affordance expressing intent ("not for review")**, not access control: the
  annotation API continues to accept authenticated POSTs for the artifact.
- `request-review` creation maps daemon 404 to exit 4 `not_a_workspace` and daemon 409 to exit 8
  `approval-conflict`. Any other API failure before the review request is created maps to exit 70
  `internal`, preserving the problem title but not its detail or instance. Exit 9 does not apply:
  no primary operation completed successfully.
- doctor 17 checks: platform, bun, git, claude-code(WARN if absent or below the plugin floor), browser, daemon+proto, token/pairing(0600), workspace(.glosa+baseline+matcher non-empty), workspace-root(the resolved root, named so an unexpected one is visible rather than inferred — issue #146), pending-delivery(WARN "N entries queued, no live session" when entries are queued for this workspace and no live session is bound to or running in it; SKIP daemon-down), live-updates(PASS when active, WARN with the offline-catch-up reason when degraded, SKIP while starting, daemon-down, or against an N-1 daemon), orphaned-state(WARN when `~/.glosa/state` holds pending entries with no live registration, with the re-open recovery hint; SKIP daemon-down), orphaned-entries(WARN when entries have no payload, naming the count and the dismiss hint; SKIP daemon-down), Claude monitor status (WARN when a known environment setting suppresses it, otherwise SKIP because availability is per live session), transcript-root(under allowed CLAUDE_CONFIG_DIR), claude-config-roots(WARN when a Claude config root exists besides the active one — e.g. an account switcher's per-account instance directories — naming each, since transcripts are readable from all of them and the plugin is installed per root), legacy-config(WARN naming leftover `glosa init` hook/MCP/manifest entries in workspace and user scope that can be deleted; read-only, never degrades the exit code).

## Metadata and binding output

- Every command uses the stable F26 envelope in JSON mode and concise deterministic prose otherwise.
- `metadata show` returns only the descriptor; set/clear results contain no token or canonical path.
- `metadata set` validates local JSON syntax before contacting the daemon. Daemon validation remains
  authoritative and failed replacement never clears the prior descriptor.
- Same-id set and repeated clear are idempotent. A different active id is an explicit conflict.
- MCP parity tools are `glosa_inbox_pull`, `glosa_inbox_get`, `glosa_metadata_set`,
  `glosa_metadata_show`, `glosa_metadata_clear`, `glosa_session_bind`, `glosa_delivery_ack`,
  `glosa_claim`, `glosa_release`, `glosa_signal_ack` (issue #155), `glosa_present`, `glosa_ask`, and
  `glosa_watch`; their
  arguments and returned data
  match the CLI/API contract. (`glosa_ask` and `glosa_watch` were both already-shipped/newly-added
  tools this list previously omitted — `GLOSA_MCP_TOOL_NAMES`'s exact-list test in `cli/test/mcp.test.ts`
  is the authoritative enumeration if this prose ever drifts from it again.)
- Provider reconnect copy is returned by `GET /api/status`, not generated by CLI core. Each provider's
  `connectPrompt({slug,path})` names its own current-session identity source; the generic fallback is
  `glosa session bind <current-session-id> --workspace <workspace-path>`.
- `glosa_present {path, mode, session_id?}` registers an absolute existing file, returns a ready URL
  with a short-TTL single-use presentation token (`p=`), never launches a browser, and never returns
  the durable pairing token. Annotations: mutating, non-destructive, idempotent, closed-world.
  `mode:"preview"` is preview-locked; `annotate`/`edit` select an unlocked initial mode.
- `glosa_ask {workspace?, path, question?, quote?, options?, label?, wait_seconds?}` marks a passage
  and, when `question` is given, BLOCKS (default 600s, cap 900s) until the human answers or the wait
  elapses; omitting `question` posts the pointer and returns immediately. Cancelling the MCP request
  ends the wait at once and withdraws the question (terminal `expired`, by that session — A1 §5.11e);
  a wait that merely elapses leaves the question open, as before. Shim shutdown or a crash also
  leaves it open: withdrawing there would put the current bearer on the wire to an endpoint resolved
  earlier in the session, the hazard `close()` refuses for deregistration. Mutating, non-idempotent
  (each call marks a new passage), closed-world.
- `glosa_watch {workspace?, path?, since?, wait_ms?, session_id?}` (issue #153 Part 2) is the opt-in
  held read over `external_edit` — detail A1 §5.11b, A5 §F23. BLOCKS up to `wait_ms` (cap 900000ms)
  for an in-scope, not-yet-`presented`-to-this-session `external_edit`; requires the resolved session
  to already be explicitly bound to the workspace (`glosa_session_bind` first). Returns
  `{entries, latest_checkpoint, has_more}`; records `presented` only after the tool response reaches
  stdout, mirroring every other pull/push acknowledgement's write-then-ack boundary. Mutating (it
  marks entries `presented` for this session), non-idempotent, closed-world. Self-echo is not
  filtered: a returned entry may be this session's own un-leased write.

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

### Doctor shadow-history diagnosis and repair (#226)

For a registered directory (or explicit `--workspace <slug>`), the workspace check reads the daemon's
canonical shadow-health endpoint, including redirected/loose-file state. Missing HEAD objects fail
and print `glosa doctor --workspace <slug> --repair-baseline`. Diagnosis reports missing-checkpoint
entry counts and whether the census is complete. Healthy current history with historical missing or
unassessable entries warns. With no registered target available, the local read-only fallback verifies
`HEAD^{commit}`; a raw ref is insufficient.

`--repair-baseline` requires an explicit registered slug and calls the authenticated daemon route.
No unknown registration is created and there is no offline Git repair. The command starts new history
from current tracked files; it cannot restore lost checkpoints. Refusals fail the workspace check;
success with remaining historical damage warns. Other doctor checks retain their existing behavior.
