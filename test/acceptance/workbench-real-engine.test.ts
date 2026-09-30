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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSha256 } from "../../packages/daemon/src/artifact-render.ts";
import { runGit } from "../../packages/daemon/src/git/shadow.ts";
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

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000, sessionId?: string): Promise<any> {
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
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    accept: (state: PageState) => boolean | Promise<boolean>,
    attempts = 240,
  ): Promise<PageState> {
    let last: PageState | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        last = await client.evaluate<PageState>(pageStateExpression(slug));
        if (last && (await accept(last))) return last;
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
    "read-only source tabs virtualize, search, wrap, restore and follow disk changes without loading remote code",
    async () => {
      const source = Array.from({ length: 20_000 }, (_, i) => `const value${i} = ${i};`).join("\n");
      writeFileSync(join(workspaceRoot, "source.ts"), source);
      writeFileSync(join(workspaceRoot, "binary.dat"), Buffer.from([0, 255]));
      writeFileSync(join(workspaceRoot, ".gitignore"), "ignored.log\n");
      writeFileSync(join(workspaceRoot, "ignored.log"), "ignored content");
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, `${pairedUrl(ALPHA)}&kind=desk`);
      const wait = async (expression: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            if (await tab.evaluate<boolean>(expression)) return;
          } catch {
            /* reload context */
          }
          await Bun.sleep(25);
        }
        throw new Error(
          `Read-only browser state missing: ${expression}; ${await tab.evaluate("document.body.innerText")}`,
        );
      };
      await waitForReady(tab, "desk ready");
      await wait(`!!document.querySelector('[data-node-id="f:source.ts"]')`);
      expect(
        await tab.evaluate<unknown>(
          `performance.getEntriesByType('resource').some(r => r.name.includes('codemirror.js'))`,
        ),
      ).toBe(false);
      expect(
        await tab.evaluate<unknown>(
          `document.querySelector('[data-node-id="f:source.ts"]').getAttribute('aria-label')`,
        ),
      ).toContain("read-only");
      expect(await tab.evaluate<unknown>(`!!document.querySelector('[data-node-id="f:ignored.log"]')`)).toBe(false);
      await openFromNavigator(tab, "binary.dat");
      await wait(`document.querySelector('.glosa-read-only-status')?.textContent.includes('Binary file')`);
      expect(
        await tab.evaluate<unknown>(
          `performance.getEntriesByType('resource').some(r => r.name.includes('codemirror.js'))`,
        ),
      ).toBe(false);
      await openFromNavigator(tab, "source.ts");
      await wait(`document.querySelectorAll('.cm-line').length > 0`);
      expect(await tab.evaluate<number>(`document.querySelectorAll('.cm-line').length`)).toBeLessThan(500);
      // Font metrics and CodeMirror's deferred measurement must settle before comparing bounds.
      await tab.evaluate(
        `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
      );
      const bounds = await tab.evaluate<{
        footerHeight: number;
        footerBottom: number;
        footerTop: number;
        editorHeight: number;
        editorBottom: number;
        viewport: number;
      }>(`(() => {
        const pane = document.querySelector('.glosa-read-only-pane[aria-label="Read-only file: source.ts"]');
        const footer = pane.querySelector('.glosa-read-only-metadata').getBoundingClientRect();
        const editor = pane.querySelector('.cm-editor').getBoundingClientRect();
        return {footerHeight:footer.height, footerBottom:footer.bottom, footerTop:footer.top, editorHeight:editor.height, editorBottom:editor.bottom, viewport:innerHeight};
      })()`);
      const geometry = JSON.stringify(bounds);
      expect(bounds.footerHeight, geometry).toBeGreaterThan(0);
      // A physical pixel of rounding is harmless; losing the footer's row is not.
      expect(bounds.footerBottom, geometry).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(bounds.editorHeight, geometry).toBeGreaterThan(100);
      expect(bounds.editorBottom, geometry).toBeLessThanOrEqual(bounds.footerTop + 1);
      expect(
        await tab.evaluate<unknown>(`document.querySelector('.cm-content').getAttribute('contenteditable')`),
      ).not.toBe("true");
      await tab.evaluate(`document.querySelector('.cm-content').focus()`);
      await tab.send("Input.insertText", { text: "not an edit" });
      expect(readFileSync(join(workspaceRoot, "source.ts"), "utf8")).toBe(source);
      await tab.evaluate(
        `[...document.querySelectorAll('.glosa-read-only-toolbar button')].find(b => b.textContent === 'Find' && !b.disabled).click()`,
      );
      await wait(`!!document.querySelector('.cm-search input[name="search"]')`);
      await tab.evaluate(`document.querySelector('.cm-search input[name="search"]').focus()`);
      await tab.send("Input.insertText", { text: "value19999" });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "9", code: "Digit9", windowsVirtualKeyCode: 57 });
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
      await wait(`document.querySelector('.cm-content')?.textContent.includes('value19999')`);
      await tab.evaluate(
        `[...document.querySelectorAll('.glosa-read-only-toolbar button')].find(b => b.textContent === 'Wrap lines' && !b.disabled).click()`,
      );
      expect(await tab.evaluate<unknown>(`!!document.querySelector('.cm-lineWrapping')`)).toBe(true);
      // Hiding rows must not close the already-open source pane.
      await tab.evaluate(
        `const select = document.querySelector('.glosa-file-view select'); select.value = 'documents'; select.dispatchEvent(new Event('change', {bubbles:true}));`,
      );
      await wait(`!document.querySelector('[data-node-id="f:source.ts"]')`);
      expect(await tab.evaluate<unknown>(`!!document.querySelector('.cm-content')`)).toBe(true);
      const beforeReload = await tab.evaluate<number>("performance.timeOrigin");
      await tab.send("Page.reload");
      await wait(`performance.timeOrigin > ${beforeReload} && !!document.querySelector('.cm-content')`);
      expect(await tab.evaluate<unknown>(`document.querySelector('.glosa-file-view select').value`)).toBe("documents");
      writeFileSync(join(workspaceRoot, "source.ts"), "const updatedFromDisk = 7;");
      await wait(`document.querySelector('.cm-content')?.textContent.includes('updatedFromDisk')`);
      await browser.send("Browser.grantPermissions", {
        origin: `http://127.0.0.1:${port}`,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      // Establish a different value so a stale clipboard cannot masquerade as a successful copy.
      await tab.evaluate("navigator.clipboard.writeText('before-read-only-copy')");
      await tab.evaluate(`(() => {
      document.querySelector('.cm-content').focus();
      const line = document.querySelector('.cm-line'); const range = document.createRange();
      range.selectNodeContents(line); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "c",
        code: "KeyC",
        modifiers: 4,
        windowsVirtualKeyCode: 67,
        commands: ["copy"],
      });
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "c",
        code: "KeyC",
        modifiers: 4,
        windowsVirtualKeyCode: 67,
      });
      await wait(`navigator.clipboard.readText().then(text => text === "const updatedFromDisk = 7;")`);
      expect(await tab.evaluate<string>("navigator.clipboard.readText()")).toBe("const updatedFromDisk = 7;");
      // A second authenticated desk follows the same folder preference over SSE.
      const other = await openTab(browser, cdpPort, `${pairedUrl(ALPHA)}&kind=desk`);
      await waitForReady(other, "second desk ready");
      await other.evaluate(`document.querySelector('.glosa-file-view summary').click()`);
      await other.evaluate(
        `const select = document.querySelector('.glosa-file-view select'); select.value = 'all'; select.dispatchEvent(new Event('change', {bubbles:true}));`,
      );
      await wait(
        `document.querySelector('.glosa-file-view select').value === 'all' && !!document.querySelector('[data-node-id="f:source.ts"]')`,
      );
      await tab.evaluate(
        `document.querySelector('.glosa-file-view').open = true; document.querySelector('.glosa-file-view input').click()`,
      );
      await wait(`!!document.querySelector('[data-node-id="f:ignored.log"]')`);
      // Unknown grammar and a near-limit single line still leave the controls responsive.
      writeFileSync(join(workspaceRoot, "long.unknown"), "x".repeat(2 * 1024 * 1024));
      await wait(`!!document.querySelector('[data-node-id="f:long.unknown"]')`);
      await openFromNavigator(tab, "long.unknown");
      await wait(
        `!!document.querySelector('.glosa-read-only-pane[aria-label="Read-only file: long.unknown"] .cm-content')`,
      );
      expect(
        await tab.evaluate<number>(
          `document.querySelector('.glosa-read-only-pane[aria-label="Read-only file: long.unknown"] .cm-content').textContent.length`,
        ),
      ).toBeLessThan(100_000);
      await openFromNavigator(tab, "source.ts");
      unlinkSync(join(workspaceRoot, "source.ts"));
      await wait(
        `document.querySelector('.glosa-read-only-pane[aria-label="Read-only file: source.ts"] .glosa-read-only-status')?.textContent.includes('not in the read-only listing')`,
      );
      expect(
        await tab.evaluate<unknown>(
          `performance.getEntriesByType('resource').filter(r => !r.name.startsWith(location.origin) && !r.name.startsWith('data:')).map(r=>r.name)`,
        ),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a person opens Edit during an exclusive claim and saves with honest human takeover",
    async () => {
      const api = async (route: string, body: unknown) =>
        fetch(`${origin()}${route}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const note = await (
        await api(`/w/${slug}/annotations`, {
          artifact_path: ALPHA,
          body: "Revise",
          intent: "content",
          target: { quote: { exact: ALPHA_TEXT } },
        })
      ).json();
      const held = await api("/api/workspaces/claims", {
        path: workspaceRoot,
        resources: [`entry:${note.id}`],
        session: "writer-458",
      });
      expect(held.status).toBe(201);
      writeFileSync(join(workspaceRoot, ALPHA), "# Alpha\n\nAgent draft in progress.\n");
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "claimed document opened");
      await waitForState(tab, "claim badge hydrated", async () =>
        Boolean(
          await tab.evaluate(
            `(() => { const edit = document.querySelector('.glosa-pane [data-control="edit"]'); return edit && !edit.disabled && edit.title.includes('working here'); })()`,
          ),
        ),
      );
      await clickInPane(tab, ALPHA, '[data-control="edit"]');
      await waitForState(tab, "Edit available during the claim", (state) => paneFor(state, ALPHA)?.mode === "edit");
      await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
      await clickInPane(tab, ALPHA, ".glosa-tools-edit-source");
      await clickInPane(tab, ALPHA, ".glosa-face-source");
      await tab.evaluate(
        `(() => { const area = document.querySelector('.glosa-edit-area'); area.focus(); area.select(); })()`,
      );
      await tab.send("Input.insertText", { text: "# Alpha\n\nHuman revision.\n" });
      await clickInPane(tab, ALPHA, ".glosa-save");
      await waitForState(
        tab,
        "human bytes saved",
        () => readFileSync(join(workspaceRoot, ALPHA), "utf8") === "# Alpha\n\nHuman revision.\n",
      );
      await waitForState(
        tab,
        "save acknowledged",
        async () =>
          (await tab.evaluate<string>("document.querySelector('.glosa-edit-status')?.textContent")) === "Saved.",
      );
      const journal = readFileSync(join(workspaceRoot, ".glosa", "journal.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal).toContainEqual(
        expect.objectContaining({
          event: "claim_released",
          by: "human",
          detail: expect.objectContaining({ reason: "released_by_human", holder_session: "writer-458" }),
        }),
      );
      const log = (await runGit(workspaceRoot, ["log", "-3", "--format=%B"])).stdout;
      expect(log).toContain("Glosa-Attribution: human");
      expect(log).toContain("Glosa-Attribution: unknown");
      expect(log).not.toContain("Glosa-Attribution: session:writer-458");
      const late = await api("/api/workspaces/resolve", {
        path: workspaceRoot,
        entry: note.id,
        outcome: "applied",
        session: "writer-458",
      });
      expect(late.status).toBe(409);
      expect((await late.json()).type).toEndWith("/claim-revoked");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a new class-F note keeps its exact source position through posting and reload",
    async () => {
      const hash = sourceSha256(Buffer.from(`# Alpha\n\n${ALPHA_TEXT}\n`));
      writeFileSync(join(workspaceRoot, PREVIEW), `<!doctype html><p data-chunk-id="chunk-1">${ALPHA_TEXT}</p>`);
      writeFileSync(
        join(workspaceRoot, "manifest.json"),
        JSON.stringify({
          manifest_version: 1,
          source_path: ALPHA,
          source_sha256: hash,
          chunks: [
            { chunk_id: "chunk-1", source_start_line: 0, source_end_line: 3, source_sha256: hash, transformed: false },
          ],
        }),
      );
      const metadata = await fetch(`${origin()}/w/${slug}/metadata`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin(), "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          id: "neutral-preview",
          artifacts: [
            { path: ALPHA, class: "R" },
            {
              path: PREVIEW,
              class: "F",
              derived_from: { path: ALPHA, via: "render" },
              manifest: { path: "manifest.json", component: "read" },
            },
          ],
        }),
      });
      expect(metadata.ok).toBe(true);
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "workspace opened");
      await openFromNavigator(tab, PREVIEW);
      await waitForState(tab, "class-F document opened", (state) => Boolean(paneFor(state, PREVIEW)));
      const deadline = Date.now() + 10000;
      let composer = false;
      let frameSession: string | undefined;
      while (Date.now() < deadline && !composer) {
        if (!frameSession) {
          const targets = await browser.send("Target.getTargets");
          const target = targets.result?.targetInfos?.find(
            (target: any) => target.type === "iframe" && target.url.includes(`:${port + 1}/`),
          );
          if (target) {
            const attached = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
            frameSession = attached.result.sessionId;
          }
        }
        if (frameSession) {
          await browser.send(
            "Runtime.evaluate",
            {
              expression: `(() => { const p=document.querySelector('[data-chunk-id]'); if(!p)return; const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,p.firstChild.textContent.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()`,
            },
            15000,
            frameSession,
          );
        }
        composer = await tab.evaluate<boolean>(`!!document.querySelector('.glosa-composer-input')`);
        if (!composer) await Bun.sleep(25);
      }
      expect(composer, "selection inside the sandboxed preview reached the composer").toBe(true);
      await tab.evaluate(`document.querySelector('.glosa-composer-input').focus()`);
      await tab.send("Input.insertText", { text: "Please revise this sentence." });
      await clickInPane(tab, PREVIEW, ".glosa-composer-send");
      const card = `document.querySelector('.glosa-annotation')`;
      await waitForState(tab, "class-F note posted", async () =>
        Boolean(await tab.evaluate(`${card}?.textContent.includes('Please revise this sentence.')`)),
      );
      expect(await tab.evaluate(`${card}.textContent`)).not.toContain("Lost its place");
      expect(await tab.evaluate<string>(`${card}.getAttribute('data-anchored')`)).toBe("true");
      await tab.reload();
      await waitForReady(tab, "class-F note reloaded");
      await waitForState(tab, "class-F note hydrated", async () => Boolean(await tab.evaluate(card)));
      expect(await tab.evaluate(`${card}.textContent`)).not.toContain("Lost its place");
      const annotations = await (
        await fetch(`${origin()}/w/${slug}/annotations?artifact=${PREVIEW}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).json();
      const note = annotations.annotations[0];
      expect(note.resolution).toMatchObject({ kind: "source_range", path: ALPHA });
      const claim = await fetch(`${origin()}/api/workspaces/claims`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin(), "Content-Type": "application/json" },
        body: JSON.stringify({ path: workspaceRoot, resources: [`entry:${note.id}`], session: "class-f-writer" }),
      });
      expect(claim.status).toBe(201);
      expect((await claim.json()).paths).toEqual([ALPHA, PREVIEW]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "tree rename keeps a real source editor and its group, then saves at the new path",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, `${pairedUrl(ALPHA)}&kind=desk`);
      await waitForReady(tab, "file actions ready");
      await openFromNavigator(tab, BETA);
      await moveActiveTabToNewGroup(tab, BETA);
      await waitForArrangement(tab, "two file groups", 2);
      await clickTab(tab, ALPHA);
      await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
      await clickInPane(tab, ALPHA, ".glosa-tools-edit-source");
      await clickInPane(tab, ALPHA, ".glosa-face-source");
      await tab.evaluate(`(() => {
        const area = document.querySelector('.glosa-pane[aria-label="alpha.md"] .glosa-edit-area');
        window.keptFileEditor = area; area.focus(); area.select();
      })()`);
      await tab.send("Input.insertText", { text: "Words kept across the rename." });
      await tab.evaluate(`document.querySelector('[data-node-id="f:alpha.md"]').focus()`);
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
      await tab.evaluate(`document.querySelector('.glosa-file-name-editor input').select()`);
      await tab.send("Input.insertText", { text: "renamed.md" });
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
      const after = await waitForState(tab, "renamed editor retained", (state) =>
        state.panes.some((pane) => pane.path === "renamed.md"),
      );
      expect(after.groups).toBe(2);
      expect(paneFor(after, "renamed.md")?.mode).toBe("edit");
      expect(
        await tab.evaluate<boolean>(
          `window.keptFileEditor === document.querySelector('.glosa-pane[aria-label="renamed.md"] .glosa-edit-area')`,
        ),
      ).toBe(true);
      expect(await tab.evaluate<string>(`window.keptFileEditor.value`)).toBe("Words kept across the rename.");
      await clickInPane(tab, "renamed.md", ".glosa-save");
      await waitForState(
        tab,
        "renamed bytes saved",
        () => readFileSync(join(workspaceRoot, "renamed.md"), "utf8") === "Words kept across the rename.",
      );
      expect(existsSync(join(workspaceRoot, ALPHA))).toBe(false);
      await stillShot(tab, "file-tree-443-rename");
    },
    TEST_TIMEOUT_MS,
  );

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
    "#411: a body block's passage address waits for a resting pointer, shows at once on keyboard focus, and never fades under reduced motion",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");
      // Alpha is `# Alpha` over one paragraph: the title shows §0 in the gutter, the paragraph §0.1.
      const BODY = '.glosa-pane[data-mode="review"] .glosa-content > p[data-address]';
      await tab.evaluate(`(async()=>{const deadline=Date.now()+5000;
        while(!document.querySelector(${JSON.stringify(BODY)})) {
          if(Date.now()>deadline) throw new Error('no addressed body block in Review');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }})()`);
      // States are forced through the engine's own style resolution rather than by moving a pointer
      // and timing it, so what is asserted is the computed transition, never an elapsed interval.
      await tab.send("DOM.enable");
      await tab.send("CSS.enable");
      const root = (await tab.send("DOM.getDocument", { depth: 0 })).result.root.nodeId;
      const nodeId = (await tab.send("DOM.querySelector", { nodeId: root, selector: BODY })).result.nodeId;
      expect(nodeId, "the body block has a DOM node id").toBeGreaterThan(0);
      const force = (forcedPseudoClasses: string[]) =>
        tab.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses });
      const label = () =>
        tab.evaluate<{ address: string; content: string; delay: string; duration: string }>(`(()=>{
          const block=document.querySelector(${JSON.stringify(BODY)}),style=getComputedStyle(block,'::before');
          return {address:block.dataset.address,content:style.content,delay:style.transitionDelay,duration:style.transitionDuration};
        })()`);
      const seconds = (time: string) =>
        time.endsWith("ms") ? Number.parseFloat(time) / 1000 : Number.parseFloat(time);
      // Pin the motion preference instead of inheriting the host's: a machine that asks for reduced
      // motion (CI runners can) zeroes the fade under the reduced-motion rule, and the first half of
      // this test is about the ordinary fade. The preference reaches style on the next frame.
      const prefer = async (value: "no-preference" | "reduce") => {
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
        await tab.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      };
      await prefer("no-preference");

      const rest = await label();
      expect(rest.address).toBe("§0.1");
      expect(rest.content).toBe('"§0.1"');
      expect(rest.delay, "at rest the label leaves at once").toBe("0s");

      await force(["hover"]);
      const hovered = await label();
      expect(seconds(hovered.delay), `hover-in delay ${hovered.delay}`).toBeGreaterThanOrEqual(0.15);
      expect(seconds(hovered.delay), `hover-in delay ${hovered.delay}`).toBeLessThanOrEqual(0.3);
      expect(seconds(hovered.duration), "the fade itself is unchanged").toBeGreaterThan(0);

      await force(["focus-visible"]);
      expect((await label()).delay, "keyboard focus shows the label at once").toBe("0s");
      await force(["hover", "focus-visible"]);
      expect((await label()).delay, "a focused block under a resting pointer still shows it at once").toBe("0s");

      await force([]);
      // A hover forced before the new preference reaches style would start under the old rules.
      await prefer("reduce");
      await force(["hover"]);
      const reduced = await label();
      expect(reduced.duration, "no fade under reduced motion").toBe("0s");
      expect(seconds(reduced.delay), "the rest delay is not motion, so it stays").toBeGreaterThanOrEqual(0.15);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "under reduced motion nothing in an open document transitions a property that moves it, the notes tray and its chevron included",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");
      // Colour, background and opacity fades are not motion and may stay. These move or resize
      // something on the page, which a reduced-motion request asks to happen at once.
      const sweep = () =>
        tab.evaluate<string[]>(`(()=>{
          const MOVES=/^(all|transform|translate|rotate|scale|inset|top|right|bottom|left|width|height|max-height|min-height|margin.*|grid-template-rows|grid-template-columns)$/;
          const seconds=(time)=>time.endsWith('ms')?Number.parseFloat(time)/1000:Number.parseFloat(time);
          const found=new Set();
          for(const element of document.querySelectorAll('*')){
            const style=getComputedStyle(element);
            const properties=style.transitionProperty.split(',').map(p=>p.trim());
            const durations=style.transitionDuration.split(',').map(d=>seconds(d.trim()));
            properties.forEach((property,index)=>{
              const duration=durations[index%durations.length];
              if(duration>0&&MOVES.test(property)) found.add(String(element.className).split(' ')[0]+' '+property);
            });
          }
          return [...found].sort();
        })()`);
      const prefer = async (value: "no-preference" | "reduce") => {
        await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
        await tab.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      };
      // The positive control: without the request, the sweep sees the tray open and its chevron turn,
      // so a clean sweep below means the rule removed them, not that the sweep cannot see them.
      await prefer("no-preference");
      const moving = await sweep();
      expect(moving, "the tray and its chevron move when motion is allowed").toEqual(
        expect.arrayContaining([
          "glosa-annotations-tray grid-template-rows",
          "glosa-tray-chevron rotate",
          "glosa-tray-chevron translate",
        ]),
      );
      await prefer("reduce");
      expect(await sweep(), "nothing moves under reduced motion").toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a document's More menu is closed when its tab comes back, whether the tab was left by a pointer press or by the keyboard",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "initial open");
      await openFromNavigator(tab, BETA);
      await waitForState(tab, "beta opened", (state) => state.panes.length === 2);
      const menuOpen = (path: string) =>
        tab.evaluate<boolean>(`(()=>{
          const pane=[...document.querySelectorAll('.glosa-pane')].find(p=>p.getAttribute('aria-label')===${JSON.stringify(path)});
          return pane?.querySelector('.glosa-pane-tools')?.getAttribute('data-open')==='true';
        })()`);
      // Ctrl+Tab steps to the next tab and Ctrl+Shift+Tab to the previous one; neither wraps.
      const ctrlTab = async (shift = false) => {
        for (const type of ["keyDown", "keyUp"] as const)
          await tab.send("Input.dispatchKeyEvent", {
            type,
            key: "Tab",
            code: "Tab",
            modifiers: shift ? 10 : 2,
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
          });
      };

      // Left by a real pointer press on the other tab: dockview runs on pointer events, so the
      // press never reaches the page as a click the menu could read as "outside".
      await clickTab(tab, ALPHA);
      await waitForState(tab, "alpha focused", (state) => paneFor(state, ALPHA)?.active === true);
      await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
      expect(await menuOpen(ALPHA), "the menu opened").toBe(true);
      await clickTab(tab, BETA);
      await waitForState(tab, "beta focused", (state) => paneFor(state, BETA)?.active === true);
      await clickTab(tab, ALPHA);
      await waitForState(tab, "alpha back", (state) => paneFor(state, ALPHA)?.active === true);
      expect(await menuOpen(ALPHA), "closed after the tab was left by a pointer press").toBe(false);

      // Left by the keyboard, from inside the open menu, which is where its focus is.
      await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
      expect(await menuOpen(ALPHA), "the menu opened again").toBe(true);
      await ctrlTab();
      await waitForState(tab, "beta by Ctrl+Tab", (state) => paneFor(state, BETA)?.active === true);
      await ctrlTab(true);
      await waitForState(tab, "alpha by Ctrl+Shift+Tab", (state) => paneFor(state, ALPHA)?.active === true);
      expect(await menuOpen(ALPHA), "closed after the tab was left by Ctrl+Tab").toBe(false);
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
    "a companion document follows Go to into another document, and Back returns to the first without a reload (#455)",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, `${pairedUrl(ALPHA)}&surface=document&kind=companion`);
      await waitForState(
        tab,
        "alpha presented",
        (state) => state.screens.includes("ready") && Boolean(paneFor(state, ALPHA)?.text.length),
      );
      // Survives only while the page does: a reload would clear it.
      await tab.evaluate("window.__glosaMarker = 'same page'; true");
      const startLength = await tab.evaluate<number>("history.length");

      const res = await fetch(`${origin()}/api/workspaces/attention-request`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin(), "Content-Type": "application/json" },
        body: JSON.stringify({
          path: workspaceRoot,
          target_path: BETA,
          action: "ask",
          message: "Does the second document still agree with the first?",
        }),
      });
      expect(res.status, `attention-request: ${await res.clone().text()}`).toBe(201);

      const pressed = async (label: string, selector: string, text?: string) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const clicked = await tab.evaluate<boolean>(`(() => {
            const target = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
              .find((el) => ${text === undefined ? "true" : `el.textContent === ${JSON.stringify(text)}`});
            if (!target || target.disabled) return false;
            target.click();
            return true;
          })()`);
          if (clicked) return;
          await Bun.sleep(50);
        }
        throw new Error(`${label}: ${selector} never became pressable`);
      };
      await pressed("the tray", ".glosa-attention-trigger:not([hidden])");
      await pressed("Go to", ".glosa-attention-actions button", "Go to the passage");

      const atBeta = await waitForState(
        tab,
        "beta after Go to",
        (state) => state.panes.length === 1 && Boolean(paneFor(state, BETA)?.text.length),
      );
      expect(new URLSearchParams(atBeta.hash.slice(1)).get("a")).toBe(BETA);
      expect(await tab.evaluate<number>("history.length")).toBe(startLength + 1);

      await tab.evaluate("history.back(); true");
      const backAtAlpha = await waitForState(
        tab,
        "alpha after Back",
        (state) => state.panes.length === 1 && Boolean(paneFor(state, ALPHA)?.text.length),
      );
      expect(paneFor(backAtAlpha, ALPHA)?.text).toContain(ALPHA_TEXT);
      expect(new URLSearchParams(backAtAlpha.hash.slice(1)).get("a")).toBe(ALPHA);
      expect(await tab.evaluate<string>("window.__glosaMarker")).toBe("same page");

      await tab.evaluate("history.forward(); true");
      const forwardAtBeta = await waitForState(
        tab,
        "beta after Forward",
        (state) => state.panes.length === 1 && Boolean(paneFor(state, BETA)?.text.length),
      );
      expect(paneFor(forwardAtBeta, BETA)?.text).toContain(BETA_TEXT);
      expect(await tab.evaluate<string>("window.__glosaMarker")).toBe("same page");
      expect(await tab.evaluate<number>("history.length")).toBe(startLength + 1);

      // The rest of the workspace is one visible control away, and the connection is on screen.
      // Opened, the navigator is a column beside the document, never stacked above or over it.
      const chrome = await tab.evaluate<{
        toggle: number;
        sidebar: { left: number; right: number; top: number; height: number };
        pane: { left: number; top: number };
        connection: string;
      }>(`(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, height: r.height, width: r.width };
        };
        const toggle = box(document.querySelector('.glosa-nav-toggle'));
        document.querySelector('.glosa-nav-toggle').click();
        return {
          toggle: toggle.width * toggle.height,
          sidebar: box(document.querySelector('.glosa-sidebar')),
          pane: box(document.querySelector('.glosa-pane')),
          connection: document.querySelector('.glosa-agent-feedback-trigger')?.textContent ?? '',
        };
      })()`);
      expect(chrome.toggle).toBeGreaterThan(0);
      expect(chrome.sidebar.height).toBeGreaterThan(0);
      expect(chrome.sidebar.left).toBe(0);
      expect(chrome.pane.left).toBeGreaterThanOrEqual(chrome.sidebar.right);
      expect(chrome.sidebar.top).toBeLessThanOrEqual(chrome.pane.top);
      expect(chrome.connection).toContain("Connect agent");
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
    "managed chat renders safely and on the design system in both themes, preserves selection while streaming, and sends real keyboard input",
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
        content:[{id:'reply',turnId:'first',kind:'text',role:'assistant',text:'A **clear opening**. <img src=x onerror=alert(1)>\\n\\n### Next steps\\n\\nRead [the outline guide](https://example.com/guide) before revising.'}], decisions:[] };
      window.chatFixture = { state, sends:[], answers:[], uploads:[], moves:[] };
      const access = {
        getAgentStatus: async () => ({available:true,profiles:[{id:'a',provider:'claude-code',label:'Personal',enabled:true}],capabilities:{a:{models:[{id:'model',name:'Model',efforts:['high']}]}}}),
        getChat: async (_s,id) => structuredClone(id==='source' ? {...state, id:'source',draft:'Source draft',draftRevision:3} : state),
        openChatStream: (_slug,_id,callbacks) => { window.chatFixture.stream=callbacks; return () => {}; },
        saveChatDraft: async (_s,_i,input) => { state.draft=input.text; state.draftAttachments=input.attachments; state.draftRevision++; return structuredClone(state); },
        sendChatTurn: async (_s,_i,input) => { window.chatFixture.sends.push(input); state.turns.push({id:input.turnId,text:input.text,status:'completed'}); state.draft=''; state.draftRevision++; state.revision++; return {}; },
        answerChatDecision: async (_s,_i,input) => { window.chatFixture.answers.push(input); state.decisions[0].status='answered'; state.revision++; },
        previewChatTranscript: async () => ({title:'Previous outline',turnCount:2,text:'# Previous outline\\n\\nA public answer.'}),
        uploadChatAttachment: async (_s,_i,file) => { chatFixture.uploads.push({name:file.name,text:await file.text()});return {name:file.name,mime:file.type,size:file.size,hash:'a'.repeat(64)}; },
        moveChatDraft: async (_s,_i,input) => {chatFixture.moves.push(input);state.draft='Source draft';state.draftRevision++;state.revision++;return {sourceCleared:true};},
      };
      window.chatFixture.pane=createChatPane(host,{dataAccess:access,slug:'fixture',chatId:'fixture',sourceChatId:'source',onChange(){},onSettings(){}});
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
      // Native selects keep keyboard behavior, while their shared custom tooltip stays dismissible.
      expect(
        await tab.evaluate<{ visible: boolean; clearance: number; text: string }>(`(()=>{
        const select=document.querySelector('[aria-label=Effort]');select.focus();
        const tip=document.getElementById(select.getAttribute('aria-describedby'));
        const icon=select.parentElement.querySelector('svg').getBoundingClientRect();
        return {visible:getComputedStyle(tip).visibility==='visible',text:tip.textContent,
          clearance:select.getBoundingClientRect().left+parseFloat(getComputedStyle(select).paddingLeft)-icon.right};
      })()`),
      ).toEqual({
        visible: true,
        clearance: expect.any(Number),
        text: expect.stringContaining("High effort · More reasoning"),
      });
      expect(
        await tab.evaluate<number>(
          `(()=>{const select=document.querySelector('[aria-label=Effort]');return parseFloat(getComputedStyle(select).paddingLeft)-26})()`,
        ),
      ).toBeGreaterThan(0);
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      expect(
        await tab.evaluate<{ focused: boolean; hidden: boolean }>(
          `(()=>{const select=document.querySelector('[aria-label=Effort]');return {focused:document.activeElement===select,hidden:getComputedStyle(document.getElementById(select.getAttribute('aria-describedby'))).visibility==='hidden'}})()`,
        ),
      ).toEqual({ focused: true, hidden: true });
      const effortBox = await tab.evaluate<{ x: number; y: number }>(
        `(()=>{const select=document.querySelector('[aria-label=Effort]');select.blur();const box=select.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}})()`,
      );
      await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...effortBox });
      const tipBox = await tab.evaluate<{ x: number; y: number; visible: boolean }>(
        `(()=>{const tip=document.querySelector('.glosa-chat-effort-field [role=tooltip]'),box=tip.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2,visible:getComputedStyle(tip).visibility==='visible'}})()`,
      );
      expect(tipBox.visible).toBe(true);
      await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tipBox.x, y: tipBox.y });
      expect(
        await tab.evaluate<string>(
          "getComputedStyle(document.querySelector('.glosa-chat-effort-field [role=tooltip]')).visibility",
        ),
      ).toBe("visible");
      await tab.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      expect(
        await tab.evaluate<string>(
          "getComputedStyle(document.querySelector('.glosa-chat-effort-field [role=tooltip]')).visibility",
        ),
      ).toBe("hidden");
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
      await tab.evaluate(`(async()=>{
        document.querySelector('[aria-label="Chat actions"]').click();
        [...document.querySelectorAll('.glosa-agent-menu button')].find(b=>b.textContent==='Move previous draft here').click();
        const deadline=Date.now()+3000;
        while(document.querySelector('[aria-label="Message"]').value!=='Source draft') {
          if(Date.now()>deadline) throw new Error('Moved draft did not reach composer');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        document.querySelector('[aria-label="Chat actions"]').click();
        [...document.querySelectorAll('.glosa-agent-menu button')].find(b=>b.textContent==='Attach previous conversation').click();
        while(!document.querySelector('dialog[open]')) {
          if(Date.now()>deadline) throw new Error('Transcript preview did not open');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
      })()`);
      const preview = await tab.evaluate<string>("document.querySelector('dialog[open]').textContent");
      expect(preview).toContain("Previous outline");
      expect(preview).toContain("2 turns");
      expect(preview).toContain("bytes");
      expect(preview).toContain("Claude Code · Personal");
      expect(await tab.evaluate<number>("chatFixture.sends.length")).toBe(1);
      await tab.evaluate(`(async()=>{
        [...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Attach transcript').click();
        const deadline=Date.now()+3000;
        while(!document.querySelector('[aria-label="Remove previous-conversation.md"]')) {
          if(Date.now()>deadline) throw new Error('Frozen transcript not attached');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
      })()`);
      expect(await tab.evaluate<string>("chatFixture.uploads[0].text")).toBe("# Previous outline\n\nA public answer.");
      expect(await tab.evaluate<number>("chatFixture.moves[0].sourceRevision")).toBe(3);
      expect(await tab.evaluate<number>("chatFixture.sends.length")).toBe(1);

      // A reply's own Markdown is set on the conversation's scale. The label above each message is
      // 12px sans; a `###` inside the reply sits one level down and must not inherit it.
      const reply = await tab.evaluate<{ heading: number; body: number }>(`(()=>{
        const reply=document.querySelector('.glosa-chat-history .glosa-chat-markdown');
        const size=(node)=>parseFloat(getComputedStyle(node).fontSize);
        return {heading:size(reply.querySelector('h3')),body:size(reply.querySelector('p'))};
      })()`);
      expect(reply.heading, "a heading inside a reply is set no larger than the reply's text").toBeGreaterThan(
        reply.body,
      );
      // Colour is read as what paints, never as a token name: `--primary` is resolved on a probe in
      // the reply's own cascade, and every colour goes through a canvas to sRGB for the WCAG ratio.
      // The danger button is the chat's own Delete chat confirmation, opened through its menu.
      const colours = () =>
        tab.evaluate<{
          theme: string;
          link: string;
          primary: string;
          danger: { text: string; background: string; ratio: number; x: number; y: number };
        }>(`(async()=>{
        const canvas=Object.assign(document.createElement('canvas'),{width:1,height:1});
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        const srgb=(css)=>{ctx.fillStyle='#010203';ctx.fillStyle=css;
          if(ctx.fillStyle==='#010203') throw new Error('the canvas could not parse '+css);
          ctx.clearRect(0,0,1,1);ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
        const lum=(css)=>{const [r,g,b]=srgb(css).map(c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;});
          return 0.2126*r+0.7152*g+0.0722*b;};
        window.contrast=(a,b)=>{const [hi,lo]=[lum(a),lum(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);};
        const reply=document.querySelector('.glosa-chat-history .glosa-chat-markdown');
        const probe=document.createElement('span');probe.style.color='var(--primary)';reply.append(probe);
        const primary=getComputedStyle(probe).color;probe.remove();
        document.querySelector('[aria-label="Chat actions"]').click();
        [...document.querySelectorAll('.glosa-agent-menu button')].find(b=>b.textContent==='Delete chat').click();
        const deadline=Date.now()+3000;
        while(!document.querySelector('dialog[open] .glosa-btn-danger')) {
          if(Date.now()>deadline) throw new Error('Delete chat did not ask first');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        const button=document.querySelector('dialog[open] .glosa-btn-danger'),style=getComputedStyle(button),box=button.getBoundingClientRect();
        return {theme:document.documentElement.dataset.theme,link:getComputedStyle(reply.querySelector('a')).color,primary,
          danger:{text:style.color,background:style.backgroundColor,ratio:contrast(style.color,style.backgroundColor),
            x:box.left+box.width/2,y:box.top+box.height/2}};
      })()`);
      // Hover darkens the fill toward the dark theme's text, so the hovered state is measured too.
      const hoveredDanger = async (at: { x: number; y: number }) => {
        await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
        const hovered = await tab.evaluate<{
          hover: boolean;
          text: string;
          background: string;
          ratio: number;
        }>(`(async()=>{
          const button=document.querySelector('dialog[open] .glosa-btn-danger');
          await Promise.all(button.getAnimations().map(a=>a.finished));
          const style=getComputedStyle(button);
          return {hover:button.matches(':hover'),text:style.color,background:style.backgroundColor,
            ratio:contrast(style.color,style.backgroundColor)};
        })()`);
        await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
        await tab.evaluate(`(async()=>{
          [...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Cancel').click();
          const deadline=Date.now()+3000;
          while(document.querySelector('dialog[open]')) {
            if(Date.now()>deadline) throw new Error('Cancel did not close the Delete chat dialog');
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
        })()`);
        return hovered;
      };
      const setScheme = async (value: "light" | "dark") => {
        // The colours read below depend on contrast too (#409: more contrast paints High contrast),
        // so every media preference is pinned rather than read from the host.
        await tab.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value },
            { name: "prefers-reduced-motion", value: "no-preference" },
            { name: "prefers-contrast", value: "no-preference" },
          ],
        });
        await tab.evaluate(`(async()=>{const deadline=Date.now()+3000;
          while(document.documentElement.dataset.theme!==${JSON.stringify(value)}) {
            if(Date.now()>deadline) throw new Error('the app never resolved the ${value} system appearance');
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }})()`);
      };
      for (const scheme of ["light", "dark"] as const) {
        await setScheme(scheme);
        const seen = await colours();
        expect(seen.theme).toBe(scheme);
        expect(seen.link, `a reply's link is not the page's action ink in ${scheme}`).toBe(seen.primary);
        expect(
          seen.danger.ratio,
          `danger button text ${seen.danger.text} on ${seen.danger.background} in ${scheme}`,
        ).toBeGreaterThanOrEqual(4.5);
        const hovered = await hoveredDanger(seen.danger);
        expect(hovered.hover).toBe(true);
        expect(
          hovered.ratio,
          `hovered danger button text ${hovered.text} on ${hovered.background} in ${scheme}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      await setScheme("light");
      expect(await tab.evaluate<number>("chatFixture.sends.length")).toBe(1);
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
        profiles[0].auth.state='probe_failed';profiles[0].isDefault=false;profiles[1].auth.state='identity_mismatch';
        window.accountFixture={updates:[],probes:[]};
        const capabilities=Object.fromEntries(profiles.map(p=>[p.id,{models:[{id:'model',name:'Model',efforts:['high']}]}]));
        accountFixture.pane=mountAgentSettings(document.querySelector('main'), {dataAccess:{
          getAgentStatus:async()=>structuredClone({available:true,providers:[{id:'claude-code',name:'Claude Code',installed:true,qualified:true},{id:'codex',name:'Codex',installed:true,qualified:true}],profiles,capabilities}),
          updateAgentProfile:async(id,input)=>{accountFixture.updates.push({id,...input});const profile=profiles.find(p=>p.id===id);Object.assign(profile,input,{revision:profile.revision+1});}
          ,probeAgent:async(id)=>{accountFixture.probes.push(id);profiles.find(p=>p.id===id).auth.state='authenticated';}
        }});
        await accountFixture.pane.ready;
        document.querySelector('[data-account-choice="p3"]').click();
        const last=document.querySelector('[data-profile-id="p3"]');
        last.scrollIntoView({block:'end'});
        last.querySelector('.glosa-agent-menu-trigger').click();
        await new Promise(resolve=>requestAnimationFrame(resolve));
      })()`);
      const menuBounds = await tab.evaluate<{ top: number; bottom: number; height: number; menuHeight: number }>(
        `(()=>{const rect=document.querySelector('.glosa-agent-menu:popover-open').getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,height:innerHeight,menuHeight:rect.height}})()`,
      );
      expect(menuBounds.top).toBeGreaterThanOrEqual(0);
      expect(menuBounds.bottom).toBeLessThanOrEqual(menuBounds.height);
      // This short action list must remain compact, not stretch to the 900px fixture viewport.
      expect(menuBounds.menuHeight).toBeLessThan(400);
      expect(
        await tab.evaluate<string>("document.querySelector('[data-profile-id=p0] .glosa-agent-state').textContent"),
      ).toBe("Could not verify");
      expect(
        await tab.evaluate<string>("document.querySelector('[data-profile-id=p1] .glosa-agent-recovery').textContent"),
      ).toContain("different account");
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
        const card=document.querySelector('[data-profile-id="p3"]');
        [...card.querySelectorAll('.glosa-agent-account-actions > button')].find(b=>b.textContent==='Make default').click();
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
      await tab.evaluate(`(async()=>{
        document.querySelector('[data-account-choice=p0]').click();
        [...document.querySelectorAll('[data-profile-id=p0] button')].find(b=>b.textContent==='Retry verification').click();
        const deadline=Date.now()+3000;
        while(document.querySelector('[data-profile-id=p0] .glosa-agent-state').textContent!=='Connected') {
          if(Date.now()>deadline) throw new Error('Account verification did not recover');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
      })()`);
      expect(await tab.evaluate<string[]>("accountFixture.probes")).toEqual(["p0"]);
      await tab.evaluate(
        `{ [...document.querySelectorAll('.glosa-agent-tabs button')].find(b=>b.textContent==='Codex').click(); }`,
      );
      expect(
        await tab.evaluate<string>(
          "document.querySelector('[data-provider-panel]:not([hidden])').dataset.providerPanel",
        ),
      ).toBe("codex");
      await tab.evaluate(`(async()=>{
        accountFixture.pane.destroy();
        const { mountAgentSettings } = await import('/app/agent-settings.js');
        window.installFixture = {installed:false,calls:0};
        installFixture.pane=mountAgentSettings(document.querySelector('main'),{dataAccess:{
          getAgentStatus:async()=>({available:true,providers:[{id:'claude-code',name:'Claude Code',installed:installFixture.installed,qualified:true,
            installation:installFixture.calls&&!installFixture.installed?{phase:'downloading',startedAt:Date.now()-72000,updatedAt:Date.now()-35000,packagesCompleted:2,bytesCompleted:2612000}:undefined
          }],profiles:[]}),
          installAgent:async()=>{installFixture.calls++;await new Promise(resolve=>installFixture.finish=resolve);installFixture.installed=true;}
        }});
        await installFixture.pane.ready;
      })()`);
      expect(
        await tab.evaluate<boolean>("document.querySelector('.glosa-agent-add-account button').matches(':disabled')"),
      ).toBe(true);
      expect(
        await tab.evaluate<boolean>("document.querySelector('.glosa-agent-add-account input').matches(':disabled')"),
      ).toBe(true);
      await tab.evaluate("document.querySelector('.glosa-agent-runtime button').click()");
      await tab.evaluate("document.querySelector('dialog .glosa-save').click()");
      await tab.evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
      const installing = await tab.evaluate<{ disabled: boolean; label: string; busy: string; calls: number }>(
        `(()=>{const b=document.querySelector('.glosa-agent-runtime button');b.click();return {disabled:b.disabled,label:b.textContent,busy:b.getAttribute('aria-busy'),calls:installFixture.calls}})()`,
      );
      expect(installing).toEqual({ disabled: true, label: "Installing runtime…", busy: "true", calls: 1 });
      expect(
        await tab.evaluate<{
          phase: string;
          metrics: string;
          visible: boolean;
          indeterminate: boolean;
          quiet: boolean;
        }>(`(()=>{
        const card=document.querySelector('.glosa-agent-runtime'),bar=card.querySelector('progress'),metrics=card.querySelector('.glosa-runtime-metrics');
        return {phase:card.querySelector('strong').textContent,metrics:metrics.textContent,
          visible:bar.getBoundingClientRect().height>0&&metrics.getBoundingClientRect().height>0,
          indeterminate:!bar.hasAttribute('value'),quiet:card.textContent.includes('No installer update for')};
      })()`),
      ).toEqual({
        phase: "Claude Code runtime · Downloading runtime",
        metrics: expect.stringMatching(/elapsed · 2 packages downloaded · ≈ 2[.,]6 MB received · Last update/),
        visible: true,
        indeterminate: true,
        quiet: true,
      });
      await tab.evaluate(`(async()=>{
        installFixture.finish();
        const deadline=Date.now()+3000;
        while(document.querySelector('.glosa-agent-add-account button').matches(':disabled')) {
          if(Date.now()>deadline) throw new Error('Account setup stayed locked after installation');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        installFixture.pane.destroy();
      })()`);
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "#405: the five raised components paint the same colours from tokens in light and dark, and a light History diff sits on glosa's paper",
    async () => {
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(ALPHA));
      await waitForReady(tab, "before the theme probe");
      const shots = (name: string) =>
        tab.send("Page.captureScreenshot", { format: "png" }).then((shot) => {
          mkdirSync(".context/test-results", { recursive: true });
          writeFileSync(
            `.context/test-results/theme-405-${name}-${Date.now()}.png`,
            Buffer.from(shot.result.data, "base64"),
          );
        });
      // Every media preference this test's paint depends on is pinned, never read from the host:
      // CI's macOS runner reports reduced motion and a local run does not. `motion` is a parameter
      // only so the same assertions can be run under `reduce` to show they do not depend on it.
      const motion = "no-preference";
      const setScheme = async (value: "light" | "dark") => {
        await tab.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value },
            { name: "prefers-reduced-motion", value: motion },
            { name: "prefers-contrast", value: "no-preference" },
          ],
        });
        await tab.evaluate(`(async()=>{const deadline=Date.now()+3000;
          while(document.documentElement.dataset.scheme!==${JSON.stringify(value)}) {
            if(Date.now()>deadline) throw new Error('the app never resolved the ${value} system scheme');
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
          for (let frame=0; frame<2; frame++) await new Promise(resolve=>requestAnimationFrame(resolve));
        })()`);
      };
      await setScheme("light");

      // The composer is the real one: a word selected in Review opens it through the pane's own
      // mouseup handler. A session's question card and three settled entries are the production
      // classes placed in the pane's own layers, since only their CSS is under test here.
      await tab.evaluate(`(async()=>{
        const pane=[...document.querySelectorAll('.glosa-pane')].find(p=>p.getAttribute('aria-label')===${JSON.stringify(ALPHA)});
        const deadline=Date.now()+5000;
        while(!pane.querySelector('.glosa-content p')?.textContent.includes(${JSON.stringify(ALPHA_TEXT)})) {
          if(Date.now()>deadline) throw new Error('alpha.md never rendered');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        const content=pane.querySelector('.glosa-content'), paragraph=content.querySelector('p');
        const range=document.createRange(); range.setStart(paragraph.firstChild,0); range.setEnd(paragraph.firstChild,5);
        const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
        content.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        while(!pane.querySelector('.glosa-composer-layer .glosa-composer')) {
          if(Date.now()>deadline) throw new Error('selecting a word in Review did not open the composer');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
      })()`);

      /** Every component's computed paint beside what the palette tokens compute to in the same
       * cascade, read in one evaluate. The expected side is the palette, which #405 leaves alone:
       * the same values the dark-only selectors painted before they became tokens. */
      const paints = (keep: boolean) =>
        tab.evaluate<Record<string, { actual: string[]; expected: string[] }>>(`(async()=>{
        const keep=${keep};
        const pane=[...document.querySelectorAll('.glosa-pane')].find(p=>p.getAttribute('aria-label')===${JSON.stringify(ALPHA)});
        const token=(property,value)=>{const probe=document.createElement('span');probe.style[property]=value;
          pane.append(probe);const computed=getComputedStyle(probe)[property];probe.remove();return computed;};
        const dark=document.documentElement.dataset.scheme==='dark';
        const bg=token('backgroundColor','var(--bg)'), surface=token('backgroundColor','var(--surface)');
        const strong=token('borderRightColor','var(--border-strong)'), quiet=token('borderRightColor','var(--border)');
        const menuLift=token('boxShadow','var(--shadow-menu)'), dialogFloat=token('boxShadow','var(--shadow-dialog)');
        const paint=(el,edge)=>{const s=getComputedStyle(el);return [s.backgroundColor,s[edge],s.boxShadow,s.opacity];};
        const composer=pane.querySelector('.glosa-composer-layer .glosa-composer');
        if(!composer) throw new Error('the composer closed before it was measured');
        // Placed now, measured at once: the pane redraws its own layers, and these are not its own.
        const card=document.createElement('div'); card.className='glosa-agent-card'; card.textContent='Should this stay?';
        card.style.top='22rem';
        pane.querySelector('.glosa-ask-layer').append(card);
        for (const [index, state] of ['rejected','stale','dismissed'].entries()) {
          const entry=document.createElement('div'); entry.className='glosa-annotation'; entry.dataset.state=state;
          entry.dataset.probe='settled'; entry.textContent='A '+state+' note'; entry.style.top=(index*3)+'rem';
          pane.querySelector('.glosa-margin').append(entry);
        }
        await Promise.all(card.getAnimations().map(a=>a.finished.catch(()=>{})));
        const out={
          composer:{actual:paint(composer,'borderRightColor'),expected:[dark?surface:bg,strong,menuLift,'1']},
          question:{actual:paint(pane.querySelector('.glosa-ask-layer .glosa-agent-card'),'borderRightColor'),
            expected:[dark?surface:bg,strong,menuLift,'1']},
        };
        for (const entry of pane.querySelectorAll('[data-probe=settled]'))
          out['settled '+entry.dataset.state]={actual:paint(entry,'borderTopColor'),
            expected:['rgba(0, 0, 0, 0)',strong,'none',dark?'1':'0.75']};
        // The pane's More menu, opened the way a person opens it.
        pane.querySelector('.glosa-tools-trigger').click();
        const menu=pane.querySelector('.glosa-pane-tools[data-open="true"] .glosa-pane-menu');
        if(!menu) throw new Error('the More menu did not open');
        out.menu={actual:paint(menu,'borderRightColor'),expected:[dark?surface:bg,strong,menuLift,'1']};
        pane.querySelector('.glosa-tools-trigger').click();
        if (!keep) { card.remove(); for (const entry of pane.querySelectorAll('[data-probe=settled]')) entry.remove(); }
        const { noticeDialog } = await import('/app/dialog.js');
        const closed=noticeDialog({title:'A dialog above the work',body:'Its paper and its lift.'});
        const dialog=document.querySelector('dialog.glosa-dialog[open]');
        await Promise.all(dialog.getAnimations().map(a=>a.finished.catch(()=>{})));
        out.dialog={actual:paint(dialog,'borderRightColor'),expected:[dark?surface:bg,quiet,dark?'none':dialogFloat,'1']};
        window.closeProbeDialog=()=>{dialog.close();return closed;};
        return out;
      })()`);

      for (const scheme of ["light", "dark"] as const) {
        await setScheme(scheme);
        // The dark pass leaves its fixtures on the page for the screenshot.
        const seen = await paints(scheme === "dark");
        if (scheme === "dark") {
          await shots("dark-dialog");
          await tab.evaluate("closeProbeDialog()");
          await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
          await shots("dark-components");
          await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
        } else {
          await tab.evaluate("closeProbeDialog()");
        }
        expect(Object.keys(seen).sort()).toEqual([
          "composer",
          "dialog",
          "menu",
          "question",
          "settled dismissed",
          "settled rejected",
          "settled stale",
        ]);
        for (const [component, { actual, expected }] of Object.entries(seen)) {
          expect(actual, `${component} in ${scheme}: background, edge, shadow, opacity`).toEqual(expected);
        }
      }

      // The History diff, through the product: an edit outside glosa, the pane's Version history,
      // the oldest version compared with the current document, in the diff tab that opens.
      await setScheme("light");
      await tab.evaluate(
        "getSelection().removeAllRanges(); document.querySelector('.glosa-composer-cancel, .glosa-composer [data-action=cancel]')?.click()",
      );
      writeFileSync(
        join(workspaceRoot, ALPHA),
        `# Alpha\n\n${ALPHA_TEXT} Revised outside glosa.\n\nA new closing line.\n`,
      );
      await clickInPane(tab, ALPHA, ".glosa-tools-trigger");
      await clickInPane(tab, ALPHA, ".glosa-pane-menu-history");
      const diff = await tab.evaluate<{
        gutter: string;
        paper: string;
        inserted: string;
        insertBed: string;
        bedSeparation: number;
      }>(`(async()=>{
        const deadline=Date.now()+15000;
        let versions=[];
        while((versions=[...document.querySelectorAll('.glosa-history-row input[type=checkbox]')]).length<1) {
          if(Date.now()>deadline) throw new Error('Version history listed no version');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        const oldest=versions.at(-1); oldest.click();
        document.querySelector('.glosa-history-compare-current').click();
        let gutter=null;
        // An unchanged line's number: the hunk header's row is an info row, and changed lines
        // take their insert or delete bed, so only a context line shows the gutter's own ground.
        while(!(gutter=document.querySelector('.glosa-diff-surface .d2h-code-linenumber.d2h-cntx'))) {
          if(Date.now()>deadline) throw new Error('the comparison never rendered a diff');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        const surface=gutter.closest('.glosa-diff-surface');
        const token=(value)=>{const probe=document.createElement('span');probe.style.backgroundColor=value;
          surface.append(probe);const computed=getComputedStyle(probe).backgroundColor;probe.remove();return computed;};
        // A line only added (a replaced line is a "change" with its own, stronger bed).
        const inserted=surface.querySelector('td.d2h-ins:not(.d2h-change)');
        // How far apart an added and a deleted line's beds are, in OKLab. Read through a canvas so
        // the engine's own colour-mix and gamut mapping decide the sRGB the reader sees.
        const oklab=(value)=>{const x=document.createElement('canvas').getContext('2d');x.fillStyle='#000';
          x.fillStyle=token(value);x.fillRect(0,0,1,1);const [r,g,b]=[...x.getImageData(0,0,1,1).data].slice(0,3)
            .map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});
          const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b),m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b),
            s=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
          return [0.2104542553*l+0.793617785*m-0.0040720468*s,1.9779984951*l-2.428592205*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.808675766*s];};
        const ins=oklab('var(--d2h-ins-bg-color)'),del=oklab('var(--d2h-del-bg-color)');
        return {gutter:getComputedStyle(gutter).backgroundColor,paper:token('var(--bg)'),
          inserted:inserted?getComputedStyle(inserted).backgroundColor:'none',
          insertBed:token('color-mix(in oklab, var(--ok) 22%, var(--bg))'),
          bedSeparation:Math.hypot(ins[0]-del[0],ins[1]-del[1],ins[2]-del[2])};
      })()`);
      await shots("light-history-diff");
      expect(diff.gutter, "a light diff's line-number gutter is glosa's paper").toBe(diff.paper);
      expect(diff.gutter).not.toBe("rgb(255, 255, 255)");
      expect(diff.inserted, "an inserted line sits on the sage bed, mixed in OKLab").toBe(diff.insertBed);
      // Mixed in OKLCH over near-neutral paper, both beds drift to the paper's beige and sit 0.012
      // apart: the + and − alone told an added line from a deleted one.
      expect(diff.bedSeparation, "an added and a deleted line's beds are told apart by colour").toBeGreaterThanOrEqual(
        0.04,
      );
    },
    TEST_TIMEOUT_MS,
  );
  // ---------- the reading desk the theme gates paint and photograph (#409, #410) ----------

  /** A document with a saved note and a session's question, through the daemon's own routes; the
   * draft in pencil is opened on the page by `openPencilDraft`, as a person opens it. */
  const READING_DESK = "reading-desk.md";
  async function seedReadingDesk(): Promise<void> {
    writeFileSync(
      join(workspaceRoot, READING_DESK),
      [
        "# Notes on a reading desk",
        "",
        "The desk is one paper. A person marks the words that need work, and the mark keeps its place beside the passage it is about.",
        "",
        "## What a session asks",
        "",
        "A session can ask about a sentence without moving the page. This sentence is the one it asks about, so its words carry the session's wash and a bracket in the gutter.",
        "",
        "## A draft not yet sent",
        "",
        "Select a phrase and the composer opens under it in pencil. Nothing takes the hand until Send, and the draft stays graphite while it waits.",
        "",
        "- The hand is every mark a person makes.",
        "- Pencil is the same mark before it is sent.",
        "- Session ink is a session's mark on the page.",
        "",
      ].join("\n"),
    );
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Origin: origin(),
      "Content-Type": "application/json",
    };
    const noted = await fetch(`${origin()}/w/${slug}/annotations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        artifact_path: READING_DESK,
        body: "Say what the place is before you say why it matters.",
        intent: "content",
        target: {
          quote: { exact: "the mark keeps its place beside the passage it is about", prefix: "", suffix: "" },
        },
      }),
    });
    expect(noted.status, `annotation: ${await noted.clone().text()}`).toBe(201);
    const asked = await fetch(`${origin()}/api/workspaces/attention-request`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: workspaceRoot,
        target_path: READING_DESK,
        action: "ask",
        message: "Is the wash on these words enough, or should the bracket say more?",
        target: { quote: { exact: "This sentence is the one it asks about" } },
      }),
    });
    expect(asked.status, `attention-request: ${await asked.clone().text()}`).toBe(201);
  }

  /** The desk done laying out before anything is read, clicked or photographed: the document is
   * its only pane, in Review, and that pane's width has held for five frames (as the #406
   * reading-scale gate waits). A timeout names each pane's mode and width, the tabs and the window. */
  const settleOnReadingDesk = (tab: CdpClient) =>
    tab.evaluate(`(async()=>{const deadline=Date.now()+10000;let last=-1,still=0;
      const desk=()=>JSON.stringify({panes:[...document.querySelectorAll('.glosa-pane')].map(p=>({label:p.getAttribute('aria-label'),
        mode:p.dataset.mode,width:Math.round(p.getBoundingClientRect().width)})),tabs:document.querySelectorAll('.dv-tab').length,window:innerWidth});
      while(still<5){
        if(Date.now()>deadline) throw new Error('the desk never settled on the document alone: '+desk());
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const panes=document.querySelectorAll('.glosa-pane');
        const width=panes.length===1&&panes[0].getAttribute('aria-label')===${JSON.stringify(READING_DESK)}&&panes[0].dataset.mode==='review'
          ?panes[0].getBoundingClientRect().width:0;
        still=width>0&&width===last?still+1:0;last=width;}})()`);

  /** A screenshot, once the page is still: the pane redraws its margin when its data refreshes,
   * and the composer plays its arrival again when it does. Written to .context/test-results. */
  async function stillShot(tab: CdpClient, name: string): Promise<void> {
    await tab.evaluate(`(async()=>{const deadline=Date.now()+5000;let last=Date.now();
      const observer=new MutationObserver(()=>{last=Date.now();});
      observer.observe(document.body,{subtree:true,childList:true,attributes:true});
      while(Date.now()-last<400||document.getAnimations().some(a=>a.playState==='running')) {
        if(Date.now()>deadline) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      observer.disconnect();})()`);
    const shot = await tab.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(".context/test-results", { recursive: true });
    writeFileSync(`.context/test-results/${name}.png`, Buffer.from(shot.result.data, "base64"));
  }

  /** Every media feature the paint depends on is pinned, never read from the host: CI's macOS
   * runner reports reduced motion, and a Mac with Increase Contrast reports more contrast. Returns
   * once <html> names `theme` and two frames have painted with it. */
  async function emulatePaint(
    tab: CdpClient,
    scheme: "light" | "dark",
    contrast: "more" | "no-preference",
    theme: string,
    media: "screen" | "print" = "screen",
  ): Promise<void> {
    await tab.send("Emulation.setEmulatedMedia", {
      media,
      features: [
        { name: "prefers-color-scheme", value: scheme },
        { name: "prefers-reduced-motion", value: "no-preference" },
        { name: "prefers-contrast", value: contrast },
      ],
    });
    await tab.evaluate(`(async()=>{const deadline=Date.now()+3000;
      while(document.documentElement.dataset.theme!==${JSON.stringify(theme)}) {
        if(Date.now()>deadline) throw new Error('the page never painted ${theme} (${scheme}, contrast ${contrast}); it shows '+document.documentElement.dataset.theme);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      for (let frame=0; frame<2; frame++) await new Promise(resolve=>requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
    })()`);
  }

  type Painted = {
    theme: string;
    scheme: string;
    palette: string;
    paper: string;
    htmlBackground: string;
    bodyBackground: string;
    bodyColor: string;
    tokens: Record<string, { value: string; resolved: string }>;
  };
  /** Each token as <html> computes it, and the colour it resolves to on an element. */
  const paintedTokens = (tab: CdpClient, names: string[]) =>
    tab.evaluate<Painted>(`(()=>{
      const html=document.documentElement, style=getComputedStyle(html), tokens={};
      for (const name of ${JSON.stringify(names)}) {
        const probe=document.createElement('span'); document.body.append(probe);
        const shadow=name.includes('shadow');
        probe.style[shadow?'boxShadow':'color']='var('+name+')';
        tokens[name]={value:style.getPropertyValue(name).trim(),resolved:getComputedStyle(probe)[shadow?'boxShadow':'color']};
        probe.remove();
      }
      // The paper as the desktop shell is told it (appearance.js readPaperColor).
      const context=document.createElement('canvas').getContext('2d');
      context.fillStyle=getComputedStyle(document.body).backgroundColor; context.fillRect(0,0,1,1);
      const paper='#'+[...context.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');
      return {theme:html.dataset.theme,scheme:html.dataset.scheme,palette:html.dataset.palette,paper,
        htmlBackground:style.backgroundColor,bodyBackground:getComputedStyle(document.body).backgroundColor,
        bodyColor:getComputedStyle(document.body).color,tokens};
    })()`);

  /** The draft in pencil: words selected in Review open the real composer at their passage. */
  const openPencilDraft = (tab: CdpClient) =>
    tab.evaluate(`(async()=>{
      const pane=[...document.querySelectorAll('.glosa-pane')].find(p=>p.getAttribute('aria-label')===${JSON.stringify(READING_DESK)});
      const deadline=Date.now()+8000;
      const phrase='Nothing takes the hand until Send';
      let paragraph=null;
      while(!(paragraph=[...pane.querySelectorAll('.glosa-content p')].find(p=>p.textContent.includes(phrase)))
        || !pane.querySelector('.glosa-annotation') || !pane.querySelector('.glosa-agent-card')) {
        if(Date.now()>deadline) throw new Error('the document, its note or the question never painted');
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      const text=paragraph.firstChild, start=text.textContent.indexOf(phrase);
      const range=document.createRange(); range.setStart(text,start); range.setEnd(text,start+phrase.length);
      const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
      pane.querySelector('.glosa-content').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      while(!pane.querySelector('.glosa-composer')) {
        if(Date.now()>deadline) throw new Error('selecting words in Review did not open the composer');
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      // Words in the draft, without focus: a focused draft turns ink, and this one is unsent.
      const field=pane.querySelector('.glosa-composer textarea');
      field.value='Keep the hand out of this until it is sent.';
      field.dispatchEvent(new Event('input',{bubbles:true}));
      field.blur();
      getSelection().removeAllRanges();
      await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
    })()`);

  /** Settings > Appearance, opened as a person opens it: the sidebar's Settings, then Appearance,
   * until its palette rows are laid out. */
  const openAppearanceSettings = (tab: CdpClient) =>
    tab.evaluate(`(async()=>{
      document.querySelector('.glosa-sidebar-settings').click();
      const deadline=Date.now()+8000;
      let item=null;
      while(!(item=[...document.querySelectorAll('.glosa-settings-nav button')].find(b=>b.textContent==='Appearance'))) {
        if(Date.now()>deadline) throw new Error('Settings never opened');
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      item.click();
      while(!document.querySelector('.glosa-settings-palettes:not([hidden]) [data-palette-choice]')?.getBoundingClientRect().height) {
        if(Date.now()>deadline) throw new Error('Settings > Appearance never showed its palettes');
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
    })()`);

  test(
    "#409: the system's request for more contrast paints glosa as High contrast, a chosen High contrast holds without it, and light, dark and print paint exactly what they did before theme files",
    async () => {
      // What "before" means: every colour token on <html> as Chrome computed it from the tree
      // before the palettes moved into theme files (fixtures/theme-colours-before-409.json).
      const before = JSON.parse(
        readFileSync(new URL("fixtures/theme-colours-before-409.json", import.meta.url), "utf8"),
      ) as {
        cases: Record<
          string,
          { tokens: Record<string, { value: string; resolved: string }> } & Record<string, unknown>
        >;
      };
      const slotsOf = (id: string) =>
        (
          JSON.parse(readFileSync(new URL(`../../packages/spa/src/themes/${id}.json`, import.meta.url), "utf8")) as {
            slots: Record<string, string>;
          }
        ).slots;
      const highContrast = { light: slotsOf("high-contrast-light"), dark: slotsOf("high-contrast-dark") };
      // The desktop shell's first frame is glosa's paper (packages/shell/src/policy.ts PAPER); High
      // contrast keeps that paper, so a window opened under Increase Contrast does not flash.
      const PAPER = { light: "#fefbf7", dark: "#1a1614" } as const;

      await seedReadingDesk();
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(READING_DESK));
      await waitForReady(tab, "before the theme files probe");
      await settleOnReadingDesk(tab);
      const shots = (name: string) => stillShot(tab, `theme-409-${name}`);
      const emulate = (
        scheme: "light" | "dark",
        contrast: "more" | "no-preference",
        theme: string,
        media: "screen" | "print" = "screen",
      ) => emulatePaint(tab, scheme, contrast, theme, media);
      const painted = (names: string[]) => paintedTokens(tab, names);
      const goldenNames = Object.keys(before.cases["light/screen"]!.tokens);
      await openPencilDraft(tab);

      for (const scheme of ["light", "dark"] as const) {
        // Without the signal: glosa's own, exactly as before.
        await emulate(scheme, "no-preference", scheme);
        await shots(`glosa-${scheme}-document`);
        const onScreen = await painted(goldenNames);
        const { tokens: screenTokens, ...screenPage } = before.cases[`${scheme}/screen`]!;
        expect(onScreen.tokens, `glosa ${scheme} on screen paints every colour token as before`).toEqual(screenTokens);
        expect({ ...onScreen, tokens: undefined, palette: undefined, paper: undefined }).toMatchObject(screenPage);
        expect(onScreen.paper).toBe(PAPER[scheme]);

        // With the signal: the same page, glosa's own palette painting as High contrast.
        await emulate(scheme, "more", `high-contrast-${scheme}`);
        await shots(`high-contrast-${scheme}-document`);
        const more = await painted(["--ink", "--hand", "--session", "--pencil", "--bg"]);
        expect(more.palette, "the chosen palette is still glosa's own").toBe("glosa");
        for (const slot of ["ink", "hand", "session", "pencil", "bg"])
          expect(more.tokens[`--${slot}`]!.value, `--${slot} under more contrast in ${scheme}`).toBe(
            highContrast[scheme][slot]!,
          );
        expect(more.paper, "High contrast keeps the paper the desktop window opens on").toBe(PAPER[scheme]);
      }
      for (const scheme of ["light", "dark"] as const) {
        await emulate(scheme, "no-preference", scheme, "print");
        const inPrint = await painted(goldenNames);
        const { tokens: printTokens, ...printPage } = before.cases[`${scheme}/print`]!;
        expect(inPrint.tokens, `glosa ${scheme} in print paints every colour token as before`).toEqual(printTokens);
        expect({ ...inPrint, tokens: undefined, palette: undefined, paper: undefined }).toMatchObject(printPage);
        // Print lays its white paper and ink over whichever theme is showing; marks keep theirs.
        await emulate(scheme, "more", `high-contrast-${scheme}`, "print");
        const printedMore = await painted(["--bg", "--ink", "--hand"]);
        expect(
          [printedMore.tokens["--bg"]!.value, printedMore.tokens["--ink"]!.value, printedMore.tokens["--hand"]!.value],
          `High contrast ${scheme} in print`,
        ).toEqual(["#fff", "#202020", highContrast[scheme].hand!]);
      }

      // Chosen in Settings > Appearance, as a person chooses it: High contrast, with or without the
      // signal, in either scheme.
      await emulate("light", "no-preference", "light");
      await openAppearanceSettings(tab);
      await shots("settings-appearance-light");
      await emulate("dark", "no-preference", "dark");
      await shots("settings-appearance-dark");
      // glosa's own chosen while the system asks for more contrast: Settings says what is showing.
      await emulate("light", "more", "high-contrast-light");
      expect(
        await tab.evaluate<string>(
          "document.querySelector('.glosa-settings-palettes + .glosa-settings-hint:not([hidden])')?.textContent ?? ''",
        ),
      ).toBe(
        "Increase contrast is on for this Mac, so glosa shows High contrast. glosa's own palette returns when it is off.",
      );
      await shots("settings-appearance-light-more-contrast");
      await emulate("dark", "no-preference", "dark");
      await tab.evaluate(`document.querySelector('[data-palette-choice="high-contrast"]').click()`);
      await emulate("dark", "no-preference", "high-contrast-dark");
      await shots("settings-appearance-high-contrast-dark");
      for (const [scheme, contrast] of [
        ["dark", "no-preference"],
        ["light", "no-preference"],
        ["light", "more"],
        ["dark", "more"],
      ] as const) {
        await emulate(scheme, contrast, `high-contrast-${scheme}`);
        const chosen = await painted(["--ink", "--hand", "--session"]);
        expect(chosen.palette).toBe("high-contrast");
        for (const slot of ["ink", "hand", "session"])
          expect(chosen.tokens[`--${slot}`]!.value, `chosen High contrast, ${scheme}, contrast ${contrast}`).toBe(
            highContrast[scheme][slot]!,
          );
      }
      await emulate("light", "no-preference", "high-contrast-light");
      await shots("settings-appearance-high-contrast-light");
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "#410: Catppuccin, Gruvbox and Rosé Pine paint their theme files in light and dark, stay as chosen when the system asks for more contrast, leave the document's face alone, and a stored dark palette is dark from the first frame",
    async () => {
      const slotsOf = (id: string) =>
        (
          JSON.parse(readFileSync(new URL(`../../packages/spa/src/themes/${id}.json`, import.meta.url), "utf8")) as {
            slots: Record<string, string>;
          }
        ).slots;
      const PALETTES = [
        { id: "catppuccin", light: "catppuccin-latte", dark: "catppuccin-mocha" },
        { id: "gruvbox", light: "gruvbox-light", dark: "gruvbox-dark" },
        { id: "rose-pine", light: "rose-pine-dawn", dark: "rose-pine" },
      ] as const;
      const PROBED = ["--bg", "--ink", "--hand", "--session"];
      /** What the page paints and whose palette it is, against the theme file's own values. */
      const expectPalette = async (palette: (typeof PALETTES)[number], scheme: "light" | "dark", label: string) => {
        const painted = await paintedTokens(tab, PROBED);
        expect([painted.palette, painted.theme, painted.scheme], label).toEqual([palette.id, palette[scheme], scheme]);
        const file = slotsOf(palette[scheme]);
        for (const token of PROBED)
          expect(painted.tokens[token]!.value, `${label}: ${token}`).toBe(file[token.slice(2)]!);
      };

      /** The two filled actions derive their hovers from the theme (app.css): each label stays at
       * 4.5:1 or more at rest and under the pointer, and the primary visibly changes when hovered.
       * Measured in the page on the colours Chrome resolves, as sRGB bytes. */
      const expectActions = async (label: string) => {
        const actions = await tab.evaluate<Record<string, number>>(`(()=>{
          const bytes=(token)=>{const probe=document.createElement('span'); probe.style.color='var('+token+')';
            document.body.append(probe); const colour=getComputedStyle(probe).color; probe.remove();
            const context=document.createElement('canvas').getContext('2d'); context.fillStyle=colour; context.fillRect(0,0,1,1);
            return [...context.getImageData(0,0,1,1).data].slice(0,3);};
          const luminance=(rgb)=>rgb.map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;})
            .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
          const ratio=(a,b)=>{const [hi,lo]=[luminance(bytes(a)),luminance(bytes(b))].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);};
          return {onPrimary:ratio('--on-primary','--primary'),onPrimaryHovered:ratio('--on-primary','--primary-hover'),
            primaryHoverStep:ratio('--primary','--primary-hover'),onDanger:ratio('--on-danger','--danger'),
            onDangerHovered:ratio('--on-danger','--danger-hover')};})()`);
        for (const pair of ["onPrimary", "onPrimaryHovered", "onDanger", "onDangerHovered"])
          expect(actions[pair]!, `${label}: ${pair}`).toBeGreaterThanOrEqual(4.5);
        expect(
          actions.primaryHoverStep!,
          `${label}: the primary action changes under the pointer`,
        ).toBeGreaterThanOrEqual(1.15);
      };

      await seedReadingDesk();
      const { browser, cdpPort } = await launchBrowser();
      const tab = await openTab(browser, cdpPort, pairedUrl(READING_DESK));
      await waitForReady(tab, "before the palettes probe");
      await emulatePaint(tab, "light", "no-preference", "light");
      await settleOnReadingDesk(tab);
      // The document's face and size under glosa's own palette; a palette sets colours only.
      const face = () =>
        tab.evaluate<{ family: string; size: string; face: string | null }>(`(()=>{
          const pane=document.querySelector('.glosa-pane'), style=getComputedStyle(pane.querySelector('.glosa-content'));
          return {family:style.fontFamily,size:style.fontSize,face:pane.getAttribute('data-face')};})()`);
      const glosaFace = await face();

      // A reload's first frame, watched from before any of the page's own scripts run: every theme
      // <html> is given, in order, and what the page would paint at the first animation frame, which
      // comes before the first paint. The paint timing entry says the theme was set before it.
      await tab.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(()=>{const record={themes:[],themeSetAt:null,atFirstFrame:null};window.__firstFrame=record;
          new MutationObserver(()=>{record.themes.push(document.documentElement.dataset.theme);
            if(record.themeSetAt===null) record.themeSetAt=performance.now();})
            .observe(document,{subtree:true,attributes:true,attributeFilter:['data-theme']});
          requestAnimationFrame(()=>{const html=document.documentElement, style=getComputedStyle(html);
            record.atFirstFrame={theme:html.dataset.theme??null,scheme:html.dataset.scheme??null,
              colorScheme:style.colorScheme,bg:style.getPropertyValue('--bg').trim(),at:performance.now()};});})()`,
      });
      type FirstFrame = {
        themes: string[];
        themeSetAt: number | null;
        atFirstFrame: { theme: string; scheme: string; colorScheme: string; bg: string; at: number } | null;
        firstPaint: number | null;
      };

      for (const palette of PALETTES) {
        // Chosen and stored, then reloaded under a dark system with "Use system setting".
        await tab.evaluate(`localStorage.setItem('glosa_palette', ${JSON.stringify(palette.id)})`);
        await tab.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: "dark" },
            { name: "prefers-reduced-motion", value: "no-preference" },
            { name: "prefers-contrast", value: "no-preference" },
          ],
        });
        await tab.reload();
        await waitForReady(tab, `${palette.id} after a reload`);
        const first = await tab.evaluate<FirstFrame>(`(async()=>{const deadline=Date.now()+5000;
          while(!performance.getEntriesByName('first-paint').length||!window.__firstFrame.atFirstFrame) {
            if(Date.now()>deadline) break;
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          return {...window.__firstFrame, firstPaint:performance.getEntriesByName('first-paint')[0]?.startTime??null};})()`);
        expect(first.atFirstFrame, `${palette.id}: the first frame after a reload`).toEqual({
          theme: palette.dark,
          scheme: "dark",
          colorScheme: "dark",
          bg: slotsOf(palette.dark).bg!,
          at: expect.any(Number),
        });
        expect(new Set(first.themes), `${palette.id}: every theme <html> was given`).toEqual(new Set([palette.dark]));
        expect(first.firstPaint, `${palette.id}: a first paint was recorded`).not.toBeNull();
        expect(first.themeSetAt!, `${palette.id}: the theme was set before the first paint`).toBeLessThan(
          first.firstPaint!,
        );

        await emulatePaint(tab, "dark", "no-preference", palette.dark);
        await settleOnReadingDesk(tab);
        await openPencilDraft(tab);
        for (const scheme of ["dark", "light"] as const) {
          await emulatePaint(tab, scheme, "no-preference", palette[scheme]);
          await expectPalette(palette, scheme, `${palette.id} in ${scheme}`);
          await expectActions(`${palette.id} in ${scheme}`);
          expect(await face(), `${palette.id} in ${scheme} keeps the document's face`).toEqual(glosaFace);
          await stillShot(tab, `theme-410-${palette[scheme]}-document`);
          // The system asks for more contrast: a palette chosen by name stays as chosen.
          await emulatePaint(tab, scheme, "more", palette[scheme]);
          await expectPalette(palette, scheme, `${palette.id} in ${scheme} under more contrast`);
        }
      }

      // Settings > Appearance: every palette row, glosa chosen, in light and dark, then the credits.
      await emulatePaint(tab, "light", "no-preference", "rose-pine-dawn");
      await openAppearanceSettings(tab);
      const choose = async (id: string, theme: string) => {
        await tab.evaluate(`document.querySelector('[data-palette-choice=${JSON.stringify(id)}]').click()`);
        await tab.evaluate(`(async()=>{const deadline=Date.now()+3000;
          while(document.documentElement.dataset.theme!==${JSON.stringify(theme)}) {
            if(Date.now()>deadline) throw new Error('choosing ${id} never painted ${theme}');
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }})()`);
      };
      await choose("catppuccin", "catppuccin-latte");
      await expectPalette(PALETTES[0], "light", "Catppuccin chosen in Settings");
      await choose("glosa", "light");
      expect(
        await tab.evaluate<string[]>(
          "[...document.querySelectorAll('.glosa-settings-palettes:not([hidden]) [data-palette-choice]')].map(r=>r.getAttribute('data-palette-choice')+' '+r.querySelector('.glosa-settings-palette-paper').getAttribute('data-theme-swatch'))",
        ),
      ).toEqual([
        "glosa light",
        "high-contrast high-contrast-light",
        "catppuccin catppuccin-latte",
        "gruvbox gruvbox-light",
        "rose-pine rose-pine-dawn",
      ]);
      await stillShot(tab, "theme-410-settings-appearance-light");
      await emulatePaint(tab, "dark", "no-preference", "dark");
      await stillShot(tab, "theme-410-settings-appearance-dark");
      await choose("gruvbox", "gruvbox-dark");
      await tab.evaluate(`document.querySelector('.glosa-settings-credits').open=true`);
      await stillShot(tab, "theme-410-settings-appearance-gruvbox-dark-credits");
      await emulatePaint(tab, "light", "no-preference", "gruvbox-light");
      await stillShot(tab, "theme-410-settings-appearance-gruvbox-light-credits");
    },
    TEST_TIMEOUT_MS,
  );
});
