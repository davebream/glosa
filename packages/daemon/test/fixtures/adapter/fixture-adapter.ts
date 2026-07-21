// SPDX-License-Identifier: Apache-2.0
// A domain-NEUTRAL "docs + rendered preview" fixture `ContentAdapter` (P6.1's acceptance fixture)
// — proves the generic adapter-registration protocol (src/adapters/interface.ts) end-to-end using
// generic vocabulary only. No pipeline/domain-specific terms anywhere in this file — the
// invariant-#1 grep guard (test/adapters/invariants.test.ts) covers this whole package, and this
// fixture is written domain-neutral anyway since that's the whole point of it: prove the protocol
// without smuggling in any real adapter's vocabulary.
//
// Registers PURELY through the public `ContentAdapter` shape — the daemon core never imports this
// file, never knows it exists. Fixed workspace: an artifact named "rendered.html" is declared
// derived FROM "source.md" (a generic "render" process), with an optional "manifest.json"
// supplying the class-F chunk manifest when present — ".json" is the REAL manifest-path
// convention (A1 §5.4); `resolveManifest` only rejects a manifestPath that resolves into the
// workspace's own excluded/internal storage (`.glosa/**` etc.), never one that merely fails the
// sidebar's tracked-artifact include glob, so a plain ".json" name resolves fine (P6.1 review
// Fix 2's corrected form).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AdapterSessionHint, ContentAdapter, DerivedFromEdge, ManifestSource } from "../../../src/adapters/interface.ts";

/** Presence of this marker file at a workspace's root is the fixture's whole "data-path
 * recognition" rule (R7) — deliberately trivial (a real adapter's own rule, e.g. a fixed path
 * pattern under some external tool's own data directory, is domain-specific and lives entirely
 * outside this repo). */
export const FIXTURE_MARKER_FILE = ".fixture-workspace";

export interface FixtureAdapterOptions {
  id?: string;
  /** Canonicalized workspace roots this instance recognizes — a fixed allowlist rather than a
   * path-pattern match, since a test fixture only ever needs to serve the one or two tmp
   * workspaces a given test created. `interface.ts`'s own header explains why every method below
   * still takes `workspaceRoot` rather than assuming "whichever root `recognizes` last saw." */
  roots: string[];
  /** P5.2 (T8 adapter-topology): an OPTIONAL `session_id -> workspace root` map standing in for a
   * real adapter's own out-of-band session-history state (e.g. a provider plugin's own
   * `session_history` file keyed by session id, tracking the "actual data root" independent of
   * whatever `cwd` the hook happened to report). Omitted entirely by every existing fixture-
   * adapter test (preserving their behavior unchanged — no `sessionBinding` method at all, same
   * as "no opinion"); only tests that pass this exercise the session-binding routing path. */
  sessionBindingFor?: Record<string, string>;
}

export function createFixtureAdapter(opts: FixtureAdapterOptions): ContentAdapter {
  const roots = new Set(opts.roots);
  const id = opts.id ?? "fixture";
  const sessionBindingFor = opts.sessionBindingFor;

  return {
    id,
    recognizes(workspaceRoot) {
      return roots.has(workspaceRoot) && existsSync(join(workspaceRoot, FIXTURE_MARKER_FILE));
    },
    ...(sessionBindingFor
      ? {
          sessionBinding(hint: AdapterSessionHint): string | null {
            return sessionBindingFor[hint.session_id] ?? null;
          },
        }
      : {}),
    derivedFrom(_workspaceRoot, artifactPath): DerivedFromEdge | null {
      if (artifactPath !== "rendered.html") return null;
      return { sourcePath: "source.md", process: "fixture-render" };
    },
    manifestFor(workspaceRoot, artifactPath): ManifestSource | null {
      if (artifactPath !== "rendered.html") return null;
      if (!existsSync(join(workspaceRoot, "manifest.json"))) return null;
      return { manifestPath: "manifest.json", component: "fixture-renderer" };
    },
    sidebarOrder(_workspaceRoot, artifacts) {
      // A generic "the rendered preview sorts last" rule — proves sidebarOrder is consulted and
      // actually changes the order, without inventing a domain-specific stage concept to do it.
      return [...artifacts].sort((a, b) => Number(a === "rendered.html") - Number(b === "rendered.html"));
    },
  };
}
