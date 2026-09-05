// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — INSTALL identity: which tree this process is running out of (A5 §F13).
//
// Deliberately separate from build-id.ts. Build identity hashes every runtime source file, which
// is far too expensive to pay on paths that only need to know *where* glosa lives — and `glosa
// hook …` runs on every agent prompt. Everything here is one realpath and one short hash.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HASH_HEX_LENGTH = 16;

/** The directory this glosa runs out of — a global install dir, or a source checkout. The same
 * root build-id.ts hashes its file set from, so the two identities can never disagree about which
 * tree they describe. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Which INSTALL this process belongs to: `sha256(realpath(packageRoot))`, truncated like a build
 * hash. `BUILD_ID` answers "which bytes"; this answers "whose daemon". Two installs of one version
 * differ in bytes and two checkouts can transiently agree on bytes, so neither question can be
 * answered with the other's value.
 *
 * A HASH, not the path: `GET /api/handshake` is tokenless, and a filesystem path on an
 * unauthenticated endpoint is a privacy regression for a tool that holds manuscripts. The hash is
 * an integrity signal against ACCIDENT, not a secrecy boundary — its input is guessable, and a
 * same-uid attacker can read `<home>/token` directly anyway (A3's threat model is hostile web
 * content, not another process owned by the same user). See docs/decisions.md.
 *
 * Bun resolves symlinks in `import.meta.url`, so a `bun link`ed install and the checkout it points
 * at produce the SAME id. That is correct — they are one install.
 */
export function computeInstallId(root: string = PACKAGE_ROOT): string {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    // A moved or deleted tree can still be compared with itself; nothing else lands here.
    canonical = root;
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, HASH_HEX_LENGTH);
}

export const INSTALL_ID = computeInstallId();

/**
 * Is this glosa running out of a source checkout rather than a published install?
 *
 * `package.json`'s `files` allowlist ships `packages/*` sources and nothing else, and
 * `scripts/package-smoke.ts` asserts the tarball contains no `test/` directory. So the presence of
 * the daemon's own test tree is a property of the ARTIFACT, not a guess about the environment.
 *
 * Deliberately NOT a realpath or symlink check: Bun resolves symlinks in `import.meta.url`, so a
 * linked install is indistinguishable from the tree it points at by that route.
 *
 * Cached for the default root only — the file layout of the running package cannot change under it
 * mid-process. Callers that also read env must re-read the env themselves; `glosaHome()` is
 * re-derived per use by design (daemon-identity.ts) and tests mutate `process.env` between cases.
 */
let cachedSourceCheckout: boolean | null = null;

function looksLikeCheckout(root: string): boolean {
  return existsSync(join(root, "packages", "daemon", "test"));
}

export function isSourceCheckout(root: string = PACKAGE_ROOT): boolean {
  if (root !== PACKAGE_ROOT) return looksLikeCheckout(root);
  if (cachedSourceCheckout === null) cachedSourceCheckout = looksLikeCheckout(root);
  return cachedSourceCheckout;
}
