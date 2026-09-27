// SPDX-License-Identifier: Apache-2.0
// #412 — marks on a document's words, in an engine that can paint them and one that cannot.
//
// Every mark glosa draws on the words (a note's underline and wash, a session's question) is a
// `::highlight()` range registered in `CSS.highlights`. Safari gained that API in 17.2; before
// #412 the floor was 16.4, and a reader on 16.4 to 17.1 saw documents with no marks and no word
// about it, because the highlight path returned early without telling anyone.
//
//   * WITHOUT THE API — the page says so once, in words that name what to use instead, where the
//     reader can see it; the saved note still lists in the margin.
//   * WITH THE API — no such notice, and the saved note's words are marked: the pixels under them
//     change when the mark is taken away.
//
// `packages/spa/test/workbench.test.ts` proves the wiring against happy-dom (one notice for two
// panes, outside every pane). It cannot say whether the notice is visible, and happy-dom has no
// highlight registry, so it cannot observe the check itself either. Here the check meets a real
// engine: an installed Chromium with the API present, and the same engine with `CSS.highlights`
// and `Highlight` removed by a script that runs on every new document before any of the page's
// own scripts. That removal is the fixture's one simulation: it stands in for Safari 16.4 to 17.1
// and does not prove anything about Safari's other behaviour.
//
// Real, not simulated: one real `glosa __daemon` subprocess, one real registered workspace, one
// saved note through the daemon's own route, one installed Chromium driven over raw CDP. The CDP
// client is file-local on purpose, as in the other real-engine gates: sharing one would couple two
// gates' failure modes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "marks-real-engine-token-0123456789abcdef0123";
const TEST_TIMEOUT_MS = 60_000;

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

const NOTICE = "This browser can't show marks on the page. Use Safari 17.2 or later, or Chrome.";
const DOC = "chapter.md";
const NOTED = "the reader has to take on trust";
const NOTE_BODY = "Earn this before asking for it.";
const DOCUMENT = [
  "# A chapter",
  "",
  `The argument turns on a premise ${NOTED}, and the rest of the chapter depends on it.`,
  "",
  "A second paragraph gives the page a little more to read.",
  "",
].join("\n");

/** Runs on every new document before any script of the page's own: the engine as Safari 16.4 to
 * 17.1 would present it, with no highlight registry and no `Highlight`. It records whether it
 * really ran first, so the test can refuse a fixture that did not. */
const REMOVE_HIGHLIGHT_API = `(() => {
  const beforeScripts = document.scripts.length === 0;
  delete CSS.highlights;
  delete window.Highlight;
  window.__highlightApiRemoved = { beforeScripts };
})();`;

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

async function waitForHandshake(port: number, deadlineMs: number, proc: Bun.Subprocess): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/handshake`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  return false;
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

  async evaluate<T = unknown>(expression: string, timeoutMs = 20_000): Promise<T> {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.result?.exceptionDetails) {
      throw new Error(`page evaluation threw: ${JSON.stringify(res.result.exceptionDetails)}`);
    }
    return res.result?.result?.value;
  }

  /** The page's pixels inside `clip`, as the PNG the engine encodes them to. */
  async screenshot(clip: { x: number; y: number; width: number; height: number }): Promise<string> {
    const res = await this.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
    return res.result?.data ?? "";
  }

  close(): void {
    this.#ws.close();
  }
}

interface MarksState {
  api: { highlights: boolean; Highlight: boolean; removed: { beforeScripts: boolean } | null };
  mode: string | null;
  /** The noted words are on the page: the document has rendered. */
  rendered: boolean;
  /** The saved note, listed where notes list (the rail or the tray). */
  cards: string[];
  notices: Array<{
    hidden: boolean;
    display: string;
    text: string;
    width: number;
    height: number;
    /** What a pointer at the notice's centre would land on is the notice itself: not covered. */
    onTop: boolean;
    inPane: boolean;
  }>;
  /** What the notes' highlight key holds in this pane, or null where there is no registry. */
  marked: string[] | null;
  /** The noted words' box on the page, for a screenshot of exactly them. */
  words: { x: number; y: number; width: number; height: number } | null;
}

const marksStateExpression = `(() => {
  const pane = document.querySelector('.glosa-pane');
  if (!pane) return null;
  const content = pane.querySelector('.glosa-content');
  const text = content ? content.textContent : '';
  let words = null;
  if (content && text.includes(${JSON.stringify(NOTED)})) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(${JSON.stringify(NOTED)});
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + ${NOTED.length});
      const r = range.getBoundingClientRect();
      words = { x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, width: Math.ceil(r.width) + 4, height: Math.ceil(r.height) + 8 };
      break;
    }
  }
  return {
    api: {
      highlights: typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined',
      Highlight: typeof Highlight !== 'undefined',
      removed: window.__highlightApiRemoved ?? null,
    },
    mode: pane.getAttribute('data-mode'),
    rendered: text.includes(${JSON.stringify(NOTED)}),
    cards: [...pane.querySelectorAll('.glosa-annotation')].map((card) => card.textContent),
    notices: [...document.querySelectorAll('.glosa-marks-notice')].map((notice) => {
      const r = notice.getBoundingClientRect();
      const hit = r.width > 0 && r.height > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        hidden: notice.hidden,
        display: getComputedStyle(notice).display,
        text: notice.textContent,
        width: r.width,
        height: r.height,
        onTop: Boolean(hit && notice.contains(hit)),
        inPane: Boolean(notice.closest('.glosa-pane')),
      };
    }),
    marked: typeof CSS !== 'undefined' && CSS.highlights
      ? [...(CSS.highlights.get('glosa-anchors') ?? [])].filter((range) => pane.contains(range.startContainer)).map((range) => range.toString())
      : null,
    words,
  };
})()`;

describe("#412 — marks on a document's words, in an engine with and without the highlight API", () => {
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

  const authHeaders = () => ({
    Authorization: `Bearer ${TOKEN}`,
    Origin: `http://127.0.0.1:${port}`,
    "Content-Type": "application/json",
  });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-412-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    superviseDaemonHome(home);
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);
    chromiumPath = await installedChromium(childEnv);

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-412-ws-"));
    writeFileSync(join(workspaceRoot, DOC), DOCUMENT);
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-412-chrome-profile-"));

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
    expect(await waitForHandshake(port, 15_000, daemon), `daemon handshake (exitCode=${daemon.exitCode})`).toBe(true);

    const opened = await fetch(`http://127.0.0.1:${port}/api/workspaces/open`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ path: workspaceRoot }),
    });
    expect(opened.ok, "workspace registration").toBe(true);
    slug = (await opened.json()).slug;

    // The saved note, through the route the composer's Send uses.
    const noted = await fetch(`http://127.0.0.1:${port}/w/${slug}/annotations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        artifact_path: DOC,
        body: NOTE_BODY,
        intent: "content",
        target: { quote: { exact: NOTED, prefix: "", suffix: "" } },
      }),
    });
    expect(noted.status, `annotation: ${await noted.clone().text()}`).toBe(201);
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

  /** One headless Chromium and one page target on it, with its domains enabled. `beforeScripts` is
   * registered before the first navigation, so it runs on the document that navigation creates. */
  async function launch(beforeScripts?: string): Promise<CdpClient> {
    const cdpPort = randomPort();
    chrome = Bun.spawn({
      cmd: [
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
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        `--user-data-dir=${chromeProfile}`,
        "about:blank",
      ],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    let endpoint: { webSocketDebuggerUrl?: string } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && chrome.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          endpoint = await res.json();
          break;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    if (!endpoint?.webSocketDebuggerUrl) {
      throw new Error(`Chromium did not open its CDP endpoint: ${await drain(chrome.stderr)}`);
    }
    const browser = await CdpClient.connect(endpoint.webSocketDebuggerUrl);
    clients.push(browser);
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    const targetId = created.result?.targetId;
    const listDeadline = Date.now() + 15_000;
    while (Date.now() < listDeadline) {
      const list: Array<{ id: string; webSocketDebuggerUrl?: string }> = await (
        await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2_000) })
      ).json();
      const target = list.find((entry) => entry.id === targetId && entry.webSocketDebuggerUrl);
      if (target) {
        const page = await CdpClient.connect(target.webSocketDebuggerUrl!);
        clients.push(page);
        await page.send("Page.enable");
        await page.send("Runtime.enable");
        if (beforeScripts) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: beforeScripts });
        return page;
      }
      await Bun.sleep(100);
    }
    throw new Error("no page target appeared");
  }

  /** The document, notes shown: the page a reader opens to see their notes on the words. */
  const reviewUrl = () =>
    `http://127.0.0.1:${port}/#${new URLSearchParams({ t: TOKEN, w: slug, a: DOC, mode: "review" })}`;

  async function waitFor(page: CdpClient, label: string, accept: (s: MarksState) => boolean): Promise<MarksState> {
    let last: MarksState | null = null;
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        last = await page.evaluate<MarksState | null>(marksStateExpression);
        if (last && accept(last)) return last;
      } catch {
        // execution context torn down mid-navigation
      }
      await Bun.sleep(50);
    }
    throw new Error(`${label}: never reached the expected state; last=${JSON.stringify(last)}`);
  }

  test(
    "without the highlight API: one notice the reader can see names Safari 17.2 and Chrome, and the saved note still lists",
    async () => {
      const page = await launch(REMOVE_HIGHLIGHT_API);
      await page.navigate(reviewUrl());
      const state = await waitFor(
        page,
        "the note listed with notes shown",
        (s) => s.rendered && s.mode === "review" && s.cards.some((card) => card.includes(NOTE_BODY)),
      );
      // The fixture really is an engine without the API, from before the page's first script.
      expect(state.api).toEqual({ highlights: false, Highlight: false, removed: { beforeScripts: true } });
      expect(state.marked).toBeNull();

      expect(state.notices).toHaveLength(1);
      const [notice] = state.notices;
      expect(notice).toMatchObject({ hidden: false, text: NOTICE, inPane: false, onTop: true });
      expect(notice?.display).not.toBe("none");
      expect(notice?.height).toBeGreaterThan(0);
      expect(notice?.width).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with the highlight API: the saved note's words are marked, and no notice says otherwise",
    async () => {
      const page = await launch();
      await page.navigate(reviewUrl());
      const state = await waitFor(
        page,
        "the note's words marked with notes shown",
        (s) => s.mode === "review" && (s.marked ?? []).includes(NOTED) && s.words !== null,
      );
      expect(state.api).toEqual({ highlights: true, Highlight: true, removed: null });
      expect(state.cards.some((card) => card.includes(NOTE_BODY))).toBe(true);
      expect(state.notices).toHaveLength(1);
      expect(state.notices[0]).toMatchObject({ hidden: true, display: "none", height: 0 });

      // Registered is not painted. Switch the mark's paint off and on again, and the pixels under the
      // words must change and then come back. The switch is a rule the page does not own: deleting
      // the registry key instead raced the pane, which paints its marks again whenever it lays out
      // (a late font load is enough), and put the mark back between the two screenshots. Measured
      // once the faces have loaded, so a font swap cannot move the words out of the clip either.
      const settle = "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));";
      await page.evaluate(`(async () => { await document.fonts.ready; ${settle} })()`);
      const settled = await page.evaluate<MarksState>(marksStateExpression);
      expect(settled.marked).toContain(NOTED);
      const words = settled.words!;
      const paint = (on: boolean) =>
        page.evaluate(`(async () => {
          document.getElementById('marks-off')?.remove();
          if (!${on}) {
            const off = document.createElement('style');
            off.id = 'marks-off';
            off.textContent = '::highlight(glosa-anchors) { background-color: transparent !important; text-decoration: none !important; }';
            document.head.append(off);
          }
          ${settle}
        })()`);
      const marked = await page.screenshot(words);
      await paint(false);
      const bare = await page.screenshot(words);
      await paint(true);
      const again = await page.screenshot(words);
      expect(marked.length).toBeGreaterThan(0);
      expect(marked === bare, "the noted words look the same with and without their mark").toBe(false);
      expect(again === marked, "the noted words look the same once their mark paints again").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
