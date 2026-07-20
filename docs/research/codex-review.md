# glosa v1 — complete adversarial technical review

**Reviewed:** 2026-07-20  
**Primary build input:** `.kombajn/inbox/pitches/2026-07-20-glosa-v1-requirements.md`  
**Supporting artifacts reviewed:** architecture/options, session decisions, JSONL UI research, and Electron/Tauri research listed by the requirements document  
**Overall verdict:** **NEEDS-REWORK**

## 1. Executive summary

The product direction is coherent and valuable: glosa is a local daemon and browser workspace that treats document files as the durable coordination surface between a human and an independently running agent session. The PRD also makes several strong choices: the file bus, transport ladder, per-artifact viewers, fail-soft transcript mirror, separate shadow history, and explicit refusal to let agents steal focus all fit the stated workflow.

It is not yet safe to feed this document unchanged into an autonomous build. Several central contracts are either internally impossible, incompatible with browser or Claude Code behavior, or absent. The five highest-priority problems are:

1. **The first adapter cannot satisfy the core routing rule.** R2 says an artifact routes only to a live session whose `cwd` is its nearest ancestor. Real jethro sermon sessions and artifacts live in Claude plugin data outside the Claude process's project cwd. The existing jethro SessionStart hook already records the Claude `session_id` and exact `transcript_path` into the active sermon `state.json`, proving that an explicit association is necessary. The PRD neither consumes that association nor permits a provider-supplied workspace binding. In the real topology, jethro feedback can park forever even while the correct session is alive.

2. **The HTTP authentication contract cannot serve two required browser transports.** Native `EventSource` does not accept arbitrary `Authorization` headers, and an iframe navigation cannot attach the SPA's Bearer header. Yet R5 requires Bearer auth on all non-handshake requests while R5/R6 require authenticated SSE and a served foreign-HTML iframe. Additionally, executable foreign HTML served from the SPA's origin is dangerous if it can be opened outside the sandbox: it can then access the origin's token storage and API. The document needs a concrete authenticated streaming method and a separate-origin/capability design for class F.

3. **The provenance and transaction guarantees are stronger than the mechanism can provide.** A filesystem watcher cannot infer whether an arbitrary write came from a human or an agent. Glosa also has no “begin apply” operation, so it cannot checkpoint “before an agent applies an entry.” And `glosa resolve` cannot atomically append one file and replace another file: a process crash can leave `journal.ndjson` and the inbox status disagreeing. These are core promises, not edge cases.

4. **The delivery ladder is plausible, but its build contract is wrong or incomplete in critical places.** Channels really do provide inbound push, but a bare `.mcp.json` server in research preview must be selected with `--dangerously-load-development-channels server:glosa`; `--channels` is for allowlisted/plugin entries, and combining the two flags does not extend the development bypass. `asyncRewake` is real, but a SessionStart-launched watcher exits on the first wake and is not automatically rearmed. “Delivered” also lacks a transport-specific acknowledgement definition.

5. **The release rehearsal can be green while the product is broken.** T8 is machine-specific and model-nondeterministic. It does not exercise the real jethro cwd/plugin-data topology, crash points in file transactions, simultaneous hooks, repeated wakeups, hostile HTML, token isolation, partial JSONL writes, resume/compact behavior, duplicate anchors, or SSE reconnect gaps. A real Claude session is useful as a manual compatibility rehearsal, but it cannot be the sole hard release oracle.

These are fixable without abandoning the architecture. The required rework is to replace implicit associations with explicit schemas and state machines: a provider-owned session/workspace binding, a daemon startup protocol, a recoverable bus transaction protocol, an authenticated browser transport contract, a separate class-F origin, and deterministic acceptance suites alongside the real-session rehearsal.

---

## 2. Dimension 1 — complete analysis and document consistency

### 2.1 What the system actually is

Glosa v1 is a companion application, not an agent runtime. A user starts Claude Code normally in a terminal, usually inside cmux. A single Bun/TypeScript daemon runs beside the session and serves both a versioned local HTTP API and a vanilla-JS browser UI. The daemon knows about multiple directory-backed workspaces and multiple live agent sessions.

The durable coordination layer is per-workspace filesystem state under `.glosa/`:

- Individual inbox JSON files represent human edits, annotations, and requests for attention.
- An append-only NDJSON journal records lifecycle and delivery events.
- A separate Git directory checkpoints selected artifact files without touching a real repository.
- A session registry is populated from Claude Code hooks.

The browser UI provides four surfaces:

- A glosa-rendered Markdown viewer with source-line hints and selection annotations.
- A sandboxed iframe viewer for self-contained HTML generated by another pipeline.
- A shadow-history diff viewer.
- A read-only rendering of Claude's transcript JSONL plus a composer that injects a new message into the terminal session.

Feedback delivery is deliberately redundant. A session-owned MCP process can send an experimental Claude Code channel notification; an `asyncRewake` hook can wake an idle session; Stop, UserPromptSubmit, and SessionStart hooks can deliver at lifecycle boundaries; cmux can type a doorbell into a terminal as the universal last resort. The inbox is intended to remain authoritative regardless of transport.

The first specialized adapter recognizes jethro sermon state, orders artifacts by stage, identifies the canonical manuscript, associates speech-notes HTML with its source manifest, and routes comments on transformed output as pipeline feedback rather than pretending every selection maps to literal source text. A companion format-sermon patch is expected to add source ranges and preserve chunk identity into rendered HTML.

The CLI initializes hooks and MCP configuration, opens the browser with a pairing token, resolves inbox entries, requests human review, reports status, and diagnoses the installation. The SPA never steals focus; attention requests persist as badges until a human chooses to act.

That conceptual decomposition is good. The durable file state is separated from lossy notification transports, the daemon is separated from per-host shims, and jethro-specific interpretation is intended to remain outside the core.

### 2.2 Where the documents agree

The final requirements correctly incorporate most late decisions from the supporting documents:

- Companion topology and no desktop shell in v1 are consistent with the final options and Electron/Tauri research.
- The singleton daemon, one port, one token, and thin MCP shims follow options §11.3.
- Channels, asyncRewake, boundary hooks, and cmux are ordered according to the late delivery addendum and decision log.
- The final PRD follows the late “no sermon-week experiments” correction: Plannotator is not shipped or trialed, and release waits for an offline rehearsal.
- Annotations now use glosa's own inbox and journal rather than the earlier Agentation-only scaffold. This is consistent with the later “one annotation contract, N viewers” product architecture, even though it contradicts the earlier spine draft.
- Class R and class F viewers, manifest-first speech-notes provenance, transformed-content intent routing, and chunk threading follow the later anchoring findings.
- The conversation viewer is included, matching the late M4c amendment and addressing pain A rather than claiming artifact rendering alone fixes terminal dialogue.
- The attention model follows the settled “agents knock, never barge” decision.
- The class-F fixture paths, canonical manuscript fallback, and format-sermon title bug are carried into tasks.
- The no-shell decision and future preference for Electron do not leak into v1 scope.

### 2.3 Drift, contradictions, and stale decisions

The requirements are declared “self-sufficient,” but they still depend on live machine state and untranscribed schemas. T6 points to jethro TypeScript types as “schema authority”; T7 modifies a skill outside the target repository; T8 depends on absolute fixture paths and subscription authentication. A builder in a truly empty target repo cannot reproduce those inputs from the PRD alone.

The supporting documents also contain superseded decisions without a single consolidated precedence rule:

| Topic | Earlier supporting text | Later/final text | Review |
|---|---|---|---|
| Annotation transport | Options lines 95–96 and 145–147 say v1 annotations do **not** enter the inbox and Agentation is the one channel. | Requirements R3 makes `annotation` a first-class inbox kind. | The PRD follows the stronger final product architecture, but the options document must label §2.2/§2.4a superseded. Otherwise builders may copy the wrong transport and storage semantics. |
| Plannotator | Decisions lines 48 and 97–110 retain an “accepted” M1 trial. | Decisions line 131 and requirements lines 26–35 reject live experiments. | The PRD is correct; the accepted-decisions list is stale and contradicts the same file's final correction. |
| Delivery flags | Requirements R4 says Channels require `--channels` “+ dev flag”; R8 only prints a `--channels` hint. | Current official Channels reference distinguishes allowlisted `--channels` entries from bare development servers selected by `--dangerously-load-development-channels server:<name>`. | This is not harmless wording drift; the documented installation will not enable the proposed channel. |
| Validation cadence | Options §6 and decisions accepted item 9 use per-sermon milestones and a legitimate stop after M3. | The late amendment and PRD require full v1 before live use. | The PRD follows the latest decision, but old “success after 3–4 sermons” and stop-point language should be explicitly archived. |
| Workspace/worktree | Early options place `.desk` in a sermon session directory and use `artifacts/` as the Git work-tree. | R1 makes any directory a workspace and uses the whole workspace with artifact globs. | This is a substantial generalization, not a rename. Initialization, baseline, matching, and session association need to be re-specified for the broader model. |
| Parser target | JSONL research lines 29–35 explicitly says `claude-code-parser` parses stream-json, not transcript-file JSONL, and expects a mapping layer. | Requirements line 61 says to vendor its protocol knowledge for transcript typing; T5 treats that as the basis of the file viewer. | The PRD collapses two different formats. It must select or define a transcript-file schema adapter rather than implying the stream parser is directly suitable. |
| Package layout | Decisions line 123 suggests `packages/daemon / spa / adapters-jethro`. | Requirements line 63 specifies `packages/adapters/jethro`. | Minor naming drift, but build scripts and package names should use one canonical layout. |
| Privacy | Options lines 382 and decisions line 93 note that current speech notes are deployed publicly. | Requirements NFR promises no external runtime calls/uploads and class F runs document JS untouched. | Glosa can remain local, but foreign HTML may itself make network requests. The runtime privacy promise needs a browser-level policy, not just a daemon policy. |

The largest hidden contradiction is between jethro's real storage model and R2. The background options show a registered Claude cwd of `/Users/dawid/code/jethro`, while sermon data is under a separate sermon-session directory. Current jethro code confirms this is not hypothetical: its SessionStart hook reads `session_id` and `transcript_path`, finds the active sermon session in plugin data, and records the association there. R2 nevertheless makes “cwd is an ancestor of the artifact” authoritative. The adapter needs an explicit provider-supplied association that is at least as authoritative as cwd containment.

---

## 3. Dimension 2 — correctness and technical viability

### 3.1 Claude Code Channels — **SUPPORTED mechanism; WRONG integration contract**

The capability is real and plausibly does exactly what the design wants. Current official Claude Code documentation states that Channels require v2.1.80+, a stdio MCP server declares `capabilities.experimental['claude/channel']`, and it emits `notifications/claude/channel` with `{content, meta}`. Events can wake an idle running session. Meta keys are restricted; current docs say letters, digits, and underscores, while the PRD's stricter leading-letter/underscore rule is safe.

The requirements' activation instructions are wrong for the proposed packaging. During research preview:

- A bare server registered as `glosa` in `.mcp.json` is selected with `claude --dangerously-load-development-channels server:glosa`.
- `--channels plugin:...` is for an allowed/plugin-wrapped channel.
- The development bypass is per entry. Combining it with `--channels` does not make the normal `--channels` entries eligible.
- Project MCP consent and, for Team/Enterprise, organization channel policy can still block it.

Sources: [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference) and [Channels overview](https://code.claude.com/docs/en/channels).

R8 should either package an actual Claude plugin and specify its marketplace/install manifest, or keep the bare server and print the exact `server:glosa` development command. `glosa doctor` must inspect whether the current session actually registered the channel, not infer readiness from `.mcp.json`.

The delivery acknowledgement is also underspecified. A successful MCP `notification()` call proves that the shim wrote to its stdio connection, not that Claude incorporated or acted on the inbox item. The journal should distinguish `attempted`, `transport_accepted`, `presented`, and agent `acknowledged`, or at minimum define “delivered” separately for every rung. The notification should carry only an entry ID and safe summary; the agent must fetch authoritative content and acknowledge via a tool/CLI.

Dependence on Channels can remain acceptable only if it is treated as optional compatibility, not a release dependency. T2 currently says every rung must deliver, while the risk section says all tests pass with Channels disabled. Those gates conflict unless “channel contract test” and “required fallback delivery test” are separate gates.

### 3.2 Hook model — **SUPPORTED primitives; DOUBTFUL lifecycle design**

The named hooks and limits are supported by current official documentation:

- SessionStart receives `session_id`, `cwd`, `transcript_path`, `source`, and model. It supports `startup`, `resume`, `clear`, and `compact` matchers and can add context.
- SessionEnd exists, cannot block, and has a default overall budget of 1.5 seconds.
- UserPromptSubmit can add `additionalContext`; its default timeout is 30 seconds and timed-out output is discarded.
- Stop can return top-level `{"decision":"block","reason":"..."}` or hook feedback, does not run on user interrupt, is replaced by StopFailure on API failure, and is overridden after eight consecutive continuations.
- `asyncRewake: true` is real. A command hook running in the background can wake an idle session by exiting 2; stderr, or stdout if stderr is empty, becomes a system reminder.

Source: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

The PRD's use of those primitives is incomplete in three ways:

1. **No rearm protocol.** A watcher launched once by SessionStart exits when it wakes Claude. Official behavior does not automatically rerun that SessionStart hook. A second inbox entry in the same session therefore has no asyncRewake watcher. If rearming from Stop or another hook is intended, specify it, prevent duplicate watchers, and test multiple sequential entries. If a persistent supervisor is intended, it cannot keep the special captured asyncRewake process alive after using its exit code.

2. **No supported PID source.** The documented hook input does not contain the Claude process PID. `process.ppid` is not a stable contract because shell-form hooks and launch wrappers add intermediary processes. R2's `pid` and `kill(pid, 0)` liveness test need a documented acquisition method or a different lease/heartbeat model. SessionEnd cleanup alone is insufficient after crashes.

3. **Hook output shapes need exact schemas.** “Block-with-reason” is not a generic outcome. Stop JSON on exit 0, exit-code-2 stderr behavior, and UserPromptSubmit's `hookSpecificOutput` shape are different. T2 needs versioned fixtures for exact hook stdin/stdout and a minimum Claude version.

The eight-block cap is not itself a problem because the inbox persists, but Stop delivery must batch or page entries and must not count repeated already-delivered items as new transitions without a defined journal event.

### 3.3 Transcript tailing — **DOUBTFUL but viable as an optional viewer**

Claude Code officially stores transcripts under `$CLAUDE_CONFIG_DIR/projects/.../<session-id>.jsonl`, and hook input provides the exact `transcript_path`. It is therefore reasonable to build a best-effort local mirror. The fail-soft boundary is appropriate because the record format is internal and may change.

The current discovery design is unnecessarily fragile. The daemon may be started from an environment that does not share the session's `CLAUDE_CONFIG_DIR`, and converting cwd to Claude's project slug is an undocumented algorithm. R2's registry omits the exact `transcript_path` that SessionStart already supplies. Store that path in the session record and validate that it stays under an allowed Claude config root before opening it.

The chosen parser is also a mismatch. The supporting research explicitly says `claude-code-parser` targets `-p --output-format stream-json`, while glosa tails interactive transcript files. Useful concepts may be vendored, but the PRD needs a separate `TranscriptEvent` normalization contract based on real transcript fixtures.

Real tailing failure modes that are not covered:

- The last JSONL line can be partial while Claude is writing it. Buffer until newline; do not permanently fail the whole pane.
- Resume, `/clear`, fork, and compaction may change transcript path, add branches/sidechains, or replay records.
- Subagent transcripts may live in nested files and be referenced by `agentId`; they cannot be assumed to be inline.
- Tool results can be very large or polymorphic; cap retained DOM/data and escape all text.
- Unknown future event types should become safe “unsupported event” records, not corrupt the whole known prefix.
- A malformed completed line should be isolated with an error boundary and retry/resync behavior. The T5 “one corrupt fixture makes mirror unavailable” gate is too coarse.
- The viewer must correlate `tool_use_id`, parent UUIDs, snapshots, and sidechain flags rather than displaying append order as a simple chat.
- Quiet transcript plus process-alive is not a reliable permission-prompt detector. Claude's Notification/PermissionRequest/Elicitation hooks provide better signals and should update explicit session-attention state.

This viewer should remain isolated and degradable, but “fail soft” must mean the artifact and annotation workflow remains usable—not that one bad line silently disables pain A for the rest of the session.

### 3.4 Singleton daemon and shim design — **PLAUSIBLE; not buildable as specified**

Many stdio shims proxying to one long-lived local engine is a sound pattern. The missing piece is process ownership. “If not, the first one wins the lock and becomes it” is ambiguous and unsafe:

- A short CLI command must return; it cannot simply become a foreground daemon.
- An MCP shim is owned by Claude Code and will be killed when the host exits. If that shim is the daemon, the singleton is not long-lived.
- A detached child needs an explicit readiness handshake, log location, inherited-environment policy, shutdown policy, and stale-lock recovery.
- The lock must contain at least PID, selected port, daemon instance ID, and protocol version. Otherwise clients using different `GLOSA_PORT` values do not know where the winner listens.
- Lock acquisition, port bind, and readiness are separate steps. Define behavior for stale lock/live port, live lock/wrong process, and configured port already occupied by another service.
- Multiple hooks updating a per-workspace `registry.json` directly can lose entries. Registry changes should be serialized through the daemon or use an explicit compare/lock/atomic-replace protocol.

The daemon also lacks a persistent global workspace index. It cannot discover arbitrary directories “containing `.glosa/`” across the machine without search roots. It needs `~/.glosa/workspaces.json` (or equivalent) updated on open/session registration, with garbage collection for missing paths.

### 3.5 File bus concurrency and lifecycle — **WRONG atomicity claim; DOUBTFUL durability**

Atomic inbox creation via write-to-temp, fsync, and same-directory rename is sound. Appending one serialized line using one `write` on an `O_APPEND` descriptor is a reasonable local-filesystem journal technique. `PIPE_BUF`, however, is a pipe guarantee and is not the relevant bound for a regular file. The design still needs a maximum event size, a single-write loop handling short writes, process-level serialization for portability, fsync policy, and startup handling for an incomplete final line.

The statement that `glosa resolve` “appends the journal line AND rewrites the inbox entry's status atomically — one command, both writes” is false. No ordinary filesystem primitive atomically changes two separate files. A crash can occur after either operation. Choose one of:

- Make inbox records immutable and derive current status from the journal, using unique event IDs and replay.
- Make the journal a write-ahead log with `transition_requested` and `transition_committed`, plus idempotent recovery.
- Put lifecycle state in a transactional local database while keeping export/audit files.

Whichever is chosen must define idempotency, duplicate resolve behavior, legal transitions, corruption quarantine, and startup reconciliation.

The current state machine is also incomplete. An unacted `delivered` item is “re-surfaced,” but `delivered` is already a status, not a new transition. Record repeated `delivery_attempt` events without pretending the lifecycle moved again. `seen → done` for attention requests is not integrated with the common pending/delivered states, and payload/response schemas are absent.

### 3.6 Shadow Git provenance — **SUPPORTED storage mechanism; WRONG attribution guarantee**

A separate Git directory used with an explicit `--work-tree` can checkpoint a non-repository directory without touching a real repository. This is a technically reasonable provenance store. It needs deterministic initialization, a branch/ref, an initial baseline commit, explicit file lists, a per-workspace Git mutex, environment-supplied author/committer identity, and recovery from index locks.

The core attribution claim is not supportable from chokidar events. The watcher sees bytes changed; it does not know which process or person wrote them. Agent writes unrelated to an inbox entry, editor formatters, a format-sermon rerender, and human saves all look alike. Likewise, glosa cannot checkpoint “before an agent applies an entry” unless the agent first invokes a glosa begin/apply operation. `glosa resolve` happens after the edit.

Fix this by adding an explicit write lease/protocol, for example:

1. Delivery instructs the agent to run `glosa apply-begin <entry> --session <id>` before editing.
2. Glosa checkpoints the exact pre-state and records a scoped attribution lease.
3. The agent edits and runs `glosa resolve`.
4. Glosa checkpoints the post-state and attributes only the proven diff between those checkpoints to that session.
5. Other watcher changes remain `unknown` unless an editor integration or explicit human action proves authorship.

Do not label all unleased watcher events “human.” “Unknown/external” is required for honest provenance. Full provenance may still mean full version history plus the strongest available attribution, not fabricated certainty.

The “one tracked-artifact rule drives watcher, Git pathspec, and sidebar identically” also needs an implementation contract. Chokidar v4 removed glob support, Git pathspec semantics are not minimatch semantics, and a 2 MB size rule is not a pathspec. Use one canonical matcher library to produce an explicit normalized file set, then feed paths—not raw globs—to all consumers. Define symlink policy, case sensitivity, Unicode normalization, deletion, rename, and what happens when a file crosses the size threshold. See [chokidar's v4 upgrade note](https://github.com/paulmillr/chokidar).

### 3.7 Security model — **SUPPORTED foundation; insufficient and internally incompatible**

For the stated browser threat, binding only to `127.0.0.1`, validating exact `Host` and `Origin`, requiring a random Bearer token, and using no cookies is a strong foundation. Host validation addresses DNS rebinding; Origin validation and the non-simple Authorization header address drive-by fetches. Passing the token in a URL fragment keeps it out of the initial HTTP request.

It is not complete:

- **SSE:** native `EventSource(url)` accepts only a URL and `withCredentials`; it cannot attach the Bearer header. Use authenticated `fetch()` and parse an SSE stream, or define a short-lived one-use stream capability. Do not put the machine token in a query string. Bun also closes quiet SSE connections after its default idle timeout unless the server disables it or sends heartbeats. See [MDN EventSource constructor](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource) and [Bun SSE guidance](https://bun.com/docs/guides/http/sse).
- **Iframe:** an `<iframe src>` navigation cannot attach the Authorization header. The iframe and any resource it loads therefore conflict with “Bearer thereafter.” Define a narrow, expiring capability URL or a bridge that fetches authenticated bytes and serves them from an isolated origin.
- **Origin isolation:** sandboxing without `allow-same-origin` gives the iframe an opaque origin while embedded, which is good. But the same foreign HTML URL can be opened at top level, where the sandbox no longer applies. If it shares the SPA origin it can read token storage and call APIs. Serve class F on a distinct loopback origin/port with no ambient credential and a per-document capability. MDN explicitly warns that sandboxing is ineffective if hostile content can be displayed outside the sandbox. See [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).
- **Bridge authentication:** opaque-origin frames report an unhelpful/null origin. The parent must validate `event.source`, a per-load nonce, message schema, and size; the bridge must use a handshake rather than trust any `postMessage` sender.
- **Network privacy:** “document CSS/JS must run untouched” conflicts with “no external calls of any kind.” A self-contained HTML document can still contain `fetch`, images, forms, WebSockets, or navigation. Set and test a class-F response CSP (`connect-src 'none'`, tightly scoped image/font/style/script policy, no top navigation/forms/popups unless explicitly required), or weaken the privacy promise. Running inline document JS can be compatible with blocking network access.
- **Token lifecycle:** clear the fragment with `history.replaceState` immediately after import; specify storage (sessionStorage is safer than permanent localStorage), rotation/revocation, file permissions, log redaction, `Referrer-Policy: no-referrer`, CSP for the SPA, and token comparison behavior.
- **Path confinement:** every workspace-relative path must be canonicalized after resolving symlinks and rejected if it escapes the registered workspace. Otherwise the authenticated API, inbox, adapter manifests, or Git commands can read arbitrary local files or accept option-like paths.
- **Read routes:** the Origin rule currently says missing/foreign Origin is rejected only for state-changing routes, while the preceding sentence says every request is validated. Specify exact behavior for navigation, same-origin fetch, CLI requests with no Origin, and tokenless handshake. Add `Sec-Fetch-Site` checks as defense-in-depth, not as the primary control.

With these fixes, the local threat model is credible. It does not and should not claim protection against another process running as the same OS user.

### 3.8 Annotation anchoring — **SUPPORTED selector family; DOUBTFUL source mapping**

Quote, prefix/suffix, position, and structural scope are sensible selector components. Hash-gating position data and refusing to guess are good. The W3C model, however, does not define the exact DOM-text normalization implementation glosa needs, and multiple matches remain possible. The PRD must define:

- Whether offsets count UTF-16 code units, Unicode code points, or bytes.
- The exact rendered-text extraction algorithm: block separators, `<br>`, hidden content, punctuation, non-breaking spaces, Unicode normalization, and whitespace folding.
- Whether `prefix`/`suffix` are measured before or after normalization and how 40 characters are counted.
- A uniqueness rule: zero or multiple verified candidates must not auto-apply.
- Hash inputs: exact bytes, line-ending normalization, and whether a manifest hash covers source before or after frontmatter processing.
- Limits on annotation body and selector sizes.

Class R is not exact merely because blocks have `data-line`. Markdown syntax breaks rendered-to-source contiguity: a rendered selection across emphasis, a link, inline code, an entity, or a soft line break may not occur verbatim in source. A `data-line` stamp identifies a block start, not source columns or an inline range. Either build a Markdown source map at token/inline level, constrain automatic application to uniquely verified literal quotes inside a stamped source range, or deliver line-range-plus-quote as human/agent guidance rather than claiming an exact source edit.

Class F's manifest can map an element to a source chunk, not necessarily to an exact source span. For synthesized headings or transformed cues, “pipeline feedback” is the right category, but it is not an anchor resolution. The contract must say what the feedback targets, which adapter/pipeline component receives it, what an agent is expected to do, and how it becomes `applied`, `rejected`, or `stale`. `intent` cannot rescue a bad mapping on its own: a user may mark a transformed heading with content intent, or a quote may be missing because of Markdown markup rather than LLM synthesis.

The current resolver cascade also underuses prefix/suffix and position. A safer order is:

1. Validate document identity/hash and structural scope.
2. If the producer supplies a source map, obtain the candidate source range.
3. Within that range, resolve exact+context and require uniqueness.
4. Use position only against the exact same rendered representation/hash, then verify the extracted quote.
5. Run the precisely specified normalized match and require uniqueness.
6. If the producer declares the node transformed/synthesized, return typed `pipeline_feedback`.
7. Otherwise return `orphaned/stale`; never silently convert an unknown mapping failure into style feedback.

“Intent routing when quote not found” is sound as conservative triage only when the provenance sidecar identifies transformed content. It is not a general substitute for anchoring.

### 3.9 cmux injection — **SUPPORTED as a fallback; overstated reliability**

The newline sanitization and `ctrl+c` key syntax corrections are useful. The fallback still cannot safely type arbitrary annotation content. The surface may currently contain a shell, a permission dialog, a different program, or an unfinished multiline prompt. “Command accepted by cmux” does not prove “message submitted to the intended agent.”

Rung 4 should type a fixed, newline-free, non-secret doorbell such as `glosa inbox --session <opaque-id>` only after verifying surface ownership through a provider lease. It should never type a body, diff, shell metacharacters, or user-supplied path. Define timeout, retry, surface reuse, and acknowledgement. For non-Claude agents, “works for any CLI” must be softened to “transport adapter possible when a provider can register and acknowledge a surface”; no Codex/agy provider contract exists in v1.

---

## 4. Dimension 3 — completeness and buildability

The tables below simulate an autonomous builder in an empty `davebream/glosa` repository. “Blocking” means the builder must invent a load-bearing behavior or will build a materially wrong system. “Minor” means a reasonable default is possible but should still be specified for consistent acceptance.

### 4.1 Functional requirements R1–R9

| Group | Buildability verdict | Blocking gaps | Minor gaps |
|---|---|---|---|
| **R1 — singleton and workspace** | **Not buildable without invention.** | No daemon spawn/detach/readiness/stale-lock protocol; no config precedence when clients disagree on `GLOSA_PORT`; no global workspace index; no definition of canonical path/symlink/case handling; arbitrary include/exclude semantics cannot be shared directly by chokidar v4 and Git; no initial shadow baseline or behavior for read-only directories. The six-hex path hash is not “collision-free”; collisions require detection. | Define natural sort, size-unit semantics, rename/move behavior, workspace removal, config schema/version, port-conflict UX, maximum workspaces/watches, and whether moving a directory intentionally changes its slug. |
| **R2 — session registry** | **Blocking for jethro and transcript viewer.** | The hook has no documented Claude PID; registry omits `transcript_path`; `most-recently-active` is used in R3 but no `last_active_at` field or update source exists; direct concurrent JSON writes can lose sessions; cwd-ancestor routing cannot route jethro plugin-data artifacts; no provider binding/lease schema; no definition for nested workspaces or a session changing cwd. | Define stale lease threshold, process-permission errors, duplicate SessionStart, `/clear` and `/resume` transitions, picker persistence, and whether a hint may name a session whose cwd is not an ancestor. |
| **R3 — file bus** | **Core guarantees currently impossible.** | No JSON Schema/TypeScript discriminated-union definitions, schema version, migration policy, or event-detail schemas; cross-file “atomic” resolve is impossible; exact writer/transaction/idempotency rules are absent; watcher cannot infer human vs agent; no pre-agent checkpoint trigger; no initial baseline; no Git serialization; no corruption recovery; no explicit maximum entry/diff size despite always-inline diffs. | Define ID collision handling, timestamps/timezone, hash bytes, diff binary/rename/deletion behavior, no-newline markers, file mode/symlink handling, journal retention/compaction/export, and status-file formatting. |
| **R4 — delivery ladder** | **Primitives exist; interface is undefined.** | No `DeliveryAdapter` request/result/ack/error contract; no rung capability-detection or selection algorithm; Channel activation hint is wrong; no asyncRewake rearm; no meaning of delivered per transport; no concurrency/order/dedup/backoff policy; no safe fixed cmux doorbell; no behavior when picker is unresolved; Stop batch behavior under eight-block cap undefined. | Define summaries, maximum context size, retry schedule, UI visibility of degraded rung, channel consent diagnostics, and how transport attempts appear in status. |
| **R5 — HTTP API/auth** | **Cannot implement required clients consistently.** | No route/method/request/response/error schemas; native SSE and iframe cannot send Bearer headers; no class-F capability/origin; no exact Host/Origin lists; no path-confinement contract; no token rotation; no SSE cursor/resync contract; no API contract version or N/N-1 compatibility matrix. | Define HTTP status codes, ETags/ranges, content types, caching, request/body limits, rate/concurrency limits, CSP/security headers, graceful shutdown, and handshake `paired:true` behavior. |
| **R6 — SPA/viewers** | **Too many UI contracts are implicit.** | No client state/API model; no exact URL grammar; no authenticated SSE implementation; no Markdown sanitization policy; no selector normalization/source-map algorithm; class-F sandbox flags/origin/CSP/bridge protocol absent; “verbatim” conflicts with bridge injection; transcript normalized event schema absent; follow-mode depends on untracked session activity/writer identity; no handling for partial JSONL or unknown events. | Define tab persistence, loading/empty/error states, keyboard/accessibility requirements, annotation editing/deletion/listing, overlapping marks, mobile exclusion behavior, theme persistence, performance limits, and notification permission UX. |
| **R7 — jethro adapter** | **Cannot be correct under R2.** | No adapter interface/schema despite adapter boundary being load-bearing; recognition root is unclear because state lives in plugin data; no explicit jethro-session ↔ Claude-session association; state schema is only an absolute external code reference; stage ordering mapping absent; manifest version/schema absent; pipeline-feedback output contract absent; stale-render algorithm absent; T6 assumes companion fields before T7 creates them. | Define behavior for malformed/null canonical pointer, multiple active sermons, old sidecars, output selection among timestamps, missing format-sermon skill, and adapter version compatibility. |
| **R8 — CLI/install** | **Commands named, contracts missing.** | No distribution/PATH/minimum Bun/Git/macOS contract; `glosa init` merge semantics for existing settings/hooks/MCP config undefined; rollback/uninstall absent; exact Channel launch command wrong; daemon ownership after short CLI/MCP invocations undefined; command outputs/exit codes and machine-readable mode absent; doctor checks are not enumerated. | Define `--help`, logging/verbosity, config locations, status format, open behavior if browser fails, idempotence markers, backup policy, and trust/consent instructions. |
| **R9 — attention** | **State machine and payload absent.** | No `attention_request` payload (path, message, requested action, requester, deadline); common and `seen→done` lifecycles conflict; no response/verdict schema; `--wait` timeout/cancel/process-exit semantics absent; no SSE/API contract; no authorization distinction despite R5 mentioning decision routes. | Define badge counts, seen vs acknowledged, optional notification dedup, browser permission denial, expiration, requester death, and multiple human responses. |

### 4.2 Task decomposition T0–T8

| Task | Can an autonomous builder implement and evaluate the gate? | Missing decisions/dependencies |
|---|---|---|
| **T0 — repo bootstrap** | **Mostly, but external side effects and platform are unspecified.** | Creating a private GitHub repo requires credentials and explicit external-write authority. Package names, supported OS/CPU, Bun version pin, TypeScript config, formatter/linter, coverage, release packaging, license, and CI platform are unspecified. “Empty-but-wired” needs exact baseline commands and expected package entrypoints. |
| **T1 — daemon core** | **No. It aggregates most blocking architecture gaps.** | Must first resolve daemon lifecycle, global/workspace registries, provider binding, schemas, transaction recovery, provenance attribution, Git initialization/locking, canonical matching, API/OpenAPI contract, stream auth, and path security. “Every lifecycle transition” cannot be tested until a legal transition table and recovery semantics exist. Split T1 into daemon lifecycle, storage/state machines, shadow history, registry/routing, and authenticated API contracts. |
| **T2 — delivery and faces** | **The gate can produce false confidence.** | A scripted fake session can test glosa's MCP messages but cannot prove Claude Code registers a research-preview Channel and wakes a real idle session. It also cannot prove asyncRewake rearming or cmux focus ownership unless those are explicitly modeled. “Killing rungs 1–3” only works if a real rung-selection/timeout state machine exists. Add protocol contract tests, repeated-event tests, and a version-pinned real-Claude compatibility test that is not the deterministic unit gate. |
| **T3 — SPA/class R/diff** | **Not without R5/R6 decisions.** | Native EventSource cannot meet auth as written. “Correct anchors” is undefined for Markdown inline markup and duplicate quotes. “Morph preserves scroll” needs a measurable tolerance, selection/popover cases, and browser viewport. Diff selectors require checkpoint query semantics and timezone/day boundaries not defined in the API. Handshake screens depend on a compatibility matrix. |
| **T4 — class F** | **No secure gate is defined.** | “Verbatim”/“byte-identical” conflicts with injected bridge bytes; visual regression is not byte identity. Sandbox flags, separate origin, capability auth, CSP, bridge nonce/protocol, top-level navigation, external network requests, and original document CSP are unspecified. “Document's own JS still works” needs named fixture behaviors and an allowed-capability list. |
| **T5 — conversation viewer** | **Fixture rendering alone is insufficient.** | Must store `transcript_path`, define normalized transcript events, handle partial lines/rotation/resume/compact/sidechains/large results, and establish safe rendering. A fully corrupted fixture does not test incremental corruption recovery. Composer semantics differ between Channel events and terminal user prompts and need acceptance. Attention heuristic needs a hook-backed signal or explicit known limitations. |
| **T6 — jethro adapter** | **Blocked by routing and unavailable build inputs.** | The referenced real fixture and schema authority are outside the new repo and unavailable to CI. The actual jethro hook-to-sermon association is omitted. Manifest-first fields do not exist until T7. Copy sanitized/versioned fixtures and adapter contracts into glosa before implementation. Gate both real topology (repo cwd, plugin-data workspace) and synthetic generic topology. |
| **T7 — companion diffs** | **Human gate is legitimate but operationally underspecified.** | Specify base commit/version of format-sermon, patch artifact location, how the autonomous repo records an external patch, user approval/resume protocol, rollback, and regenerated fixture destination. “Old outputs still render” needs fixture matrix and expected output normalization. T7 must complete before T6/T8 assertions depend on new manifests. |
| **T8 — rehearsal** | **Not a sufficient hard release gate.** | Absolute private paths and subscription login make it nonportable. Real model behavior is nondeterministic; no prompt, timeout, retry, model/version, permission mode, or expected edit is fixed. Starting Claude “in” the copied artifact workspace avoids the actual jethro repo-cwd/plugin-data routing problem. Research-preview consent dialogs impede scripting. It omits crash recovery, concurrency, multiple same-cwd sessions/picker, repeat wake, channel-disabled fallback, hostile HTML/network blocking, API attacks, token rotation, SSE reconnect, partial transcripts, resume/compact, duplicate anchors, symlink escapes, and unknown writer attribution. Use a deterministic fake-agent acceptance suite plus a separately reported manual real-Claude compatibility rehearsal. |

### 4.3 Missing cross-cutting specifications

Before autonomous decomposition, add these artifacts to the PRD or as normative linked appendices copied into the glosa repo:

1. Versioned JSON Schemas (or TypeScript + generated JSON Schema) for workspace config, daemon lock/metadata, workspace registry, session/provider lease, every inbox kind, every journal event, manifests consumed by adapters, normalized transcript events, bridge messages, and API errors.
2. A legal inbox/attention state-transition table with writer, idempotency key, recovery behavior, and meaning of delivery attempt versus acknowledgement.
3. An OpenAPI-like HTTP contract including authenticated fetch-streaming, SSE event IDs/resync, class-F capability issuance, route authorization, and path canonicalization.
4. A daemon process-state diagram covering lock acquisition, spawn, readiness, proxy, shutdown, stale recovery, port conflict, upgrade, and incompatible client behavior.
5. An internal session-provider interface that can bind a Claude session to workspaces outside cwd and supply liveness, transcript path, activity, and optional terminal surface.
6. A canonical artifact-matcher specification and explicit-file-set implementation strategy.
7. A source-selector normalization and uniqueness specification with fixtures containing Polish Unicode, Markdown markup, repeated quotes, transformed HTML, stale hashes, and chunk sidecars.
8. A security appendix defining the SPA origin, class-F origin, CSPs, sandbox tokens, capabilities, postMessage handshake, token lifecycle, and network privacy policy.
9. Supported platform and minimum versions: macOS version, Bun, Git, Claude Code, cmux, Chromium/c​​mux browser, and whether non-cmux terminals are supported only through hooks.
10. Deterministic acceptance harness protocols separated from manual compatibility rehearsals.

---

## 5. Dimension 4 — adversarial risk assessment

### 5.1 Most likely real-world failure sequence

The most likely first failure is not Channels churn. It is association drift:

1. Claude runs from the jethro project cwd.
2. The active sermon and speech notes live under plugin data or an Obsidian/output path outside that cwd.
3. Glosa creates an annotation entry in that artifact workspace.
4. R2 finds no live session whose cwd is an ancestor, so the item parks.
5. A later SessionStart in the jethro repo still does not have the sermon workspace as its cwd, so the parked entry never drains.
6. Tests remain green because T8 starts Claude inside the copied artifact directory, a topology that does not match production.

This failure defeats the central promise while every individual component can appear healthy. Fix it before task decomposition.

### 5.2 Experimental Channels are not the main risk—but can hide delivery defects

The architecture wisely retains lower rungs, so protocol churn need not threaten data durability. The risk is observational: if the implementation marks entries delivered when it merely writes a Channel notification, failures look successful. Conversely, a development flag/consent mistake may silently downgrade every real run to cmux, while tests exercise only a mocked Channel.

Make Channels an optional capability with a visible status and exact diagnostics. Release correctness should be defined as: an entry survives, is eventually presented through at least one supported non-preview route, is acknowledged or remains visibly pending, and transport attempts are auditable. A real Channel smoke test should be version-pinned and allowed to fail as “unsupported” without invalidating the durable loop.

### 5.3 The transcript mirror can become a permanent maintenance tax

Fail-soft limits blast radius, but the mirror is one of the four stated pain fixes and the composer makes users treat it as a conversation client. An undocumented transcript change can remove pain A overnight while the rest of glosa still passes. Rendering fixtures alone will lag real format changes.

Mitigate with:

- Exact transcript paths from hooks.
- A small normalized event boundary and a raw-event quarantine.
- Fixture capture by Claude version with sensitive content scrubbed.
- Metrics visible locally in doctor/status (unknown event counts, parse offset, last successful event), without telemetry.
- Hook-derived attention state rather than transcript-only inference.
- A prominent terminal fallback and no claim of full UI parity.

If schedule pressure requires a cut, cut the permission-stall heuristic and rich subagent grouping before cutting safe parsing or the basic dialogue/tool-call mirror. Do not silently call pain A solved if T5 is removed.

### 5.4 Green tests that do not mean “works”

- Mocking cmux command success does not prove the right program owned the surface or received the text.
- Mocking MCP notification success does not prove Claude registered a Channel, woke, or saw the entry.
- A single asyncRewake test does not prove the watcher is rearmed for a second event.
- A watcher test that labels every unleased write human does not prove provenance.
- A process test of `glosa resolve` without crash injection does not prove journal/inbox consistency.
- A screenshot of sandboxed HTML does not prove token isolation, no external requests, or safety when opened top-level.
- A recorded transcript fixture does not prove live partial-write, resume, compact, or unknown-version behavior.
- One unique prose quote does not prove Markdown or transformed-output anchoring.
- Starting Claude in a copied sermon folder does not prove jethro's real out-of-cwd adapter routing.
- A reconnecting SSE socket does not prove missed events are recovered without event IDs/refetch.
- Git commits with chosen author names do not prove the corresponding process wrote the bytes.

Acceptance gates should assert user-observable invariants and include fault injection at state boundaries, not only successful component calls.

### 5.5 Security attacks the current plan permits or fails to define

1. Open the class-F URL in a new tab. If it shares the SPA origin, its scripts are no longer sandboxed and can read the token store.
2. Put a remote `<img>`, `fetch`, WebSocket, form, or redirect in a “self-contained” document. The browser leaks that the document was opened and potentially its content unless CSP blocks it.
3. Send a forged `postMessage` from another child/window. Without `event.source` plus nonce validation, create a fake selection or annotation.
4. Place a symlink inside a workspace that points outside. Without realpath confinement, content/Git/API operations escape the workspace.
5. Use a filename beginning with `-` or containing control characters in a Git/CLI path. Without `--` and argv-safe spawning, it can become an option or corrupt a doorbell.
6. Inject HTML through an artifact name, Markdown HTML, annotation body, transcript event, or tool result. Every renderer needs contextual escaping and CSP.
7. Let a malicious local site issue simple navigations or frame probes to class-F/handshake routes. Exact Host/Origin, frame policies, token/capability requirements, and no readable unauthenticated state must be consistent for reads as well as writes.
8. Leave the fragment token in history or permanent localStorage. A same-origin compromise or browser extension obtains machine-wide access until manual file deletion.

These tests belong in T3/T4/T8, not in a future hardening phase.

### 5.6 Scope assessment

The core v1 is ambitious but defensible if the requirements are converted into contracts. The current task plan tries to ship a daemon, recoverable event store, Git provenance engine, four delivery methods, authenticated API, four viewers, transcript parser, annotation system, adapter framework, external compiler patch, and a CLI in one release. Autonomous implementation capacity does not remove integration uncertainty.

Items that should be cut or explicitly demoted:

- Treat Channels as experimental compatibility, not a required rung gate.
- Cut the transcript permission-stall heuristic in favor of hook-fed explicit signals.
- Defer “between any two checkpoints,” “since yesterday,” and restore UI unless they receive API/state acceptance criteria; keep one current-vs-baseline diff first.
- Defer generic Claude Desktop/Codex portability claims. Keep an internal provider interface, but v1 only needs the Claude Code provider plus cmux fallback.
- Defer optional OS notifications until persistent attention state is correct.
- Do not promise full human/agent attribution for unleased filesystem writes; ship `human`, `session:<id>`, and `unknown` only where evidenced.

Items apparently cut but secretly required:

- A provider-specific workspace/session association for jethro.
- A daemon supervisor/startup and discovery protocol.
- A recoverable transaction model for inbox/journal state.
- A secure class-F serving origin/capability model.
- Exact transcript path registration.
- A begin/apply lease if session attribution is a release promise.
- Versioned fixtures copied into the target repo rather than absolute live paths.
- An explicit internal adapter/provider interface even if a public SDK is out of scope.

### 5.7 What a sufficient release gate should be

Keep the real T8 rehearsal, but make it the final manual compatibility layer over deterministic gates:

1. **Deterministic storage/fault suite:** kill the daemon after each step of inbox creation, journal append, status replacement, Git add/commit, and registry update; restart and assert one legal recovered state.
2. **Concurrency suite:** simultaneous hooks, two sessions in one cwd, nested workspaces, duplicate resolve, watcher activity during apply, and Git lock contention.
3. **Delivery suite:** two consecutive asyncRewake events, Channel disabled/unregistered, Stop cap, UserPromptSubmit timeout, stale cmux surface, no cmux, parked/resumed, and transport acknowledgement semantics.
4. **Browser security suite:** malicious Origin/Host, missing token, DNS-rebinding-shaped Host, SSE auth/reconnect, top-level class-F URL, remote subresource attempts, postMessage spoof, CSP, XSS payloads, and symlink/path traversal.
5. **Anchor corpus:** unique/duplicate quotes, Polish combining characters, Markdown links/emphasis/code, stale source/render hashes, transformed headings, missing manifests, and multiple chunk candidates.
6. **Transcript suite:** partial line, unknown event, huge tool result, subagent file, resume, clear, compact, replacement/truncation, config-root override, and safe recovery after corruption.
7. **Actual jethro topology suite:** Claude cwd is the jethro repo while the sermon workspace is plugin data; provider binding routes the correct entry and transcript.
8. **Manual real-Claude rehearsal:** pin Claude version/model/mode, record exact commands/prompts/timeouts and consent steps, run with Channels enabled and disabled, and produce a signed-off compatibility report. Model edits are reviewed outcomes, not deterministic test assertions.

The release definition should be “deterministic invariants pass and the current supported Claude/cmux versions pass the manual compatibility rehearsal,” not “one model run happened to complete.”

---

## 6. Prioritized findings

| ID | Severity | Dimension | Doc + location | Problem | Concrete fix |
|---|---|---|---|---|---|
| **F01** | **BLOCKING** | Analysis / correctness | Requirements R2 lines 100–103; R7 lines 218–234; glossary lines 339–349 | “A file resolves to the live session whose cwd is the nearest ancestor” cannot route real jethro artifacts stored in plugin data outside the jethro repo cwd. The existing jethro hook records the necessary Claude-session ↔ sermon-session association. | Add a versioned provider binding `{provider, session_id, workspace_path, transcript_path, lease, evidence}`. Make an explicit live provider binding authoritative before cwd fallback. Add an actual jethro-topology acceptance test. |
| **F02** | **BLOCKING** | Correctness / security | R5 lines 169–180; R6 lines 189–197 | The SPA must send a Bearer token on every API request, but native EventSource and iframe navigation cannot attach it. Required SSE and class-F serving therefore cannot both satisfy auth. | Specify authenticated `fetch` streaming for SSE. Serve class F from a separate loopback origin using a narrow expiring document capability and a nonce-authenticated bridge; never expose the machine token in a URL. |
| **F03** | **BLOCKING** | Correctness / security | R6 lines 192–197; NFR lines 254–255 | Executable foreign HTML is served under the SPA origin and is safe only while sandboxed. Opened top-level, it can access same-origin token storage/API. Its JS can also make external calls, contradicting “no external calls.” | Use a distinct origin/port with no ambient credential; deny/neutralize top-level use; set a tested CSP blocking network, forms, popups, and top navigation while allowing only required inline assets; add hostile fixture tests. |
| **F04** | **BLOCKING** | Correctness | R3 lines 137–146 | “Appends the journal line AND rewrites the inbox entry's status atomically” is impossible across two files. A crash can produce contradictory state. | Make journal authoritative/immutable or define a write-ahead two-phase transition with event IDs, fsync, atomic rename, idempotent replay, and startup reconciliation. Fault-inject every boundary. |
| **F05** | **BLOCKING** | Correctness | Goal lines 3–6; R3 lines 127–146; diff UI lines 198–200 | A watcher cannot know whether bytes were written by a human or agent. Glosa also cannot checkpoint “before an agent applies” because no pre-edit command exists. “Full provenance” and author labels can be false. | Add `glosa apply-begin`/MCP begin lease and post-resolution checkpoint correlation. Attribute only proven intervals; label all other writes `unknown/external`, not human. |
| **F06** | **BLOCKING** | Correctness / buildability | R4 lines 148–154; R8 lines 237–244; T2 lines 276–279 | Channels exist, but the activation instructions are wrong for a bare `.mcp.json` server. `--channels` plus a dev flag does not authorize it; a development server needs `--dangerously-load-development-channels server:glosa`, or glosa must be a plugin. | Choose bare-server or plugin packaging. Specify exact config/command/consent/org-policy behavior and make doctor verify actual registration. Separate optional Channel smoke tests from required fallback gates. |
| **F07** | **BLOCKING** | Correctness / buildability | R4 lines 155–160; T2 lines 276–279 | A SessionStart `asyncRewake` process exits on its first wake and is not automatically rerun. Repeated inbox entries can silently lose rung 2. | Define a rearm state machine tied to a documented hook event or revise the transport. Prevent duplicate watchers with per-session leases and test at least three sequential wake cycles plus restart. |
| **F08** | **BLOCKING** | Completeness | R2 lines 94–103; R6 lines 201–211 | Registry requires `pid` but hook input has no documented Claude PID; it omits exact `transcript_path`; and R3 uses “most-recently-active” without storing/updating activity. | Replace PID-only liveness with a provider lease/heartbeat and optional verified PID. Persist `transcript_path`, `last_active_at`, source, provider, capabilities, and lease expiry from hooks/provider events. |
| **F09** | **BLOCKING** | Completeness / security | R5 lines 169–182; T1 lines 272–275 | Route names are listed but request/response/error/auth schemas do not exist. A builder must invent the public contract, path validation, SSE replay, and N/N-1 behavior. | Add a normative versioned OpenAPI-like contract, schemas, status codes, limits, event IDs/resync, compatibility fixtures, and canonical path-confinement rules before T1. |
| **F10** | **BLOCKING** | Correctness | R6 lines 184–216; R3 lines 133–136 | `data-line` plus a rendered quote does not exactly map Markdown inline syntax to source; offsets/normalization/duplicates are undefined. Missing source quotes are not always LLM transformations. | Specify rendered-text normalization and uniqueness. Add token-level source maps or restrict automatic apply to unique verified literals in a stamped source range; otherwise return guidance/orphaned, not a guessed edit or pipeline intent. |
| **F11** | **BLOCKING** | Correctness / buildability | R7 lines 224–234; T6 lines 291–299 | A chunk manifest maps transformed HTML to a broad source chunk, not an exact source edit. “Intent routing” has no typed output, target, or resolution semantics, and T6 depends on fields not created until T7. | Define `resolve → source_range | pipeline_feedback | orphaned`, a pipeline-feedback schema/recipient, manifest versions, and task dependency T7→T6 for new fields. Require producer-declared transformed nodes. |
| **F12** | **BLOCKING** | Completeness | R3 lines 105–109; R9 lines 246–250; R8 line 240 | `attention_request` has no payload or response schema, and `seen→done` conflicts with the common lifecycle. `--wait` timeout and cancellation cannot be implemented consistently. | Define a discriminated payload, unified legal state machine, human response/verdict, requester/session, deadline, timeout exit codes, cancellation, persistence, and API/SSE events. |
| **F13** | **BLOCKING** | Correctness / buildability | R1 lines 72–79; monorepo line 64; options §11.3 | “First shim wins the lock and becomes” the daemon does not define how a short CLI returns or how a host-owned MCP process survives host exit. Port override also prevents clients from locating the winner. | Specify a detached daemon supervisor, lock metadata, readiness handshake, logs, environment scrubbing, stale recovery, port discovery/conflict behavior, upgrade/shutdown, and shim lifecycle. |
| **F14** | **BLOCKING** | Risk / release | T8 lines 303–315 | The hard release gate is nondeterministic, machine-specific, and uses a topology that can bypass the jethro routing defect. It omits crash, concurrency, security, and format-evolution failures. | Make deterministic fake-agent/fault/security suites mandatory. Keep a version-pinned manual real-Claude rehearsal as an additional compatibility report, using actual jethro cwd/plugin-data topology and Channels-on/off runs. |
| **F15** | **MAJOR** | Correctness | Requirements line 61; R6 lines 201–211; JSONL research lines 29–35 | `claude-code-parser` targets stream-json, not interactive transcript-file JSONL. Direct adoption will misparse or omit file-specific records. | Define a separate transcript normalization adapter based on scrubbed real fixtures; vendor only reusable concepts. Record parser compatibility by Claude version. |
| **F16** | **MAJOR** | Correctness / robustness | R6 lines 201–211; T5 lines 287–290 | The tailer has no contract for partial lines, unknown events, rotation/truncation, resume/clear/compact, sidechains, nested subagents, or large tool results. One corrupt line can permanently remove the pane. | Buffer partial lines, isolate bad completed records, cap data, resync on path/size/inode changes, model branches/tool IDs, preserve known prefix, expose diagnostics, and test all lifecycle cases. |
| **F17** | **MAJOR** | Correctness / robustness | R5 lines 179–180; R6 lines 189–190; NFR lines 256–260 | SSE reconnect is asserted without cursor/replay/resync, and Bun closes quiet streams by default unless configured. Updates can be lost or connections churn. | Disable Bun idle timeout or heartbeat; use fetch-streaming with event IDs; on reconnect refetch authoritative snapshot then resume after a cursor. Test network drops and daemon restart. |
| **F18** | **MAJOR** | Security | R6 lines 192–197 | The sandbox flags and postMessage trust model are absent. Opaque-origin frames cannot be authenticated by origin alone, and any child/window may spoof messages. | Specify exact sandbox tokens; validate `event.source`; issue a per-load nonce; schema/size-check messages; use a MessageChannel/handshake; forbid top navigation/popups/forms unless tested. |
| **F19** | **MAJOR** | Correctness / completeness | R1 lines 77–91 | There is no global workspace index, so the daemon cannot enumerate arbitrary directories containing `.glosa/`. Per-workspace registry files also cannot safely coordinate global routing. | Add an atomic `~/.glosa/workspaces.json` registry with canonical paths, slugs, last seen, and garbage collection; serialize session routing in the daemon. |
| **F20** | **MAJOR** | Correctness | R1 lines 80–85; fixed tech lines 59–60 | Chokidar v4 has no glob support; Git pathspec and minimatch semantics differ; file size is not a pathspec. Three consumers will drift despite the stated invariant. | Define one canonical matcher and produce an explicit normalized file list for watcher filtering, sidebar, and `git add -- <paths>`. Add cross-consumer conformance fixtures. |
| **F21** | **MAJOR** | Correctness | R3 lines 137–146; R1 lines 88–91 | Shadow Git lacks baseline/ref/index locking/recovery semantics. Concurrent watcher and agent checkpoints can hit index locks or produce wrong before/after refs. | Define initialization and first baseline, one Git mutex per workspace, argv-safe commands, explicit author/committer env, lock recovery, deletion/rename handling, and checkpoint idempotency. |
| **F22** | **MAJOR** | Correctness | R4 lines 161–167 | cmux command success does not prove the intended agent owns the surface. Typing user content into a shell/dialog can execute or corrupt input; newline stripping also mutates content. | Send only a constant safe doorbell containing an opaque ID, require a live provider/surface lease, never type content, and distinguish attempted/presented/acknowledged. Test stale/reused surfaces. |
| **F23** | **MAJOR** | Correctness | R3 lines 105–142; R4 lines 165–167 | Lifecycle status and transport attempts are conflated. Re-surfacing an already `delivered` entry is not another legal transition, and “delivered” means different things per rung. | Publish a transition table and separate lifecycle from `delivery_attempt` events. Define idempotency and acknowledgement per adapter; allow repeated attempts without rewriting terminal status. |
| **F24** | **MAJOR** | Security | R5 lines 169–178; R6 all viewers | Token import/storage/rotation, SPA CSP, escaping, security headers, and symlink/path traversal are unspecified. Same-origin XSS gains machine-wide API access. | Clear the fragment immediately, prefer session storage, add rotate/revoke, redact logs, set CSP/Referrer-Policy/frame headers, escape every renderer, realpath-confine paths, and add XSS/traversal tests. |
| **F25** | **MAJOR** | Completeness | R1 lines 86–87 | `sha256(path)[:6]` is only 24 bits and is not “collision-free.” A collision can alias workspace URLs and data. | Detect collisions against the global registry and lengthen the suffix deterministically until unique; treat canonical path as identity and slug as a route label. |
| **F26** | **MAJOR** | Completeness | R8 lines 236–244 | `glosa init` may clobber or duplicate existing hooks/MCP config, cannot uninstall, and prints the wrong channel hint. Command outputs/exit codes are unspecified. | Define AST/JSON merge ownership markers, backups, idempotence, uninstall/rollback, exact hook configs, channel command, minimum versions, stable exit codes, and `--json` output. |
| **F27** | **MAJOR** | Completeness / buildability | T6 lines 291–299; T7 lines 300–302; T8 lines 303–307 | Acceptance depends on private absolute paths and external schemas/skill code unavailable in a clean repo or CI. T7's approved patch artifact and base version are not defined. | Copy sanitized, versioned fixtures and schema snapshots into glosa; record provenance/base commit; emit external patches to a specified artifact path; define HITL resume and regenerate checked-in fixtures. |
| **F28** | **MAJOR** | Analysis / requirements quality | Requirements lines 13–17; options lines 95–96, 145–147, 326; decisions lines 41–54 and 119–131 | Background docs retain mutually exclusive “accepted” paths—Agentation-only annotations, Plannotator trial, stop after M3—while the PRD follows later amendments. Autonomous agents may reuse stale sections. | Add a supersession notice/table to supporting docs or publish one consolidated ADR set. State that late plan-philosophy and final PRD override named earlier sections. |
| **F29** | **MAJOR** | Risk / scope | Goal lines 21–28; R6 lines 201–211; T5 | Conversation mirror is part of claimed pain-A success but is allowed to disappear entirely on parse failure; rich heuristic/grouping scope distracts from safe core parsing. | Define a minimum supported mirror contract and version compatibility; cut permission heuristics first; keep terminal fallback explicit; do not mark pain A satisfied when current version is unsupported. |
| **F30** | **MAJOR** | Completeness | Whole PRD; NFR lines 261–265 | Supported OS and exact dependency versions are unstated despite cmux/macOS paths, system Git, Bun, Chromium, Claude preview behavior, and zero-native-dependency claims. | Declare macOS-only v1 if intended, with minimum pinned Bun/Git/Claude/cmux/browser versions and upgrade compatibility policy; clarify what “no build step” and “zero native compile dependencies” exclude. |
| **F31** | **MINOR** | Completeness | R6 lines 198–200; R1 lines 90–91 | UI vocabulary mentions “restore” and diff queries “since yesterday/between any checkpoints,” but no restore route/task or timezone/query semantics exist. | Either remove/defer these claims or add checkpoint query/restore API, dirty-worktree confirmation, timezone rules, and acceptance tests. |
| **F32** | **MINOR** | Requirements quality | R6 lines 192–207; T4 lines 284–286 | “Renders ... verbatim,” “bridge injected,” “byte-identical visual regression,” and “read-only mirror + composer” use contradictory/imprecise terminology. | Say source document semantics/styles are preserved subject to sandbox/CSP; test screenshot/DOM behavior rather than byte identity; call the transcript view read-only with an external message composer. |

## Final recommendation

Do not start the autonomous epic from the current PRD. First resolve F01–F14 and add the normative schemas/protocol appendices. Then restructure T1/T2 around those contracts and make the deterministic acceptance suite a prerequisite for the manual T8 rehearsal. With those changes, the fundamental architecture is viable and the remaining risks are appropriate for a v1 companion product.
