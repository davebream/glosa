// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverableEntry } from "../../src/agent-provider/interface.ts";
import { AdapterRegistry } from "../../src/adapters/interface.ts";
import { WorkspaceMetadataRegistry } from "../../src/adapters/workspace-metadata.ts";
import { sourceSha256 } from "../../src/artifact-render.ts";
import type { WorkspaceBus } from "../../src/bus/bus.ts";
import { inboxEntryPath, journalPath } from "../../src/bus/paths.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { buildDeliveryPresentation, MAX_ENTRY_PRESENTATION_BYTES, utf8Bytes } from "../../src/delivery/presentation.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { type WorkspaceEntry, WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { type ArtifactAccessDependencies, actionablePresentation } from "../../src/services/artifact.ts";

function annotation(body: string) {
  return {
    kind: "annotation",
    artifact_path: "drafts/week.md",
    body,
    intent: "content",
    target: {
      chunk_id: "chunk-4",
      quote: { exact: "grace upon grace", prefix: "received ", suffix: " from him" },
      position: { start: 140, end: 156 },
    },
  };
}

describe("actionable inbox presentations", () => {
  test("conversation messages expose exact text, UTF-8 byte count, client ID, and target without truncation", () => {
    const message = "Sprawdź 🙂 dokładnie.";
    const result = buildDeliveryPresentation(
      "123e4567-e89b-42d3-a456-426614174000",
      {
        kind: "conversation_message",
        text: message,
        target_session_id: "session-exact",
        provider: "claude-code",
      },
      { status: "pending" },
    );
    expect(result).toMatchObject({
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "conversation_message",
      message,
      message_bytes: Buffer.byteLength(message, "utf8"),
      target_session_id: "session-exact",
      provider: "claude-code",
      truncation: { truncated: false },
    });
  });

  test("annotation includes identity, path, comment, intent, selectors, and source-range resolution", () => {
    const result = buildDeliveryPresentation("inb-a", annotation("Make the connection explicit."), {
      status: "pending",
      resolution: {
        kind: "source_range",
        path: "drafts/week.md",
        start_line: 4,
        end_line: 4,
        start_col: 12,
        end_col: 28,
        matched_quote: "grace upon grace",
        confidence: "exact",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.text).toContain("glosa annotation inb-a");
    expect(result?.text).toContain("artifact: drafts/week.md");
    expect(result?.text).toContain("Make the connection explicit.");
    expect(result?.text).toContain("intent: content");
    expect(result?.text).toContain('"exact":"grace upon grace"');
    expect(result?.text).toContain('"start":140');
    expect(result?.text).toContain('"kind":"source_range"');
  });

  test("annotation preserves pipeline-feedback and orphaned resolution detail", () => {
    const pipeline = buildDeliveryPresentation("inb-p", annotation("Check this output."), {
      status: "pending",
      resolution: {
        kind: "pipeline_feedback",
        target: { adapter: "pipeline", component: "chunk", chunk_id: "chunk-4", source_line_range: [4, 4] },
        intent: "content",
        body: "Check this output.",
      },
    });
    const orphaned = buildDeliveryPresentation("inb-o", annotation("The source moved."), {
      status: "pending",
      resolution: { kind: "orphaned", reason: "hash_mismatch_no_match" },
    });
    expect(pipeline?.text).toContain('"kind":"pipeline_feedback"');
    expect(orphaned?.text).toContain('"reason":"hash_mismatch_no_match"');
  });

  test("a passage address rides on its own line right after the quote and in the detail, and only with a source range", () => {
    const range = {
      kind: "source_range" as const,
      path: "drafts/week.md",
      start_line: 4,
      end_line: 4,
      start_col: 12,
      end_col: 28,
      matched_quote: "grace upon grace",
      confidence: "exact" as const,
    };
    const resolved = buildDeliveryPresentation("inb-a", annotation("Make the connection explicit."), {
      status: "pending",
      resolution: range,
      address: "§2.3",
    });
    const lines = (resolved?.text ?? "").split("\n");
    const quoteAt = lines.findIndex((line) => line.startsWith("quote: "));
    expect(quoteAt).toBeGreaterThan(0);
    expect(lines[quoteAt + 1]).toStartWith("address: §2.3 (");
    // The text says what the label is, so a session does not mistake it for the anchor.
    expect(lines[quoteAt + 1]).toContain("as it stands now");
    expect(lines[quoteAt + 1]).toContain("the quote is the anchor");
    expect(resolved?.detail?.address).toBe("§2.3");

    // A label for a block the note does not resolve to would be a guess: an orphaned note drops it.
    const orphaned = buildDeliveryPresentation("inb-o", annotation("The source moved."), {
      status: "pending",
      resolution: { kind: "orphaned", reason: "hash_mismatch_no_match" },
      address: "§2.3",
    });
    expect(orphaned?.text).not.toMatch(/^address:/m);
    expect(orphaned?.detail).not.toHaveProperty("address");
  });

  test("the address is reserved before the comment is sized: a comment at the cap gives up exactly the address line", () => {
    const range = {
      kind: "source_range" as const,
      path: "drafts/week.md",
      start_line: 4,
      end_line: 4,
      matched_quote: "grace upon grace",
      confidence: "exact" as const,
    };
    const long = annotation("a".repeat(MAX_ENTRY_PRESENTATION_BYTES));
    const without = buildDeliveryPresentation("inb-cap", long, { status: "pending", resolution: range });
    const withAddress = buildDeliveryPresentation("inb-cap", long, {
      status: "pending",
      resolution: range,
      address: "§2.3",
    });
    const line = (withAddress?.text ?? "").split("\n").find((text) => text.startsWith("address: "));
    expect(line).toStartWith("address: §2.3 (");
    expect(withAddress?.truncation?.truncated).toBe(true);
    // The comment, not the address, pays for the line and its line break, byte for byte.
    const bodyBytes = (entry: typeof without) => utf8Bytes(String(entry?.detail?.body ?? ""));
    expect(bodyBytes(without) - bodyBytes(withAddress)).toBe(utf8Bytes(`${line}\n`));
    expect(withAddress?.bytes).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
  });

  test("every annotation tells the agent how to take the apply-lease and resolve the entry", () => {
    // A4 §F05's lease is the only thing that can attribute a change to a session, and the only
    // thing that leaves a `pre_apply` checkpoint for the human to roll back to. Both commands
    // shipped and were tested, but nothing told the agent they existed — so no lease was ever
    // taken, annotations stayed `pending` however faithfully they were acted on, and every edit
    // was attributed `unknown`. The instruction is the half that was missing.
    const result = buildDeliveryPresentation("inb-a", annotation("Tighten this."), { status: "pending" });
    const text = result?.text ?? "";
    expect(text).toContain("glosa apply-begin inb-a --session");
    expect(text).toContain("glosa resolve inb-a applied --session");
    // Both commands default to the caller's cwd, which is not necessarily this entry's workspace
    // — an agent reviewing documents outside its own repo would otherwise act on the wrong one.
    expect(text).toContain("--workspace");
    // The other verdicts are named too, so "I am not doing this" has an honest terminal state
    // instead of an entry left open forever.
    expect(text).toContain("rejected");
    expect(text).toContain("deferred");
    // And it stays inside the entry budget rather than being appended past it.
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
  });

  test("UTF-8 truncation is byte-exact and gives stable CLI/MCP continuation instructions", () => {
    const result = buildDeliveryPresentation("inb-u", annotation("żółć🙂".repeat(10_000)), { status: "pending" });
    expect(result).not.toBeNull();
    expect(utf8Bytes(result?.text ?? "")).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
    expect(result?.truncation?.truncated).toBe(true);
    expect(result?.retrieval?.cursor).toBeString();
    expect(result?.text).toContain("glosa inbox get inb-u --cursor");
    expect(result?.text).toContain("MCP glosa_inbox_get");

    const next = buildDeliveryPresentation("inb-u", annotation("żółć🙂".repeat(10_000)), {
      status: "pending",
      cursor: result?.retrieval?.cursor,
    });
    expect(next?.detail?.body).not.toBe(result?.detail?.body);
  });

  test("human edit includes checkpoints and only complete bounded hunks, never artifact bodies", () => {
    const secretFullBody = "FULL_ARTIFACT_BODY_MUST_NOT_APPEAR";
    const hunks = Array.from(
      { length: 80 },
      (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n-old ${i}\n+new ${i} ${"ą".repeat(400)}\n`,
    ).join("");
    const result = buildDeliveryPresentation(
      "inb-edit",
      {
        kind: "human_edit",
        checkpoint_before: "abc123",
        checkpoint_after: "def456",
        artifact_body: secretFullBody,
        files: [
          { path: "notes.md", diff: `diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n${hunks}` },
        ],
      },
      { status: "pending" },
    );
    expect(result?.text).toContain("checkpoints: abc123..def456");
    expect(result?.text).toContain("file: notes.md");
    expect(result?.text).not.toContain(secretFullBody);
    expect(utf8Bytes(result?.text ?? "")).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
    expect(result?.truncation?.omitted_hunks).toBeGreaterThan(0);
    expect(((result?.text ?? "").match(/^@@ /gm) ?? []).length).toBe(
      (result?.detail?.files as unknown[] | undefined)?.length ?? -1,
    );
  });

  function externalEdit() {
    return {
      kind: "external_edit",
      path: "draft.md",
      diff: "diff --git a/draft.md b/draft.md\n--- a/draft.md\n+++ b/draft.md\n@@ -1 +1,2 @@\n one\n+two",
      since_checkpoint: "a".repeat(40),
      until_checkpoint: "b".repeat(40),
      observed_at: "2026-09-16T00:00:00.000Z",
      source: "live",
    };
  }

  test("external_edit (#153 Part 2 D10): ordinary retrieval says 'a record, not a request'; a watch says the session asked to watch, and nobody else was nudged", () => {
    const ordinary = buildDeliveryPresentation("inb-ext-1", externalEdit(), { status: "pending" });
    expect(ordinary?.text).toContain("this is a record, not a");
    expect(ordinary?.text).toContain("request; `glosa inbox dismiss inb-ext-1` closes it.");
    expect(ordinary?.text).not.toContain("glosa_watch");

    const watched = buildDeliveryPresentation("inb-ext-1", externalEdit(), { status: "pending", watched: true });
    expect(watched?.text).toContain("this is a record, not a");
    expect(watched?.text).toContain("session explicitly called glosa_watch — nobody");
    expect(watched?.text).toContain("else was nudged by it");
    expect(watched?.text).toContain("`glosa inbox dismiss inb-ext-1` closes it.");
    // Same underlying facts either way — only the framing sentence differs.
    expect(watched?.detail).toEqual(ordinary?.detail);
  });
});

/** A title, two sections and their paragraphs, with a `%%` comment the page never shows. The third
 * block under the second heading is §2.3: a lone leading h1 is the title (§0), so `##` numbers the
 * sections. */
const DRAFT = [
  "# The Title",
  "",
  "An opening paragraph.",
  "",
  "## First",
  "",
  "One.",
  "",
  "Two.",
  "",
  "## Second",
  "",
  "Alpha paragraph.",
  "",
  "Beta paragraph.",
  "",
  "The third block under the second heading.",
  "",
  "%%",
  "A private comment.",
  "%%",
  "",
  "Tail paragraph.",
  "",
].join("\n");
const THIRD = "The third block under the second heading.";

describe("a delivered note names its passage as the document stands at delivery (#411)", () => {
  let home: string;
  let root: string;
  let buses: WorkspaceBusRegistry;
  let workspace: WorkspaceEntry;
  let bus: WorkspaceBus;
  let deps: ArtifactAccessDependencies;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-address-delivery-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-address-delivery-ws-")));
    writeFileSync(join(root, "draft.md"), DRAFT);
    const workspaceIndex = new WorkspaceIndex({ home });
    buses = new WorkspaceBusRegistry();
    workspace = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    bus = buses.get(workspace);
    deps = { workspaceIndex, getWorkspaceBus: (target) => buses.get(target) };
  });

  afterEach(async () => {
    await buses.close(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function note(exact: string, body = "Tighten this.", artifactPath = "draft.md", chunk?: string) {
    return {
      kind: "annotation",
      artifact_path: artifactPath,
      body,
      intent: "content",
      target: { ...(chunk ? { chunk_id: chunk } : {}), quote: { exact, prefix: "", suffix: "" } },
    };
  }

  /** One real delivery transaction, the one every HTTP delivery runs: the bus prepares the entry
   * through the resolving builder, then the transport's outcome is acknowledged into the journal. */
  async function deliver(id: string, outcome: "presented" | "failed"): Promise<DeliverableEntry> {
    const prepared = await bus.prepareDelivery(
      8,
      { via: "mcp_pull", session: "session-411", entryId: id },
      (entryId, payload, status, { claims }) =>
        actionablePresentation(deps, workspace, entryId, payload, status, undefined, { claims }),
    );
    expect(prepared.drained.map((entry) => entry.id)).toEqual([id]);
    expect(await bus.acknowledgeDelivery(prepared.delivery_id!, outcome)).toBe(true);
    return prepared.drained[0]!;
  }

  const addressLine = (entry: DeliverableEntry) => entry.text.split("\n").find((line) => line.startsWith("address: "));

  test("a note on the third block under the second heading is §2.3, then §2.4 once a paragraph is inserted above it, and nothing stores either", async () => {
    await bus.createEntry("inb-411-a", note(THIRD));
    const stored = readFileSync(inboxEntryPath(workspace, "inb-411-a"));

    const first = await deliver("inb-411-a", "failed");
    expect(addressLine(first)).toStartWith("address: §2.3 (");
    expect(first.detail.address).toBe("§2.3");
    // Beside the quote, which stays the anchor.
    expect(first.text).toContain(`quote: {"exact":"${THIRD}"`);
    expect(first.detail.resolution).toMatchObject({ kind: "source_range", confidence: "exact" });

    writeFileSync(join(root, "draft.md"), DRAFT.replace("Beta paragraph.\n", "Beta paragraph.\n\nInserted above.\n"));
    const second = await deliver("inb-411-a", "presented");
    expect(addressLine(second)).toStartWith("address: §2.4 (");
    expect(second.detail.address).toBe("§2.4");

    // The label is derived at delivery and kept nowhere: the immutable entry is byte-identical, and
    // the journal holds both delivery attempts without a label in either.
    expect(readFileSync(inboxEntryPath(workspace, "inb-411-a")).equals(stored)).toBe(true);
    const journal = readFileSync(journalPath(workspace), "utf8");
    expect(journal.match(/"event":"delivery_attempt"/g)).toHaveLength(2);
    expect(journal).not.toContain("§");
  });

  test("no address when there is none to give: an orphaned note, a note inside a comment the page hides, a note on an HTML document", async () => {
    await bus.createEntry("inb-411-orphan", note("Words that were never in the document."));
    const orphan = await deliver("inb-411-orphan", "presented");
    expect(orphan.detail.resolution).toMatchObject({ kind: "orphaned" });
    expect(addressLine(orphan)).toBeUndefined();
    expect(orphan.detail).not.toHaveProperty("address");

    // The words resolve, but to a `%%` comment: the page shows no block there, so it has no label.
    await bus.createEntry("inb-411-comment", note("A private comment."));
    const comment = await deliver("inb-411-comment", "presented");
    expect(comment.detail.resolution).toMatchObject({ kind: "source_range" });
    expect(addressLine(comment)).toBeUndefined();

    // Class F: an HTML page whose manifest maps the note into draft.md. The note resolves to a
    // source range in Markdown, yet the page it was written on numbers no blocks.
    const lastLine = DRAFT.split("\n").length - 1;
    const hash = sourceSha256(Buffer.from(DRAFT));
    writeFileSync(join(root, "page.html"), `<p data-chunk="chunk-1">${THIRD}</p>`);
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        manifest_version: 1,
        source_path: "draft.md",
        source_sha256: hash,
        chunks: [{ chunk_id: "chunk-1", source_start_line: 0, source_end_line: lastLine, source_sha256: hash }],
      }),
    );
    const metadata = new WorkspaceMetadataRegistry();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(metadata.adapter());
    await metadata.set(root, {
      version: 1,
      id: "fixture-renderer",
      artifacts: [
        { path: "draft.md", class: "R", order: 0 },
        {
          path: "page.html",
          class: "F",
          order: 1,
          derived_from: { path: "draft.md", via: "render" },
          manifest: { path: "manifest.json", component: "read" },
        },
      ],
    });
    deps = { ...deps, adapterRegistry };
    await bus.createEntry("inb-411-html", note(THIRD, "Tighten this.", "page.html", "chunk-1"));
    const html = await deliver("inb-411-html", "presented");
    expect(html.detail.resolution).toMatchObject({ kind: "source_range", path: "draft.md" });
    expect(addressLine(html)).toBeUndefined();
    expect(html.detail).not.toHaveProperty("address");
  });

  test("a quote that ends on its line break names the block it was taken from, not the heading on the next line", async () => {
    // A selection can run to the end of its block and take the line break with it. The match then
    // ends at column 0 of the next line, and here that line is a heading, which the page does not
    // count as part of the passage: its range ends in the whitespace between the two elements.
    writeFileSync(join(root, "draft.md"), "## One\n\nLast words of one.\n## Two\n\nMore.\n");
    await bus.createEntry("inb-411-break", note("Last words of one.\n"));
    const broken = await deliver("inb-411-break", "presented");
    expect(broken.detail.resolution).toMatchObject({ kind: "source_range", end_col: 0 });
    expect(addressLine(broken)).toStartWith("address: §1.1 (");
  });

  test("a comment past the byte cap truncates and the address survives inside the 16 KiB entry", async () => {
    await bus.createEntry("inb-411-long", note(THIRD, "ż".repeat(MAX_ENTRY_PRESENTATION_BYTES)));
    const long = await deliver("inb-411-long", "presented");
    expect(long.truncation.truncated).toBe(true);
    expect(addressLine(long)).toStartWith("address: §2.3 (");
    expect(long.bytes).toBe(utf8Bytes(long.text));
    expect(long.bytes).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
  });
});
