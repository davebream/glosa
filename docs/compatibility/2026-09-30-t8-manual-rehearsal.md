# T8 manual compatibility rehearsal · 2026-09-30

## Decision

| Decision | Result | Reason |
|---|---|---|
| Deterministic gate | **PASS** | The main-branch CI run on the candidate commit ran the full T8 deterministic profile and passed. |
| Manual rehearsal | **FAIL** | Two scenarios that passed on 2026-07-22 fail now: a source edit made from a note on a rendered document is not credited to the session, and a review request cannot be approved. |
| Current T8 result | **FAIL** | Supersedes the current T8 result recorded on 2026-07-22. |
| Overall v1 readiness | **BLOCKED** | T8 fails, Codex push delivery was not reached, and maintainer sign-off is pending. |

This report records the attended rehearsal of v0.1.0-alpha.37 for issue #19. It does not approve a
release and does not carry a maintainer signature.

Terms follow [the requirements](../requirements.md) and appendices A1 to A6. Two matter throughout.
A **claim** is an agent's declared, time-limited hold on the files it is about to edit; glosa credits
a change to that session only when the change happens inside the claim and on its files (A4 §F05).
Claims replaced the earlier **apply lease** on 2026-09-23 (#341). A **class-F** document is a
rendered file shown in a sandboxed frame, whose notes resolve back to a Markdown source.

## Rehearsal boundary

The rehearsal used an ignored, generated workspace with neutral content: a workshop handbook, a
monthly checklist, a short notes file, and a rendered survey that a deterministic local renderer
builds from a Markdown source, with one verbatim chunk and one transformed chunk. Workspace
metadata used `WorkspaceMetadataDescriptor` v1 through the generic adapter interface. The rendered
survey's footer ran an inert probe against a closed loopback port.

[The T8 gate](../../test/acceptance/T8-GATE.md) asks for a copy of documents the maintainer selects.
As in the 2026-07-22 rehearsal, the maintainer chose a generated neutral document instead.

The maintainer was present for the whole run, which is the attended condition T8 requires. Real
Claude Code and Codex sessions did the agent work. Chrome was driven through its DevTools protocol
with real pointer and keyboard events, including selections inside the sandboxed class-F frame.
Safari provided the WebKit result.

No rehearsal file, transcript, pairing token, session identifier or private path is committed here.

### Candidate

The candidate is commit `36fc4a7`: v0.1.0-alpha.37 plus #453, a change to the release workflow
only. Build `0.1.0-alpha.37-8f3b3bcef5df387b`, API contract 1.26.

For most of the run the daemon was served from a working checkout at that commit. Part way through,
that checkout picked up local modifications unrelated to this rehearsal. When a glosa CLI starts
from a tree whose build differs from the running daemon's, it replaces the daemon with its own build,
so for about four minutes the daemon ran the modified tree. Two checks ran in that window, the
WebKit sandbox probe and the attention request. The daemon, the CLI and the agent sessions were then
moved to a clean, separate checkout of `36fc4a7`, and both checks were run again there. The results
below are from those repeat runs, and every other result also comes from the unmodified candidate.

## Environment

| Component | Observed value |
|---|---|
| macOS | 26.2, build 25C56 |
| Architecture | arm64 |
| Bun | 1.4.2 |
| Git | 2.50.1 |
| glosa | 0.1.0-alpha.37, build `0.1.0-alpha.37-8f3b3bcef5df387b` |
| API contract | 1.26 |
| Claude Code | 2.1.285 |
| Codex CLI | 0.159.0, with a managed app-server daemon 0.159.2 |
| Browsers | Google Chrome 154.0.8037.92; Safari 26.2 |

## Deterministic gate

A push to `main` runs the full profile [the T8 gate](../../test/acceptance/T8-GATE.md) defines: three
partitions that together cover every test, including every T8 acceptance file, the stability
repetitions, one unpartitioned `test:full` run, and the license and package checks. For `36fc4a7`
that [CI run](https://github.com/davebream/glosa/actions/runs/36636986588) passed, and so did the
[release workflow](https://github.com/davebream/glosa/actions/runs/36637037421) for v0.1.0-alpha.37.
The suites were not rerun locally for this rehearsal.

## Expected and actual results

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Metadata registration and restart | The descriptor validates, persists, and survives a daemon restart. | Registered cleanly. After a restart, `glosa metadata show --json` returned byte-identical output. | PASS |
| Parked delivery | A note written with no session connected waits, then reaches the session that connects. | `doctor` warned that one entry was queued with no live session. The monitor offered it as soon as a session registered, and it was presented on that session's next turn. | PASS |
| Verbatim class-F note and apply | The note resolves to its source range, the agent applies it to the source, and the session is credited. | The note resolved to the exact source line and columns. The agent's source edit was checkpointed as `unknown` and filed as an external edit, because the claim that came with the note covered only the rendered file. | **FAIL** (defect 1) |
| Regenerated-render pickup | Re-rendering shows the revised text and clears the stale state. | The frame showed the new sentence and no stale marker. | PASS |
| Transformed class-F note | The note becomes pipeline feedback and the source stays unchanged. | Resolved as pipeline feedback naming the descriptor, component, chunk and source lines. The agent rejected it with a reason, and the source was untouched. | PASS |
| Edit round trip | One block edited in glosa changes exactly that block on disk and is recorded as the person's. | Exactly one hunk on disk; a `human_edit` entry with a `human` checkpoint. | PASS |
| Stale-file dialog | Saving over a disk change offers Keep mine, Take disk and Compare, and Keep mine keeps both changes. | The dialog appeared; Keep mine kept both changes, recorded as `human`. | PASS |
| Margin question (`glosa_ask`) | The question appears at its sentence, and the answer resumes the agent's turn. | The journal recorded delivered, seen, then done with the response; the agent's waiting call returned it. | PASS |
| External edits | A burst of outside saves becomes one live external edit that is not pushed; edits made while the daemon is stopped become one catch-up entry with only the net change. | Five saves in 1.5 seconds became one `live` entry, delivered only to a subscriber that asked. Three offline edits, one undoing another, became one `offline_catchup` entry holding the net change. | PASS |
| A person's save while an agent holds a claim | The save wins, the agent's unfinished bytes become `unknown`, and the agent gets a conflict signal. | The claim was released by the person, the agent's bytes were checkpointed as `unknown`, the save was recorded as `human`, and the agent received the conflict signal. | PASS; see defect 3 for starting an edit during a claim |
| A second session asks for a held claim | The second claim is refused and names the holder. | Refused, naming the holding session, the claim and its expiry. | PASS; the MCP error carries no `claim-held` code |
| Session started elsewhere, bound explicitly | A session started outside the workspace binds explicitly and pulls its notes. | Bound from another directory with plugin monitors suppressed by `DISABLE_TELEMETRY=1`, and pulled over MCP. `doctor`, run with the same setting, named the suppression. | PASS (MCP pull; push not available by design) |
| Daemon restart under a live session | The session's push stream returns without action in the session. | `doctor` reported the session's push stream held again after the restart. | PASS |
| Attention request and `request-review --wait` | The person can approve or request changes, and the waiting command receives that verdict. | Every reply resolved as `changes_requested`. An approval reached the waiting command as changes requested. | **FAIL** (defect 2) |
| Conversation mirror and composer (Claude Code) | The mirror shows the live session, and a composer message reaches it. | The message was delivered and presented, and the session's reply appeared in the mirror. | PASS; see defect 6 |
| Codex | Codex binds with its thread id, and notes and messages reach it by app-server push, with MCP pull as the fallback. | Binding with the thread id worked. Push never connected, and the composer could not reach the Codex session (defect 8). | NOT REACHED |
| Class-F sandbox probe | Inside the class-F frame, the probe's requests are blocked by the frame's content security policy. | Chrome, inside glosa's viewer: both requests blocked, with `connect-src` and `img-src` violations. Safari: the same result with the frame's document loaded directly, which shows WebKit enforces the frame's policy header. | PASS (Chrome in the viewer; Safari document only) |

## Defects found

Each defect is tracked in an issue that groups the work to be fixed and retested together.

| # | Defect | Gates T8 | Tracked in |
|---|---|---|---|
| 1 | Source edits from a class-F note are not credited to the session | Yes | #458 |
| 2 | A review request cannot be approved | Yes | #457 (fix) |
| 3 | Edit is locked while an agent holds a claim | Maintainer to decide | #458 |
| 4 | The chat list goes stale | No | #460 |
| 5 | A tab pinned to an earlier install ignores a fresh pairing link | No | #461 |
| 6 | The conversation mirror is noisy | No | #460 |
| 7 | Requests meant for the person are pushed to the agent | No | #459 |
| 8 | A Codex session without push is hard to reach | No | #460 |
| 9 | Copy | No | #458, #459 |

1. **Class-F source edits are not credited to the session.** The claim created for a verbatim
   class-F note covers only the rendered file. The agent edits the Markdown source, which the claim
   does not cover, so the change is checkpointed as `unknown` and reported as an external edit. On
   2026-07-22 the apply lease covered the same source edit and credited it to the session. Claims
   replaced the lease in #341. Whether #341 or a later change left the source file out of this
   claim was not traced.
2. **A review request cannot be approved.** On 2026-07-22 a request from `glosa request-review`
   was answered in the attention tray, which offered Approve, and the waiting command received
   `approved`. Since #134, a request that names a document is answered on a card at its passage,
   and both of that card's buttons resolve a review as `changes_requested`. Fix: #457. How review requests are routed and worded is #459.
3. **Edit is locked while an agent holds a claim.** While a claim is held, glosa disables Edit and
   the source editor for that file, for as long as fifteen minutes. A4 §F05 says a person is never
   blocked by an agent. A draft opened before the claim can still be saved, and that save wins, but
   the page tells the person to wait until the agent finishes. The claim scenario above passes because
   it opened the draft first.
4. **The chat list goes stale.** To reproduce: open glosa with a live terminal session listed under
   Chats, restart the daemon, or start and bind a second session. The list shows "No chats yet", or
   leaves the new session out, until the page is reloaded.
5. **A tab pinned to an earlier install ignores a fresh pairing link.** To reproduce: pair a tab,
   then restart the daemon from a different install of the same version and open the link that
   `glosa open --url` prints. The tab keeps showing "A different glosa has this port" for up to ten
   minutes, because the stored install is checked before the new link is used.
6. **The conversation mirror is noisy.** Claude Code's mirror showed 534 "unrecognized transcript
   line: skipped" rows and displayed Claude Code's own background notifications as messages from
   "You". The Codex mirror showed only unrecognized rows.
7. **Requests meant for the person are pushed to the agent.** To reproduce: have a session call
   `glosa_ask`, or run `glosa request-review <path>` while a session is connected. The entry is also
   delivered to the connected session. In the rehearsal, the agent reviewed the document itself in
   answer to a review request addressed to the person.
8. **A Codex session without push is hard to reach.** A session bound only through MCP counts as
   live for about a minute after each tool call. After that, its chat does not open and the composer
   refuses to send ("the selected session is not a live binding"). `glosa codex-attach --verbose`
   printed nothing for fifteen seconds while failing to attach.
9. **Copy.** A review request is announced as "is asking about a passage". A note card on a
   rendered document showed "Lost its place" although its note had resolved exactly. The instructions
   delivered with a note still name the removed apply lease, and one of them contains an em dash that
   the copy check does not cover, because that text lives in the daemon.

## Transports

| Transport | Status |
|---|---|
| Claude Code plugin monitor | PASS: notes, questions, claim signals and composer messages were pushed and presented. |
| MCP pull | PASS: exact retrieval, and explicit binding from a session started elsewhere. |
| Codex over MCP | PASS for binding with the thread id. |
| Codex app-server push | NOT REACHED. The Codex app-server daemon was running with its control socket present. After binding, `glosa status` reported the session's push as disconnected, and a foreground `glosa codex-attach` did not change that. The Codex TUI was started through a terminal wrapper; whether it was a client of that app-server daemon was not established. Still untested for Codex: push delivery of notes and messages, a restart between queueing and presentation, composer delivery, and acknowledgement of a pushed entry. Next step: start the TUI as a confirmed client of the running app-server, then bind and check `glosa status`. Tracked in #460. |

## Issue #460 attended follow-up

An attended, isolated follow-up completed the checks requested by #460. This was a focused
compatibility checkpoint. It did not rerun this rehearsal, resolve its other blockers or sign T8.

| Check | Result |
|---|---|
| Codex topology | PASS. The installed terminal wrapper used Codex CLI 0.159.0. The exact test thread was owned by the already-running 0.159.2 app-server daemon through its control socket. The checkpoint did not start, repair or replace the app-server or substitute another thread. |
| Attachment diagnostics | PASS. Verbose foreground diagnostics reached socket, handshake, initialize, exact-thread resume, daemon registration and stream connection in order. Connected status was reported only after the daemon stream opened. The earlier silent failure did not recur, so no transport correction was made. |
| Live push | PASS. The exact thread received and presented one note and one composer message. Connected push status, journal transport acceptance, provider presentation and the conversation receipt agreed. |
| Restarted queue | PASS. A composer message accepted for a stale explicit binding remained queued across daemon restart. Restoring that exact binding delivered only to its target thread, whose pushed `[glosa <id>]` entry was acknowledged and committed as delivered. |
| Transcript compatibility | PASS. Fresh neutral Claude Code 2.1.285 and Codex 0.159.2 records were sanitized into regression fixtures. Their provider normalizers emitted user and assistant prose plus paired tool events, hid recognized harness and bookkeeping records, and quarantined zero records. |

Raw transcripts, identifiers, tokens, configuration paths and journal evidence remain ignored. Only
neutralized record shapes and this behavior summary are tracked.

## Setup notes for the next rehearsal

- Serve the daemon, the CLI and every agent session from a separate, clean checkout of the
  candidate. `GLOSA_BIN` is the environment variable the Claude Code plugin's launcher uses to pick
  which glosa executable to run; set it to that checkout for agent sessions. Otherwise a glosa
  started from any other checkout re-points the rehearsal home's launcher at itself.
- A `glosa` MCP server configured directly in an agent's settings, next to the plugin's, starts a
  second glosa process that the agent can call by mistake. `doctor` does not mention it (#461).

## Sanitization check

- Rehearsal data stayed in ignored local state.
- No fixture, transcript, token, session identifier or private path is included in this report.
- Scanning the tracked tree for private absolute paths found one: a design critique record under
  `.impeccable/critique/`, committed on 2026-09-24, names a path in the maintainer's home directory.
  It is unrelated to the rehearsal and should be removed. Every other hit is a sample path in
  documentation or a test fixture.

## Maintainer review and sign-off

**Status: pending.** This report is not signed on the maintainer's behalf.
