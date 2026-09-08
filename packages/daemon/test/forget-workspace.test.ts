// SPDX-License-Identifier: Apache-2.0
// glosa forget <slug> (issue #156) — the one supported whole-bus deletion primitive built on top
// of WorkspaceIndex.forget()'s pre-existing (guard-bypassing, file-untouched) registration
// removal. These tests exercise the layer above it: preflight refusal naming the blockers,
// all-or-nothing confinement before any destructive side effect, crash-resumable deletion across
// the target's own bus plus any historical sealed loose-file source adopted into it, and mutual
// exclusion with an in-flight adoption of the same target.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdoptionCoordinator, adoptLooseLineages } from "../src/adoption.ts";
import { WorkspaceBus, WorkspaceForgottenError } from "../src/bus/bus.ts";
import { writeInboxEntryOnce } from "../src/bus/inbox.ts";
import { APPLY_LEASE_TTL_MS, leaseHeldError } from "../src/bus/lease.ts";
import { journalPath } from "../src/bus/paths.ts";
import { reconcileWorkspace } from "../src/bus/reconcile.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { confineBusPathForDeletion, type ForgetDeps, forgetWorkspace } from "../src/registry/forget-workspace.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { registrationIdFor } from "../src/workspace.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir, manualClock } from "./registry/helpers.ts";

function buildDeps(
  index: WorkspaceIndex,
  sessionRegistry: SessionRegistry,
  busRegistry: WorkspaceBusRegistry,
  home: string,
  coordinator: AdoptionCoordinator = new AdoptionCoordinator(),
): ForgetDeps {
  return {
    workspaceIndex: index,
    sessionRegistry,
    home,
    getWorkspaceBus: (workspace) => busRegistry.get(workspace),
    adoptionCoordinator: coordinator,
  };
}

describe("glosa forget", () => {
  test("refuses live sessions and apply leases before side effects", async () => {
    const home = freshHome();
    const liveRoot = freshWorkspaceDir();
    const leaseRoot = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    // --- blocker 1: a live bound session -------------------------------------------------
    const liveEntry = await index.upsertWorkspace(liveRoot, "glosa-open");
    await sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: liveRoot,
      workspace_binding: liveRoot,
      source: "hook",
    });

    const liveResult = await forgetWorkspace(deps, liveEntry.slug, { confirm: false });
    expect(liveResult).toMatchObject({ ok: false, code: "blocked" });
    if (liveResult.ok || liveResult.code !== "blocked") throw new Error("unreachable");
    expect(liveResult.blockers).toEqual([{ kind: "live-session", session_id: "s1" }]);

    // No side effects: still resolvable, still active, bus untouched.
    expect(index.getBySlug(liveEntry.slug)?.lifecycle?.state ?? "active").toBe("active");
    expect(existsSync(liveEntry.bus_path)).toBe(false); // never opened — proves nothing was created either

    // --- blocker 2: an unexpired apply-lease ----------------------------------------------
    const leaseEntry = await index.upsertWorkspace(leaseRoot, "glosa-open");
    const leaseBus = busRegistry.get(leaseEntry);
    await leaseBus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await leaseBus.applyBegin("e1", "session-x");

    const leaseResult = await forgetWorkspace(deps, leaseEntry.slug, { confirm: false });
    expect(leaseResult).toMatchObject({ ok: false, code: "blocked" });
    if (leaseResult.ok || leaseResult.code !== "blocked") throw new Error("unreachable");
    expect(leaseResult.blockers).toEqual([{ kind: "apply-lease", lease_id: leaseId, expires_at: expect.any(String) }]);

    // A blocked confirm:true must ALSO refuse before touching anything — the refusal is not a
    // preview-only artifact.
    const leaseExecute = await forgetWorkspace(deps, leaseEntry.slug, { confirm: true });
    expect(leaseExecute).toMatchObject({ ok: false, code: "blocked" });
    expect(index.getBySlug(leaseEntry.slug)?.lifecycle?.state ?? "active").toBe("active");
    expect(existsSync(leaseEntry.bus_path)).toBe(true); // untouched, not deleted
    expect(leaseBus.state.forgetSeal).toBe(false); // never sealed either

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(liveRoot);
    cleanup(leaseRoot);
  });

  test("resumes each interrupted deletion phase and preserves work-tree bytes", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifactPath = join(root, "notes.md");
    const originalBytes = "keep me\n";
    writeFileSync(artifactPath, originalBytes);

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    const entry = await index.upsertWorkspace(root, "glosa-open");
    const bus = busRegistry.get(entry);
    await bus.reconcileOnce();
    await bus.createEntry("e1", { kind: "annotation" });
    expect(existsSync(entry.bus_path)).toBe(true);

    // --- phase A: crash recorded AFTER the durable "forgetting" marker, BEFORE any file was
    // deleted. Simulated by performing exactly that durable step by hand, then resuming through
    // the public entry point exactly as a restarted daemon handling a retried CLI call would. ---
    await index.markForgetting([entry.registration_id], entry.registration_id);
    expect(index.getBySlug(entry.slug)?.lifecycle?.state).toBe("forgetting");
    expect(existsSync(entry.bus_path)).toBe(true); // still there — the crash landed before deletion

    const resumed = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(resumed.removed.map((r) => r.registration_id)).toEqual([entry.registration_id]);
    expect(existsSync(entry.bus_path)).toBe(false);
    expect(index.getBySlug(entry.slug)).toBeNull();
    expect(readFileSync(artifactPath, "utf8")).toBe(originalBytes); // work-tree byte-for-byte intact

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resumes past a crash between deleting a sealed source's bus and the target's own, across a real adoption", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");

    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const sealedSource = index.getWorkspaceByRegistration(loose.entry.registration_id);
    expect(sealedSource?.lifecycle?.state).toBe("adopted");
    const target = index.getBySlug(directory.entry.slug)!;
    expect(index.sealedSourcesFor(target.registration_id).map((e) => e.registration_id)).toEqual([
      loose.entry.registration_id,
    ]);

    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);

    // Durable step done; simulate a crash that deleted the SOURCE bus (the loose file's own
    // `~/.glosa/state/<id>`) but not yet the target's `.glosa` — an arbitrary interruption point
    // between the two entries this forget must delete.
    await index.markForgetting([target.registration_id, loose.entry.registration_id], target.registration_id);
    rmSync(sealedSource!.bus_path, { recursive: true, force: true });
    expect(existsSync(sealedSource!.bus_path)).toBe(false);
    expect(existsSync(target.bus_path)).toBe(true);

    const resumed = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(new Set(resumed.removed.map((r) => r.registration_id))).toEqual(
      new Set([target.registration_id, loose.entry.registration_id]),
    );
    expect(existsSync(target.bus_path)).toBe(false);
    expect(index.getBySlug(directory.entry.slug)).toBeNull();
    expect(index.getWorkspaceByRegistration(loose.entry.registration_id)).toBeNull();
    // The work-tree file `forget` must never touch survives untouched throughout.
    expect(readFileSync(artifact, "utf8")).toBe("second\n");

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resumes when every source registration was already removed but the target's was not — the COMPLETE original set is still reported (issue #156 review finding 5)", async () => {
    // Regression for issue #156's crash-safety finding: registrations must be removed
    // sources-first, target-last, because the TARGET's slug is the only key a retried `glosa
    // forget <slug>` can still name. This simulates the boundary right after the last source
    // registration disappears but before the target's does — exactly what the sources-first
    // ordering produces, and the one crash point that must remain resumable by the target slug.
    // The independent review's finding 5 was that the OLD registry-only reconstruction
    // (`forgettingMembersFor`) silently dropped a member once its own registration was gone —
    // this asserts the fix: the durable `ForgetOperationRecord` snapshot, taken once before
    // anything is removed, is what the resumed call reports back, so the already-gone source is
    // still part of the "removed" output even though it can no longer be found in the registry.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");
    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);

    // Begin the durable operation exactly the way a real forget commit would — BEFORE either
    // member's bus or registration is touched — so its snapshot still remembers the source once
    // the source's own registration is gone.
    const operation = await index.beginForgetOperation(target, [target, source]);
    rmSync(target.bus_path, { recursive: true, force: true });
    rmSync(source.bus_path, { recursive: true, force: true });
    // Simulate the crash point: the source's registration is already gone, the target's is not.
    expect(await index.forget(source.slug)).toBe(true);
    expect(index.getWorkspaceByRegistration(source.registration_id)).toBeNull();
    expect(index.getBySlug(target.slug)).not.toBeNull(); // the resume key still resolves
    expect(index.activeForgetOperationForTarget(target.registration_id)?.operation_id).toBe(operation.operation_id);

    const resumed = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(new Set(resumed.removed.map((r) => r.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );
    expect(index.getBySlug(target.slug)).toBeNull();
    expect(readFileSync(artifact, "utf8")).toBe("second\n");

    // Idempotent completion receipt: a retry against either the target's original slug or the
    // already-gone source's own slug still returns the complete removal list, never a 404.
    const retryByTarget = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(retryByTarget).toMatchObject({ ok: true, confirmed: true });
    if (!retryByTarget.ok || !retryByTarget.confirmed) throw new Error("unreachable");
    expect(new Set(retryByTarget.removed.map((r) => r.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );
    const retryBySource = await forgetWorkspace(deps, source.slug, { confirm: false });
    expect(retryBySource).toMatchObject({ ok: true, confirmed: true });

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("preview (confirm:false) names the exact paths and never mutates anything", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await index.upsertWorkspace(root, "glosa-open");
    mkdirSync(entry.bus_path, { recursive: true });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), "");

    const deps = buildDeps(index, sessionRegistry, busRegistry, home);
    const preview = await forgetWorkspace(deps, entry.slug, { confirm: false });
    expect(preview).toMatchObject({ ok: true, confirmed: false });
    if (!preview.ok || preview.confirmed) throw new Error("unreachable");
    expect(preview.entries).toEqual([
      {
        registration_id: entry.registration_id,
        slug: entry.slug,
        canonical_path: entry.canonical_path,
        kind: "directory",
        bus_path: entry.bus_path,
      },
    ]);

    // Still fully present and untouched — a preview never even calls `getWorkspaceBus`.
    expect(index.getBySlug(entry.slug)?.lifecycle?.state ?? "active").toBe("active");
    expect(existsSync(entry.bus_path)).toBe(true);
    expect(busRegistry.has(entry)).toBe(false);
    cleanup(home);
    cleanup(root);
  });

  test("confinement refuses a bus path that does not resolve to the local or redirected shape", async () => {
    // This is the critical guard issue #156 calls out for ablation evidence: "confinement must be
    // proven before the first destructive side effect". Exercised directly against a synthetic
    // corrupted/foreign entry (no real WorkspaceIndex needed) — a `bus_path` pointing at neither
    // of the two shapes the index itself ever constructs (`<worktree>/.glosa` or
    // `<home>/state/<registration_id>`), here an unrelated directory entirely.
    const home = freshHome();
    const worktree = freshWorkspaceDir();
    const canaryRoot = freshWorkspaceDir();
    const canaryFile = join(canaryRoot, "do-not-delete.txt");
    writeFileSync(canaryFile, "precious\n");

    const corrupted = {
      // A REAL registration_id (derived from canonical_path exactly as the index itself would) —
      // this test's whole point is that `bus_path` alone is the wrong shape, independent of the
      // anchor-validation guard against a corrupted `registration_id`/`worktree_path` (covered by
      // its own test below).
      registration_id: registrationIdFor("directory", worktree),
      kind: "directory" as const,
      canonical_path: worktree,
      worktree_path: worktree,
      bus_path: canaryRoot,
      tracking: { mode: "matcher" as const },
      slug: "corrupted",
      slug_len: 6,
      source: "glosa-open" as const,
      first_seen: "2020-01-01T00:00:00.000Z",
      last_seen: "2020-01-01T00:00:00.000Z",
      present: true,
    };

    expect(confineBusPathForDeletion(corrupted, home)).toBeNull();
    expect(readFileSync(canaryFile, "utf8")).toBe("precious\n"); // never touched

    // The legitimate local shape for the SAME entry passes confinement.
    const legitimate = { ...corrupted, bus_path: join(worktree, ".glosa") };
    mkdirSync(legitimate.bus_path, { recursive: true });
    expect(confineBusPathForDeletion(legitimate, home)).toEqual({ path: legitimate.bus_path, existed: true });

    cleanup(home);
    cleanup(worktree);
    cleanup(canaryRoot);
  });

  test("confinement is validated for the WHOLE member set before anything is marked or deleted", async () => {
    // Regression for issue #156's all-or-nothing confinement finding: a valid target followed by
    // a corrupted adopted source must not let the target's bus get deleted before the source's
    // corruption is discovered. Asserts genuinely ZERO mutation of either member.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const canaryRoot = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");
    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    expect(existsSync(target.bus_path)).toBe(true);

    // Corrupt the SOURCE's bus_path in place (simulating a damaged index record) — the target
    // passes confinement on its own, the source does not.
    (source as { bus_path: string }).bus_path = canaryRoot;

    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);
    const result = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(result).toEqual({ ok: false, code: "confinement-failed", registration_id: source.registration_id });

    // ZERO mutation: the target's bus is untouched, and NEITHER member was ever marked
    // "forgetting" — a first-entry pass must never leave the operation half-committed.
    expect(existsSync(target.bus_path)).toBe(true);
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("active");
    expect(index.getWorkspaceByRegistration(source.registration_id)?.lifecycle?.state).toBe("adopted");

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
    cleanup(canaryRoot);
  });

  test("refuses to forget a workspace mid-adoption", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    writeFileSync(join(root, "loose.md"), "x\n");
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();

    const loose = await index.resolveOpenTarget(join(root, "loose.md"));
    await busRegistry.get(loose.entry).reconcileOnce(); // materializes the loose bus dir — beginAdoption requires existsSync(bus_path)
    const directory = (await index.resolveOpenTarget(root)).entry;
    const record = await index.beginAdoption(directory);
    expect(record).not.toBeNull();
    expect(index.getBySlug(directory.slug)?.lifecycle?.state).toBe("adopting");

    const deps = buildDeps(index, sessionRegistry, busRegistry, home);
    const preview = await forgetWorkspace(deps, directory.slug, { confirm: false });
    expect(preview).toEqual({
      ok: false,
      code: "blocked",
      blockers: [{ kind: "adopting" }],
      target_slug: directory.slug,
      requested_slug: directory.slug,
    });
    const execute = await forgetWorkspace(deps, directory.slug, { confirm: true });
    expect(execute).toEqual({
      ok: false,
      code: "blocked",
      blockers: [{ kind: "adopting" }],
      target_slug: directory.slug,
      requested_slug: directory.slug,
    });
    expect(index.getBySlug(directory.slug)?.lifecycle?.state).toBe("adopting"); // untouched

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("beginAdoption refuses a target that is being forgotten (the symmetric guard)", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const entry = await index.upsertWorkspace(root, "glosa-open");
    await index.markForgetting([entry.registration_id], entry.registration_id);

    await expect(index.beginAdoption(entry)).rejects.toMatchObject({ code: "workspace-forgetting" });

    cleanup(home);
    cleanup(root);
  });

  test("WorkspaceBus.sealForForget is atomic with the lease check and permanently locks the bus", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await index.upsertWorkspace(root, "glosa-open");
    const bus = busRegistry.get(entry);
    await bus.reconcileOnce();
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.applyBegin("e1", "session-x");

    // Sealing over an active lease would silently strand its proven pre..post interval — refused,
    // and the bus is provably NOT sealed afterward (no partial commit).
    await expect(bus.sealForForget()).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(bus.state.forgetSeal).toBe(false);

    await bus.resolveEntry("e1", "applied", "session-x");
    await bus.sealForForget();
    expect(bus.state.forgetSeal).toBe(true);

    // Permanent: every mutator (`assertWritable`) now refuses, exactly like an adoption seal.
    await expect(bus.createEntry("e2", { kind: "annotation" })).rejects.toBeInstanceOf(WorkspaceForgottenError);

    // Idempotent: sealing again is a silent no-op, never a duplicate journal event.
    await bus.sealForForget();

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resolves an adopted source slug to the complete owning provenance unit", async () => {
    // Regression for the independent review's finding 1: "an adopted source slug can be treated
    // as the target and delete only that historical source instead of the complete provenance
    // unit." A source is never an independent provenance unit — `glosa forget <source-slug>` must
    // resolve straight through to the owning target and act on the whole unit.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");
    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    expect(source.lifecycle?.state).toBe("adopted");
    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);

    // Preview against the SOURCE's own slug — never treated as an independent unit: the resolved
    // response names the owning TARGET, and the exact same complete member set the target's own
    // slug would report.
    const preview = await forgetWorkspace(deps, source.slug, { confirm: false });
    expect(preview).toMatchObject({
      ok: true,
      confirmed: false,
      target_slug: target.slug,
      requested_slug: source.slug,
    });
    if (!preview.ok || preview.confirmed) throw new Error("unreachable");
    expect(new Set(preview.entries.map((e) => e.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );

    // Executing against the source's slug deletes the COMPLETE unit — target and source both —
    // never just the named source, and reports the target's slug as the one actually acted on.
    const result = await forgetWorkspace(deps, source.slug, { confirm: true });
    expect(result).toMatchObject({ ok: true, confirmed: true, target_slug: target.slug, requested_slug: source.slug });
    if (!result.ok || !result.confirmed) throw new Error("unreachable");
    expect(new Set(result.removed.map((e) => e.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );
    expect(existsSync(target.bus_path)).toBe(false);
    expect(existsSync(source.bus_path)).toBe(false);
    expect(index.getBySlug(target.slug)).toBeNull();
    expect(index.getWorkspaceByRegistration(source.registration_id)).toBeNull();
    expect(readFileSync(artifact, "utf8")).toBe("second\n"); // work-tree untouched throughout

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("serializes session binding with deletion commitment", async () => {
    // Regression for the independent review's finding 2: session registration/binding must share
    // the SAME per-target ownership lock a forget commit holds, and must reject an ACTIVE forget
    // operation rather than resurrect a live session on a workspace mid-deletion — including the
    // crash-recovery case exercised here, where the marker survived a restart (a fresh
    // coordinator, no in-memory lock contention left over from before the crash) and only the
    // durable state on disk says a deletion is committed. `http.ts`'s `handleSessionBinding`/
    // `handleSessionRegister` use exactly this shape: acquire the shared coordinator lock for the
    // target, re-check the freshest lifecycle under it, and only then mutate. The mutual-exclusion
    // half of this fix — a bind racing a FRESH commit's own lock acquisition, not a resumed one —
    // is exercised under genuine concurrency at the HTTP layer in http-routes.test.ts.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const entry = await index.upsertWorkspace(root, "glosa-open");
    await busRegistry.get(entry).reconcileOnce();
    await index.beginForgetOperation(entry, [entry]);

    async function guardedBind(sessionId: string): Promise<"bound" | "blocked"> {
      return coordinator.run(entry.registration_id, async () => {
        const fresh = index.getWorkspaceByRegistration(entry.registration_id);
        if (fresh?.lifecycle?.state === "forgetting") return "blocked" as const;
        await sessionRegistry.bind(sessionId, root);
        return "bound" as const;
      });
    }

    expect(await guardedBind("race-session")).toBe("blocked");
    expect(sessionRegistry.get("race-session")).toBeNull();

    // The deletion itself still resumes and completes cleanly afterward — the refused bind left
    // no trace to interfere with it.
    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);
    const resumed = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    expect(index.getBySlug(entry.slug)).toBeNull();

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resumes after a crash between the durable plan and bus seal", async () => {
    // Regression for the independent review's finding 3: "a crash after the durable forget_sealed
    // journal event but before the index lifecycle marker is not discoverable or resumable through
    // status/doctor." The fix reorders the commit so the durable marker (`beginForgetOperation`) is
    // written BEFORE the bus is sealed — making that exact crash impossible by construction: by the
    // time sealing is even attempted, the marker (and therefore `status`/`doctor` discoverability)
    // is already durable. This simulates a crash mid-seal (after the marker landed) via an injected
    // `getWorkspaceBus` and proves both the discoverability and the resumability.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await index.upsertWorkspace(root, "glosa-open");
    const realBus = busRegistry.get(entry);
    await realBus.reconcileOnce();

    let sealAttempted = false;
    let originalSeal: (() => Promise<void>) | undefined;
    const crashingDeps: ForgetDeps = {
      workspaceIndex: index,
      sessionRegistry,
      home,
      adoptionCoordinator: new AdoptionCoordinator(),
      getWorkspaceBus: (workspace) => {
        const bus = busRegistry.get(workspace);
        if (!originalSeal) {
          originalSeal = bus.sealForForget.bind(bus);
          bus.sealForForget = async () => {
            sealAttempted = true;
            throw new Error("simulated crash mid-seal");
          };
        }
        return bus;
      },
    };

    await expect(forgetWorkspace(crashingDeps, entry.slug, { confirm: true })).rejects.toThrow(
      "simulated crash mid-seal",
    );
    expect(sealAttempted).toBe(true);

    // Discoverable: the durable marker survived the crash even though sealing never completed —
    // `status`/`doctor` see this immediately, not just after a resume is attempted.
    expect(index.getBySlug(entry.slug)?.lifecycle?.state).toBe("forgetting");
    expect(existsSync(entry.bus_path)).toBe(true); // nothing destructive has happened yet
    expect(realBus.state.forgetSeal).toBe(false); // the seal itself never actually landed

    // Restore the real seal implementation before resuming — a real crash would restart the whole
    // process, so nothing about "sealing already failed once" survives into the resumed attempt.
    // This is also what proves the actual fix under test: resuming must RE-ATTEMPT sealing rather
    // than skip it outright, since nothing in a fresh process can prove an earlier attempt ever
    // got that far (finding 3, second pass).
    realBus.sealForForget = originalSeal!;

    const deps = buildDeps(index, sessionRegistry, busRegistry, home);
    const resumed = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(resumed.removed.map((r) => r.registration_id)).toEqual([entry.registration_id]);
    expect(existsSync(entry.bus_path)).toBe(false);
    expect(index.getBySlug(entry.slug)).toBeNull();
    expect(realBus.state.forgetSeal).toBe(true); // the resume genuinely sealed it, not skipped

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resumes past a crash between the target's own deregistration and the receipt's completion (independent review, second pass, finding 1)", async () => {
    // Regression: the target's own registration can be the LAST durable step to disappear, and a
    // crash between that removal and `completeForgetOperation` leaves `getBySlug` resolving
    // nothing at all — the outer `forgetWorkspace` must still find the ACTIVE (not yet completed)
    // operation record and finish it, rather than returning a false `not-found` because there is
    // no live registration left to anchor the old (pre-fix) lookup on.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await index.upsertWorkspace(root, "glosa-open");
    await busRegistry.get(entry).reconcileOnce();

    const operation = await index.beginForgetOperation(entry, [entry]);
    rmSync(entry.bus_path, { recursive: true, force: true });
    // Simulate the exact crash point: the target's own (and only) registration has just been
    // removed, but `completeForgetOperation` never ran.
    expect(await index.forget(entry.slug)).toBe(true);
    expect(index.getBySlug(entry.slug)).toBeNull();
    expect(index.getWorkspaceByRegistration(entry.registration_id)).toBeNull();
    expect(index.activeForgetOperationForTarget(operation.target_registration_id)?.completed_at).toBeUndefined();

    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    // A preview call in this exact state must still find the operation and answer with its
    // complete original member set, never `not-found`.
    const preview = await forgetWorkspace(deps, entry.slug, { confirm: false });
    expect(preview).toMatchObject({ ok: true, confirmed: false, target_slug: entry.slug, requested_slug: entry.slug });
    if (!preview.ok || preview.confirmed) throw new Error("unreachable");
    expect(preview.entries.map((e) => e.registration_id)).toEqual([entry.registration_id]);

    // The commit call resolves the same way and simply stamps the completion receipt — nothing
    // left to delete or deregister, since a prior attempt already got there.
    const resumed = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true, target_slug: entry.slug, requested_slug: entry.slug });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(resumed.removed.map((r) => r.registration_id)).toEqual([entry.registration_id]);
    expect(index.forgetOperationForSlug(entry.slug)?.completed_at).toBeDefined();

    // And it stays this way on any further retry — the idempotent completion receipt.
    const again = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(again).toMatchObject({ ok: true, confirmed: true });

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("a retry addressed by an adopted source's own slug, after the durable operation marker already exists, resolves the SAME operation (independent review, second pass, finding 2)", async () => {
    // Regression: once `beginForgetOperation` flips a sealed source's lifecycle from `"adopted"`
    // to `"forgetting"`, `resolveForgetTarget`'s `"adopted"` check no longer matches it — a naive
    // re-derivation would treat the source AS the target, find an empty member set (nothing has
    // `target_registration_id === source.registration_id`), and either fail or start a second,
    // broken, source-owned operation. The fix routes any "forgetting" entry through the durable
    // operation record directly, keyed by ANY original member's slug.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");
    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    expect(source.lifecycle?.state).toBe("adopted");

    // Begin the durable operation exactly as a real commit would — BEFORE any file is touched —
    // flipping BOTH members' lifecycle to "forgetting" in the same durable write.
    const operation = await index.beginForgetOperation(target, [target, source]);
    const resolvedSource = index.getWorkspaceByRegistration(source.registration_id)!;
    expect(resolvedSource.lifecycle?.state).toBe("forgetting"); // no longer "adopted"

    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);

    // Preview by the SOURCE's own slug, now that the marker exists.
    const preview = await forgetWorkspace(deps, source.slug, { confirm: false });
    expect(preview).toMatchObject({
      ok: true,
      confirmed: false,
      target_slug: target.slug,
      requested_slug: source.slug,
    });
    if (!preview.ok || preview.confirmed) throw new Error("unreachable");
    expect(new Set(preview.entries.map((e) => e.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );

    // Commit by the SOURCE's own slug: removes the COMPLETE unit through the SAME operation
    // record — never a second, source-owned operation, and never just the source alone.
    const result = await forgetWorkspace(deps, source.slug, { confirm: true });
    expect(result).toMatchObject({ ok: true, confirmed: true, target_slug: target.slug, requested_slug: source.slug });
    if (!result.ok || !result.confirmed) throw new Error("unreachable");
    expect(new Set(result.removed.map((e) => e.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );
    expect(index.getBySlug(target.slug)).toBeNull();
    expect(index.getWorkspaceByRegistration(source.registration_id)).toBeNull();
    // Exactly ONE operation record exists throughout — no second, broken one was ever created.
    expect(index.forgetOperationForSlug(target.slug)?.operation_id).toBe(operation.operation_id);
    expect(readFileSync(artifact, "utf8")).toBe("second\n");

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("a lease that lands after the durable marker but before sealing blocks a resume from deleting the unsealed bus (independent review, second pass, finding 3)", async () => {
    // Regression: the marker-before-seal ordering (finding 3, first pass) closed the
    // discoverability gap, but the ORIGINAL fix still skipped sealing entirely on resume — so a
    // lease that lands in the gap between the marker landing and the (crashed, never-attempted)
    // seal was never checked at all, and a resume would delete the bus right out from under an
    // active apply-lease. This proves the second-pass fix: resuming re-attempts sealing (a no-op
    // if already sealed, a hard LEASE_HELD refusal otherwise) before ever touching a file. Ablate
    // the resume's `existsSync(target.bus_path)`-gated seal block in commitForgetLocked to see
    // this go red: it would call `rmSync` on the bus while `bus.state.applyLease` is still active.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await index.upsertWorkspace(root, "glosa-open");
    const bus = busRegistry.get(entry);
    await bus.reconcileOnce();
    await bus.createEntry("e1", { kind: "annotation" });

    // Durable marker written — the point a real commit reaches right before attempting to seal.
    await index.beginForgetOperation(entry, [entry]);
    expect(bus.state.forgetSeal).toBe(false);

    // A lease lands in the gap (bus.applyBegin has no knowledge of the index lifecycle — this is
    // exactly the daemon-HTTP-layer race the marker/routing refusal is meant to close, simulated
    // directly against the bus to prove the DELETION side refuses independently of routing too).
    const { leaseId } = await bus.applyBegin("e1", "session-x");
    expect(leaseId).toBeTruthy();

    const deps = buildDeps(index, sessionRegistry, busRegistry, home);
    const blocked = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
    if (blocked.ok || blocked.code !== "blocked") throw new Error("unreachable");
    expect(blocked.blockers).toEqual([{ kind: "apply-lease", lease_id: leaseId, expires_at: expect.any(String) }]);

    // Nothing destructive happened: the bus survives, the registration survives, the marker is
    // untouched (still resumable — a resume that loses this race must NOT roll back, unlike a
    // fresh attempt, since other members may already be gone in a larger operation).
    expect(existsSync(entry.bus_path)).toBe(true);
    expect(index.getBySlug(entry.slug)?.lifecycle?.state).toBe("forgetting");
    expect(bus.state.forgetSeal).toBe(false);

    // Resolving the lease and retrying now succeeds.
    await bus.resolveEntry("e1", "applied", "session-x");
    const resumed = await forgetWorkspace(deps, entry.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(resumed.removed.map((r) => r.registration_id)).toEqual([entry.registration_id]);
    expect(existsSync(entry.bus_path)).toBe(false);
    expect(bus.state.forgetSeal).toBe(true);

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("a live, freshly-reopened registration under a previously-forgotten slug takes precedence over the stale completion receipt (independent review, second pass, finding 5)", async () => {
    // Regression: registration_id (and therefore, absent a collision, the assigned slug) is a
    // deterministic hash of kind + canonical path — reopening the SAME still-existing directory
    // after a completed `forget` legitimately reconstructs the identical identity. A stale
    // completion receipt checked BEFORE the live registry would silently answer "already removed"
    // for this brand-new registration and its brand-new bus, without ever previewing or asking for
    // consent, and without ever removing the thing the user actually just asked to forget.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    const first = await index.upsertWorkspace(root, "glosa-open");
    await busRegistry.get(first).reconcileOnce();
    const firstForgotten = await forgetWorkspace(deps, first.slug, { confirm: true });
    expect(firstForgotten).toMatchObject({ ok: true, confirmed: true });
    expect(index.getBySlug(first.slug)).toBeNull();
    expect(existsSync(first.bus_path)).toBe(false);
    expect(existsSync(root)).toBe(true); // the work-tree directory itself was never touched

    // A retry against the now-completed receipt still answers with it — the baseline this test
    // contrasts against.
    const staleRetry = await forgetWorkspace(deps, first.slug, { confirm: true });
    expect(staleRetry).toMatchObject({ ok: true, confirmed: true, target_slug: first.slug });

    // Reopen the SAME still-existing directory — a deterministic registration_id/slug collision
    // with the forgotten entry, by construction (registrationIdFor hashes kind + canonical_path).
    await busRegistry.closeAll();
    const reopened = await index.upsertWorkspace(root, "glosa-open");
    expect(reopened.registration_id).toBe(first.registration_id);
    expect(reopened.slug).toBe(first.slug);
    const freshBusRegistry = new WorkspaceBusRegistry();
    await freshBusRegistry.get(reopened).reconcileOnce();
    expect(existsSync(reopened.bus_path)).toBe(true);

    const freshDeps = buildDeps(index, sessionRegistry, freshBusRegistry, home);

    // A preview against the reused slug must show the NEW bus, not silently echo the old receipt.
    const preview = await forgetWorkspace(freshDeps, reopened.slug, { confirm: false });
    expect(preview).toMatchObject({ ok: true, confirmed: false, target_slug: reopened.slug });
    if (!preview.ok || preview.confirmed) throw new Error("unreachable");
    expect(preview.entries.map((e) => e.registration_id)).toEqual([reopened.registration_id]);

    // And committing it actually removes the NEW registration and its NEW bus.
    const secondForgotten = await forgetWorkspace(freshDeps, reopened.slug, { confirm: true });
    expect(secondForgotten).toMatchObject({ ok: true, confirmed: true });
    if (!secondForgotten.ok || !secondForgotten.confirmed) throw new Error("unreachable");
    expect(secondForgotten.removed.map((r) => r.registration_id)).toEqual([reopened.registration_id]);
    expect(index.getBySlug(reopened.slug)).toBeNull();
    expect(existsSync(reopened.bus_path)).toBe(false);
    expect(existsSync(root)).toBe(true);

    await freshBusRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("a forget_sealed bus's reconcile performs no self-heal, lease-expiry, or offline catch-up before deletion (issue #156 held-review finding)", async () => {
    // Regression: "a resumed bus carrying forget_sealed can run self-heal, lease expiry, or
    // offline Git catch-up before deletion because reconcile treats only adoptionSeal as an early
    // terminal state." Simulated exactly as a real crash-then-restart would hit it: seal the bus
    // over a lease that is EXPIRED-BUT-NEVER-CLOSED (sealing an expired lease is legal — only an
    // ACTIVE one blocks `sealForForget`), leave an orphan inbox file with no matching
    // `entry_created` on disk, then run a completely fresh `reconcileWorkspace` pass (a new
    // process's restart-time reconcile) and prove it appended NOTHING.
    const root = freshWorkspaceDir();
    const clock = manualClock();
    const bus = new WorkspaceBus(root, { now: clock });
    await bus.reconcileOnce();
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.applyBegin("e1", "session-x");
    expect(bus.state.applyLease).not.toBeNull();

    // The lease is now expired but the journal has no `apply_expired` for it yet — exactly the
    // dangling state reconcile step 4 exists to close, on an ORDINARY (non-sealed) bus.
    clock.advance(APPLY_LEASE_TTL_MS + 60_000);
    await bus.sealForForget(); // legal: sealing checks for an ACTIVE lease, and this one is expired
    expect(bus.state.forgetSeal).toBe(true);

    // An orphan inbox file with no `entry_created` at all — reconcile step 3's self-heal trigger.
    writeInboxEntryOnce(root, "orphan-1", { kind: "annotation" });

    const before = readFileSync(journalPath(root), "utf8");
    expect(before.length).toBeGreaterThan(0);

    const result = await reconcileWorkspace(root, { now: clock });
    expect(result.state.forgetSeal).toBe(true);
    expect(result.healedEntryIds).toEqual([]);
    expect(result.expiredLeaseIds).toEqual([]);
    expect(result.offlineCatchup).toEqual({ occurred: false });

    // The strongest possible proof: not one byte was appended to the journal by this reconcile —
    // ablating the `|| state.forgetSeal` check would make this assertion fail (the lease-expiry
    // step alone would append a fresh `apply_expired` line).
    const after = readFileSync(journalPath(root), "utf8");
    expect(after).toBe(before);

    await bus.close();
    cleanup(root);
  });

  test("confinement fails closed under COORDINATED worktree_path + bus_path corruption targeting a foreign .glosa directory, preserving its canary (issue #156 held-review finding)", async () => {
    // Regression: "confinement derives both the candidate and expected local path from coherently
    // corruptible index fields, so coordinated worktree_path + bus_path corruption can target a
    // foreign .glosa directory." Both fields are corrupted TOGETHER, internally consistent with
    // each other (bus_path = join(corrupted worktree_path, ".glosa")) — the exact shape that used
    // to pass the OLD confinement check, since it derived its own expectation from the very same
    // corrupted worktree_path. `canonical_path` (the index's real semantic key) is left untouched.
    const home = freshHome();
    const realWorktree = freshWorkspaceDir();
    const foreignRoot = freshWorkspaceDir();
    const foreignBus = join(foreignRoot, ".glosa");
    mkdirSync(foreignBus, { recursive: true });
    const canary = join(foreignBus, "do-not-delete.txt");
    writeFileSync(canary, "precious\n");

    const coherentlyCorrupted = {
      // registration_id still matches `registrationIdFor(kind, canonical_path)` — the review's
      // point is that THIS pair alone was never enough; only worktree_path/bus_path were forged.
      registration_id: registrationIdFor("directory", realWorktree),
      kind: "directory" as const,
      canonical_path: realWorktree, // untouched — the index's real semantic key
      worktree_path: foreignRoot, // corrupted
      bus_path: foreignBus, // corrupted, but internally consistent with the line above
      tracking: { mode: "matcher" as const },
      slug: "corrupted",
      slug_len: 6,
      source: "glosa-open" as const,
      first_seen: "2020-01-01T00:00:00.000Z",
      last_seen: "2020-01-01T00:00:00.000Z",
      present: true,
    };

    expect(confineBusPathForDeletion(coherentlyCorrupted, home)).toBeNull();
    expect(readFileSync(canary, "utf8")).toBe("precious\n"); // the foreign directory survives, byte-for-byte
    expect(existsSync(foreignBus)).toBe(true);

    cleanup(home);
    cleanup(realWorktree);
    cleanup(foreignRoot);
  });

  test("heartbeat and connection-refresh cannot extend a session's lease once its workspace is forgetting (issue #156 held-review finding)", async () => {
    // Regression: "heartbeat and connection refresh can reactivate an expired session after the
    // final liveness scan because those paths do not share the ownership/lifecycle gate." Proven
    // directly against SessionRegistry + WorkspaceIndex — the same two collaborators http.ts wires
    // together — without needing the HTTP layer at all.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const clock = manualClock();
    const index = new WorkspaceIndex({ home, now: clock });
    const sessionRegistry = new SessionRegistry({ index, now: clock, leaseTtlMs: 1_000 });

    const entry = await index.upsertWorkspace(root, "glosa-open");
    await sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "hook",
    });
    const initialExpiry = sessionRegistry.get("s1")!.lease_expiry;

    // Forget commits: the workspace is now durably "forgetting".
    await index.markForgetting([entry.registration_id], entry.registration_id);

    // Advance time (but not past the lease TTL) and heartbeat — a bare "still known" ping must not
    // extend the lease for a workspace whose forget has committed.
    clock.advance(500);
    expect(await sessionRegistry.heartbeat("s1")).toBe(true); // still a KNOWN session
    expect(sessionRegistry.get("s1")!.lease_expiry).toBe(initialExpiry); // but NOT extended

    // The connection-refresh timer goes through the exact same gated path. `holdConnection` calls
    // `scheduleRefresh` once (capturing the periodic tick below) AND fires an immediate refresh —
    // the workspace is ALREADY forgetting by this point, so even that immediate bump is withheld.
    let refresh: (() => void) | undefined;
    const withScheduler = new SessionRegistry({
      index,
      now: clock,
      leaseTtlMs: 1_000,
      scheduleRefresh: (fn) => {
        refresh = fn;
        return () => {
          refresh = undefined;
        };
      },
    });
    await withScheduler.register({
      session_id: "s2",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "hook",
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const s2RegisteredExpiry = withScheduler.get("s2")!.lease_expiry;
    withScheduler.holdConnection("s2");
    expect(refresh).toBeDefined();
    await flush(); // let holdConnection's own immediate (queued, async) refresh settle
    // The immediate refresh `holdConnection` itself fires is ALSO withheld — the workspace is
    // already forgetting by this point (marked above), so nothing about this call ever bumps it.
    const s2InitialExpiry = withScheduler.get("s2")!.lease_expiry;
    expect(s2InitialExpiry).toBe(s2RegisteredExpiry);
    clock.advance(500);
    refresh?.(); // the periodic connection-refresh tick `holdConnection` scheduled
    await flush();
    expect(withScheduler.get("s2")!.lease_expiry).toBe(s2InitialExpiry); // untouched

    // Past the original TTL, the session goes stale on schedule — never artificially kept alive.
    clock.advance(2_000);
    expect(sessionRegistry.liveness("s1")).toBe("stale");

    cleanup(home);
    cleanup(root);
  });

  test("a fresh commit's LEASE_HELD abort restores an adopted source's TRUE prior lifecycle, never a bare 'active' (held-review finding)", async () => {
    // Regression: `abortForgetOperation` used to reset EVERY member's lifecycle to a bare
    // `{state:"active"}`. For the TARGET that happens to be correct, but for an already-sealed
    // adopted SOURCE it is a lie — it silently strips the `adoption_id`/`target_registration_id`/
    // `sealed_at` that `sealedSourcesFor` needs to ever rediscover it again, so a later (successful)
    // forget attempt would silently leave that source's bus behind forever.
    //
    // Deterministic, no genuine race needed: a real adoption seals the source into the target,
    // then the target's own bus is made to throw LEASE_HELD on its very first `sealForForget()`
    // call — landing exactly on the fresh (non-resuming) abort path inside `commitForgetLocked`,
    // which flips BOTH members to "forgetting" via `beginForgetOperation` before sealing ever runs.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");
    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    expect(source.lifecycle).toMatchObject({ state: "adopted", target_registration_id: target.registration_id });
    const priorSourceLifecycle = source.lifecycle!;

    const targetBus = busRegistry.get(target);
    await targetBus.reconcileOnce();
    let originalSeal: (() => Promise<void>) | undefined;
    const crashingDeps: ForgetDeps = {
      workspaceIndex: index,
      sessionRegistry,
      home,
      adoptionCoordinator: coordinator,
      getWorkspaceBus: (workspace) => {
        const bus = busRegistry.get(workspace);
        if (bus === targetBus && !originalSeal) {
          originalSeal = bus.sealForForget.bind(bus);
          bus.sealForForget = async () => {
            throw leaseHeldError("fake-lease-id");
          };
        }
        return bus;
      },
    };

    const blocked = await forgetWorkspace(crashingDeps, target.slug, { confirm: true });
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
    if (blocked.ok || blocked.code !== "blocked") throw new Error("unreachable");
    expect(blocked.blockers).toEqual([{ kind: "apply-lease", lease_id: "fake-lease-id", expires_at: "" }]);

    // The operation was ABORTED (a fresh commit's LEASE_HELD) — no operation record survives, and
    // both members return to their TRUE prior state, never a blanket "active".
    expect(index.forgetOperationForSlug(target.slug)).toBeNull();
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("active");
    const restoredSource = index.getWorkspaceByRegistration(source.registration_id)!;
    expect(restoredSource.lifecycle).toEqual(priorSourceLifecycle); // exactly "adopted", never "active"

    // Still discoverable as a sealed source of the target — a later successful forget must still
    // find and delete it, not orphan its bus forever.
    expect(index.sealedSourcesFor(target.registration_id).map((e) => e.registration_id)).toEqual([
      source.registration_id,
    ]);

    targetBus.sealForForget = originalSeal!;
    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);
    const resumed = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: true, confirmed: true });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(new Set(resumed.removed.map((r) => r.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );
    expect(existsSync(target.bus_path)).toBe(false);
    expect(existsSync(source.bus_path)).toBe(false);

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("heartbeat serializes with a forget commit under the SAME per-target ownership coordinator (issue #156 held-review finding)", async () => {
    // Regression: "heartbeat and connection refresh use only the session mutex, not the per-target
    // ownership coordinator. A queued refresh can renew an expired session after `commitForgetLocked`
    // performs its final liveness scan but before the asynchronously persisted forgetting marker."
    // Proven by holding the coordinator lock for the target OURSELVES (simulating forget's own
    // commit critical section) and asserting a concurrent heartbeat call genuinely QUEUES behind
    // it rather than running unlocked in parallel — the fix's whole point.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const coordinator = new AdoptionCoordinator();
    const sessionRegistry = new SessionRegistry({ index, ownershipCoordinator: coordinator });

    const entry = await index.upsertWorkspace(root, "glosa-open");
    await sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "hook",
    });
    const initialExpiry = sessionRegistry.get("s1")!.lease_expiry;

    const order: string[] = [];
    let releaseHold: (() => void) | undefined;
    const held = coordinator.run(entry.registration_id, () => {
      order.push("commit-start");
      return new Promise<void>((resolve) => {
        releaseHold = () => {
          order.push("commit-end");
          resolve();
        };
      });
    });

    // Give the held lock a tick to actually acquire before racing the heartbeat against it.
    await Promise.resolve();
    const heartbeatPromise = sessionRegistry.heartbeat("s1").then((result) => {
      order.push("heartbeat-ran");
      return result;
    });

    // The heartbeat must NOT have run yet — it is queued behind the coordinator, not racing it.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["commit-start"]);
    expect(sessionRegistry.get("s1")!.lease_expiry).toBe(initialExpiry);

    releaseHold!();
    await held;
    expect(await heartbeatPromise).toBe(true);
    expect(order).toEqual(["commit-start", "commit-end", "heartbeat-ran"]);

    cleanup(home);
    cleanup(root);
  });

  test("a session bound to a loose source BEFORE adoption still blocks forgetting the target it was adopted into (issue #156 held-review finding, third pass)", async () => {
    // Regression: "a session bound to a loose source before adoption remains keyed to the source
    // path after adoption, so target liveness checks can miss it and delete the complete provenance
    // unit beneath the live session." A plain `SessionRegistry.forWorkspace` compares
    // `workspace_binding` to the TARGET's own canonical path by raw string equality — the source's
    // own canonical path is a different string, so that comparison alone can never see it, even
    // though the source is now provably part of the target's own provenance unit.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const coordinator = new AdoptionCoordinator();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = busRegistry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.humanEditCheckpoint("source-edit");

    // Bound BEFORE adoption exists at all — explicitly to the loose file's OWN pre-adoption
    // canonical path, exactly as a real live session's binding would be at that point in time.
    await sessionRegistry.register({
      session_id: "pre-adoption-session",
      provider: "claude-code",
      cwd: loose.entry.canonical_path,
      workspace_binding: loose.entry.canonical_path,
      source: "hook",
    });

    writeFileSync(artifact, "second\n");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => busRegistry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      coordinator,
    );

    const target = index.getBySlug(directory.entry.slug)!;
    const source = index.getWorkspaceByRegistration(loose.entry.registration_id)!;
    expect(source.lifecycle).toMatchObject({ state: "adopted", target_registration_id: target.registration_id });
    // The session's OWN binding is unchanged by adoption — still the source's pre-adoption path.
    expect(sessionRegistry.get("pre-adoption-session")?.workspace_binding).toBe(source.canonical_path);

    const deps = buildDeps(index, sessionRegistry, busRegistry, home, coordinator);
    const blocked = await forgetWorkspace(deps, target.slug, { confirm: false });
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
    if (blocked.ok || blocked.code !== "blocked") throw new Error("unreachable");
    expect(blocked.blockers).toEqual([{ kind: "live-session", session_id: "pre-adoption-session" }]);

    // No side effects: the complete provenance unit survives, untouched.
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("active");
    expect(existsSync(source.bus_path)).toBe(true);

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("heartbeat and connection-refresh cannot extend a session's lease during the registration-less window between deregistration and completion (issue #156 held-review finding, third pass)", async () => {
    // Regression: "heartbeat and connection refresh lose their owner/lifecycle key when
    // registration is absent, allowing stale sessions to become live in the
    // deregistration-to-completion window." Reached by the exact durable state a crash between the
    // target's own deregistration and the operation's completion leaves behind — the target's OWN
    // registration is fully gone, but its `ForgetOperationRecord` is still open.
    const home = freshHome();
    const root = freshWorkspaceDir();
    const clock = manualClock();
    const index = new WorkspaceIndex({ home, now: clock });
    const sessionRegistry = new SessionRegistry({ index, now: clock, leaseTtlMs: 1_000 });
    const busRegistry = new WorkspaceBusRegistry();

    const entry = await index.upsertWorkspace(root, "glosa-open");
    await sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "hook",
    });
    const initialExpiry = sessionRegistry.get("s1")!.lease_expiry;

    await busRegistry.get(entry).reconcileOnce();
    const operation = await index.beginForgetOperation(entry, [entry]);
    expect(await index.forget(entry.slug)).toBe(true);
    expect(index.getBySlug(entry.slug)).toBeNull();
    expect(index.activeForgetOperationForTarget(operation.target_registration_id)?.completed_at).toBeUndefined();

    clock.advance(500);
    expect(await sessionRegistry.heartbeat("s1")).toBe(true); // still a KNOWN session
    expect(sessionRegistry.get("s1")!.lease_expiry).toBe(initialExpiry); // but NOT extended

    // Past the original TTL, the session goes stale on schedule — never artificially kept alive by
    // the registration-less gap.
    clock.advance(2_000);
    expect(sessionRegistry.liveness("s1")).toBe("stale");

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(root);
  });

  test("resume refuses to delete a foreign bus whose lifecycle was marked 'forgetting' for this target but was never part of the operation's own snapshot, preserving its canary (issue #156 held-review finding, third pass)", async () => {
    // Regression: "resume derives deletion candidates from mutable lifecycle rows rather than
    // solely from the immutable operation snapshot; unvalidated extra lifecycle rows can authorize
    // deletion of an unrelated bus." `markForgetting` is the same public primitive a genuine forget
    // commit uses to mark its own members — here it stands in for whatever produced the stray extra
    // marker (corruption, or any other lifecycle-row inconsistency), applied to a workspace that was
    // never part of the durable operation's own immutable `members` snapshot.
    const home = freshHome();
    const targetRoot = freshWorkspaceDir();
    const foreignRoot = freshWorkspaceDir();
    const canary = join(foreignRoot, ".glosa", "canary.txt");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    const target = await index.upsertWorkspace(targetRoot, "glosa-open");
    const foreign = await index.upsertWorkspace(foreignRoot, "glosa-open");
    await busRegistry.get(target).reconcileOnce();
    await busRegistry.get(foreign).reconcileOnce();
    mkdirSync(join(foreignRoot, ".glosa"), { recursive: true });
    writeFileSync(canary, "precious\n");

    // The durable operation's own snapshot names ONLY the target — a legitimate single-member
    // forget with no adopted sources.
    await index.beginForgetOperation(target, [target]);
    // Corruption: an UNRELATED workspace's lifecycle row is marked "forgetting" for the SAME
    // target, without ever being part of that operation's own immutable snapshot.
    await index.markForgetting([foreign.registration_id], target.registration_id);
    expect(index.getWorkspaceByRegistration(foreign.registration_id)?.lifecycle).toMatchObject({
      state: "forgetting",
      target_registration_id: target.registration_id,
    });

    const resumed = await forgetWorkspace(deps, target.slug, { confirm: true });
    expect(resumed).toMatchObject({ ok: false, code: "confinement-failed", registration_id: foreign.registration_id });

    // Zero deletions: the foreign workspace's bus and its canary survive, byte-for-byte.
    expect(existsSync(foreign.bus_path)).toBe(true);
    expect(readFileSync(canary, "utf8")).toBe("precious\n");
    expect(index.getWorkspaceByRegistration(foreign.registration_id)).not.toBeNull();
    // The target's own operation is still open (neither completed nor destructively touched) —
    // a fully legitimate retry (once the corruption is cleared) must still be able to resume it.
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("forgetting");
    expect(index.activeForgetOperationForTarget(target.registration_id)?.completed_at).toBeUndefined();
    expect(existsSync(target.bus_path)).toBe(true);

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(targetRoot);
    cleanup(foreignRoot);
  });

  test("a resumed commit addressed by another member's slug is not fooled by an unrelated fresh registration that reused the target's own freed slug (issue #156 held-review finding, final pass)", async () => {
    // Regression: "commit resolves the target by stale slug; this can falsely complete while a live
    // registration remains." Once a target's own registration is removed (sources-first,
    // target-last), its slug string is free — an entirely UNRELATED fresh registration can
    // legitimately claim that exact freed slug before the operation's completion receipt lands.
    // `commitForgetLocked` used to re-resolve "the target" via `getBySlug(op.target_slug)`, which
    // would then silently find and act on the fresh unrelated workspace instead. Reached here via
    // the operation's SECOND member (never stolen) — the only slug still uniquely identifying the
    // stale operation once the target's own slug belongs to someone else.
    const home = freshHome();
    const targetParent = freshWorkspaceDir();
    const targetRoot = join(targetParent, "target");
    mkdirSync(targetRoot, { recursive: true });
    const sourceRoot = freshWorkspaceDir();
    const decoyParent = freshWorkspaceDir();
    const decoyRoot = join(decoyParent, "target"); // SAME basename as targetRoot

    const index = new WorkspaceIndex({ home, now: deterministicClock(), slug: { hash: () => "abc123" } });
    const sessionRegistry = new SessionRegistry({ index });
    const busRegistry = new WorkspaceBusRegistry();
    const deps = buildDeps(index, sessionRegistry, busRegistry, home);

    const target = await index.upsertWorkspace(targetRoot, "glosa-open");
    const source = await index.upsertWorkspace(sourceRoot, "glosa-open");
    expect(target.slug).toBe("target-abc123");

    // Simulates a crash interrupted after both members were deregistered but before the operation's
    // completion receipt was stamped — the exact durable state a resumed `glosa forget` recovers
    // from (same construction the registration-less status/doctor tests above use).
    const operation = await index.beginForgetOperation(target, [target, source]);
    expect(await index.forget(source.slug)).toBe(true);
    expect(await index.forget(target.slug)).toBe(true);
    expect(index.activeForgetOperationForTarget(operation.target_registration_id)?.completed_at).toBeUndefined();

    // An entirely unrelated, freshly-opened workspace claims the target's now-free slug (forced
    // collision: identical basename + the injected fixed hash).
    mkdirSync(decoyRoot, { recursive: true });
    const decoy = await index.upsertWorkspace(decoyRoot, "glosa-open");
    expect(decoy.slug).toBe(target.slug);
    expect(decoy.registration_id).not.toBe(target.registration_id);

    const resumed = await forgetWorkspace(deps, source.slug, { confirm: true });
    expect(resumed).toMatchObject({
      ok: true,
      confirmed: true,
      target_slug: target.slug,
      requested_slug: source.slug,
    });
    if (!resumed.ok || !resumed.confirmed) throw new Error("unreachable");
    expect(new Set(resumed.removed.map((m) => m.registration_id))).toEqual(
      new Set([target.registration_id, source.registration_id]),
    );

    // The decoy is untouched: still registered, still active, never marked forgetting or deleted.
    const decoyAfter = index.getWorkspaceByRegistration(decoy.registration_id);
    expect(decoyAfter).not.toBeNull();
    expect(decoyAfter?.lifecycle?.state ?? "active").toBe("active");

    // The ORIGINAL stale operation is the one that actually completed.
    expect(index.activeForgetOperationForTarget(operation.target_registration_id)).toBeNull();

    await busRegistry.closeAll();
    cleanup(home);
    cleanup(targetParent);
    cleanup(sourceRoot);
    cleanup(decoyParent);
  });
});
