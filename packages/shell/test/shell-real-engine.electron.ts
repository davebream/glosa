// SPDX-License-Identifier: Apache-2.0
// The A3 §5 browser-security posture inside the shell's own renderer (issue #160 contract: "the
// A3 §5 browser-security suite must run inside the shell's renderer as well as in Chromium").
// Real, not simulated: one `glosa __daemon` from this checkout on a throwaway home, the real CLI
// as the shell's `glosa open`, the real main.ts and preload.cjs in the Electron this package
// installed, observed over Chrome DevTools Protocol on a port this test chose. Skips, with the
// reason in its name, only when Electron is not installed here (`bun install --cwd packages/shell`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../../daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../daemon/test/helpers.ts";
import { PAPER } from "../src/policy.ts";

const SHELL_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
// The Electron binary itself (what `node_modules/electron/path.txt` names), not the `.bin/electron`
// Node wrapper: a signal must reach the process the test means to stop, and a SIGKILL to the
// wrapper would leave Electron running, orphaned.
const ELECTRON_PACKAGE = join(SHELL_DIR, "node_modules", "electron");
const ELECTRON = existsSync(join(ELECTRON_PACKAGE, "path.txt"))
  ? join(ELECTRON_PACKAGE, "dist", readFileSync(join(ELECTRON_PACKAGE, "path.txt"), "utf8").trim())
  : "";
const MAIN_PATH = join(REPO, "packages", "cli", "src", "main.ts");
const PROBE = join(REPO, "docs", "research", "spikes", "electron-classf-probe.html");
const SHELL_PRELOAD = join(SHELL_DIR, "src", "preload.cjs");
const TOKEN = "shell-test-durable-token-0123456789abcdef0123456789abcdef";
const SHELL_VERSION = (JSON.parse(readFileSync(join(SHELL_DIR, "package.json"), "utf8")) as { version: string })
  .version;
const electronInstalled = ELECTRON !== "" && existsSync(ELECTRON);

type Handshake = { instance_id: string; install_id: string };

async function waitForHandshake(port: number, deadlineMs: number, child: Bun.Subprocess): Promise<Handshake | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/handshake`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return (await res.json()) as Handshake;
    } catch {
      /* not yet */
    }
    await Bun.sleep(100);
  }
  return null;
}

/** The smallest CDP client this needs: one socket, JSON-RPC ids, optional flat session routing. */
class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  static async connect(url: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve(), { once: true });
      c.ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), { once: true });
    });
    c.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    return c;
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 10_000);
    });
  }
  async evaluate<T>(expression: string, sessionId?: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
  /** Evaluates in Electron's MAIN process over its Node inspector (`--inspect`), where the
   * inspector's command-line API supplies `require`, so `require('electron')` reads the real
   * `BrowserWindow` and `nativeTheme` the shell drives. */
  async evaluateInMain<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: unknown } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
    );
    if (r.exceptionDetails) throw new Error(`main-process evaluate threw: ${JSON.stringify(r.exceptionDetails)}`);
    return r.result.value;
  }
  close(): void {
    this.ws.close();
  }
}

/** A local stand-in for GitHub's Releases API on a port this test owns, recording every request.
 * The shell reaches it through GLOSA_SHELL_RELEASES_API, which only an unpackaged app reads. */
function releasesStub(answer: () => Response) {
  const requests: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, headers: req.headers.toJSON() });
      return answer();
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/repos/davebream/glosa/releases`,
    requests,
    stop: () => server.stop(true),
  };
}

/** Clicks Check for Updates… `times` times, back to back, from the main process, once the menu exists. */
async function clickCheckForUpdates(main: Cdp, times: number): Promise<void> {
  // An update check is exercised here for its menu, request and result. A native result dialog
  // would interrupt a local run; trap any attempt so the hidden-mode guard has a named failure.
  await main.evaluateInMain(`(() => {
    const { dialog } = require('electron');
    globalThis.__glosaUpdateDialogs = 0;
    dialog.showMessageBox = async () => { globalThis.__glosaUpdateDialogs++; return { response: 0 }; };
    return true;
  })()`);
  const clicked = await main.evaluateInMain<boolean>(`(async () => {
    const { Menu } = require('electron');
    // 5 s, well inside the CDP call's own 10 s, so a missing item fails the assertion below.
    for (let i = 0; i < 50; i++) {
      const item = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates');
      if (item) {
        for (let n = 0; n < ${times}; n++) item.click();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  expect(clicked, "the app menu has an item with id check-for-updates").toBe(true);
}

/**
 * The pids of every process whose command line names `marker`. Electron passes the test's
 * `--user-data-dir` to its GPU, network and renderer helpers as well as to its main process, and
 * that directory's name is unique to one test, so the marker names exactly the processes a test
 * owns (measured in Electron 44.4.5). The name, not the whole path, because the temp prefix may be
 * spelled `/var/...` or `/private/var/...`.
 */
function ownedPids(marker: string): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString();
  return out
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

/** Every target seen on the last poll, for the failure message. */
let lastTargets: string[] = [];
async function listTargets(
  cdpPort: number,
  deadlineMs: number,
  predicate: (t: { type: string; url: string }) => boolean,
) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(500) });
      const targets = (await res.json()) as Array<{
        id: string;
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }>;
      lastTargets = targets.map((t) => `${t.type} ${t.url.slice(0, 120)}`);
      const hit = targets.find(predicate);
      if (hit) return hit;
    } catch {
      /* not yet */
    }
    await Bun.sleep(200);
  }
  return null;
}

/** The main process's inspector target (`--inspect=<port>`), or null past the deadline. */
async function mainInspectorUrl(inspectPort: number): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(500) });
      const url = ((await res.json()) as Array<{ webSocketDebuggerUrl?: string }>)[0]?.webSocketDebuggerUrl;
      if (url) return url;
    } catch {
      /* not yet */
    }
    await Bun.sleep(100);
  }
  return null;
}

/** True once the page has paired and mounted the workspace (its appearance control exists). */
async function workspaceMounted(cdp: Cdp): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    try {
      if (
        await cdp.evaluate<boolean>(
          "Boolean(document.querySelector('.glosa-appearance-option[data-appearance=\"dark\"]'))",
        )
      )
        return true;
    } catch {
      // the context can be replaced while the page loads
    }
    await Bun.sleep(200);
  }
  return false;
}

describe.skipIf(!electronInstalled)(
  "desktop shell: A3 §5 posture in the shell's renderer (real Electron, real daemon)",
  () => {
    let home: string;
    let workspace: string;
    let userHome: string;
    let userData: string;
    let port: number;
    let cdpPort: number;
    let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
    let electron: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
    let cli: string;
    let stderrText = "";
    let env: Record<string, string>;
    // Every launch's update check points here unless a test names its own stub: a local endpoint
    // that answers 503, so a check that ran when it should not stays on this machine and fails.
    let closedReleases: ReturnType<typeof releasesStub> | null = null;

    /** Starts the shell with `args` after the app directory, the way `open -a` or a link would. */
    const launchShell = (args: string[], extra: Record<string, string> = {}, ownProfile = false) => {
      electron = Bun.spawn({
        cmd: [
          ELECTRON,
          SHELL_DIR,
          ...args,
          `--remote-debugging-port=${cdpPort}`,
          ...(ownProfile ? [] : [`--user-data-dir=${userData}`]),
        ],
        env: {
          ...env,
          GLOSA_SHELL_CLI: cli,
          GLOSA_SHELL_RELEASES_API: closedReleases!.url,
          ANTHROPIC_API_KEY: "sk-must-never-reach-a-child",
          ...extra,
          GLOSA_SHELL_HIDDEN: "yes",
          ...(ownProfile ? { GLOSA_SHELL_TEST_PROFILE: userData } : {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      stderrText = "";
      const started = electron;
      void (async () => {
        for await (const chunk of started.stderr) stderrText += new TextDecoder().decode(chunk);
      })();
    };

    beforeEach(async () => {
      closedReleases = releasesStub(() => new Response("releases are closed to this test", { status: 503 }));
      home = mkdtempSync(join(tmpdir(), "glosa-shell-home-"));
      userHome = mkdtempSync(join(tmpdir(), "glosa-shell-userhome-"));
      // Electron keeps localStorage under its userData directory, which it derives from the macOS
      // user, not from $HOME. Without a private one, a pairing from an earlier run at the same port
      // makes "paired via the bridge" pass with the bridge deleted (it did, once).
      userData = mkdtempSync(join(tmpdir(), "glosa-shell-userdata-"));
      workspace = mkdtempSync(join(tmpdir(), "glosa-shell-ws-"));
      mkdirSync(join(workspace, "classf"));
      writeFileSync(join(workspace, "classf", "probe.html"), readFileSync(PROBE));
      writeFileSync(join(workspace, "readme.md"), "# Fixture\n\nA fixture for the shell suite.\n");
      writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
      superviseDaemonHome(home);
      // The shell's `glosa open` is this checkout's CLI, run by the Bun running this test.
      cli = join(home, "glosa-cli.sh");
      writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${MAIN_PATH}" "$@"\n`, { mode: 0o755 });

      port = randomPort();
      cdpPort = randomPort();
      env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: userHome,
        GLOSA_HOME: home,
        GLOSA_PORT: String(port),
        GLOSA_CLASSF_PORT: String(port + 1),
      };
      daemon = Bun.spawn({
        cmd: [process.execPath, MAIN_PATH, "__daemon"],
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const hs = await waitForHandshake(port, 15_000, daemon);
      expect(hs, "daemon handshake").not.toBeNull();
    }, 60_000);

    afterEach(async () => {
      if (electron) {
        electron.kill();
        // An update check's result dialog with no window to attach to is app-modal, and holds a
        // graceful quit while it waits for a person. The process is this test's own, so it goes.
        const quit = await Promise.race([electron.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
        if (!quit) electron.kill("SIGKILL");
        await electron.exited;
      }
      // The main process exiting is not the whole tree: wait for every helper this test owns to go,
      // then kill and report any that did not, so a survivor fails the suite instead of outliving it.
      const marker = basename(userData);
      const settled = Date.now() + 5_000;
      while (ownedPids(marker).length > 0 && Date.now() < settled) await Bun.sleep(100);
      const survivors = ownedPids(marker);
      for (const pid of survivors) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      daemon.kill();
      await daemon.exited;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
      closedReleases?.stop();
      closedReleases = null;
      expect(survivors, `Electron processes outlived the test (${marker})`).toEqual([]);
    }, 20_000);

    test("hidden test mode keeps windows off screen while the renderer runs animation frames (#447)", async () => {
      const inspectPort = randomPort();
      launchShell([workspace, "readme.md", `--inspect=${inspectPort}`]);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(page, `SPA page target; shell stderr:\n${stderrText}`).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      try {
        expect(await workspaceMounted(cdp), `the workspace mounted; shell stderr:\n${stderrText}`).toBe(true);
        const windows = await main.evaluateInMain<{
          count: number;
          visible: number;
          throttled: number;
          focused: boolean;
          dockVisible: boolean | null;
        }>(`(() => {
          const { app, BrowserWindow } = require('electron');
          const all = BrowserWindow.getAllWindows();
          return { count: all.length, visible: all.filter((w) => w.isVisible()).length,
            throttled: all.filter((w) => w.webContents.getBackgroundThrottling()).length,
            focused: BrowserWindow.getFocusedWindow() !== null,
            dockVisible: process.platform === 'darwin' ? app.dock.isVisible() : null };
        })()`);
        expect(windows.count).toBeGreaterThan(0);
        expect(windows.visible, "no shell window is visible").toBe(0);
        // Electron initially treats show:false pages as visible, so rAF alone cannot catch a
        // missing throttle override. Read the effective setting from the real WebContents too.
        expect(windows.throttled, "hidden shell windows keep background throttling disabled").toBe(0);
        expect(windows.focused, "the shell has no focused window").toBe(false);
        if (process.platform === "darwin") expect(windows.dockVisible, "the shell has no Dock icon").toBe(false);
        // Electron reports a page as visible when background throttling is disabled, even though
        // BrowserWindow.isVisible() is false. The real contract is no native UI and live frames.
        const framed = await cdp.evaluate<boolean>(
          `Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
          ])`,
        );
        expect(framed, "a hidden window still runs animation frames").toBe(true);
      } finally {
        cdp.close();
        main.close();
      }
    }, 120_000);

    test("development shell uses its checkout CLI and a private Electron profile", async () => {
      // The recorded decoy would fail if the shell looked up the install of truth instead of its checkout.
      const recorded = join(home, "bin", "glosa");
      rmSync(recorded);
      writeFileSync(recorded, "#!/bin/sh\nexit 33\n", { mode: 0o755 });
      launchShell([workspace, "readme.md"], { GLOSA_SHELL_CLI: "" }, true);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(
        cdpPort,
        60_000,
        (target) => target.type === "page" && target.url.startsWith(spaOrigin),
      );
      expect(page, `dev shell page; stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      try {
        expect(await workspaceMounted(cdp), `checkout CLI opened the workspace; stderr:\n${stderrText}`).toBe(true);
        expect(existsSync(join(userData, "session"))).toBe(true);
      } finally {
        cdp.close();
      }
    }, 70_000);

    test("pairs over the bridge with no token in any URL, keeps class-F sandboxed, denies leaving the SPA origin, and leaves the daemon running on quit", async () => {
      launchShell([workspace, "classf/probe.html"]);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(
        page,
        `SPA page target at ${spaOrigin}; targets seen: ${JSON.stringify(lastTargets)}; shell stderr:\n${stderrText}`,
      ).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      try {
        // Paired through the preload bridge: the window URL never carried p= or t=.
        let durable: string | null = null;
        for (let i = 0; i < 100 && !durable; i++) {
          try {
            durable = await cdp.evaluate<string | null>("localStorage.getItem('glosa_token')");
          } catch {
            // The page's context can be replaced while it loads; a throw here is a retry, not a
            // verdict (one run in five failed on it before this).
            durable = null;
          }
          if (!durable) await Bun.sleep(200);
        }
        expect(durable, `paired via bridge; shell stderr:\n${stderrText}`).toBeString();
        expect(await cdp.evaluate<string>("location.href")).not.toMatch(/[#&](p|t)=/);
        expect(await cdp.evaluate<string>("typeof window.glosaShell")).toBe("object");
        // Reveal in Finder is on the bridge, and takes no argument (#160). Not called: it would
        // open Finder on the machine running the test.
        expect(await cdp.evaluate<string>("typeof window.glosaShell.revealInFinder")).toBe("function");
        expect(await cdp.evaluate<number>("window.glosaShell.revealInFinder.length")).toBe(0);
        // One-shot (R-P2): a second ask gets nothing.
        expect(await cdp.evaluate<string | null>("window.glosaShell.presentationToken()")).toBeNull();

        // Session history carries no secret (the token the bridge handed over is the only one that
        // could have; the durable token is what the page redeemed it for).
        const history = await cdp.send<{ entries: Array<{ url: string }> }>("Page.getNavigationHistory");
        for (const entry of history.entries) {
          expect(entry.url).not.toMatch(/[#&](p|t)=/);
          expect(entry.url).not.toContain(durable!);
        }

        // The top frame cannot leave the SPA origin, and cannot open windows.
        expect(await cdp.evaluate<null | string>("String(window.open('https://example.com/'))")).toBe("null");
        await cdp.evaluate("(location.href = 'https://example.com/', true)");
        await Bun.sleep(750);
        expect(new URL(await cdp.evaluate<string>("location.href")).origin).toBe(spaOrigin);
        expect(stderrText).toContain("denied navigation to https://example.com");

        // The class-F frame: its own origin, the probe's verdicts, and no bridge inside it.
        const frame = await listTargets(
          cdpPort,
          20_000,
          (t) => t.type === "iframe" && t.url.startsWith(`http://127.0.0.1:${port + 1}/`),
        );
        expect(frame, `class-F iframe target; shell stderr:\n${stderrText}`).not.toBeNull();
        const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: frame!.id,
          flatten: true,
        });

        let probe = "";
        for (let i = 0; i < 50 && !probe.includes("img="); i++) {
          probe = await cdp.evaluate<string>("document.getElementById('out')?.textContent ?? ''", attached.sessionId);
          if (!probe.includes("img=")) await Bun.sleep(200);
        }
        expect(probe).toContain(`origin=http://127.0.0.1:${port + 1}`);
        expect(probe).toContain("storage=blocked");
        expect(probe).toContain("fetch=blocked");
        expect(probe).toContain("img=blocked");
        expect(probe).toContain("open=blocked");
        expect(probe).toContain("topnav=blocked");
        expect(await cdp.evaluate<string>("typeof window.glosaShell", attached.sessionId)).toBe("undefined");
      } finally {
        cdp.close();
      }

      // R-O4: quitting the shell leaves the daemon it did not spawn exactly where it was.
      const before = (await (await fetch(`http://127.0.0.1:${port}/api/handshake`)).json()) as Handshake;
      electron!.kill();
      await electron!.exited;
      electron = null;
      await Bun.sleep(500);
      const after = (await (await fetch(`http://127.0.0.1:${port}/api/handshake`)).json()) as Handshake;
      expect(after.instance_id).toBe(before.instance_id);
    }, 120_000);

    test("switching glosa to Dark and Light sets the window's paper and themeSource, keeps the Dock on macOS's appearance, and refuses the call from a window the shell did not open for the SPA (#405)", async () => {
      const inspectPort = randomPort();
      launchShell([workspace, "readme.md", `--inspect=${inspectPort}`]);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(
        page,
        `SPA page target; targets seen: ${JSON.stringify(lastTargets)}; shell stderr:\n${stderrText}`,
      ).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector on ${inspectPort}; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      try {
        // The appearance control exists once the page has paired and mounted the workspace.
        expect(await workspaceMounted(cdp), `the workspace's appearance control; shell stderr:\n${stderrText}`).toBe(
          true,
        );

        const osDark = await main.evaluateInMain<boolean>(
          "require('electron').systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'",
        );
        const windowState = () =>
          main.evaluateInMain<{ themeSource: string; dark: boolean; background: string | null }>(`(() => {
            const { BrowserWindow, nativeTheme } = require('electron');
            const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(${JSON.stringify(spaOrigin)}));
            return { themeSource: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors,
              background: win ? win.getBackgroundColor().toLowerCase() : null };
          })()`);
        const pagePaper = () =>
          cdp.evaluate<{ paper: string; prefersDark: boolean }>(`(() => {
            const context = document.createElement('canvas').getContext('2d');
            context.fillStyle = getComputedStyle(document.body).backgroundColor;
            context.fillRect(0, 0, 1, 1);
            const paper = '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
              .map((v) => v.toString(16).padStart(2, '0')).join('');
            return { paper, prefersDark: matchMedia('(prefers-color-scheme: dark)').matches };
          })()`);
        const choose = async (scheme: "light" | "dark") => {
          await cdp.evaluate(`document.querySelector('.glosa-appearance-option[data-appearance="${scheme}"]').click()`);
          let seen = await windowState();
          for (let i = 0; i < 50 && seen.themeSource !== scheme; i++) {
            await Bun.sleep(100);
            seen = await windowState();
          }
          return seen;
        };

        // Light first, then Dark: whichever the OS is, one of the two is the opposite of it, which
        // is where a Dock that followed `nativeTheme` would have changed.
        for (const scheme of ["light", "dark"] as const) {
          const seen = await choose(scheme);
          const painted = await pagePaper();
          expect(seen.themeSource, `themeSource after choosing ${scheme}; shell stderr:\n${stderrText}`).toBe(scheme);
          expect(seen.dark).toBe(scheme === "dark");
          expect(seen.background, `the window's paper in ${scheme}`).toBe(painted.paper);
          expect(painted.paper, "the shell's own first-frame paper is the page's").toBe(PAPER[scheme]);
          // themeSource reaches the page too: prefers-color-scheme follows glosa, not the OS.
          expect(painted.prefersDark).toBe(scheme === "dark");
        }
        const dockLines = stderrText.match(/dock icon follows macOS: (dark|light)/g) ?? [];
        expect(dockLines, `the Dock icon was set once, from macOS's appearance; shell stderr:\n${stderrText}`).toEqual([
          `dock icon follows macOS: ${osDark ? "dark" : "light"}`,
        ]);

        // A window the shell did not open for the SPA: the shell's own preload, told the daemon's
        // IP origin, on a page at that origin. The preload exposes the bridge there, so the call
        // reaches the main process, and only its origin check stands between the page and the
        // process-wide themeSource.
        const refused = await main.evaluateInMain<string>(`(async () => {
          const { BrowserWindow } = require('electron');
          const other = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(SHELL_PRELOAD)},
            sandbox: true, contextIsolation: true, additionalArguments: ['--glosa-spa-origin=http://127.0.0.1:${port}'] } });
          try {
            await other.loadURL('http://127.0.0.1:${port}/api/handshake');
            return await other.webContents.executeJavaScript(
              "window.glosaShell.reportAppearance({ source: 'light', scheme: 'light', background: '#000000' })" +
              ".then(() => 'accepted', (error) => String(error.message))");
          } finally {
            other.destroy();
          }
        })()`);
        expect(refused).toContain("rejected: not the SPA origin");
        const after = await windowState();
        expect(after.themeSource, "a refused call leaves themeSource alone").toBe("dark");
        expect(after.background, "and the SPA window's paper").toBe(PAPER.dark);
      } finally {
        cdp.close();
        main.close();
      }
    }, 120_000);

    // What this drives is an overridden `nativeTheme.shouldUseHighContrastColors` getter and a
    // manually emitted `updated` event in the real main process, not macOS: that turning Increase
    // contrast on changes the getter and fires `updated` is read from Electron's and Chromium's
    // source, and stays a manual check on a Mac (docs/accessibility.md).
    test("an overridden nativeTheme.shouldUseHighContrastColors, emitted as updated, turns glosa's own palette into High contrast live (theme, Settings' sentence, the window's paper) and back, paints a reloaded document High contrast from its first frame, never reports more contrast to or reaches a window the shell did not open for the SPA, and pushes nothing to a blocking screen loaded into one it did (#425)", async () => {
      const inspectPort = randomPort();
      launchShell([workspace, "readme.md", `--inspect=${inspectPort}`]);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(
        page,
        `SPA page target; targets seen: ${JSON.stringify(lastTargets)}; shell stderr:\n${stderrText}`,
      ).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector on ${inspectPort}; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      const GETTER = "shouldUseHighContrastColors";
      /** Replaces the getter on the real `nativeTheme`, keeping the original descriptor to restore:
       * `delete` would leave the property undefined rather than Electron's own. */
      const override = (value: boolean) =>
        main.evaluateInMain(`(() => {
          const { nativeTheme } = require('electron');
          if (!('saved' in (globalThis.__glosaContrast ??= {})))
            globalThis.__glosaContrast.saved = Object.getOwnPropertyDescriptor(nativeTheme, '${GETTER}');
          Object.defineProperty(nativeTheme, '${GETTER}', { configurable: true, enumerable: true, get: () => ${value} });
          return true;
        })()`);
      const emitUpdated = () => main.evaluateInMain("(require('electron').nativeTheme.emit('updated'), true)");
      const spaWindow = `require('electron').BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(${JSON.stringify(spaOrigin)}))`;
      const SENTINEL = "#010203";
      const windowBackground = () =>
        main.evaluateInMain<string | null>(`(${spaWindow})?.getBackgroundColor().toLowerCase() ?? null`);
      const painted = () =>
        cdp.evaluate<{ theme: string; hint: string | null; bridge: boolean }>(`(() => {
          const hint = document.querySelector('.glosa-settings-palettes + .glosa-settings-hint');
          const shown = hint && !hint.hidden && hint.getBoundingClientRect().height > 0;
          return { theme: document.documentElement.dataset.theme, hint: shown ? hint.textContent : null,
            bridge: window.glosaShell.moreContrast() };
        })()`);
      /** Sets the getter, paints the window with a colour no theme has, emits `updated`, and
       * returns once the page shows `theme` and has reported its paper again (or the deadline). */
      const flip = async (value: boolean, theme: string) => {
        await override(value);
        await main.evaluateInMain(`((${spaWindow}).setBackgroundColor('${SENTINEL}'), true)`);
        await emitUpdated();
        let seen = await painted();
        let background = await windowBackground();
        for (let i = 0; i < 50 && (seen.theme !== theme || background === SENTINEL); i++) {
          await Bun.sleep(100);
          seen = await painted();
          background = await windowBackground();
        }
        return { ...seen, background };
      };
      const SENTENCE =
        "Increase contrast is on for this Mac, so glosa shows High contrast. glosa's own palette returns when it is off.";
      try {
        expect(await workspaceMounted(cdp), `the workspace's appearance control; shell stderr:\n${stderrText}`).toBe(
          true,
        );
        // Whatever this Mac's own setting, the test starts from "no more contrast", and in Light so
        // the themes it expects are fixed.
        await override(false);
        await emitUpdated();
        await cdp.evaluate(`document.querySelector('.glosa-appearance-option[data-appearance="light"]').click()`);
        // Settings opens only once the workspace's dock exists, which can be after its appearance
        // control does, so the click repeats until Settings shows (opening it again only selects it).
        await cdp.evaluate(`(async()=>{
          const deadline=Date.now()+8000;
          let item=null;
          let clicked=0;
          while(!(item=[...document.querySelectorAll('.glosa-settings-nav button')].find(b=>b.textContent==='Appearance'))) {
            if(Date.now()>deadline) throw new Error('Settings never opened');
            if(Date.now()-clicked>250) { document.querySelector('.glosa-sidebar-settings').click(); clicked=Date.now(); }
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
          item.click();
          while(!document.querySelector('.glosa-settings-palettes:not([hidden]) [data-palette-choice]')?.getBoundingClientRect().height) {
            if(Date.now()>deadline) throw new Error('Settings > Appearance never showed its palettes');
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
        })()`);
        expect(await painted()).toEqual({ theme: "light", hint: null, bridge: false });
        const logFrom = stderrText.length;

        // AC2: on, live, without a reload; then off again.
        const on = await flip(true, "high-contrast-light");
        expect(on, `after the getter turned on; shell stderr:\n${stderrText}`).toEqual({
          theme: "high-contrast-light",
          hint: SENTENCE,
          bridge: true,
          // High contrast keeps glosa's paper; the page reported it again, over the sentinel.
          background: PAPER.light,
        });
        const off = await flip(false, "light");
        expect(off, `after the getter turned off; shell stderr:\n${stderrText}`).toEqual({
          theme: "light",
          hint: null,
          bridge: false,
          background: PAPER.light,
        });
        expect(stderrText.slice(logFrom).match(/more contrast: (on|off)/g)).toEqual([
          "more contrast: on",
          "more contrast: off",
        ]);

        // AC1: the getter turns on after this window exists, and the document the window loads next
        // paints High contrast from its first frame. A recorder registered for every new document
        // keeps each value <html data-theme> ever held, and the theme at the first animation frame.
        expect(await flip(true, "high-contrast-light")).toMatchObject({ theme: "high-contrast-light" });
        await cdp.send("Page.enable");
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `(() => {
            const themes = [];
            window.__glosaThemes = themes;
            const note = (value) => { if (typeof value === 'string' && themes[themes.length - 1] !== value) themes.push(value); };
            new MutationObserver((records) => {
              for (const record of records) if (record.target === document.documentElement) note(record.oldValue);
              note(document.documentElement?.dataset.theme);
            }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-theme'] });
            requestAnimationFrame(() => { window.__glosaFirstFrame = document.documentElement.dataset.theme ?? null; });
          })()`,
        });
        await cdp.send("Page.reload");
        let recorded: { first: string | null; themes: string[] } | null = null;
        for (let i = 0; i < 150 && !recorded; i++) {
          try {
            recorded = await cdp.evaluate<{ first: string | null; themes: string[] } | null>(
              "'__glosaFirstFrame' in window && document.querySelector('.glosa-appearance-option') ? { first: window.__glosaFirstFrame, themes: window.__glosaThemes } : null",
            );
          } catch {
            recorded = null; // the context is replaced while the page reloads
          }
          if (!recorded) await Bun.sleep(100);
        }
        expect(recorded, `the reloaded document's recorder; shell stderr:\n${stderrText}`).toEqual({
          first: "high-contrast-light",
          themes: ["high-contrast-light"],
        });

        // AC4: a window the shell did not open for the SPA (the shell's own preload, told the
        // daemon's IP origin, on a page there, so the preload exposes the bridge). With the getter
        // on, its synchronous read is refused and answers no more contrast, without hanging its
        // page, and the push that turns the getter off reaches the SPA window but not it.
        const forged = await main.evaluateInMain<{
          read: boolean;
          completed: boolean;
          pushes: unknown[];
          spa: string;
        }>(`(async () => {
          const { BrowserWindow, nativeTheme } = require('electron');
          const other = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(SHELL_PRELOAD)},
            sandbox: true, contextIsolation: true, additionalArguments: ['--glosa-spa-origin=http://127.0.0.1:${port}'] } });
          try {
            await other.loadURL('http://127.0.0.1:${port}/api/handshake');
            const read = await other.webContents.executeJavaScript(
              "window.__pushes = []; window.glosaShell.onMoreContrastChange((value) => window.__pushes.push(value)); window.glosaShell.moreContrast()");
            Object.defineProperty(nativeTheme, '${GETTER}', { configurable: true, enumerable: true, get: () => false });
            nativeTheme.emit('updated');
            // Nothing arrives to wait for, so the SPA window receiving the same push is the
            // positive control, and half a second more is the margin for the other renderer.
            const spa = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(${JSON.stringify(spaOrigin)}));
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && (await spa.webContents.executeJavaScript('document.documentElement.dataset.theme')) !== 'light')
              await new Promise((resolve) => setTimeout(resolve, 50));
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { read, completed: true, pushes: await other.webContents.executeJavaScript('window.__pushes'),
              spa: await spa.webContents.executeJavaScript('document.documentElement.dataset.theme') };
          } finally {
            other.destroy();
          }
        })()`);
        expect(forged, `the window the shell did not open; shell stderr:\n${stderrText}`).toEqual({
          read: false,
          completed: true,
          pushes: [],
          spa: "light",
        });
        expect(stderrText).toContain("refused a contrast read: not the SPA origin");

        // A window keeps the SPA origin the shell recorded for it when the shell loads a blocking
        // screen into it (a failed compatibility check, `openWith`), so the push must also read the
        // top frame's committed origin. Spy on the SPA window's own `send`: a push while it shows the
        // SPA is the positive control; after the blocking screen, a change pushes nothing to it.
        const blocked = await main.evaluateInMain<{
          beforeScreen: unknown[];
          afterScreen: unknown[];
          frameOrigin: string;
        }>(`(async () => {
          const { nativeTheme } = require('electron');
          const win = ${spaWindow};
          const sent = [];
          const original = win.webContents.send;
          win.webContents.send = function (channel, ...args) {
            if (channel === 'glosa:more-contrast-changed') sent.push(args[0]);
            return original.call(this, channel, ...args);
          };
          const set = (value) => Object.defineProperty(nativeTheme, '${GETTER}', { configurable: true, enumerable: true, get: () => value });
          set(true);
          nativeTheme.emit('updated');
          const beforeScreen = [...sent];
          await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>glosa</title><h1>blocked</h1>'));
          set(false);
          nativeTheme.emit('updated');
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { beforeScreen, afterScreen: sent.slice(beforeScreen.length), frameOrigin: win.webContents.mainFrame.origin };
        })()`);
        expect(blocked, `a blocking screen in a window recorded for the SPA; shell stderr:\n${stderrText}`).toEqual({
          beforeScreen: [true],
          afterScreen: [],
          frameOrigin: "null",
        });
        // The change itself was seen (so nothing was sent because of where, not because it never ran).
        expect(stderrText.match(/more contrast: (on|off)/g)?.slice(-2)).toEqual([
          "more contrast: on",
          "more contrast: off",
        ]);
      } finally {
        await main
          .evaluateInMain(`(() => {
            const { nativeTheme } = require('electron');
            const kept = globalThis.__glosaContrast;
            if (kept && kept.saved) Object.defineProperty(nativeTheme, '${GETTER}', kept.saved);
            else if (kept) delete nativeTheme['${GETTER}'];
            return true;
          })()`)
          .catch(() => {});
        cdp.close();
        main.close();
      }
    }, 120_000);

    test("a glosa:// link opens the folder as a companion window, pairs over the bridge, and carries the link's route (#392)", async () => {
      const link = `glosa://open?${new URLSearchParams({
        path: workspace,
        focus: "readme.md",
        kind: "companion",
        mode: "read",
      }).toString()}`;
      // No window shows this folder yet, so the shell would ask; the unpackaged-only override answers.
      launchShell([link], { GLOSA_SHELL_CONFIRM: "yes" });
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(page, `SPA page for the link; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      try {
        let durable: string | null = null;
        for (let i = 0; i < 100 && !durable; i++) {
          try {
            durable = await cdp.evaluate<string | null>("localStorage.getItem('glosa_token')");
          } catch {
            // The page's context can be replaced while it loads; a throw here is a retry, not a
            // verdict (one run in five failed on it before this).
            durable = null;
          }
          if (!durable) await Bun.sleep(200);
        }
        expect(durable, `paired via bridge; shell stderr:\n${stderrText}`).toBeString();
        const href = await cdp.evaluate<string>("location.href");
        expect(href).not.toMatch(/[#&](p|t)=/);
        const route = new URLSearchParams(new URL(href).hash.slice(1));
        expect(route.get("kind")).toBe("companion");
        expect(route.get("mode")).toBe("read");
        expect(route.get("a")).toBe("readme.md");
      } finally {
        cdp.close();
      }
    }, 120_000);

    test("Check for Updates… sits under About, asks nothing through launch and pairing, and one click makes one request with a constant User-Agent (#424)", async () => {
      let arch = "";
      const releases = releasesStub(() =>
        Response.json([
          {
            tag_name: "v99.0.0",
            draft: false,
            prerelease: true,
            html_url: "https://example.com/not-the-release-page",
            assets: [{ name: `glosa-99.0.0-${arch}.dmg`, state: "uploaded" }],
          },
        ]),
      );
      const inspectPort = randomPort();
      try {
        launchShell([workspace, "readme.md", `--inspect=${inspectPort}`], { GLOSA_SHELL_RELEASES_API: releases.url });
        const spaOrigin = `http://glosa.localhost:${port}`;
        const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
        expect(page, `SPA page target; shell stderr:\n${stderrText}`).not.toBeNull();
        const mainUrl = await mainInspectorUrl(inspectPort);
        expect(mainUrl, `main-process inspector on ${inspectPort}; shell stderr:\n${stderrText}`).not.toBeNull();
        const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
        const main = await Cdp.connect(mainUrl!);
        try {
          let durable: string | null = null;
          for (let i = 0; i < 100 && !durable; i++) {
            try {
              durable = await cdp.evaluate<string | null>("localStorage.getItem('glosa_token')");
            } catch {
              durable = null; // the page's context can be replaced while it loads
            }
            if (!durable) await Bun.sleep(200);
          }
          expect(durable, `paired via bridge; shell stderr:\n${stderrText}`).toBeString();
          expect(releases.requests, "no update request through launch and pairing").toEqual([]);

          const menu = await main.evaluateInMain<Array<{ label: string; role: string | null; items: string[] }>>(`(() =>
            require('electron').Menu.getApplicationMenu().items.map((m) => ({ label: m.label, role: m.role || null,
              items: m.submenu ? m.submenu.items.map((i) => i.role || (i.type === 'separator' ? 'separator' : i.label)) : [] })))()`);
          expect(menu[0]?.items, "the app menu: About, then Check for Updates…, then the standard items").toEqual([
            "about",
            "Check for Updates…",
            "separator",
            "services",
            "separator",
            "hide",
            "hideothers",
            "unhide",
            "separator",
            "quit",
          ]);
          expect(menu.at(-1)).toEqual({ label: "Help", role: "help", items: [] });
          expect(menu.slice(1).flatMap((m) => m.items)).not.toContain("Check for Updates…");

          arch = await main.evaluateInMain<string>("process.arch");
          // Two clicks back to back: the second finds the first in flight and starts nothing.
          await clickCheckForUpdates(main, 2);
          const deadline = Date.now() + 15_000;
          while (!stderrText.includes("update check:") && Date.now() < deadline) await Bun.sleep(100);
          expect(stderrText, "the shell read the stub's release list").toContain(
            `update check: found 99.0.0 for ${arch}`,
          );
          expect(releases.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
            "GET /repos/davebream/glosa/releases",
          ]);
          const headers = releases.requests[0]?.headers ?? {};
          expect(headers["user-agent"]).toBe("glosa-update");
          for (const [name, value] of Object.entries(headers)) expect(value, name).not.toContain(SHELL_VERSION);
          expect(closedReleases!.requests, "nothing reached the suite's closed default endpoint").toEqual([]);
          expect(
            await main.evaluateInMain<number>("globalThis.__glosaUpdateDialogs"),
            "hidden mode opens no update-result dialog",
          ).toBe(0);
        } finally {
          cdp.close();
          main.close();
        }
      } finally {
        // The result's dialog stays open until afterEach quits the shell: nothing here presses its
        // buttons (Copy Upgrade Command would overwrite this machine's clipboard).
        releases.stop();
      }
    }, 120_000);

    test("Check for Updates… follows no redirect: a 302 fails the check, and its target is never asked (#424)", async () => {
      // GitHub answers a renamed repository with a redirect; the check treats one as a failure.
      const target = releasesStub(() =>
        Response.json([
          { tag_name: "v99.0.0", draft: false, assets: [{ name: "glosa-99.0.0-arm64.dmg", state: "uploaded" }] },
        ]),
      );
      const redirecting = releasesStub(() => new Response(null, { status: 302, headers: { location: target.url } }));
      const inspectPort = randomPort();
      try {
        launchShell([workspace, "readme.md", `--inspect=${inspectPort}`], {
          GLOSA_SHELL_RELEASES_API: redirecting.url,
        });
        // A person clicks with a window open; the result dialog then attaches to it.
        const spaOrigin = `http://glosa.localhost:${port}`;
        const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
        expect(page, `SPA page target; shell stderr:\n${stderrText}`).not.toBeNull();
        const mainUrl = await mainInspectorUrl(inspectPort);
        expect(mainUrl, `main-process inspector on ${inspectPort}; shell stderr:\n${stderrText}`).not.toBeNull();
        const main = await Cdp.connect(mainUrl!);
        try {
          await clickCheckForUpdates(main, 1);
          const deadline = Date.now() + 15_000;
          while (!stderrText.includes("update check:") && Date.now() < deadline) await Bun.sleep(100);
          expect(target.requests, "the redirect's target received no request").toEqual([]);
          expect(stderrText, "the check failed, so the dialog is the failure one").toContain(
            "update check: failed: GitHub redirected the request (HTTP 302), and the check follows no redirect",
          );
          expect(redirecting.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
            "GET /repos/davebream/glosa/releases",
          ]);
          expect(
            await main.evaluateInMain<number>("globalThis.__glosaUpdateDialogs"),
            "hidden mode opens no update-result dialog",
          ).toBe(0);
        } finally {
          main.close();
        }
      } finally {
        target.stop();
        redirecting.stop();
      }
    }, 120_000);

    // ---------- desk browser tabs (#440; A3 §4b, §5 row 13) ----------

    /** A stand-in for the web on a port this test owns, counting every request by path. It is
     * reached as `localhost:<port>` (a local page) and as `internet.test:<port>` (a Chromium
     * host-resolver rule maps that name to loopback, so glosa sees an internet address without the
     * test leaving this machine). */
    function fakeWeb() {
      const hits = new Map<string, number>();
      const page = (title: string, body: string) =>
        new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      let web_port = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const path = new URL(req.url).pathname;
          hits.set(path, (hits.get(path) ?? 0) + 1);
          if (path === "/report.pdf")
            return new Response("%PDF-1.4", {
              headers: {
                "content-type": "application/pdf",
                "content-disposition": "attachment; filename=tides-2026.pdf",
              },
            });
          if (path === "/probe")
            return page(
              "Probe",
              `<a href="/report.pdf">report</a><script>
              window.__probe = (async () => {
                const r = { bridge: typeof window.glosaShell, ua: navigator.userAgent };
                // no-cors: a request that reached the server resolves (opaque); only one the shell
                // cancelled rejects. A CORS failure must not pass for a refusal.
                try { await fetch("http://127.0.0.1:${port}/api/handshake", { mode: "no-cors" }); r.daemon = "reached"; } catch { r.daemon = "blocked"; }
                try { await fetch("http://127.0.0.1:${port + 1}/", { mode: "no-cors" }); r.classF = "reached"; } catch { r.classF = "blocked"; }
                try { await fetch("http://localhost:${web_port}/other", { mode: "no-cors" }); r.web = "reached"; } catch { r.web = "blocked"; }
                r.notify = await Notification.requestPermission();
                return r;
              })();</script>`,
            );
          if (path === "/tides")
            // A page that tries to change what an agent reads: in its own world, every element's
            // text reads as TAMPERED. The shell reads in an isolated world, where it does not.
            return page(
              "Tides",
              `<p>High water at Gdańsk 06:12</p><script>
              Object.defineProperty(HTMLElement.prototype, "innerText", { get() { return "TAMPERED"; } });
              </script>`,
            );
          return page(path.slice(1) || "Home", "<p>page</p>");
        },
      });
      web_port = server.port ?? 0;
      return { port: server.port, hits: (path: string) => hits.get(path) ?? 0, stop: () => server.stop(true) };
    }

    /** Types an address into a new browser tab, the way a person does: the strip's tool, then the field. */
    async function openTab(cdp: Cdp, address: string): Promise<void> {
      // The strip's tools arrive with the dock's first layout, after the workspace has mounted.
      let tool = false;
      for (let i = 0; i < 50 && !tool; i++) {
        tool = await cdp.evaluate<boolean>("Boolean(document.querySelector('.glosa-strip-new-browser'))");
        if (!tool) await Bun.sleep(100);
      }
      expect(tool, "the tab strip offers New browser tab").toBe(true);
      await cdp.evaluate("document.querySelector('.glosa-strip-new-browser').click(), true");
      let focused = false;
      for (let i = 0; i < 50 && !focused; i++) {
        focused = await cdp.evaluate<boolean>(
          "document.activeElement?.classList.contains('glosa-browser-input') ?? false",
        );
        if (!focused) await Bun.sleep(100);
      }
      expect(focused, "a new browser tab focuses its address").toBe(true);
      await cdp.evaluate(`(() => {
        const input = document.activeElement;
        input.value = ${JSON.stringify(address)};
        input.dispatchEvent(new Event("input"));
        input.form.requestSubmit();
        return true;
      })()`);
    }

    /** The guest showing `path`, as the main process sees it: its id and whether it is in the
     * browser partition. Polls until it exists. */
    async function guestFor(
      main: Cdp,
      path: string,
    ): Promise<{ id: number; partition: boolean; notDefault: boolean } | null> {
      for (let i = 0; i < 100; i++) {
        const found = await main.evaluateInMain<{
          id: number;
          partition: boolean;
          notDefault: boolean;
        } | null>(`(() => {
          const { webContents, session } = require('electron');
          const g = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.getURL().includes(${JSON.stringify(path)}));
          return g ? { id: g.id, partition: g.session === session.fromPartition('persist:glosa-browser'),
            notDefault: g.session !== session.defaultSession } : null;
        })()`);
        if (found) return found;
        await Bun.sleep(100);
      }
      return null;
    }

    test("a desk browser tab runs in its own partition with no bridge, reaches no daemon port, is refused permissions and downloads, names neither glosa nor Electron, and a restored internet tab fetches nothing until Load page (#440)", async () => {
      const web = fakeWeb();
      const inspectPort = randomPort();
      launchShell([
        workspace,
        "readme.md",
        `--inspect=${inspectPort}`,
        "--host-resolver-rules=MAP internet.test 127.0.0.1",
      ]);
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(
        page,
        `SPA page target; targets seen: ${JSON.stringify(lastTargets)}; shell stderr:\n${stderrText}`,
      ).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      try {
        expect(await workspaceMounted(cdp), `the workspace mounted; shell stderr:\n${stderrText}`).toBe(true);

        // A local page, in the browser partition, not the SPA's session.
        await openTab(cdp, `localhost:${web.port}/probe`);
        const probe = await guestFor(main, "/probe");
        expect(probe, `the probe's guest attached; shell stderr:\n${stderrText}`).not.toBeNull();
        expect(probe!.partition).toBe(true);
        expect(probe!.notDefault).toBe(true);
        const seen = await main.evaluateInMain<{
          bridge: string;
          ua: string;
          daemon: string;
          classF: string;
          web: string;
          notify: string;
        }>(`require('electron').webContents.fromId(${probe!.id}).executeJavaScript('window.__probe')`);
        expect(seen.bridge).toBe("undefined");
        expect(seen.daemon).toBe("blocked");
        expect(seen.classF).toBe("blocked");
        expect(seen.web, "the same probe does reach another local server").toBe("reached");
        expect(seen.notify).toBe("denied");
        expect(seen.ua).not.toMatch(/glosa|Electron/i);
        expect(stderrText).toContain("browser tab: cancelled a request");

        // Whatever the SPA frame asks for, the shell decides the guest's session: a webview with no
        // partition would otherwise run in the SPA's own session, beside the pairing credential.
        await cdp.evaluate(`(() => {
          const w = document.createElement('webview');
          w.setAttribute('src', 'http://localhost:${web.port}/rogue');
          w.style.cssText = 'position:fixed;width:10px;height:10px;left:0;top:0';
          document.body.append(w);
          return true;
        })()`);
        const rogue = await guestFor(main, "/rogue");
        expect(rogue, `the rogue guest attached; shell stderr:\n${stderrText}`).not.toBeNull();
        expect(rogue!.partition).toBe(true);
        expect(rogue!.notDefault).toBe(true);
        expect(
          await main.evaluateInMain<string>(
            `require('electron').webContents.fromId(${rogue!.id}).executeJavaScript('typeof window.glosaShell')`,
          ),
        ).toBe("undefined");
        await cdp.evaluate("document.querySelector('body > webview')?.remove(), true");

        // The refused permission, and a refused download, are said in the tab.
        const noticeSays = async (words: string) => {
          for (let i = 0; i < 50; i++) {
            const text = await cdp.evaluate<string>(
              "document.querySelector('.glosa-browser-notice-text')?.textContent ?? ''",
            );
            if (text.includes(words)) return text;
            await Bun.sleep(100);
          }
          return await cdp.evaluate<string>("document.querySelector('.glosa-browser-notice-text')?.textContent ?? ''");
        };
        expect(await noticeSays("asked to show notifications")).toContain("glosa doesn't allow that");
        await main.evaluateInMain(
          `require('electron').webContents.fromId(${probe!.id}).executeJavaScript("document.querySelector('a').click()", true)`,
        );
        expect(await noticeSays("tides-2026.pdf")).toContain("glosa doesn't save downloads");

        // A guest sent to glosa's own address never gets there.
        await main.evaluateInMain(
          `require('electron').webContents.fromId(${probe!.id}).loadURL(${JSON.stringify(`${spaOrigin}/`)}).catch(() => null)`,
        );
        await Bun.sleep(500);
        expect(
          await main.evaluateInMain<string>(`require('electron').webContents.fromId(${probe!.id}).getURL()`),
        ).not.toStartWith(spaOrigin);

        // The SPA's own gate is unchanged: the page cannot reach the stand-in internet.
        expect(
          await cdp.evaluate<string>(
            `fetch("http://internet.test:${web.port}/gate").then(() => "reached", () => "blocked")`,
          ),
        ).toBe("blocked");
        expect(web.hits("/gate")).toBe(0);

        // The browser partition can: an internet page a person asked for loads once.
        await openTab(cdp, `http://internet.test:${web.port}/restore`);
        expect(
          await guestFor(main, "/restore"),
          `the internet page loaded; shell stderr:\n${stderrText}`,
        ).not.toBeNull();
        expect(web.hits("/restore")).toBe(1);
        const probeLoads = web.hits("/probe");

        // After a reload the local tab loads again at once; the internet tab asks nothing until Load page.
        await cdp.evaluate("(location.reload(), true)");
        await Bun.sleep(500);
        expect(await workspaceMounted(cdp)).toBe(true);
        let unloaded = false;
        for (let i = 0; i < 50 && !unloaded; i++) {
          unloaded = await cdp.evaluate<boolean>(
            "Boolean(document.querySelector('.glosa-browser[data-state=\"unloaded\"]'))",
          );
          if (!unloaded) await Bun.sleep(100);
        }
        expect(unloaded, "the internet tab came back without loading").toBe(true);
        for (let i = 0; i < 50 && web.hits("/probe") === probeLoads; i++) await Bun.sleep(100);
        expect(web.hits("/probe")).toBe(probeLoads + 1);
        await Bun.sleep(1500); // the window in which a silent restore load would have arrived
        expect(web.hits("/restore")).toBe(1);
        await cdp.evaluate(
          `[...document.querySelectorAll('.glosa-browser-sheet button')].find((b) => b.textContent === 'Load page').click(), true`,
        );
        for (let i = 0; i < 50 && web.hits("/restore") === 1; i++) await Bun.sleep(100);
        expect(web.hits("/restore")).toBe(2);
      } finally {
        cdp.close();
        main.close();
        web.stop();
      }
    }, 120_000);

    test("a chat agent's read goes through the bridge for the window's own tab only, and the page cannot change what is read (#440)", async () => {
      const web = fakeWeb();
      const other = mkdtempSync(join(tmpdir(), "glosa-shell-ws-other-"));
      writeFileSync(join(other, "readme.md"), "# Other\n");
      const inspectPort = randomPort();
      launchShell([workspace, "readme.md", `--inspect=${inspectPort}`], { GLOSA_SHELL_CONFIRM: "yes" });
      const spaOrigin = `http://glosa.localhost:${port}`;
      const first = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(first, `SPA page target; shell stderr:\n${stderrText}`).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(first!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      let second: Cdp | null = null;
      try {
        expect(await workspaceMounted(cdp), `the workspace mounted; shell stderr:\n${stderrText}`).toBe(true);
        await openTab(cdp, `localhost:${web.port}/tides`);
        const tides = await guestFor(main, "/tides");
        expect(tides, `the page's guest attached; shell stderr:\n${stderrText}`).not.toBeNull();
        // The page has run its script: in its own world the text reads as TAMPERED.
        let tampered = "";
        for (let i = 0; i < 50 && tampered !== "TAMPERED"; i++) {
          tampered = await main.evaluateInMain<string>(
            `require('electron').webContents.fromId(${tides!.id}).executeJavaScript('document.body.innerText')`,
          );
          if (tampered !== "TAMPERED") await Bun.sleep(100);
        }
        expect(tampered).toBe("TAMPERED");

        const read = await cdp.evaluate<{ url: string; title: string; text: string; truncated: boolean }>(
          `window.glosaShell.readBrowserTab(${tides!.id}, 5000)`,
        );
        expect(read).toEqual({
          url: `http://localhost:${web.port}/tides`,
          title: "Tides",
          text: "High water at Gdańsk 06:12",
          truncated: false,
        });
        const refused = (expression: string) =>
          cdp.evaluate<string>(`${expression}.then(() => "read", (error) => String(error?.message ?? error))`);
        // The SPA's own page is not a browser tab.
        const own = await main.evaluateInMain<number>(
          `require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window' && w.getURL().startsWith(${JSON.stringify(spaOrigin)})).id`,
        );
        expect(await refused(`window.glosaShell.readBrowserTab(${own}, 5000)`)).toContain(
          "not one of this window's browser tabs",
        );
        expect(await refused(`window.glosaShell.readBrowserTab("${tides!.id}", 5000)`)).toContain(
          "not one of this window's browser tabs",
        );

        // Another desk window, on another folder, with a tab of its own.
        await main.evaluateInMain(
          `(require('electron').app.emit('open-url', { preventDefault() {} }, ${JSON.stringify(
            `glosa://open?${new URLSearchParams({ path: other, focus: "readme.md", kind: "desk" }).toString()}`,
          )}), true)`,
        );
        const secondTarget = await listTargets(
          cdpPort,
          60_000,
          (t) => t.type === "page" && t.url.startsWith(spaOrigin) && (t as { id?: string }).id !== first!.id,
        );
        expect(secondTarget, `a second desk window; targets seen: ${JSON.stringify(lastTargets)}`).not.toBeNull();
        second = await Cdp.connect(secondTarget!.webSocketDebuggerUrl);
        expect(await workspaceMounted(second)).toBe(true);
        const nativeWindows = await main.evaluateInMain<{ count: number; visible: number; focused: boolean }>(
          `(() => {
            const { BrowserWindow } = require('electron');
            const all = BrowserWindow.getAllWindows();
            return { count: all.length, visible: all.filter((w) => w.isVisible()).length,
              focused: BrowserWindow.getFocusedWindow() !== null };
          })()`,
        );
        expect(nativeWindows.count, "the link opened a second native window").toBeGreaterThanOrEqual(2);
        expect(nativeWindows.visible, "both desk windows stay hidden").toBe(0);
        expect(nativeWindows.focused, "the second window did not take focus").toBe(false);
        await openTab(second, `localhost:${web.port}/elsewhere`);
        const elsewhere = await guestFor(main, "/elsewhere");
        expect(elsewhere, `the second window's guest attached; shell stderr:\n${stderrText}`).not.toBeNull();
        // Each window reads its own tab and not the other's, whatever id it names.
        expect(await refused(`window.glosaShell.readBrowserTab(${elsewhere!.id}, 5000)`)).toContain(
          "not one of this window's browser tabs",
        );
        expect(
          await second.evaluate<string>(
            `window.glosaShell.readBrowserTab(${tides!.id}, 5000).then(() => "read", (error) => String(error?.message ?? error))`,
          ),
        ).toContain("not one of this window's browser tabs");
        expect(
          (await second.evaluate<{ title: string }>(`window.glosaShell.readBrowserTab(${elsewhere!.id}, 5000)`)).title,
        ).toBe("elsewhere");
      } finally {
        second?.close();
        cdp.close();
        main.close();
        web.stop();
        rmSync(other, { recursive: true, force: true });
      }
    }, 120_000);

    test("a companion window has no browser tools, and a webview it asks for never attaches (#440)", async () => {
      const inspectPort = randomPort();
      const link = `glosa://open?${new URLSearchParams({ path: workspace, focus: "readme.md", kind: "companion" }).toString()}`;
      launchShell([link, `--inspect=${inspectPort}`], { GLOSA_SHELL_CONFIRM: "yes" });
      const spaOrigin = `http://glosa.localhost:${port}`;
      const page = await listTargets(cdpPort, 60_000, (t) => t.type === "page" && t.url.startsWith(spaOrigin));
      expect(page, `SPA page for the link; shell stderr:\n${stderrText}`).not.toBeNull();
      const mainUrl = await mainInspectorUrl(inspectPort);
      expect(mainUrl, `main-process inspector; shell stderr:\n${stderrText}`).not.toBeNull();
      const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
      const main = await Cdp.connect(mainUrl!);
      try {
        expect(await workspaceMounted(cdp)).toBe(true);
        expect(await cdp.evaluate<boolean>("Boolean(document.querySelector('.glosa-strip-tools'))")).toBe(false);
        expect(await cdp.evaluate<number>("window.glosaShell.browserTabs")).toBe(1);
        // The page asks for a guest anyway, as a compromised page would.
        await cdp.evaluate(`(() => {
          const w = document.createElement('webview');
          w.setAttribute('src', 'http://localhost:1/');
          document.body.append(w);
          return true;
        })()`);
        await Bun.sleep(1500);
        expect(
          await main.evaluateInMain<number>(
            "require('electron').webContents.getAllWebContents().filter((w) => w.getType() === 'webview').length",
          ),
        ).toBe(0);
        expect(stderrText).toContain("refused a browser tab");
      } finally {
        cdp.close();
        main.close();
      }
    }, 120_000);
  },
);
