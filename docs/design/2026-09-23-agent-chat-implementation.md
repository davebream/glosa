# First-class agent chats: implementation specification

Date: **2026-09-23**. Status: **proposed implementation contract; no runtime behavior is changed by this document**.

This specifies a local Glosa interface for Claude Code and Codex: persistent workspace chats, ordinary content tabs, isolated subscription accounts, native login, and interactive agent execution. It turns the [integration research](../research/2026-09-23-agent-chat-integration.md) into concrete implementation choices. Existing [requirements](../requirements.md) and appendices remain authoritative until the corresponding implementation and contract amendments ship together. This document does not move roadmap items, establish provider permission, or satisfy T8.

## 1. Decisions and delivery boundary

**A chat is durable workspace data. A tab displays it. A provider runtime executes its turns under one explicitly selected account.** These three lifetimes are separate.

| Decision | Specified behavior |
| --- | --- |
| Navigation | Files and Chats share the workspace sidebar. Chats use the existing dock, including split views. Remove the contextual Conversation entry only after its external-session replacement works. |
| Integration | Direct Codex app-server over stdio; official Claude Agent SDK driving the unmodified native executable, conditional on the offering/authentication gate below. Keep ACP behind the future adapter boundary. |
| Accounts | A Glosa-owned configuration directory per account profile. Native runtimes own credentials. Multiple profiles may be enabled; one enabled default per provider, or no default. |
| Switching | Model/effort changes apply to a subsequent turn in the same chat. Changing provider after submission creates a fresh chat. A same-provider subscription switch persists on the existing chat, with a fresh native session and message-text handoff on the next explicit send. |
| Stack | Bun, TypeScript, vanilla ES modules, existing Markdown/diff components. Locally vendored browser-ready xterm.js only for native login. No React migration, second service, native addon, or application build step. |

Disabling an account **blocks new execution immediately and stops its active runs**. The button explains the number of affected chats. Changing a default affects future drafts only. Reauthentication is part of the first release, not a follow-up.

The specification selects native adapters without requiring an ACP bake-off first. The research established that common transport does not eliminate provider/account differences. ACP v1 can be added later by implementing the same contract; ACP v2 drafts are not production dependencies. [ACP](https://agentclientprotocol.com/), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude SDK](https://code.claude.com/docs/en/agent-sdk/overview).

### Ship gates versus architectural decisions

| Gate | Required evidence | Failure outcome |
| --- | --- | --- |
| G1: Claude offering | Record the exact distribution, native login, SDK use and applicable Anthropic permission. Native hosting terms and SDK offering restrictions must be reconciled for this product. | Claude managed execution stays unavailable; do not switch to print mode and claim the restriction disappeared. External Claude sessions keep working. |
| G2: native compatibility | Attended two-account isolation, login/relogin, model/effort, permissions, resume, MCP and cancellation against each pinned runtime on supported macOS architectures. | Mark that provider/version unsupported; do not fall back to API billing or another account. |
| G3: lifecycle containment | Synthetic process-group and guardian tests, plus attended native tests proving stop/crash behavior for the supported runtimes. | Do not enable managed execution with an unproved process owner. |
| G4: Glosa release | Required deterministic tests, contract amendments, browser scenarios and expanded attended T8 rehearsal/sign-off. | Remain experimental; green CI alone is insufficient. |

G1 is a product/distribution determination, not a question an adapter can answer. Anthropic's [hosting conditions](https://code.claude.com/docs/en/legal-and-compliance) and [SDK conditions](https://code.claude.com/docs/en/agent-sdk/overview) are the primary sources. Codex must likewise retain its supported native authentication and account policies. These gates do not leave the data model or UX undecided.

### Initial scope

| Included | Deliberately excluded |
| --- | --- |
| Managed Claude/Codex chats; external-session chat tabs; durable history and drafts | Taking control of an externally owned CLI session |
| Multiple accounts, defaults, native login/logout/relogin, explicit runtime install/update | Credential imports, token proxies, automatic account rotation or automatic API fallback |
| Models, effort, provider-native approvals/questions, usage, MCP configuration/status | Arbitrary MCP Apps HTML, hosted relay, remote agent hosts, multi-user access |
| File/selection/text-image attachments within consent and runtime capabilities; explicit transcript attachment | Autonomous schedules, workflow orchestration, worktree creation, background inference |
| Directory-workspace execution; loose-file workspaces retain external session viewing | Launching an agent at the filesystem root or silently broadening a loose-file registration to its parent directory |

## 2. User experience

The design extends Glosa's [product](../../PRODUCT.md) and [visual system](../../DESIGN.md). Preserve its warm paper surface, shared workspace desk, ink dividers and existing light/dark tokens. Documents remain the primary reading surface. Conductor is an interaction reference, not a replacement visual theme. Vermilion continues to identify human actions; do not repurpose it as a generic provider color.

```text
Workspace
├── Files                  existing document tree
└── Chats                  New chat action, count, search
    ├── Review the outline  Claude Code · Personal · Needs approval
    ├── Tighten examples    Codex · Work · Working
    └── Terminal session    Claude Code · External · Disconnected

Content dock: document | chat | document comparison
Settings → Agents → Claude Code / Codex → Accounts / Runtime / Configuration
```

### 2.1 Sidebar and tab behavior

| Element | Behavior |
| --- | --- |
| Chat row | Deterministic title, provider, short account label and textual status. Most recently active first; pinned rows first. No generated title call. First user message supplies a clipped title until renamed. |
| New chat | Creates a local draft and focuses its tab. Uses the last explicitly selected provider and that provider's current default. Without an eligible default, show account selection. Never start a process from opening the tab. |
| Tab identity | One dock panel per chat per browser workspace layout; clicking an already open row focuses it. Reopening restores history, not execution. Split with a document using existing dock controls. |
| Close / archive / delete | Closing removes only the view. Archiving requires no active/queued work and hides the row. Deleting requires stopped execution and explicit confirmation; explain native-provider history retention separately. |
| Activity | Offscreen approvals appear as a count and status on the chat row/tab. Finishing a turn never steals focus. No required OS notification integration. |

Chats and Files are independently collapsible. Chat search initially covers title and locally stored message text in this workspace, with pagination; never launches a provider. Archived chats have an explicit filter. Empty Chats offers one New chat action and a short explanation; avoid dashboard cards or onboarding tours.

### 2.2 Composer and switching

The composer has text/attachments above a compact row: **model · effort**, attachments, and Send/Stop. One quiet model button opens a compact popover; its Subscription row opens a separate account-selection view within that popover. Glosa exposes no Plan mode selector; native tool approvals remain intact. Effort uses the same compact monochrome bars for either provider, with a descriptive hover/focus tooltip; model selection uses the same tooltip treatment. Versioned labels come from provider metadata, including Claude’s optional `resolvedModel`; selectable IDs remain unchanged. Tooltips distinguish an alias from its last reported concrete model. Collapse aliases only when their resolved model IDs match exactly, retaining the current alias for existing chats and preferring an explicit model reference over `default` for a new selection. The default is tooltip metadata; a 1M label appears only when another discovered choice has the same concrete base ID with a different context suffix. This follows the separation of models, defaults and hidden compatibility aliases in [Paseo’s curated model manifest](https://github.com/getpaseo/paseo/blob/49f9cec6be01ef7e7604dadf127425eac6493820/packages/server/src/server/agent/providers/claude/model-manifest.ts), while retaining Glosa’s account-specific native discovery. [Conductor’s public settings](https://www.conductor.build/docs/reference/settings/reference) likewise store the default as a model reference; its internal alias resolution is not publicly established by that documentation. Cached entries lacking a version explicitly say “version not reported” until model discovery is refreshed, with no background provider call or guessed release mapping. The selected subscription appears in the popover and model tooltip; it does not need a separate composer control. Keyboard Enter sends; Shift+Enter inserts a newline; IME composition must not submit. Existing document keyboard commands apply only to document panels.

| Action | Result |
| --- | --- |
| Provider/account change in an unsent draft | Update the draft in place; retain text and compatible attachments. Flag incompatible attachments for removal instead of silently discarding them. |
| Provider change after submission, even a failed submission | Open a new draft tab using the requested choice. Old chat continues independently. Preserve the current unsent draft in the old chat; offer an explicit Move draft action. |
| Same-provider subscription change | Keep the tab, chat ID, messages and unsent draft. Persist the subscription for this chat without changing the default. Require stopped runtime ownership and no pending turns. Allocate a fresh native session and Glosa binding; carry prior message text on the next explicit send. |
| Model/effort change | Save desired settings for the next submitted turn. Already accepted or queued turns retain their settings snapshot. If a queued turn exists, explain that the selection applies after it, with Cancel queued turn available. |
| Send while idle | Persist the intent, then dispatch after admission checks. Clear the text only after durable acceptance, retaining the message receipt for recovery. |
| Send while working | Label action Queue next message. Allow one pending user turn per chat; it executes after successful completion of the current turn while authorization remains valid. A second queued send is rejected with the draft intact. |

An explicit Stop interrupts current execution **and cancels queued dispatch**. A queued message remains visible as cancelled and can be copied back into the composer. Permission waits do not consume the queue. After an error, authentication failure, daemon restart or uncertain acceptance, queued work becomes held and requires a fresh Continue action; no invisible inference on recovery.

Cross-provider continuation has a New chat affordance with an optional **Attach previous conversation** action. That action shows the source chat, included turns, byte size and destination account. It produces a frozen, user-visible text attachment; it never copies native thread IDs, hidden reasoning, secrets, pending approvals or native tool-control messages. Sending the attachment is the consented transmission. Opening a new tab alone sends nothing.

### 2.3 Settings and account lifecycle

Each provider page shows account rows with label, provider-reported identity, plan/auth method when available, enabled/default state, connection status and last verification time. An identity reported by the provider is distinct from the editable label. Do not display an email merely inferred from a config filename.

| Action | UI and enforcement |
| --- | --- |
| Add account | Create an empty private profile; explain native authentication and isolated configuration. Start the vendor's native login only after the user's Connect action. |
| Make default | Available only for an enabled, authenticated profile. Clears the previous default atomically. Existing drafts/chats do not move. |
| Disable | “Disable and stop N active chats.” Increment the profile execution fence, hold pending work, deny unresolved approvals and interrupt active runs. Show Stopping until confirmed. No replacement default is silently chosen. |
| Reconnect | Stop remaining processes for that profile, then run native login against its existing directory. Verify identity before allowing old chats to resume. |
| Sign out / remove | Sign out runs the vendor's logout for that profile after stopping it. Remove then deletes only the owned directory/metadata through a resumable operation; existing chats remain readable with Account removed. |

All accounts can be disabled. A disabled or missing default means new drafts need explicit selection. A quota limit does not disable an account or select another. Changing provider identity during reconnect must not silently repurpose the old account slot: mark it `identity_mismatch`, block old chats, and offer a fresh profile/login or signing back into the original identity. Do not copy or move credentials to repair that mismatch.

Authentication statuses are `unknown`, `checking`, `authenticated`, `needs_login`, `expired`, `probe_failed`, and `identity_mismatch`; `enabled` is separate. Probe failure is not evidence of logout. Persist last observed status and timestamp, but after restart consider it stale until a foreground action verifies it. No periodic provider checks.

### 2.4 Login terminal

Use the original vendor flow in an inline xterm.js region inside the selected account's settings. It is a bounded login task, not a general shell. Launch an executable with an argv array and an explicit environment; never interpolate a shell command. The pinned Claude adapter uses `auth login --claudeai`, which enters native subscription sign-in directly without the interactive session's theme/onboarding wizard. Codex uses its native browser/device login. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Codex authentication](https://learn.chatgpt.com/docs/auth).

The region has a clear account heading, Cancel, accessible text/status alternative and browser-open fallback. Native flow output is ephemeral, kept only in a bounded in-memory buffer. Do not journal it, log it, restore it after restart, include it in diagnostics, or auto-copy it. Restrict link handling to user-activated HTTP(S) destinations validated by the adapter; reject terminal clipboard escapes and all shell/file link schemes. Do not strip control sequences required by the vendor TUI indiscriminately; disable unsafe terminal features at the renderer boundary.

Allow one login task globally initially, avoiding native callback-port collisions, and one task per profile by construction. Another browser can observe its status but cannot take over terminal input without an explicit control transfer. Native login has a fixed ten-minute deadline from admission, including completed output retention. Browser polling does not renew or shorten it: provider sign-in can suspend the initiating tab. Closing the login/settings view cancels immediately when its controller runs; an abrupt browser exit is bounded by the same deadline. Cancel acts immediately. A late completion after cancellation cannot enable an account: kill the task and require a fresh status probe. If credentials were written before cancellation, display that result only after explicit verification.

### 2.5 Messages, tools and failure states

| Surface | Contract |
| --- | --- |
| Assistant text | Streaming Markdown with raw HTML disabled, safe links, bounded code blocks and Copy. Never execute output. Render only provider-exposed reasoning/summary events; omit absent reasoning. |
| Tool activity | Collapsed name/status/duration; structured arguments/results on expansion. File paths link only through Glosa's authorized artifact resolver. Diffs are previews, not evidence of authorship. Unknown tools use safe text/JSON. |
| Permission/question | Inline decision card plus sidebar badge; exact operation, target, scope and available choices. Stable IDs survive browser reconnect. Approval is never inferred from a chat message. |
| Errors | Plain cause and recovery: Sign in again, Choose supported model, Retry status, Continue, or Start new chat. Show Unknown outcome where execution may already have happened. |
| Usage | Separate context, token totals, account limits and optional estimated cost. Show source/account/scope/as-of and unavailable/stale states. Subscription token estimates are not invoices. |

Keep scroll anchored unless the reader was already following the bottom. Provide a new-content button when scrolled away. Preserve text selection during streaming. Virtualize old messages by logical message, not by arbitrary text lines; never unmount the focused decision or selected text. Screen readers receive throttled status changes, not token-by-token announcements. At narrow widths, the existing sidebar collapses; chat controls wrap without horizontal page scrolling. WCAG 2.2 AA, reduced motion, visible keyboard focus and non-color status labels apply.

## 3. Domain model and component boundaries

### 3.1 Objects and identities

| Object | Identity and lifetime | Authority |
| --- | --- | --- |
| AccountProfile | Random immutable UUID; one provider and canonical config root; editable label/enabled/default separately | Global control journal; native runtime owns its credential files/Keychain entry |
| Chat | Random UUID plus immutable workspace registration ID and origin (`managed` or `external`) | Per-chat journal; title/archive/draft/settings projected from it |
| Turn | Chat-scoped UUID with request ID, frozen input, profile/settings/consent revisions | Chat journal; provider's acceptance/outcome recorded separately |
| Managed session binding | Stable Glosa session UUID for one subscription/native-thread segment within a chat; maps to provider, profile and native thread ID | Chat journal identity; this is the immutable feedback/claim target registered in SessionRegistry |
| RuntimeSession | New run UUID and monotonically increasing generation for each owned process; references the stable managed binding | Journaled run identity plus live ownership/lease; native IDs are never authorization |
| Decision | Chat/runtime generation, provider request ID and immutable request digest | Journaled request/answer lifecycle; one reply per live native request |

Use `WorkspaceLocation.registration_id`, not a slug, as persisted workspace identity. Slugs can change or be reused. Native thread/session IDs are keyed by `(provider, profileId, chatId)` and never global lookup keys. The same native ID in different profiles must not collide. A chat is considered started after its first durable `turn.accepted`, even if dispatch fails. Allocate its stable managed Glosa session ID before the first launch. Idle eviction/explicit resume can re-register that same ID only after handshake under the same account, workspace and native-thread binding; each connection gets a new run ID/generation. This preserves immutable inbox targets without making an offline session live. Grants, decisions and stale connection callbacks are generation-fenced. A new native thread after failed resume requires a new chat/binding, not reassignment of the old ID. An explicit same-provider subscription switch creates a new binding inside the existing chat after confirmed shutdown; old turns and feedback targets retain the prior binding. Never reuse a native ID when switching back to a previously selected subscription.

Every accepted turn freezes provider, profile identity revision, runtime manifest version, desired/effective model and effort, permission policy revision, workspace root/registration, consent revision, attachment references and MCP configuration digest. Defaults cannot reinterpret an old turn.

### 3.2 Components

| Component | Owns | Does not own |
| --- | --- | --- |
| Existing AgentProvider | External session detection, delivery, leases, transcript discovery; optional managed delivery delegation | Native credential storage or process launch details in core |
| ManagedAgentAdapter | Provider-specific native login/probe, protocol, models, permissions, MCP and event normalization | UI, durable storage, selecting a different account, global child ownership |
| AgentControlService | Profiles/defaults/runtime manifests/consent, admission fences, login-task registry | Parsing native transcript JSON in generic core |
| ChatService | Journals, turn admission, queue, decisions, replay, attached-session association | Calling remote model APIs or trusting client-supplied native IDs |
| RuntimeSupervisor + per-run guardian | Owned process lifecycle, bounded pipes, stop escalation, parent-death cleanup | Provider semantics, reusable background service, external-session discovery |

The guardian is a short-lived Bun child module for each native process, not another daemon: no listener, independent startup, persistent account state or automatic restart. One Glosa daemon continues to serve UI/API and serialize state. The composition root registers optional adapters; generic core boots and document review works with zero adapters.

Keep the existing `AgentProvider` contract valid. Introduce a separate optional `ManagedAgentAdapter` interface under the generic daemon boundary, implemented only in provider packages. Do not add Claude branches to generic core or reinterpret every registered external session as owned.

```ts
// Proposed contract sketch; provider wire types stay inside its adapter.
interface ManagedAgentAdapter {
  describe(manifest: RuntimeManifest): StaticCapabilities;
  login(spec: ProfileLaunchSpec, io: OwnedProcessIO): LoginDriver;
  probe(spec: ProfileLaunchSpec, io: OwnedProcessIO): Promise<AuthObservation>;
  connect(spec: SessionLaunchSpec, io: OwnedProcessIO): Promise<ManagedConnection>;
}
interface ManagedConnection {
  capabilities: EffectiveCapabilities;
  events: AsyncIterable<NormalizedEvent>;
  startTurn(turn: FrozenTurn): Promise<DispatchReceipt>;
  answerDecision(answer: FencedDecisionAnswer): Promise<ReplyReceipt>;
  interrupt(turnId: string): Promise<InterruptReceipt>;
  close(): Promise<void>;
}
```

`OwnedProcessIO` is created only by the supervisor from an admitted launch spec. Adapters may request subprocess operations but cannot bypass supervision with arbitrary `spawn`. Type definitions include cancellation signals, explicit timeouts and bounded output. Use the published Claude SDK `spawnClaudeCodeProcess` seam to supply a supervised `SpawnedProcess`: Node-compatible readable/writable streams and lifecycle callbacks backed by the guardian, rather than the SDK default spawner. The inspected 0.3.280 declaration exposes this seam. Its `signal` has SDK-specific graceful-EOF timing; bridge abort/kill and exit exactly once without confusing guardian exit with native exit. Validate the SDK-provided command, args and environment against the admitted launch specification. Bun stream compatibility and end-to-end cancellation still require G3. [Published SDK declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.280/sdk.d.ts).

### 3.3 Capability model

Capabilities are observed per runtime version/account/session, not assumed from provider name. Include native resume, model listing, effort values, model/effort change strategy, input attachments, approvals, structured questions, cancellation, MCP status/auth, context usage and account limits. For each control report `supported`, `unsupported` or `unavailable` with a reason; unavailable is not an empty successful result.

No dynamic model request when merely reading history. Cache the last foreground result with its account/version provenance. A user-activated Refresh models action can run foreground discovery for the selected profile. First Send can also start the authorized runtime and discover models before inference; if the selection is unavailable, stop admission and ask the user to choose. Never substitute a cheaper, newer or cross-provider model silently. Persist the native-reported effective setting, separately from the requested setting.

## 4. Persistence, replay and concurrency

### 4.1 Storage ownership

Use the resolved Glosa home (default `/Users/<user>/.glosa` on macOS); never the agent's default CLI home or a repository for account secrets. Paths below are logical layout, not shell literals.

```text
<GLOSA_HOME>/agents/
├── control.jsonl                   profiles, defaults, consent, operations
├── profiles/<profile-id>/native/    vendor-owned config/auth/history
├── runtimes/<provider>/<version>/<arch>/
├── runs/<runtime-id>/              launch descriptor and bounded guardian receipt
└── chats/<chat-id>/
    ├── journal.jsonl               chat/turn/decision/runtime facts
    ├── blobs/<sha256>              frozen attachments and oversized payloads
    └── projection.json             disposable replay cache
```

Create private directories as `0700`, ordinary state files as `0600`; vendor files retain vendor-supported secure modes. Profile roots are absolute, canonical, immutable, disjoint and not symlinks into another profile or default CLI configuration. Validate owned ancestors and leaf type on every destructive operation. Refuse unexpected symlinks/hardlinks rather than following them during recursive removal. A same-OS-user malicious process is outside this directory isolation guarantee; do not advertise an OS security sandbox.

There are three authorities, with distinct subjects: existing workspace bus for annotations/claims/provenance; control journal for account/consent policy; chat journal for conversation/execution intent. A JSON projection or sidebar index is rebuildable, never a second source of truth. No promise of atomic writes across them.

Reuse the existing short-write/fsync primitives after extracting a generic append framing helper if needed. Do not insert chat events into the workspace `EventType` union by casting, or treat the workspace reducer as a generic chat store. Current journal framing limits records to 65,536 bytes including newline. Apply that ceiling to new journals too; split output into bounded chunks or reference immutable blobs.

### 4.2 Event envelope and durability

```ts
type ChatEnvelope = {
  schema: 1; chatId: string; seq: number; eventId: string; at: string;
  type: ChatEventType; runtimeGeneration?: number; turnId?: string;
  providerEventId?: string; data: unknown; // validated by type-specific schema
};
```

Sequence is assigned by the sole daemon writer while holding that chat's mutex. Reject sequence gaps/duplicates with different content on replay. An unknown optional display event can become a safe unsupported-event placeholder; an unknown control/schema version makes the chat read-only. A corrupt interior control record blocks further execution. A torn final record is quarantined/truncated to the last verified boundary and leaves any dispatched work uncertain. Do not inherit the workspace bus's permissive interior-line recovery for executable chat policy.

| Event family | Examples | Durability rule |
| --- | --- | --- |
| Chat/configuration | created, renamed, archived, settings_changed, draft_saved, deleted | Fsync before acknowledging mutation |
| Turn intent/outcome | accepted, held, cancelled, dispatch_started, provider_accepted, completed, failed, outcome_unknown | Fsync before external dispatch and before reporting a terminal outcome |
| Decisions | requested, answer_reserved, reply_attempted, resolved, expired | Persist request before interactive display; answer reservation before native reply |
| Runtime | prepared, spawned, connected, stop_requested, stopped, ownership_unknown | Fsync lifecycle boundaries; ownership evidence excludes credentials |
| Content/usage | message_started, content_delta, message_completed, tool_updated, usage_observed | Persist ordered chunks before emitting them as durable SSE events; batched fsync at most every 100 ms/32 KiB, flush at turn/decision boundary |

Output may appear provisionally between fsync batches; the UI marks only user-intent/terminal receipts as committed and accepts a reset after crash. Keep transient delta IDs distinct from the durable replay cursor until fsync; emit a durable watermark after each batch. The REST snapshot returns only the durable prefix. No approval card is actionable before its own durable request exists.

Write a blob to a private temporary file, fsync it, atomically rename by digest, fsync its directory, then append/fsync its journal reference. A crash can leave an unreferenced blob, never a committed reference to absent bytes. Garbage collection considers all surviving journal references and a seven-day orphan grace period. No automatic deletion of accepted history for a storage budget; fail new writes visibly before dispatch when space is exhausted.

### 4.3 Idempotency and dispatch uncertainty

All mutations have a client-generated request UUID and expected revision. The journal retains request ID, canonical request digest and response identity. Same ID/same payload returns its receipt; same ID/different payload is `409 idempotency-conflict`. No content-based deduplication: two identical prompts may be intentional. A new retry ID is a new instruction.

```text
Send → validate → fsync turn.accepted → acquire admission → fsync dispatch_started
     → write to provider → fsync provider_accepted → stream → fsync completed
```

| Crash window | Recovery |
| --- | --- |
| Before accepted fsync | Client may retry the same request ID; no dispatch was allowed. |
| Accepted, before dispatch_started | Held after restart. Continue may dispatch once after fresh admission. |
| dispatch_started, before durable native acknowledgment | Outcome unknown. Reconcile through native thread history only if the adapter proves the match; never auto-resend. |
| Native acknowledgment, incomplete turn | Resume/read native state using the same profile and native ID after user action; reconcile or retain partial/unknown outcome. |
| Completed but browser did not see response | Same request ID or SSE replay restores the existing receipt without new inference. |

Glosa guarantees idempotent local acceptance, not exactly-once remote inference. `provider_accepted` means the native protocol accepted the turn; it does not mean a model read every attachment or that a tool completed. Unknown approval-reply delivery has the same conservative treatment; do not blindly replay an authorization.

### 4.4 Locking and fences

Serialize account/default/consent policy through one control actor; chat mutations through one actor/mutex per chat. Keep the existing ownership-coordinator-before-session-mutex order. Never await provider/network activity while holding workspace ownership, control, chat or bus locks.

Admission uses an immutable ticket containing profile policy epoch, identity revision, consent revision, workspace ownership epoch, chat settings revision and runtime generation. Under the control actor, validate policy and create the ticket. Under workspace ownership then chat serialization, validate workspace/chat and record intent. Immediately before handing off an external action, synchronously recheck all epochs through the supervisor's serialized dispatch gate. Every guardian also owns a per-runtime dispatch gate. Sends and `fence(epoch)` commands travel on one ordered control stream; the guardian validates generation/epoch, writes a send to native stdin without yielding to another command, and acknowledges the handoff. A fence closes its gate, drops any not-yet-committed buffered actions and acknowledges that no later action at the old epoch can be written. Native bytes handed off before that point are already in flight and cannot be recalled.

Disable/revocation first durably changes control policy and closes local admission, then sends fences and cancellation outside all state locks. Return a pending operation receipt while these complete; do not report the execution fence effective until every live guardian acknowledges it or is confirmed stopped. A missed acknowledgment escalates stop and leaves ownership unknown if exit is unproved. Control disabled/revoked state is effective for new admission immediately; the UI separately displays Stopping/Recovery required. AC-04 must pause guardian consumption and race a queued send against the fence, not test only a daemon-local boolean.

No rollback across journals is required: an accepted chat intent can remain held if its ticket becomes invalid. The disabling control event is authoritative even if per-chat cancellation journaling later fails. Replay always joins chat intent with current control policy before execution. Workspace forget/adoption uses the existing ownership coordinator as the outer barrier; do not introduce a reverse acquisition from an account callback.

## 5. Runtime ownership and recovery

### 5.1 State machines

```text
Chat: draft → ready → active → ready
                  ↘ blocked / interrupted / outcome_unknown
      ready → archived → ready; stopped state → deleted

Turn: accepted → queued/starting → running ↔ waiting_for_decision → completed
      accepted/queued → held/cancelled
      starting/running → failed/interrupted/outcome_unknown

Owned process: prepared → spawned → connected → stopping → stopped
               any live state → ownership_unknown (execution blocked)
```

Chat display status is derived from turn/runtime state; it is not a separately mutable field. Provider terminal messages, process exit and stderr are independent observations. A process exit alone cannot convert a turn to success. A native protocol failure cannot be hidden behind exit code zero.

### 5.2 Guardian and cancellation

Use Bun's native process APIs; no `node-pty`. A per-run guardian controls the vendor subprocess and its process group, while the daemon controls the guardian through private pipes. The guardian uses a framed, size-bounded control channel with request IDs; native stdout, stderr and PTY data occupy distinct frame types. Runtime protocol bytes cannot impersonate guardian control frames.

Start the guardian inert. Persist `runtime.prepared` before granting it launch permission. Allocate a random ownership nonce and persist the run descriptor before granting launch. Once the guardian reports child PID/process group and executable identity against that nonce, persist `runtime.spawned` before sending any user content or granting tool decisions. Runtime initialization that may contact a vendor is itself within the foreground consent ticket. A guardian whose initial acknowledgment is lost is cancelled rather than launched again.

For pipe-based runtimes, `Bun.spawn({detached: true})` creates a private process group on supported macOS; do not call `unref` or discard pipes. For PTY tasks verify the actual session/group behavior rather than assuming the same option combination works. Guardian stdin closure and missed daemon heartbeat both enter cancellation. Heartbeat: five seconds; expiry: twenty seconds. Guardian failure is a hard stop of admission, not a reason to auto-restart the agent.

Cancellation first uses the provider's protocol interrupt. After two seconds without confirmation, terminate the owned process group; after another second, force-kill it. Always await/observe exit, close pipes/PTY, expire decisions and record outcome. A failed stop becomes `ownership_unknown` with further execution for that chat/profile blocked. Signal only a group whose ownership the live guardian established; never find processes by executable name or kill a stale recorded PID after restart.

The managed provider and ordinary children remaining in its group are covered. A tool that deliberately detaches a service can escape group signalling; configuration isolation is not process containment. UI Stop means stop the managed agent and its owned group, not undo changes or promise to kill arbitrary services it started. Native detached-tool behavior must be documented during G3; unresolved provider-process ownership blocks another launch. Do not claim an OS sandbox that the provider does not supply.

### 5.3 Daemon/browser lifecycle

| Event | Required behavior |
| --- | --- |
| Browser/tab closes | An already authorized turn and its explicitly queued next turn may finish. No new task is invented. Pending decisions wait up to ten minutes, then deny/cancel. Native login retains its fixed ten-minute deadline if the browser disappears; an explicit login/settings close cancels immediately. |
| Idle native process | Close after five idle minutes, preserving native thread ID and chat. Reopen only on a new foreground action. No model warm-up. |
| Graceful daemon shutdown | Close admission, hold queues, interrupt owned runs, await guardians, then close chat/control writers before existing workspace writers/identity release. Fit the existing eight-second hard-exit budget; guardians retain parent-death cleanup if daemon drain fails. |
| Daemon crash/stall kill | Guardians detect pipe closure/heartbeat expiry and stop their groups. Restart replays journals as held/uncertain; never spawn agents, log in, or infer automatically. |
| Automatic daemon replacement | A newer CLI must not casually interrupt active work. Return `managed-runtime-busy` with count until the user chooses Stop and restart; preserve current daemon's handshake compatibility path. Explicit stop uses the same bounded shutdown. |

The daemon is the only journal writer. Each guardian may write exactly one bounded exit-observation receipt in its already-created private run directory: runtime ID/generation, nonce, OS boot identity, child/group identity, exit signal/code and whether the owned group was observed empty. No native content, arguments or credentials. It writes a private temporary file, fsyncs, renames and fsyncs the directory. This is an observation, never authorization or a second journal; the daemon validates it against `runtime.prepared/spawned` before appending its own stopped/unknown event. A receipt is absent when the guardian itself crashes, and an incomplete receipt grants nothing.

On restart, an old spawn record without confirmed exit is not a live lease. Reconcile conservatively using the validated receipt plus read-only process/group inspection for recorded owned identities (or proof that the OS rebooted). If identity cannot be proven, expose Recovery required and block replacement for that profile; offer instructions to inspect/stop the named owned run. Do not adopt an arbitrary PID or reconnect a second controller to a native thread. The G3 experiment must prove the ordinary crash path does not leave this manual recovery as the normal experience.

Rotating or revoking the Glosa pairing token invalidates streams, login input ownership and managed MCP grants. Close managed admission and stop active managed processes; require a freshly paired foreground action to continue. External sessions retain existing documented token/lease behavior. Runtime stop does not alter provenance rules for unfinished claims.

## 6. Provider adapters and account isolation

### 6.1 Launch environment and configuration

One `resolveProfileLaunchSpec(profileId, manifestId, workspace?)` supplies login, logout, probe, discovery, run, resume, history and MCP operations. No operation can fall back to the daemon's ambient agent home. Keep the OS `HOME` unchanged; use supported provider configuration-root variables. Do not copy the user's credential files or symlink shared mutable resources.

| Concern | Contract |
| --- | --- |
| OS environment | Construct a documented baseline for PATH, locale, terminal and OS-required values. Secrets are not inherited wholesale. Preserve explicitly approved tool environment separately and display its scope. |
| Provider auth/billing | Always scrub `ANTHROPIC_API_KEY`; also remove ambient vendor tokens, API/gateway overrides, cloud credential selectors and credential helpers from subscription launch policy. Adapter owns the versioned exact deny/allow list. |
| Config roots | Claude receives only the canonical profile `CLAUDE_CONFIG_DIR`; Codex receives profile `CODEX_HOME`. Assert the same root in every operation and record only a root identifier in diagnostics. |
| User/project settings | Start with isolated provider user settings. Project instructions can be read as disclosed workspace content, but executable helpers, hooks, plugins, MCP servers and auth-routing settings require explicit enablement. Managed organizational policies must still apply. |
| Effective route | Verify provider-reported identity/auth method before dispatch. If an allowed config/policy changes subscription billing route, block the turn and explain; never silently send through an API key. |

Subscription is the supported default. A later API/cloud profile is a different typed authentication mode with separate consent and visible billing; there is no API fallback switch hidden in a subscription profile. Native runtime authentication choices must not be removed in conflict with vendor terms; if a user chooses an unimplemented native auth method, preserve the native flow and explain that Glosa execution for that mode is unavailable.

Claude officially documents configuration-directory Keychain namespacing; Codex documents home and credential-store selection. For initial Codex managed profiles select its supported **file** credential store inside each private home, avoiding reliance on unverified global keyring namespacing. The runtime writes/refreshes that file; Glosa never parses its token fields. A native status interface supplies identity. File permissions and same-user exposure must be stated accurately. [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude environment](https://code.claude.com/docs/en/env-vars), [Codex authentication](https://learn.chatgpt.com/docs/auth).

### 6.2 Codex

Use the native app-server's stdio protocol with types generated from the pinned executable. Initialize once, advertise only implemented stable capabilities, and validate every response/notification. Maintain a request map separate from server-initiated approval requests; distinguish numeric and string IDs. Bound line length, nesting and pending request count. Unknown notifications may be ignored/safely recorded; unknown authorization requests are denied, never approved by a default handler.

| Product operation | Native mapping |
| --- | --- |
| Account | Native CLI login/device-auth terminal and native logout; app-server `account/read` for identity; supported account limit reads during foreground use. Do not implement OAuth/token exchange in Glosa. |
| Discovery | `model/list`; map advertised effort choices and account availability. |
| Chat | `thread/start`, `thread/resume`/read and `turn/start`; preserve native thread ID within profile. Per-turn model/effort overrides use supported fields. |
| Interaction | Stream item/turn notifications; answer native command/file approvals and structured user-input requests with their exact schema; `turn/interrupt` for Stop. |
| MCP/usage | Supported MCP status/configuration and token/rate-limit events. Experimental plugin/remote transports remain disabled. |

The existing Glosa Codex socket attachment is for externally owned sessions; do not replace it with this owned stdio transport. Reuse validators/delivery semantics where appropriate, with distinct connection ownership. The native app-server protocol is not a generic LSP JSON-RPC connection: generate against its actual framing. [App-server reference](https://learn.chatgpt.com/docs/app-server).

### 6.3 Claude Code

Use the official TypeScript SDK's structured streaming path with an explicit native executable path and profile environment. Maintain an async input stream for interactive turns; do not scrape terminal ANSI into chat messages. Map tool-use/results, text deltas, native session IDs, permission callbacks, result/error/usage and supported rate-limit events into the generic event schema. [SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

Use `supportedModels`, `accountInfo` and `setModel` only where present in the pinned SDK and tested under Bun. Effort does not get an invented `setEffort` method: store the next-turn choice and, when the SDK requires construction-time effort, close at an idle boundary and resume the same native session with the new option. A queued turn retains its frozen setting. If resume fails, keep the chat readable and offer a fresh chat with an explicit context attachment; do not restart with missing history under the old chat identity.

Supply explicit `settingSources`, supported permission policy and MCP definitions. Native policies win over Glosa preferences. Do not enable bypass-permission modes by default, wrap `/login` in fake OAuth, or extract tokens. Login/reauth status uses the native CLI, with the same profile root as SDK execution. SDK result cost is an estimate, not evidence of subscription money spent.

The SDK package/runtime pair is a compatibility unit. Its process-launch seam, bundled runtime behavior, Bun support and distribution license must be proven before adoption; importing a JS package alone is not that evidence. If supervised SDK launch is unsupported, redesign the supported transport before release rather than weakening the lifecycle contract.

### 6.4 Model/settings changes and native resume

Apply changes at a turn boundary only. Never mutate the active turn while the UI shows another model. Record `settings_changed`, then record each subsequent turn's requested and effective values. Permission/MCP configuration changes that require a restart hold queued work, close the existing native connection, and require a new foreground admission for resume. No account change resumes an old native thread.

Runtime update does not rewrite native history. Record the version last used for each session; before resuming under a newer runtime, require the manifest's tested compatibility rule. A downgrade may be refused if native state was migrated irreversibly. “Rollback” means selecting a compatible prior binary, not promising reversible vendor data migrations.

## 7. Permissions, MCP, delivery and provenance

### 7.1 Human decisions

Persist each decision with runtime generation, provider request ID, operation digest, available choice IDs and expiry. Browser reply includes decision ID, choice ID, expected revision and request UUID. The first valid answer reserves the decision durably; a different answer from another browser is `409 decision-already-answered`. Repeating the identical answer ID returns its receipt. Do not send a reply after its native generation disconnected.

Unknown decision schemas fail closed. Expiry, stop, disable, token revocation and reauthentication deny/cancel pending decisions with the provider's supported semantics; if a reply cannot be delivered, terminate the managed connection. Show expired cards as history. Do not render them as reusable buttons after restart. Approval grants last only as long/as broadly as the provider's explicitly shown choice; no invented “Always allow” choice.

### 7.2 Glosa tools in managed sessions

Add an ephemeral managed-session MCP endpoint/bridge registered at native launch. It uses a random in-memory grant bound to runtime generation, workspace registration, Glosa session ID, allowed tools and expiry. The grant is not the daemon's durable pairing token. It permits the existing inbox, presentation, claim/release and supported edit-resolution operations for that exact binding; it cannot administer accounts, execute login, install runtimes, select another workspace or mint grants.

Extend authorization at this new endpoint rather than passing a new grant into the existing broad bearer gate and hoping the reporting principal restricts it. Existing `principalOfRequest` is reporting-only. Do not reuse the class-F document capability as an agent capability. The scoped bridge injects authoritative session/workspace identity and rejects conflicting arguments. Existing external MCP clients and pairing behavior remain intact.

For stdio MCP, launch a private bridge child under the same lifecycle owner. Give its grant through a private pipe/environment excluded from diagnostics, never in argv or model-visible tool metadata. Register only after the native runtime handshake is bound to the owned session. Revoke grants on stop, profile disable, token revocation, workspace lifecycle changes and daemon restart. No plugin installation into the user's main CLI configuration.

Every foreground managed run supplies app-owned Glosa workflow guidance separately from the user's message. Claude appends it to the native `claude_code` preset with `snapshot: false`, so resumed conversations receive the current guidance; Codex supplies `developerInstructions` on both thread start and resume. The guidance covers presenting tracked documents, reading and acknowledging feedback, claims and fences, honest resolution, human-edit precedence, and the fact that Glosa MCP is already configured. This is behavioral guidance, not an authorization boundary; scoped grants and native permissions still enforce access.

Before marking a turn as dispatched, prepare its native session and inspect the native MCP catalog. The built-in `glosa` server must be connected and expose every tool in the actual managed tool registry. Optional user servers do not determine built-in readiness. A bounded startup wait fails closed on an incomplete catalog, authentication failure or stalled status call. The turn records a readable **message not sent** error and can be sent again explicitly; Glosa does not replay it. Native startup disconnects are also unsent failures. Stop fences writers, closes the connection to cancel readiness, drains pending operations and proves owned process exit. A late readiness reply cannot submit a prompt.

### 7.3 Feedback routing and document changes

Managed chat Send is a chat-journal turn, not an additional `conversation_message` inbox entry. That avoids double dispatch. Existing annotation/human-edit inbox entries remain authoritative in the workspace bus and route through the provider delivery interface to the exact managed runtime/session, using the existing reservation/ack protocol.

Background annotation delivery must never start/resume a managed process or create inference. An already active, consented turn may receive pending entries through scoped MCP pull, following the existing presentation/ack contract. Otherwise hold them for the next explicit user action. Show a pending-feedback count and **Send feedback** action in that chat. This action creates a normal durable turn through ChatService, with `origin:feedback` and frozen references to the original immutable inbox IDs; it uses the same queue, consent ticket, concurrency budget and uncertain-dispatch rules as typed text. A background `AgentProvider.deliver` callback may only report queued/unavailable or use an already supported in-turn transport; it must not call native start-turn directly.

A queued annotation is not “presented” until the supported transport proves it entered that session's context. Bridge the workspace entry ID and chat turn/event ID for traceability without copying the entire entry into two mutable stores. Idle process closure/resume keeps the stable managed Glosa session ID and therefore the original exact targets; never choose another active chat just because it uses the same provider. Do not duplicate entries already presented through in-turn MCP pull when a later feedback turn is assembled; the workspace bus reservation/status is authoritative.

Before an edit, the managed agent must use the existing witnessed claim/application flow when supported. A tool card saying “edited” is not attribution evidence. Native writes outside a valid claim interval are `unknown`; editor saves are `human`; a person's save wins over an unfinished agent claim. Permissions to execute a tool and Glosa claims are different: a claim coordinates/proves a file interval, not an OS security boundary. Existing contention rules apply across external and managed sessions.

Where claim resolution requires an existing CLI/API operation not exposed by current MCP, extend the managed bridge to that established operation with the same validation; do not invent a new provenance shortcut. Tests must exercise concurrent human save, two managed chats, and a managed plus external session on the same tracked file.

### 7.4 User MCP configuration

Offer provider/profile defaults and workspace overrides, with a resolved list shown before enabling a server. Session launch receives a frozen resolved configuration digest. No silent import of global CLI servers. Each external server requires consent naming executable/endpoint, data scope and network destination; connecting is a foreground action. A server's native OAuth flow is separate from provider account login.

Show connection and needs-auth state only when exposed by the provider. Supported structured elicitation uses the same fenced decision machinery. Unsupported features show a reason. Tool-returned HTML/JS is never mounted. Resource links and images pass the same safe URL/content policy as ordinary messages; a text link is not permission to fetch its target.

## 8. HTTP, events and frontend implementation

All SPA access goes through `packages/spa/src/data-access.js`. Follow existing Host/Origin/Bearer/token-rotation rules and problem-response conventions. Agent settings and login endpoints are unavailable to class-F frames and managed MCP grants. Provider credentials, managed MCP grants and login secrets must never enter URL query strings/fragments, browser storage or error bodies. This does not change the existing Glosa pairing bearer in localStorage and its established pairing/redeem mechanism; changing that transport is a separate security migration. New login/stream routes do not add query-token authentication.

### 8.1 API surface

The following paths are proposed. Prefix consistency with the existing router must be preserved; these are added routes, not claims that they already exist.

| Route | Purpose |
| --- | --- |
| `GET /agents` | Installed providers/runtimes, capability summaries, profile metadata and cached observed status; no spawn/network |
| `POST /agents/profiles`; `PATCH /agents/profiles/:id` | Create; label/enabled/default changes with request ID and revision |
| `POST /agents/profiles/:id/auth/{login,probe,logout}`; `POST /agents/profiles/:id/discover` | Explicit foreground auth/model discovery task; returns an opaque task ID, not credentials |
| `POST /agents/profiles/:id/remove`; `POST /agents/runtimes/{install,update}` | Durable resumable local/account operation or explicitly consented runtime fetch |
| `GET /agents/tasks/:id/events`; `POST /agents/tasks/:id/{input,resize,cancel,claim-control}` | Authenticated SSE output; bounded input/resize/cancel; explicit input-control transfer; task/controller revision required |

| Workspace route | Purpose |
| --- | --- |
| `GET/POST /w/:slug/chats`; `GET/PATCH /w/:slug/chats/:id` | Page/create/read/update a chat; server checks registration association |
| `PUT /w/:slug/chats/:id/draft` | Debounced durable draft with revision; conflicts preserve both browser drafts |
| `POST /w/:slug/chats/:id/turns`; `POST .../turns/:turnId/{continue,cancel}` | Accept frozen prompt; continue held work; cancel/interrupt with idempotency |
| `POST /w/:slug/chats/:id/decisions/:decisionId/answer` | Fenced native decision reply |
| `GET /w/:slug/chats/:id/events`; `POST .../{archive,restore,delete,export,attachments}` | Replay stream; lifecycle operations; explicit export and validated attachment staging |

Use opaque IDs validated before filesystem access; derive all native/root paths on the server. POST returns `202` plus durable operation ID when work continues asynchronously; it does not imply native completion. `409` covers stale revision/identity/decision/queue conflicts; `413` oversized input; `422` unsupported selection; `503` unavailable runtime/storage. Include typed reason and recovery action. Return consistent not-found responses for IDs outside the authorized workspace.

Request JSON maximum 1 MiB; prompt text maximum 256 KiB UTF-8. Uploads are separate bounded bodies: at most ten attachments, 10 MiB each, 25 MiB total per turn, and the lower native limit always wins. Reject unsupported files before accepting the turn. Images are decoded/validated and served through safe local object URLs without external fetches; SVG/HTML are text attachments, never executable inline content. MIME is verified rather than trusted from extension. A selected document attachment freezes bytes/hash/version; later disk edits do not change accepted input.

### 8.2 Event transport

Use fetch-based SSE through the existing data-access layer so Authorization is a header. Native `EventSource` query-token workarounds are prohibited. Cursor contains chat ID, journal generation and durable sequence, validated against that chat. Do not reuse attached transcript inode/byte-offset cursors for managed events.

Initial snapshot gives durable state and watermark, then stream strictly after it. Buffer during snapshot/subscribe handoff or subscribe first and replay through the captured watermark so no events fall between the two. Deduplicate by event ID/sequence, never text. On old/invalid cursor, emit reset with a fresh snapshot reference. Reconnection and replay never call a provider.

Bound each SSE subscriber to 1 MiB/1,000 pending events; a slow reader is disconnected with resync required, without losing the journal. Native transport has an independent 8 MiB buffered-output ceiling; chunk large display payloads, spool bounded tool results to blobs, and fail/interrupt on sustained overrun instead of unbounded memory. Use backpressure where the SDK supports it; otherwise document the bounded stop behavior.

Workspace sidebar status rides a compact workspace event stream, without copying complete transcripts to every open browser. Login output has a separate ephemeral cursor/ring and a single input controller; its replay never enters chat storage. Redact raw protocol stderr and URLs before any diagnostic sink.

### 8.3 Dock and rendering changes

Replace implicit artifact detection with a discriminated panel parameter: `{kind:'artifact'|'diff'|'chat', version:2, ...}`. The current `!id.startsWith('diff:')` rule would treat every chat as an artifact. Audit focus, navigation, history, modes, claims, pane controls, URL state and shortcuts, not just `createPane`.

Migrate saved layouts once: recognize legacy artifact/diff structures using their existing parameters and valid artifacts, then write v2. A legitimate filename containing `chat:` must not become a chat. Unknown/corrupt panels are pruned without discarding valid neighbors. Key new layouts by installation identity plus workspace registration ID; import the old slug-keyed layout only after validating that it belongs to this registration. Browser storage is a convenience, not the chat database.

Create small modules for chat panel, message renderer, decision cards, account settings, login terminal and chat state projection. Reuse Markdown/link sanitation, diff rendering, existing focus/overlay primitives and design tokens. Plain modules can load published browser JS from vendored files. Pin xterm.js/addons with licenses, source URL, hashes and update instructions; no CDN. Package smoke must prove all assets ship without a build step.

## 9. Existing sessions, workspace lifecycle and migration

### 9.1 External-session chats

For every existing explicitly registered session, expose a persistent `origin:external` chat association keyed by workspace registration, provider and external session ID. Persist it on explicit registration/user opening, not by crawling global native history. An external chat is a mirror plus the existing composer/delivery service, clearly labeled External. Hide managed account/model/stop controls when the session cannot support them.

After daemon restart, a remembered association is Disconnected until the normal external registration/lease returns. It must not revive a lease from disk. Continue to use the existing transcript tailer and inode cursor; optionally retain only content already explicitly viewed if the user enables local history retention. Do not promise durable external transcript contents when the source has disappeared. Show an unavailable-source state without breaking documents or deleting the association.

Migration order: add external chat panels and exact-session composer routing; preserve older Conversation deep links as redirects to the corresponding chat; verify all contextual launch paths; then remove the menu entry and obsolete surface UI. In a workspace with several sessions, redirect through explicit selection, never “most recent.” Existing pending composer message IDs keep their original service/status recovery path.

### 9.2 Workspace ownership transitions

| Transition | Chat behavior |
| --- | --- |
| Missing directory | History remains readable. Block execution with Restore workspace location; never choose another cwd automatically. |
| Adoption/alias merge | Close admission under the ownership coordinator and stop affected runtimes. Preserve original chat/workspace identity as history reachable from the target's adopted-history list. To execute in the target, create a fresh chat with optional explicit context attachment. |
| Forget workspace | Preserve current live-session/exclusive-claim blockers. Offer explicit Stop managed chats and forget after a read-only preview; stop outside ownership locks, then reacquire/revalidate ordinary blockers. Only then extend the existing durable forget-operation manifest with managed chat IDs/owned storage roots before deleting any bytes. Revoke grants, delete chat data, and complete existing bus/index cleanup; resume cleanup after crash without spawning providers. |
| Re-register same path | A completed forget receipt does not resurrect deleted chats. A new registration can reuse a slug, but layout/history recovery also checks the registration lifecycle receipt. |
| Profile removed | Chats remain readable with a non-executable missing-account binding. User explicitly starts a new chat with another profile. |

External live sessions and remaining exclusive claims continue to block forget; the managed stop action does not kill external sessions, force-resolve claims, or bypass them. Ownership-unknown also blocks destructive cleanup. A workspace admission fence prevents new managed starts between preview/stop/revalidation; failure or user cancellation releases that operation's fence without resurrecting cancelled turns. Adoption follows the same stop-before-ownership-lock pattern and existing refusal/rollback rules.

Forgetting a workspace does not delete the account's entire native history/config root, because other workspaces share that account. The confirmation must state that Glosa chat copies are removed while the provider may retain native session records. If the provider offers a supported per-thread deletion, expose it as a separate explicit action; otherwise give an accurate limitation. Do not edit undocumented native databases to promise complete deletion.

## 10. Installation, consent, privacy and operations

### 10.1 Runtime manifest

Each tested manifest records provider, native version, architecture, source URL, artifact hash/signature verification method, SDK version, protocol-schema version, normalizer version, Bun/macOS floor, supported features and resume compatibility. One immutable installed directory per tuple. No `latest`, `npx` at chat creation or runtime self-update. Disable provider auto-update/telemetry through documented supported controls and test their effect; do not patch vendor executables.

Install/update is an explicit foreground action with destination and download size if known. Download to a private staging directory, verify official origin/integrity, prevent archive traversal/symlink extraction, validate executable/architecture and run only bounded non-inference version checks after permission. Atomic rename installs the manifest; failed install leaves the previous version intact. Active sessions retain their binary. Old versions remain while referenced by resumable chats; removal is explicit.

Use a managed tested runtime normally; optionally allow an absolute custom executable after explicit selection, version probing and compatibility check. A custom path never inherits the system CLI's credentials/config. Missing or changed executable identity is a visible unsupported state. No background update checks, model warm-up, usage polling or arbitrary URL installer.

The new APIs require a Bun minimum that actually supports native Terminal and tested process-group behavior. The current application's old floor is insufficient evidence. Set the new floor from a compatibility test on that release, update package/CLI diagnostics/A6/CI together, and refuse managed features on an unsupported Bun while preserving any supported document-only operation. The probes in §13 use Bun 1.4.2; they do not establish a lower supported floor.

### 10.2 Consent records

Versioned consent names provider/profile, workspace root/scope, transmitted prompt/attachments/instructions, tool execution policy, MCP endpoints, runtime version policy and action purpose. Connect permits native authentication, not automatic model inference. First Send permits the stated run and explicit queue; browsing history permits neither. Expanding scope or changing effective billing route requires a new consent revision before dispatch.

Revocation closes admission synchronously and stops affected work; it cannot retract bytes already sent. Child process egress is distinct from the SPA's CSP: class-F frames remain network-blocked, while the chosen native runtime may contact disclosed provider/tool endpoints during authorized execution. If native telemetry cannot be disabled through supported configuration, the provider cannot meet Glosa's zero-telemetry contract and stays unsupported. Do not describe OS-wide network enforcement that Glosa does not implement.

Never store provider tokens, full login URLs/device codes, environment dumps, raw authentication stderr or secret tool arguments in Glosa diagnostics. Normal chat/tool content may itself contain user secrets; there is no universal redactor that can make arbitrary transcripts safe to publish. Diagnostics default to IDs, versions, event types, timings and redacted errors; including content requires an explicit reviewed export. No external crash reporting.

### 10.3 Resource budgets

| Resource | Initial bound and response |
| --- | --- |
| Active managed turns | Four globally, two per profile, one per chat. Excess requests remain accepted/held with a visible waiting reason; cancel available. No hidden account fallback. |
| User queue | One next turn per active chat; no persistent scheduler or post-restart auto-run. Admission fairness is FIFO across ready chats within eligible profile limits. |
| Provider decisions | At most 32 unresolved per runtime; reject/stop on protocol overflow. Human-response timeout ten minutes, with remaining time visible. |
| History | Page 100 logical messages initially; cap mounted inactive messages near 200, preserving focused/selected regions. Chat search uses disposable local indexes. |
| Disk/output | Enforce event/upload/buffer bounds above; retain original history until explicit deletion. Disk-full closes admission and interrupts before additional uncontrolled output. |

Model inference has no arbitrary total-duration timeout while progress is reported. Native handshake/status: 30 seconds; protocol control request: 15 seconds; inactive transport health timeout must distinguish a legitimately long-running tool from a dead connection using supported native signals. Report stalled versus disconnected accurately; never resend a turn based on elapsed time alone.

## 11. Source map and contract amendments

Source references below were inspected after refreshing Graphify against the research merge. They are integration seams, not claims that the new feature already exists.

| Existing source | Required work |
| --- | --- |
| [provider interface](../../packages/daemon/src/agent-provider/interface.ts), [session registry](../../packages/daemon/src/registry/session-registry.ts) | Add optional managed boundary; distinct managed IDs/generations; keep external lease semantics and existing lock order. |
| [daemon lifecycle](../../packages/daemon/src/lifecycle/daemon.ts), [journal](../../packages/daemon/src/bus/journal.ts), [workspace identity](../../packages/daemon/src/workspace.ts) | Supervisor/guardian integration, shutdown/replacement guard, generic append primitives and separate replay stores keyed by registration. |
| [authorization](../../packages/daemon/src/security/auth.ts), [MCP shim](../../packages/cli/src/mcp.ts), [composer](../../packages/daemon/src/services/composer.ts) | Restricted managed MCP grants, exact delivery bridge, separate managed send versus external composer. |
| [dock](../../packages/spa/src/dock.js), [viewer](../../packages/spa/src/viewer.js), [conversation](../../packages/spa/src/conversation.js), [data access](../../packages/spa/src/data-access.js) | Typed panel migration, new chat/settings/login modules, preserve external transcript/composer adapter, one fetch boundary. |
| [transcript stream](../../packages/daemon/src/transcript/stream.ts), [workspace index](../../packages/daemon/src/registry/workspace-index.ts) | Keep attached cursors separate; adoption/forget lifecycle references and durable cleanup manifests. |

Proposed new code areas are `packages/daemon/src/agents/` (control, profiles, supervisor, guardian, grants, runtime manifests), `packages/daemon/src/chats/` (journal/replay/service/decisions), managed adapters within the two existing provider packages, routes following existing daemon conventions, and small SPA modules. Do not create a shared package until a real public cross-package boundary needs it. Package file lists must include new runtime modules/vendor assets.

| Normative document | Amendment shipped with relevant code |
| --- | --- |
| Requirements R4/R6 and A2 §F08 | Explicit opt-in managed topology alongside unchanged companion topology; ownership, registration without plugin, first-class chats. |
| A1 | Agent/chat/login routes, event schemas/cursors, idempotency/error/status contracts, exact capabilities. |
| A3 | Child env, native auth/config isolation, scoped MCP grants, foreground consent, login PTY and native-process egress threat model. |
| A4/A5 | Chat/control authority and durability, dispatch uncertainty, lock ordering, workspace deletion/adoption, owned-process shutdown/recovery/replacement. |
| A6/testing/T8 | Bun/runtime installation floor and distribution; compatibility manifests; selected regression/acceptance coverage and attended multi-account rehearsal. |

The historical, now closed [issue #157](https://github.com/davebream/glosa/issues/157) asked for a decision record revisiting “glosa never launches an agent,” not simply a chat UI. The implementation must add its requested Launching sessions decision entry, preserve the old invariant verbatim for history, document prerequisites/security/roadmap placement, update the above contracts in the code PR, and cover pluginless registration/child environment lifecycle. Forward-reference assumptions in #151 and #160; do not silently broaden those issues. This specification alone does not close #157 or implement the feature. Whether a completed feature closes it must be checked against its then-current acceptance criteria.

## 12. Delivery slices and acceptance contract

Build Claude first, then Codex parity; release both together. The maintainer confirmed this ordering after the original specification. The maintainer is not pursuing Anthropic confirmation at present: implementation and isolated synthetic tests continue, while public managed execution stays gated. No partial one-provider public rollout is authorized. Deliver vertical slices behind explicit provider availability gates. A hidden feature flag must not weaken existing document review. Each code PR updates the normative contracts it changes and has observable failure tests, with critical guards ablated to produce a named red per [testing convention](../testing.md).

| Slice | Work and dependencies | Exit evidence |
| --- | --- | --- |
| S0: contracts and compatibility | G1 determination; pin a candidate tuple; native auth/isolation/SDK-supervision/PTy/process-group spike; choose exact Bun floor | Recorded attended evidence; no support claims from mocks. Failure may leave Claude gated while generic work proceeds. |
| S1: persistence and ownership | Control/chat stores, validators, replay/idempotency, supervisor/guardian, environment resolver, scoped grants | Crash-window, journal corruption/disk-full, process ownership and cross-profile negative tests; no UI/native inference needed. |
| S2: Claude vertical slice | Profile/login settings, SDK process bridge, one managed chat panel, approval, stop, resume and usage. Prove Claude first internally. | Deterministic process/protocol/browser evidence first; attended native qualification and the offering gate remain required before public activation. |
| S3: Codex parity | Isolated native login and app-server adapter on the same account, chat, decision and process-control contracts. | Identical generic acceptance with Codex-specific protocol fixtures and attended two-account qualification. |
| S4: complete workspace UX | Sidebar/dock migration, external-session tabs, queue, attachments/export, MCP settings, disable/remove/adoption/forget, T8 | Legacy delivery preserved, all acceptance rows below, browser review and maintainer rehearsal. Remove old Conversation entry last. |

### 12.1 Accounts, execution and durability

| ID | Trigger | Required observation and cheapest sufficient boundary |
| --- | --- | --- |
| AC-01 | Login A/B for the same provider; run A/B concurrently; inspect default CLI separately | Native reported identities match selected profiles; main CLI config/auth unchanged. Attended isolated-profile test; synthetic env tests alone are insufficient. |
| AC-02 | Three enabled accounts; default change; disable all; enable one | Existing chats retain account; new draft uses only explicit eligible default; no silent selection. Service integration plus browser picker. |
| AC-03 | Expired auth; failed probe; reconnect into wrong identity | Correct distinct UI states, old thread blocked on mismatch, draft/history preserved, no API fallback. Native ceremony plus deterministic protocol cases. |
| AC-04 | Disable/revoke concurrently with queued send and approval click | No new admission after local fence; no native write after guardian fence acknowledgment. Already handed-off bytes remain in flight and are cancelled conservatively. Active run stopped or ownership-unknown blocks launch. Barrier-controlled daemon/guardian integration; ablate both epoch checks. |
| AC-05 | Change model/effort; switch provider/account after start | Frozen active/queued settings; next turn gets supported new setting; provider opens a new tab without implicit transcript; same-provider subscription stays on the chat with a new isolated binding and text-only handoff. Adapter/service plus real browser. |
| AC-06 | Crash at every dispatch/approval boundary; same request retry | No duplicate local intent or blind external resend; unknown outcomes explicit; resolved answers cannot be replayed to new generation. Fault-injection integration. |
| AC-07 | Torn record, bad interior control event, ENOSPC, short write | No execution from untrusted replay; no ACK without durable intent; no lost valid neighbor chat. Real file/journal fault tests. |
| AC-08 | Daemon SIGKILL/stall, guardian exit, shutdown during tool, stale PID | Owned ordinary tree stops; escaped/uncertain ownership is reported and blocks replacement; unrelated processes survive. Real synthetic subprocess tests plus attended native G3. |
| AC-09 | Restart/open history/refresh browser or background feedback while idle | No login, discovery, update, MCP connection or model egress automatically; explicit Send feedback goes through ordinary turn admission; correct snapshot/stream handoff. Injectable network/spawn boundary with named negative control. |
| AC-10 | Update native runtime while old thread exists | Active process unchanged; explicit next-use compatibility check; unsupported downgrade refused. Install/resume integration with fixture executables. |

### 12.2 UI, security and existing Glosa behavior

| ID | Trigger | Required observation and cheapest sufficient boundary |
| --- | --- | --- |
| AC-11 | Legacy layouts, legitimate `chat:` filename, missing panel, reused slug | Correct kind/focus; valid documents retained; no old workspace chat leakage. Pure migration cases plus browser saved-layout restore. |
| AC-12 | Two external sessions and two managed chats in one workspace | Explicit routing; registry restart does not revive external leases; old composer message receipts remain valid. Existing delivery/transcript integration extended. |
| AC-13 | Human save during claimed managed edit; managed/external overlap | Existing human precedence/unknown drift/proven interval attribution preserved. Existing real filesystem/Git acceptance owners extended. |
| AC-14 | Two browsers answer; refresh while permission pending; late reply | One native response; pending state restored within same generation; stale response rejected. Service concurrency plus DOM/browser focus checks. |
| AC-15 | Hostile Markdown/tool HTML, OSC clipboard, malicious links, huge output/upload | No execution/exfiltration, bounded memory, safe error, document surface remains usable. Renderer corpus plus real browser CSP/terminal checks. |
| AC-16 | Managed grant calls settings/another workspace; class-F calls login; token revoked | Denied at authorization boundary, no credential response, streams/grants closed. Security attack-table integration; ablate scope check. |
| AC-17 | Forget/adopt races with start and process output; crash during cleanup | No write/dispatch after ownership fence; correct resumable deletion/retention; no reappearance after re-registration. Existing lifecycle integration extended. |
| AC-18 | Scrolled/selected text while streaming; keyboard/IME/screen reader/reduced motion | Stable reading/focus/selection, no accidental send, accessible decisions and narrow layout. Real browser plus attended accessibility review. |
| AC-19 | Package install without build; offline history; zero adapters | Assets/runtime guardian available, history/documents usable, no hidden provider dependency/network call. Package smoke and generic-core integration. |
| AC-20 | Usage counters reset/compact; quota missing/stale; account limit reached | Correct scoped labels, no false percentage/invoice or account rotation. Recorded native event fixtures and attended observation. |

Tests should extend existing owners where possible. Do not write source-string assertions pretending to verify account isolation, cancellation, egress or visible layout. For each mock state what remains unproved, retain stdout/stderr and owned process cleanup evidence in ignored local test artifacts, and keep real provider credentials/transcripts out of CI.

## 13. Evidence collected for this specification

Baseline: research merged in commit `42556f223a2d455c88ad810cf456660f20f2fce7`. Graphify was refreshed before tracing provider/session/journal/dock/MCP relationships (12,224 nodes, 31,250 edges); the relevant source was then opened and checked. The graph was used as an index, not proof of behavior.

| Check run on 2026-09-23 | Result | What it establishes |
| --- | --- | --- |
| Focused dock, conversation, journal, session-registry and shutdown suites | **75 passed; 0 failed** on Bun 1.4.2 | Existing migration/lifecycle seams behave as their current tests specify. These are baseline checks, not tests of the proposed feature. |
| Documentation consumer suite (`bun run test:docs`) | **219 passed; 0 failed** | Existing documentation/package contract consumers; not managed feature acceptance. |
| Existing workspace forget suite (independent reviewer) | **28 passed; 0 failed** | Current preview, blocker, ownership-lock and resumable cleanup behavior. Proposed managed-stop integration remains unimplemented. |
| Native `Bun.Terminal` with an isolated `/bin/sh` read/echo fixture | **Passed**; actual input and terminal output observed, process/terminal closed | This machine's Bun can host a PTY without a native addon. Not native Claude/Codex login compatibility. |
| `Bun.spawn` detached `/bin/sleep`, group inspected with `ps`, group SIGTERM and awaited exit | **Passed** | This machine creates a distinct owned process group and can terminate it. Not a proof of guardian crash handling, detached descendants or native SDK ownership. |

A separate adversarial source review found five contract gaps: child-process dispatch fencing/recovery evidence, stable logical session identity, forget blockers, foreground feedback admission, and pairing-token wording. All were corrected and the focused re-review found no remaining material contradiction. A cold-read also replaced the speculative SDK launch seam with the published interface and made proposed behavior, baseline evidence and unproved native compatibility distinct.

No provider authentication, credential read/import, model call, dependency installation, live manuscript run or new application code was performed. The proposed compatibility, fault-injection and T8 scenarios remain implementation work. Published package interfaces and product terms are grounded in the [source-linked research](../research/2026-09-23-agent-chat-integration.md); they must be rechecked for the exact release tuple chosen in S0.

## 14. Definition of implementation completion

The feature is complete only when both provider paths intended for release satisfy their gates; a deliberately unavailable Claude path is a partial rollout, not completion of the requested two-provider experience. Accounts remain isolated across every login/run/resume/status operation, first-class chats replace the old navigation without losing external sessions, all AC rows have appropriate evidence, and normative docs/package metadata agree with the implementation.

The maintainer can review document and chat side by side, run either native agent under an explicitly selected subscription account, answer genuine native decisions, stop it, recover from expired authentication, and switch provider into a fresh tab without surprising billing, hidden history transfer, credential crossover or false document provenance. That observable behavior is the acceptance target.

## 15. Implementation evidence and remaining release qualification

The implementation following this specification adds the managed provider boundary, supervised
native processes, immutable intent journals, isolated account profiles, native authentication,
first-class chat tabs, exact external-session migration, workspace feedback tools and MCP settings.
It retains the vanilla-module UI and keeps provider imports in the CLI composition root.

The public execution gate and both runtime qualification flags remain **false**. This records
implemented, reviewable code; it does not claim the two-provider acceptance target in §14 is met.
The maintainer instructed implementation to continue without obtaining Anthropic confirmation now.
Attended native qualification has begun using separate profiles and a synthetic workspace.
Native Claude and Codex inference, plus Claude approval, were exercised with synthetic prompts. No user credential
import, real manuscript run or T8 sign-off is claimed by the evidence below.

### Evidence obtained

| Boundary | Observation | Limit |
|---|---|---|
| Complete repository gate | `bun run check`: 3,263 tests passed across 210 files; zero failures. Lint, typecheck, version consistency and formatting passed. Package smoke verified 231 packaged files; secret scan found no leaks. | Local candidate evidence; not native account qualification or maintainer release sign-off. |
| Actual pinned installation | Claude CLI 2.1.280 / SDK 0.3.280 and Codex 0.156.1 installed in isolated private homes using frozen dependency locks; executable and dependency-tree integrity verified. The initial Codex installation needed 398 seconds; a later attended download exceeded the former 600-second limit. The bounded installer now allows 20 minutes, reports a specific timeout, and disables HTTP idle expiry while retaining owned-process cleanup. | Installation is not authentication, account isolation or inference compatibility. macOS arm64 only was exercised. |
| Attended Claude login | The initial `/login` entered theme setup. Switching the pinned CLI to `auth login --claudeai` went directly to native browser sign-in and reported success. A subsequent native probe identified the first profile as authenticated on a Max plan. After correcting the qualification harness, re-login preserved that identity and the native fallback credential file was absent. Read-only metadata checks found distinct Keychain entries for the two private profile roots; both providers' default config/auth file hashes were unchanged. | The first test incorrectly replaced the OS home and omitted the OS username, provoking a Keychain dialog. Native fallback storage stayed inside the profile with mode `0600`. The harness now retains the OS home/username while isolating provider config; production already preserves these platform variables. Early additional slots reported the same account as the first; the subsequent distinct-account check below supersedes that limitation for the two Claude accounts exercised. The initial default-CLI identity probe also omitted the OS username; its comparison is invalid and has been replaced with a correctly configured baseline for subsequent checks. |
| Attended Claude execution | The authenticated SDK returned 11 available models. Native chat produced the requested token, a follow-up recalled it, and the same native session resumed after daemon restart. A real Bash permission request reached the browser; Allow once created the expected disposable file. Stop changed a running turn to cancelled and confirmed process exit in under one second. The stream now renders each completed block once, including after thinking blocks. Signing out profile B removed only its Keychain entry; A remained authenticated and executed these turns. | Both profile slots had the same observed subscription identity, so this does not prove distinct-account isolation. A subsequent Haiku-to-Sonnet change reported Sonnet on the same native session; native effort remains unreported. Cancellation covered the native agent, not a running long-lived tool descendant. The corrected ordinary-CLI auth baseline remained unchanged; no secret values were read. |
| Distinct Claude accounts (2026-09-24) | Two profiles reported different subscription identities, both Max, with separate native Keychain service entries. B returned the requested synthetic token, then A returned another token from its existing chat. Making B the default and restoring A succeeded without changing either existing chat’s account. Default Claude/Codex config and credential-file hashes and the corrected ordinary-CLI auth baseline remained unchanged. | Scoped evidence for these two accounts on macOS arm64. Full config/egress qualification, two-account Codex, and native expiry/refresh behavior remain separate gates. No credential contents were exported. |
| Attended Codex execution | The pinned runtime installed successfully on the retry. Native sign-in and a fresh app-server probe identified the selected Pro subscription. Model discovery succeeded. Switching the started Claude chat to Codex opened a separate empty tab with only explicit transfer controls; after workspace consent, Codex returned the requested token and a follow-up remembered it. Both native turns completed with stopped runtimes and reported token/quota fields. A later Stop cancelled an admitted turn and confirmed native exit. | One Codex account was available. This does not prove two-account isolation, native Codex approval, OAuth to external MCP servers or x64 support. No previous Claude conversation was attached or sent to Codex. |
| Attended per-chat subscription switching (2026-09-24) | One synthetic chat ran Claude A → distinct Claude B → A. Each native turn returned the exact codename from prior message text; all three native IDs and Glosa bindings differed. Global defaults and the sampled default CLI config/auth file hashes stayed unchanged. The combined picker then changed the same chat to B and retained that subscription after browser reload. | This qualifies the exercised Claude flow only. One Codex account was available; same-provider Codex account switching remains unverified against two real subscriptions. Automated coverage separately exercises stopped partial replies, queued handoff consumption, consent, replay and turn attribution. |
| Pinned native control probes | Fresh macOS arm64 profiles with networking blocked exercised actual Codex initialization, `config/read`, `account/read`, and Claude `auth status`. Captured Codex defaults exposed a clean-profile rejection; Claude's signed-out exit 1 exposed an incorrect error state. Both fixes passed native rechecks and named regression tests. The real Claude SDK also completed `supportedModels` and `accountInfo` through the supervised process bridge, then correctly rejected an unmatched identity. All owned process groups stopped. | The SDK bridge probe injected only the preliminary status to reach that transport without credentials; its native account check remained real. No prompt, live sign-in, billing, inference, unrestricted egress, or two-account isolation was tested. |
| Native process supervision | Real synthetic processes prove owned-tree cleanup, native cleanup grace after wrapper exit, no-child recovery, capacity, large-frame serialization and revocation during a partial frame. | No claim about deliberately escaped descendants or either vendor runtime's full behavior. Unproved ownership blocks further managed execution. |
| Local service and persistence | Durable retry receipts, disabled-profile admission, decision races, account-scoped cleanup, exact managed tools, queue holds, corrupt unrelated history, search/paging and draft transfer exercised with isolated state. | Synthetic adapters prove Glosa's boundary, not vendor compatibility. |
| Browser | Real Chromium exercised keyboard send, streamed selection, inert hostile markup, narrow layout, account menus/defaults, verification recovery, draft transfer and explicit transcript preview/upload. The real workbench suite passed all six scenarios. Desktop light/dark and 390px account/chat views were also inspected in the isolated preview; no page overflow or browser errors were observed. | The automated chat stream uses a deterministic adapter. The preview read existing attended native conversations; this visual pass did not submit new inference. |
| Adversarial review | Independent review found sign-out deletion, suppressed interrupt, shortened cleanup grace, destructive forget ordering, stranded pending IDs, oversized write rejection and prelaunch ownership poisoning. Live execution also exposed process-exit/fence races and blockwise message duplication. Review identified a missing install response timeout guard and the empty-block indexing edge case. Each was fixed; review also found retained login output after uncertain cleanup and ownership release after a late preflight failure. Both were repaired and their failure paths pinned by regression checks; focused re-review covered the resulting fixes. | Review is not a native-provider qualification certificate. |
| Guard ablation | Temporarily removing native admission, the bus mutex revocation check, sign-out preservation, per-chunk admission, process-group grace, effective-configuration audit, project-configuration preflight, shared-stream reuse and snapshot retry produced the corresponding named failures. Restored guards passed. | Further UI ablations produced named failures for settings/upload send races, missing-model admission, recovered process ownership, filtered transfer content, closed-preview lifetime and draft-transfer retry identity. Restored guards passed the complete gate. The named tests cover their explicit observation boundaries only. |

### Implemented behavioral details clarified during review

- The workspace sidebar now has independently collapsible Artifacts and Chats sections. Chat rows
  expose account identity and pending replies; tabs distinguish work in progress, replies needed
  and unconfirmed cleanup. Creating a chat does not launch an agent; model discovery and sending
  are explicit foreground actions.
  The first accepted prompt supplies a local title unless the user already renamed the chat.
- The composer keeps account, model, effort and attachments visible, while workspace
  tools and account maintenance use disclosure controls. Uploads and settings changes finish before
  sending; partial upload success is retained. Waiting messages can be cancelled independently,
  held messages require Continue, and cancelled messages can be restored as an unsent draft.
  Retry stop remains available until owned-process recovery independently confirms exit.
- Transcript transfer previews the source, message count, UTF-8 size and destination account. It
  includes user and assistant text, excluding tool payloads, reasoning and approval metadata.
  Closing a tab cannot leave a delayed preview dialog behind. A definitive draft conflict resets
  the transfer revision; an ambiguous failure retains the original durable request.
- Account settings distinguish failed verification from signed-out or mismatched identity. Local
  monochrome Claude Code and OpenAI marks use exact upstream SVG paths, recorded in the third-party
  notices. Usage separates conversation totals from account limits with their reported source
  and observation time; cumulative tokens never become an invented current-context percentage.
- Sign out invokes native logout and preserves native session history/configuration; Remove deletes
  only that account namespace after confirmed shutdown and successful native cleanup.
- Stop admits only the bounded native cancellation call chain after fencing normal input. Every
  transport chunk rechecks authority; partial-frame revocation closes input and proceeds to owned
  process termination instead of appending another protocol message.
- Chat/workspace associations and purge member lists are durable control-journal records. All managed
  roots are preflighted before destructive work; managed purge precedes workspace bus deletion.
- A started chat's provider change opens a fresh tab with explicit draft/transcript transfer. A
  same-provider subscription change keeps the existing tab and draft, persists the selected account
  and allocates a new native session/Glosa binding. The next explicit send carries a bounded frozen
  copy of user messages, text attachments and assistant text, including stopped partial replies.
  Image bytes, tool output, reasoning, approvals and native IDs are excluded. The text handoff is
  capped at 10 MiB and counts toward the turn's 20 MiB attachment budget; oversized history requires
  a new chat with a shorter excerpt. Successful handoff is recorded so queued turns do not resend it.
  Target-account consent is checked at send time. Neither selecting an account nor reopening the
  tab starts a runtime, and global defaults remain unchanged.
- MCP status is read from an active native connection. MCP authentication uses a separate bounded,
  workspace-bound native terminal: Claude's original `/mcp` manager or Codex's `mcp login` command.
  Codex uses file storage for both account and MCP credentials in its private `CODEX_HOME`.
  Provider login URLs retain a strict hostname allowlist (including the pinned Claude login’s current `claude.com` host); MCP login exposes an HTTPS destination
  for the user to inspect and open. No authorization URL is persisted in Glosa's journals.
- Native configuration is checked independently of account identity. Claude disables inherited
  settings, unlisted MCP servers and account-connected web tools. Codex starts in a neutral
  directory, disables apps/plugins/hooks/telemetry/update checks and login shells, and audits
  `config/read` before account operations and each thread start/resume. Unexpected effective
  settings or inherited MCP endpoints fail closed without rewriting user/organizational policy.
  Project configuration is rejected at dispatch, including linked-worktree configuration and
  dangling links; AGENTS instructions remain available. This is deliberately conservative:
  unsupported custom or managed settings require qualification, not an automatic bypass.
  The native startup egress and operating-system policy checks remain part of G2/G3.
- Workspace, sidebar and managed-chat panes share one browser stream. Advisory chat invalidations
  reload bounded durable snapshots; reconnect performs the same recovery. A real three-window
  document regression exposed connection starvation from the first per-pane stream design,
  prompting this change. Document-only surfaces do not subscribe to the chat list.
- Native login survives suspended browser polling for its original ten-minute deadline. The previous thirty-second polling lease could kill the callback server while the user signed in elsewhere. Explicit cancellation remains immediate; completed output also expires. Ended login views revoke old browser links and terminal input and explain how to start again. If process exit is uncertain, sensitive output is cleared immediately while the ownership blocker remains; even a later preflight failure cannot release it.
- Native cleanup always attempts owned stop after an SDK close/fence race. A confirmed process-group exit releases the operation; uncertain exit continues to block execution. Late launches are stopped before their fenced handoff rejects.
- The Claude stream normalizer uses native block indexes when present, with a completed-block offset for non-streamed envelopes. Empty blocks need no finalized envelope and do not shift later text. Sidebar account labels load independently of creating a new chat, and refresh after account renaming.
- Requested turn settings remain separate from native-reported effective settings. Unreported effort
  stays unknown. Codex refuses a reported model mismatch before submitting the prompt. Account
  quota notifications display only reported values with observation time, not inferred balances.

### Managed-tool startup verification (2026-09-24)

The provider fixtures exercise native instruction fields, unchanged user messages, incomplete catalogs, native authentication failures, paginated catalogs and successful preparation before dispatch. Service tests cover unsent failure and explicit recovery, missing adapter readiness support, a stalled read, Stop/late-reply races, process release, and native startup disconnects. Negative controls temporarily removed catalog enforcement, adapter readiness enforcement and Claude prompt freshness, and restored the old drain-before-close ordering; each produced a named failing regression before source restoration.

An additional offline witness used the installed Claude Code 2.1.280 / Agent SDK 0.3.280 and Codex 0.156.1 against a synthetic loopback MCP endpoint with the production tool schemas. Both reported all seven Glosa tools connected before any prompt. Separate empty profiles were used, external networking and reads of the main CLI/keychain directories were blocked, no model prompt or tool invocation was sent, and owned processes exited. This verifies native catalog wire behavior; it does not prove authenticated model behavior or satisfy the remaining release gates. An independent adversarial review found and rechecked the cancellation ordering, resumed Claude instruction freshness and native-error classification fixes.

### Still required before activation

G1 subscription-integration release determination, G2 real multi-account/config/keychain isolation,
G3 actual native SDK/app-server/PTY/process-tree qualification, every remaining attended acceptance
scenario (including native MCP OAuth), and the expanded T8 maintainer rehearsal remain open.
The exact x64 runtime tuple also needs its own native evidence. Repository CI and package smoke
cannot substitute for these gates. The Codex configuration fixture now records the pinned binary's
actual response, and unauthenticated control probes cover both providers. Claude now has scoped authenticated evidence for permission decisions, streaming, cancellation and resume; Codex now has scoped authenticated evidence for native sign-in, model discovery, streaming, follow-up resume and Stop; its native approval checks remain open. Two distinct Claude accounts have now signed in and executed independently; cross-account refresh/expiry, two-account Codex, native questions/MCP OAuth and running-tool descendant cleanup remain separate attended scenarios. The earlier §13 observations describe the pre-implementation
specification review; the observations in this section describe the subsequent implementation.


## September 24 interface refinement

The accepted interface direction replaces the earlier account-heavy sidebar and form-like composer:

- One stable top search opens the existing keyboard palette. Artifacts, managed chats, terminal sessions and commands share it. Managed-chat search queries the full workspace history, including archives, and pages older results inside the palette. Search generations discard stale responses; switching workspace clears cached chat destinations immediately. Terminal-session search uses its displayed identity, not transcript full-text.
- The sidebar contains at most 20 title-only rows, pinned before recent conversations, with no count and no separate filter. Pin/Unpin is available in each managed row's hover/focus menu. Account and activity information remains in the row tooltip and active conversation controls.
- Settings is a named destination with Agents & accounts and Appearance. Provider runtime status comes first. A missing runtime has a prominent install action; installation visibly locks controls and reports its native phase, elapsed time, completed package count and approximate completed archive bytes. Bun reports archive sizes after download completion, so progress stays indeterminate: no invented percentage or transfer rate. Quiet installer output and a lost status connection are distinguished, and polling survives a disconnected install response until status reconciles. Account setup stays disabled until the runtime is installed and the build permits managed account operations. Account selection displays one detail view instead of an expanding stack.
- Human messages use right-aligned bubbles; assistant prose remains unboxed. Visible author labels are removed while semantic names remain. Account/model/effort controls are borderless and size to the selected label. All existing approval, permission, transfer, upload, queue, stop, MCP, recovery and export behavior is preserved.
- The user's final icon reference selects the Claude asterisk and OpenAI knot for Codex. Both are locally embedded, monochrome, small Lobe Icons assets with pinned MIT attribution; no icon library or network dependency is added at runtime.

The independent design critique scored the preceding interface 21/40; that is not a post-change score. The Astra review identified Enter-key routing and stale workspace/search destinations; the implementation corrects these. Browser inspection verified the selected-label sizing rather than assuming CSS intrinsic sizing works. Focused tests cover installation locks and recovery, stale search responses and pagination, native filter-button activation, the 20-row cap and persistent pinning. Temporary removal of the runtime gate and stale-search guard each produced a named failing test; exact source was restored afterward.

The workbench retains its existing 360px minimum pane width. Showing the 232px navigator alongside it requires 592px; narrower windows can hide the navigator or scroll the desk. This refinement does not change that existing desktop-layout contract or any managed-provider release gate.

Validation before the installation-progress and spacing follow-up: `bun run check` passed 3,268 tests across 210 files, plus lint, typecheck, version and format checks. Package smoke passed for 231 packaged files. The live documentation corpus gained three editable blocks in DESIGN.md; only its measured denominators changed (756 blocks / 686 edits), with all serializer-loss and detection counts unchanged. Real-browser checks exercised the missing-runtime lock, visible installation state, duplicate-click prevention and successful unlock, and measured 16px provider marks at a 390px Settings viewport without overflow. The follow-up adversarial review found no remaining blocker in the four repaired interactions. This is interface validation, not evidence that the outstanding native-provider activation gates have closed.
