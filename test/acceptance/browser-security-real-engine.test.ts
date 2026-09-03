// SPDX-License-Identifier: Apache-2.0
// T8 browser-security fidelity layer. Runs a supported installed Chromium engine with an isolated
// throwaway profile against the production class-F response pipeline. No Playwright/Puppeteer,
// downloaded browser, external service, or user browser profile participates.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CapabilityStore } from "../../packages/daemon/src/capability.ts";
import { createClassFFetch } from "../../packages/daemon/src/http.ts";
import { randomPort } from "../../packages/daemon/test/helpers.ts";

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

function installedChromium(): { executable: string; version: string } {
  for (const executable of CHROMIUM_CANDIDATES) {
    if (!existsSync(executable)) continue;
    const probe = Bun.spawnSync({ cmd: [executable, "--version"], stdout: "pipe", stderr: "pipe" });
    const version = probe.stdout.toString().trim();
    const major = Number(version.match(/\b(\d{3})\b/)?.[1]);
    if (probe.exitCode === 0 && Number.isFinite(major) && major >= 111) return { executable, version };
  }
  throw new Error(`T8 real-browser gate requires installed Chromium >=111; checked: ${CHROMIUM_CANDIDATES.join(", ")}`);
}

async function readBrowserDump(child: Bun.Subprocess<"ignore", "pipe", "ignore">, deadlineMs: number): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + deadlineMs;
  try {
    while (!output.includes("</html>")) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Chromium did not emit a complete --dump-dom document before the deadline");
      const result = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => ({ timeout: true }) as const)]);
      if ("timeout" in result) throw new Error("Chromium --dump-dom timed out");
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    try {
      await reader.cancel();
    } catch {
      // the child closing stdout first is the normal successful path
    }
    reader.releaseLock();
  }
}

describe("A3 §5 attacks #1/#2 — production class-F CSP honored by a real browser engine", () => {
  let artifactDir: string;
  let browserProfile: string;
  let classFServer: ReturnType<typeof Bun.serve>;
  let probeServer: ReturnType<typeof Bun.serve>;
  let classFUrl: string;
  let probeHits: number;

  beforeEach(() => {
    artifactDir = mkdtempSync(join(tmpdir(), "glosa-browser-artifact-"));
    browserProfile = mkdtempSync(join(tmpdir(), "glosa-browser-profile-"));
    const classFPort = randomPort();
    const probePort = randomPort();
    probeHits = 0;

    probeServer = Bun.serve({
      hostname: "127.0.0.1",
      port: probePort,
      fetch: () => {
        probeHits += 1;
        return new Response("probe reached");
      },
    });

    const artifact = join(artifactDir, "hostile.html");
    writeFileSync(
      artifact,
      `<!doctype html><html><body><iframe name="form-target" hidden></iframe><pre id="result">pending</pre>
<script>
(async function () {
  var violations = [];
  document.addEventListener("securitypolicyviolation", function (event) {
    violations.push(event.violatedDirective);
  });
  var report = { storage: "allowed", fetch: "allowed", websocket: "allowed", image: "allowed", form: "pending" };
  try { localStorage.setItem("glosa_probe", "secret"); } catch (_) { report.storage = "blocked"; }
  try { await fetch("http://127.0.0.1:${probePort}/fetch"); } catch (_) { report.fetch = "blocked"; }
  report.websocket = await new Promise(function (resolve) {
    try {
      var ws = new WebSocket("ws://127.0.0.1:${probePort}/socket");
      ws.onopen = function () { resolve("allowed"); };
      ws.onerror = function () { resolve("blocked"); };
      setTimeout(function () { resolve("blocked"); }, 250);
    } catch (_) { resolve("blocked"); }
  });
  report.image = await new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () { resolve("allowed"); };
    img.onerror = function () { resolve("blocked"); };
    img.src = "http://127.0.0.1:${probePort}/image.png";
    setTimeout(function () { resolve("blocked"); }, 250);
  });
  var form = document.createElement("form");
  form.action = "http://127.0.0.1:${probePort}/form";
  form.method = "POST";
  form.target = "form-target";
  document.body.appendChild(form);
  try { form.submit(); } finally { report.form = "attempted"; }
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  report.violations = Array.from(new Set(violations)).sort();
  document.getElementById("result").textContent = JSON.stringify(report);
})();
</script></body></html>`,
    );

    const store = new CapabilityStore();
    const minted = store.mint({
      slug: "browser-acceptance",
      artifactDirRealPath: realpathSync(artifactDir),
      artifactBasename: basename(artifact),
    });
    const classFFetch = createClassFFetch({ port: classFPort, spaPort: classFPort + 1, capabilityStore: store });
    classFServer = Bun.serve({ hostname: "127.0.0.1", port: classFPort, fetch: classFFetch });
    classFUrl = `http://127.0.0.1:${classFPort}/doc/${minted.token}/${basename(artifact)}`;
  });

  afterEach(async () => {
    await Promise.allSettled([classFServer.stop(true), probeServer.stop(true)]);
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(browserProfile, { recursive: true, force: true });
  });

  test("direct navigation has opaque storage and remote fetch/WebSocket/image/form attempts violate CSP", async () => {
    const browser = installedChromium();
    const policyResponse = await fetch(classFUrl);
    const policy = policyResponse.headers.get("Content-Security-Policy");
    await policyResponse.arrayBuffer();
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-forms");
    const child = Bun.spawn({
      cmd: [
        browser.executable,
        "--headless=new",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-gpu",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${browserProfile}`,
        "--virtual-time-budget=1500",
        "--dump-dom",
        classFUrl,
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
    const dom = await readBrowserDump(child, 10_000);
    expect(dom.length, browser.version).toBeGreaterThan(0);
    const serialized = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    expect(serialized).toBeString();
    const report = JSON.parse(serialized!) as {
      storage: string;
      fetch: string;
      websocket: string;
      image: string;
      form: string;
      violations: string[];
    };
    expect(report).toMatchObject({
      storage: "blocked",
      fetch: "blocked",
      websocket: "blocked",
      image: "blocked",
      form: "attempted",
    });
    // Chromium blocks the form at the stricter CSP sandbox gate because allow-forms is omitted,
    // before it evaluates form-action. It therefore emits no form-action violation event. The
    // attempted marker plus zero probe hits exercise that path; the production response assertion
    // above separately proves form-action remains deny-all as defense in depth.
    expect(report.violations).toContain("connect-src");
    expect(report.violations).toContain("img-src");
    expect(probeHits).toBe(0);
  }, 15_000);
});
