// SPDX-License-Identifier: Apache-2.0
// The throttled 401 recorder (A3 §4). Its whole purpose is to make a de-pair report settleable
// after the fact — "was the tab holding a stale credential, or had this daemon no credential at
// all?" — without becoming a way to fill a disk or smuggle text into a line-oriented log.
import { describe, expect, test } from "bun:test";
import { createRejectionRecorder } from "../src/transport/http.ts";

function recorder() {
  const lines: string[] = [];
  let now = 1_000_000;
  const record = createRejectionRecorder(
    (line) => lines.push(line),
    () => now,
  );
  return { lines, record, advance: (ms: number) => (now += ms) };
}

describe("401 rejection recorder", () => {
  test("logs the first occurrence of each reason immediately", () => {
    const { lines, record } = recorder();
    record("bearer-mismatch");
    record("no-token-on-daemon");
    expect(lines).toEqual(["401 bearer-mismatch", "401 no-token-on-daemon"]);
  });

  test("suppresses repeats inside the window and reports the count on the next line", () => {
    const { lines, record, advance } = recorder();
    record("bearer-mismatch");
    for (let index = 0; index < 25; index += 1) record("bearer-mismatch");
    expect(lines).toEqual(["401 bearer-mismatch"]);

    advance(60_000);
    record("bearer-mismatch");
    expect(lines).toEqual(["401 bearer-mismatch", "401 bearer-mismatch (25 more suppressed in the last 60s)"]);

    // The count resets once reported rather than accumulating forever.
    advance(60_000);
    record("bearer-mismatch");
    expect(lines[2]).toBe("401 bearer-mismatch");
  });

  test("throttling is per reason, so one noisy reason cannot mask another", () => {
    const { lines, record } = recorder();
    record("bearer-mismatch");
    record("bearer-mismatch");
    record("credential-rotated");
    expect(lines).toEqual(["401 bearer-mismatch", "401 credential-rotated"]);
  });

  test("a caller that varies its request path cannot defeat the throttle", () => {
    // The load-bearing property. A throttle keyed on (path, reason) would emit one fresh "first
    // occurrence" per request, turning a diagnostic into a disk-filling primitive for any local
    // page — the auth gate runs BEFORE the Origin check, so a cross-site fetch reaches it.
    const { lines, record } = recorder();
    for (let index = 0; index < 10_000; index += 1) record("bearer-mismatch");
    expect(lines).toHaveLength(1);
  });

  test("records no request content and no credential", () => {
    const { lines, record } = recorder();
    record("bearer-mismatch");
    record("no-token-on-daemon");
    record("credential-rotated");
    for (const line of lines) {
      // Only the fixed prefix and a reason slug. Nothing here can carry a path, a header, or a
      // token — so nothing can inject a second line into the log or leak a secret into it.
      expect(line).toMatch(/^401 (bearer-mismatch|no-token-on-daemon|credential-rotated)$/);
      expect(line).not.toContain("\n");
    }
  });
});
