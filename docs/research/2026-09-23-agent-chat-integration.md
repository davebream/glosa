# First-class agent chats in Glosa

Research date: **2026-09-23**. Status: **design input, not an accepted architecture decision**.

This report investigates hosting local coding agents behind Glosa's own interface, using the user's provider subscription where supported. It covers account isolation, agent transport, rendering, lifecycle, usage, and the changes required by Glosa's existing contracts. It does not change the roadmap, authorize runtime egress, or establish live-provider compatibility.

## Recommended direction

**Make chats persistent workspace objects displayed in ordinary content tabs. Let Glosa manage explicit agent profiles and local processes, while the original provider runtime owns authentication and agent execution.**

| Decision | Recommendation | Why |
| --- | --- | --- |
| Product surface | Workspace chat list in the left sidebar; chat panels in the existing dock; remove the contextual Conversation entry after migration | A chat needs a stable identity and navigation independent of whichever document is open |
| First two integrations | Codex app-server; Claude's official runtime through a supported structured interface, conditional on the authentication determination below | Preserves native agent behavior and exposes interactive controls without scraping terminal output |
| Extensibility | Keep the Glosa provider boundary; evaluate stable ACP v1 against the same acceptance scenarios | ACP is a credible reusable transport, but provider features and account semantics still need adapters |
| Accounts | Separate Glosa-owned configuration root for each provider account; vendor-owned credentials; explicit account selection | Three plans must remain three distinguishable identities, without silently sharing the terminal CLI's configuration |
| Renderer | Extend the existing vanilla renderer initially; consider assistant-ui only with an explicit frontend-stack decision | Maintained React components exist, but adopting them changes Glosa's fixed no-build, no-heavy-framework stack |

The most useful combination is **Conductor for interaction design, Paseo for lifecycle and provider architecture, Claudexor for account-profile semantics, official runtimes for execution, and ACP for a possible common transport**. No inspected package supplies all of those concerns as a mature, stack-compatible, drop-in library.

Five decisions remain before a final implementation specification:

1. Confirm the permitted Claude distribution/authentication path for Glosa's exact offering.
2. Choose direct provider integrations or ACP after a small parity experiment.
3. Retain vanilla rendering or explicitly approve a React surface.
4. Approve the proposed rule that changing account, like changing provider, starts a fresh chat.
5. Decide whether disabling an account immediately stops active work or takes effect at the next turn boundary.

## Scope, evidence, and confidence

Primary evidence includes official product/protocol documentation, GitHub repository metadata and release records, licenses, selected implementation files, and the published Claude Agent SDK TypeScript declarations. Repository statistics are a September 23 snapshot, not support guarantees. Release activity, maintainership, public package boundaries, protocol stability, and license terms matter more than stars.

The supplied Conductor screenshots establish the desired interaction: agent/model/effort selection, first-class chat tabs, and a fresh chat after a cross-provider change, with an optional previous-chat transcript. Additional settings screenshots show a native Claude `/login` terminal inside the app and a native Codex login process. These establish the login UX but do not establish Conductor's chat transport or multi-account isolation. Personal identifiers, local account paths and transient login URLs from those screenshots are intentionally not reproduced here.

| Evidence class | Established here | Still requires an experiment |
| --- | --- | --- |
| Official interface documentation | Available authentication, session, streaming, configuration and approval interfaces | Their behavior with the exact pinned binary, macOS Keychain, and Bun combination |
| Source inspection | How selected projects wrap providers and where their public package boundaries end | Whether extracting those components is cheaper than a direct integration |
| Current Glosa source | Existing provider, transcript, dock and contextual-surface boundaries | Migration behavior with saved layouts, live sessions and concurrent document edits |
| Product observation | The supplied Conductor UX and published runtime-distribution model | Unpublished implementation details and account-switching guarantees |

No provider login, credential migration, model inference, live manuscript session, or dependency installation was performed for this research. Compatibility claims below are documentary unless explicitly described as proposals. Broader projects were screened; the direct integrations, ACP adapters, Paseo, Claudexor and TAKT received deeper inspection.

## 1. Subscription access and authentication

### The key distinction

A provider subscription can authenticate its native agent runtime. That does not make the subscription a general API credential for arbitrary applications. Glosa should operate the native agent and consume its structured events; it should not extract a bearer token and implement its own inference client.

| Path | What runs | Billing/authentication consequence | Glosa assessment |
| --- | --- | --- | --- |
| Codex with native ChatGPT login | Official Codex app-server | Subscription/credits associated with that account; API-key mode is separate | Strong initial fit |
| Unmodified Claude Code with native user login | Anthropic-published binary, user completes Anthropic's flow | Hosting is addressed explicitly in current documentation, with conditions | Plausible intended path; resolve SDK/product interpretation before committing |
| Claude Agent SDK / Claude ACP adapter | Official agent runtime underneath a programmable wrapper | Technical ability to use existing credentials is not product authorization | Conditional, not an automatic subscription entitlement |
| Direct model APIs or hosted Managed Agents | An API client or hosted agent service | API/provider billing; a different product from local subscription use | Optional separately configured offering, not the default answer |
| Token extraction or subscription proxy | Glosa would own credential handling and requests | Crosses the native-authentication boundary | Exclude |

Codex documents both ChatGPT sign-in and API-key authentication, with separate billing paths. A local interactive integration must retain that distinction and respect managed account policies. The selected profile should visibly identify its authentication method. [Codex authentication](https://learn.chatgpt.com/docs/auth).

### Claude's current documentation must be read together

Anthropic permits products to run its unmodified published Claude Code binary under stated commercial conditions. End users authenticate with their own credentials; hosts must preserve built-in authentication methods and must not intermediate or resell usage. The same page forbids third-party collection/intermediation of Claude subscription tokens and distinguishes a user's native CLI sign-in from a third-party application's own Claude login. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

The Agent SDK overview separately says third-party subscription login/rate-limit offerings require prior approval and directs developers to API-key authentication. It also describes the SDK as running the Claude Code binary. Therefore **native binary hosting and an SDK-powered product cannot simply be treated as equivalent permission claims**. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

**Design consequence:** document Glosa's exact distribution, local process ownership, native login ceremony and absence of token custody, then establish which permitted category applies. This is the main unresolved product constraint. A working prototype, another app's behavior, an open-source adapter, or switching from SDK calls to `claude -p` does not settle it. The latter is itself documented as a programmatic way to run the agent. [Programmatic Claude Code](https://code.claude.com/docs/en/headless).

Keep provider-supported API/cloud authentication available where required by the distribution terms, while making subscription use the intended setup when permitted. Never silently fall back from a subscription profile to a billable API credential. Provider branding also depends on whether the surface hosts Claude Code or presents an SDK-based agent; settle labels during that same review.

### Multiple accounts are feasible without editing the user's default CLI

| Provider | Isolation mechanism | Credential owner | Important qualification |
| --- | --- | --- | --- |
| Claude | A unique, canonical `CLAUDE_CONFIG_DIR` per profile | Claude Code; macOS Keychain, with documented file fallback | Current docs explicitly namespace the Keychain entry by this directory |
| Codex | A unique `CODEX_HOME` per profile | Codex; configured file/keyring credential store | Verify simultaneous profile isolation for the selected credential-store backend |
| ACP agent | Launch each configured adapter with the appropriate profile environment | Underlying provider, through advertised authentication | ACP authentication is not a universal account database |

Claude explicitly documents separate configuration directories for concurrent identities, including Keychain namespacing. This is stronger evidence than copying credential files between launches. Keychain failures and fallback storage still need a macOS experiment. [Claude authentication](https://code.claude.com/docs/en/authentication), [environment variables](https://code.claude.com/docs/en/env-vars). Codex describes `CODEX_HOME` and its configurable credential-store backends; Glosa must not assume every backend has identical isolation behavior. [Codex authentication](https://learn.chatgpt.com/docs/auth).

Separate configuration is **configuration isolation, not an operating-system security boundary**. Processes running as the same user may still access other user files unless a real sandbox prevents it.

## 2. Integration choices

| Option | Interactive coverage | Work Glosa still owns | Decision |
| --- | --- | --- | --- |
| Native Codex app-server + official Claude interface | Highest access to provider-specific features | Two adapters, lifecycle, account profiles, journal, UI | Recommended baseline for two providers |
| ACP v1 + maintained Claude/Codex adapters | Common messages, tools, permissions and configuration | Capability negotiation, adapter versions, provider exceptions and accounts | Strong alternative; compare before implementation |
| Paseo client/embedded daemon | Existing multi-provider lifecycle and session services | Integration with a second state/lifecycle model; privacy and packaging fit | Evaluate only if willing to adopt a larger subsystem |
| CLI print-mode streaming maintained locally | Structured text/tool events where supplied | Bidirectional approvals, control messages, resume, failures, version drift | Avoid duplicating a supported SDK/app-server unless a concrete gap requires it |
| PTY and terminal emulator | Native terminal behavior, including the provider's own login UI | Accessible structured chat semantics cannot reliably be recovered from ANSI output | Good native login surface; separate from the primary chat protocol |

### Codex app-server

OpenAI identifies app-server as the integration surface for rich custom clients. It provides thread lifecycle, streamed turns, server-initiated approvals/questions, account login, model discovery, MCP status and usage notifications. Prefer an owned subprocess over stdio JSONL; the documented JSON-RPC variant omits the `jsonrpc` field. Generate matching TypeScript types/schema from the pinned binary. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Useful methods include `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `model/list`, `account/login/start`, `account/read`, and `account/rateLimits/read`. Model/effort are turn inputs; account and model metadata should drive the picker. Browser and device-code login remain provider-owned. Experimental features and remote WebSocket deployment are separately caveated in the documentation; do not turn available methods into a blanket stability guarantee. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

The TypeScript Codex SDK is convenient for programmatic jobs, while the richer app-server is the better match for this UI. Do not confuse launching Glosa's own app-server with Glosa's existing attachment to an externally owned Codex socket. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

### Claude's structured interface

The official TypeScript Agent SDK exposes streaming messages, permission callbacks, session resumption, MCP status, model discovery, account information and executable selection. Inspection of published version **0.3.280** found `setModel()` for subsequent responses in streaming-input mode, `supportedModels()`, `accountInfo()`, `mcpServerStatus()`, `canUseTool`, and `pathToClaudeCodeExecutable`. It also includes `SDKRateLimitEvent`. These are concrete surfaces for Glosa's own UI. [Official SDK package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.280), [official SDK repository](https://github.com/anthropics/claude-agent-sdk-typescript).

There was no `setEffort()` method in those declarations. Do not promise that effort changes are a live control identical to model changes: the adapter may need to end an idle query and resume the native session with different options. Prove this without losing history or resending a prompt. Also audit helper methods before calling them: the declarations distinguish local context summaries from detailed token-count requests, which can make external calls.

Prefer the supported SDK control protocol over parsing human terminal output. If distribution or policy constraints require another approach, preserve the same provider boundary and re-evaluate capabilities honestly. The SDK and runtime have commercial terms; a public repository or permissive outer adapter does not relicense them. [SDK license and terms](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms).

### ACP: credible transport, not a complete product

ACP means **Agent Client Protocol**, the interface between a client UI and an agent. MCP means **Model Context Protocol**, the interface through which agents use tools/resources. AG-UI is another frontend event protocol. They address different layers. [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

Stable ACP v1 has configuration selectors for models, modes and effort. Prefer `configOptions` to legacy modes, render supported values dynamically, and consume the complete configuration state returned after a change. A model change can alter the valid effort choices. [ACP session configuration](https://agentclientprotocol.com/protocol/v1/session-config-options).

ACP supports agent-owned authentication, including a terminal-authentication flow. The client launches its configured executable with the specified authentication arguments/environment, waits for completion and reconnects. It must not treat arbitrary text in an agent response as a shell command. [ACP authentication](https://agentclientprotocol.com/protocol/v1/authentication).

Context usage and optional cumulative cost became stable on June 5, 2026. That does not guarantee account-plan quota information from every adapter. ACP v2 was published as a draft on July 20 and remains documented as unsuitable for default production enablement. Native subagent and other adapter extensions must be negotiated independently. [Usage stabilization](https://agentclientprotocol.com/announcements/session-usage-stabilized), [v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft).

| Adapter | Current finding | Practical implication |
| --- | --- | --- |
| [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp/tree/b264b52bee80e49f20caf1941f7d7cb89edb80c4) | Apache-2.0; v0.81.1; uses official SDK 0.3.280; Node engine requirement | Promising maintained wrapper; Bun compatibility and Claude offering permission remain separate questions |
| [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp/tree/7fee150a55098f7140a03907fec5f11edbe45086) | Apache-2.0; v1.13.1; wraps Codex app-server, bundles a compatible Codex dependency | Useful common transport; pin the resolved Codex dependency as well as the adapter |
| [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) | Archived; points to the replacement above | Do not select the obsolete repository from an older comparison |

The current Claude adapter offers a `--hide-claude-auth` integration option. Its existence reinforces that authentication presentation is a client-specific choice; it does not settle which mode Glosa is entitled to offer. Both adapters expose more than the stable protocol through extensions. The client must distinguish standard support, negotiated extensions and unsupported operations.

## 3. What the reference products actually contribute

### Conductor: use the interaction pattern

Conductor bundles Claude Code, Codex and OpenCode and permits using an alternative local executable for the first two. Each chat belongs to a harness; chats in a workspace share its branch and files. Usage is associated with the user's provider account. [Harness overview](https://www.conductor.build/docs/reference/harnesses), [Claude reference](https://www.conductor.build/docs/reference/harnesses/claude-code), [Codex reference](https://www.conductor.build/docs/reference/harnesses/codex).

Its provider setup warns about inherited API-key configuration. This is directly relevant to preventing accidental billing in Glosa. The September changelog also shows that managed runtime versions and model-picker behavior change together. [Provider configuration](https://www.conductor.build/docs/guides/providers), [changelog](https://www.conductor.build/changelog).

Adopt the supplied screenshots' fresh-tab transition across providers and explicit transcript attachment. The additional screenshots show an authentication selector, native-login status, executable override, and an embedded terminal launched by the login button. Claude runs its own `/login` interaction; Codex starts its own browser-callback flow and offers device authentication. This is a useful implementation pattern: the surrounding application controls presentation while the vendor controls sign-in.

The user reports that this Conductor path supports one account per agent. Its settings also display the ordinary user configuration locations. Neither a bundled executable nor an in-app login terminal proves separate credentials/configuration: **binary isolation and account isolation are independent**. The displayed Claude backend label is not evidence of API-key billing when the login method says Claude account. Do not infer three-account support, a particular chat SDK, or reusable UI packages from these screens.

### Paseo: the closest architecture reference

Paseo combines native Claude SDK and Codex app-server integrations with an ACP extension path. Its source separates provider clients/sessions from application lifecycle and transcript state. Inspect its recovery, permission, cancellation and process-ownership handling rather than merely its provider list. [Architecture](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/docs/architecture.md), [provider documentation](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/docs/providers.md).

The public `@getpaseo/client` package drives a **Paseo daemon**. It is not a standalone pair of CLI adapters: that daemon owns the agents and persistent sessions. The server exports daemon construction, but the inspected export surface does not expose the provider implementation as a clean independent library. [Paseo SDK](https://paseo.sh/docs/sdk), [server exports](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/packages/server/src/server/exports.ts).

Useful implementation lessons include identity-sensitive model caches, explicit handling of ambiguous steering failures, and recording owned process identity before cleanup. Its Claude provider contains version-sensitive stream/resume/cancellation handling, demonstrating that a shared interface does not remove vendor compatibility work. Glosa should inspect any code it adopts for configuration inheritance and network behavior. [Claude implementation](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/packages/server/src/server/agent/providers/claude/agent.ts).

**Assessment:** strong reference; possible larger subsystem adoption, but no evidence of a small, public, framework-independent renderer/runtime package satisfying Glosa's constraints. Bringing in the whole daemon adds another authority for lifecycle, storage and authentication. Its remote/mobile transport is outside this proposal.

For authentication specifically, Paseo's public guide says the default uses the existing installed Claude CLI/account. It warns that reauthentication does not update an already-running session; a new session is needed. Its custom-provider configuration supports multiple entries with separate environment settings, but its published examples use API keys. Its separately named “agent profiles” are model/mode/effort presets, not an account-management system. These are three different concepts. [Claude guide](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/public-docs/claude-code.md), [custom providers](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/public-docs/custom-providers.md), [profile schema](https://github.com/getpaseo/paseo/blob/ba4595d4e8352fafc1f59791c648e846027f0b7f/packages/protocol/src/agent-profile.ts).

The inspected Claude implementation accepts launch-environment overlays, but some history-path operations resolve from the daemon's ambient configuration directory. This is a concrete reason to audit *every* login/run/history/status operation before assuming per-provider environment overrides deliver complete account isolation. It is an integration concern to investigate, not a claim that all Paseo multi-profile behavior is broken.

### Claudexor: account profiles and identity-bound sessions

The requested repository is [razzant/claudexor](https://github.com/razzant/claudexor/tree/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a). It is younger and smaller than the strongest dependencies here, but unusually relevant to the account problem. Its design separates credential profiles and configuration locations and pins session lanes to harness/credential identity. It also supports account-pool behavior that Glosa should not inherit by accident. [README](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/README.md).

The Claude profile implementation canonicalizes configuration paths and constructs the native environment for the selected profile. Its authentication probe distinguishes a logged-out result from a failed probe; stale cached identity must not masquerade as a fresh successful check. [Profile implementation](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/harness-claude/src/profile.ts), [authentication probe](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/harness-claude/src/auth-status.ts).

**Assessment:** learn from named profiles, explicit account pinning and status semantics. Do not adopt token custody or automatic account rotation. Multiple owned plans are a user-selection requirement here, not a request to build a quota-bypass scheduler. Use native provider-reported usage rather than private service endpoints.

The closest concrete implementation of the requested login pattern is Claudexor's `nativeLoginSpec` / `nativeLoginEnv`. It launches `claude auth login` or a Codex native login flow with a sanitized environment and an explicit profile configuration directory. Login and post-login verification use the same location. Its setup runner owns cancellation, completion and transient login interaction. These mechanisms are directly relevant even though its default presentation uses a sign-in card rather than Conductor's full terminal. [Native login](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/cli/src/native-login.ts), [login runner](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/cli/src/setup-login-runner.ts), [shared directory resolver](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/cli/src/config-dir-login-harnesses.ts).

Its native Codex path deliberately supports device-code authentication and discusses browser-session interference. Treat that as implementation experience to test, not an official guarantee of server-side session behavior. Its Claude refresh helper wakes a native process and inspects expiry metadata; Glosa should not copy this as an undocumented background refresh requirement. Prefer normal vendor refresh during an authorized action and explicit re-login when it fails. [Refresh helper](https://github.com/razzant/claudexor/blob/cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a/packages/harness-claude/src/auth-refresh.ts).

### TAKT: orchestration above the provider layer

The requested [nrslib/takt](https://github.com/nrslib/takt/tree/12e575b9cd4f11d6ecd6442855378832007f5d5c) is a workflow orchestrator: roles, multi-step execution and review loops are its main abstraction. Its source has distinct Claude SDK and headless CLI paths. The latter launches structured `stream-json` output with session/model/permission parameters. [Headless implementation](https://github.com/nrslib/takt/blob/12e575b9cd4f11d6ecd6442855378832007f5d5c/src/infra/claude-headless/client.ts), [SDK implementation](https://github.com/nrslib/takt/blob/12e575b9cd4f11d6ecd6442855378832007f5d5c/src/infra/claude/client.ts).

**Assessment:** useful evidence for separating workflow orchestration from provider transport. It does not remove the need for Glosa's accounts, rich chat renderer, approval UI or durable conversation model. Its own authentication caveats are another reason not to treat technical CLI access as permission evidence. Do not import an orchestration engine to implement ordinary chat tabs.

TAKT's `ProviderPermissionProfiles` configures permission defaults and per-step overrides. It is not a registry of logged-in subscription identities. The inspected CLI/SDK paths and profile definitions did not establish a built-in isolated multi-account login/re-login manager. [Profile types](https://github.com/nrslib/takt/blob/12e575b9cd4f11d6ecd6442855378832007f5d5c/src/core/models/provider-profiles.ts).

### Established account managers: useful patterns, different defaults

| Project | Verified mechanism | Reuse judgment |
| --- | --- | --- |
| [CCS](https://github.com/kaitranntt/ccs/tree/f45fa923f231ecb95b782d3a9edde3cad3476d48) | Native Claude profiles launch with separate `CLAUDE_CONFIG_DIR`; named/default selection; Codex native profiles launch with `CODEX_HOME` | Good targeted reference. Separate its native-account path from its OAuth-proxy product features |
| [CC Switch](https://github.com/farion1231/cc-switch/tree/da193d4f7a6ce3710623c312245c752376c0d036) | Mature desktop configuration/provider switcher; live-config application and optional proxy routing | Its default configuration-switching model does not establish Glosa's “leave the main CLI untouched” guarantee |

CCS's Claude creation code strips ambient provider credentials and launches the original CLI in an isolated instance. It offers a bare mode without shared resource symlinks. Its execution path carries the same configuration directory forward. That is useful evidence that this is an established native-CLI pattern, not a need to invent a new authentication protocol. [Create account](https://github.com/kaitranntt/ccs/blob/f45fa923f231ecb95b782d3a9edde3cad3476d48/src/auth/commands/create-command.ts), [account execution](https://github.com/kaitranntt/ccs/blob/f45fa923f231ecb95b782d3a9edde3cad3476d48/src/dispatcher/flows/account-flow.ts).

Its Codex path also demonstrates why account isolation is not the same as full configuration isolation: credentials/history are profile-local, while configuration and some resources are shared through symlinks by default. It also has explicit credential-import and proxy paths. Glosa should neither import those defaults nor read tokens to populate identity when native account-status APIs are available. [Codex profile design](https://github.com/kaitranntt/ccs/blob/f45fa923f231ecb95b782d3a9edde3cad3476d48/docs/codex-auth.md), [native login implementation](https://github.com/kaitranntt/ccs/blob/f45fa923f231ecb95b782d3a9edde3cad3476d48/src/codex-auth/commands/login-command.ts).

CC Switch explicitly documents writing the active provider to the live Codex configuration and preserving official authentication alongside third-party routing. That solves a different problem from independent Glosa-owned profiles. Its UI is relevant; its global switching behavior is not the default architecture to adopt. [Official configuration-preservation guide](https://github.com/farion1231/cc-switch/blob/da193d4f7a6ce3710623c312245c752376c0d036/docs/guides/codex-official-auth-preservation-guide-en.md).

### Maintenance and reuse screen

Counts are rounded; dates are observed repository creation/last push or named release dates, not a promise of future support. Licenses below were checked in repository files where GitHub's metadata was ambiguous. A repository license does not cover every bundled vendor runtime.

| Project | Age / adoption snapshot | Activity observed | License / reuse judgment |
| --- | --- | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) | Oct 2025; 18.2k stars | v0.9.1 Sep 22; push Sep 23 | Apache-2.0; strong architecture reference |
| [ACP specification](https://github.com/agentclientprotocol/agent-client-protocol) | Jun 2025; 4.3k | v1.9.1 Sep 18 | Ecosystem standard; distinguish protocol/schema and SDK versions |
| [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) | Aug 2025; 2.6k | v0.81.1; active Sep 23 | Apache-2.0 wrapper; native runtime has separate terms |
| [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) | Dec 2025; 401 | v1.13.1; active Sep 23 | Apache-2.0; supported lineage matters more than raw star count |
| [Claudexor](https://github.com/razzant/claudexor) | Jun 2026; 481 | v3.13.0 Sep 22; push Sep 23 | MIT; targeted reference, not primary dependency recommendation |
| [TAKT](https://github.com/nrslib/takt) | Jan 2026; 1.4k | Push Sep 22; no GitHub Releases returned | MIT; workflow reference; absence of GitHub releases does not establish no package releases |
| [CCS](https://github.com/kaitranntt/ccs) | Nov 2025; 2.9k | v8.10.0 Sep 11; push Sep 22 | MIT; useful native account-profile code, avoid conflating with proxy paths |
| [CC Switch](https://github.com/farion1231/cc-switch) | Aug 2025; 135.5k | v3.20.4 Sep 22; push Sep 23 | MIT; mature config manager, different isolation goals |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | Nov 2023; 12.3k | Active Sep 23 | MIT; strongest general React rendering candidate |
| [AI Elements](https://github.com/vercel/ai-elements) | Aug 2025; 2.5k | Push Sep 1 | Apache-2.0; copy-in React components |
| [Superset](https://github.com/superset-sh/superset) | Oct 2025; 14.5k | Desktop 1.30.2 Sep 22 | Elastic License 2.0; inspect restrictions, not a permissive default |
| [Happy](https://github.com/slopus/happy) | Jul 2025; 23.9k | CLI 1.2.5 Sep 22 | MIT; full local/mobile product, not a small renderer library |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Jun 2025; 28.2k | Push Sep 19 | Apache-2.0; announced sunsetting and community maintenance |
| [Claude Code Viewer](https://github.com/d-kimuson/claude-code-viewer) | Aug 2025; 1.3k | v0.8.2 Aug 18 | MIT; complete application, useful transcript reference |

Vibe Kanban is an important counterexample to star-based selection: the company announced its shutdown on April 10, 2026, while local workspaces and community maintenance continue. Do not describe it as abandoned, but do not assume vendor-backed maintenance either. [Official shutdown announcement](https://www.vibekanban.com/blog/shutdown).

Superset's inspected `chat-runtime` and `chat-ui` manifests are private packages. Their names do not imply an independently supported npm integration. Happy's session takeover/reconnection patterns are useful, but its relay architecture would add a deployment and privacy model Glosa does not currently need. [Superset chat runtime](https://github.com/superset-sh/superset/tree/main/packages/chat-runtime), [Superset chat UI](https://github.com/superset-sh/superset/tree/main/packages/chat-ui), [Happy source](https://github.com/slopus/happy).

Also screened: [OpenCode](https://github.com/anomalyco/opencode), [Goose](https://github.com/aaif-goose/goose), [Vercel AI SDK](https://github.com/vercel/ai), [CopilotKit](https://github.com/CopilotKit/CopilotKit), and [AG-UI](https://github.com/ag-ui-protocol/ag-ui). These are established projects, but solve different layers. An alternative agent harness is not automatically a wrapper retaining Claude Code/Codex behavior; a frontend protocol is not subscription authentication. No deep compatibility endorsement is made for this secondary group.

## 4. Rendering: reusable components exist, complete agent UX does not

**Consume typed events and render them into Glosa-owned components. Do not ask the agent to produce HTML for its own transcript.** Text, tool calls, permissions, files and usage have distinct semantics; arbitrary HTML would discard those semantics and introduce an unsafe rendering surface.

| Candidate | What it supplies | What it does not supply | Fit for Glosa |
| --- | --- | --- | --- |
| Existing vanilla transcript renderer | Current transcript grouping and workspace styling | Rich interactive event model and all managed-chat states | Best fit with today's stack; extend deliberately |
| assistant-ui | Customizable React chat primitives and externally controlled runtime | Native CLI process, credential isolation and provider permission mapping | Strongest option if React is approved |
| Vercel AI Elements | React components for messages, tools, reasoning, terminal-like output and context | Complete session engine or native CLI integration | Useful design/source reference; requires React/shadcn/Tailwind conventions |
| ACP TypeScript SDK | Protocol types, transport and request handling | HTML, CSS, account registry and persistence | Backend/client plumbing, not a renderer |
| CopilotKit / AG-UI | Agent/frontend synchronization and UI integration ecosystem | Automatic wrapping of the user's local Claude/Codex sessions | Additional abstraction; no demonstrated need for initial scope |

assistant-ui's **ExternalStoreRuntime** lets Glosa provide messages, status and callbacks while retaining its own backend. It does not require using a hosted inference service just to render a chat. A provider adapter must map tools, attachments, errors and approval actions into the renderer's model. [External store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store), [runtime selection](https://www.assistant-ui.com/docs/runtimes/pick-a-runtime).

There is an assistant-ui integration for **Claude Managed Agents**, but that is Anthropic's hosted API product, not local Claude Code subscription access. No maintained, ready-made assistant-ui integration covering this proposal's Claude Code + Codex + isolated-account behavior was verified. [Managed Agents runtime](https://www.assistant-ui.com/docs/runtimes/claude-managed-agents).

AI Elements' tool and reasoning components are useful building blocks. Its terminal component is an output display, not proof of an interactive PTY. Its context/cost component must not be mistaken for a subscription quota meter. [Tool](https://elements.ai-sdk.dev/components/tool), [reasoning](https://elements.ai-sdk.dev/components/reasoning), [terminal](https://elements.ai-sdk.dev/components/terminal), [context](https://elements.ai-sdk.dev/components/context).

The existing [July renderer survey](jsonl-ui-components.md) remains historical background. This report supersedes its adoption recommendations where circumstances changed: Vibe Kanban's maintenance posture needs qualification; the old tiny Claude SDK UI candidate was not re-established as a stable dependency; assistant-ui now documents a hosted Claude integration that still does not solve the local-subscription requirement. Do not turn old package discovery into a current recommendation without rechecking ownership and releases.

### Minimum transcript component inventory

| Group | Components and required behavior |
| --- | --- |
| Conversation | User/assistant messages, streaming Markdown, code, selected-file attachments, draft preservation, copy/export, search and accessible keyboard navigation |
| Agent activity | Tool name/status/duration; readable parameters/results; file references/diffs; nested subagent activity; provider-exposed reasoning or summaries only |
| Human decisions | Permission request, structured question, MCP authentication/elicitation; exact request identity; clear pending/answered/expired states |
| Status and recovery | Starting, working, awaiting input, interrupted, failed, disconnected, reconnecting; queued versus sent messages; actionable failures |
| Context and usage | Effective account/model/effort, context occupancy, compaction marker, token usage, provider quota windows, clearly labeled optional cost |

Preserve selection and scroll position while streaming. Follow output only when the reader is already at the bottom; otherwise show a new-content indicator. Load old history incrementally, cap retained DOM, and keep focused approvals mounted. Sanitize Markdown and links; show unknown tool results through a safe generic renderer. Do not manufacture thinking content that the provider does not expose.

## 5. Proposed UX contract

These are design recommendations derived from the requested behavior, not claims about existing Glosa functionality.

### Information architecture

```text
Workspace
├── Files
│   └── Existing document navigation
└── Chats
    ├── New chat
    ├── Draft review       Claude · Personal · Waiting for approval
    └── Outline cleanup    Codex · Work · Idle

Content tabs: document | chat | document diff | another chat
Settings: Agents → Accounts, defaults, runtime versions, configuration
```

Use the existing dock rather than a separate chat tab manager. A **chat** is persisted workspace data; a **tab** is a view of it; a **runtime session** is the provider's execution state. Closing one must not accidentally delete or terminate the others.

Move existing Conversation access into this model before removing its contextual entry. Existing externally bound sessions need an identifiable destination and preserved history. Do not discard the only route to them while the new chat experience is incomplete.

### Creation and switching rules

| Trigger | Proposed visible behavior | Stored/runtime consequence |
| --- | --- | --- |
| New chat | Empty chat tab; choose agent, enabled account, model and effort | Local draft only; no inference until Send |
| Change provider before any message | Reconfigure the empty draft; preserve unsent text and explicit attachments | No old native session to migrate |
| Change model within the same provider/account | Keep chat; show the new selection for the next turn | Validate capability and persist desired/effective settings per turn |
| Change effort | Same chat; supported values only | Apply at the next safe boundary; resume the same native session if the adapter requires it |
| Change provider after chat starts | Open and focus a new empty chat tab; leave old chat intact | New provider session; offer an explicit previous-transcript attachment |
| Change account after chat starts | Recommended: new chat, same as a provider change | Avoid resuming a session under a different credential identity without a proven contract |
| Change a setting while working | State that it applies to the next turn | No silent interruption, prompt replay or mid-turn credential replacement |

Provider and account are separate axes. Model names are not reliable provider identifiers. The effective picker data comes from the chosen runtime/account; never encode screenshot model names as permanent product options. If a runtime changes the effective model, display that change rather than continuing to label output with the requested model.

Cross-provider transcript transfer must be explicit because it sends earlier content to a different provider. Preview the included messages/files and label them as imported context. It is a fresh conversation informed by a transcript, not continuation of the original native session. Avoid automatic summarization calls during this transition; they are separate external actions.

### Chat list and lifecycle actions

| Action/state | Behavior |
| --- | --- |
| Close tab | Close the view; preserve draft/history and show ongoing work or approvals in the sidebar |
| Stop | Interrupt the active turn through the provider; retain partial output and any edits already made |
| Archive | Hide from the ordinary list; retain history and recoverability; settle active work first |
| Delete | Explicitly describe whether Glosa history, native history and attachments are removed; deletion is not merely closing a tab |
| Workspace switch or browser reload | Work remains daemon-owned; reconnect from persisted state; approval badges survive navigation |

No unsolicited model call for chat titles. Use a local title derived from the opening text or an explicit rename. A future generated-title feature would need its own disclosed external action.

### Account settings

Each provider can have multiple rows: user label, verified identity when available, authentication method, enabled state, default-for-new-chats flag, status freshness and available quota information. Never present a guessed identity as verified.

| Operation | Meaning |
| --- | --- |
| Add / sign in | Allocate an isolated root, launch the provider's native flow, confirm status, then enable selection |
| Enable / disable | Control use by Glosa; disabling does not itself revoke the provider's login |
| Set default | Affects new chats only; it must not redirect existing chats |
| Sign out | Invoke provider logout for that exact profile; show which chats become unavailable |
| Remove profile | Remove the Glosa configuration association with an explicit history/credential retention choice |

All accounts disabled is a valid state. Show a useful setup action; never select the machine's default account behind the user's back. A failed status probe is different from signed out. An account with stale quota information remains labeled stale, not zero usage or confirmed capacity.

### Native login inside Glosa, with multiple accounts

**Recommended user experience:** an account row has **Sign in**, **Sign in again**, **Use by default**, and **Enable** controls. Selecting Sign in opens a dedicated login surface for that row. Claude's real terminal login can run there, as in Conductor. For Codex, the native app-server's typed browser/device flow can supply a simpler card; an embedded native terminal remains an alternative. Neither path makes Glosa an OAuth client or token exchange service.

One installed executable may serve many accounts. Every login, status probe, chat, history operation and logout must receive the same canonical profile root. The root belongs outside the workspace/repository and is not shared with the ordinary CLI installation.

```text
Glosa private data
├── runtimes
│   ├── claude / tested-version / original executable
│   └── codex / tested-version / original executable
└── agent-accounts
    ├── claude-personal / native configuration and history
    ├── claude-work / native configuration and history
    ├── claude-secondary / native configuration and history
    └── codex-work / native configuration and history

Choose account → resolve immutable profile ID → set native configuration root
→ native login in Glosa → native status check for same root → verify identity
→ mark ready → launch/resume chat with same profile
```

The directory labels above are illustrative; use opaque IDs internally so renaming an account does not move its directory or change Keychain identity. Glosa's root resolver must be shared by login, run, probe, history and logout code. Do not maintain five subtly different environment-building paths.

| Mechanism | Proposed implementation boundary |
| --- | --- |
| Terminal | Daemon-owned PTY with a maintained terminal renderer such as xterm.js; Bun's terminal support avoids requiring node-pty solely for this surface |
| Process launch | Absolute pinned executable plus an argument array and explicit environment; neutral login working directory; no general interactive shell that reloads user startup configuration |
| Login scope | One active login operation per account profile; operations on other profiles remain independent; serialize flows if a provider requires the same callback port |
| Completion | Native process/control-protocol completion, then native status and identity verification; not merely seeing a success-colored terminal line |
| Input/output | Transient terminal/device-code data; no auth-terminal recording in the chat journal, analytics, crash reports or ordinary logs |

The building blocks are mature terminal rendering and native process control; the account/login coordinator is Glosa-specific work. Bun exposes PTY support, and xterm.js is a standalone terminal component, not a replacement frontend framework. Validate the exact pinned Bun behavior and vendoring requirements before selecting it. [Bun child processes](https://bun.com/docs/runtime/child-process), [xterm.js](https://github.com/xtermjs/xterm.js).

Restrict terminal escape-sequence capabilities such as automatic clipboard writes, and keep authentication links and pasted codes transient. Cancellation terminates only the owned login process. Disallow starting a second login that can replace credentials while the same profile is actively running a turn; offer to stop or wait first. These controls belong to Glosa's process/UI layer and do not alter the vendor binary.

The default is **one optional default account per provider**, selected from enabled accounts. With several enabled accounts, every new chat can override it in the composer. Disabling the default asks for another choice or leaves no default; it never silently picks another account. A running chat displays its pinned account even when the global default changes. Enabling an account does not automatically start work.

### Expiry and re-login are part of the initial scope

```text
Ready → native refresh during authorized action → Ready
Ready → authentication rejected → Sign-in required → Signing in → Verifying → Ready
Verifying → different principal → Identity changed; existing chats remain blocked
Any status probe → network/tool failure → Status unavailable (not automatically signed out)
```

| Situation | Required behavior |
| --- | --- |
| Access token can refresh normally | Let the native runtime refresh it; Glosa does not implement refresh-token handling |
| Refresh fails / session revoked | Preserve draft, transcript and uncertain-send state; show Sign in again on the affected account and chats |
| Re-login succeeds as the same principal | Keep the Glosa chat; recreate/resume its native runtime only when required and supported; do not replay a submitted prompt automatically |
| Re-login chooses a different account or organization | Do not silently change what the profile means to existing chats; offer a separate account profile/new chat or explicit repair path |
| Provider cannot resume after re-login | Keep the old chat readable and offer a fresh chat with explicit context transfer; state the limitation |

Bind account identity to provider-reported stable principal/organization identifiers where available, not merely the editable display label or email. If a provider exposes insufficient identity information, record that limitation and require explicit confirmation before reusing a binding. Store only the nonsecret metadata needed for this check.

Paseo's documented need to start a new native session after reauthentication means **updating credentials on disk is not evidence that a live process adopted them**. Test whether Glosa can preserve the visible chat while resuming a replacement native process for each pinned provider version. Re-login and “switch to another account” are distinct actions.

Local directory isolation prevents Glosa from intentionally overwriting the terminal CLI's configuration or credential entry. It cannot guarantee that a provider will never invalidate another login server-side. Browser SSO can also preselect the wrong identity. Verify the resulting account, provide the native device flow where supported, and test simultaneous/default CLI sessions. Do not promise that private browsing alone prevents provider-wide session revocation.

## 6. Proposed architecture within Glosa

### Current implementation and seams

The inspected base is `a97157a` on `origin/main`. These source paths were read, rather than inferred from old issue descriptions:

| Existing component | Current responsibility | Required extension |
| --- | --- | --- |
| [AgentProvider](../../packages/daemon/src/agent-provider/interface.ts) | Detect, connect, deliver, liveness and transcript paths for bound sessions | Add a separate managed-runtime interface/capability; do not force external sessions to implement launch/login |
| [Codex provider](../../packages/providers/codex/src/provider.ts) | Attach to an existing provider session/socket | A distinct owned-process path for chats started by Glosa |
| [Conversation view](../../packages/spa/src/conversation.js) | Normalized transcript display, grouping and delivery composer | Interactive managed events, approvals, rich content, recovery and explicit chat identity |
| [Contextual surfaces](../../packages/spa/src/viewer-context-surfaces.js) | Mount the current Conversation context | Migration/deep-link handoff to ordinary chat tabs |
| [Dock](../../packages/spa/src/dock.js) | Existing dockview-core tab/split furniture | A discriminated chat panel kind and saved-layout migration |

The current requirements describe a companion to externally started agents, not an agent host. The existing delivery distinction between transport acceptance and presentation must survive the new design. See [requirements](../requirements.md), [decisions](../decisions.md), and [roadmap](../../ROADMAP.md).

### Component ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Workspace/chat service | Chat identity, settings snapshots, journal-derived state, visibility and user intents | Vendor credential contents |
| Profile registry | Nonsecret profile metadata and isolated-root references | A copied OAuth-token pool |
| Runtime manager | Version selection, child launch, ownership, reconnect and shutdown | Arbitrary process discovery/termination or the user's external CLI lifecycle |
| Provider implementation | Native session IDs, event/control conversion, capabilities and authentication invocation | Generic UI state or domain-specific document logic |
| SPA data-access module and renderers | Typed daemon API, projections, accessible presentation and user choices | Direct provider network calls, secrets or raw process handles |

```text
User action → SPA data-access module → daemon intent/journal → provider adapter
Provider event → normalized event/journal → projection → SPA chat and document views
```

Keep one daemon and one SPA data-access module. Avoid importing provider-specific SDK types into generic chat components. A future ACP provider belongs behind the same boundary as native integrations.

### Data and persistence

| Record | Suggested fields / invariant |
| --- | --- |
| AccountProfile | Stable ID, provider, user label, canonical config-root reference, enabled/default state, verified principal/organization when exposed, auth state/freshness; no token fields |
| Chat | Stable ID, workspace ID, provider/profile binding, native session reference, origin (`managed` or `attached`), created/archived metadata |
| RuntimeSession | Ownership kind, process-generation identity, pinned executable/adapter versions, negotiated capabilities, connection state |
| Turn | User intent ID, requested/effective model and effort, permission policy snapshot, dispatch/acknowledgment/outcome, usage provenance |
| Event | Chat/turn ID, provider event identity when available, generation, monotonic local sequence, typed content, timestamps and redaction policy |

Keep the journal authoritative for Glosa-owned state; do not create independently mutable chat status files that can disagree with it. Native history remains the provider's resume material, not a second source of truth for Glosa's user-action status. Specify how imported transcript history and live managed events meet without duplication.

Use provider IDs plus local sequence/generation boundaries, not message text, to reconcile events. Identical text can be two legitimate messages. Persist pending user intents before dispatch. A broken connection after dispatch can leave acceptance unknown: mark it uncertain and reconcile; never automatically resend a potentially accepted instruction.

The system can make its own journal append idempotent. It cannot promise exactly-once external inference across all crashes unless the provider protocol offers the necessary acknowledgment/idempotency contract. Keep that limit visible in the design.

### Owned and attached sessions

```text
Managed: draft → starting → idle → running → awaiting input → running → idle
Failures: starting/running → failed or reconnecting → reconciled state
Stopping: running → interrupt requested → confirmed stopped/idle or outcome unknown
Attached: externally owned session → observe/deliver only as its capabilities allow
```

Closing the browser does not imply an agent should die. Daemon shutdown, idle eviction and upgrades need explicit policies for draining or interrupting owned processes. Record PID plus start identity/ownership evidence; never kill by process name. On restart, determine whether the provider supports reattachment or only session resumption before replacing anything.

Do not open a second controller against the same native session merely because its transcript is readable. An external terminal session is not automatically safe to take over. Provider capability and ownership, not tab appearance, determine available actions.

## 7. MCP, permissions, usage and provenance

### Tools and human decisions

| Concern | Required behavior |
| --- | --- |
| Permission request | Render the provider's actual operation and scope; reply to its exact request; no invented blanket approval |
| Browser reconnect | Restore unresolved decisions or mark them expired; never apply an old click to a new request |
| Structured questions | Preserve option IDs, free-text constraints and cancellation semantics; distinguish from ordinary chat |
| MCP status/authentication | Show connected, failed, pending and needs-auth states where available; use provider-owned auth flows |
| Unknown tool/event | Safe generic content fallback; fail closed for an unrecognized decision that could grant access |

Permission mode, OS sandbox policy and model effort are different controls. A UI label such as “Plan” must reflect the provider's actual enforcement; it must not imply a stronger filesystem/network sandbox than exists.

MCP configuration needs explicit scope: Glosa application, account profile, workspace and session. Avoid name collisions and unintended inheritance. A tool card can present a resource link or structured output without granting that content execution privileges. **MCP Apps or arbitrary tool-supplied HTML are a separate security surface** and are not included automatically by adding chat rendering. They would require an explicit isolation/CSP design compatible with Glosa's blocked class-F egress.

Agent capabilities such as commands, skills, plugins and subagents should be discovered where possible and rendered as optional features. Do not promise identical capabilities across providers or treat an experimental plugin-management interface as a release-ready dependency.

### Usage is several different measurements

| Measurement | Meaning | UI rule |
| --- | --- | --- |
| Context occupancy | Tokens currently occupying the model's context versus its window | Display as context, with compaction/reset behavior |
| Turn/session tokens | Input/output and optional cache/reasoning counters | State scope and whether counters are cumulative or deltas |
| Account quota | Provider plan windows, remaining/used capacity and reset time | Include account, observation time and unknown/stale states |
| Cost estimate | Provider-reported or calculated monetary estimate | Never label it as the user's actual subscription charge |
| Billing route | Subscription, credits, API key or cloud provider | Visible before first send and whenever effective authentication changes |

Codex exposes account rate-limit information; Claude's inspected SDK exposes rate-limit events. Neither establishes one uniform cross-provider quota contract. ACP's stable usage notification covers session context and optional cost, not a universal account balance. Build nullable typed fields with provenance, not a single percentage pretending to cover every provider.

Do not poll private usage endpoints or scrape tokens to complete an attractive meter. Prefer observed runtime events, explicit refresh where supported, and “unavailable” when information is absent. Do not trigger hidden token-count requests while someone is merely reading history.

### Document provenance remains independent

An agent announcing “I edited the file” or emitting an edit-tool card does not prove which bytes it authored. Managed chats must still participate in Glosa's existing witnessed claim intervals, conflict rules and human-save precedence. Bind the managed runtime's identity to the established claim/resolve mechanism; where proof is absent, attribution remains `unknown`.

Two chats in one workspace can affect the same documents. Preserve the existing concurrency behavior rather than treating tabs as isolation. A document save by a person must not be relabeled as agent work just because a managed turn is active. This is a central acceptance requirement, not a later UI enhancement.

## 8. Configuration, runtime packaging and privacy

### Configuration precedence must be deliberate

Scrubbing `ANTHROPIC_API_KEY` remains mandatory, but is not sufficient to guarantee subscription billing. Claude supports additional authentication routes and settings layers; project configuration or helpers can reintroduce another route. SDK `settingSources` must be chosen deliberately rather than copied from a sample. Managed policies must continue to apply. [Claude authentication](https://code.claude.com/docs/en/authentication), [settings](https://code.claude.com/docs/en/settings).

Construct a documented child environment and configuration policy. Identify which values are required for platform operation, native login, workspace tools and explicit user configuration. Scrub unintended provider credentials and gateway overrides; when a user deliberately configures API/cloud access, keep that profile visibly distinct. Do not claim environment filtering prevents workspace commands from reading every credential available to the OS user.

Never overwrite the user's default CLI config, rotate shared auth files, or symlink a single mutable credential file among profiles. Create private directories with restrictive permissions. Redact secrets from child stderr, diagnostic exports and journal payloads, including login URLs when they contain secret material.

### Pin a compatible set, not just an npm package

| Layer | Version/ownership rule |
| --- | --- |
| Native executable | Official distribution, exact version, integrity verification and macOS architecture support; preserve an unmodified vendor binary |
| SDK or ACP adapter | Exact compatible version; resolved transitive dependencies locked; preserve licenses/notices |
| Protocol/schema | Generate or vendor the schema/types matching the chosen runtime; label experimental capabilities |
| Glosa event normalizer | Versioned fixtures from supported runtimes; tolerant of harmless additions, strict about decisions and identity |
| Upgrade | Explicit user action; compatibility check; rollback strategy and resume-format assessment; no background update checks |

Claude documents versioned installation and update-disabling controls. Use those controls when appropriate to the selected distribution model rather than modifying its executable. Some broad nonessential-traffic controls also disable capabilities; test the exact supported environment. [CLI reference](https://code.claude.com/docs/en/cli-reference), [environment variables](https://code.claude.com/docs/en/env-vars).

Offer a managed tested runtime as the ordinary path, with a clearly marked custom executable override if desired. The latter must show its detected version and supported capability result. Do not execute a runtime downloaded from an arbitrary agent-provided URL, or run `npx ...@latest` on chat creation. An explicit first-use install is a foreground network action with a clear destination and purpose.

The fixed Bun/no-native-addon stack applies to Glosa, but externally launched vendor binaries are a new packaging decision that must be recorded. ACP adapters declaring Node requirements are not proven compatible merely because their code is TypeScript. A separate Node runtime, if necessary, is a real dependency decision.

### Consent and network behavior

Keep the browser's provider calls behind the daemon. Consent must describe the selected provider, authentication/billing route, workspace access and data categories the native agent may transmit. Attaching one file does not prove the agent cannot inspect other workspace files through its tools.

No provider warm-up, metadata generation, model request, telemetry, automatic update, or hidden quota/context lookup should happen merely because Glosa starts or a historical chat opens. Configuration/account/model discovery can itself involve external calls; perform it through explicit setup/refresh or an authorized foreground action and cache results with freshness labels. Establish which native-runtime traffic can be disabled and which is operationally required before claiming compliance with Glosa's consent contract.

## 9. Relation to issue #157 and existing contracts

**This feature would supersede the narrow scope of #157, but this research does not close it.** The issue currently asks for a “Launching sessions” decision record in `docs/decisions.md`, with the existing invariant, prerequisites, security consequences and Later placement. It explicitly says it is not an implementation. [Issue #157](https://github.com/davebream/glosa/issues/157).

An accepted decision record can satisfy that original documentation task without shipping chats. Alternatively, a promoted implementation can close it once its recorded obligations are covered: corresponding A2/A3/R4 changes, updates to the assumptions in #151 and #160, and lifecycle evidence for scrubbed child environments and registration without a plugin. First-class chat tabs alone are insufficient. Broader UI/account/runtime delivery needs explicit implementation scope rather than hiding everything inside an old decision-record issue.

| Contract/area | Delta to design and approve |
| --- | --- |
| A2 §F08 and decision log | Separate external companion sessions from explicitly Glosa-managed sessions; replace the blanket no-launch rule only for the latter |
| R4 and provider integration | Owned launch/login/control path; direct session registration; preserve external attach and MCP delivery paths |
| A3 security and consent | Child environment/config precedence, native credential ownership, process permissions, runtime downloads and provider egress |
| R6 and workspace UI | Chats as first-class panels, contextual Conversation migration, workspace list, interactive decisions, history/draft semantics |
| A4/A5 persistence and lifecycle | Journal events/projections, process ownership, recovery, claim attribution and concurrent editor behavior |

The UI request is broader than the original #157 idea. It changes product topology from exclusively companion use to **companion plus opt-in managed agents**. It does not require Electron, cmux coupling, terminal keystroke injection, or silently taking over existing sessions. The desktop-shell question in [#160](https://github.com/davebream/glosa/issues/160) remains separate.

The issue's historical suggestion that nothing durable is written does not describe this proposal's persistent account profiles and chats. The new decision must explicitly define retained configuration/history and removal behavior. Likewise, “no plugin required” must mean Glosa can register and control its owned session directly, not that transcript messages can replace provenance evidence.

Other backlog context inspected: [#30](https://github.com/davebream/glosa/issues/30) conversation composer, [#151](https://github.com/davebream/glosa/issues/151) Claude integration, [#161](https://github.com/davebream/glosa/issues/161) Codex attachment, [#162](https://github.com/davebream/glosa/issues/162) workbench, and [#168](https://github.com/davebream/glosa/issues/168) Later decisions. Their current code/status should remain the baseline; historical issue wording is not a fresh implementation specification. No roadmap commitments or issue states are changed by this report.

## 10. Experiments required before the final design

Run these as explicit, attended integration experiments with synthetic workspaces and isolated homes. Record exact binary/SDK/adapter versions, observed authentication route and limitations. Do not use live manuscripts or copy existing secrets for convenience.

| Experiment | Pass evidence | Decision it resolves |
| --- | --- | --- |
| Three-account isolation and re-login | A/B/C sign-in, explicit default/switching, expiry/refresh/re-login, different-principal rejection, concurrent refresh/login conflicts, locked-Keychain failure, default CLI and unrelated sessions checked before/after | Whether the account UX is actually supportable on macOS |
| Native versus ACP parity | Same prompt/tool/approval/question/MCP/interrupt/resume/model/effort scenarios through both paths; explicit unsupported-feature list; Bun process/transport proof | Whether common transport saves work without losing required UX |
| Crash and reconnect | Browser reload, daemon exit, child exit, lost acknowledgment, repeated event, stream gap and pending approval; no silent duplicate dispatch | Durable chat and process-ownership contract |
| Provenance and shared files | Two managed chats plus a human save, real claim intervals, conflict/unfinished edit outcomes | Whether managed sessions preserve Glosa's defining attribution guarantees |
| Distribution and egress | Exact billing-route verification, config precedence, explicit install/update/rollback, measured network behavior, representative runtime upgrade | Whether the chosen package/environment satisfies consent and version promises |

Treat acceptance observations according to [Glosa's testing convention](../testing.md): mock-provider fixtures prove local state transitions, not live-provider compatibility; browser tests prove interaction, not billing; declared flags prove configuration, not observed network behavior. Critical recovery/security guards need named negative controls. Required live support and T8 maintainer acceptance remain separate gates.

### Suggested delivery slices, subject to prioritization

| Slice | Reviewable outcome | Exit condition |
| --- | --- | --- |
| Decision and compatibility evidence | Accepted topology/account rules; Claude authentication determination; native/ACP comparison | No unresolved assumption hidden inside an implementation ticket |
| Chat domain and navigation | Persistent workspace chats, ordinary tabs, drafts, existing-session migration | Old Conversation access migrates without losing session visibility/history |
| First managed provider | Codex owned process, isolated account, streaming, decisions, stop/resume | Real end-to-end scenarios plus deterministic lifecycle/recovery guards |
| Claude and multiple accounts | Approved integration, native login, profile isolation, model/effort controls | Account/billing and provider-parity evidence with exact supported versions |
| Rich tools and release hardening | MCP, usage, subagents, provenance, upgrade/rollback, accessibility | No false capability/usage/provenance claims; required acceptance and attended rehearsal |

These slices are a proposed dependency order, not changes to ROADMAP priority. Agent execution can be proven with a minimal internal view before polishing the full chat interface; account identity and recovery must not be postponed until after a visually complete demo.

## 11. Source and freshness notes

The durable source references above include inspected commit IDs for the most consequential third-party implementation findings. Product documentation and `main` links are mutable; recheck authentication terms, experimental flags, licenses and maintained repository locations before adoption.

| Evidence | Snapshot detail |
| --- | --- |
| Glosa baseline | `a97157a`; actual provider/UI files and live #157 body inspected |
| Claude package | `@anthropic-ai/claude-agent-sdk@0.3.280`; published declarations read without installation; SDK reference web page exceeded fetch limits |
| Paseo source | `ba4595d4e8352fafc1f59791c648e846027f0b7f` |
| Claudexor source | `cc34a19ee1b0b41bc4fb3627a73ca40e1bf72e7a` |
| TAKT source | `12e575b9cd4f11d6ecd6442855378832007f5d5c` |
| Claude ACP source | `b264b52bee80e49f20caf1941f7d7cb89edb80c4` |
| Codex ACP source | `7fee150a55098f7140a03907fec5f11edbe45086` |
| assistant-ui source | `cbd2c283720cf962b0bebc711d731f79c16dbbde`; public runtime documentation also inspected |
| CCS source | `f45fa923f231ecb95b782d3a9edde3cad3476d48`; native account creation/execution and Codex login/config-sharing paths |
| CC Switch source | `da193d4f7a6ce3710623c312245c752376c0d036`; live-configuration behavior and official-auth preservation guide |

The report supports selecting a design and defining its validation work. It does not establish that an SDK integration is permitted for every distribution model, that every provider exposes the same features, or that an untested adapter/runtime combination is production-stable.
