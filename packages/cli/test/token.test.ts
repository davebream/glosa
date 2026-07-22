// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { renameSync, unlinkSync } from "node:fs";
import { loadToken } from "@glosa/daemon";
import { printTokenResult, runToken } from "../src/token.ts";
import { captureStdout } from "./test-utils.ts";
import { cleanupHome, freshHome } from "../../daemon/test/helpers.ts";

describe("glosa token", () => {
  test("rotate has stable human/JSON output and never emits token material", () => {
    const home = freshHome();
    try {
      const result = runToken("rotate", home);
      const token = loadToken(home)!;
      expect(result).toMatchObject({
        ok: true,
        command: "token",
        exitCode: 0,
        data: { state: "active", invalidated: "all", re_pair_command: "glosa open" },
      });

      const human = captureStdout(() => printTokenResult(result, false));
      expect(human).toBe("glosa token: rotated; all existing credentials are invalid\nRun `glosa open` to re-pair.\n");
      expect(human).not.toContain(token);

      const json = captureStdout(() => printTokenResult(result, true));
      expect(JSON.parse(json)).toEqual({
        glosa_json: 1,
        ok: true,
        command: "token",
        exit_code: 0,
        data: { state: "active", invalidated: "all", re_pair_command: "glosa open" },
        warnings: [],
        error: null,
      });
      expect(json).not.toContain(token);
    } finally {
      cleanupHome(home);
    }
  });

  test("revoke is idempotent and documents the re-pairing path", () => {
    const home = freshHome();
    try {
      runToken("rotate", home);
      const first = runToken("revoke", home);
      const second = runToken("revoke", home);
      expect(first.data).toEqual({
        state: "revoked",
        invalidated: "all",
        already_revoked: false,
        re_pair_command: "glosa open",
      });
      expect(second.data.already_revoked).toBe(true);
      expect(loadToken(home)).toBeNull();
    } finally {
      cleanupHome(home);
    }
  });

  test("mutation failure returns stable exit 70 and leaves prior state intact", () => {
    const home = freshHome();
    try {
      runToken("rotate", home);
      const before = loadToken(home);
      const result = runToken("rotate", home, {
        rename: () => {
          throw new Error("injected");
        },
        unlink: unlinkSync,
      });
      expect(result).toMatchObject({
        ok: false,
        command: "token",
        exitCode: 70,
        error: { code: "token-rotate-failed", kind: "internal" },
      });
      expect(loadToken(home)).toBe(before);

      const revokeFailure = runToken("revoke", home, {
        rename: renameSync,
        unlink: () => {
          throw new Error("injected");
        },
      });
      expect(revokeFailure.exitCode).toBe(70);
      expect(loadToken(home)).toBe(before);
    } finally {
      cleanupHome(home);
    }
  });
});
