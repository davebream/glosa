// SPDX-License-Identifier: Apache-2.0
// Test-only holder for issue #140's real-parent-death scenarios. Its inherited stdin fd is the
// other end of a socketpair whose peer became the shim's own stdin (`mcp-intermediary.ts` wires
// this up). This process never reads that fd — its only job is to keep it open, which is what
// keeps the shim's stdin from seeing EOF once the intermediary that spawned both of them is gone.
// The owning test kills this process directly, after its assertions.
setInterval(() => {}, 1_000_000);
