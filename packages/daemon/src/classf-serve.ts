// @glosa/daemon — GET /doc/:token/<path...> (A1 §7, A3 §1): the class-F origin's ONLY route.
// Resolves a capability token to its minted directory, re-confines the requested sibling path
// against that directory on EVERY request (confinePath, A1 §6 — "each request re-confined... a
// sibling request can never escape the artifact's directory"), and streams the file
// source-preserving — bridge-injected for the document itself, byte-identical for every sibling
// asset (A1 §7's "sibling assets are streamed with their own content-type... no bridge").
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { confinePath } from "./confine-path.ts";
import { buildBridgeInjection } from "./classf-bridge.ts";
import type { CapabilityStore } from "./capability.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// A sandboxed `allow-scripts` iframe can't fetch/XHR/WS/frame out (CSP's `connect-src 'none'`),
// but it CAN always navigate itself — a residual the platform doesn't let CSP close (logged as an
// accepted decision). A `<meta http-equiv="refresh" content="0;url=...">` is the one exfil variant
// that needs no script at all, so it's the one form worth actually neutralizing at serve time; a
// script-driven `location.href = ...` still gets caught, but on the PARENT side (classf-viewer.js
// detects the resulting re-`load` and tears the iframe down) — see that module's own docstring.
const META_TAG_RE = /<meta\b[^>]*>/gi;
const HTTP_EQUIV_REFRESH_RE = /http-equiv\s*=\s*(["']?)\s*refresh\s*\1/i;

function stripMetaRefresh(html: string): string {
  return html.replace(META_TAG_RE, (tag) => (HTTP_EQUIV_REFRESH_RE.test(tag) ? "<!-- glosa: meta refresh removed -->" : tag));
}

/** Finds the index the bridge should be spliced in front of: the START of the LAST `</body>`
 * (any case, any internal whitespace before `>`) in the ORIGINAL string. Deliberately NOT
 * `html.toLowerCase().lastIndexOf("</body>")` — `String.toLowerCase()` isn't always length-
 * preserving (e.g. `"İ".toLowerCase()` is 2 UTF-16 units from 1 input unit), so an index found
 * against a lowercased COPY can land at the wrong offset in the ORIGINAL string once the document
 * contains such a character before `</body>` — this scans the original directly instead. */
function lastBodyCloseIndex(html: string): number {
  const re = /<\/body\s*>/gi;
  let lastIndex = -1;
  for (let match = re.exec(html); match !== null; match = re.exec(html)) lastIndex = match.index;
  return lastIndex;
}

/** `GET /doc/<token>/<path...>` — everything else on the class-F listener 404s before reaching
 * this (createClassFFetch owns the Host check + route parse). Returns `null` for "not found"
 * (unknown/expired token, a path that escapes the directory, or a missing/non-file target) so the
 * caller can render the ONE plain-text 404 body A1 §7 requires ("no daemon-origin details")
 * regardless of which of those actually happened — an attacker must not be able to distinguish
 * "token doesn't exist" from "path escaped the directory" from "file missing" by response shape. */
export function serveClassFDocument(store: CapabilityStore, token: string, rawPath: string): Response | null {
  const record = store.lookup(token);
  if (!record) return null;

  // Re-confined against the MINTED artifact directory on every single request (A1 §7) — never
  // against a workspace root, and never trusting a previous request's confinement.
  const confined = confinePath(record.artifactDirRealPath, rawPath);
  if (!confined.ok) return null;

  let raw: Buffer;
  try {
    const st = statSync(confined.realPath);
    if (!st.isFile()) return null;
    raw = readFileSync(confined.realPath);
  } catch {
    return null;
  }

  const isDocument = rawPath === record.artifactBasename;
  const contentType = contentTypeFor(rawPath);

  if (isDocument && contentType.startsWith("text/html")) {
    const html = stripMetaRefresh(raw.toString("utf8"));
    const injection = buildBridgeInjection(record.nonce);
    const bodyCloseIdx = lastBodyCloseIndex(html);
    const withBridge =
      bodyCloseIdx === -1 ? html + injection : html.slice(0, bodyCloseIdx) + injection + html.slice(bodyCloseIdx);
    return new Response(withBridge, { headers: { "Content-Type": contentType } });
  }

  // Every sibling asset — including a `.html` file that ISN'T the document itself — is streamed
  // byte-identical, no bridge injected. The `as BodyInit` cast mirrors http.ts's own
  // `readBodyCapped` handling — `Response` accepts a `Uint8Array` body at runtime (Buffer IS a
  // Uint8Array), it's only the ambient lib types (bun-types' non-generic `Uint8Array`
  // augmentation vs. `Buffer`'s generic one, at this TypeScript/bun-types pin) that disagree.
  return new Response(raw as unknown as BodyInit, { headers: { "Content-Type": contentType } });
}
