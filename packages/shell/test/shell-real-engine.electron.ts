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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../../daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../daemon/test/helpers.ts";
import { PAPER } from "../src/policy.ts";

const SHELL_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ELECTRON = join(SHELL_DIR, "node_modules", ".bin", "electron");
const MAIN_PATH = join(REPO, "packages", "cli", "src", "main.ts");
const PROBE = join(REPO, "docs", "research", "spikes", "electron-classf-probe.html");
const SHELL_PRELOAD = join(SHELL_DIR, "src", "preload.cjs");
const TOKEN = "shell-test-durable-token-0123456789abcdef0123456789abcdef";
const electronInstalled = existsSync(ELECTRON);

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

    /** Starts the shell with `args` after the app directory, the way `open -a` or a link would. */
    const launchShell = (args: string[], extra: Record<string, string> = {}) => {
      electron = Bun.spawn({
        cmd: [ELECTRON, SHELL_DIR, ...args, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`],
        env: { ...env, GLOSA_SHELL_CLI: cli, ANTHROPIC_API_KEY: "sk-must-never-reach-a-child", ...extra },
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
      electron?.kill();
      await electron?.exited;
      daemon.kill();
      await daemon.exited;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    });

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
  },
);
