// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  type AdapterRegistry,
  classifyWithAdapter,
  derivedFromSourcePath,
  isArtifactStale,
  orderWithAdapter,
  resolveManifest,
} from "../adapters/interface.ts";
import type { DeliverableEntry } from "../agent-provider/interface.ts";
import {
  type ClassFArtifact,
  type ClassRArtifact,
  type Resolution,
  type ResolveCtx,
  resolve as resolveAnchor,
} from "../anchoring.ts";
import { classifyArtifactPath, renderMarkdown, sourceSha256, writeArtifactAtomic } from "../artifact-render.ts";
import { isTerminal } from "../bus/lifecycle.ts";
import { buildDiffHunks, commitExists } from "../checkpoint-diff.ts";
import { checkpointArtifactPath, listCheckpoints } from "../checkpoints.ts";
import { buildDeliveryPresentation, MAX_ENTRY_PRESENTATION_BYTES, utf8Bytes } from "../delivery/presentation.ts";
import { isPathDirty, readFileAtCheckpoint, runGit, safePathspec } from "../git/shadow.ts";
import { type MatchedFile, resolveTrackedFiles } from "../matcher.ts";
import type { WorkspaceEntry } from "../registry/workspace-index.ts";
import type { CapabilityStore } from "../security/capability.ts";
import { confinePath } from "../security/confine-path.ts";
import { findWorkspace, type WorkspaceAccess, workspaceBus } from "./workspace-access.ts";

export interface ArtifactAccessDependencies extends WorkspaceAccess {
  adapterRegistry?: Pick<AdapterRegistry, "forWorkspace">;
}

export interface ArtifactDependencies extends ArtifactAccessDependencies {
  capabilityStore: Pick<CapabilityStore, "mint">;
}

export type ArtifactErrorCode =
  | "invalid-path"
  | "not-found"
  | "class-f-not-editable"
  | "source-changed"
  | "unknown-checkpoint"
  | "artifact-missing-at-checkpoint"
  | "restore-conflict"
  | "annotation-not-found"
  | "annotation-closed"
  | "presentation-not-actionable"
  | "class-r-capability";

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    readonly data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function id(): string {
  return `inb-${Math.floor(Date.now() / 1000)}-${randomBytes(2).toString("hex")}`;
}

function trackedArtifact(workspace: WorkspaceEntry, rawPath: string) {
  const confined = confinePath(workspace.worktree_path, rawPath);
  if (!confined.ok) throw new ArtifactError("invalid-path");
  const normalized = rawPath
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const match = resolveTrackedFiles(workspace).tracked.find((file) => file.path === normalized);
  if (!match) throw new ArtifactError("not-found");
  return match;
}

export function listArtifacts(deps: ArtifactAccessDependencies, slug: string) {
  const workspace = findWorkspace(deps, slug);
  const root = workspace.worktree_path;
  const adapter = deps.adapterRegistry?.forWorkspace(workspace);
  const { tracked } = resolveTrackedFiles(workspace);
  const byPath = new Map(tracked.map((file) => [file.path, file]));
  const mtimeMs = new Map(tracked.map((file) => [file.path, statSync(file.rawPath).mtime.getTime()]));
  const ordered = orderWithAdapter(
    adapter,
    root,
    tracked.map((file) => file.path),
    workspace,
  );
  return ordered.map((path) => {
    const file = byPath.get(path)!;
    return {
      path: file.path,
      class: classifyWithAdapter(adapter, root, file.path, classifyArtifactPath(file.path), workspace),
      size_bytes: file.sizeBytes,
      mtime: new Date(mtimeMs.get(file.path)!).toISOString(),
      source_sha256: sourceSha256(readFileSync(file.rawPath)),
      stale: isArtifactStale(
        adapter,
        root,
        file.path,
        mtimeMs.get(file.path)!,
        (p) => mtimeMs.get(p) ?? null,
        workspace,
      ),
    };
  });
}

export function getArtifact(deps: ArtifactAccessDependencies, slug: string, path: string, render: boolean) {
  const workspace = findWorkspace(deps, slug);
  const match = trackedArtifact(workspace, path);
  const raw = readFileSync(match.rawPath);
  const sha = sourceSha256(raw);
  const adapter = deps.adapterRegistry?.forWorkspace(workspace);
  const cls = classifyWithAdapter(
    adapter,
    workspace.worktree_path,
    match.path,
    classifyArtifactPath(match.path),
    workspace,
  );
  if (cls === "F") {
    const derivedFrom = derivedFromSourcePath(adapter, workspace.worktree_path, match.path, workspace);
    const manifest = resolveManifest(workspace.worktree_path, adapter, match.path, workspace);
    return {
      source_path: match.path,
      source_sha256: sha,
      class: "F" as const,
      ...(derivedFrom !== undefined ? { derived_from: derivedFrom } : {}),
      ...(manifest?.manifestPath !== undefined ? { manifest_path: manifest.manifestPath } : {}),
    };
  }
  const content = raw.toString("utf8");
  if (!render) return { source_path: match.path, source_sha256: sha, class: "R" as const, content };
  const rendered = renderMarkdown(content);
  return {
    source_path: match.path,
    source_sha256: sha,
    rendered_sha256: createHash("sha256").update(rendered, "utf8").digest("hex"),
    class: "R" as const,
    content,
    rendered_html: rendered,
  };
}

export interface PreparedArtifactSave {
  workspace: WorkspaceEntry;
  match: MatchedFile;
}

export function prepareArtifactSave(
  deps: ArtifactAccessDependencies,
  slug: string,
  path: string,
  ifMatch?: string,
): PreparedArtifactSave {
  const workspace = findWorkspace(deps, slug);
  const match = trackedArtifact(workspace, path);
  const adapter = deps.adapterRegistry?.forWorkspace(workspace);
  if (
    classifyWithAdapter(adapter, workspace.worktree_path, match.path, classifyArtifactPath(match.path), workspace) ===
    "F"
  ) {
    throw new ArtifactError("class-f-not-editable");
  }
  if (ifMatch !== undefined && sourceSha256(readFileSync(match.rawPath)) !== ifMatch) {
    throw new ArtifactError("source-changed");
  }
  return { workspace, match };
}

export async function saveArtifact(deps: ArtifactAccessDependencies, prepared: PreparedArtifactSave, content: string) {
  const { workspace, match } = prepared;
  const bus = await workspaceBus(deps, workspace);
  const inboxId = id();
  const captured = await bus.captureHumanEdit(inboxId, match.path, () => writeArtifactAtomic(match.rawPath, content));
  return {
    source_path: match.path,
    source_sha256: sourceSha256(Buffer.from(content, "utf8")),
    class: "R" as const,
    content,
    rendered_html: renderMarkdown(content),
    ...(captured ? { inbox_id: inboxId } : {}),
  };
}

function anchoringContext(deps: ArtifactAccessDependencies, workspace: WorkspaceEntry, artifactPath: string) {
  let match: MatchedFile;
  try {
    match = trackedArtifact(workspace, artifactPath);
  } catch {
    return null;
  }
  const root = workspace.worktree_path;
  const adapter = deps.adapterRegistry?.forWorkspace(workspace);
  const cls = classifyWithAdapter(adapter, root, match.path, classifyArtifactPath(match.path), workspace);
  if (cls === "R") {
    const source = readFileSync(match.rawPath, "utf8");
    const artifact: ClassRArtifact = { class: "R", path: match.path, source, renderedHtml: renderMarkdown(source) };
    return { artifact, resolveCtx: {} as ResolveCtx };
  }
  const manifest = resolveManifest(root, adapter, match.path, workspace);
  let source = "";
  if (manifest) {
    const sourceMatch = resolveTrackedFiles(workspace).tracked.find(
      (file) => file.path === manifest.manifest.source_path,
    );
    if (sourceMatch) source = readFileSync(sourceMatch.rawPath, "utf8");
  }
  const artifact: ClassFArtifact = {
    class: "F",
    path: match.path,
    source,
    ...(manifest ? { manifest: manifest.manifest } : {}),
  };
  const resolveCtx: ResolveCtx = manifest
    ? { pipelineFeedback: { adapter: manifest.adapterId, component: manifest.component } }
    : {};
  return { artifact, resolveCtx };
}

export function actionablePresentation(
  deps: ArtifactAccessDependencies,
  workspace: WorkspaceEntry,
  entryId: string,
  payload: unknown,
  status: string,
  cursor?: string,
): (DeliverableEntry & { workspace: string }) | null {
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  let resolution: Resolution | undefined;
  if (record?.kind === "annotation" && typeof record.artifact_path === "string") {
    const built = anchoringContext(deps, workspace, record.artifact_path);
    if (built) {
      resolution = resolveAnchor({ body: record.body, intent: record.intent, target: record.target }, built.artifact, {
        ...built.resolveCtx,
        ...(typeof record.captured_rendered_sha256 === "string"
          ? { capturedRenderedSha256: record.captured_rendered_sha256 }
          : {}),
      });
    }
  }
  const workspaceLine = `workspace: ${workspace.canonical_path}`;
  const presentation = buildDeliveryPresentation(entryId, payload, {
    status,
    ...(resolution ? { resolution } : {}),
    ...(cursor ? { cursor } : {}),
    maxBytes: Math.max(0, MAX_ENTRY_PRESENTATION_BYTES - utf8Bytes(workspaceLine) - 1),
  });
  if (!presentation) return null;
  const text = `${workspaceLine}\n${presentation.text}`;
  const bytes = utf8Bytes(text);
  if (bytes > MAX_ENTRY_PRESENTATION_BYTES) return null;
  return { ...presentation, workspace: workspace.canonical_path, text, bytes };
}

export interface CreateAnnotationInput {
  artifactPath: string;
  capturedRenderedSha256?: string;
  body: unknown;
  intent: unknown;
  target: unknown;
}

export async function createAnnotation(deps: ArtifactAccessDependencies, slug: string, input: CreateAnnotationInput) {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  const entryId = id();
  await bus.createEntry(entryId, {
    kind: "annotation",
    artifact_path: input.artifactPath,
    ...(input.capturedRenderedSha256 !== undefined ? { captured_rendered_sha256: input.capturedRenderedSha256 } : {}),
    body: input.body,
    intent: input.intent,
    target: input.target,
  });
  const built = anchoringContext(deps, workspace, input.artifactPath);
  const resolution = built
    ? resolveAnchor({ body: input.body, intent: input.intent, target: input.target }, built.artifact, {
        ...built.resolveCtx,
        ...(input.capturedRenderedSha256 !== undefined ? { capturedRenderedSha256: input.capturedRenderedSha256 } : {}),
      })
    : undefined;
  return { id: entryId, status: "pending" as const, ...(resolution ? { resolution } : {}) };
}

export async function withdrawAnnotation(deps: ArtifactAccessDependencies, slug: string, entryId: string) {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  const entry = bus.state.entries[entryId];
  if (!entry) throw new ArtifactError("annotation-not-found", { id: entryId });
  if (isTerminal(entry.kind === "attention" ? "attention" : "common", entry.status)) {
    throw new ArtifactError("annotation-closed", { status: entry.status });
  }
  await bus.commitTransition(entryId, "rejected", { by: "human", note: "withdrawn in glosa" });
  return { id: entryId, status: bus.state.entries[entryId]?.status ?? "rejected" };
}

export async function artifactDiff(deps: ArtifactAccessDependencies, slug: string, from: string, to: string) {
  const workspace = findWorkspace(deps, slug);
  await workspaceBus(deps, workspace);
  if (!(await commitExists(workspace, from)) || (to !== "working" && !(await commitExists(workspace, to)))) {
    throw new ArtifactError("unknown-checkpoint");
  }
  return { from, to, hunks: await buildDiffHunks(workspace, from, to) };
}

export async function artifactCheckpoints(
  deps: ArtifactAccessDependencies,
  slug: string,
  query: { since?: string; limit?: number },
) {
  const workspace = findWorkspace(deps, slug);
  await workspaceBus(deps, workspace);
  const result = await listCheckpoints(workspace, query, new Date());
  if (!result.ok) throw new ArtifactError("unknown-checkpoint");
  return result.rows;
}

export async function restoreArtifact(
  deps: ArtifactAccessDependencies,
  slug: string,
  path: string,
  to: string,
  force: boolean,
) {
  const workspace = findWorkspace(deps, slug);
  const match = trackedArtifact(workspace, path);
  const bus = await workspaceBus(deps, workspace);
  if (!(await commitExists(workspace, to))) throw new ArtifactError("unknown-checkpoint");
  if ((await isPathDirty(workspace, match.path)) && !force) {
    const lost = await runGit(workspace, ["diff", "HEAD", "--", safePathspec(match.path)]);
    throw new ArtifactError("restore-conflict", { path: match.path, diff: lost.stdout });
  }
  const checkpointPath = await checkpointArtifactPath(workspace, to, match.path);
  const content = await readFileAtCheckpoint(workspace, to, checkpointPath);
  if (content === null) throw new ArtifactError("artifact-missing-at-checkpoint");
  const inboxId = id();
  const captured = await bus.captureHumanEdit(
    inboxId,
    match.path,
    () => writeArtifactAtomic(match.rawPath, content),
    "restore",
  );
  const fullSha = captured?.checkpoint_after ?? to;
  const shortSha = (await runGit(workspace, ["rev-parse", "--short", fullSha])).stdout.trim();
  return {
    path: match.path,
    restored_to: to,
    checkpoint_id: shortSha,
    source_sha256: sourceSha256(Buffer.from(content, "utf8")),
    ...(captured ? { inbox_id: inboxId } : {}),
  };
}

export async function inboxPresentation(
  deps: ArtifactAccessDependencies,
  slug: string,
  entryId: string,
  cursor?: string,
) {
  const workspace = findWorkspace(deps, slug);
  const bus = await workspaceBus(deps, workspace);
  const entry = bus.readEntry(entryId);
  if (!entry) throw new ArtifactError("not-found", { id: entryId });
  const state = bus.state.entries[entryId];
  const presentation = actionablePresentation(
    deps,
    workspace,
    entryId,
    entry.payload,
    state?.status ?? "pending",
    cursor,
  );
  if (!presentation) throw new ArtifactError("presentation-not-actionable", { id: entryId });
  return presentation;
}

export function mintArtifactCapability(deps: ArtifactDependencies, slug: string, path: string) {
  const workspace = findWorkspace(deps, slug);
  const match = trackedArtifact(workspace, path);
  const adapter = deps.adapterRegistry?.forWorkspace(workspace);
  if (
    classifyWithAdapter(adapter, workspace.worktree_path, match.path, classifyArtifactPath(match.path), workspace) !==
    "F"
  ) {
    throw new ArtifactError("class-r-capability");
  }
  const artifactDirRealPath = dirname(realpathSync(match.rawPath));
  const artifactBasename = basename(match.rawPath);
  return { artifactBasename, ...deps.capabilityStore.mint({ slug, artifactDirRealPath, artifactBasename }) };
}
