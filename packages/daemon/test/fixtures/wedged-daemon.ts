// SPDX-License-Identifier: Apache-2.0
// Test-only fixture for issue #139: a process that holds a listening socket while its event loop
// has stopped running. That single state is what produced every symptom in the report — no
// handshake answer, no lock repair, no SIGTERM — so reproducing it faithfully needs a REAL
// process, not a stub: an in-process `Bun.serve` that returns the wrong body still accepts
// connections, and accepting is exactly the behavior under test.
//
// argv[2] is the port. `GET /ready` answers until `GET /wedge` is requested, after which the main
// thread blocks and nothing is ever served again. The block is bounded so an interrupted suite
// cannot leave this running for long; `Atomics.wait` rather than a spin loop so a stranded fixture
// costs a sleeping thread instead of a busy core.
const port = Number(process.argv[2]);
const WEDGE_MS = 60_000;

// Installed for the same reason the daemon installs it: to prove it cannot run. A JS handler
// replaces the kernel's default SIGTERM disposition, so once the loop stops, the signal is queued
// and never dispatched — the process survives a `kill -TERM` that would otherwise have ended it.
process.on("SIGTERM", () => process.exit(0));

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (req) => {
    if (new URL(req.url).pathname === "/wedge") {
      // Blocks shortly AFTER this response is flushed, so the caller gets its reply and the loop
      // stops immediately afterwards.
      setTimeout(() => {
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, WEDGE_MS);
        process.exit(0);
      }, 50);
      return new Response("wedging");
    }
    return new Response("ready");
  },
});
