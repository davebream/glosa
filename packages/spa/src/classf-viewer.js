// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the class-F (foreign HTML) viewer's parent-side trust boundary (A3 §1/§2, R6).
// Mints a capability, embeds the document in a sandboxed iframe on the SEPARATE class-F origin,
// and completes the nonce-gated MessageChannel handshake — then trusts NOTHING arriving except
// over that one private port. Never calls `fetch`/imports data-access.js itself — `dataAccess` is
// caller-injected (viewer.js passes its own instance), same DI shape as history.js's
// `mountHistoryPane` — so R6's "ONE data-access module" invariant holds through composition, not
// a second import (see test/import-boundary.test.ts).

const MAX_MESSAGE_BYTES = 8192; // A3 §2: "size cap 8KB/msg"
const RATE_LIMIT_PER_SEC = 50; // A3 §2: "rate limit 50 msg/s/iframe (token bucket, drop excess)"
const MESSAGE_TYPES = new Set(["selection", "mark", "ready", "error"]);

// ---------------------------------------------------------------------------------------------
// Pure, independently-testable pieces (A3 §2's three orthogonal checks + the message validator +
// the rate limiter). None of these touch the DOM — `mountClassFViewer` below is the only thing
// that does.
// ---------------------------------------------------------------------------------------------

/** Orthogonal check 1 (A3 §2): "capture `const win = iframeEl.contentWindow` at creation; accept
 * only `event.source === win`." Exported standalone so a forged event from a different window can
 * be proven rejected without mounting anything. */
export function checkEventSource(event, expectedWindow) {
  return event?.source === expectedWindow;
}

/** Orthogonal check 2 (A3 §2): the per-load nonce, compared as a plain string equality — same
 * shape as the bridge's own gate (classf-bridge.ts's `bridgeShouldAcceptInit`), just evaluated on
 * the parent side of the same handshake. */
export function checkNonce(data, expectedNonce) {
  return typeof data?.nonce === "string" && data.nonce === expectedNonce;
}

/** A sandboxed `allow-scripts` iframe has no fetch/XHR/WS (`connect-src 'none'`) and no top-level
 * open (the CSP's `sandbox` token), but it can ALWAYS navigate ITSELF — `location.href = ...`, a
 * click, or a script-free `<meta http-equiv=refresh>` (the latter is neutralized server-side, see
 * classf-serve.ts's `stripMetaRefresh`; the script-driven form isn't closable by the platform, so
 * this is detection + response, not prevention — a residual, logged as an accepted decision). The
 * browser fires the iframe's `load` event again on ANY navigation of its nested browsing context,
 * including a same-document one — so "more than one `load`" is the signal. Exported as a pure
 * classifier (no DOM) so the detection logic is independently testable: `loadNumber` is a 1-based
 * count of `load` events seen so far on this iframe INSTANCE. */
export function classifyIframeLoad(loadNumber) {
  return loadNumber <= 1 ? "handshake" : "navigation";
}

/** Combines checks 1+2 for the ONE handshake-adjacent message the parent might ever see arrive on
 * `window` (rather than the private port) — per A3 §2, "origin/source checks only guard the
 * single init msg." In this implementation the parent INITIATES the handshake (posts to the
 * iframe on `load`, doesn't wait to receive anything first), so nothing legitimate ever reaches a
 * `window`-level listener at all; `mountClassFViewer` still installs one, gated by this predicate,
 * purely as defense-in-depth (A3 §5 attack #3: "a 3rd window posts a well-formed msg at parent" —
 * with no window listener at all this attack is already structurally impossible, but the
 * predicate is what a test can pin down without needing a live iframe). */
export function isTrustedInitEvent(event, expectedWindow, expectedNonce) {
  return checkEventSource(event, expectedWindow) && checkNonce(event?.data, expectedNonce);
}

/** A minimal hand-rolled schema/size validator for a message arriving over the trusted
 * `MessageChannel` port (zod isn't in the stack — see the brief). Checked on EVERY message, not
 * just the first: the sender is the class-F document's own (foreign) JS, which this validator
 * treats as untrusted input even though it already crossed the port boundary — a buggy or hostile
 * doc script can still send malformed data over an otherwise-legitimate channel. */
export function validateBridgeMessage(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };
  if (!MESSAGE_TYPES.has(raw.type)) return { ok: false, reason: "unknown type" };
  if (!Number.isInteger(raw.seq) || raw.seq < 0) return { ok: false, reason: "seq must be a non-negative integer" };

  let byteLength;
  try {
    byteLength = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  } catch {
    return { ok: false, reason: "not serializable" };
  }
  if (byteLength > MAX_MESSAGE_BYTES) return { ok: false, reason: "message exceeds 8KB cap" };

  if (raw.type === "selection") {
    const quote = raw.quote;
    if (typeof quote !== "object" || quote === null) return { ok: false, reason: "quote is required" };
    if (typeof quote.exact !== "string" || typeof quote.prefix !== "string" || typeof quote.suffix !== "string") {
      return { ok: false, reason: "quote.exact/prefix/suffix must be strings" };
    }
    const range = raw.range;
    if (typeof range !== "object" || range === null) return { ok: false, reason: "range is required" };
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start >= range.end) {
      return { ok: false, reason: "range.start/end must be integers with start < end" };
    }
    if (raw.chunk_id !== undefined && typeof raw.chunk_id !== "string") {
      return { ok: false, reason: "chunk_id must be a string when present" };
    }
  }

  return { ok: true, value: raw };
}

/** A token bucket: `capacity` tokens, refilled at `refillPerSec` tokens/second, `take()` consumes
 * one and returns whether it was available. `nowFn` is injectable so a test can drive it without
 * a real clock. Matches A3 §2's "rate limit 50 msg/s/iframe (token bucket, drop excess)". */
export function createTokenBucket({ capacity = RATE_LIMIT_PER_SEC, refillPerSec = RATE_LIMIT_PER_SEC } = {}, nowFn = () => Date.now()) {
  let tokens = capacity;
  let last = nowFn();

  return {
    take() {
      const now = nowFn();
      const elapsedSec = Math.max(0, (now - last) / 1000);
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** Builds the router installed as `channel.port1.onmessage` — validates + rate-limits every
 * inbound message, then dispatches to exactly one of `onSelection`/`onMark`/`onReady`/`onError`.
 * Anything that fails validation or the rate limit is silently dropped (A3 §2: "unknown → drop"),
 * never thrown — a malformed/flooding doc script must not be able to crash the parent viewer. */
export function createMessageRouter({ bucket, onSelection, onMark, onReady, onError } = {}) {
  return function handleMessage(raw) {
    if (!bucket.take()) return; // rate-limited — dropped, no error surfaced back to the doc
    const validated = validateBridgeMessage(raw);
    if (!validated.ok) return;
    const msg = validated.value;
    if (msg.type === "selection") onSelection?.(msg);
    else if (msg.type === "mark") onMark?.(msg);
    else if (msg.type === "ready") onReady?.(msg);
    else if (msg.type === "error") onError?.(msg);
  };
}

// ---------------------------------------------------------------------------------------------
// The DOM-facing mount. Everything above this line is pure and unit-tested directly; this
// function is what actually creates the iframe and drives the real handshake — its own coverage
// is necessarily lighter (needs a live iframe `load`/postMessage cycle a real browser gives you,
// noted as a P5.4 rehearsal item) beyond what's asserted about the attributes it sets.
// ---------------------------------------------------------------------------------------------

/**
 * Mounts the class-F viewer into `container`: mints a capability, creates the sandboxed iframe,
 * completes the handshake on `load`, and forwards validated `selection` messages to
 * `onSelection(target)` (a `{quote, position, chunk_id?}` shape ready to attach to an annotation
 * POST body — mirrors annotate.js's `buildAnnotationTarget` output shape, but built from the
 * bridge's own precomputed offsets rather than a DOM `Selection`, since the selection happened
 * inside the foreign document, not this one). Returns `unmount()`.
 */
export function mountClassFViewer(container, { dataAccess, slug, artifactPath, onSelection, onReady, onError } = {}) {
  const iframe = document.createElement("iframe");
  // `setAttribute`, not the `.sandbox`/`.referrerPolicy` IDL properties — more portable across
  // DOM implementations (including the happy-dom harness this module is unit-tested against) and
  // matches exactly what A3 §2 specifies as the literal iframe markup.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", "Artifact preview");
  container.textContent = "";
  container.append(iframe);

  let port = null;
  let windowMessageHandler = null;
  let loadHandler = null;
  let cancelled = false;
  let loadCount = 0;

  function teardown() {
    cancelled = true;
    if (windowMessageHandler) window.removeEventListener("message", windowMessageHandler);
    if (loadHandler) iframe.removeEventListener("load", loadHandler);
    port?.close();
    port = null;
    iframe.remove();
  }

  async function connect() {
    const { url, nonce } = await dataAccess.mintClassFCapability(slug, artifactPath);
    if (cancelled) return;
    const classFOrigin = new URL(url).origin;
    // Captured NOW, before `load` fires — A3 §2 check 1's "at creation" (here: at src-assignment
    // time, the earliest this window handle exists).
    const iframeWindow = iframe.contentWindow;

    windowMessageHandler = (event) => {
      // Defense-in-depth only — see isTrustedInitEvent's own docstring. Nothing legitimate is
      // expected to arrive here; this exists so a forged message from an unrelated window is
      // provably rejected rather than silently unhandled-by-absence.
      if (!isTrustedInitEvent(event, iframeWindow, nonce)) return;
    };
    window.addEventListener("message", windowMessageHandler);

    // A PERSISTENT listener, not `{once: true}` — a self-navigation inside the sandboxed frame
    // fires `load` again on this SAME iframe element, and that second (or later) `load` is the
    // detection signal `classifyIframeLoad` is built for (see its own docstring).
    loadHandler = () => {
      if (cancelled) return;
      loadCount += 1;
      if (classifyIframeLoad(loadCount) === "navigation") {
        teardown();
        onError?.("document attempted to navigate");
        return;
      }

      const channel = new MessageChannel();
      const bucket = createTokenBucket();
      const router = createMessageRouter({
        bucket,
        onSelection: (msg) => onSelection?.({ quote: msg.quote, position: msg.range, ...(msg.chunk_id ? { chunk_id: msg.chunk_id } : {}) }),
        onReady: () => onReady?.(),
        onError: (msg) => onError?.(msg.message),
      });
      channel.port1.onmessage = (event) => router(event.data);
      channel.port1.start();
      port = channel.port1;
      iframeWindow.postMessage({ type: "glosa:init", nonce }, classFOrigin, [channel.port2]);
    };
    iframe.addEventListener("load", loadHandler);

    iframe.src = url;
  }

  void connect().catch((error) => {
    if (cancelled) return;
    teardown();
    onError?.(error instanceof Error ? error.message : "preview unavailable");
  });

  return teardown;
}
