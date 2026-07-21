// @glosa/daemon — class-R artifact content helpers for A1 §5.4: the canonical `source_sha256`
// formula (A5 §F10 — SHA256 of the raw bytes after `\r\n`→`\n` only, no markdown processing) and
// the markdown-it render pipeline that stamps `data-line` attributes onto every block-level token
// so the SPA can map a click in the rendered view back to a source line (A1 §5.4).
import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";

/** A5 §F10's fixed identity formula — shared here (artifact content responses) and by the later
 * anchoring resolver (F10/F11), so the two never compute "what is this source" two different
 * ways. Deliberately NOT full markdown processing — just the one normalization A5 §F10 names. */
export function sourceSha256(raw: Buffer): string {
  const normalized = raw.toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Stamps `data-line="<0-based source line>"` on every block-level token that carries a source
 * map (markdown-it's `token.map[0]`) — headings, paragraphs, list items, code fences, tables, etc.
 * Registered as a core rule (not per-renderer-rule overrides) so it applies uniformly across every
 * block type without this module having to enumerate them one by one. */
function dataLineStamp(md: MarkdownIt): void {
  md.core.ruler.push("glosa_data_line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.type.endsWith("_open")) {
        token.attrSet("data-line", String(token.map[0]));
      }
    }
  });
}

// One shared renderer instance — markdown-it's `.use()` mutates the instance, not per-call state,
// so building it once at module load and reusing it across requests is both correct and avoids
// re-registering the plugin on every render.
const renderer = new MarkdownIt({ html: false, linkify: false });
renderer.use(dataLineStamp);

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

/** The class-R/class-F split (A1 §5.3/§5.4/§7) by extension. One place so `GET /w/:slug/artifacts`
 * (P3.1), `GET /w/:slug/artifacts/:path` (P3.1), and the SSE snapshot/artifact-change push (P3.2)
 * never independently redefine what "class F" means. */
export function classifyArtifactPath(path: string): "R" | "F" {
  return path.endsWith(".html") ? "F" : "R";
}
