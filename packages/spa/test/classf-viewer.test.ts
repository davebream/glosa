// P4.1 — classf-viewer.js: the parent-side trust boundary for the class-F iframe (A3 §1/§2). Pure
// functions (checkEventSource/checkNonce/isTrustedInitEvent/validateBridgeMessage/
// createTokenBucket/createMessageRouter) are unit-tested directly, no DOM needed — this is the
// bulk of the security-critical logic per the task brief ("unit-test the parent-side validator...
// as pure functions"). `mountClassFViewer` itself gets a lighter happy-dom smoke test for the
// iframe attributes/mint call; the full live handshake needs a real browser (P5.4 rehearsal).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkEventSource,
  checkNonce,
  classifyIframeLoad,
  createMessageRouter,
  createTokenBucket,
  isTrustedInitEvent,
  mountClassFViewer,
  validateBridgeMessage,
} from "../src/classf-viewer.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("checkEventSource — A3 §2 orthogonal check 1", () => {
  test("accepts when event.source is exactly the captured window", () => {
    const win = {};
    expect(checkEventSource({ source: win }, win)).toBe(true);
  });

  test("rejects a different window object (a forged/third-party source)", () => {
    const win = {};
    const other = {};
    expect(checkEventSource({ source: other }, win)).toBe(false);
  });

  test("rejects a null/undefined event", () => {
    expect(checkEventSource(null, {})).toBe(false);
    expect(checkEventSource(undefined, {})).toBe(false);
  });
});

describe("checkNonce — A3 §2 orthogonal check 2", () => {
  const NONCE = "e".repeat(64);

  test("accepts the matching nonce", () => {
    expect(checkNonce({ nonce: NONCE }, NONCE)).toBe(true);
  });

  test("rejects a wrong nonce", () => {
    expect(checkNonce({ nonce: "f".repeat(64) }, NONCE)).toBe(false);
  });

  test("rejects a missing/non-string nonce", () => {
    expect(checkNonce({}, NONCE)).toBe(false);
    expect(checkNonce({ nonce: 12345 }, NONCE)).toBe(false);
  });
});

describe("isTrustedInitEvent — [A3 §5 #3] forged postMessage rejection", () => {
  const win = {};
  const NONCE = "a".repeat(64);

  test("accepts source+nonce both matching", () => {
    expect(isTrustedInitEvent({ source: win, data: { nonce: NONCE } }, win, NONCE)).toBe(true);
  });

  test("a 3rd window (wrong source) with an otherwise well-formed nonce → rejected", () => {
    const thirdWindow = {};
    expect(isTrustedInitEvent({ source: thirdWindow, data: { nonce: NONCE } }, win, NONCE)).toBe(false);
  });

  test("the right source but a wrong nonce → rejected", () => {
    expect(isTrustedInitEvent({ source: win, data: { nonce: "wrong" } }, win, NONCE)).toBe(false);
  });

  test("the right source but NO nonce at all → rejected", () => {
    expect(isTrustedInitEvent({ source: win, data: {} }, win, NONCE)).toBe(false);
  });
});

describe("validateBridgeMessage — the hand-rolled schema/size validator", () => {
  test("accepts a well-formed selection message", () => {
    const msg = { type: "selection", seq: 0, quote: { exact: "a", prefix: "b", suffix: "c" }, range: { start: 0, end: 1 } };
    expect(validateBridgeMessage(msg)).toEqual({ ok: true, value: msg });
  });

  test("accepts selection with an optional chunk_id", () => {
    const msg = {
      type: "selection",
      seq: 1,
      quote: { exact: "a", prefix: "", suffix: "" },
      range: { start: 0, end: 1 },
      chunk_id: "chunk-001",
    };
    expect(validateBridgeMessage(msg).ok).toBe(true);
  });

  test("accepts ready/mark/error with just type+seq", () => {
    expect(validateBridgeMessage({ type: "ready", seq: 0 }).ok).toBe(true);
    expect(validateBridgeMessage({ type: "mark", seq: 1 }).ok).toBe(true);
    expect(validateBridgeMessage({ type: "error", seq: 2, message: "oops" }).ok).toBe(true);
  });

  test("rejects an unknown message type", () => {
    expect(validateBridgeMessage({ type: "not-a-real-type", seq: 0 }).ok).toBe(false);
  });

  test("rejects a non-object / null / array payload", () => {
    expect(validateBridgeMessage(null).ok).toBe(false);
    expect(validateBridgeMessage("selection").ok).toBe(false);
    expect(validateBridgeMessage([1, 2, 3]).ok).toBe(false);
  });

  test("rejects a missing/non-integer/negative seq", () => {
    expect(validateBridgeMessage({ type: "ready" }).ok).toBe(false);
    expect(validateBridgeMessage({ type: "ready", seq: 1.5 }).ok).toBe(false);
    expect(validateBridgeMessage({ type: "ready", seq: -1 }).ok).toBe(false);
  });

  test("rejects a selection with a malformed quote or range", () => {
    expect(validateBridgeMessage({ type: "selection", seq: 0, quote: "not an object", range: { start: 0, end: 1 } }).ok).toBe(false);
    expect(
      validateBridgeMessage({ type: "selection", seq: 0, quote: { exact: "a", prefix: "b", suffix: "c" }, range: { start: 5, end: 5 } }).ok,
    ).toBe(false); // start === end, not start < end
    expect(
      validateBridgeMessage({ type: "selection", seq: 0, quote: { exact: 1, prefix: "b", suffix: "c" }, range: { start: 0, end: 1 } }).ok,
    ).toBe(false); // exact isn't a string
  });

  test("[A3 §2] rejects a message over the 8KB size cap", () => {
    const huge = "x".repeat(9000);
    const msg = { type: "selection", seq: 0, quote: { exact: huge, prefix: "", suffix: "" }, range: { start: 0, end: 1 } };
    expect(validateBridgeMessage(msg)).toEqual({ ok: false, reason: "message exceeds 8KB cap" });
  });

  test("[A3 §6] a script/HTML payload in the quote is accepted as PLAIN TEXT — escaping is the render side's job, not the validator's", () => {
    const msg = {
      type: "selection",
      seq: 0,
      quote: { exact: "<script>alert(1)</script>", prefix: "", suffix: "" },
      range: { start: 0, end: 1 },
    };
    const result = validateBridgeMessage(msg);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.quote.exact).toBe("<script>alert(1)</script>"); // untouched string, not stripped/executed
  });
});

describe("createTokenBucket — [A3 §2] 50 msg/s rate limit, token bucket, drop excess", () => {
  test("allows exactly `capacity` messages instantly, then drops the next one", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 5, refillPerSec: 5 }, () => now);
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false); // 6th at the same instant — no tokens left
  });

  test("refills over time — after 1 full second, capacity tokens are available again", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 50, refillPerSec: 50 }, () => now);
    for (let i = 0; i < 50; i++) bucket.take();
    expect(bucket.take()).toBe(false);
    now += 1000; // 1 second later
    for (let i = 0; i < 50; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  test("partial refill: half a second at 50/s refills 25 tokens, not more", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 50, refillPerSec: 50 }, () => now);
    for (let i = 0; i < 50; i++) bucket.take();
    now += 500;
    let allowed = 0;
    for (let i = 0; i < 30; i++) if (bucket.take()) allowed++;
    expect(allowed).toBe(25);
  });
});

describe("createMessageRouter — validation + rate limit gate before dispatch", () => {
  test("dispatches a valid selection message to onSelection", () => {
    const received: unknown[] = [];
    let now = 0;
    const router = createMessageRouter({
      bucket: createTokenBucket({ capacity: 10, refillPerSec: 10 }, () => now),
      onSelection: (msg: unknown) => received.push(msg),
    });
    router({ type: "selection", seq: 0, quote: { exact: "a", prefix: "", suffix: "" }, range: { start: 0, end: 1 } });
    expect(received).toHaveLength(1);
  });

  test("a malformed message never reaches any callback", () => {
    const calls: string[] = [];
    let now = 0;
    const router = createMessageRouter({
      bucket: createTokenBucket({ capacity: 10, refillPerSec: 10 }, () => now),
      onSelection: () => calls.push("selection"),
      onMark: () => calls.push("mark"),
      onReady: () => calls.push("ready"),
      onError: () => calls.push("error"),
    });
    router({ type: "bogus", seq: 0 });
    router(null);
    router("just a string");
    expect(calls).toHaveLength(0);
  });

  test("a rate-limited message is dropped silently — no callback, no throw", () => {
    const received: unknown[] = [];
    let now = 0;
    const router = createMessageRouter({
      bucket: createTokenBucket({ capacity: 1, refillPerSec: 1 }, () => now),
      onReady: () => received.push("ready"),
    });
    router({ type: "ready", seq: 0 });
    router({ type: "ready", seq: 1 }); // over budget at the same instant
    expect(received).toEqual(["ready"]);
  });
});

describe("classifyIframeLoad — [self-navigation mitigation] detecting a post-handshake iframe navigation", () => {
  test("the first load is the handshake", () => {
    expect(classifyIframeLoad(1)).toBe("handshake");
  });

  test("any load after the first is a navigation", () => {
    expect(classifyIframeLoad(2)).toBe("navigation");
    expect(classifyIframeLoad(3)).toBe("navigation");
    expect(classifyIframeLoad(100)).toBe("navigation");
  });
});

describe("mountClassFViewer — DOM smoke test (happy-dom; full handshake needs a real browser, P5.4)", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  function fakeDataAccess(mintResult: { url: string; nonce: string; expires_in_s: number }) {
    const mintCalls: Array<[string, string]> = [];
    return {
      mintClassFCapability: async (slug: string, artifactPath: string) => {
        mintCalls.push([slug, artifactPath]);
        return mintResult;
      },
      mintCalls,
    };
  }

  test("creates a sandboxed, no-referrer iframe and mints a capability for the given artifact", async () => {
    const container = dom.document.createElement("div");
    dom.document.body.append(container);
    const da = fakeDataAccess({ url: "http://127.0.0.1:4647/doc/tok/notes.html", nonce: "n".repeat(64), expires_in_s: 600 });

    mountClassFViewer(container, { dataAccess: da, slug: "ws-1", artifactPath: "output/docs/notes.html" });
    await Promise.resolve();
    await Promise.resolve();

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(da.mintCalls).toEqual([["ws-1", "output/docs/notes.html"]]);
    // A3 §2: `src`, not `srcdoc` — srcdoc would give the document the PARENT's origin as its
    // base, defeating the whole "opaque origin from src, not same-origin from srcdoc" design.
    expect(iframe!.src).toBe("http://127.0.0.1:4647/doc/tok/notes.html");
    expect(iframe!.hasAttribute("srcdoc")).toBe(false);
  });

  test("[self-navigation mitigation] a SECOND `load` event on the iframe (a self-navigation) tears it down and surfaces an error, not a silent re-handshake", async () => {
    const container = dom.document.createElement("div");
    dom.document.body.append(container);
    const da = fakeDataAccess({ url: "http://127.0.0.1:4647/doc/tok/notes.html", nonce: "n".repeat(64), expires_in_s: 600 });
    const errors: string[] = [];

    mountClassFViewer(container, { dataAccess: da, slug: "ws-1", artifactPath: "notes.html", onError: (msg: string) => errors.push(msg) });
    await Promise.resolve();
    await Promise.resolve();

    const iframe = container.querySelector("iframe")!;
    iframe.dispatchEvent(new dom.window.Event("load")); // 1st load — the real handshake trigger
    expect(container.querySelector("iframe")).not.toBeNull(); // still mounted after the first load

    iframe.dispatchEvent(new dom.window.Event("load")); // 2nd load — a self-navigation
    expect(container.querySelector("iframe")).toBeNull(); // torn down
    expect(errors).toEqual(["document attempted to navigate"]);
  });

  test("unmount() removes the iframe from the container", async () => {
    const container = dom.document.createElement("div");
    dom.document.body.append(container);
    const da = fakeDataAccess({ url: "http://127.0.0.1:4647/doc/tok/notes.html", nonce: "n".repeat(64), expires_in_s: 600 });

    const unmount = mountClassFViewer(container, { dataAccess: da, slug: "ws-1", artifactPath: "notes.html" });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector("iframe")).not.toBeNull();

    unmount();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
