// SPDX-License-Identifier: Apache-2.0
// Managed execution is optional and separate from the external-session provider contract.

export type AuthState = "unknown" | "authenticated" | "needs_login" | "expired" | "probe_failed" | "identity_mismatch";
export interface AccountObservation {
  state: AuthState;
  identity?: string;
  label?: string;
  plan?: string;
  method?: string;
  observedAt: string;
}
export interface AgentProfile {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  revision: number;
  epoch: number;
  identityRevision: number;
  auth: AccountObservation;
  removed: boolean;
  cleanup?: "signout" | "remove";
  mcpServers?: AgentMcpServer[];
}
export type AgentMcpServer = { id: string; label: string; enabled: boolean } & (
  | { transport: "stdio"; command: string; args: string[] }
  | { transport: "http"; url: string }
);
export interface AgentModel {
  id: string;
  name: string;
  /** Provider-reported concrete model behind a selectable alias; never inferred from a family name. */
  resolvedModel?: string;
  efforts: string[];
}
export interface AgentCapabilities {
  models: AgentModel[];
  resume: boolean;
  images: boolean;
  questions: boolean;
  permissions: boolean;
  mcp: boolean;
}
export interface RuntimeManifest {
  id: string;
  provider: string;
  version: string;
  executable: string;
  executableSha256: string;
  sdkModule?: string;
  sdkSha256?: string;
  qualified: boolean;
  reason?: string;
}
export interface ProfileLaunchSpec {
  profile: AgentProfile;
  configRoot: string;
  cwd: string;
  probeCwd?: string;
  env: Record<string, string>;
  manifest: RuntimeManifest;
}
export interface TurnSettings {
  model: string;
  effort: string;
  permissionMode: "default" | "plan";
}
export interface NativeQuestion {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
}
export interface NativeDecision {
  id: string;
  kind: "permission" | "question";
  title: string;
  detail: string;
  choices: { id: string; label: string }[];
  allowText?: boolean;
  questions?: NativeQuestion[];
}
export type AgentEvent =
  | { type: "effective_settings"; model?: string; effort?: string }
  | { type: "session"; nativeId: string }
  | { type: "text"; id: string; text: string; reasoning?: boolean }
  | { type: "tool"; id: string; name: string; detail: string; status: "running" | "completed" | "failed" }
  | { type: "decision"; decision: NativeDecision }
  | { type: "decision_closed"; id: string }
  | { type: "usage"; value: Record<string, number | string | null> }
  | { type: "completed" }
  | { type: "failed"; code: string; message: string; outcomeUnknown?: boolean };

export interface AgentInput {
  turnId: string;
  text: string;
  settings: TurnSettings;
  attachments: { name: string; mime: string; bytes: Uint8Array }[];
}
export interface ManagedConnection {
  capabilities: AgentCapabilities;
  /** Configure the native thread and verify built-in tools before any user input is dispatched. */
  prepareTurn?(settings: TurnSettings): Promise<void>;
  startTurn(input: AgentInput): Promise<void>;
  answer(id: string, choice: string, text?: string): Promise<void>;
  interrupt(): Promise<void>;
  mcpStatus?(): Promise<{ name: string; status: string; auth: string; login: boolean }[]>;
  close(): Promise<void>;
}
export interface SessionLaunchSpec extends ProfileLaunchSpec {
  sessionId: string;
  runId: string;
  generation: number;
  nativeId?: string;
  settings: TurnSettings;
  mcp?: { url: string; grant: string; instructions: string; requiredTools: string[] };
  servers?: AgentMcpServer[];
}
export interface OwnedProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<{ code: number | null; signal: string | null; groupEmpty: boolean }>;
  write(data: string, admit?: () => void): Promise<void>;
  fence(): Promise<void>;
  stop(): Promise<void>;
  resize(cols: number, rows: number): void;
}
export interface ProcessLauncher {
  spawn(options: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    terminal?: boolean;
    onData: (channel: "stdout" | "stderr" | "terminal", bytes: Uint8Array) => void;
  }): Promise<OwnedProcess>;
}
export interface ManagedAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly authHosts: readonly string[];
  loginArgs(): string[];
  mcpLoginArgs?(servers: AgentMcpServer[], serverId?: string): string[];
  logoutArgs(): string[];
  profileEnvironment(configRoot: string): Record<string, string>;
  preflight?(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<void>;
  probe(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<AccountObservation>;
  connect(
    spec: SessionLaunchSpec,
    launcher: ProcessLauncher,
    onEvent: (event: AgentEvent) => void,
  ): Promise<ManagedConnection>;
}

export type ManagedAgentCode =
  | "auth-required"
  | "account-busy"
  | "account-changed"
  | "account-disabled"
  | "account-mismatch"
  | "account-unavailable"
  | "answer-required"
  | "answer-unknown"
  | "attachment-too-large"
  | "attachments-too-large"
  | "chat-exists"
  | "chat-not-found"
  | "chat-read-only"
  | "consent-required"
  | "decision-expired"
  | "event-too-large"
  | "idempotency-conflict"
  | "input-too-large"
  | "invalid-answer"
  | "invalid-attachment"
  | "invalid-blob"
  | "invalid-default"
  | "journal-corrupt"
  | "journal-unavailable"
  | "login-cancelled"
  | "login-expired"
  | "login-not-found"
  | "managed-stopping"
  | "managed-unavailable"
  | "management-busy"
  | "ownership-unknown"
  | "probe-failed"
  | "probe-timeout"
  | "profile-capacity"
  | "profile-not-found"
  | "provider-unavailable"
  | "queue-full"
  | "run-fenced"
  | "runtime-capacity"
  | "runtime-closed"
  | "runtime-fenced"
  | "runtime-install-timeout"
  | "runtime-unqualified"
  | "sdk-unavailable"
  | "glosa-tools-unavailable"
  | "stale-chat"
  | "stale-decision"
  | "stale-draft"
  | "stale-profile"
  | "storage-unavailable"
  | "turn-active"
  | "turn-not-held"
  | "unexpected-executable"
  | "unsafe-state-path"
  | "unsupported-attachment"
  | "unsupported-images"
  | "unsupported-model"
  | "workspace-changed"
  | "workspace-stopping"
  | "wrong-provider";

export class ManagedAgentError extends Error {
  constructor(
    readonly code: ManagedAgentCode,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export class ManagedAgentRegistry {
  private readonly adapters = new Map<string, ManagedAgentAdapter>();
  register(adapter: ManagedAgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`duplicate managed provider: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): ManagedAgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new ManagedAgentError("provider-unavailable", "This agent is not installed.", 422);
    return adapter;
  }
  list(): ManagedAgentAdapter[] {
    return [...this.adapters.values()];
  }
}
