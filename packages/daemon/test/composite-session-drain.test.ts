// SPDX-License-Identifier: Apache-2.0
// W34 — real-route coverage for R2's inverse direction: one unbound ancestor session may be
// routable from several registered workspace journals, so a turn-boundary drain must combine
// them without guessing one workspace or inventing a durable authority outside the journals.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBus } from "../src/bus/bus.ts";
import { journalPath } from "../src/bus/paths.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { CapabilityStore } from "../src/capability.ts";
import { CompositeDeliveryRegistry } from "../src/delivery/composite-reservations.ts";
import { MAX_BATCH_PRESENTATION_BYTES, MAX_ENTRY_PRESENTATION_BYTES } from "../src/delivery/presentation.ts";
import { createApiFetch, type ApiContext } from "../src/http.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { type WorkspaceEntry, WorkspaceIndex } from "../src/registry/workspace-index.ts";

const TOKEN = "composite-session-drain-token-0123456789";
const PORT = 4646;

function annotation(body: string) {
  return {
    kind: "annotation",
    artifact_path: "notes.md",
    body,
    intent: "content",
    target: { quote: { exact: "sentence" }, position: { start: 0, end: 8 } },
  };
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

describe("composite cwd-ancestor session drain (R2/W34)", () => {
  let home: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let ctx: ApiContext;
  let fetchFn: ReturnType<typeof createApiFetch>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-composite-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-composite-root-")));
    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((path) => sessionRegistry.forWorkspace(path).length > 0);
    ctx = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "gl-composite-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (workspace) => busRegistry.get(workspace),
      capabilityStore: new CapabilityStore(),
    };
    fetchFn = createApiFetch(ctx);
  });

  afterEach(async () => {
    await busRegistry.closeAll();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function req(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    headers.set("Origin", `http://127.0.0.1:${PORT}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }

  async function registerSession(workspaceBinding?: string): Promise<void> {
    const response = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({
          session_id: "session-root",
          provider: "claude-code",
          cwd: root,
          source: "startup",
          ...(workspaceBinding ? { workspace_binding: workspaceBinding } : {}),
        }),
      }),
    );
    expect(response.status).toBe(200);
  }

  async function restartDaemon(): Promise<void> {
    await busRegistry.closeAll();
    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((path) => sessionRegistry.forWorkspace(path).length > 0);
    ctx = {
      ...ctx,
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (workspace) => busRegistry.get(workspace),
    };
    fetchFn = createApiFetch(ctx);
    await registerSession();
  }

  async function child(name: string, at: string | (() => Date)): Promise<{ entry: WorkspaceEntry; bus: WorkspaceBus }> {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const entry = await workspaceIndex.upsertWorkspace(path, "glosa-open");
    const bus = busRegistry.get(entry, { now: typeof at === "string" ? () => new Date(at) : at });
    return { entry, bus };
  }

  async function drain() {
    return fetchFn(
      req("/api/sessions/session-root/drain", {
        method: "POST",
        body: JSON.stringify({ via: "stop" }),
      }),
    );
  }

  async function acknowledge(deliveryId: string, outcome: "presented" | "failed" = "presented") {
    return fetchFn(
      req(`/api/sessions/session-root/deliveries/${deliveryId}/ack`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      }),
    );
  }

  function damageCreatedAt(workspace: WorkspaceEntry, id: string): void {
    const path = journalPath(workspace);
    const damaged = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => {
        if (line.length === 0) return line;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.event === "entry_created" && event.entry === id) event.at = { damaged: true };
        return JSON.stringify(event);
      })
      .join("\n");
    writeFileSync(path, damaged);
  }

  test("an unbound ancestor combines every routable present workspace, globally oldest first, with byte-stable ties and workspace labels", async () => {
    const first = await child("first", "2026-01-01T00:00:00.000Z");
    const second = await child("second", "2026-01-01T00:00:00.000Z");
    const rootBus = busRegistry.get(root, { now: () => new Date("2026-01-02T00:00:00.000Z") });
    await first.bus.createEntry("for-another-session", {
      kind: "conversation_message",
      text: "do not leak",
      target_session_id: "another-session",
      provider: "claude-code",
    });
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await rootBus.createEntry("root-entry", annotation("root"));
    await registerSession();

    const response = await drain();
    expect(response.status).toBe(200);
    const body = await response.json();
    const tied = [first.entry, second.entry].sort((a, b) => compareUtf8(a.registration_id, b.registration_id));
    const expectedByWorkspace = new Map([
      [first.entry.canonical_path, "first-entry"],
      [second.entry.canonical_path, "second-entry"],
    ]);
    expect(body.drained.map((item: { id: string }) => item.id)).toEqual([
      ...tied.map((entry) => expectedByWorkspace.get(entry.canonical_path)),
      "root-entry",
    ]);
    expect(body.drained.map((item: { workspace: string }) => item.workspace)).toEqual([
      ...tied.map((entry) => entry.canonical_path),
      root,
    ]);
    for (const item of body.drained as Array<{ workspace: string; text: string; bytes: number }>) {
      expect(item.text).toStartWith(`workspace: ${item.workspace}\n`);
      expect(item.bytes).toBe(Buffer.byteLength(item.text, "utf8"));
    }
    expect(body.drained.some((item: { id: string }) => item.id === "for-another-session")).toBe(false);
    expect(body.delivery_id).toStartWith("cmp_");
  });

  test("non-string durable timestamps take the deterministic fallback instead of crashing the drain", async () => {
    const first = await child("damaged-first", "2026-01-01T00:00:00.000Z");
    const second = await child("damaged-second", "2026-01-01T00:00:00.000Z");
    await first.bus.createEntry("z-created-first", annotation("first"));
    await first.bus.createEntry("a-created-second", annotation("second in same workspace"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();

    // Resolve both buses once so the route's next access uses their live in-memory fold. The
    // damage targets only the read-only ordering peek; W28 owns full replay validation.
    expect((await fetchFn(req(`/w/${first.entry.slug}/inbox/z-created-first/presentation`))).status).toBe(200);
    expect((await fetchFn(req(`/w/${second.entry.slug}/inbox/second-entry/presentation`))).status).toBe(200);
    damageCreatedAt(first.entry, "z-created-first");
    damageCreatedAt(first.entry, "a-created-second");
    damageCreatedAt(second.entry, "second-entry");

    const response = await drain();
    expect(response.status).toBe(200);
    const body = await response.json();
    const tied = [first.entry, second.entry].sort((a, b) => compareUtf8(a.registration_id, b.registration_id));
    const expected = tied.flatMap((entry) =>
      entry.canonical_path === first.entry.canonical_path ? ["z-created-first", "a-created-second"] : ["second-entry"],
    );
    expect(body.drained.map((item: { id: string }) => item.id)).toEqual(expected);
  });

  test("the aggregate count and UTF-8 batch caps apply globally, not once per workspace", async () => {
    let firstAt = "2026-01-01T00:00:00.000Z";
    const first = await child("cap-first", () => new Date(firstAt));
    const second = await child("cap-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-0", annotation(`0:${"ż".repeat(5_000)}`));
    firstAt = "2026-01-03T00:00:00.000Z";
    for (let i = 1; i < 5; i++) await first.bus.createEntry(`first-${i}`, annotation(`${i}:${"ż".repeat(5_000)}`));
    for (let i = 0; i < 5; i++) await second.bus.createEntry(`second-${i}`, annotation(`${i}:${"ż".repeat(5_000)}`));
    await registerSession();

    const body = await (await drain()).json();
    const serialized = body.drained.map((item: { text: string }) => item.text).join("\n\n---\n\n");
    expect(body.count).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_BATCH_PRESENTATION_BYTES);
    expect(body.count).toBeGreaterThan(1);
    expect(new Set(body.drained.map((item: { workspace: string }) => item.workspace)).size).toBeGreaterThan(1);
    expect(body.has_more).toBe(true);
    const next = await (await drain()).json();
    const firstIds = new Set(body.drained.map((item: { id: string }) => item.id));
    expect(next.count).toBeGreaterThan(0);
    expect(next.drained.some((item: { id: string }) => firstIds.has(item.id))).toBe(false);
  });

  test("the canonical workspace label consumes the existing per-entry UTF-8 budget", async () => {
    const labelled = await child("ż-workspace", "2026-01-01T00:00:00.000Z");
    await labelled.bus.createEntry("large-entry", annotation("ż".repeat(20_000)));
    await registerSession();

    const response = await drain();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBe(1);
    const item = body.drained[0] as {
      workspace: string;
      text: string;
      bytes: number;
      truncation: { truncated: boolean };
    };
    expect(item.workspace).toBe(labelled.entry.canonical_path);
    expect(item.text).toStartWith(`workspace: ${labelled.entry.canonical_path}\n`);
    expect(item.bytes).toBe(Buffer.byteLength(item.text, "utf8"));
    expect(item.bytes).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
    expect(item.truncation.truncated).toBe(true);
  });

  test("an explicit binding remains isolated to exactly one workspace", async () => {
    const bound = await child("bound", "2026-01-02T00:00:00.000Z");
    const sibling = await child("sibling", "2026-01-01T00:00:00.000Z");
    await bound.bus.createEntry("bound-entry", annotation("bound"));
    await sibling.bus.createEntry("sibling-entry", annotation("sibling"));
    await busRegistry.get(root).createEntry("root-entry", annotation("root"));
    await registerSession(bound.entry.canonical_path);

    const body = await (await drain()).json();
    expect(body.drained.map((item: { id: string }) => item.id)).toEqual(["bound-entry"]);
    expect(body.drained[0].workspace).toBe(bound.entry.canonical_path);
    expect(body.delivery_id).not.toStartWith("cmp_");
  });

  test("a constituent preparation failure releases every earlier reservation and returns no partial batch", async () => {
    const first = await child("prepare-first", "2026-01-01T00:00:00.000Z");
    const second = await child("prepare-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const failure = new Error("forced second-workspace prepare failure");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const prepareSpy = spyOn(second.bus, "prepareDelivery").mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      expect((await drain()).status).toBe(500);
      prepareSpy.mockRestore();
      const retry = await drain();
      expect(retry.status).toBe(200);
      expect((await retry.json()).drained.map((item: { id: string }) => item.id)).toEqual([
        "first-entry",
        "second-entry",
      ]);
    } finally {
      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("composite-token allocation failure releases every constituent reservation", async () => {
    const first = await child("token-first", "2026-01-01T00:00:00.000Z");
    const second = await child("token-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    ctx.compositeDeliveryRegistry = new CompositeDeliveryRegistry({
      id: () => {
        throw new Error("forced composite-token allocation failure");
      },
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect((await drain()).status).toBe(500);
      ctx.compositeDeliveryRegistry = new CompositeDeliveryRegistry();
      const retry = await drain();
      expect(retry.status).toBe(200);
      expect((await retry.json()).drained.map((item: { id: string }) => item.id)).toEqual([
        "first-entry",
        "second-entry",
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a plan-to-reserve contender causes rollback instead of silently substituting the next entry", async () => {
    const childWorkspace = await child("contended", "2026-01-01T00:00:00.000Z");
    await childWorkspace.bus.createEntry("planned-first", annotation("first"));
    await childWorkspace.bus.createEntry("must-not-substitute", annotation("second"));
    await registerSession();
    const originalPreview = childWorkspace.bus.previewDelivery.bind(childWorkspace.bus);
    let contenderDeliveryId: string | null = null;
    const previewSpy = spyOn(childWorkspace.bus, "previewDelivery").mockImplementationOnce(async (...args) => {
      const plan = await originalPreview(...args);
      const contender = await childWorkspace.bus.prepareDelivery(
        1,
        { via: "stop", session: "session-root", entryId: "planned-first" },
        (id, _payload, status) => {
          const planned = plan.entries.find((item) => item.id === id)?.presentation;
          return planned ? { ...planned, status } : null;
        },
      );
      contenderDeliveryId = contender.delivery_id;
      return plan;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect((await drain()).status).toBe(500);
      expect(childWorkspace.bus.state.entries["must-not-substitute"]?.deliveryAttempts).toHaveLength(0);
      expect(contenderDeliveryId).not.toBeNull();
      if (!contenderDeliveryId) throw new Error("contender did not reserve the planned entry");
      await childWorkspace.bus.cancelDelivery(contenderDeliveryId);
      previewSpy.mockRestore();
      const retry = await (await drain()).json();
      expect(retry.drained.map((item: { id: string }) => item.id)).toEqual(["planned-first", "must-not-substitute"]);
    } finally {
      previewSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("a composite ack reports success only after every journal append and retries a failed suffix without duplicating its completed prefix", async () => {
    const first = await child("ack-first", "2026-01-01T00:00:00.000Z");
    const second = await child("ack-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const ackSpy = spyOn(second.bus, "acknowledgeDelivery").mockImplementationOnce(async () => {
      throw new Error("forced ack suffix failure");
    });

    try {
      expect((await acknowledge(prepared.delivery_id)).status).toBe(500);
      expect(first.bus.state.entries["first-entry"]?.deliveryAttempts).toHaveLength(1);
      expect(second.bus.state.entries["second-entry"]?.deliveryAttempts).toHaveLength(0);
      expect((await acknowledge(prepared.delivery_id, "failed")).status).toBe(409);
      expect((await acknowledge(prepared.delivery_id)).status).toBe(200);
      expect(first.bus.state.entries["first-entry"]?.deliveryAttempts).toHaveLength(1);
      expect(second.bus.state.entries["second-entry"]?.deliveryAttempts).toHaveLength(1);
    } finally {
      ackSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("concurrent acknowledgements of one token cannot cancel an in-flight suffix", async () => {
    const first = await child("ack-race-first", "2026-01-01T00:00:00.000Z");
    const second = await child("ack-race-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();

    const originalAck = first.bus.acknowledgeDelivery.bind(first.bus);
    let acknowledgeCalls = 0;
    let signalFirstConsumed!: () => void;
    const firstConsumed = new Promise<void>((resolve) => {
      signalFirstConsumed = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayReturn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ackSpy = spyOn(first.bus, "acknowledgeDelivery").mockImplementation(async (...args) => {
      acknowledgeCalls += 1;
      const result = await originalAck(...args);
      if (acknowledgeCalls === 1) {
        signalFirstConsumed();
        await firstMayReturn;
      }
      return result;
    });

    try {
      const firstRequest = acknowledge(prepared.delivery_id);
      await firstConsumed;
      const duplicateRequest = acknowledge(prepared.delivery_id);
      // Give an unserialized duplicate one turn to consume the first child and cancel the suffix.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseFirst();
      const statuses = (await Promise.all([firstRequest, duplicateRequest])).map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(first.bus.state.entries["first-entry"]?.deliveryAttempts).toHaveLength(1);
      expect(second.bus.state.entries["second-entry"]?.deliveryAttempts).toHaveLength(1);
    } finally {
      releaseFirst();
      ackSpy.mockRestore();
    }
  });

  test("ordinary coordinator activity prunes expired composites and releases only their unacknowledged suffix", async () => {
    let coordinatorNow = 0;
    const ids = ["fixed-token", "fixed-token", "replacement-token"];
    let nextId = 0;
    ctx.compositeDeliveryRegistry = new CompositeDeliveryRegistry({
      now: () => coordinatorNow,
      id: () => ids[nextId++]!,
    });
    const first = await child("expiry-first", "2026-01-01T00:00:00.000Z");
    const second = await child("expiry-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const ackSpy = spyOn(second.bus, "acknowledgeDelivery").mockImplementationOnce(async () => {
      throw new Error("forced suffix failure before composite expiry");
    });

    try {
      expect((await acknowledge(prepared.delivery_id)).status).toBe(500);
      ackSpy.mockRestore();
      const firstCancel = spyOn(first.bus, "cancelDelivery");
      const secondCancel = spyOn(second.bus, "cancelDelivery");
      try {
        coordinatorNow = 30_001;
        const reacquired = await (await drain()).json();
        expect(firstCancel).toHaveBeenCalledTimes(0);
        expect(secondCancel).toHaveBeenCalledTimes(1);
        expect(reacquired.drained.map((item: { id: string }) => item.id)).toEqual(["second-entry"]);
        // Reusing the deterministic id proves the expired map entry itself was deleted, not just
        // that its child token happened to be cancelled.
        expect(reacquired.delivery_id).toBe(prepared.delivery_id);
      } finally {
        firstCancel.mockRestore();
        secondCancel.mockRestore();
      }
    } finally {
      ackSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("lifecycle loss after a mid-ack prefix preserves that journal truth and redrains only the suffix", async () => {
    const first = await child("prefix-restart-first", "2026-01-01T00:00:00.000Z");
    const second = await child("prefix-restart-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const ackSpy = spyOn(second.bus, "acknowledgeDelivery").mockImplementationOnce(async () => {
      throw new Error("forced ack suffix failure before lifecycle loss");
    });

    try {
      expect((await acknowledge(prepared.delivery_id)).status).toBe(500);
      expect(first.bus.state.entries["first-entry"]?.deliveryAttempts).toHaveLength(1);
      expect(second.bus.state.entries["second-entry"]?.deliveryAttempts).toHaveLength(0);
    } finally {
      ackSpy.mockRestore();
      errorSpy.mockRestore();
    }

    await restartDaemon();

    expect((await acknowledge(prepared.delivery_id)).status).toBe(409);
    const retry = await (await drain()).json();
    expect(retry.drained.map((item: { id: string }) => item.id)).toEqual(["second-entry"]);
    expect((await acknowledge(retry.delivery_id)).status).toBe(200);

    const restartedFirst = busRegistry.get(workspaceIndex.get(first.entry.canonical_path)!);
    const restartedSecond = busRegistry.get(workspaceIndex.get(second.entry.canonical_path)!);
    expect(restartedFirst.state.entries["first-entry"]?.deliveryAttempts).toHaveLength(1);
    expect(restartedSecond.state.entries["second-entry"]?.deliveryAttempts).toHaveLength(1);
  });

  test("failed composite acknowledgement keeps all entries retryable", async () => {
    const first = await child("failed-first", "2026-01-01T00:00:00.000Z");
    const second = await child("failed-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();
    expect((await acknowledge(prepared.delivery_id, "failed")).status).toBe(200);
    const retry = await (await drain()).json();
    expect(retry.drained.map((item: { id: string }) => item.id)).toEqual(["first-entry", "second-entry"]);
  });

  test("daemon-lifecycle loss invalidates the composite token while journal truth makes unacknowledged entries drainable again", async () => {
    const first = await child("restart-first", "2026-01-01T00:00:00.000Z");
    const second = await child("restart-second", "2026-01-02T00:00:00.000Z");
    await first.bus.createEntry("first-entry", annotation("first"));
    await second.bus.createEntry("second-entry", annotation("second"));
    await registerSession();
    const prepared = await (await drain()).json();

    await restartDaemon();

    expect((await acknowledge(prepared.delivery_id)).status).toBe(409);
    const retry = await (await drain()).json();
    expect(retry.drained.map((item: { id: string }) => item.id)).toEqual(["first-entry", "second-entry"]);
  });
});
