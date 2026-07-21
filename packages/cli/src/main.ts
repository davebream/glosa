#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// @glosa/cli executable entrypoint (GLOSA_BIN target — A6 §F26).
// The full command surface (open/init/resolve/apply-begin/request-review/doctor/status/mcp/hook)
// lands in P5.1; this stub establishes the entrypoint the monorepo + `glosa init` resolve against.
import { run } from "./index.ts";

const exitCode = await run(Bun.argv.slice(2));
process.exit(exitCode);
