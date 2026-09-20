// SPDX-License-Identifier: Apache-2.0
// Test-only fixture for issue #281's hardlink-alias Worker failure path: answers every request
// with a clean `{status: "error"}` reply — exactly how the production
// `hardlink-alias-worker.ts` reports an internal failure (its own top-level try/catch never lets
// an exception escape uncaught). Deterministic and avoids racing a real scan.
self.onmessage = () => {
  postMessage({ status: "error", message: "simulated hardlink-alias worker failure" });
};
