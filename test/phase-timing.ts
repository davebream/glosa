// SPDX-License-Identifier: Apache-2.0
import { beforeEach as registerBefore, afterEach as registerAfter } from "bun:test";
import { appendFileSync } from "node:fs";

/** Per-file fixture diagnostics only; no shared fixture state and no change to test scheduling. */
export function timedHooks(file: string) {
  let setupMs = 0;
  let bodyStart = 0;
  return {
    beforeEach(callback: () => unknown | Promise<unknown>, timeout?: number) {
      registerBefore(async () => {
        const start = performance.now();
        try {
          await callback();
        } finally {
          setupMs = performance.now() - start;
          bodyStart = performance.now();
        }
      }, timeout);
    },
    afterEach(callback: () => unknown | Promise<unknown>, timeout?: number) {
      registerAfter(async () => {
        const start = performance.now();
        const bodyMs = start - bodyStart;
        try {
          await callback();
        } finally {
          if (process.env.GLOSA_TEST_PHASE_REPORT)
            appendFileSync(
              process.env.GLOSA_TEST_PHASE_REPORT,
              `${JSON.stringify({ file, setupMs, bodyMs, cleanupMs: performance.now() - start })}\n`,
            );
        }
      }, timeout);
    },
  };
}
