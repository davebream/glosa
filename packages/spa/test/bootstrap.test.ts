// SPDX-License-Identifier: Apache-2.0
// P1.4 — scrubSecrets/selectScreen are the security-load-bearing pure functions in bootstrap.js
// (A3 §3/F24, A1 §5.1). Fakes over location/sessionStorage/history stand in for the
// real browser objects — bootstrap.js takes them as parameters for exactly this reason.
import { describe, expect, test } from "bun:test";
import {
  CONTRACT_VERSION,
  focusHash,
  readRoute,
  rememberDaemonIdentity,
  scrubSecrets,
  selectScreen,
  waitForOwnDaemon,
  writeFocus,
} from "../src/bootstrap.js";

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

describe("readRoute — the CLI deep-link half of the fragment", () => {
  test("#t=…&w=<slug>&a=<artifact> yields slug/artifact; URL-encoding is undone", () => {
    const loc = { hash: "#t=SECRET&w=essays-abc&a=07%2Fmanuscript.md" };
    const route = readRoute(loc);
    expect(route.slug).toBe("essays-abc");
    expect(route.artifact).toBe("07/manuscript.md");
  });

  test("a plain #t=<token> fragment yields null slug/artifact (directory open)", () => {
    const route = readRoute({ hash: "#t=SECRET" });
    expect(route.slug).toBeNull();
    expect(route.artifact).toBeNull();
  });

  test("no fragment at all yields null slug/artifact", () => {
    const route = readRoute({ hash: "" });
    expect(route.slug).toBeNull();
    expect(route.artifact).toBeNull();
  });
});

describe("focusHash — the inverse of readRoute slug/artifact", () => {
  test("slug + artifact → #w=&a= with artifact path URL-encoded, w before a", () => {
    expect(focusHash({ slug: "essays-abc", artifact: "07/manuscript.md" })).toBe("#w=essays-abc&a=07%2Fmanuscript.md");
  });

  test("round-trips through readRoute slug/artifact projection", () => {
    const focus = { slug: "essays-abc", artifact: "07/manuscript.md" };
    const route = readRoute({ hash: focusHash(focus) });
    expect({ slug: route.slug, artifact: route.artifact }).toEqual(focus);
  });

  test("slug only (no artifact) → #w= alone", () => {
    expect(focusHash({ slug: "essays-abc", artifact: null })).toBe("#w=essays-abc");
  });

  test("neither present → empty string, so replaceState leaves a clean URL with no stray #", () => {
    expect(focusHash({ slug: null, artifact: null })).toBe("");
    expect(focusHash()).toBe("");
  });

  test("never emits t= even if a stray token-shaped value is passed as slug/artifact", () => {
    // The guard is structural: focusHash only ever reads slug/artifact, so `t=` cannot appear.
    expect(focusHash({ slug: "t=SECRET", artifact: "t=SECRET" })).not.toContain("t=SECRET&");
    expect(focusHash({ slug: "essays-abc", artifact: "07/manuscript.md" })).not.toContain("&t=");
  });
});

describe("writeFocus — reflects on-screen focus into the address bar", () => {
  test("rebuilds pathname+search+fragment; the pairing token can never reappear", () => {
    const loc = { pathname: "/", search: "", hash: "" };
    const history = fakeHistory();

    writeFocus(loc, history as unknown as History, { slug: "essays-abc", artifact: "07/manuscript.md" });

    expect(history.calls.length).toBe(1);
    const [, , url] = history.calls[0]!;
    expect(url).toBe("/#w=essays-abc&a=07%2Fmanuscript.md");
    expect(url).not.toContain("t=");
  });

  test("preserves existing pathname + search; no artifact → workspace-only fragment", () => {
    const loc = { pathname: "/w/foo", search: "?x=1", hash: "" };
    const history = fakeHistory();

    writeFocus(loc, history as unknown as History, { slug: "essays-abc", artifact: null });

    const [, , url] = history.calls[0]!;
    expect(url).toBe("/w/foo?x=1#w=essays-abc");
  });

  test("empty focus → clean URL with no stray fragment", () => {
    const loc = { pathname: "/", search: "", hash: "" };
    const history = fakeHistory();

    writeFocus(loc, history as unknown as History, { slug: null, artifact: null });

    expect(history.calls[0]![2]).toBe("/");
  });
});

describe("readRoute — surface/mode/lock + secrets", () => {
  test("parses surface, mode, lock, and both pairing secret forms", () => {
    expect(
      readRoute({
        hash: "#t=SECRET&w=essays-abc&a=note.md&surface=document&mode=review&lock=read",
      }),
    ).toEqual({
      slug: "essays-abc",
      artifact: "note.md",
      surface: "document",
      mode: "review",
      readLock: true,
      durableToken: "SECRET",
      presentationToken: null,
    });
    expect(readRoute({ hash: "#p=PRESENT&w=x&a=y&surface=workspace&mode=read" }).presentationToken).toBe("PRESENT");
  });
});

describe("scrubSecrets — preserves non-secret route state", () => {
  test("scrubs t= while keeping w/a/surface/mode/lock", () => {
    const loc = {
      hash: "#t=SECRET&w=essays-abc&a=note.md&surface=document&mode=read&lock=read",
      pathname: "/",
      search: "",
    };
    const session = fakeStorage();
    const history = fakeHistory();
    const route = readRoute(loc);

    const result = scrubSecrets(loc, session, history as unknown as History, route);

    expect(result).toBe("SECRET");
    expect(session.getItem("glosa_token")).toBe("SECRET");
    const [, , url] = history.calls[0]!;
    expect(url).toBe("/#w=essays-abc&a=note.md&surface=document&mode=read&lock=read");
    expect(url).not.toContain("t=");
    expect(url).not.toContain("SECRET");
  });

  test("redeems p= via caller-supplied durable token and scrubs p=", () => {
    const loc = { hash: "#p=PRESENT&w=essays-abc&a=note.md&surface=document&mode=edit", pathname: "/", search: "" };
    const session = fakeStorage();
    const history = fakeHistory();
    const route = readRoute(loc);

    const result = scrubSecrets(loc, session, history as unknown as History, route, "DURABLE");

    expect(result).toBe("DURABLE");
    expect(session.getItem("glosa_token")).toBe("DURABLE");
    const [, , url] = history.calls[0]!;
    expect(url).not.toContain("p=");
    expect(url).not.toContain("PRESENT");
    expect(url).toContain("surface=document");
    expect(url).toContain("mode=edit");
  });

  test("#t=<token> present: stashed in sessionStorage under glosa_token", () => {
    const loc = { hash: "#t=SECRET", pathname: "/", search: "" };
    const session = fakeStorage();
    const history = fakeHistory();

    const result = scrubSecrets(loc, session, history as unknown as History);

    expect(result).toBe("SECRET");
    expect(session.getItem("glosa_token")).toBe("SECRET");
  });

  test("#t=<token> present: history.replaceState strips t= from the URL", () => {
    const loc = { hash: "#t=SECRET", pathname: "/w/foo", search: "?x=1" };
    const session = fakeStorage();
    const history = fakeHistory();

    scrubSecrets(loc, session, history as unknown as History);

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

    const result = scrubSecrets(loc, session, history as unknown as History);

    expect(result).toBe("already-stored");
    expect(history.calls.length).toBe(0);
  });

  test("no #t= and nothing stored: returns null, no throw", () => {
    const loc = { hash: "", pathname: "/", search: "" };
    const session = fakeStorage();
    const history = fakeHistory();

    expect(() => scrubSecrets(loc, session, history as unknown as History)).not.toThrow();
    expect(scrubSecrets(loc, session, history as unknown as History)).toBeNull();
  });
});

describe("selectScreen", () => {
  test("the bundled SPA advertises contract 1.6", () => {
    expect(CONTRACT_VERSION).toBe("1.6");
  });

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

  // A daemon can be up, paired and contract-compatible and still not be the one that issued this
  // tab's credential — a second glosa install taking the port is exactly that. Rendering `ready`
  // there produced a 401 on the first call, which used to be read as "revoked" and threw the
  // credential away for good.
  test("a paired daemon from another install → foreign-daemon, not ready", () => {
    const handshake = { contract_version: "1.6", paired: true, install_id: "ffffffffffffffff" };
    expect(selectScreen(handshake, "some-token", "aaaaaaaaaaaaaaaa")).toBe("foreign-daemon");
  });

  test("the same install → ready", () => {
    const handshake = { contract_version: "1.6", paired: true, install_id: "aaaaaaaaaaaaaaaa" };
    expect(selectScreen(handshake, "some-token", "aaaaaaaaaaaaaaaa")).toBe("ready");
  });

  test("unknown identity on either side is never 'foreign' — old tabs behave exactly as before", () => {
    const known = { contract_version: "1.6", paired: true, install_id: "ffffffffffffffff" };
    expect(selectScreen(known, "some-token", null)).toBe("ready");
    const legacyDaemon = { contract_version: "1.6", paired: true };
    expect(selectScreen(legacyDaemon, "some-token", "aaaaaaaaaaaaaaaa")).toBe("ready");
  });

  test("an unpaired or down daemon still wins over the identity check", () => {
    const unpaired = { contract_version: "1.6", paired: false, install_id: "ffffffffffffffff" };
    expect(selectScreen(unpaired, "some-token", "aaaaaaaaaaaaaaaa")).toBe("unpaired");
    expect(selectScreen(null, "some-token", "aaaaaaaaaaaaaaaa")).toBe("down");
  });
});

describe("rememberDaemonIdentity", () => {
  test("records the issuing daemon alongside the credential", () => {
    const storage = fakeStorage();
    const handshake = { contract_version: "1.6", paired: true, install_id: "aaaaaaaaaaaaaaaa" };
    expect(rememberDaemonIdentity(storage, handshake, "tok")).toBe("aaaaaaaaaaaaaaaa");
    expect(storage.getItem("glosa_install")).toBe("aaaaaaaaaaaaaaaa");
  });

  test("records nothing without a credential or without an identity to record", () => {
    const noToken = fakeStorage();
    rememberDaemonIdentity(noToken, { contract_version: "1.6", paired: true, install_id: "a" }, null);
    expect(noToken.getItem("glosa_install")).toBeNull();

    const legacyDaemon = fakeStorage();
    rememberDaemonIdentity(legacyDaemon, { contract_version: "1.6", paired: true }, "tok");
    expect(legacyDaemon.getItem("glosa_install")).toBeNull();
  });
});

describe("waitForOwnDaemon", () => {
  const paired = "aaaaaaaaaaaaaaaa";

  test("resumes as soon as this tab's own daemon answers again", async () => {
    let calls = 0;
    const outcome = await waitForOwnDaemon(
      {
        daemonIdentity: async () => {
          calls += 1;
          if (calls < 3) return { contract_version: "1.6", paired: true, install_id: "ffffffffffffffff" };
          return { contract_version: "1.6", paired: true, install_id: paired };
        },
      },
      paired,
      { sleep: async () => {}, pollMs: 0 },
    );
    expect(outcome).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("an unreachable daemon is waited through, not given up on", async () => {
    let calls = 0;
    const outcome = await waitForOwnDaemon(
      {
        daemonIdentity: async () => {
          calls += 1;
          return calls < 3 ? null : { contract_version: "1.6", paired: true, install_id: paired };
        },
      },
      paired,
      { sleep: async () => {}, pollMs: 0 },
    );
    expect(outcome).toBe("recovered");
  });

  test("gives up after its window so a tab cannot hold a credential it can no longer place", async () => {
    let clock = 0;
    const outcome = await waitForOwnDaemon(
      { daemonIdentity: async () => ({ contract_version: "1.6", paired: true, install_id: "ffffffffffffffff" }) },
      paired,
      {
        now: () => clock,
        sleep: async () => {
          clock += 60_000;
        },
        timeoutMs: 600_000,
        pollMs: 0,
      },
    );
    expect(outcome).toBe("timeout");
  });

  test("checks once before consulting the clock, so a daemon already back never waits", async () => {
    let slept = 0;
    const outcome = await waitForOwnDaemon(
      { daemonIdentity: async () => ({ contract_version: "1.6", paired: true, install_id: paired }) },
      paired,
      {
        now: () => 0,
        sleep: async () => {
          slept += 1;
        },
        timeoutMs: 0,
        pollMs: 0,
      },
    );
    expect(outcome).toBe("recovered");
    expect(slept).toBe(0);
  });
});
