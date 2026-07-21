// @glosa/daemon — R7's content-adapter interface + the registry the daemon holds (the generic/
// domain boundary, CLAUDE.md invariant #1: generic core, domain in adapters). Mirrors
// providers/interface.ts's own framing verbatim: this is the seam EXTERNAL code (a package living
// in ITS OWN repo, outside glosa entirely, or this repo's own neutral fixture adapter under
// test/fixtures/) registers domain facts through at runtime. The core (http.ts, anchoring.ts,
// registry/*) imports and calls ONLY the shapes in this file — never a concrete adapter package;
// "adding a content adapter = a new package implementing this interface, never a core change."
//
// Every method past `id`/`recognizes` is OPTIONAL, and the core ships with ZERO adapters
// registered by default (R7) — every generic behavior this file computes (staleness, class-F
// Edit routing, manifest resolution, sidebar ordering, session binding) is provably a no-op with
// an empty/undefined adapter, which is exactly what "the core runs with zero adapters" pins down.
//
// `workspaceRoot` is threaded through EVERY per-artifact method, not just `recognizes` — a
// deliberate departure from the terser "derivedFrom(artifactPath)" shorthand a first pass might
// reach for. A single adapter instance can legitimately serve many concurrent workspaces (e.g.
// one adapter recognizing every session directory under some fixed external tool's own data
// path, many of which may be open at once); an artifact PATH alone ("07_manuscript.md") is only
// unambiguous within one workspace. Passing `workspaceRoot` on every call keeps an adapter
// implementable as a pure function of its inputs — no "remember the last workspace `recognizes()`
// saw" mutable state, which would race across concurrently-handled requests for two different
// workspaces.
import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import { confinePath } from "../confine-path.ts";
import { loadMatcherConfig } from "../matcher.ts";
import type { ChunkManifest } from "../anchoring.ts";

/** The subset of a live session an adapter needs to decide a `workspace_binding` — mirrors
 * `SessionRecord`'s own identity fields (registry/session-registry.ts) without importing that
 * whole type, so this file doesn't gain a dependency on the session registry's storage shape. */
export interface AdapterSessionHint {
  session_id: string;
  provider: string;
  cwd: string;
  source: string;
}

/** A generic `derived-from(A→B, via process)` edge (R7): the artifact at `artifactPath` (A) was
 * built FROM `sourcePath` (B, workspace-relative) BY `process` — a human-readable label (e.g. the
 * name of a rendering/transform step) the core never interprets, only ever surfaces to a human or
 * forwards as part of a pipeline-feedback target. From this edge alone the core computes BOTH
 * generic behaviors R7 promises: Edit-on-A opens source B (`derivedFromSourcePath`), and B newer
 * than A's own mtime marks A stale (`isArtifactStale`) — zero further domain knowledge needed for
 * either. */
export interface DerivedFromEdge {
  sourcePath: string;
  process: string;
}

/** What `manifestFor` hands back for a class-F artifact (A5 §F10/§F11's chunk manifest) — either
 * form is accepted: an adapter can supply the already-parsed object directly, or just point at
 * where the daemon should read it from disk (workspace-relative, resolved through the SAME
 * `confinePath` gate every other workspace-relative path goes through — an adapter is external
 * code, so a path it names gets exactly the same traversal/symlink-escape scrutiny as any other
 * input, A1 §6). `component` feeds `anchoring.ts`'s `ctx.pipelineFeedback` target
 * `{adapter: <this adapter's id>, component}` — the adapter is the only layer allowed to know
 * which producer component a `transformed:true` chunk's feedback should route to. */
export type ManifestSource = { manifest: ChunkManifest; component: string } | { manifestPath: string; component: string };

/** R7's content-adapter interface. Every method past `id`/`recognizes` is OPTIONAL — an adapter
 * that only wants to say "this is my workspace" is legal on its own; the core falls back to its
 * zero-adapter behavior for whatever a given adapter doesn't implement. */
export interface ContentAdapter {
  /** Stable identity — the `adapter` half of an `anchoring.ts` `ctx.pipelineFeedback` target. */
  id: string;
  /** Is `workspaceRoot` (already canonicalized) a workspace this adapter handles? Called on every
   * routing/listing path for that workspace, so it should be cheap — a marker-file stat, not a
   * deep scan — and side-effect-free (it may be called speculatively, more than once per request). */
  recognizes(workspaceRoot: string): boolean;
  /** R2's authoritative routing input, derived from adapter-specific state (e.g. a provider's own
   * session-history file) rather than the hook payload's raw `cwd`. `null`/`undefined` defers to
   * the core's existing cwd-ancestor fallback (registry/routing.ts) exactly as if no adapter had
   * an opinion — the core calls this WITHOUT knowing why the adapter picked what it picked. */
  sessionBinding?(session: AdapterSessionHint): string | null;
  /** Overrides the extension-based R/F split (`artifact-render.ts`'s `classifyArtifactPath`) for
   * one artifact. `undefined` defers to the extension default. */
  classifyArtifact?(workspaceRoot: string, artifactPath: string): "R" | "F" | undefined;
  /** Reorders a workspace's tracked-artifact path list for the sidebar (e.g. by pipeline stage).
   * Expected to return a permutation of its input, but the core never trusts that blindly (see
   * `orderWithAdapter`) — a misbehaving adapter can only reorder its own workspace's sidebar,
   * never hide or inject artifacts. */
  sidebarOrder?(workspaceRoot: string, artifacts: string[]): string[];
  /** The generic derived-from edge (R7) for one artifact, or `null` if it has none (a leaf source,
   * not a build output — e.g. every class-R stage file in a pipeline with no upstream). */
  derivedFrom?(workspaceRoot: string, artifactPath: string): DerivedFromEdge | null;
  /** Class-F manifest resolution (A5 §F10/§F11) for one artifact, or `null` if it has none —
   * opaque preview+annotate only, same as no adapter at all. */
  manifestFor?(workspaceRoot: string, artifactPath: string): ManifestSource | null;
}

/** Runs one adapter method call, degrading to `fallback` (and logging which adapter/method
 * misbehaved) if it throws. An adapter is external code — a buggy (not malicious) method
 * throwing must never propagate up through the core into an unrelated per-workspace 500
 * (this file's own stated philosophy: a misbehaving adapter degrades gracefully, never breaks
 * the core). The fallback passed in is always the SAME answer the caller already gives for "this
 * adapter doesn't implement the method at all," so a throw and an absent method are
 * indistinguishable to everything downstream. */
function safeAdapterCall<T>(adapterId: string, method: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`glosa: adapter "${adapterId}" ${method}() threw — degrading to fallback`, err);
    return fallback;
  }
}

/**
 * The daemon's one adapter registry (R7: "the core calls the adapter ONLY through this
 * interface"). Registration order is match priority — `forWorkspace` returns the FIRST registered
 * adapter whose `recognizes()` is true, never the "best" or "most specific" one; a deployment
 * that needs disambiguation between overlapping adapters orders its own `register()` calls.
 * Starts empty and stays empty in every production wiring today (a real content adapter registers
 * itself from ITS OWN repo, out of scope here) — an empty registry is exactly "core runs with
 * zero adapters."
 */
export class AdapterRegistry {
  private readonly adapters: ContentAdapter[] = [];

  register(adapter: ContentAdapter): void {
    this.adapters.push(adapter);
  }

  /** `undefined` — not a sentinel "no-op adapter" object — is the honest "no adapter claims this
   * workspace" answer; every helper below already treats an absent adapter as "defer to the
   * generic core behavior," so callers never need a null-object stand-in. A `recognizes()` that
   * throws is treated as "not recognized" for THAT adapter only — the registry keeps checking
   * later-registered adapters rather than letting one bad adapter black out the whole lookup. */
  forWorkspace(workspaceRoot: string): ContentAdapter | undefined {
    for (const a of this.adapters) {
      const recognized = safeAdapterCall(a.id, "recognizes", () => a.recognizes(workspaceRoot), false);
      if (recognized) return a;
    }
    return undefined;
  }

  /** R2 session-binding consult (`handleSessionRegister`): asks every registered adapter, in
   * registration order, for an opinion on `hint` and takes the first non-empty answer. Not gated
   * through `forWorkspace` first — which workspace a session belongs to is exactly the question
   * being asked here, so there is no root yet to recognize against. A `sessionBinding()` that
   * throws degrades to "no opinion" (same as `null`) for that adapter and the loop continues. */
  resolveSessionBinding(hint: AdapterSessionHint): string | null {
    for (const adapter of this.adapters) {
      const binding = safeAdapterCall(adapter.id, "sessionBinding", () => adapter.sessionBinding?.(hint) ?? null, null);
      if (typeof binding === "string" && binding.length > 0) return binding;
    }
    return null;
  }

  list(): readonly ContentAdapter[] {
    return this.adapters;
  }
}

// -------------------------------------------------------------------------------------------
// Generic behaviors the core computes from an adapter's answers (R7) — ZERO domain knowledge
// lives past this line, only the mechanical "given an edge/manifest, do the generic thing" logic.
// Each function degrades to its zero-adapter answer when `adapter` is `undefined` OR the method
// it needs is absent, which is what makes "core runs with zero adapters" provable rather than
// merely asserted.
// -------------------------------------------------------------------------------------------

/** R7 behavior (1): Edit-on-class-F opens the derived-from source, if declared. Returns the
 * workspace-relative source path, or `undefined` when there's no edge (same shape as "no
 * adapter") — the SPA already treats a falsy `derived_from` as "class F is opaque"
 * (viewer.js's `canEdit`). */
export function derivedFromSourcePath(adapter: ContentAdapter | undefined, workspaceRoot: string, artifactPath: string): string | undefined {
  if (!adapter) return undefined;
  const edge = safeAdapterCall(adapter.id, "derivedFrom", () => adapter.derivedFrom?.(workspaceRoot, artifactPath) ?? null, null);
  return edge?.sourcePath ?? undefined;
}

/** R7 behavior (2): B (the derived-from source) newer than A's own mtime marks A stale. Takes
 * mtimes rather than reading the filesystem itself, so it stays pure/unit-testable;
 * `resolveSourceMtimeMs` returns `null` when the source path isn't a currently-tracked artifact
 * (deleted, renamed, never existed) — that's "can't prove staleness," not "prove it's stale," so
 * this fails open (`false`), never guesses. */
export function isArtifactStale(
  adapter: ContentAdapter | undefined,
  workspaceRoot: string,
  artifactPath: string,
  artifactMtimeMs: number,
  resolveSourceMtimeMs: (sourcePath: string) => number | null,
): boolean {
  if (!adapter) return false;
  const edge = safeAdapterCall(adapter.id, "derivedFrom", () => adapter.derivedFrom?.(workspaceRoot, artifactPath) ?? null, null);
  if (!edge) return false;
  const sourceMtimeMs = resolveSourceMtimeMs(edge.sourcePath);
  if (sourceMtimeMs === null) return false;
  return sourceMtimeMs > artifactMtimeMs;
}

export function classifyWithAdapter(adapter: ContentAdapter | undefined, workspaceRoot: string, artifactPath: string, fallback: "R" | "F"): "R" | "F" {
  if (!adapter) return fallback;
  return safeAdapterCall(adapter.id, "classifyArtifact", () => adapter.classifyArtifact?.(workspaceRoot, artifactPath) ?? fallback, fallback);
}

/** Applies `sidebarOrder`, then reconciles the result against the REAL tracked-path set rather
 * than trusting it blindly: any path the adapter returned that isn't actually tracked is dropped,
 * and any tracked path the adapter's permutation omitted is appended at the end (in its original
 * order) — so a buggy or malicious adapter can reorder a workspace's own sidebar but can never
 * make an artifact disappear from or a foreign one appear in the listing. */
export function orderWithAdapter(adapter: ContentAdapter | undefined, workspaceRoot: string, paths: readonly string[]): readonly string[] {
  const proposed = adapter
    ? safeAdapterCall(adapter.id, "sidebarOrder", () => adapter.sidebarOrder?.(workspaceRoot, [...paths]) ?? null, null)
    : null;
  if (!proposed) return paths;

  const known = new Set(paths);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of proposed) {
    if (known.has(p) && !seen.has(p)) {
      ordered.push(p);
      seen.add(p);
    }
  }
  for (const p of paths) {
    if (!seen.has(p)) ordered.push(p);
  }
  return ordered;
}

export interface ResolvedManifest {
  manifest: ChunkManifest;
  component: string;
  /** Present only when the adapter supplied a path (vs. an inline manifest) — this is what the
   * class-F artifact response's `manifest_path` field (A1 §5.4) surfaces to the client. */
  manifestPath?: string;
}

/** Class-F manifest resolution (A5 §F10/§F11's "manifest supplied by the caller"): asks the
 * adapter for a `ManifestSource`, and if it named a path rather than handing back the parsed
 * object, reads + parses it from disk THROUGH `confinePath` (A1 §6) — an adapter is external
 * code, so a path it names gets no more trust than any other workspace-relative input; confining
 * alone isn't enough, since e.g. `.glosa/**` confines fine but must stay off-limits. Past
 * confinement, this rejects a manifestPath that resolves into the workspace's OWN excluded/
 * internal storage (`.glosa/**`, `node_modules/**`, dotdirs — `config.artifacts.exclude`, same
 * list `matcher.ts` enforces), same as any other path in this codebase — but it does NOT also
 * require the path match the sidebar's user-visible artifact `include` glob
 * (`**\/*.md`/`**\/*.html`/`**\/*.txt`): chunk manifests are metadata read by the daemon, not
 * sidebar artifacts a human browses, and the real convention (A1 §5.4, requirements.md's
 * `manifest_path` example) is a `.json` file, which never matches that include list by design. A
 * path that fails confinement, falls in an excluded directory, doesn't exist, or isn't valid JSON
 * resolves to `null` — same as "no manifest" — never a throw. */
export function resolveManifest(workspaceRoot: string, adapter: ContentAdapter | undefined, artifactPath: string): ResolvedManifest | null {
  if (!adapter) return null;
  const source = safeAdapterCall(adapter.id, "manifestFor", () => adapter.manifestFor?.(workspaceRoot, artifactPath) ?? null, null);
  if (!source) return null;
  if ("manifest" in source) return { manifest: source.manifest, component: source.component };

  const confined = confinePath(workspaceRoot, source.manifestPath);
  if (!confined.ok) return null;

  const manifestRelNfc = source.manifestPath
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { artifacts } = loadMatcherConfig(workspaceRoot);
  const isExcluded = picomatch(artifacts.exclude, { nocase: false });
  if (isExcluded(manifestRelNfc)) return null;

  let raw: string;
  try {
    raw = readFileSync(confined.realPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return { manifest: parsed as ChunkManifest, component: source.component, manifestPath: source.manifestPath };
}
