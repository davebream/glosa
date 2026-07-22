// SPDX-License-Identifier: Apache-2.0
import {
  glosaHome,
  revokeToken,
  rotateToken,
  type TokenMutationDeps,
} from "../../daemon/src/index.ts";
import { EXIT_CODES, printJsonEnvelope, type CommandEnvelope } from "./envelope.ts";

export type TokenAction = "rotate" | "revoke";

export interface TokenCommandData {
  state?: "active" | "revoked";
  invalidated?: "all";
  already_revoked?: boolean;
  re_pair_command?: "glosa open";
}

export function runToken(
  action: TokenAction,
  home: string = glosaHome(),
  deps?: TokenMutationDeps,
): CommandEnvelope<TokenCommandData> {
  try {
    if (action === "rotate") {
      // Deliberately discard the returned credential. Token material only travels in `glosa
      // open`'s fragment bootstrap and is never part of this command's human/JSON envelope.
      rotateToken(home, deps);
      return {
        ok: true,
        command: "token",
        exitCode: EXIT_CODES.OK,
        data: { state: "active", invalidated: "all", re_pair_command: "glosa open" },
        warnings: [],
      };
    }

    const removed = revokeToken(home, deps);
    return {
      ok: true,
      command: "token",
      exitCode: EXIT_CODES.OK,
      data: {
        state: "revoked",
        invalidated: "all",
        already_revoked: !removed,
        re_pair_command: "glosa open",
      },
      warnings: [],
    };
  } catch {
    return {
      ok: false,
      command: "token",
      exitCode: EXIT_CODES.INTERNAL,
      data: {},
      warnings: [],
      error: {
        code: action === "rotate" ? "token-rotate-failed" : "token-revoke-failed",
        kind: "internal",
        message: `could not ${action} the local pairing credential; the previous token state was preserved`,
        hint: "Check ~/.glosa ownership and permissions, then retry.",
      },
    };
  }
}

export function printTokenResult(result: CommandEnvelope<TokenCommandData>, json: boolean): void {
  if (json) return printJsonEnvelope(result);
  if (!result.ok) {
    process.stderr.write(`glosa token: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  if (result.data.state === "active") {
    process.stdout.write("glosa token: rotated; all existing credentials are invalid\nRun `glosa open` to re-pair.\n");
    return;
  }
  const suffix = result.data.already_revoked ? " (already revoked)" : "";
  process.stdout.write(`glosa token: revoked${suffix}; all existing credentials are invalid\nRun \`glosa open\` to re-pair.\n`);
}
