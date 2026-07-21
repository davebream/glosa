// P1.4 — scrubToken/selectScreen are the security-load-bearing pure functions in bootstrap.js
// (A3 §3/F24, A1 §5.1). Fakes over location/sessionStorage/localStorage/history stand in for the
// real browser objects — bootstrap.js takes them as parameters for exactly this reason.
import { describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, scrubToken, selectScreen } from "../src/bootstrap.js";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function fakeHistory(): { calls: Array<[unknown, string, string]>; replaceState: History["replaceState"] } {
  const calls: Array<[unknown, string, string]> = [];
  return {
    calls,
    replaceState: (state: unknown, title: string, url?: string | URL | null) => {
      calls.push([state, title, String(url)]);
    },
  };
}

describe("scrubToken", () => {
  test("#t=<token> present: stashed in sessionStorage under glosa_token", () => {
    const loc = { hash: "#t=SECRET", pathname: "/", search: "" };
    const session = fakeStorage();
    const history = fakeHistory();

    const result = scrubToken(loc, session, history as unknown as History);

    expect(result).toBe("SECRET");
    expect(session.getItem("glosa_token")).toBe("SECRET");
  });

  test("#t=<token> present: localStorage is never touched", () => {
    const loc = { hash: "#t=SECRET", pathname: "/", search: "" };
    const session = fakeStorage();
    const local = fakeStorage();
    const history = fakeHistory();

    scrubToken(loc, session, history as unknown as History);

    expect(local.getItem("glosa_token")).toBeNull();
  });

  test("#t=<token> present: history.replaceState strips t= from the URL", () => {
    const loc = { hash: "#t=SECRET", pathname: "/w/foo", search: "?x=1" };
    const session = fakeStorage();
    const history = fakeHistory();

    scrubToken(loc, session, history as unknown as History);

    expect(history.calls.length).toBe(1);
    const [, , url] = history.calls[0]!;
    expect(url).not.toContain("t=");
    expect(url).not.toContain("SECRET");
    expect(url).toBe("/w/foo?x=1");
  });

  test("no #t= present: returns the already-stored token, no throw, history untouched", () => {
    const loc = { hash: "", pathname: "/", search: "" };
    const session = fakeStorage();
    session.setItem("glosa_token", "already-stored");
    const history = fakeHistory();

    const result = scrubToken(loc, session, history as unknown as History);

    expect(result).toBe("already-stored");
    expect(history.calls.length).toBe(0);
  });

  test("no #t= and nothing stored: returns null, no throw", () => {
    const loc = { hash: "", pathname: "/", search: "" };
    const session = fakeStorage();
    const history = fakeHistory();

    expect(() => scrubToken(loc, session, history as unknown as History)).not.toThrow();
    expect(scrubToken(loc, session, history as unknown as History)).toBeNull();
  });
});

describe("selectScreen", () => {
  test("handshake null (fetch failed/threw) → down", () => {
    expect(selectScreen(null, "some-token")).toBe("down");
  });

  test("contract major mismatch (daemon 2.0 vs SPA CONTRACT_VERSION 1.0) → mismatch", () => {
    expect(CONTRACT_VERSION.split(".")[0]).toBe("1");
    const handshake = { contract_version: "2.0", daemon_version: "0.1.0", paired: true };
    expect(selectScreen(handshake, "some-token")).toBe("mismatch");
  });

  test("no token → unpaired, even if daemon reports paired:true", () => {
    const handshake = { contract_version: "1.0", daemon_version: "0.1.0", paired: true };
    expect(selectScreen(handshake, null)).toBe("unpaired");
  });

  test("paired:false → unpaired, even with a stored token", () => {
    const handshake = { contract_version: "1.0", daemon_version: "0.1.0", paired: false };
    expect(selectScreen(handshake, "some-token")).toBe("unpaired");
  });

  test("token present + paired:true + matching major → ready", () => {
    const handshake = { contract_version: "1.9", daemon_version: "0.1.0", paired: true };
    expect(selectScreen(handshake, "some-token")).toBe("ready");
  });
});
