#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// @glosa/cli executable entrypoint (GLOSA_BIN target — A6 §F26).
// Entrypoint for the public CLI plus internal daemon, MCP, hook-migration, and plugin-monitor commands.
import { run } from "./index.ts";
import { glosaHome } from "../../daemon/src/index.ts";
import { ensureRecordedExecutable } from "./install-link.ts";

ensureRecordedExecutable(glosaHome(), import.meta.path);

const exitCode = await run(Bun.argv.slice(2));
process.exit(exitCode);
