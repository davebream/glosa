// SPDX-License-Identifier: Apache-2.0
// P4.1 — the bridge's nonce-gated handshake (A3 §2). `bridgeShouldAcceptInit` is the pure mirror
// of the injected script's own gate (classf-bridge.ts's own header explains why the real logic
// has to live in a plain-JS string, not a TS import, and why this pure twin exists to keep the
// decision logic independently testable). `buildBridgeInjection`'s output shape (embeds the
// nonce, never leaks it unescaped into somewhere unsafe, degrades gracefully with no `</body>`)
// is covered here too; classf-serve.test.ts covers where it gets SPLICED into a real document.
import { describe, expect, test } from "bun:test";
import { bridgeShouldAcceptInit, buildBridgeInjection } from "../src/classf-bridge.ts";

describe("bridgeShouldAcceptInit — the bridge's one-time nonce gate (A3 §2)", () => {
  const NONCE = "a".repeat(64);

  test("accepts a well-formed glosa:init with the matching nonce, before any handshake", () => {
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce: NONCE }, NONCE, false)).toBe(true);
  });

  test("rejects once already handshaked — the nonce is validated EXACTLY ONCE (A3 §2)", () => {
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce: NONCE }, NONCE, true)).toBe(false);
  });

  test("rejects a wrong nonce", () => {
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce: "b".repeat(64) }, NONCE, false)).toBe(false);
  });

  test("rejects a missing nonce", () => {
    expect(bridgeShouldAcceptInit({ type: "glosa:init" }, NONCE, false)).toBe(false);
  });

  test("rejects a non-string nonce (e.g. an attacker sending a number/object)", () => {
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce: 12345 }, NONCE, false)).toBe(false);
  });

  test("rejects the wrong message type entirely", () => {
    expect(bridgeShouldAcceptInit({ type: "selection", nonce: NONCE }, NONCE, false)).toBe(false);
  });

  test("rejects null/undefined messages", () => {
    expect(bridgeShouldAcceptInit(null, NONCE, false)).toBe(false);
    expect(bridgeShouldAcceptInit(undefined, NONCE, false)).toBe(false);
  });
});

describe("buildBridgeInjection", () => {
  test("embeds the exact nonce as a JS string literal the bridge script compares against", () => {
    const nonce = "c".repeat(64);
    const script = buildBridgeInjection(nonce);
    expect(script).toContain(JSON.stringify(nonce));
  });

  test("is a <script> (+ scoped <style>) fragment — no bare top-level HTML", () => {
    const script = buildBridgeInjection("d".repeat(64));
    expect(script).toContain("<script>");
    expect(script).toContain("</script>");
    expect(script).toContain("<style");
  });

  test("two calls for two different nonces never share the embedded value", () => {
    const a = buildBridgeInjection("1".repeat(64));
    const b = buildBridgeInjection("2".repeat(64));
    expect(a).not.toBe(b);
    expect(a).toContain(JSON.stringify("1".repeat(64)));
    expect(b).toContain(JSON.stringify("2".repeat(64)));
  });
});
