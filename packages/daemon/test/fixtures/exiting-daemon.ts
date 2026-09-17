// SPDX-License-Identifier: Apache-2.0
// Test-only stand-in for a glosa daemon that has closed its listeners but not yet removed its
// lock: a live process whose command line carries the `__daemon` marker, binding no port, which
// exits after the number of milliseconds given as its second argument.
const lingerMs = Number(process.argv[3]);
if (process.argv[2] !== "__daemon" || !Number.isFinite(lingerMs)) {
  throw new Error("usage: exiting-daemon.ts __daemon <linger-ms>");
}
setTimeout(() => process.exit(0), lingerMs);
