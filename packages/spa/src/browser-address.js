// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — desk browser tabs (#440): what a typed address means, what the address row shows,
// what a tab is called, and what a failed load says. Pure, so every rule is testable without a page.
//
// glosa never searches the web: words that are not an address stay words, and the row says so,
// because sending them to a search engine nobody configured would be egress no one asked for
// (AGENTS.md invariant 5).

/** @typedef {{ ok: true, url: string } | { ok: false, reason: "empty" | "not-an-address" | "unsupported", text: string }} ParsedAddress */

/** A name that always means this machine: `localhost` and its subdomains, the loopback ranges.
 * @param {string} hostname */
export function isLoopbackHostname(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Whether a page lives on this machine. A restored local tab loads at once; any other waits.
 * @param {string} url */
export function isLocalUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether `url` is glosa itself: the SPA's own port, or the class-F port beside it, on any loopback
 * name. The shell's request policy cancels such a load silently (packages/shell/src/policy.ts
 * browserRequestDecision), so the tab refuses it first and says why instead of sitting on a page
 * it never reached.
 * @param {string} url
 * @param {string} spaUrl the page's own address (`location.href`)
 */
export function isGlosaAddress(url, spaUrl) {
  try {
    const target = new URL(url);
    const spa = new URL(spaUrl);
    const port = (/** @type {URL} */ u) => Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const spaPort = port(spa);
    return isLoopbackHostname(target.hostname) && [spaPort, spaPort + 1].includes(port(target));
  } catch {
    return false;
  }
}

const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether `host` (no scheme, maybe a port) reads as somewhere to go rather than words.
 * @param {string} host */
function looksLikeHost(host) {
  const name = host
    .replace(/:\d{1,5}$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
  if (!name) return false;
  if (isLoopbackHostname(name) || IPV4.test(name) || name.includes(":")) return true;
  // A dotted name whose last label is a word, the way every public name is (`example.org`,
  // `docs.tidewater.dev`); `v1.2` or `notes` are not addresses.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z-]*[a-z]$/.test(name);
}

/**
 * What someone typed into the address row, as a web address, or why it is not one.
 * `localhost:5173`, a loopback address or a private network address gets `http://`; any other
 * name gets `https://`. A scheme other than http or https is refused rather than guessed at.
 *
 * @param {string} input
 * @returns {ParsedAddress}
 */
export function parseAddress(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, reason: "empty", text };
  if (/\s/.test(text)) return { ok: false, reason: "not-an-address", text };
  // `localhost:5173/x` looks like a scheme to a URL parser; a host and a port come first.
  const hostAndPort = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})(?=[/?#]|$)/i.exec(text);
  const scheme = hostAndPort ? null : /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  let candidate = text;
  if (scheme) {
    if (scheme !== "http" && scheme !== "https") return { ok: false, reason: "unsupported", text };
  } else {
    const host = /^[^/?#]+/.exec(text)?.[0] ?? "";
    if (!looksLikeHost(host)) return { ok: false, reason: "not-an-address", text };
    const name = host.replace(/:\d{1,5}$/, "").replace(/^\[(.*)\]$/, "$1");
    const plain = isLoopbackHostname(name) || PRIVATE_IPV4.test(name) || IPV4.test(name);
    candidate = `${plain ? "http" : "https"}://${text}`;
  }
  try {
    const url = new URL(candidate);
    if (!url.hostname) return { ok: false, reason: "not-an-address", text };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "not-an-address", text };
  }
}

/** The sentence under the address row when an address will not do.
 * @param {ParsedAddress} parsed */
export function addressProblem(parsed) {
  if (parsed.ok || parsed.reason === "empty") return "";
  const quoted = parsed.text.length > 48 ? `${parsed.text.slice(0, 45)}…` : parsed.text;
  if (parsed.reason === "unsupported")
    return `"${quoted}" isn't a web address. Browser tabs open http and https pages.`;
  return `"${quoted}" isn't a web address. glosa doesn't search the web.`;
}

/**
 * The address row's reading of a page's address: where it is ("Local" for this machine, "Not
 * secure" for plain http anywhere else, nothing for https), the host in ink and the rest muted.
 * The scheme is left out, as browsers do; the field holds the full address when it is edited.
 *
 * @param {string} url
 */
export function describeUrl(url) {
  try {
    const parsed = new URL(url);
    const local = isLoopbackHostname(parsed.hostname);
    const where = local ? "Local" : parsed.protocol === "http:" ? "Not secure" : "";
    let rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (rest === "/") rest = "";
    return { where, host: parsed.host, rest, local, secure: parsed.protocol === "https:" };
  } catch {
    return { where: "", host: String(url ?? ""), rest: "", local: false, secure: false };
  }
}

/** A browser tab's label: the page's own title, else its host, else what a new tab is.
 * @param {{ title?: string, url?: string }} page */
export function browserTabLabel({ title, url }) {
  const named = typeof title === "string" ? title.trim() : "";
  if (named) return named;
  if (url) {
    try {
      return new URL(url).host || "New browser tab";
    } catch {
      // fall through
    }
  }
  return "New browser tab";
}

// Chromium's net error codes (net/base/net_error_list.h) the tab says something specific about.
const REFUSED = new Set([-100, -101, -102, -104, -109, -118, -7, -324]);
const NOT_FOUND = new Set([-105, -137]);

/**
 * What a tab says when its page did not load, or null when there is nothing to say (a load the
 * person stopped, or one replaced by the next). `action` is the one thing offered: reload, or
 * open the page in the person's own browser.
 *
 * @param {number} code
 * @param {string} url
 * @returns {{ title: string, body: string, action: "reload" | "open-outside" | null } | null}
 */
export function describeLoadFailure(code, url) {
  if (code === -3) return null; // ERR_ABORTED: stopped, or superseded by another navigation
  const { host, local } = describeUrl(url);
  const where = host || "this address";
  if (local && (REFUSED.has(code) || NOT_FOUND.has(code))) {
    return {
      title: `Nothing is answering at ${where}`,
      body: "The dev server may not be running. Start it, then reload.",
      action: "reload",
    };
  }
  if (NOT_FOUND.has(code)) {
    return { title: `glosa couldn't find ${where}`, body: "Check the address, or your connection.", action: "reload" };
  }
  if (code === -106) {
    return {
      title: "You're offline",
      body: `glosa couldn't reach ${where}. Reload once you're connected.`,
      action: "reload",
    };
  }
  if (REFUSED.has(code)) {
    return {
      title: `glosa couldn't reach ${where}`,
      body: "The site didn't answer. Try again in a moment.",
      action: "reload",
    };
  }
  if (code <= -200 && code >= -299) {
    return {
      title: `${where} has a certificate glosa can't trust`,
      body: "glosa won't show this page. If you trust the site, open it in your browser.",
      action: "open-outside",
    };
  }
  if (code === -20) {
    return {
      title: `glosa doesn't show ${where} in a browser tab`,
      body: "That address is glosa's own. Its documents are in the navigator.",
      action: null,
    };
  }
  if (code === -310) {
    return {
      title: `${where} keeps redirecting`,
      body: "The page sent glosa round in a loop. Open it in your browser to see what it wants.",
      action: "open-outside",
    };
  }
  return {
    title: `glosa couldn't load ${where}`,
    body: "Try reloading, or open it in your browser.",
    action: "reload",
  };
}
