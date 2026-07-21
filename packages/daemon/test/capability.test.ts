// P4.1 — CapabilityStore unit coverage (A1 §7): mint shape, TTL expiry, and the "unknown vs.
// expired collapse to the same lookup result" invariant the class-F serve route depends on to
// never leak which failure occurred (A1 §7: "no daemon-origin details").
import { describe, expect, test } from "bun:test";
import { CAPABILITY_TTL_MS, CapabilityStore } from "../src/capability.ts";

function input(overrides: Partial<{ slug: string; artifactDirRealPath: string; artifactBasename: string }> = {}) {
  return {
    slug: "ws-1",
    artifactDirRealPath: "/tmp/glosa-ws/output/sermon",
    artifactBasename: "speech-notes.html",
    ...overrides,
  };
}

describe("CapabilityStore.mint", () => {
  test("token and nonce are each 256-bit (32 bytes, 64 hex chars)", () => {
    const store = new CapabilityStore();
    const { token, nonce } = store.mint(input());
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  test("expiresAt is exactly now + 600s (A1 §7 TTL)", () => {
    const store = new CapabilityStore();
    const now = 1_000_000;
    const { expiresAt } = store.mint(input(), now);
    expect(expiresAt).toBe(now + CAPABILITY_TTL_MS);
    expect(CAPABILITY_TTL_MS).toBe(600_000);
  });

  test("two mints for the SAME artifact never produce the same token or nonce", () => {
    const store = new CapabilityStore();
    const a = store.mint(input());
    const b = store.mint(input());
    expect(a.token).not.toBe(b.token);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("CapabilityStore.lookup", () => {
  test("a freshly minted token resolves to the record it was minted with", () => {
    const store = new CapabilityStore();
    const { token } = store.mint(input({ slug: "sermon-ws" }));
    const record = store.lookup(token);
    expect(record?.slug).toBe("sermon-ws");
    expect(record?.artifactBasename).toBe("speech-notes.html");
  });

  test("an unknown token → null", () => {
    const store = new CapabilityStore();
    expect(store.lookup("0".repeat(64))).toBeNull();
  });

  test("a token past its expiresAt → null, same as unknown (A1 §7: no distinguishing signal)", () => {
    const store = new CapabilityStore();
    const now = 1_000_000;
    const { token } = store.mint(input(), now);
    expect(store.lookup(token, now + CAPABILITY_TTL_MS)).toBeNull(); // now === expiresAt, `<` not `<=`
    expect(store.lookup(token, now + CAPABILITY_TTL_MS + 1)).toBeNull();
  });

  test("a token still within its TTL resolves right up to the boundary", () => {
    const store = new CapabilityStore();
    const now = 1_000_000;
    const { token } = store.mint(input(), now);
    expect(store.lookup(token, now + CAPABILITY_TTL_MS - 1)).not.toBeNull();
  });

  test("a token minted for artifact A's directory carries ONLY A's directory — never resolves as B's", () => {
    const store = new CapabilityStore();
    const a = store.mint(input({ artifactDirRealPath: "/tmp/ws/output/a", artifactBasename: "a.html" }));
    const b = store.mint(input({ artifactDirRealPath: "/tmp/ws/output/b", artifactBasename: "b.html" }));
    expect(store.lookup(a.token)?.artifactDirRealPath).toBe("/tmp/ws/output/a");
    expect(store.lookup(b.token)?.artifactDirRealPath).toBe("/tmp/ws/output/b");
    // there is no cross-token confusion possible — each token is its own map key — but this pins
    // the shape the class-F serve route's per-request confinement (classf-serve.test.ts) relies on.
    expect(store.lookup(a.token)?.artifactDirRealPath).not.toBe(store.lookup(b.token)?.artifactDirRealPath);
  });
});
