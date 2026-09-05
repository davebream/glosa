// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — port resolution. Mirrors home.ts: ONE resolver, honoured everywhere, so a client
// and the daemon it is looking for can never disagree about where to look (A5 §F13).
import { INSTALL_ID, isSourceCheckout } from "./install.ts";

export const DEFAULT_PORT = 4646;

// A source checkout gets its own port pair so it can never contend with a published install on
// 4646/4647. Range notes:
//   - 60000-65498 is disjoint from packages/daemon/test/helpers.ts's allocator, which reserves
//     20000-59999 in four-port blocks with a sentinel per block. A derived port inside that range
//     would hold no reservation and could be handed to a test while a dev daemon owned it.
//   - Even offsets only, so `port` and its class-F `port + 1` always belong to the same checkout.
const DEV_PORT_MIN = 60_000;
const DEV_PORT_PAIRS = 2_750; // 60000 + 2749*2 = 65498, class-F 65499

/** Deterministic per-install dev port. Stable across runs, so a developer's URL keeps working. */
export function devPortFor(installId: string = INSTALL_ID): number {
  // Folds the WHOLE id. Slicing a prefix would make every pair of ids that share those characters
  // collide on one port, and a prefix is not a property install ids are chosen to differ in.
  // Integer arithmetic below 2^31 throughout, so this stays exact in a double and cannot NaN on
  // an unexpected id.
  let folded = 0;
  for (let index = 0; index < installId.length; index += 1) {
    folded = (folded * 31 + installId.charCodeAt(index)) % 0x7fff_ffff;
  }
  return DEV_PORT_MIN + (folded % DEV_PORT_PAIRS) * 2;
}

/** The SPA/API port. An explicit `GLOSA_PORT` (or `--port`, which sets it) always wins. */
export function glosaPort(): number {
  const explicit = Bun.env.GLOSA_PORT;
  if (explicit !== undefined) return Number(explicit);
  return isSourceCheckout() ? devPortFor() : DEFAULT_PORT;
}

/** The class-F port (A3 §1). Keeps deriving as `port + 1` unless pinned. */
export function glosaClassFPort(port: number = glosaPort()): number {
  const explicit = Bun.env.GLOSA_CLASSF_PORT;
  return explicit !== undefined ? Number(explicit) : port + 1;
}

/** True when this process is falling back to the source-checkout defaults rather than an explicit
 * value. The CLI boundary uses this to tell the developer once; the resolvers stay side-effect
 * free so they remain safe to call from anywhere, any number of times. */
export function usingDevDefaults(): boolean {
  return isSourceCheckout() && (Bun.env.GLOSA_HOME === undefined || Bun.env.GLOSA_PORT === undefined);
}
