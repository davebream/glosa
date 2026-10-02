// SPDX-License-Identifier: Apache-2.0
// T8 browser-security fidelity layer. Runs a supported installed Chromium engine with an isolated
// throwaway profile against the production class-F response pipeline. No Playwright/Puppeteer,
// downloaded browser, external service, or user browser profile participates.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CapabilityStore } from "../../packages/daemon/src/security/capability.ts";
import { createClassFFetch } from "../../packages/daemon/src/transport/http.ts";
import { randomPort } from "../../packages/daemon/test/helpers.ts";

const CHROMIUM_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

async function installedChromium(env: NodeJS.ProcessEnv): Promise<{ executable: string; version: string }> {
  for (const executable of CHROMIUM_CANDIDATES) {
    if (!existsSync(executable)) continue;
    const probe = Bun.spawn({ cmd: [executable, "--version"], env, stdout: "pipe", stderr: "ignore" });
    const version = (await new Response(probe.stdout).text()).trim();
    await probe.exited;
    const major = Number(version.match(/\b(\d{3})\b/)?.[1]);
    if (probe.exitCode === 0 && Number.isFinite(major) && major >= 111) return { executable, version };
  }
  throw new Error(`T8 real-browser gate requires installed Chromium >=111; checked: ${CHROMIUM_CANDIDATES.join(", ")}`);
}

interface BrowserResponse {
  id?: number;
  error?: unknown;
  result?: { exceptionDetails?: unknown; result?: { value?: unknown } };
}

async function readBrowserReport(
  child: Bun.Subprocess<"ignore", "ignore", "pipe">,
  port: number,
  deadlineMs: number,
): Promise<string> {
  // --dump-dom with a virtual-time budget can wait indefinitely for navigation, before observing
  // any security result. Read the real page's completed report over CDP instead. Every wait has
  // one wall-clock deadline; browser errors and early exit remain failures, never retries.
  const stderr = new Response(child.stderr).text();
  let failed = false;
  let socket: WebSocket | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: BrowserResponse) => void; reject: (error: Error) => void }>();
  const deadline = Date.now() + deadlineMs;
  try {
    while (!socket) {
      if (child.exitCode !== null) throw new Error(`Chromium exited before its page was ready: ${child.exitCode}`);
      if (Date.now() >= deadline) throw new Error("Chromium page discovery timed out");
      let targets: { type: string; webSocketDebuggerUrl?: string }[] = [];
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
        if (response.ok) targets = await response.json();
      } catch {
        // The browser has not opened its private debugging port yet.
      }
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (!target) {
        await Bun.sleep(50);
        continue;
      }
      socket = new WebSocket(target.webSocketDebuggerUrl!);
      const connected = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Chromium debugging socket timed out")),
          Math.max(1, deadline - Date.now()),
        );
        connected.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        connected.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("Chromium debugging socket failed"));
          },
          { once: true },
        );
      });
    }
    socket.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data)) as BrowserResponse;
      if (response.id !== undefined) pending.get(response.id)?.resolve(response);
    });
    socket.addEventListener("close", () => {
      for (const call of pending.values()) call.reject(new Error("Chromium debugging socket closed"));
    });
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Chromium exited before completing its security report: ${child.exitCode}`);
      const id = ++nextId;
      const response = await new Promise<BrowserResponse>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Chromium security report read timed out")),
          Math.max(1, deadline - Date.now()),
        );
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          },
        });
        socket!.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression: 'document.getElementById("result")?.textContent', returnByValue: true },
          }),
        );
      });
      if (response.error || response.result?.exceptionDetails)
        throw new Error(`Chromium security report evaluation failed: ${JSON.stringify(response)}`);
      const value = response.result?.result?.value;
      if (typeof value === "string" && value !== "pending") return value;
      await Bun.sleep(50);
    }
    throw new Error("Chromium did not complete its security report before the deadline");
  } catch (error) {
    failed = true;
    throw new Error(
      `${error instanceof Error ? error.message : error}; browser PID ${child.pid}, exit ${child.exitCode}`,
      { cause: error },
    );
  } finally {
    socket?.close();
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
    const diagnostics = await Promise.race([stderr, Bun.sleep(2_000).then(() => "<stderr did not close>")]);
    if (failed) process.stderr.write(`Chromium security probe diagnostics:\n${diagnostics.slice(-8_000)}\n`);
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
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    const browser = await installedChromium(childEnv);
    const policyResponse = await fetch(classFUrl);
    const policy = policyResponse.headers.get("Content-Security-Policy");
    await policyResponse.arrayBuffer();
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-forms");
    const debuggingPort = randomPort();
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
        // The throwaway profile must not wait for access to the desktop Keychain.
        "--use-mock-keychain",
        `--user-data-dir=${browserProfile}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${debuggingPort}`,
        classFUrl,
      ],
      env: childEnv,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const serialized = await readBrowserReport(child, debuggingPort, 30_000);
    expect(serialized.length, browser.version).toBeGreaterThan(0);
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
  }, 40_000);
});
