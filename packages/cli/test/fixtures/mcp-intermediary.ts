// SPDX-License-Identifier: Apache-2.0
// Test-only intermediary for issue #140's real-parent-death acceptance scenarios. Spawns argv as
// its own child — the "real parent" whose death the test observes — over a socketpair rather than
// a plain pipe: on this runtime, a target process's stdin delivers reliably only when it is a
// fresh, single-hop fd (matching what `Bun.spawn({stdin:"pipe"})` creates internally); a raw
// `pipe(2)` fd handed across two spawn hops does not (verified empirically while building this
// fixture — writes succeed but the target's `process.stdin` never emits `data`).
//
// The peer end of that socketpair is handed to `mcp-stdio-holder.ts`, a second, independent
// process this one spawns and never manages further. That holder never reads its end — it only
// keeps it open — so once THIS process is killed (simulating the real parent dying), the shim's
// stdin still has a live peer and never sees EOF. The owning test talks to the shim by writing to
// THIS process's own stdin and reading its own stdout; both of those are ordinary, single-hop
// pipes the test created directly, so they need no special handling on the read side.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { write as fsWrite } from "node:fs";
import { fileURLToPath } from "node:url";

const HOLDER_PATH = fileURLToPath(new URL("./mcp-stdio-holder.ts", import.meta.url));

const cmd = process.argv.slice(2);
if (cmd.length === 0) throw new Error("mcp-intermediary requires a command to spawn");

const libSystem = dlopen("libSystem.B.dylib", {
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});
const AF_UNIX = 1;
const SOCK_STREAM = 1;

function socketPair(): [number, number] {
  const fds = new Int32Array(2);
  const rc = libSystem.symbols.socketpair(AF_UNIX, SOCK_STREAM, 0, ptr(fds));
  if (rc !== 0) throw new Error("socketpair() failed");
  return [fds[0]!, fds[1]!];
}

const [shimStdinFd, holderPeerFd] = socketPair();

const shim = Bun.spawn({
  cmd,
  env: process.env as Record<string, string>,
  cwd: process.cwd(),
  stdin: shimStdinFd,
  stdout: "pipe",
  stderr: "ignore",
});

const holder = Bun.spawn({
  cmd: [process.execPath, HOLDER_PATH],
  stdin: holderPeerFd,
  stdout: "ignore",
  stderr: "ignore",
});
holder.unref();

process.stderr.write(`child_pid=${shim.pid} holder_pid=${holder.pid}\n`);

// F-4 mode: die immediately, so the shim's real parent is gone before the shim's own module load
// finishes and its first `process.ppid` read can only ever see the reaper. The holder keeps the
// shim's stdin open, so EOF never arrives either. Nothing relays I/O in this mode and nothing
// needs to: the scenario's whole question is whether the shim notices and exits by itself.
if (process.env.GLOSA_TEST_INTERMEDIARY_EXIT_IMMEDIATELY === "1") process.exit(0);

// Relay the shim's stdout back to our own stdout — a single, ordinary hop the owning test reads.
(async () => {
  const reader = (shim.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    process.stdout.write(value);
  }
})();

// Relay the owning test's writes (our own stdin, also a single ordinary hop) into the shim's
// stdin via the socketpair. A raw fd write, never a second Readable-stream hop on the read side.
process.stdin.on("data", (chunk: Buffer) => {
  fsWrite(holderPeerFd, chunk, () => {});
});

await new Promise<void>((resolve) => process.stdin.once("end", resolve));
