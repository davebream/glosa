// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the SPA's servable files and where their bytes come from (P1.4, #432).
//
// Two sources behind one interface. A source checkout reads from disk on every request, so an edit
// shows on reload (R-L10). An installed daemon reads every servable file into memory before it binds
// and serves only those bytes for its whole life (R-L1), so a package manager replacing the tree
// underneath it can never mix two versions into one page. Either way the page is stamped with the
// daemon's build hash and asks for its assets under `/app/@<hash>/` (R-L6).
// Contract: docs/design/2026-09-29-install-lifetime-and-restart.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceSha256 } from "../artifact-render.ts";
import type { DictationBrowserAsset } from "../dictation/interface.ts";

// The SPA's static source dir (`packages/spa/src/`), resolved relative to this file rather than
// `process.cwd()` so it's correct regardless of where `glosa` is invoked from (P1.4).
export const SPA_SRC_DIR = fileURLToPath(new URL("../../../spa/src/", import.meta.url));

// Fixed allowlist of files servable under `GET /app/<file>` (A3 §3: no path traversal — a
// basename check alone isn't enough, so every servable file is named here explicitly; anything
// not in this map 404s regardless of what else lives on disk under SPA_SRC_DIR).
export const SPA_ASSETS: Readonly<Record<string, string>> = {
  // Appearance preload is classic/blocking to apply a persisted override before CSS paints;
  // appearance.js owns the page-lifetime controller and workspace popover. Both read the one list
  // of appearances, a classic script the preload needs before any module loads (#405).
  "appearance-list.js": "text/javascript; charset=utf-8",
  "appearance-preload.js": "text/javascript; charset=utf-8",
  "appearance.js": "text/javascript; charset=utf-8",
  // A document's style (Editorial, Spec, Mono): its per-document choice, the folder default it
  // falls back to, and the menu rows that choose them (#407).
  "style.js": "text/javascript; charset=utf-8",
  // The text size step (#406): a classic, blocking preload that holds the ladder and applies the
  // stored step before CSS paints, and the store and stepper that text-size.js builds on it.
  "text-size-preload.js": "text/javascript; charset=utf-8",
  "text-size.js": "text/javascript; charset=utf-8",
  // Passage addresses ("§2.3"), derived from the rendered Markdown structure.
  "address.js": "text/javascript; charset=utf-8",
  "bootstrap.js": "text/javascript; charset=utf-8",
  // What the page says when the daemon that served it changes (#432, R-L6/R-L8).
  "update-notice.js": "text/javascript; charset=utf-8",
  // The theme slots (#409): packages/spa/src/themes/*.json, checked against their contrast floors
  // and rendered into one stylesheet, so a theme reaches the page under `style-src 'self'` rather
  // than as an injected <style>. The theme files themselves are not served.
  "themes.css": "text/css; charset=utf-8",
  // The SPA's visual system (design brief docs/design/2026-07-21-workspace-review-surface-brief.md).
  "app.css": "text/css; charset=utf-8",
  // The product mark is a fixed, self-adapting SVG used by the shell and browser chrome.
  "glosa-mark.svg": "image/svg+xml",
  // The two faces of the visual system, vendored so the runtime never reaches a font service
  // (A3: no external calls). Licences: src/fonts/OFL.txt. Served as bytes, never decoded as text.
  "fonts/source-serif-4-roman.woff2": "font/woff2",
  "fonts/source-serif-4-italic.woff2": "font/woff2",
  "fonts/source-sans-3-roman.woff2": "font/woff2",
  "fonts/source-sans-3-italic.woff2": "font/woff2",
  // P3.3 additions — the class-R viewer + its ONE data-access module (R6), and idiomorph
  // vendored under src/vendor/ (see that file's own header for why it's vendored rather than a
  // bare-specifier import).
  "document-images.js": "text/javascript; charset=utf-8",
  "image-insertion.js": "text/javascript; charset=utf-8",
  "image-pane.js": "text/javascript; charset=utf-8",
  // Desk browser tabs (#440): the pane and its address rules.
  "browser-pane.js": "text/javascript; charset=utf-8",
  "browser-address.js": "text/javascript; charset=utf-8",
  "vendor/image-viewer.js": "text/javascript; charset=utf-8",
  "vendor/image-viewer.css": "text/css; charset=utf-8",
  "data-access.js": "text/javascript; charset=utf-8",
  "dictation.js": "text/javascript; charset=utf-8",
  "viewer.js": "text/javascript; charset=utf-8",
  "viewer-shell.js": "text/javascript; charset=utf-8",
  "viewer-context-surfaces.js": "text/javascript; charset=utf-8",
  "viewer-feedback.js": "text/javascript; charset=utf-8",
  "viewer-navigator.js": "text/javascript; charset=utf-8",
  "agent-feedback.js": "text/javascript; charset=utf-8",
  "artifact-tree.js": "text/javascript; charset=utf-8",
  "file-actions.js": "text/javascript; charset=utf-8",
  "annotate.js": "text/javascript; charset=utf-8",
  // The agent's half of the Review margin: source→rendered quote resolution and card shaping.
  "agent-request.js": "text/javascript; charset=utf-8",
  // The desktop shell's Dock badge and notifications (#391); loaded only inside the shell.
  "attention-watch.js": "text/javascript; charset=utf-8",
  "vendor/idiomorph.js": "text/javascript; charset=utf-8",
  // P3.5 additions — the checkpoint/diff timeline pane and its ONE vendored rendering dependency.
  "history.js": "text/javascript; charset=utf-8",
  "vendor/diff2html.js": "text/javascript; charset=utf-8",
  "vendor/diff2html.min.css": "text/css; charset=utf-8",
  // P4.1 addition — the class-F viewer's iframe/handshake/message-validation logic.
  "classf-viewer.js": "text/javascript; charset=utf-8",
  // P4.2 addition — the read-only conversation mirror + out-of-band composer (R6/F32).
  "conversation.js": "text/javascript; charset=utf-8",
  "attention-tray.js": "text/javascript; charset=utf-8",
  // Which bytes a run of top-level blocks owns (#271). Statically imported by artifact-pane.js —
  // it is pure arithmetic with no imports of its own, so it stays outside the lazy editor bundle
  // and has to be served with the reading modules rather than beside the editor below.
  "run-spans.js": "text/javascript; charset=utf-8",
  // Rich markdown editor (the byte-exact source view) + its vendored ProseMirror bundle.
  "rich-editor.js": "text/javascript; charset=utf-8",
  "markdown-parser.js": "text/javascript; charset=utf-8",
  "markdown-non-manuscript.js": "text/javascript; charset=utf-8",
  "vendor/prosemirror.js": "text/javascript; charset=utf-8",
  // Shared confirm dialog (discard-edits and restore guards).
  "dialog.js": "text/javascript; charset=utf-8",
  // Multi-artifact workbench (design brief docs/design/2026-09-04-multi-artifact-workbench-brief.md):
  // the dock engine and its stylesheet, one pane per artifact, and a comparison as a pane.
  "dock.js": "text/javascript; charset=utf-8",
  "agent-mcp-settings.js": "text/javascript; charset=utf-8",
  "agent-ui.js": "text/javascript; charset=utf-8",
  "agent-settings.js": "text/javascript; charset=utf-8",
  "agent-login.js": "text/javascript; charset=utf-8",
  "chat-markdown.js": "text/javascript; charset=utf-8",
  "vendor/markdown-it.js": "text/javascript; charset=utf-8",
  "composer-picker.js": "text/javascript; charset=utf-8",
  "chat-pane.js": "text/javascript; charset=utf-8",
  "vendor/xterm.mjs": "text/javascript; charset=utf-8",
  "vendor/xterm.css": "text/css; charset=utf-8",
  "panel-identity.js": "text/javascript; charset=utf-8",
  "artifact-pane.js": "text/javascript; charset=utf-8",
  // #182 — the pure three-way merge behind Keep mine, imported by artifact-pane.js.
  "merge-markdown.js": "text/javascript; charset=utf-8",
  // The document outline as data (headings, depths, the current section), and the Go to palette
  // (⌘K) that lists it beside the workspace's files. Pure DOM — no transport of their own.
  "outline.js": "text/javascript; charset=utf-8",
  "palette.js": "text/javascript; charset=utf-8",
  "diff-pane.js": "text/javascript; charset=utf-8",
  "vendor/dockview.js": "text/javascript; charset=utf-8",
  // Served as a real stylesheet rather than injected inline, so it lands under `style-src 'self'`.
  "vendor/dockview.css": "text/css; charset=utf-8",
};

/** A servable file, as the route answers it. */
export interface ServedAsset {
  body: Buffer<ArrayBuffer>;
  contentType: string;
  etag: string;
}

export interface SpaAssetSource {
  /** The hash the page is stamped with and asset URLs are scoped by (R-L6); null serves the page
   *  unstamped, as a hand-built test context does. */
  readonly buildHash: string | null;
  /** `shell.html`, stamped when `buildHash` is set. */
  shell(): string;
  /** A built-in asset or a provider's browser asset by its `/app/…` route, or null. */
  asset(route: string): ServedAsset | null;
}

/** The ETag today's route sends: a font's raw sha256 (bytes are never decoded as text), otherwise
 *  the same source hash the artifact renderer uses. */
function etagFor(body: Buffer<ArrayBuffer>, contentType: string): string {
  const digest = contentType.startsWith("font/") ? createHash("sha256").update(body).digest("hex") : sourceSha256(body);
  return `"${digest}"`;
}

/** `shell.html` with every `/app/` reference scoped to `hash` and a `glosa-build` meta the page reads
 *  at boot (R-L6). Relative imports inside the modules inherit the prefix from their own URL. */
export function stampShell(html: string, hash: string): string {
  const scoped = html.replaceAll('="/app/', `="/app/@${hash}/`);
  const meta = `<meta name="glosa-build" content="${hash}" />`;
  return scoped.includes("<head>") ? scoped.replace("<head>", `<head>\n${meta}`) : `${meta}\n${scoped}`;
}

/** The file behind a built-in route, or null when the name is not on the allowlist. `Object.hasOwn`,
 *  not a bare lookup: a prototype key like `__proto__` would otherwise resolve to a truthy value. */
function builtIn(dir: string, route: string): { path: string; contentType: string } | null {
  if (!route.startsWith("/app/")) return null;
  const name = route.slice("/app/".length);
  if (!Object.hasOwn(SPA_ASSETS, name)) return null;
  return { path: join(dir, name), contentType: SPA_ASSETS[name] as string };
}

/** Today's behaviour: every request reads the file from disk. */
export function liveSpaAssets(options: {
  dir?: string;
  buildHash: string | null;
  providerAsset?: (route: string) => DictationBrowserAsset | undefined;
}): SpaAssetSource {
  const dir = options.dir ?? SPA_SRC_DIR;
  return {
    buildHash: options.buildHash,
    shell() {
      const html = readFileSync(join(dir, "shell.html"), "utf8");
      return options.buildHash === null ? html : stampShell(html, options.buildHash);
    },
    asset(route) {
      const file = builtIn(dir, route) ?? toFile(options.providerAsset?.(route));
      if (file === null) return null;
      // Read bytes, not text: a font decoded as UTF-8 and re-encoded would reach the browser corrupt.
      const body = readFileSync(file.path);
      return { body, contentType: file.contentType, etag: etagFor(body, file.contentType) };
    },
  };
}

function toFile(asset: DictationBrowserAsset | undefined): { path: string; contentType: string } | null {
  return asset === undefined ? null : { path: asset.filePath, contentType: asset.contentType };
}

/** Every file an installed daemon pins at boot: `shell.html`, the allowlist and the providers'
 *  browser assets. Also the curated file set the install guard watches (R-L2). */
export function pinnedFilePaths(dir: string, providerAssets: readonly DictationBrowserAsset[]): string[] {
  return [
    join(dir, "shell.html"),
    ...Object.keys(SPA_ASSETS).map((name) => join(dir, name)),
    ...providerAssets.map((asset) => asset.filePath),
  ];
}

/** R-L1: read everything once, now, and serve only these bytes. A file missing at boot stays
 *  missing (404), exactly as it would have failed per request before. */
export function pinnedSpaAssets(options: {
  dir?: string;
  buildHash: string;
  providerAssets: readonly DictationBrowserAsset[];
}): SpaAssetSource {
  const dir = options.dir ?? SPA_SRC_DIR;
  const shell = stampShell(readFileSync(join(dir, "shell.html"), "utf8"), options.buildHash);
  const assets = new Map<string, ServedAsset>();
  const pin = (route: string, path: string, contentType: string): void => {
    try {
      const body = readFileSync(path);
      assets.set(route, { body, contentType, etag: etagFor(body, contentType) });
    } catch {
      // absent at boot: not servable
    }
  };
  for (const [name, contentType] of Object.entries(SPA_ASSETS)) pin(`/app/${name}`, join(dir, name), contentType);
  for (const asset of options.providerAssets) pin(asset.route, asset.filePath, asset.contentType);
  return {
    buildHash: options.buildHash,
    shell: () => shell,
    asset: (route) => assets.get(route) ?? null,
  };
}
