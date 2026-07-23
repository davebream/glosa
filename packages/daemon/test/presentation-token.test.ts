// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  PRESENTATION_TOKEN_TTL_MS,
  PresentationTokenStore,
} from "../src/presentation-token.ts";

describe("PresentationTokenStore", () => {
  test("mints a 256-bit hex token with a 60s TTL", () => {
    const store = new PresentationTokenStore();
    const now = 1_000_000;
    const minted = store.mint(now);
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.expiresAt).toBe(now + PRESENTATION_TOKEN_TTL_MS);
    expect(store.size()).toBe(1);
  });

  test("redeems atomically once", () => {
    const store = new PresentationTokenStore();
    const { token } = store.mint(1_000);
    expect(store.redeem(token, 1_001)).toBe(true);
    expect(store.redeem(token, 1_002)).toBe(false);
    expect(store.size()).toBe(0);
  });

  test("expired and unknown tokens fail indistinguishably", () => {
    const store = new PresentationTokenStore();
    const { token } = store.mint(1_000);
    expect(store.redeem(token, 1_000 + PRESENTATION_TOKEN_TTL_MS)).toBe(false);
    expect(store.redeem("deadbeef".repeat(8), 1_000)).toBe(false);
  });

  test("clear drops outstanding tokens", () => {
    const store = new PresentationTokenStore();
    const { token } = store.mint();
    store.clear();
    expect(store.redeem(token)).toBe(false);
  });
});
