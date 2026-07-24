# glosa v1 — architecture spec (F13, F19, F23, F10/F11)

## F13 — daemon lifecycle
- **No entry point becomes the daemon in-process** (fixes "first shim wins the lock and becomes it"). Any client finding no live daemon **spawns a detached `glosa __daemon`** and acts purely as a client. Three roles, one binary: CLI (short client: ensureDaemon→1 HTTP call→exit), MCP shim `glosa mcp` (host-owned stdio client: ensureDaemon→proxy tool calls→exit on stdin EOF; NEVER binds/locks), daemon `glosa __daemon` (singleton; only role that binds port + writes lock).
- Lock `~/.glosa/daemon.lock` (daemon-only, written AFTER port bound): `{instance_id:gl-uuid, pid, port, protocol_version, build_id, started_at, host, bun}`. Handshake and status expose the same required `build_id`; readers accept a missing field only as a legacy migration case. **`lock.port` = authoritative port for all clients**; GLOSA_PORT only seeds a fresh spawn. Readiness = a lock plus passing `/api/handshake`, with identity/PID/instance/protocol agreeing between them.
- `build_id` is `<root-package-semver>-<first-16-hex-of-sha256>`. The hash covers every regular file under `packages/daemon/src`, `packages/cli/src`, `packages/spa/src`, and `packages/providers/*/src`, ordered by repository-relative POSIX path. Each path and its file bytes are independently framed as `<decimal-byte-length>:<bytes>\0`. Identity computation and semver parsing fail closed.
- `ensureDaemon()` verifies the lock/handshake pair, then applies this matrix: higher client semver → SIGTERM+replace regardless of protocol; lower client semver → reuse only when protocol-compatible, otherwise FAIL `incompatible glosa versions installed` without signalling; equal semver+hash → reuse only when protocol-compatible; equal semver+different hash → invoking client SIGTERM+replace; missing legacy identity → replace. Malformed identity or any lock/handshake disagreement fails closed without signalling.
- Replacement signals only the verified PID, waits ≤5s for that exact lock instance to disappear/change, then re-enters the ordinary read-or-spawn loop. Concurrent clients therefore converge through bind/O_EXCL/CAS; clients never unlink a replacement lock or spawn independently. If no live daemon exists, spawn = detachedSpawn + poll handshake ≤5s; timeout→FAIL w/ daemon.log path.
- Detach (macOS, no setsid): `Bun.spawn stdio:["ignore",logfd,logfd]` (~/.glosa/daemon.log) + `child.unref()`; **daemon ignores SIGHUP/SIGINT** (survives Ctrl-C/terminal close), SIGTERM→graceful. Claude killing shim kills only shim.
- Daemon boot: bind 127.0.0.1:port (EADDRINUSE + valid peer → exit0 benign race; EADDRINUSE foreign → exit3 + log) → `openSync(lock,"wx")` O_EXCL = CAS (EEXIST + live peer → exit0; else reclaim+retry once→exit4) → write+fsync lock → install signal handlers → serve (handshake→200). Bind-before-lock + O_EXCL → exactly one daemon wins.
- reclaimStaleLock: unlink + re-openSync(wx). Stale = dead pid / unparseable / alive-but-foreign-port (PID reuse, detected by handshake fail).
- Shutdown: SIGTERM → `server.stop(false)` on both listeners → SSE `event:bye` and close all journal/transcript streams → await active HTTP handlers and every workspace-bus mutex → fsync+close journal writers → unlink lock ONLY if `instance_id` matches → exit0. The drain is bounded at 3s; timeout force-closes both listeners, retains the ownership check, logs forced shutdown, and exits. SPA clients consume `bye` internally and reconnect immediately with their last cursor; later failures use normal backoff. A severed apply lease reconciles subsequent edits as `unknown`; only a completed matching lease may yield `session:<id>`, and shutdown never invents a `human` fallback. No idle self-shutdown in v1.

## F19 — global workspace index `~/.glosa/workspaces.json`
- **Daemon-only writer**, serialized via in-process async mutex, temp+fsync+rename. All clients (CLI/hooks/MCP) mutate via daemon API, never write the file → also fixes F08 session-registration race.
- Schema v3:
  `{version:3,updated_at,workspaces:{<registration_id>:{registration_id,kind,canonical_path,worktree_path,bus_path,tracking,slug,slug_len,source,first_seen,last_seen,present,file_identity?,lifecycle}},adoptions}`.
  `tracking` is `{mode:"matcher"}` or `{mode:"bounded",paths:[<relative-path>,…]}`. Registration
  IDs are immutable full SHA-256 hashes of registration kind + canonical identity. v1 entries
  migrate atomically to directory registrations without changing their slug/root, using
  `<canonical-root>/.glosa` and matcher tracking.
- Canonicalization (identity) = realpath→NFC→strip trailing slash. Slug = sanitize(basename)+`-`+sha256(canonical)[:6], collision→lengthen hex (F25). Enumerate switcher = present===true.
- `POST /api/workspaces/open` accepts the original file or directory path and optional
  `external_state:true`; it returns the selected slug, work-tree path, and optional representative
  focus path. Existing registrations and existing local buses are authoritative regardless of the
  flag. Fresh unwritable directories redirect automatically; fresh writable directories redirect
  only by opt-in. An unwritable existing local bus fails closed rather than creating a second
  journal; moving state is a separate migration. A loose-file-to-directory open is the narrow
  exception: it creates a durable adoption record, seals source histories in place, and publishes a
  new directory state atomically by same-filesystem rename. The index lifecycle is
  `active → adopting → adopted`; a source is never made writable again, and a restart resumes the
  same plan rather than beginning a second migration.
- GC (on start + throttled ≥60s): missing path → soft `present:false` (keeps slug for history); hard-remove only when gone AND no live session AND present:false ≥ grace (or `glosa forget <slug>`). Conservative.

## F23 — inbox/attention lifecycle
- Inbox files **immutable**; status field frozen `pending`, non-authoritative. **Authoritative status = journal replay fold** (overrides R3's cross-file rewrite per F04). `resolve` appends ONE journal line, never rewrites the entry.
- **Two separate axes**: (1) lifecycle status (small state machine, one legal writer/transition, idempotent); (2) `delivery_attempt` events = NOT transitions. Re-nudging a `delivered` entry emits new delivery_attempt (status stays delivered); per-rung "delivered" semantics live in `attempt.outcome`.
- Conversation entries use terminal `pending → delivered`. The transition is appended only with a
  durable `delivery_attempt{outcome:"presented"}` for the exact target session; queueing and
  `transport_accepted` are non-terminal.
- Event vocab (writer / changes-state / idem-key): created(daemon/→pending/entry); delivery_attempt(daemon/NO/(entry,attempt_seq)); delivered(daemon/pending→delivered/(entry,delivered)); seen(daemon|human/delivered→seen [attention]/(entry,seen)); resolved(session:<id>|human/→applied|rejected|stale/(entry,resolved) first-terminal-wins); done(human|session/seen→done [attention]); staled(daemon/→stale); expired(daemon/→expired [attention]). A seen/response mutation may append missing `delivered` and `seen` transitions under the same workspace mutex; every completion therefore has the auditable `seen→done` path.
- delivery_attempt.detail: `{via:channel|asyncRewake|gate|stop|userprompt|mcp_pull, session, outcome:attempted|transport_accepted|presented|failed, reason:initial|re_nudge, error?}`. (No cmux — glosa is cmux-decoupled; the cross-agent transports are the blocking gate + turn-boundary hooks + MCP-pull, plus Claude channels.)
- Presentation is two-phase. `prepare` selects non-terminal entries in journal creation order, reads
  their immutable payloads, builds provider-neutral actionable presentations, and places an in-memory
  30-second reservation on each selected id. It returns a random delivery token but writes no
  `presented` attempt. `ack(token,presented|failed)` consumes the reservation and appends one attempt
  per entry; token expiry or process death releases the entries without changing journal state.
- Limits are measured with `TextEncoder`: 16 KiB per serialized entry, 32 KiB per serialized batch,
  maximum eight entries. An annotation always retains id/kind/artifact/body-or-prefix/intent/quote/
  position/current resolution. A human edit always retains id/kind/checkpoint pair/all file paths and
  as many complete unified-diff hunks as fit. Every truncation includes omitted byte/hunk counts and an
  opaque continuation cursor usable through the CLI and MCP retrieval surfaces. Full artifact bodies
  are forbidden in delivery payloads.
- Conversation payloads are never truncated. Their immutable entry retains the client id, exact UTF-8
  text, byte count, provider, and target session. Pending entries survive restart; in-memory
  reservations may retry at least once. Journal/API errors use bounded stable codes, never exception
  text, tokens, transcript paths, or canonical workspace paths.
- Common entries terminal: applied/rejected/stale. Attention terminal: done/expired/stale. Event with guard `from`≠current → ignored on replay (idempotent). Duplicate resolve on terminal = no-op. Ordinary `done.detail` is `{outcome:"done"|"approved"|"changes_requested", response?:string}`; review actions accept the two review outcomes, while generic actions accept `done`. Approval-mode attention stores exactly `{outcome:"approved",target_path,revision_id,completed_at}` after validating the current `source_sha256`. Creation is serialized with an atomic non-terminal uniqueness check on workspace+target_path. A terminal retry returns the original detail without appending.
- Replay: fold in order; skip torn final line; malformed completed line → quarantine (not fatal); delivery_attempt never mutates; guarded transitions only when !isTerminal(cur). `--wait` callers resolve when fold reaches done/expired, payload in done.detail.

## F10/F11 — anchoring resolution contract
- `resolve(annotation, artifact, ctx) → Resolution` — total, never throws, never guesses:
  `{kind:"source_range", path, start_line, end_line, start_col?, end_col?, matched_quote, confidence:"exact"|"normalized"|"block_range"}` | `{kind:"pipeline_feedback", target, intent, body}` | `{kind:"orphaned", reason:"hash_mismatch_no_match"|"ambiguous"|"no_source_map"|"quote_absent_not_transformed"}`.
- Normalization (fixed, shared): NFC first; whitespace-fold (collapse all Unicode ws incl NBSP→single space, trim); offsets in UTF-16 code units vs rendered DOM text; source matching by string search (source needs only `\r\n→\n`); prefix/suffix ±40 rendered chars post-fold; **uniqueness always required (0 or ≥2 → never auto-apply)**; `source_sha256`=SHA256(raw bytes after \r\n→\n only, no md processing); `rendered_sha256`=SHA256(served bytes); position trusted only while rendered_sha256 matches.
- **Class R cascade** (NO full inline source map — deferred): 1 identity hash; 2 scope via position→enclosing data-line block→source line range [L0,L1] (no position→whole doc); 3 EXACT literal substring in [L0,L1] unique→source_range exact; 4 NORMALIZED fold in [L0,L1] unique→normalized; 5 WIDEN normalized whole-doc unique→normalized; 6 fallback: stamped block scope→source_range block_range (guidance, NOT verified edit) else orphaned. **Class R NEVER returns pipeline_feedback** (no declared transform). Rendered selection crossing emphasis/link/code → block_range guidance.
- **Class F cascade** (uses descriptor-derived source/manifest metadata; bridge captures nearest `[data-chunk]`): manifest `{manifest_version:1, source_path, source_sha256, chunks:[{chunk_id, source_start_line, source_end_line, source_sha256, transformed:bool default false}]}`. Steps: 1 chunk_id→manifest chunk (none→orphaned no_source_map); 2 staleness via chunk.source_sha256; 3 if transformed==false → run Class-R EXACT→NORMALIZED within [chunk lines]: unique→source_range, **no match→orphaned{quote_absent_not_transformed}** (intent does NOT rescue); 4 if transformed==true → pipeline_feedback whose target uses only descriptor id, descriptor manifest component, chunk id, and source range.
- **F11 invariant**: pipeline_feedback ONLY when producer declares node `transformed:true`. Missing quote in non-transformed chunk = orphaned, never silently reclassified as feedback because intent said "content." Intent selects framing/recipient AFTER transformed authorizes the path; never converts a bad mapping to good.
- pipeline_feedback = inbox entry delivered to the explicitly bound agent session; resolves via applied|rejected|stale; auto-`staled` if chunk source changes before resolution; NOT an anchor (no source_range).
- Global cascade (both viewers): identity/hash → manifest range → exact+unique → position(if rendered hash matches)+verify quote → normalized+unique → transformed⇒feedback → else block_range/orphaned. Never silently convert unknown mapping failure into style feedback.

## Cross-cutting
- All mutations route through the single serialized writer (daemon/journal); no cross-file atomic writes. Versioned schemas (version/manifest_version/protocol_version) for N-1 tolerance. Deferred as over-engineering for local single-user v1: idle-daemon auto-shutdown, full inline markdown source map, fuzzy re-anchoring.
