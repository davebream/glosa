// SPDX-License-Identifier: Apache-2.0
// Test-only fixture for the issue #139 stall watchdog: a process that holds a real ownership lock,
// arms the watchdog, and then stops running its event loop for good. Everything here mirrors what
// `bootDaemon` does around `claimDaemonIdentity` — lock first, watchdog second, so the watchdog
// only ever releases a record this process is entitled to release.
//
// argv: <home> <instanceId> <stallMs>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ID } from "../../src/lifecycle/build-id.ts";
import { ensureHomeDir, lockPath } from "../../src/lifecycle/home.ts";
import { INSTALL_ID } from "../../src/lifecycle/install.ts";
import { writeLockExclusive } from "../../src/lifecycle/lock.ts";
import { PROTOCOL_VERSION } from "../../src/lifecycle/protocol.ts";
import { startStallWatchdog } from "../../src/lifecycle/stall-watchdog.ts";

const [, , home, instanceId, stallMsRaw] = process.argv;
const stallMs = Number(stallMsRaw);
ensureHomeDir(home as string);
const lockFile = lockPath(home as string);

writeLockExclusive(lockFile, {
  instance_id: instanceId as string,
  pid: process.pid,
  port: 0,
  protocol_version: PROTOCOL_VERSION,
  build_id: BUILD_ID,
  install_id: INSTALL_ID,
  started_at: new Date().toISOString(),
  host: "127.0.0.1",
  bun: Bun.version,
});

// Proof that a wedged process cannot honour it — the test sends SIGTERM and expects nothing.
process.on("SIGTERM", () => process.exit(0));

startStallWatchdog({ home: home as string, lockFile, instanceId: instanceId as string, stallMs });

// A short window of normal operation first, so the heartbeat is genuinely running before it stops.
setTimeout(() => {
  // Written immediately before the loop stops, so the test can wait for the wedge itself instead
  // of racing this timer: a SIGTERM that lands while the process is still healthy proves nothing.
  writeFileSync(join(home as string, "wedged.marker"), "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.exit(0);
}, 200);
