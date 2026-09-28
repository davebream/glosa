#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// @glosa/cli executable entrypoint (GLOSA_BIN target — A6 §F26).
// Entrypoint for the public CLI plus internal daemon, MCP, hook-migration, and plugin-monitor commands.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./index.ts";
import { glosaHome } from "../../daemon/src/index.ts";
import { classifyInstall, currentPackageRoot, recordingPlan } from "./install-kind.ts";
import { ensureRecordedExecutable, readPackageType } from "./install-link.ts";

// The CLI inside the desktop app (the macOS bundle, the Linux package) records the app's launcher,
// which supplies the Bun the app carries, and only when nothing is recorded, so a terminal install
// keeps ownership (#371, #432). recordingPlan owns that rule; this is wiring.
const packageRoot = currentPackageRoot();
const { kind } = classifyInstall(packageRoot, existsSync(join(packageRoot, ".git")), readPackageType(packageRoot));
const plan = recordingPlan(kind, packageRoot, import.meta.path);
ensureRecordedExecutable(glosaHome(), plan.executable, { onlyWhenAbsent: plan.onlyWhenAbsent });

const exitCode = await run(Bun.argv.slice(2));
process.exit(exitCode);
