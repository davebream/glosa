// SPDX-License-Identifier: Apache-2.0
import { ManagedAgentError } from "../../../daemon/src/agents/interface.ts";

/** Every gate names a separate observable guarantee. A package version is never proof. */
export const ACP_GATES = [
  "effective-configuration",
  "exact-tool-inventory",
  "per-attempt-authority",
  "native-generation",
  "descendant-cleanup",
  "helper-inference-suppressed",
  "native-compatibility",
  "failure-semantics",
] as const;
export type AcpGate = (typeof ACP_GATES)[number];
export interface AcpQualification {
  provider: "claude-code" | "codex";
  sdk: string;
  adapter: string;
  native: string;
  nativeSdk?: string;
  evidence: Readonly<Partial<Record<AcpGate, { passed: boolean; reference: string }>>>;
  blockers: readonly string[];
}
/** Released-source/spike evidence. This record deliberately enables neither provider. */
export const ACP_QUALIFICATIONS: Readonly<Record<"claude-code" | "codex", AcpQualification>> = {
  "claude-code": {
    provider: "claude-code",
    sdk: "2.2.0",
    adapter: "0.99.1",
    native: "2.1.312",
    nativeSdk: "0.3.312",
    evidence: {},
    blockers: [
      "The ACP wire does not acknowledge effective per-attempt MCP authority and exact tool inventory.",
      "Internal native replacement has no generation fence visible to the client.",
      "Helper inference and final native credential inheritance remain unqualified.",
    ],
  },
  codex: {
    provider: "codex",
    sdk: "2.2.0",
    adapter: "2.5.0",
    native: "0.165.0",
    evidence: {},
    blockers: [
      "MCP startup waiting does not acknowledge effective per-attempt authority and exact tool inventory.",
      "Internal app-server replacement has no generation fence visible to the client.",
      "AIR failure negotiation, helper suppression and descendant cleanup need integrated qualification.",
    ],
  },
};
export function acpQualificationStatus(qualification: AcpQualification) {
  const missing = ACP_GATES.filter(
    (gate) => !qualification.evidence[gate]?.passed || !qualification.evidence[gate]?.reference.trim(),
  );
  return {
    qualified: missing.length === 0 && qualification.blockers.length === 0,
    warmReuse: false as const,
    missing,
    blockers: qualification.blockers,
  };
}
export function requireAcpQualification(qualification: AcpQualification): void {
  if (!acpQualificationStatus(qualification).qualified)
    throw new ManagedAgentError(
      "runtime-unqualified",
      "ACP is awaiting provider qualification. The existing native executor remains selected.",
      503,
    );
}
