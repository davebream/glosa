// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — class-R artifact content helpers for A1 §5.4: the canonical `source_sha256`
// formula (A5 §F10 — SHA256 of the raw bytes after `\r\n`→`\n` only, no markdown processing) and
// the markdown-it render pipeline that stamps `data-line` attributes onto every block-level token
// so the SPA can map a click in the rendered view back to a source line (A1 §5.4).
import { closeSync, fsyncSync, openSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { addressLabels } from "../../spa/src/address.js";
import {
  installDataLineStamp,
  installNonManuscriptRules,
  MARKDOWN_OPTIONS,
  MARKDOWN_PRESET,
  tokenLayout,
} from "../../spa/src/markdown-non-manuscript.js";
import { fsyncContainingDir, writeAllSync } from "./bus/io.ts";

/** A5 §F10's fixed identity formula — shared here (artifact content responses) and by the later
 * anchoring resolver (F10/F11), so the two never compute "what is this source" two different
 * ways. Deliberately NOT full markdown processing — just the one normalization A5 §F10 names. */
export function sourceSha256(raw: Buffer): string {
  const normalized = raw.toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// One shared renderer instance — markdown-it's `.use()` mutates the instance, not per-call state,
// so building it once at module load and reusing it across requests is both correct and avoids
// re-registering the plugin on every render.
const renderer = new MarkdownIt(MARKDOWN_PRESET, { ...MARKDOWN_OPTIONS });
renderer.use(installDataLineStamp);
// #175 — issue title: "consistent non-manuscript markdown regions". Reading and Note must not show a
// document's own metadata header or a `%%`-fenced authoring comment (block OR inline) as
// manuscript; both stay recoverable in source editing, and the rich editor's Edit face carries
// either verbatim/marked and LABELED rather than hidden (rich-editor.js). `installNonManuscriptRules`
// is the ONE declarative recogniser both this real `MarkdownIt` instance and the vendored one
// inside packages/spa/src/vendor/prosemirror.js register — see that shared module's own header
// comment for why a plain, dependency-free module loads in both the daemon's Bun process and the
// browser SPA (served through transport/http.ts's `SPA_ASSETS`) with no bundler and no framework.
renderer.use(installNonManuscriptRules);

export function renderMarkdownLayout(source: string) {
  return tokenLayout(renderer.parse(source, {}));
}

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

/** One top-level block of a rendered Markdown document: its 0-based source lines (`endLine`
 * exclusive, markdown-it's own `map`) and its passage address, or null for a block the page never
 * shows. */
export interface PassageBlock {
  startLine: number;
  endLine: number;
  address: string | null;
}

/** The passage address (packages/spa/src/address.js) of every top-level block of `source`, as the
 * document stands now. The page numbers the top-level elements `renderMarkdown` produces; this
 * numbers the tokens those elements come from, through the same `addressLabels` rule, so the two
 * agree without the daemon building a DOM. A top-level token becomes one `data-line` element
 * unless it is hidden: the metadata header and a `%%` comment render nothing, so the page cannot
 * number them. They keep a row with a null address, which is what stops a line inside them from
 * borrowing a neighbour's label. */
export function passageAddresses(source: string): PassageBlock[] {
  const blocks = renderer
    .parse(source, {})
    .filter((token) => token.level === 0 && token.block && token.map && token.nesting >= 0 && token.type !== "inline");
  const visible = blocks.filter((token) => !token.hidden);
  const labels = addressLabels(
    visible.map((token) => (token.type === "heading_open" ? Number(token.tag.slice(1)) : 0)),
  );
  let next = 0;
  return blocks.map((token) => {
    const [startLine, endLine] = token.map as [number, number];
    return { startLine, endLine, address: token.hidden ? null : (labels[next++] ?? null) };
  });
}

/** The address of a passage that runs from 0-based source line `first` to `last`, inclusive: the
 * top-level block holding its last line, the way the page names a selection by the block its end
 * sits in (address.js `addressForRange`), else the block holding its first. Null when neither line
 * sits in a block the page shows. */
export function passageAddressOf(source: string, first: number, last: number): string | null {
  const blocks = passageAddresses(source);
  const at = (line: number) => blocks.find((block) => line >= block.startLine && line < block.endLine)?.address ?? null;
  return at(last) ?? at(first);
}

/** Atomic temp -> fsync -> rename write for an artifact's source content (P3.3 addition, the
 * `PUT /w/:slug/artifacts/:path` edit-save route). Same shape as
 * registry/workspace-index.ts's `persist()` and bus/inbox.ts's publish step — write a sibling
 * temp file in the SAME directory (so the rename is guaranteed same-filesystem, hence atomic on
 * POSIX), fsync its contents, rename over the existing file, then fsync the containing directory
 * so the rename itself is durable. This never creates a NEW artifact — callers only invoke it
 * once `rawPath` has already been proven to be a currently-tracked artifact's real on-disk path. */
export function writeArtifactAtomic(rawPath: string, content: string): Buffer {
  const dir = dirname(rawPath);
  const tmpPath = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const bytes = Buffer.from(content, "utf8");
  const fd = openSync(tmpPath, "w");
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, rawPath); // atomic on POSIX — replaces the existing file in one step
  fsyncContainingDir(rawPath);
  // The exact bytes that landed, so the caller can check the file still holds them before it
  // attributes anything to whoever asked for this write (issue #155, `captureHumanEdit`).
  return bytes;
}

/** The class-R/class-F split (A1 §5.3/§5.4/§7) by extension. One place so `GET /w/:slug/artifacts`
 * (P3.1), `GET /w/:slug/artifacts/:path` (P3.1), and the SSE snapshot/artifact-change push (P3.2)
 * never independently redefine what "class F" means. */
export function classifyArtifactPath(path: string): "R" | "F" {
  return path.endsWith(".html") ? "F" : "R";
}
