# glosa v1 — requirements (v2, build-ready)

> **Status:** This is the normative v1 technical contract, not the live product roadmap or work queue.
> See [`ROADMAP.md`](../ROADMAP.md) for accepted direction and its linked GitHub Project for current
> execution status.

**This is the authoritative build input for glosa v1.** It supersedes the original v1 contract in
full. v1 + the adversarial review
(`research/codex-review.md`, verdict NEEDS-REWORK, 32 findings) + a six-specialist resolution pass
produced this document; where v1 and v2 disagree, **v2 governs**. Deep contracts live in the six
normative appendices under `appendices/` (A1–A6); this document states requirements and references the
appendix that specifies each. **Precedence: where
this v2 body and an appendix disagree, v2 governs** — in particular, cmux appears nowhere in the delivery or
UI model; any lingering cmux mention in an appendix is stale and superseded by R4's cmux-free model.

**Product**: glosa — a local-first, writing-first workspace for people working with AI coding agents.
An agent drafts documents; the human reads them rendered, annotates in the margins, and edits; glosa
routes annotations and edits back to the right agent session with honest provenance. **Companion
topology**: the agent runs as a normal interactive session in the user's terminal; glosa is a singleton
daemon beside it serving a browser SPA. Claude Code is the deep, required integration; the design is
agent-agnostic (Codex and other push/MCP-capable CLIs supported through one provider interface).

**Repository**: `davebream/glosa`. GitHub issues are the executable work queue; this document is the
normative product contract.

## 0. What changed from v1 (orientation for anyone who read v1)
- **No cmux coupling** anywhere. SPA runs in any browser over localhost; delivery uses each agent's own push transport plus MCP, not keystroke injection.
- **In-app editor is IN scope** (Read / Review / Edit modes). v1's "no editing" non-goal is removed.
- **Explicit session binding** is authoritative; terminal cwd is only a generic fallback (F01).
- **Declarative workspace metadata** replaces embedded producer/domain adapters. An external
  integration describes artifacts through the public CLI or MCP contract; glosa owns no integration
  package or workflow logic.
- **Multi-agent**: Claude Code deep + Codex built to the same provider interface; provider interface is a first-class deliverable.
- **History = full** (compare + restore). **Platform = macOS-only, pinned versions.**
- Durability, auth, daemon lifecycle, anchoring, security, CLI all hardened per appendices A1–A6.

## 1. Goal & release gate
**Goal**: eliminate four failure modes of agent-assisted writing — (A) unreadable terminal rendering
of long-form dialogue, (B) no artifact preview/annotation beside the agent, (C) manual edits invisible
to the agent, (D) annotation of rendered output requiring copy-paste.

**Hard release gate**: the deterministic acceptance suites pass, AND a maintainer-reviewed manual
rehearsal (T8) against an ignored copy of real past artifacts passes. The maintainer selects the
private input and signs the sanitized report; an agent never signs on the maintainer's behalf.

**Non-goals (v1)**: desktop shell (Electron/Tauri — v1 is daemon + browser); dictation capture;
mobile/remote access; cloud sync; a second-agent provider *beyond* Claude Code + Codex; a public
plugin/SDK surface; telemetry; cross-platform (macOS-only); instant-wake of a non-Claude *idle* agent
(honest limit — see R4).

## 2. Architecture (fixed)
```
 user's terminal: interactive `claude` (or `codex`) session(s)      browser (any: Safari-dock / tab / later Electron)
   plugin monitor / app-server attach → register + push stream ·        glosa SPA (served by daemon over http://127.0.0.1)
   MCP shim (`glosa mcp`) pull/ack/bind · `glosa resolve`/`apply-begin`  Read/Review/Edit · 4 viewers · workspace switcher
                    │ push stream (SSE), MCP(stdio), CLI                            │ fetch + streaming-SSE, Bearer (SPA origin)
             ┌──────▼──────────────────────────────────────────────────────────────▼──────┐
             │ glosa daemon — singleton per machine, TWO fixed ports (4646 SPA/API, 4647    │
             │ class-F content). file bus: per-workspace inbox + journal(=truth) + shadow-  │
             │ git · picomatch matcher · session registry · global workspace index ·        │
             │ provider-based delivery · auth (Host+Origin allowlist + Bearer + capabilities)│
             └──────────────────────────────────────────────────────────────────────────────┘
```
Fixed stack: **Bun + TypeScript**; one process serves SPA + API; **no heavy frontend framework**
(server-rendered HTML + small vanilla ES modules); **markdown-it** (+ `data-line` stamping),
**idiomorph** (live morph), **diff2html** (diff pane), **picomatch** (the one matcher), Bun's native
recursive **`fs.watch`** (artifact watch; **chokidar v5** only for transcript tailing), system **git** (shadow repo), a vendored **transcript-event normalizer** (do NOT
parse raw transcript JSONL directly — A2). Monorepo: `packages/{daemon, spa, providers/claude-code,
providers/codex, cli}`. Three invariant boundaries (review-blockers if violated):
(1) daemon API is versioned + client-agnostic; (2) agent providers and content adapters only enter
via their interfaces — no special-casing; (3) the SPA talks to the daemon only through the public
authenticated API. **Adapters/providers carry ALL domain- and agent-specific knowledge; the core is
generic.**

## 3. Functional requirements

### R1 — singleton daemon, ports, workspace model  (detail: A5 §F13, A4, A6 §F30)
- One daemon/machine; lock `~/.glosa/daemon.lock` carries
  `{instance_id,pid,port,protocol_version,build_id,…}`. `build_id` is the root package semver plus a
  content hash of all runtime source; legacy locks/handshakes may omit it only during migration.
  A verified older or same-semver-different daemon is automatically replaced; a newer compatible
  daemon is reused, while an incompatible newer daemon fails closed and is never signalled;
  **`lock.port` is the authoritative port** (env `GLOSA_PORT` default 4646 only seeds a fresh spawn;
  class-F port = `GLOSA_PORT+1` = 4647). No entry point *becomes* the daemon in-process: a client with
  no live daemon **spawns a detached `glosa __daemon`** (unref + ignores SIGHUP/SIGINT) and acts as a
  client; the MCP shim (`glosa mcp`) only proxies, never binds/locks. Readiness = a lock plus a
  passing `/api/handshake`. A daemon that already established ownership recreates its own missing
  lock through a 250 ms watchdog and also during handshake, using the same O_EXCL+fsync path;
  clients proceed only after re-reading a matching lock/handshake pair. Corrupt or mismatched locks
  are never overwritten, lockless older daemons remain fail-closed with manual recovery guidance,
  and lock and handshake identity/PID/instance must agree before any signal is sent. Client-side
  discovery has one caller-supplied wall-clock budget — **twelve seconds**, the single default for
  every CLI/MCP call, since `glosa hook <event>` is a silent stub that never calls discovery at all
  (#152) — permits at most one detached spawn, and requires three consecutive
  `ECONNREFUSED` probes 100 ms apart **and a successful bind of the port** before treating it as
  free — a refused connection is not evidence a port is free, because a daemon that has stopped
  accepting still holds its listening socket. Ownership changes or an
  exhausted budget fail closed without unlinking or spawning, surfacing as a thrown
  `DAEMON_UNREACHABLE` error to the caller. A daemon that stops running its event loop
  releases its own ownership record and ends its process rather than holding the port
  indefinitely, and every client message about an unresponsive owner names the recovery a user can
  actually perform on one.
  Replacement waits up to ten seconds, within the discovery budget, for that lock ownership to
  change or the signalled process to exit, then re-enters the normal `bind → O_EXCL lock create`
  CAS loop so simultaneous refreshes converge on one daemon. A lock whose process is still a glosa
  daemon is never reclaimed while that process lives, even with its port free: that is a daemon on
  its way out, and the client waits for it the same way or fails closed naming its PID.
- **Workspace registration** separates an immutable registration ID, kind (`directory` or
  `loose-file`), canonical identity path, work-tree, absolute bus path, and tracked-file policy.
  Sources: session registration, `glosa open <path>`, first-touch `.glosa/`. The daemon-only,
  atomically written global index `~/.glosa/workspaces.json` is authoritative. Identity paths use
  realpath→NFC→strip-slash; slugs remain display/routing labels with deterministic
  collision-lengthening (A4 §F25). Loose files and redirected directories store state beneath
  `~/.glosa/state/<full-sha256-registration-id>/` while retaining their original work-tree.
  **A file with no owning registration resolves to its enclosing git repository as a `directory`
  registration, not a `loose-file`, whenever that repo's own tracked-artifact rule would track the
  file** (issue #96) — this is the same root `glosa doctor` resolves to for that file,
  so all three commands agree on one workspace boundary and never point a wiring hint at the
  file's bare containing directory. `loose-file` remains the outcome for a file outside any git
  repository, or one the enclosing repo's own matcher excludes (dot-dir, `node_modules`, > 2 MiB).
  The same bounded fallback applies when an explicitly named file is excluded by an already-
  registered owning directory; opening that directory still omits the file, and an explicit
  directory focus remains constrained to the directory's tracked list.
  **This enclosing-repository resolution never adopts the user's home directory, or any ancestor
  of it, as the resolved root** (issue #146): a dotfiles checkout at `$HOME` is a git repository
  like any other to the raw walk, so without this boundary it is adopted the same way, pointing a
  workspace — and its matcher — at the user's entire home directory. `glosa open`'s file-owning
  reuse is bounded the same way: a `directory` registration already naming `$HOME` or an ancestor
  of it (created before this boundary existed) is never silently reused for a new file lookup —
  the registration is surfaced by slug with remediation, and continuing to use it requires the
  same explicit intent as creating one, namely opening that directory itself rather than an
  unrelated nested file. `glosa doctor`'s cwd default falls back to the literal cwd
  instead of promoting to home, and an explicit `--dir` naming `$HOME` itself is refused the same
  way a temp-root or multi-repo target is (`home-dir` risk, clearable with `--force` or a TTY
  confirmation). A repository that is merely a subdirectory of home is unaffected and keeps
  resolving normally.
- **Tracked-artifact rule** produces one normalized file LIST feeding watcher + sidebar + git
  pathspec identically. Directory registrations use the recursive picomatch policy: include
  `**/*.md,**/*.html,**/*.txt`; exclude dot-dirs, `node_modules`, files > 2 MiB; symlinks never
  followed/matched; NFC + case-sensitive. Loose-file registrations use a bounded relative-path
  list containing exactly the requested existing regular non-symlink file and intentionally bypass
  matcher extension, exclusion, and size rules. Per-workspace overrides resolve from
  `<bus-path>/config.json` (A4 §F20).
- Git-agnostic provenance: shadow repo
  `GIT_DIR=<bus-path>/shadow.git --work-tree=<work-tree>`, argv-safe, one git mutex/registration,
  deterministic init + baseline, index-lock recovery (A4 §F21). UI speaks versions/timeline/restore
  — never commits/SHAs.
- **Loose-to-directory adoption is seal-and-link, never a physical migration.** Opening a parent
  directory seals each contained loose-file bus, retains its journal/inbox and shadow repo beneath
  `~/.glosa` as historical truth, imports its Git head under a target lineage ref, and carries only
  non-terminal entries as explicitly provenance-marked target aliases. The new directory bus is
  the sole live writer. One daemon-scoped coordinator serializes the complete adoption transaction
  per target; ordinary target routes return `409 workspace-adopting` until publication commits. A
  target with pre-existing state or a live source apply lease fails closed; the implementation never
  recursively moves or deletes source state (A4/A5).

### R2 — session registry & routing  (detail: A2 §F08, A5 §F19)
- Providers register live agent sessions through their push transport at session start, MCP activity
  (first tool call), or explicit binding → daemon API (never direct file writes; serialized by the
  daemon → no lost entries). Record: `{session_id, provider, workspace_binding, cwd,
  transcript_path, source, last_active_at, lease_expiry}`. Liveness = **unexpired 60-second lease**, refreshed by MCP tool calls or an open
  session transport connection every 20 seconds (never `kill(pid,0)`). Closing a connection stops
  refreshes; it does not end the lease immediately. `source` is `monitor`, `codex-app-server`,
  `mcp`, or `cli` (explicit bind), or `manual` for an explicit bind that sends none; there are no
  hook sources (#152).
  MCP registers on first tool use and re-registers after an unknown-session heartbeat. Explicit bind
  also registers unknown identities and refreshes stale ones; missing provider identity uses generic
  `mcp`, which a subsequent concrete provider may enrich. Omitted registration fields preserve
  bindings/transcripts; conflicting concrete providers fail. Bindings remain in memory and require
  explicit restoration after daemon restart.
- **Routing precedence**: (1) an **explicit session binding** supplied through the API, CLI, or MCP
  contract (authoritative); (2) the generic cwd-ancestor fallback. This supports artifact workspaces
  that differ from the agent process cwd without teaching glosa about an external workflow. Two sessions bound to one
  workspace → deliver to the `session_hint`; else a one-time SPA picker (never guess). No live session →
  the entry **parks**; next session registration for that workspace drains it. An explicitly bound
  session drains only that exact workspace. An unbound session drain applies the same cwd-ancestor
  routing predicate in reverse across every present, active registered workspace; it combines rather
  than guesses among nested descendants. The combined response retains the global eight-entry/32-KiB
  caps and labels every agent-visible presentation with its canonical workspace path (A1 §5.15).

### R3 — file bus: inbox, journal (=truth), provenance  (detail: A4 §F04/§F05, A5 §F23)
- **The journal is the single source of truth.** Inbox entries are **immutable** (write-once, temp→
  fsync→rename); current status is derived by **replaying the journal** (idempotent fold; ULID
  `event_id` + `idem` keys). `glosa resolve` and `glosa inbox dismiss` each append **one** journal
  line — no cross-file atomic write exists (this is the F04 fix); dismiss is the human path that
  closes an entry whose inbox payload has gone missing, without needing a session, reconciling the
  count `doctor`/`status` name as orphaned. Startup reconciliation: torn-tail truncate → replay → inbox self-heal →
  apply-lease reconcile → offline-edit catch-up. Corrupt interior line → quarantine, never fatal.
- Journal, inbox, quarantine, declarative metadata/config, reconciliation state, checkpoints, and
  shadow Git resolve through the registration's absolute bus path. Redirection changes storage
  location only; journal replay and apply-lease evidence retain unchanged authority.
- Entry kinds: `human_edit`, `annotation`, `attention_request`, `conversation_message`, `external_edit`. Envelope + payloads exactly per A4/A5
  (`human_edit` = inline hunk diffs referenced by shadow-git sha, never full bodies; `external_edit`
  = a tracked artifact that changed on disk with nothing to attribute it to, one entry per artifact
  — `{path, diff, since_checkpoint, until_checkpoint, observed_at, source: live|offline_catchup}`,
  singular `path` and never a file list; `annotation` =
  W3C quote+prefix/suffix+position + `intent` + `target.chunk_id?`). Annotation `intent` enum =
  `content` (change the words → source edit) | `classification` (wrong type/split/label → pipeline
  feedback) | `style` (rendering/notation → renderer/CSS). The resolver (R6) uses `intent` only to
  frame/route feedback once anchoring has decided source-vs-pipeline; it never overrides anchoring.
- Actionable delivery is built from the immutable entry at presentation time. Annotation presentation
  includes its workspace-relative artifact path, comment body, intent, durable quote/position context,
  and the current F10/F11 anchoring resolution. Human-edit presentation includes before/after
  shadow-git checkpoints and bounded unified hunks; it never includes a full artifact body.
- **`external_edit` is a record, not a request.** It reports that a file changed outside glosa; there
  is nothing to apply, because the change is already in the artifact. It is therefore excluded from
  ordinary delivery eligibility and from the badge-facing pending count, and no agent is ever nudged
  with one **unless its own session explicitly watches for it** (issue #153 Part 2's `glosa_watch` /
  `GET /w/:slug/watch`, detail A1/A5 §F23). A watch is opt-in and per-session: it marks the entries it
  returns `presented` (`via:"watch"`) for the watching session only — no status transition, no effect
  on any other session's monitor stream, MCP pull, badge count, or the retention-facing count below —
  and it does not filter self-echo, so a returned entry may be the watching session's own un-leased
  write. It remains retrievable (`glosa inbox get`, MCP) and is still counted by the retention-facing
  signals — GC's hard-remove guard and the stranded-home-state scanner — so an undismissed one is
  parked work that blocks deletion rather than work that vanishes. `glosa inbox dismiss` closes it;
  nothing else does, and there is no TTL.
- **Lifecycle** is a state machine with delivery kept as a *separate axis* (A5 §F23): `delivery_attempt`
  events never change status; re-nudging a `delivered` entry emits attempts, not transitions. Full
  transition table + single writer per event in A5.
- **Provenance / attribution (honest)**: agent edits are bracketed by an explicit **apply-lease**
  (`glosa apply-begin` → pre-checkpoint; `glosa resolve` → post-checkpoint; the proven `pre..post` diff
  → `session:<id>`). Edits made in glosa's own editor → `human` by construction. **Every other
  watcher-observed write → `unknown`, never falsely `human`.** Attribution rides in git commit trailers
  (A4 §F05/§F21). That last case is what `external_edit` names in the inbox, so the honest `unknown`
  in storage is the same answer the reader and the agent are given — the two used to disagree, with
  drift hunks reaching delivery labelled `human_edit`. A drift-capturing checkpoint is never taken
  while an apply-lease is held: because checkpointing is idempotent, one taken mid-lease would become
  the lease's own `post_sha` and make the journal credit a session for a commit trailered `unknown`.
  The lease's `pre..post` pair brackets that interval instead.

### R4 — delivery: provider-based, cmux-free  (detail: A2 §F06/§F07/§F16)
Delivery is per-agent-provider, selecting the best injection point that provider offers. Durable inbox
is always the truth; a transport failure only changes *which* mechanism delivers next, never whether
the entry survives. The ladder is **`push → mcp_pull`**; there are no hook rungs (#152).

| Capability | Claude Code provider | Codex provider | Generic MCP host |
|---|---|---|---|
| Async push into idle | **plugin monitor** over the generic session stream | **Codex app-server control socket**, when separately running | — |
| Pull on demand | MCP tool | MCP tool | **MCP tool** |
- Registration happens from the push transport at session start (the monitor, the app-server
  attachment) or from the MCP shim on its first tool call. There is no `glosa init`, no hook
  registration, no Channel, no rewake watcher, and no turn-boundary drain: the `SessionStart`/`Stop`/
  `UserPromptSubmit`/`Notification` hooks and the structured blocking gate are retired, not
  optional. `glosa hook <event>` survives for one release as a silent exit-0 stub so a machine still
  carrying old hook entries never shows a failing hook; `glosa doctor` names the leftover entries.
- `push` is a **per-session** capability evaluated at registration, never inferred from
  installation. Claude: true only while that session's plugin monitor holds the stream — Claude
  suppresses monitors when nonessential traffic/telemetry is disabled and in noninteractive or
  unsupported hosted-model sessions; `glosa doctor` names the environment-variable case and MCP pull
  remains available. Codex: true only while that exact thread owns a live app-server attachment.
- Push writes prove only `transport_accepted`. A targeted conversation message becomes terminal
  `delivered` only after the exact session acknowledges `presented` through `glosa_delivery_ack`;
  until then it remains eligible for MCP pull. Every pushed line begins `[glosa <entry-id>]`, which
  the acknowledgement tool returns.
- Codex's MCP bind owns an RFC 6455 connection over the local app-server Unix socket, resumes the
  exact thread, and delivers bounded input with `turn/steer` when it knows the active turn id or
  `turn/start` otherwise. Glosa never starts or repairs Codex's app-server; MCP pull remains
  available when the socket is absent or the first-turn rollout is not ready.
- **No cmux.** The universal cross-agent path is MCP pull; push is a per-provider optimization over
  the provider's own documented transport. (The earlier sentence naming "the structured blocking
  gate (Plannotator-proven …)" as the universal path is retired with the hooks.)
- Every injected presentation is UTF-8 bounded: at most 16 KiB per entry and 32 KiB per batch, with
  at most eight entries in journal creation order. Truncation happens only at field or complete-hunk
  boundaries and always carries omitted counts plus `glosa inbox get <id> --cursor <cursor>` and MCP
  `glosa_inbox_get` retrieval instructions. Preparing content reserves it briefly; only a successful
  monitor/app-server/MCP write may acknowledge it as `presented`. Failed or expired reservations remain
  eligible, and later attempts append `reason:re_nudge` without mutating the inbox payload.

### R5 — HTTP API + auth  (detail: A1 full, A3 §4)
- Two fixed loopback listeners (SPA/API 4646; class-F content 4647) — one daemon, two origins.
- **Auth**: `Host` must literally equal an allowlisted name + port on every request — `127.0.0.1:<port>`
  or, on the SPA/API port only, `glosa.localhost:<port>` (resolved on-device, never by a DNS query → anti-rebinding; #159);
  Bearer token (128-bit, `~/.glosa/token` 0600) on API requests via `Authorization` header; **SSE uses
  `fetch()`-streaming (NOT native EventSource) so the header rides normally**; the class-F iframe loads
  via a **one-time 256-bit capability URL** on port 4647 (no ambient token there). Origin allowlist is
  route-class-scoped (strict on state-changing, foreign-only-reject on reads/handshake, inapplicable to
  navigation) — the resolved table is A3 §4. No cookies (CSRF structurally dead). The browser keeps
  the pairing token in origin-scoped `localStorage`, so a reload, a second tab, or a host that rebuilds
  its web view stays paired on that origin (#229); the token never enters the URL or browser history.
- **Token lifecycle**: `glosa token rotate` atomically replaces the credential with a fresh 128-bit
  mode-0600 token; `glosa token revoke` removes the credential. The running daemon observes either
  transition without restart, aborts credential-bound streams, invalidates every class-F capability,
  and accepts only the current token with no grace period. Stale SPA requests receive 401, clear the
  origin-scoped browser credential (shared by every tab on that origin, so they all unpair together),
  and return to the unpaired screen; `glosa open` is the documented re-pairing path, and one such open
  re-pairs every tab on the origin. Mutation failures preserve the prior credential state. Token commands never print token material.
- Versioned route catalog (contract v1.11: `/api/handshake` plus workspace routes including metadata,
  explicit session binding, artifact list/content,
  streaming SSE with journal-offset cursor + reconnect replay, annotations, diff, checkpoints/restore
  (full history), transcript stream, inbox/attention, the opt-in held `external_edit` watch and its
  acknowledgement routes (issue #153 Part 2), presentation-token mint/redeem, whole-bus
  deletion (`glosa forget`, issue #156), starred workspaces (star, unstar, reopen by star id)) — schemas, status codes, 1 MiB body cap,
  `X-Contract-Version` (major mismatch → 409 + reload; minor tolerated) in A1. All paths pass the single
  `confinePath()` realpath guard (A3 §3).

### R6 — SPA: three modes, four viewers  (detail: A3 §1-2, A5 §F10/§F11, A1)
- **v1 invariant — swappable data layer**: the SPA reaches the daemon through ONE data-access module
  (same-origin fetch today). This is a v1 build constraint, not future scope: it is what makes a future
  hosted-shell/Electron topology a config change rather than a refactor (the L0→L3 distribution ladder).
  No SPA component talks to the daemon except through that module.
- **Document links and same-tab navigation**: a `surface=document` fragment renders one pane with
  the navigator hidden, without restoring or overwriting the workspace's saved tab layout. External
  fragment changes and history traversal re-enter bootstrap after every open pane's discard guard
  consents. Cancellation preserves the mounted editor and restores its secret-free focus URL.
  Workspace, artifact, surface, mode and read lock follow the requested fragment.
- **One page per artifact in three states**, named for what the HUMAN is doing rather than for who the
  counterparty is. **Review** is the default page: the anchored two-way margin, where the reviewer's
  own comments AND a session's questions and pointers about a passage are answered where the words
  are, and selecting text opens a comment. **Read** is the same page with notes hidden (rendered,
  reading-only canvas; annotation, restore, and agent composition need notes shown), reached through
  one Notes toggle. **Edit** is a deliberate state of that same page (modify source, save →
  re-render), entered with one Edit action and left with Done, which returns to whichever view was
  left; the page itself scrolls, so the reader's place survives entering and leaving it. Edit is
  paused while the workspace's apply lease is held by a session, and a draft already open is kept.
  The three state names stay on the wire (`mode=` links, `glosa open`, `glosa_present`); a link or
  command that names no mode opens Review, and a read lock pins Read with no Notes or Edit control. Edit has two faces: a rich editor is the default and the byte-exact source
  textarea stays one toggle away. Saves are **source-preserving** — only the blocks the writer
  edited are re-serialized and everything else is byte-identical; a block the rich editor models is
  written back in the spelling it was read in, and a top-level construct it does not model — a
  document's metadata header — is carried through verbatim rather than re-serialized; a single newline inside a
  paragraph is a line break the writer typed and is kept as one, since a joined line cannot be
  split again from the file afterwards. Where re-serializing an edited block would still change
  bytes the writer did not touch, glosa shows that collateral and asks before writing, never
  silently. Human edits in glosa → attributed `human` by construction. A save is refused when the file moved
  under the draft since it was opened, rather than silently overwritten, and the writer chooses: **keep
  mine** (a three-way merge — the version the writer opened, the writer's own edit, and disk's current
  version — previewed first and written only on that explicit choice; a block only the writer touched
  keeps the writer's bytes, a block only disk touched keeps disk's bytes, and a block both touched is a
  conflict the writer's version wins, listed in the preview so that choice is informed), take the disk
  version, or compare first. **Non-manuscript regions** — a leading document
  metadata header and paired `%%` authoring comments — are hidden in Read/Review and excluded from
  outline headings. Inline pairs stay within one CommonMark inline block; own-line pairs may span
  multiple lines within their container. Escaped/unmatched delimiters and markers in code remain
  literal. Source Edit retains the source; rich Edit labels metadata and private notes and preserves
  their spelling outside intentional edits (issue #175).
- **Class R viewer (markdown)**: markdown-it + `data-line` stamping; SSE-driven updates morphed via
  idiomorph (scroll/selection preserved); annotation → W3C record → POST.
- **Class F viewer (foreign HTML)**: **source-preserving (bridge-augmented)** — served from the
  separate 4647 origin under a capability, document HTML/CSS/JS unmodified except one namespaced glosa
  bridge appended before `</body>`; strict CSP (`sandbox allow-scripts`, `connect-src 'none'`,
  separate origin) makes it safe even opened top-level and enforces "no external calls"; annotation via
  nonce-authenticated **MessageChannel** bridge to the parent (A3 §1-2). **Edit mode on class F**
  follows the generic **derived-from edge** (see R7) → opens the source artifact; if the artifact has no
  derived-from edge it is opaque (Read + Review only, no Edit).
- **Diff pane**: shadow-git diffs via diff2html; **full history** (compare any two checkpoints, `restore`
  with dirty-worktree guard) per the user scope decision (A6 §F31 3.B). Human vs session vs unknown
  attribution shown; writer-register labels.
- **Conversation viewer** = **read-only transcript view with an out-of-band composer** (F32): tails the
  registered session's transcript (registry path or exact provider-owned discovery, never a cwd→slug
  guess). Missing paths are derived by exact session identity within
  the provider’s configured transcript roots, retried when the mirror is requested, and confined
  before reading; missing or ambiguous matches do not prevent registration. Renders by event type
  (prose turns; collapsed tool chips; grouped subagents;
  meta hidden); vendored normalized `TranscriptEvent` layer with partial-line buffering, unknown-event
  quarantine, resume/clear/compact handling, tool-result caps (A2 §F16). **Fail soft**: any parse
  failure → "mirror unavailable — use the terminal", never worse; artifact/annotation workflow stays
  usable. Composer sends a NEW user message out-of-band via R4 (never writes the transcript). Attention
  state comes only from glosa's own `attention_request` entries (`glosa_ask`, `request-review`) —
  never a transcript stall heuristic, and no longer a provider signal: the `Notification` hook that
  carried "agent is waiting on you" went with the hooks (#152), and the #150 spike found no
  replacement in the plugin monitor's or MCP server's environment. The composer keeps
  one tab-scoped in-flight submission, clears only after `presented`, preserves newer edits, and shows
  an inline native session picker when multiple live explicit bindings are eligible.
- **Anchoring resolution contract** (A5 §F10/§F11): total `resolve(annotation, artifact, ctx) →
  source_range | pipeline_feedback | orphaned`. Fixed normalization (NFC, whitespace-fold, UTF-16
  offsets, uniqueness required). Class R = quote-in-stamped-line-range, else `block_range` guidance,
  else orphaned — **never pipeline_feedback**. Class F = manifest chunk → if `transformed:false` resolve
  within chunk lines (miss → `orphaned{quote_absent_not_transformed}`), if producer-declared
  `transformed:true` → typed `pipeline_feedback` to the producer. **Intent never rescues a bad mapping.**

### R7 — providers, adapters, and declarative workspace metadata
- **Agent-provider interface** (first-class v1 deliverable). Minimal interface (design stage may extend,
  not narrow):
  ```
  interface AgentProvider {
    id: string                                   // "claude-code" | "codex"
    detectSession(payload): SessionBinding | null    // from a session payload → {session_id, workspace, transcript_path?, source}
    capabilities(session): { push:bool, mcpPull:bool }   // evaluated per session at registration, never provider-wide
    deliver(session, entry): DeliveryResult      // uses the best available capability; result → journal delivery_attempt
    liveness(session): "alive" | "stale"         // lease/heartbeat, never kill(pid,0)
    transcriptPath(session): string | null       // explicit path or exact provider-owned discovery
    transcriptRoots?(): readonly string[]          // provider-owned confinement allowlist
  }
  ```
  v1 ships: **Claude Code provider** (`push` = a monitor is connected for this session; plugin MCP
  tools; transcript mirror) and a **Codex provider** (`push` = an app-server attachment is live for
  this exact thread). Both always have `mcpPull`; neither has `gate` or `boundaryDrain` any more (#152).
  Adding a CLI = a new provider, never a core change.
- **Content-adapter interface**: supplies artifact-class metadata, sidebar ordering, and generic
  **`derived-from(A→B, via process)`** edges. From an edge the core provides Edit-on-A→source-B,
  staleness, and class-F source resolution without knowing the workflow that produced either file.
- **`WorkspaceMetadataDescriptor` v1** is the durable public adapter input. It has an `id` and artifact
  entries containing a workspace-relative `path`, optional `class`, `order`, `derived_from {path,via}`,
  and `manifest {path,component}`. There is one active descriptor per workspace. Setting the same id
  replaces it atomically; a different id conflicts until the active descriptor is cleared.
- The daemon validates the complete descriptor before persistence: byte and entry limits, exact schema,
  unique paths, workspace confinement, no symlink components, and existence of every artifact,
  derived source, and manifest. A failed replacement leaves the previous descriptor intact. The active
  descriptor persists in daemon-owned workspace runtime state, reloads when the workspace opens, and
  invalidates connected SPA clients after set or clear.
- The descriptor is materialized behind the existing generic content-adapter interface. Manifest v1
  remains the class-F source-map authority; a transformed chunk's pipeline-feedback target is derived
  only from descriptor id, manifest component, chunk id, and source range. No external package or
  workflow logic enters glosa.
- **Core runs with zero adapters**: a plain directory yields an ordered file list and all generic
  viewer/annotation/editor behavior. Without a descriptor, HTML remains opaque Preview+Annotate.

### R8 — CLI + install  (detail: A6 full)
- Commands (all with `--json` + stable exit codes, A6): `open [--url]`,
  `resolve`, `apply-begin`, `request-review [--require-approval] [--wait]`, `inbox list|get|dismiss`,
  `metadata set|show|clear`, `session bind`,
  `token rotate|revoke`, `doctor` (16 enumerated checks incl. Claude-monitor suppression + transcript-root confinement + orphaned journal entries + the resolved workspace root, #146 + leftover `glosa init` config, #152), `status`,
  `forget <workspace> [--yes]` (the one supported whole-bus deletion primitive: removes a
  workspace's registration, journal, inbox, and shadow-git history — including any historical
  loose-file source sealed into it by adoption — while never touching work-tree files; refuses
  first on a live bound session, an unexpired apply lease, or an in-progress adoption, naming the
  blocker (mutually exclusive with adoption in both directions), previews exact paths before an
  interactive consent prompt, proves confinement for the whole deletion set before any durable
  marker or destructive step, resumes cleanly if interrupted mid-deletion, and is named explicitly
  by `doctor`/`status` while a resume is pending);
  internal `mcp`, `monitor`, `codex-attach`, and — for one release — `hook <event>` as a silent
  exit-0 stub (#152). **There is no `glosa init`.** Claude Code is wired by the plugin
  (`/plugin marketplace add davebream/glosa`, `/plugin install glosa`); Codex by
  `codex mcp add glosa -- glosa mcp`. `open` auto-creates the `.glosa/` scaffold and never writes
  agent configuration; a workspace with no connected session is shown as such by the SPA badge
  ("no session connected — annotations wait here") and by `doctor`'s `pending-delivery` line, never
  as "not initialized". A workspace remains usable SPA-only without any agent.

### R9 — attention model  (detail: A5 §F23)
- Agents **knock, never barge**: `attention_request` entries retain their immutable `message`, `action`,
  and `target` and surface as workspace-switcher badges plus an
  attention tray (+ optional OS notification, deferred if it complicates persistent state). The SPA
  **never** auto-switches workspace or steals focus. All completion paths advance through
  `delivered→seen→done`; repeated mutations are idempotent. Generic actions show **Done**.
  `request-review` defaults to action `review` and shows **Approve** / **Request changes**. The terminal
  `done.detail` is `{outcome:done|approved|changes_requested,response?}` with a bounded optional response;
  `request-review --wait` returns that structure. The attention badge is driven only by these
  `attention_request` entries; glosa has no provider-side "waiting on you" signal (R6, #152).
- `request-review --require-approval` opts one existing tracked artifact into explicit final approval.
  Its immutable request payload carries normalized `target_path` plus `approval_mode:true`; at most one
  non-terminal approval request may exist for that workspace/path. The matching artifact alone shows
  the final-approval action. Confirmation saves pending editor changes first, then terminal `done.detail`
  is exactly `{outcome:"approved",target_path,revision_id:source_sha256,completed_at}`. Later edits do not
  mutate or revoke that revision-bound verdict.

## 4. Non-functional  (detail: A6 §F30)
- **Platform: macOS-only v1** (Apple Silicon + Intel), pinned floors: macOS 13, Bun 1.2.7, Git 2.30,
  Claude Code 2.1.80 (plugin floor; rec ≥2.1.200), browser Chromium≥111/Safari≥16.4. Non-Darwin →
  exit 5.
- **Privacy**: loopback-only; zero telemetry/external runtime calls; class-F network egress blocked by
  CSP. (Manuscripts may hold special-category personal data — this posture is load-bearing.)
- **Robustness**: daemon crash loses nothing (journal-as-truth + fsync-before-ACK + replay; SSE
  reconnect replays from cursor; watcher catch-up on restart). Any face (push/MCP/CLI) failing changes
  which mechanism delivers, never whether the entry survives.
- **No build step** = no bundle/transpile + no native/compiled addons (`bun run` direct); Bun, system
  git, a browser are required host software (A6 §F30). Scrub `ANTHROPIC_API_KEY` from every spawned
  child env (the $1,800 footgun). Idle daemon < 100 MB RSS.

## 5. Task decomposition (epic order; each has a testable gate)
- **T0 — bootstrap**: create the repository; monorepo + lefthook/CI (`bun test` + typecheck); copy
  A1–A6 into the repo as `docs/appendices/`. Gate: CI green.
- **T1a — daemon lifecycle & API skeleton**: detached-daemon spawn/lock/handshake/port-discovery/
  shutdown (A5 §F13); full R5 auth (Host/Origin/Bearer/capability, `confinePath`); versioned route
  skeleton + `X-Contract-Version`. Gate: lifecycle + auth + attack-suite (A3 §5) unit/integration tests.
- **T1b — file bus & provenance**: inbox/journal(=truth)/replay/reconciliation (A4 §F04); picomatch
  matcher (A4 §F20); shadow-git + apply-lease attribution (A4 §F05/§F21); global workspace index +
  registry (A5 §F19). Gate: every lifecycle transition + crash-recovery (fault injection at each write
  boundary) + concurrency (two sessions/one cwd, duplicate resolve) + routing incl. parked-drain.
- **T2a — pin the Codex integration contract** (research sub-task, BEFORE the Codex provider build):
  verify current Codex CLI transport/transcript-file mechanics against real docs/source — the
  Plannotator-era "Codex Stop-hook + rollout-file parsing" note was the starting point, not gospel,
  and its hook-gate mechanism is retired with the hooks (#152). Output:
  `docs/research/codex-contract.md`, a concrete Codex provider contract (the app-server
  control-socket push mechanism and its `thread/resume`/`turn/start`/`turn/steer`/`turn/completed`
  shape, where Codex writes its transcript, and its role as an MCP client). Gate: a written
  contract the provider is built against.
- **T2 — providers & delivery**: agent-provider interface (R7); Claude Code plugin monitor + MCP server;
  **Codex provider** (per T2a; app-server push + MCP pull); `resolve`/`apply-begin`/MCP tools. Gate: each
  capability delivers for each provider; monitor-unavailable MCP fallback still delivers; journal records correct
  transport `outcome`.
- **T3 — SPA shell + class R viewer + three modes + diff/history**: handshake/pairing screens; switcher/
  sidebar/tabs/follow-mode; markdown Read/Review/Edit; streaming-SSE (fetch) with reconnect replay;
  idiomorph; diff2html with full compare + restore. Gate: E2E — annotate a live-updating md file (anchors
  correct, morph preserves scroll); edit-in-glosa attributed `human`; restore with dirty-guard; SSE
  reconnect loses no events; a concurrent writer's change on disk is never silently overwritten by
  a stale save — a merge is written only on the writer's explicit Keep mine, never automatically, and
  what it cannot carry (a conflicting block, or a conflicting source region between or around blocks)
  is named in the preview rather than dropped silently.
- **T4 — class F viewer**: separate-origin serving + capability + CSP + MessageChannel bridge (A3);
  source-preserving render; derived-from Edit→source; anchoring resolution (A5 §F11). Gate: E2E annotate
  the real rendered-preview fixture (renders within tolerance, its JS runs, network blocked); the full A3 §5
  attack suite; transformed-vs-verbatim chunk anchoring corpus.
- **T5 — conversation viewer**: transcript discovery via registry + `$CLAUDE_CONFIG_DIR`; normalized
  `TranscriptEvent` layer; typed rendering; out-of-band composer; fail-soft. Gate: fixtures incl. partial
  line, unknown event, resume/clear/compact, huge tool_result, and a corrupted line → graceful degrade.
- **T6 — generic metadata compatibility**: durable descriptor registration, adapter hydration,
  explicit session binding, class-F manifest resolution, API/CLI/MCP parity, and SPA refresh. Gate:
  malformed/conflicting/confined/symlink/rollback/restart tests plus neutral manifest fixtures.
- **T7 — external integration boundary**: an integration may call the public CLI/MCP contracts and
  produce manifest v1, but glosa never imports its package, state schema, paths, or workflow logic.
  Gate: compatibility exercised entirely through public contracts with no external code in this repo.
- **T8 — release gate = deterministic suites + private manual rehearsal**:
  - Deterministic suites (mandatory): storage/fault (kill daemon at each write step → one legal recovered
    state); concurrency; delivery (monitor/Codex push/reconnect, MCP pull fallback, parked/resumed); browser
    security (the A3 §5 attacks); anchor corpus (Polish combining chars, md markup, duplicate quotes,
    stale hashes, transformed HTML); transcript suite; **explicit-binding topology** (agent cwd differs
    from the artifact workspace and routing still succeeds); editor round-trip (a save re-serializes only the blocks the writer edited; everything else is byte-identical).
  - Manual rehearsal: copy maintainer-selected real source and rendered artifacts into an ignored
    workspace under `.context/`, rename them neutrally, and add only private descriptor/manifest marker
    data needed for one verbatim and one transformed region. Run an isolated daemon and a real Claude
    Code session from another cwd; bind it explicitly. Exercise human edit/provenance, verbatim source
    resolution and apply lease, transformed feedback without a source edit, parked drain, attention,
    conversation mirror/fallback, monitor/MCP delivery, and a local inert browser CSP probe.
    Record exact runtime versions and produce a sanitized report with separate T8 and v1-readiness results.
  - **v1 is done when the deterministic suites are green AND the manual rehearsal passes — not on one model run.**

## 6. Risks (build-relevant)
- Claude plugin monitors are unavailable in some host modes → live connection decides push capability and MCP pull remains the fallback (R4).
- Transcript format internal/unstable → isolated normalizer, fixture tests, fail-soft (R6/A2).
- `ANTHROPIC_API_KEY` outranks subscription OAuth in spawned contexts → scrub in every spawn; doctor warns.
- Codex provider is designed to the same interface as Claude's but its push-transport/transcript shapes
  differ → pinned by T2a's `docs/research/codex-contract.md` against real source, not the
  Plannotator-era snapshot.

## 7. Normative appendices (in repo as `docs/appendices/`)
- **A1** api-transport — HTTP contract, streaming-SSE, cursors/resync, capability URLs, versioning.
- **A2** claude-code-integration — plugin monitor, MCP fallback, registry, transcript tailer.
- **A3** security — two-origin split, CSP, MessageChannel bridge, token lifecycle, confinePath, Host/Origin table, attack→test matrix.
- **A4** filebus-concurrency — journal-as-truth durability, apply-lease attribution, shadow-git mechanics, picomatch matcher, slug.
- **A5** daemon-architecture — daemon lifecycle, workspace index, lifecycle state-transition table, anchoring resolution contract.
- **A6** cli-platform — command surface, exit codes, install surface, platform pins, checkpoint/restore, terminology.

## 7b. Deferred / future (explicitly NOT v1 — recorded so they are not re-litigated or lost)
- **tila as the state-relay home**: promote the proven inbox/journal/registry schemas into a tila vertical
  (multi-machine, unlocks phone/iPad annotation via tila's Cloudflare Worker). Decision point after v1
  proves the loop. glosa v1 uses local files only.
- **Hosted-shell / Electron / L2–L3 distribution**: the SPA-swappable-data-layer invariant (R6) is built
  now so these are later deploys, but no shell/hosted mode ships in v1.
- **"Make it a git repo" promotion**: one-click promote a workspace to a real repo (seeded from the shadow
  history) + optional GitHub remote. Future; needs an explicit privacy-consent moment.
- **Publishing an artifact externally** is an integration concern, not a glosa responsibility. glosa
  itself makes no external runtime calls.
- **Reference implementations for T5** (transcript viewer): `d-kimuson/claude-code-viewer` (MIT, live
  file-watching viewer) and `claude-code-parser` for protocol knowledge are steal-from references; the
  deliberate decision is **vanilla, not assistant-ui/React** (v2 §2 stack).

## 8. Glossary
- **glosa** — this product. **Artifact** — a document file (markdown, or self-contained rendered HTML).
  **Workspace** — the directory an artifact set lives in. **Session** — one interactive agent process
  working in a workspace. **Provider** — an agent-integration adapter (Claude Code, Codex). **Content
  adapter** — a generic adapter supplying artifact classes + derived-from edges. **Class R/F** —
  markdown glosa renders (anchors via stamps) / foreign pre-rendered HTML glosa must not restyle (anchors
  via manifest + quotes). **derived-from edge** — generic "A is a rendered/compiled view of source B"
  metadata an adapter declares; the core computes edit-source + staleness from it with no domain knowledge.
  **WorkspaceMetadataDescriptor** — the durable declarative metadata v1 document supplied through
  CLI/MCP. **External integration** — any process outside glosa that supplies metadata, binds sessions,
  or generates artifacts using public contracts only.

### Shadow-history loss recovery (#226)

Detected loss of the active shadow checkpoint refuses ordinary capture and fails the workspace doctor
check. The maintainer-selected policy is explicit repair: `glosa doctor --workspace <registered-slug> --repair-baseline` requests a daemon-owned, unknown-attributed baseline of current tracked files.
It preserves surviving history and immutable records, records the reason durably, and restores later
external-edit capture. Read-only diagnosis counts entries referring to missing checkpoints and
qualifies unassessable data. See A4 F21 for ownership, crash recovery and the limit when all evidence
of prior initialization is absent; A1 and A6 define the API and command.
