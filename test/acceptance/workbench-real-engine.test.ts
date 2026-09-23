// SPDX-License-Identifier: Apache-2.0
// #162 — the multi-artifact workbench, in a real browser engine.
//
// The 2026-09-04 brief (docs/design/2026-09-04-multi-artifact-workbench-brief.md) makes three
// claims that no DOM-shim test can settle, because each depends on a real layout engine, real
// persistence across a real page teardown, or a real nested browsing context:
//
//   §10 the arrangement AND each pane's state come back after a reload;
//   §2/§10 the mode control addresses ONE pane, and the other panes stay where they were;
//   §11 a class-F pane's sandboxed iframe survives a tab switch and a tab move without reloading
//       — which for an INTERACTIVE frame is not a performance nicety: `classf-viewer.js` reads a
//       second `load` on the same element as the document navigating itself, tears the frame down
//       and shows an error. Reparenting it is indistinguishable from an attack.
//
// `packages/spa/test/workbench.test.ts` covers the same sections against happy-dom, where
// `localStorage` is a fake map, `offsetParent` is not laid out, and an iframe never loads
// anything. It cannot fail for any of the three reasons above.
//
// Real, not simulated: one real `glosa __daemon` subprocess, one real registered workspace, one
// installed Chromium engine from the same fixed candidate list the other real-engine gates use,
// driven over its own raw CDP WebSocket. No Playwright, no Puppeteer, no downloaded browser. The
// CDP client is file-local on purpose: importing one out of another acceptance test would couple
// two gates' failure modes together.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "workbench-real-engine-token-0123456789abcdef01";
const TEST_TIMEOUT_MS = 60_000;

const ALPHA = "alpha.md";
const BETA = "beta.md";
const PREVIEW = "preview.html";
const ALPHA_TEXT = "Alpha is the artifact the address bar names.";
const BETA_TEXT = "Beta is the companion that must keep its own state.";

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

/** AGENTS.md invariant 5: scrub `ANTHROPIC_API_KEY` from EVERY spawned child. `HOME` points at
 * this test's private throwaway home, so nothing spawned reads or writes the real user's home. */
function buildChildEnv(ambient: Record<string, string | undefined>, home: string): Record<string, string> {
  const env = { ...ambient } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  env.HOME = home;
  return env;
}

async function killAndAwait(proc: Bun.Subprocess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
  await proc.exited;
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  try {
    return await Promise.race([new Response(stream).text(), Bun.sleep(2_000).then(() => "<drain timed out>")]);
  } catch {
    return "";
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<string> {
  if (!stream) return "";
  try {
    return await Promise.race([
      new Response(stream).text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("read timed out")), timeoutMs)),
    ]);
  } catch {
    return "";
  }
}

async function installedChromium(env: Record<string, string>): Promise<string> {
  for (const executable of CHROMIUM_CANDIDATES) {
    if (!existsSync(executable)) continue;
    const probe = Bun.spawn({ cmd: [executable, "--version"], env, stdout: "pipe", stderr: "ignore" });
    const version = (await readBounded(probe.stdout, 5_000)).trim();
    await killAndAwait(probe);
    const major = Number(version.match(/\b(\d{3})\b/)?.[1]);
    if (probe.exitCode === 0 && Number.isFinite(major) && major >= 111) return executable;
  }
  throw new Error(`this gate requires installed Chromium >=111; checked: ${CHROMIUM_CANDIDATES.join(", ")}`);
}

interface Handshake {
  contract_version: string;
  install_id: string;
  paired: boolean;
}

async function waitForHandshake(port: number, deadlineMs: number, proc: Bun.Subprocess): Promise<Handshake | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (proc.exitCode !== null) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/handshake`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return (await res.json()) as Handshake;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  return null;
}

/** A tiny raw-CDP client: one WebSocket, one `id -> {resolve,reject}` map. Every pending call is
 * bounded and every pending call is rejected the moment the socket closes, so a browser that stays
 * alive without answering fails the waiting call instead of hanging. */
class CdpClient {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void }>();
  #subscribers = new Set<(msg: any) => void>();
  #terminated: Error | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id === undefined) {
        for (const subscriber of this.#subscribers) subscriber(msg);
        return;
      }
      const pending = this.#pending.get(msg.id);
      if (pending) {
        this.#pending.delete(msg.id);
        pending.resolve(msg);
      }
    });
    const onTerminate = (reason: string) => {
      if (this.#terminated) return;
      this.#terminated = new Error(`CDP socket ${reason} with ${this.#pending.size} call(s) still pending`);
      for (const { reject } of this.#pending.values()) reject(this.#terminated as Error);
      this.#pending.clear();
    };
    ws.addEventListener("close", () => onTerminate("closed"));
    ws.addEventListener("error", () => onTerminate("errored"));
  }

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket did not open before the deadline")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket failed to open"));
      });
    });
    return new CdpClient(ws);
  }

  /** Subscribes to every unsolicited CDP event. Returns an unsubscribe. */
  on(handler: (msg: any) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (this.#terminated) return Promise.reject(this.#terminated);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP call ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Arms a listener BEFORE the caller issues the command that produces the event — the event can
   * land before a command's own reply does, and arming afterwards loses that race. */
  waitForEvent(method: string, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event ${method} did not arrive within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.on((msg) => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  async navigate(url: string): Promise<void> {
    const loaded = this.waitForEvent("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async reload(): Promise<void> {
    const loaded = this.waitForEvent("Page.loadEventFired");
    await this.send("Page.reload", { ignoreCache: false });
    await loaded;
  }

  async evaluate<T = unknown>(expression: string, timeoutMs = 20_000): Promise<T> {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.result?.exceptionDetails) {
      throw new Error(`page evaluation threw: ${JSON.stringify(res.result.exceptionDetails)}`);
    }
    return res.result?.result?.value;
  }

  /** A real chorded keystroke, through the browser's own input pipeline rather than a synthetic
   * `KeyboardEvent` the page would receive with `isTrusted: false`. CDP modifier bits: Alt 1,
   * Ctrl 2, Meta 4, Shift 8. */
  async metaKeyPress(key: string, code: string, windowsVirtualKeyCode: number): Promise<void> {
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        modifiers: 4,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      });
    }
  }

  close(): void {
    this.#ws.close();
  }
}

interface PaneState {
  path: string | null;
  mode: string | null;
  active: boolean;
  left: number;
  width: number;
  liveModeBar: boolean;
  modeLabel: string;
  classFError: string;
  text: string;
  errorTitle: string;
}

interface PageState {
  screens: string[];
  groups: number;
  tabs: string[];
  panes: PaneState[];
  hash: string;
  layout: { panels: Record<string, { params?: { mode?: string } }> } | null;
}

/** Everything the page can tell us about the workbench, read in ONE evaluate so no two fields can
 * disagree about which moment they describe. */
const pageStateExpression = (slug: string) => `(() => {
  const screens = Array.from(document.querySelectorAll('[data-screen]'))
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute('data-screen'));
  const panes = Array.from(document.querySelectorAll('.glosa-pane')).map((pane) => {
    const box = pane.getBoundingClientRect();
    const bar = pane.querySelector('.glosa-modebar');
    return {
      path: pane.getAttribute('aria-label'),
      mode: pane.getAttribute('data-mode'),
      active: pane.getAttribute('data-active') === 'true',
      left: Math.round(box.left),
      width: Math.round(box.width),
      liveModeBar: Boolean(bar) && bar.offsetParent !== null,
      modeLabel: pane.querySelector('.glosa-pane-mode-label')?.textContent ?? '',
      classFError: pane.querySelector('.glosa-classf-status[data-error="true"]')?.textContent ?? '',
      // issue #337: what the pane actually rendered — the ONE observation that distinguishes
      // "opened the right document" from "opened nothing" or "opened the wrong one".
      text: pane.querySelector('.glosa-content')?.textContent ?? '',
      errorTitle: pane.querySelector('.glosa-empty-title')?.textContent ?? '',
    };
  });
  let layout = null;
  try {
    layout = JSON.parse(localStorage.getItem('glosa:layout:' + ${JSON.stringify(slug)}) ?? 'null');
  } catch {
    layout = null;
  }
  return {
    screens,
    groups: document.querySelectorAll('.dv-groupview').length,
    tabs: Array.from(document.querySelectorAll('.glosa-tab-label')).map((el) => el.textContent),
    panes,
    hash: location.hash,
    layout,
  };
})()`;

describe("#162 — the multi-artifact workbench in a real engine", () => {
  let home: string;
  let workspaceRoot: string;
  let chromeProfile: string;
  let childEnv: Record<string, string>;
  let chromiumPath: string;
  let port: number;
  let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let chrome: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let clients: CdpClient[] = [];
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-162-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    // A test runner killed mid-run reparents its children; this guardian reaps the daemon that
    // owns exactly this throwaway home rather than leaving it on the port.
    superviseDaemonHome(home);
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);
    chromiumPath = await installedChromium(childEnv);

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-162-ws-"));
    writeFileSync(join(workspaceRoot, ALPHA), `# Alpha\n\n${ALPHA_TEXT}\n`);
    writeFileSync(join(workspaceRoot, BETA), `# Beta\n\n${BETA_TEXT}\n`);
    // Any `.html` is class F (packages/daemon/src/artifact-render.ts `classifyArtifactPath`), so
    // this opens in the sandboxed capability iframe rather than as a manuscript.
    writeFileSync(
      join(workspaceRoot, PREVIEW),
      '<!doctype html><html><body><p id="p">A rendered preview.</p></body></html>\n',
    );
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-162-chrome-profile-"));

    port = randomPort();
    const daemonEnv: Record<string, string> = { ...childEnv };
    daemonEnv.GLOSA_HOME = home;
    daemonEnv.GLOSA_PORT = String(port);
    daemonEnv.GLOSA_CLASSF_PORT = String(port + 1);
    daemon = Bun.spawn({
      cmd: [process.execPath, MAIN_PATH, "__daemon"],
      env: daemonEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const handshake = await waitForHandshake(port, 15_000, daemon);
    expect(handshake, `daemon handshake failed (exitCode=${daemon.exitCode})`).not.toBeNull();

    const opened = await fetch(`http://127.0.0.1:${port}/api/workspaces/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: workspaceRoot }),
    });
    expect(opened.ok, "workspace registration").toBe(true);
    slug = (await opened.json()).slug;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await killAndAwait(chrome);
    chrome = null;
    await killAndAwait(daemon);
    daemon = null;
    for (const dir of [chromeProfile, workspaceRoot, home]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  const origin = () => `http://127.0.0.1:${port}`;
  const pairedUrl = (artifact: string) =>
    `${origin()}/#${new URLSearchParams({ t: TOKEN, w: slug, a: artifact, mode: "review" })}`;

  /** Launches Chromium on this test's profile with CDP enabled. The window is wide on purpose:
   * two panes at the 360px floor plus the navigator do not fit the 800x600 headless default, and
   * a pane squeezed below its minimum is a different layout than the one under test. */
  async function launchBrowser(): Promise<{ browser: CdpClient; cdpPort: number }> {
    const cdpPort = randomPort();
    const argv = [
      chromiumPath,
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      "--window-size=1600,1000",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      // Nothing this browser resolves can reach a real host, only loopback.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      `--user-data-dir=${chromeProfile}`,
      "about:blank",
    ];
    chrome = Bun.spawn({ cmd: argv, env: childEnv, stdout: "pipe", stderr: "pipe" });

    let browser: CdpClient | undefined;
    try {
      let versionEndpoint: { webSocketDebuggerUrl?: string } | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (chrome.exitCode !== null) break;
        try {
          const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            versionEndpoint = await res.json();
            break;
          }
        } catch {
          // not up yet
        }
        await Bun.sleep(100);
      }
      if (!versionEndpoint?.webSocketDebuggerUrl) {
        throw new Error("Chromium did not open its CDP endpoint before the deadline");
      }
      browser = await CdpClient.connect(versionEndpoint.webSocketDebuggerUrl);
      clients.push(browser);
      return { browser, cdpPort };
    } catch (error) {
      browser?.close();
      await killAndAwait(chrome);
      const [out, err] = await Promise.all([drain(chrome?.stdout ?? null), drain(chrome?.stderr ?? null)]);
      throw new Error(
        `${(error as Error).message}\nargv=${JSON.stringify(argv)}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    }
  }

  /** Opens a blank tab with `Page`, `Runtime` and `Network` already enabled, and returns it
   * WITHOUT navigating. The caller navigates, so a listener armed here cannot miss a request the
   * page made while the domain was still being enabled — which it did, intermittently, when the
   * target was created at the real URL. */
  async function openBlankTab(browser: CdpClient, cdpPort: number): Promise<CdpClient> {
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    const targetId = created.result?.targetId;
    if (!targetId) throw new Error(`Target.createTarget returned no targetId: ${JSON.stringify(created)}`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const list: Array<{ id: string; webSocketDebuggerUrl?: string }> = await (
        await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2_000) })
      ).json();
      const target = list.find((entry) => entry.id === targetId && entry.webSocketDebuggerUrl);
      if (target) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
        clients.push(client);
        await client.send("Page.enable");
        await client.send("Runtime.enable");
        await client.send("Network.enable");
        return client;
      }
      await Bun.sleep(100);
    }
    throw new Error(`no page target appeared for ${targetId}`);
  }

  async function openTab(browser: CdpClient, cdpPort: number, url: string): Promise<CdpClient> {
    const client = await openBlankTab(browser, cdpPort);
    await client.navigate(url);
    return client;
  }

  /** Polls the page until `accept` holds. Evaluate errors are swallowed while polling: during a
   * reload the previous execution context is torn down and any in-flight evaluation dies with it,
   * which is normal here rather than a failure. */
  async function waitForState(
    client: CdpClient,
    label: string,
    accept: (state: PageState) => boolean,
    attempts = 240,
  ): Promise<PageState> {
    let last: PageState | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        last = await client.evaluate<PageState>(pageStateExpression(slug));
        if (last && accept(last)) return last;
      } catch {
        // execution context torn down mid-reload
      }
      await Bun.sleep(50);
    }
    throw new Error(`${label}: never reached the expected state; last=${JSON.stringify(last)}`);
  }

  /** dockview repositions its render overlays on an animation frame, so a move is not finished
   * when the command returns. Settle on GEOMETRY, agreed twice in a row, rather than on a fixed
   * sleep: `groups` panes side by side, each with a real width and its own left edge. */
  async function waitForArrangement(client: CdpClient, label: string, groups: number): Promise<PageState> {
    const settled = (state: PageState) => {
      if (state.groups !== groups || state.panes.length < groups) return false;
      if (!state.panes.every((pane) => pane.width > 0)) return false;
      return new Set(state.panes.map((pane) => pane.left)).size === groups;
    };
    let previous = "";
    for (let attempt = 0; attempt < 240; attempt++) {
      const state = await waitForState(client, label, settled, 1).catch(() => null);
      const signature = state ? JSON.stringify(state.panes.map((pane) => [pane.path, pane.left, pane.width])) : "";
      if (state && signature === previous) return state;
      previous = signature;
      await Bun.sleep(50);
    }
    throw new Error(`${label}: the arrangement never settled into ${groups} pane(s)`);
  }

  const waitForReady = (client: CdpClient, label: string) =>
    waitForState(client, label, (state) => state.screens.includes("ready") && state.panes.length > 0);

  /** Clicks something by selector inside the pane whose `aria-label` is `path`, and reports which
   * selector was missing rather than failing later on a state that never changed. */
  const clickInPane = async (client: CdpClient, path: string, selector: string) => {
    const found = await client.evaluate<boolean>(`(() => {
      const pane = Array.from(document.querySelectorAll('.glosa-pane'))
        .find((el) => el.getAttribute('aria-label') === ${JSON.stringify(path)});
      const target = pane?.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!found) throw new Error(`no ${selector} inside the pane for ${path}`);
  };

  /** Activates a tab with a REAL pointer press at its own coordinates. A scripted `.click()` does
   * not reach dockview's tab handler at all — the dock runs on pointer events (`dndStrategy:
   * "pointer"`, chosen in dock.js because HTML5 drag-and-drop is unreliable on Safari), so the
   * one event a scripted click dispatches is the one event the strip does not listen for. */
  const clickTab = async (client: CdpClient, label: string) => {
    const box = await client.evaluate<{ x: number; y: number } | null>(`(() => {
      const tab = Array.from(document.querySelectorAll('.glosa-tab-label'))
        .find((el) => el.textContent === ${JSON.stringify(label)});
      const target = tab?.closest('.dv-tab') ?? tab?.closest('.glosa-tab');
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    if (!box) throw new Error(`no laid-out tab labelled ${label}`);
    for (const [type, buttons] of [
      ["mouseMoved", 0],
      ["mousePressed", 1],
      ["mouseReleased", 0],
    ] as const) {
      await client.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
  };

  const openFromNavigator = async (client: CdpClient, path: string) => {
    const found = await client.evaluate<boolean>(`(() => {
      const row = document.querySelector('[data-node-id="f:' + ${JSON.stringify(path)} + '"] .glosa-tree-row');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (!found) throw new Error(`no navigator row for ${path}`);
  };

  /** issue #337: a document under `My Folder/` starts with its ancestor collapsed (only the
   * INITIALLY-open artifact's ancestors auto-expand) — click the folder row first, same
   * synchronous DOM toggle `openFromNavigator` relies on for files. */
  const expandFolderInTree = async (client: CdpClient, dirPath: string) => {
    const found = await client.evaluate<boolean>(`(() => {
      const item = document.querySelector('[data-node-id="d:' + ${JSON.stringify(dirPath)} + '"]');
      const row = item?.querySelector('.glosa-tree-row');
      if (!item || !row) return false;
      if (item.getAttribute('aria-expanded') !== 'true') row.click();
      return true;
    })()`);
    if (!found) throw new Error(`no navigator directory row for ${dirPath}`);
  };

  /** Moves the ACTIVE tab into a tab group of its own, through the same single-pointer menu
   * command WCAG 2.2 SC 2.5.7 requires glosa to offer beside the drag (§9). */
  const moveActiveTabToNewGroup = async (client: CdpClient, path: string) => {
    await clickInPane(client, path, ".glosa-tools-trigger");
    await clickInPane(client, path, '.glosa-pane-menu-move[data-direction="new"]');
  };

  const paneFor = (state: PageState, path: string) => state.panes.find((pane) => pane.path === path);

  test(
    "§10: the arrangement AND every pane's state come back after a real reload",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");

      await openFromNavigator(tab, BETA);
      await waitForState(tab, "beta opened", (state) => state.panes.length === 2);
      await moveActiveTabToNewGroup(tab, BETA);
      await waitForArrangement(tab, "the split", 2);

      // Beta is the companion: it is NOT the artifact the address bar names, so its mode can only
      // come back from the arrangement.
      await clickInPane(tab, BETA, '.glosa-modebar [data-control="notes"]');
      await waitForState(tab, "beta hides its notes", (state) => paneFor(state, BETA)?.mode === "read");

      await clickTab(tab, ALPHA);
      await waitForState(tab, "alpha focused", (state) => paneFor(state, ALPHA)?.active === true);
      await clickInPane(tab, ALPHA, '.glosa-modebar [data-control="edit"]');
      const before = await waitForState(tab, "alpha edits", (state) => paneFor(state, ALPHA)?.mode === "edit");

      // The arrangement on disk names both panels and carries a mode for each.
      expect(Object.keys(before.layout?.panels ?? {}).sort()).toEqual(
        [ALPHA, BETA].map((path) => JSON.stringify(["artifact", path])),
      );
      expect(before.layout?.panels[JSON.stringify(["artifact", BETA])]?.params?.mode).toBe("read");
      expect(before.layout?.panels[JSON.stringify(["artifact", ALPHA])]?.params?.mode).toBe("edit");

      await tab.reload();
      await waitForReady(tab, "after reload");
      const after = await waitForArrangement(tab, "the restored split", 2);

      expect(after.tabs.sort()).toEqual([ALPHA, BETA]);
      expect(paneFor(after, ALPHA)?.active).toBe(true);
      expect(paneFor(after, ALPHA)?.mode).toBe("edit");
      // The one assertion the URL cannot satisfy: beta is not the focused artifact, so without
      // per-pane persistence it comes back in whatever state it was FIRST opened with.
      expect(paneFor(after, BETA)?.mode).toBe("read");

      const hash = new URLSearchParams(after.hash.slice(1));
      expect(hash.get("w")).toBe(slug);
      expect(hash.get("a")).toBe(ALPHA);
      expect(hash.get("mode")).toBe("edit");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "§2/§10: the mode control addresses ONE pane, and the keyboard follows the focused one",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");
      await openFromNavigator(tab, BETA);
      await waitForState(tab, "beta opened", (state) => state.panes.length === 2);
      await moveActiveTabToNewGroup(tab, BETA);
      const split = await waitForArrangement(tab, "the split", 2);

      // Exactly one live mode control on the page, in the pane everything else addresses. Laid
      // out, not merely present in the DOM: the others are `display: none`, not `hidden`.
      expect(split.panes.filter((pane) => pane.liveModeBar).map((pane) => pane.path)).toEqual([BETA]);
      // ...and the pane that does not offer one still states where it stands.
      expect(paneFor(split, ALPHA)?.modeLabel).toBe(paneFor(split, ALPHA)?.mode ?? "");

      // ⌘1 is Read. It must move the focused pane and leave the other exactly where it was.
      const alphaBefore = paneFor(split, ALPHA)?.mode;
      await tab.metaKeyPress("1", "Digit1", 49);
      const afterOne = await waitForState(tab, "beta reads", (state) => paneFor(state, BETA)?.mode === "read");
      expect(paneFor(afterOne, ALPHA)?.mode).toBe(alphaBefore ?? null);

      await clickTab(tab, ALPHA);
      await waitForState(tab, "alpha focused", (state) => paneFor(state, ALPHA)?.active === true);
      await tab.metaKeyPress("3", "Digit3", 51);
      const afterThree = await waitForState(tab, "alpha edits", (state) => paneFor(state, ALPHA)?.mode === "edit");
      // The companion did not follow the keystroke into Edit.
      expect(paneFor(afterThree, BETA)?.mode).toBe("read");
      expect(afterThree.panes.filter((pane) => pane.liveModeBar).map((pane) => pane.path)).toEqual([ALPHA]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "§11: a class-F pane's iframe survives a tab switch and a tab move — same frame, no reload, no re-mint",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openBlankTab(browser, cdpPort);

      // Instrument on the WIRE, before anything loads. Two counters, both daemon-visible:
      //   mints   — POSTs to the capability route. A1 §7 makes one mint per iframe open the
      //             contract, and a re-mint is one half of "the frame was remounted".
      //   docLoads — GETs of the minted document itself, on the class-F origin. This is the half
      //             a re-mint does NOT catch: the capability token is multi-request, so an iframe
      //             that is reparented fetches the SAME url again without minting a new one.
      // Counting in the page instead would race the frame's own first load against the moment
      // the probe is armed; the socket sees both in order.
      let mints = 0;
      let docLoads = 0;
      await tab.send("Network.enable");
      tab.on((msg) => {
        if (msg.method !== "Network.requestWillBeSent") return;
        const { url, method } = msg.params?.request ?? {};
        if (typeof url !== "string") return;
        if (method === "POST" && url.includes("/capability/")) mints += 1;
        if (msg.params?.type === "Document" && url.includes(`:${port + 1}/doc/`)) docLoads += 1;
      });

      await tab.navigate(pairedUrl(PREVIEW));
      await waitForReady(tab, "preview opened");
      await waitForState(tab, "the preview frame loads", () => mints >= 1 && docLoads >= 1);
      expect(mints).toBe(1);
      expect(docLoads).toBe(1);

      // Element and window identity are the page-side witnesses: a frame taken out of the
      // document and put back gets a new `contentWindow` even though the element object itself
      // is unchanged, so identity alone would not notice a reparent.
      const armed = await tab.evaluate<boolean>(`(() => {
        const frame = document.querySelector('.glosa-classf-frame iframe');
        if (!frame) return false;
        window.__probe = { frame, contentWindow: frame.contentWindow };
        return true;
      })()`);
      expect(armed, "the class-F iframe never appeared").toBe(true);

      await openFromNavigator(tab, ALPHA);
      await waitForState(tab, "alpha opened beside the preview", (state) => state.panes.length === 2);

      const probe = `(() => {
        const frame = document.querySelector('.glosa-classf-frame iframe');
        return {
          sameElement: frame === window.__probe.frame,
          sameWindow: Boolean(frame) && frame.contentWindow === window.__probe.contentWindow,
          connected: Boolean(frame) && frame.isConnected,
        };
      })()`;

      // (a) switch away to the manuscript tab and back.
      await clickTab(tab, ALPHA);
      await waitForState(tab, "alpha focused", (state) => paneFor(state, ALPHA)?.active === true);
      await clickTab(tab, PREVIEW);
      await waitForState(tab, "preview focused again", (state) => paneFor(state, PREVIEW)?.active === true);

      const afterSwitch = await tab.evaluate<any>(probe);
      expect(afterSwitch).toEqual({ sameElement: true, sameWindow: true, connected: true });
      expect({ mints, docLoads }).toEqual({ mints: 1, docLoads: 1 });

      // (b) move the preview into a tab group of its own — the pane physically changes place.
      await moveActiveTabToNewGroup(tab, PREVIEW);
      const moved = await waitForArrangement(tab, "the preview in its own group", 2);

      const afterMove = await tab.evaluate<any>(probe);
      expect(afterMove).toEqual({ sameElement: true, sameWindow: true, connected: true });
      expect({ mints, docLoads }).toEqual({ mints: 1, docLoads: 1 });
      // A second `load` is what `classf-viewer.js` reads as the document navigating itself; that
      // path ends in a torn-down frame and this message. Its absence is the reader-facing half.
      expect(paneFor(moved, PREVIEW)?.classFError).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  // issue #337's own path: an artifact whose name needs percent-encoding. Cost kept small — ONE
  // browser process, THREE tabs total (one initial + two fragment-form navigations), and the
  // non-ASCII document is exercised by tree click only: it has no space, so the `+`/`%20`
  // distinction the OTHER two tabs exist to prove is not a distinct case for it (that decode path
  // is already pinned by the GET name-table unit coverage in http-routes.test.ts).
  test(
    "issue #337: a document in a spaced folder, and a non-ASCII-named document, open and render — by tree click, and (the spaced one) by both the `+` and `%20` fragment forms",
    async () => {
      const FOLDER_PATH = "My Folder/doc.md";
      const FOLDER_TEXT = "This document lives inside a folder whose name has a space.";
      const NON_ASCII_PATH = "café.md";
      const NON_ASCII_TEXT = "This document's own name is not ASCII.";
      mkdirSync(join(workspaceRoot, "My Folder"), { recursive: true });
      writeFileSync(join(workspaceRoot, "My Folder", "doc.md"), `# Folder doc\n\n${FOLDER_TEXT}\n`);
      writeFileSync(join(workspaceRoot, "café.md"), `# Café\n\n${NON_ASCII_TEXT}\n`);

      const { browser, cdpPort } = await launchBrowser();

      // (a) tree click, both documents, one tab.
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");

      await expandFolderInTree(tab, "My Folder");
      await openFromNavigator(tab, FOLDER_PATH);
      const folderByClick = await waitForState(
        tab,
        "folder doc opened by tree click",
        // `active` flips synchronously on open, before the fetched content mounts — wait for the
        // text itself so this doesn't pass on a still-empty pane.
        (state) => paneFor(state, FOLDER_PATH)?.active === true && paneFor(state, FOLDER_PATH)!.text.length > 0,
      );
      expect(paneFor(folderByClick, FOLDER_PATH)?.text).toContain(FOLDER_TEXT);
      expect(paneFor(folderByClick, FOLDER_PATH)?.errorTitle).toBe("");

      await openFromNavigator(tab, NON_ASCII_PATH);
      const nonAsciiByClick = await waitForState(
        tab,
        "non-ASCII doc opened by tree click",
        (state) => paneFor(state, NON_ASCII_PATH)?.active === true && paneFor(state, NON_ASCII_PATH)!.text.length > 0,
      );
      expect(paneFor(nonAsciiByClick, NON_ASCII_PATH)?.text).toContain(NON_ASCII_TEXT);
      expect(paneFor(nonAsciiByClick, NON_ASCII_PATH)?.errorTitle).toBe("");

      // (b) the `+` form `glosa_present` emits (URLSearchParams' space spelling).
      const plusUrl = `${origin()}/#t=${TOKEN}&w=${slug}&a=My+Folder%2Fdoc.md&surface=document&mode=review`;
      const plusTab = await openTab(browser, cdpPort, plusUrl);
      const afterPlus = await waitForState(
        plusTab,
        "`+`-form fragment open",
        (state) => state.screens.includes("ready") && Boolean(paneFor(state, FOLDER_PATH)?.text.length),
      );
      expect(paneFor(afterPlus, FOLDER_PATH)?.text).toContain(FOLDER_TEXT);
      expect(paneFor(afterPlus, FOLDER_PATH)?.errorTitle).toBe("");
      // After the app rewrites its own fragment (scrubSecrets strips `t=`), the view is still
      // this document — the rewrite is a hash replace, never a navigation away from it.
      const plusHash = new URLSearchParams((await plusTab.evaluate<string>("location.hash")).slice(1));
      expect(plusHash.get("a")).toBe(FOLDER_PATH);
      expect(plusHash.has("t")).toBe(false);

      // (c) the `%20` form — same artifact, the other space spelling.
      const percentUrl = `${origin()}/#t=${TOKEN}&w=${slug}&a=My%20Folder%2Fdoc.md&surface=document&mode=review`;
      const percentTab = await openTab(browser, cdpPort, percentUrl);
      const afterPercent = await waitForState(
        percentTab,
        "`%20`-form fragment open",
        (state) => state.screens.includes("ready") && Boolean(paneFor(state, FOLDER_PATH)?.text.length),
      );
      expect(paneFor(afterPercent, FOLDER_PATH)?.text).toContain(FOLDER_TEXT);
      expect(paneFor(afterPercent, FOLDER_PATH)?.errorTitle).toBe("");
      const percentHash = new URLSearchParams((await percentTab.evaluate<string>("location.hash")).slice(1));
      expect(percentHash.get("a")).toBe(FOLDER_PATH);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "ended native logins remove browser links, reject terminal input and explain recovery",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "before native login");
      // Real xterm/DOM/input; synthetic operation responses avoid real provider credentials.
      for (const outcome of ["expired", "completed", "failed", "stopping"]) {
        await tab.evaluate(`(async () => {
          const { mountAgentLogin } = await import('/app/agent-login.js');
          const host = document.createElement('main'); document.body.replaceChildren(host);
          const fixture = window.loginFixture = { writes: [], reads: 0 };
          fixture.mounted = await mountAgentLogin(host, {
            profile: { id: 'fixture', label: 'Test account' },
            dataAccess: {
              loginAgent: async () => ({ id: 'operation', secret: 'test-only', authHosts: ['auth.example.test'] }),
              readAgentLogin: async () => {
                if (!fixture.reads++) return { state: 'running', output: btoa('https://auth.example.test/authorize?state=fixture\\r\\n'), offset: 1 };
                return new Promise((resolve, reject) => { fixture.resolve = resolve; fixture.reject = reject; });
              },
              resizeAgentLogin: async () => {},
              writeAgentLogin: async (_id, _secret, data) => fixture.writes.push(data),
              finishAgentLogin: async () => {},
            },
          });
          await new Promise((resolve, reject) => {
            const deadline = Date.now() + 3000;
            const check = () => fixture.resolve ? resolve() : Date.now() > deadline ? reject(new Error('login poll missing')) : requestAnimationFrame(check);
            check();
          });
        })()`);
        expect(await tab.evaluate<boolean>("!document.querySelector('main a').hidden")).toBe(true);
        await tab.evaluate(`(() => {
          if (${JSON.stringify(outcome)} === 'expired') loginFixture.reject(Object.assign(new Error('login unavailable'), {problem:{type:'https://glosa.local/errors/login-not-found'}}));
          else loginFixture.resolve({state:${JSON.stringify(outcome)},output:'',offset:1});
        })()`);
        const ended = await tab.evaluate<{ hidden: boolean; href: string | null; status: string; button: string }>(
          `new Promise(resolve => requestAnimationFrame(() => resolve({
            hidden:document.querySelector('main a').hidden, href:document.querySelector('main a').getAttribute('href'),
            status:document.querySelector('[role=status]').textContent, button:document.querySelector('main > button').textContent
          })))`,
        );
        expect(ended.hidden).toBe(true);
        expect(ended.href).toBeNull();
        expect(ended.button).toBe("Close terminal");
        expect(ended.status).toContain(
          outcome === "expired"
            ? "choose Sign in again"
            : outcome === "completed"
              ? "check the account"
              : outcome === "stopping"
                ? "wait for cleanup"
                : "try again",
        );
        await tab.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
        await tab.send("Input.insertText", { text: "late authentication code" });
        expect(
          await tab.evaluate<number>(
            "new Promise(resolve => requestAnimationFrame(() => resolve(loginFixture.writes.length)))",
          ),
        ).toBe(0);
        await tab.evaluate("loginFixture.mounted.destroy()");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "managed chat renders safely, preserves selection while streaming, and sends real keyboard input",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "before managed pane");
      // Real renderer/input/layout, deterministic transport. This is not a native-provider claim.
      await tab.evaluate(`(async () => {
      const { createChatPane } = await import('/app/chat-pane.js');
      const host = document.createElement('main'); host.style.cssText = 'height:100vh;width:100%;padding:12px;box-sizing:border-box';
      document.body.replaceChildren(host);
      const state = { id:'fixture', profileId:'a', provider:'claude-code', title:'Review the outline', revision:1,
        configRevision:1, draftRevision:0, draft:'', draftAttachments:[], archived:false,
        settings:{model:'model',effort:'high',permissionMode:'default'},
        turns:[{id:'first',text:'Review my outline',status:'completed'}],
        content:[{id:'reply',turnId:'first',kind:'text',role:'assistant',text:'A **clear opening**. <img src=x onerror=alert(1)>'}], decisions:[] };
      window.chatFixture = { state, sends:[], answers:[] };
      const access = {
        getAgentStatus: async () => ({available:true,profiles:[{id:'a',provider:'claude-code',label:'Personal',enabled:true}],capabilities:{a:{models:[{id:'model',name:'Model',efforts:['high']}]}}}),
        getChat: async () => structuredClone(state),
        openChatStream: (_slug,_id,callbacks) => { window.chatFixture.stream=callbacks; return () => {}; },
        saveChatDraft: async (_s,_i,input) => { state.draft=input.text; state.draftRevision++; return structuredClone(state); },
        sendChatTurn: async (_s,_i,input) => { window.chatFixture.sends.push(input); state.turns.push({id:input.turnId,text:input.text,status:'completed'}); state.draft=''; state.draftRevision++; state.revision++; return {}; },
        answerChatDecision: async (_s,_i,input) => { window.chatFixture.answers.push(input); state.decisions[0].status='answered'; state.revision++; },
      };
      window.chatFixture.pane=createChatPane(host,{dataAccess:access,slug:'fixture',chatId:'fixture',onChange(){},onSettings(){}});
      await window.chatFixture.pane.ready;
      await new Promise(resolve => requestAnimationFrame(resolve));
    })()`);
      expect(
        await tab.evaluate<number>(
          "document.querySelectorAll('.glosa-chat-history img, .glosa-chat-history script').length",
        ),
      ).toBe(0);
      expect(await tab.evaluate<string>("document.querySelector('.glosa-chat-history strong')?.textContent")).toBe(
        "clear opening",
      );
      const selected = await tab.evaluate<string>(`(() => {
      const text = document.querySelector('.glosa-chat-history strong').firstChild;
      const range=document.createRange(); range.selectNodeContents(text); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
      chatFixture.stream.onEvent({event:'chat_event',data:{seq:2,data:{type:'content',content:{id:'reply',turnId:'first',kind:'text',role:'assistant',text:' More context.'}}}});
      return selection.toString();
    })()`);
      expect(selected).toBe("clear opening");
      await tab.evaluate("getSelection().removeAllRanges(); document.querySelector('[aria-label=Message]').focus()");
      await tab.send("Input.insertText", { text: "Please expand this section" });
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      const submitted = await tab.evaluate<string>(`new Promise((resolve,reject) => { const deadline=Date.now()+3000;
      const check=()=>{if(chatFixture.sends.length) resolve(chatFixture.sends[0].text); else if(Date.now()>deadline) reject(new Error('keyboard send not observed')); else requestAnimationFrame(check)}; check(); })`);
      expect(submitted).toBe("Please expand this section");
      await tab.send("Emulation.setDeviceMetricsOverride", {
        width: 480,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await tab.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`);
      const layout = await tab.evaluate<{
        viewport: number;
        width: number;
        buttons: number;
        history: number;
        height: number;
        composerRight: number;
      }>(
        `({viewport:innerWidth,width:document.body.scrollWidth,buttons:[...document.querySelectorAll('.glosa-chat-pane button')].filter(b=>b.getBoundingClientRect().width>0).length,history:document.querySelector('.glosa-chat-history').clientHeight,height:innerHeight,composerRight:document.querySelector('.glosa-chat-composer').getBoundingClientRect().right})`,
      );
      expect(layout.width).toBeLessThanOrEqual(layout.viewport);
      expect(layout.buttons).toBeGreaterThan(5);
      expect(layout.history).toBeGreaterThan(layout.height * 0.4);
      expect(layout.composerRight).toBeLessThanOrEqual(layout.viewport);
      const screenshot = await tab.send("Page.captureScreenshot", { format: "png" });
      mkdirSync(".context/test-results", { recursive: true });
      writeFileSync(
        `.context/test-results/managed-chat-browser-${Date.now()}.png`,
        Buffer.from(screenshot.result.data, "base64"),
      );
      // Account controls use the same real browser: test the low-on-screen menu, not a DOM shim.
      await tab.evaluate(`(async () => {
        chatFixture.pane.destroy();
        const { mountAgentSettings } = await import('/app/agent-settings.js');
        const profiles = Array.from({length:4}, (_,i)=>({id:'p'+i,provider:'claude-code',label:'Account '+(i+1),enabled:true,revision:1,isDefault:i===0,auth:{state:'authenticated',plan:'Max',observedAt:new Date().toISOString()},mcpServers:[]}));
        window.accountFixture={updates:[]};
        const capabilities=Object.fromEntries(profiles.map(p=>[p.id,{models:[{id:'model',name:'Model',efforts:['high']}]}]));
        accountFixture.pane=mountAgentSettings(document.querySelector('main'), {dataAccess:{
          getAgentStatus:async()=>structuredClone({available:true,providers:[{id:'claude-code',name:'Claude Code',installed:true,qualified:true},{id:'codex',name:'Codex',installed:true,qualified:true}],profiles,capabilities}),
          updateAgentProfile:async(id,input)=>{accountFixture.updates.push({id,...input});const profile=profiles.find(p=>p.id===id);Object.assign(profile,input,{revision:profile.revision+1});}
        }});
        await accountFixture.pane.ready;
        const last=document.querySelector('[data-profile-id="p3"]');
        last.scrollIntoView({block:'end'});
        last.querySelector('.glosa-agent-menu-trigger').click();
        await new Promise(resolve=>requestAnimationFrame(resolve));
      })()`);
      const menuBounds = await tab.evaluate<{ top: number; bottom: number; height: number }>(
        `(()=>{const rect=document.querySelector('.glosa-agent-menu:popover-open').getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,height:innerHeight}})()`,
      );
      expect(menuBounds.top).toBeGreaterThanOrEqual(0);
      expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.height);
      await tab.evaluate("document.querySelector('.glosa-agent-menu:popover-open button').focus()");
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      expect(
        await tab.evaluate<boolean>(
          "document.activeElement === document.querySelector('[data-profile-id=\"p3\"] .glosa-agent-menu-trigger')",
        ),
      ).toBe(true);
      expect(await tab.evaluate<number>("document.querySelectorAll('.glosa-agent-menu:popover-open').length")).toBe(0);
      await tab.evaluate(`(async()=>{
        const card=document.querySelector('[data-profile-id="p3"]');card.querySelector('.glosa-agent-menu-trigger').click();
        [...card.querySelectorAll('.glosa-agent-menu button')].find(b=>b.textContent==='Make default').click();
        const deadline=Date.now()+3000;
        while(!document.querySelector('[data-profile-id="p3"] .glosa-agent-default')) {
          if(Date.now()>deadline) throw new Error('Default account did not update');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
      })()`);
      expect(
        await tab.evaluate<{ id: string; revision: number; isDefault: boolean }>(
          "({id:accountFixture.updates[0].id,revision:accountFixture.updates[0].revision,isDefault:accountFixture.updates[0].isDefault})",
        ),
      ).toEqual({ id: "p3", revision: 1, isDefault: true });
      await tab.evaluate(
        `{ [...document.querySelectorAll('.glosa-agent-tabs button')].find(b=>b.textContent==='Codex').click(); }`,
      );
      expect(
        await tab.evaluate<string>(
          "document.querySelector('[data-provider-panel]:not([hidden])').dataset.providerPanel",
        ),
      ).toBe("codex");
      await tab.evaluate("accountFixture.pane.destroy()");
    },
    TEST_TIMEOUT_MS,
  );
});
