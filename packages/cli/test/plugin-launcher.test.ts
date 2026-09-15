// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = join(import.meta.dir, "../../../glosa-plugin/bin/glosa");

describe("Claude plugin launcher", () => {
  test("uses GLOSA_BIN first and never resolves a poisoned PATH glosa", () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-launcher-"));
    const pluginBin = join(root, "plugin", "bin");
    const poison = join(root, "poison");
    mkdirSync(pluginBin, { recursive: true });
    mkdirSync(poison);
    const isolatedLauncher = join(pluginBin, "glosa");
    cpSync(launcher, isolatedLauncher);
    chmodSync(isolatedLauncher, 0o755);
    const fakePathGlosa = join(poison, "glosa");
    writeFileSync(fakePathGlosa, "#!/bin/sh\necho poisoned\n");
    chmodSync(fakePathGlosa, 0o755);

    const missing = Bun.spawnSync({
      cmd: [isolatedLauncher, "--version"],
      env: { HOME: root, PATH: `${poison}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(127);
    expect(missing.stdout.toString()).not.toContain("poisoned");
    expect(missing.stderr.toString()).toContain("npm install --global @davebream/glosa");

    const selected = join(root, "selected-glosa");
    writeFileSync(selected, '#!/bin/sh\necho selected "$@"\n');
    chmodSync(selected, 0o755);
    const explicit = Bun.spawnSync({
      cmd: [isolatedLauncher, "monitor", "--project-dir", "/tmp/example"],
      env: { HOME: root, PATH: `${poison}:/usr/bin:/bin`, GLOSA_BIN: selected },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout.toString()).toBe("selected monitor --project-dir /tmp/example\n");
    rmSync(root, { recursive: true, force: true });
  });
});
