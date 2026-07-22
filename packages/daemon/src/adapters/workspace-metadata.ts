// SPDX-License-Identifier: Apache-2.0
// Durable, declarative workspace metadata. External integrations register this data through the
// public API; the daemon materializes it as an ordinary ContentAdapter so the core keeps one seam.
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { confinePath } from "../confine-path.ts";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";
import { KeyedMutex } from "../bus/mutex.ts";
import { workspaceBusDir } from "../bus/paths.ts";
import type { ContentAdapter } from "./interface.ts";

export const WORKSPACE_METADATA_VERSION = 1 as const;
export const MAX_WORKSPACE_METADATA_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 2048;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 256;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface WorkspaceMetadataArtifact {
  path: string;
  class?: "R" | "F";
  order?: number;
  derived_from?: { path: string; via: string };
  manifest?: { path: string; component: string };
}

export interface WorkspaceMetadataDescriptor {
  version: 1;
  id: string;
  artifacts: WorkspaceMetadataArtifact[];
}

export class WorkspaceMetadataError extends Error {
  readonly code: "invalid-metadata" | "metadata-conflict" | "metadata-io";
  readonly status: 400 | 409 | 500;

  constructor(code: WorkspaceMetadataError["code"], message: string, status: WorkspaceMetadataError["status"] = 400) {
    super(message);
    this.name = "WorkspaceMetadataError";
    this.code = code;
    this.status = status;
  }
}

export function workspaceMetadataPath(workspaceRoot: string): string {
  return join(workspaceBusDir(workspaceRoot), "workspace-metadata.json");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceMetadataError("invalid-metadata", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new WorkspaceMetadataError("invalid-metadata", `${label} has unknown field ${unknown[0]}`);
}

function boundedString(value: unknown, label: string, max = MAX_LABEL_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new WorkspaceMetadataError("invalid-metadata", `${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function assertRegularNonSymlinkPath(workspaceRoot: string, relPath: string, label: string): void {
  const confined = confinePath(workspaceRoot, relPath);
  if (!confined.ok) throw new WorkspaceMetadataError("invalid-metadata", `${label} is not confined to the workspace`);

  let current = workspaceRoot;
  for (const segment of relPath.split("/")) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new WorkspaceMetadataError("invalid-metadata", `${label} does not exist`);
    }
    if (stat.isSymbolicLink()) throw new WorkspaceMetadataError("invalid-metadata", `${label} must not contain symlinks`);
  }
  if (!lstatSync(confined.realPath).isFile()) {
    throw new WorkspaceMetadataError("invalid-metadata", `${label} must reference a regular file`);
  }
}

export function validateWorkspaceMetadata(workspaceRoot: string, input: unknown): WorkspaceMetadataDescriptor {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new WorkspaceMetadataError("invalid-metadata", "metadata must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new WorkspaceMetadataError("invalid-metadata", "metadata must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_METADATA_BYTES) {
    throw new WorkspaceMetadataError("invalid-metadata", `metadata exceeds ${MAX_WORKSPACE_METADATA_BYTES} bytes`);
  }

  const descriptor = record(input, "metadata");
  exactKeys(descriptor, ["version", "id", "artifacts"], "metadata");
  if (descriptor.version !== WORKSPACE_METADATA_VERSION) {
    throw new WorkspaceMetadataError("invalid-metadata", `metadata.version must be ${WORKSPACE_METADATA_VERSION}`);
  }
  const id = boundedString(descriptor.id, "metadata.id", MAX_ID_LENGTH);
  if (!ID_RE.test(id)) throw new WorkspaceMetadataError("invalid-metadata", "metadata.id has an invalid format");
  if (!Array.isArray(descriptor.artifacts) || descriptor.artifacts.length > MAX_ARTIFACTS) {
    throw new WorkspaceMetadataError("invalid-metadata", `metadata.artifacts must contain at most ${MAX_ARTIFACTS} entries`);
  }

  const paths = new Set<string>();
  const artifacts = descriptor.artifacts.map((raw, index): WorkspaceMetadataArtifact => {
    const artifact = record(raw, `metadata.artifacts[${index}]`);
    exactKeys(artifact, ["path", "class", "order", "derived_from", "manifest"], `metadata.artifacts[${index}]`);
    const path = boundedString(artifact.path, `metadata.artifacts[${index}].path`, 4096).normalize("NFC");
    if (paths.has(path)) throw new WorkspaceMetadataError("invalid-metadata", `duplicate artifact path: ${path}`);
    paths.add(path);
    assertRegularNonSymlinkPath(workspaceRoot, path, `artifact path ${path}`);

    if (artifact.class !== undefined && artifact.class !== "R" && artifact.class !== "F") {
      throw new WorkspaceMetadataError("invalid-metadata", `metadata.artifacts[${index}].class must be R or F`);
    }
    if (artifact.order !== undefined && (!Number.isSafeInteger(artifact.order) || (artifact.order as number) < 0)) {
      throw new WorkspaceMetadataError("invalid-metadata", `metadata.artifacts[${index}].order must be a non-negative integer`);
    }

    let derived_from: WorkspaceMetadataArtifact["derived_from"];
    if (artifact.derived_from !== undefined) {
      const derived = record(artifact.derived_from, `metadata.artifacts[${index}].derived_from`);
      exactKeys(derived, ["path", "via"], `metadata.artifacts[${index}].derived_from`);
      const derivedPath = boundedString(derived.path, `metadata.artifacts[${index}].derived_from.path`, 4096).normalize("NFC");
      assertRegularNonSymlinkPath(workspaceRoot, derivedPath, `derived_from path ${derivedPath}`);
      derived_from = { path: derivedPath, via: boundedString(derived.via, `metadata.artifacts[${index}].derived_from.via`) };
    }

    let manifest: WorkspaceMetadataArtifact["manifest"];
    if (artifact.manifest !== undefined) {
      const source = record(artifact.manifest, `metadata.artifacts[${index}].manifest`);
      exactKeys(source, ["path", "component"], `metadata.artifacts[${index}].manifest`);
      const manifestPath = boundedString(source.path, `metadata.artifacts[${index}].manifest.path`, 4096).normalize("NFC");
      assertRegularNonSymlinkPath(workspaceRoot, manifestPath, `manifest path ${manifestPath}`);
      manifest = { path: manifestPath, component: boundedString(source.component, `metadata.artifacts[${index}].manifest.component`) };
    }

    return {
      path,
      ...(artifact.class === "R" || artifact.class === "F" ? { class: artifact.class } : {}),
      ...(typeof artifact.order === "number" ? { order: artifact.order } : {}),
      ...(derived_from ? { derived_from } : {}),
      ...(manifest ? { manifest } : {}),
    };
  });

  return { version: WORKSPACE_METADATA_VERSION, id, artifacts };
}

export class WorkspaceMetadataRegistry {
  private readonly cache = new Map<string, WorkspaceMetadataDescriptor | null>();
  private readonly mutex = new KeyedMutex<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(workspaceRoot: string): WorkspaceMetadataDescriptor | null {
    if (this.cache.has(workspaceRoot)) return this.cache.get(workspaceRoot) ?? null;
    const path = workspaceMetadataPath(workspaceRoot);
    if (!existsSync(path)) {
      this.cache.set(workspaceRoot, null);
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const validated = validateWorkspaceMetadata(workspaceRoot, parsed);
      this.cache.set(workspaceRoot, validated);
      return validated;
    } catch (error) {
      console.warn(`glosa: ignoring invalid persisted workspace metadata: ${(error as Error).message}`);
      this.cache.set(workspaceRoot, null);
      return null;
    }
  }

  set(workspaceRoot: string, input: unknown): Promise<{ descriptor: WorkspaceMetadataDescriptor; replaced: boolean }> {
    return this.mutex.runExclusive(workspaceRoot, () => {
      const descriptor = validateWorkspaceMetadata(workspaceRoot, input);
      const current = this.get(workspaceRoot);
      if (current && current.id !== descriptor.id) {
        throw new WorkspaceMetadataError("metadata-conflict", `workspace metadata is owned by ${current.id}; clear it before registering another id`, 409);
      }

      const target = workspaceMetadataPath(workspaceRoot);
      mkdirSync(dirname(target), { recursive: true });
      const temp = join(dirname(target), `.workspace-metadata.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
      const fd = openSync(temp, "wx");
      try {
        writeAllSync(fd, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8"));
        fsyncSync(fd);
      } catch (error) {
        try { unlinkSync(temp); } catch { /* best effort */ }
        throw new WorkspaceMetadataError("metadata-io", `could not persist workspace metadata: ${(error as Error).message}`, 500);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temp, target);
        fsyncContainingDir(target);
      } catch (error) {
        try { unlinkSync(temp); } catch { /* best effort */ }
        throw new WorkspaceMetadataError("metadata-io", `could not persist workspace metadata: ${(error as Error).message}`, 500);
      }
      this.cache.set(workspaceRoot, descriptor);
      this.emit(workspaceRoot);
      return { descriptor, replaced: current !== null };
    });
  }

  clear(workspaceRoot: string): Promise<boolean> {
    return this.mutex.runExclusive(workspaceRoot, () => {
      const target = workspaceMetadataPath(workspaceRoot);
      const existed = this.get(workspaceRoot) !== null;
      if (existsSync(target)) {
        unlinkSync(target);
        fsyncContainingDir(target);
      }
      this.cache.set(workspaceRoot, null);
      if (existed) this.emit(workspaceRoot);
      return existed;
    });
  }

  subscribe(workspaceRoot: string, listener: () => void): () => void {
    const listeners = this.listeners.get(workspaceRoot) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(workspaceRoot, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(workspaceRoot);
    };
  }

  adapter(): ContentAdapter {
    return {
      id: "workspace-metadata-v1",
      recognizes: (root) => this.get(root) !== null,
      classifyArtifact: (root, path) => this.get(root)?.artifacts.find((artifact) => artifact.path === path)?.class,
      sidebarOrder: (root, paths) => {
        const descriptor = this.get(root);
        if (!descriptor) return paths;
        const order = new Map(descriptor.artifacts.map((artifact, index) => [artifact.path, artifact.order ?? index]));
        return [...paths].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
      },
      derivedFrom: (root, path) => {
        const edge = this.get(root)?.artifacts.find((artifact) => artifact.path === path)?.derived_from;
        return edge ? { sourcePath: edge.path, process: edge.via } : null;
      },
      manifestFor: (root, path) => {
        const manifest = this.get(root)?.artifacts.find((artifact) => artifact.path === path)?.manifest;
        return manifest
          ? { manifestPath: manifest.path, component: manifest.component, adapterId: this.get(root)!.id }
          : null;
      },
    };
  }

  private emit(workspaceRoot: string): void {
    for (const listener of this.listeners.get(workspaceRoot) ?? []) listener();
  }
}
