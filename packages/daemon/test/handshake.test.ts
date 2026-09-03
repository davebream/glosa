// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { parseHandshakeResponse, pollHandshake } from "../src/lifecycle/handshake.ts";

const base = {
  protocol_version: "1.0",
  build_id: "0.1.0-alpha.0-0123456789abcdef",
  instance_id: "gl-test",
  pid: 42,
  started_at: "2026-07-21T00:00:00.000Z",
};

describe("handshake migration parsing", () => {
  test("accepts current and legacy responses", () => {
    expect(parseHandshakeResponse(base)).toEqual(base);
    const { build_id: _buildId, ...legacy } = base;
    expect(parseHandshakeResponse(legacy)).toEqual(legacy);
  });

  test("rejects a non-string build identity and malformed required fields", () => {
    expect(parseHandshakeResponse({ ...base, build_id: 42 })).toBeNull();
    expect(parseHandshakeResponse({ ...base, pid: "42" })).toBeNull();
  });
});

describe("pollHandshake", () => {
  test("returns immediately when shouldStop is already true", async () => {
    const started = Date.now();
    const hs = await pollHandshake(1, 5000, 100, () => true);
    expect(hs).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});
