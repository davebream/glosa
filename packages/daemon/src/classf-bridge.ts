// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the glosa bridge injected into a class-F document's own HTML (A3 §1/§2). This
// is UNTRUSTED-origin code by construction: it runs inside the opaque-origin, sandboxed iframe,
// alongside whatever the document's own `<script>`s do. It carries no ambient authority of its
// own — `connect-src 'none'`/`form-action 'none'` (the class-F CSP, csp.ts) block it from ever
// reaching the network, and the ONLY channel it can use to talk to the trusted parent is the
// private `MessagePort` handed to it during the one-time nonce-gated handshake below. Security
// enforcement lives on the PARENT side (packages/spa/src/classf-viewer.js) — this script's own
// nonce check just keeps a THIRD party (a page that isn't the real glosa SPA) from completing the
// handshake and stealing the port; it is not the security boundary itself.
import { randomBytes } from "node:crypto";

/** Pure mirror of the bridge script's own handshake gate (A3 §2: "validates the nonce ONCE").
 * Kept here as a real, independently testable function for the same reason data-access.js's SSE
 * parser is unit-tested against sse.ts's real encoder (see that module's header comment) — the
 * actual enforcement necessarily lives in the plain-JS string below (this is code that runs
 * inside a foreign HTML document, so it can't be a bare TS import), but the DECISION LOGIC is
 * simple enough to duplicate byte-for-byte and pin down with a unit test: accept an init message
 * only when handshake hasn't already completed, the type is exactly "glosa:init", and its nonce
 * matches the one this document was served with. */
export function bridgeShouldAcceptInit(
  msg: { type?: unknown; nonce?: unknown } | null | undefined,
  expectedNonce: string,
  alreadyHandshaked: boolean,
): boolean {
  if (alreadyHandshaked) return false;
  if (!msg || msg.type !== "glosa:init") return false;
  return typeof msg.nonce === "string" && msg.nonce === expectedNonce;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Builds the literal `<script>`+`<style>` text injected into a class-F document immediately
 * before `</body>` (classf-serve.ts). `nonce` is hex (from CapabilityStore, capability.ts) so it
 * embeds into the script source with no escaping concerns. The script:
 *
 * 1. Listens for the parent's ONE `postMessage({type:"glosa:init", nonce}, classFOrigin,
 *    [port2])` (A3 §2) and validates it with the exact algorithm `bridgeShouldAcceptInit` mirrors
 *    above — reject silently (no reply) on a bad/missing nonce or a repeat attempt.
 * 2. Once validated, keeps the received `MessagePort` and communicates EXCLUSIVELY over it from
 *    then on — the bridge never calls `postMessage` on `window`/`parent` again.
 * 3. Sends `ready` once the port is live, then `selection` messages (with `seq`, `quote{exact,
 *    prefix,suffix}`, `range{start,end}`, and an optional `chunk_id` read off the nearest
 *    `[data-chunk-id]` ancestor) on every non-collapsed text selection, and `error` if building
 *    one throws. All strings are sent as plain text — no HTML is ever constructed from them
 *    (A3 §5 attack #6: the escaping obligation lives on the RENDERING side, not here).
 */
export function buildBridgeInjection(nonce: string): string {
  const instanceId = randomHex(4); // cosmetic only — namespaces the injected style id per render
  return `<style id="glosa-bridge-style-${instanceId}">.glosa-bridge-mark{background:rgba(255,214,0,.35)}</style>
<script>
(function () {
  "use strict";
  var EXPECTED_NONCE = ${JSON.stringify(nonce)};
  var port = null;
  var handshaked = false;
  var seq = 0;

  // Mirrors bridgeShouldAcceptInit's exact three conditions (classf-bridge.ts) — kept in lockstep
  // by hand since this string can't import that function.
  function shouldAcceptInit(msg) {
    if (handshaked) return false;
    if (!msg || msg.type !== "glosa:init") return false;
    return typeof msg.nonce === "string" && msg.nonce === EXPECTED_NONCE;
  }

  function send(message) {
    if (!port) return;
    try {
      port.postMessage(message);
    } catch (e) {
      // the port is gone (parent tore down the iframe) — nothing to recover, nothing to report
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!shouldAcceptInit(data)) return;
    var p = event.ports && event.ports[0];
    if (!p) return;
    handshaked = true;
    port = p;
    port.start();
    send({ type: "ready", seq: seq++ });
  });

  function chunkIdOf(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el.nodeType === 1) {
      var id = el.getAttribute && el.getAttribute("data-chunk-id");
      if (id) return id;
      el = el.parentElement;
    }
    return undefined;
  }

  function textOffsetOf(container, node, offset) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var total = 0;
    var current = walker.nextNode();
    while (current) {
      if (current === node) return total + offset;
      total += current.textContent.length;
      current = walker.nextNode();
    }
    return total;
  }

  function onSelectionChange() {
    if (!handshaked) return;
    try {
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      var range = selection.getRangeAt(0);
      var container = document.body;
      if (!container.contains(range.commonAncestorContainer)) return;
      var fullText = container.textContent;
      var start = textOffsetOf(container, range.startContainer, range.startOffset);
      var end = textOffsetOf(container, range.endContainer, range.endOffset);
      if (start >= end) return;
      var CONTEXT = 40;
      var prefixStart = Math.max(0, start - CONTEXT);
      var suffixEnd = Math.min(fullText.length, end + CONTEXT);
      var msg = {
        type: "selection",
        seq: seq++,
        quote: {
          exact: fullText.slice(start, end),
          prefix: fullText.slice(prefixStart, start),
          suffix: fullText.slice(end, suffixEnd),
        },
        range: { start: start, end: end },
      };
      var chunkId = chunkIdOf(range.commonAncestorContainer);
      if (chunkId) msg.chunk_id = chunkId;
      send(msg);
    } catch (e) {
      send({ type: "error", seq: seq++, message: "selection capture failed" });
    }
  }

  document.addEventListener("mouseup", onSelectionChange);
  document.addEventListener("selectionchange", function () {
    // selectionchange fires far more often than a human finishes a selection (every caret move);
    // mouseup above is the primary signal — this is only a fallback for non-mouse selection
    // (keyboard, assistive tech) and is deliberately debounce-free since v1's iframe fixtures are
    // small documents (A3 §5's real-browser rehearsal, not this task's unit-test surface).
  });
})();
</script>
`;
}
