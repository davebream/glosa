// SPDX-License-Identifier: Apache-2.0
// #308 — an agent's question, in a real browser engine.
//
// The report: a session asked about a paragraph near the top of a 250-line document while the
// reader was scrolled near the end, and nothing told them where it was. The code it ran already
// had a mark and an automatic scroll; the mark was a 2px grey rule nobody saw, and the scroll did
// not fire. #308 replaces both: a band in session ink around the exact words, a notice with
// "Go to it" whenever a question is not beside its words, and NO movement the reader did not ask
// for.
//
// Every claim below needs a layout engine, which is why it is here and not only in
// `packages/spa/test/review-surface.test.ts`: happy-dom lays nothing out, so there "off screen",
// "the card is beside the passage" and "the page did not move" are all unobservable — every rect
// is zero and `scrollTop` is a plain field.
//
//   * OFF SCREEN + FIRST LOAD — the question exists before the page opens and its passage is
//     2000+px above the reader. This is the reported case, and the case the old arrival logic
//     skipped by design.
//   * NEVER MOVED — a second question arrives while the reader is at the bottom; `scrollTop` and
//     the mode must not change.
//   * ONE ACTION — "Go to it" brings the passage into the pane's viewport.
//   * TOGETHER — below the rail floor, the question, its options and Send are on screen with the
//     passage, with the tray closed.
//   * EXACT WORDS — the band starts mid-line and ends mid-line: a stepped outline, not a block.
//
// Real, not simulated: one real `glosa __daemon` subprocess, one real registered workspace, real
// attention requests through the daemon's own route, one installed Chromium driven over raw CDP.
// The CDP client is file-local on purpose, as in the other real-engine gates: sharing one would
// couple two gates' failure modes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "agent-question-real-engine-token-0123456789ab";
const TEST_TIMEOUT_MS = 60_000;

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

const DOC = "long.md";
// Long enough to cross a line break wherever it starts, behind a lead-in short enough that it
// cannot start at the column's left edge: the band has to step, whatever the face's metrics.
const ASKED =
  "The remedy is fewer tools, held longer, chosen once and then left alone, which the draft asserts flatly and never once stops to earn from the reader it is asking to change.";
const POINTED = "switching costs";

function longDocument(): string {
  const filler = (n: number) =>
    `Paragraph ${n} is ordinary prose that exists to give this document real height, so that a passage near the top is genuinely far from a reader near the end. It says nothing the test reads.`;
  const parts = ["# A long document", ""];
  parts.push(filler(1), "");
  // The asked-about sentence sits in the MIDDLE of a paragraph: it starts mid-line and ends
  // mid-line, which is what makes a block-shaped mark wrong and a stepped band right.
  parts.push(
    `The turn comes early. ${ASKED} Everything after this sentence depends on the reader having accepted it, and nothing before it has prepared them to, which is the whole difficulty with the section as it stands.`,
    "",
  );
  parts.push(`The section on ${POINTED} is the strongest writing in the piece.`, "");
  for (let n = 2; n <= 60; n++) parts.push(filler(n), "");
  return parts.join("\n");
}

interface AskState {
  mode: string | null;
  scrollTop: number;
  scrollMax: number;
  notice: { hidden: boolean; text: string; go: string; count: string; back: boolean } | null;
  bands: Array<{
    entry: string | null;
    kind: string | null;
    d: string;
    top: number;
    bottom: number;
    left: number;
    right: number;
  }>;
  labels: string[];
  tabs: Array<{ kind: string | null; left: number; right: number; label: string | null }>;
  view: { top: number; bottom: number; left: number; right: number };
  column: { left: number; right: number } | null;
  card: { top: number; bottom: number; options: number; hasInput: boolean; send: boolean } | null;
  trayOpen: boolean;
  railCards: number;
}

const askStateExpression = `(() => {
  const pane = document.querySelector('.glosa-pane');
  if (!pane) return null;
  const main = pane.querySelector('.glosa-pane-main');
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const noticeEl = pane.querySelector('.glosa-ask-notice');
  const cardEl = pane.querySelector('.glosa-ask-layer .glosa-agent-card');
  const para = [...pane.querySelectorAll('.glosa-content p')].find((p) => p.textContent.includes('The remedy is fewer tools'));
  return {
    mode: pane.getAttribute('data-mode'),
    scrollTop: Math.round(main.scrollTop),
    scrollMax: Math.round(main.scrollHeight - main.clientHeight),
    notice: noticeEl ? {
      hidden: noticeEl.hidden,
      text: noticeEl.querySelector('.glosa-ask-notice-text')?.textContent ?? '',
      go: noticeEl.querySelector('.glosa-ask-notice-go')?.textContent ?? '',
      count: noticeEl.querySelector('.glosa-ask-notice-count')?.textContent ?? '',
      back: Boolean(noticeEl.querySelector('.glosa-ask-notice-back')),
    } : null,
    bands: [...pane.querySelectorAll('.glosa-band')].map((b) => ({ entry: b.getAttribute('data-entry'), kind: b.getAttribute('data-kind'), d: b.getAttribute('d') ?? '', ...box(b) })),
    labels: [...pane.querySelectorAll('.glosa-band-label')].map((l) => l.textContent),
    tabs: [...pane.querySelectorAll('.glosa-band-tab')].map((t) => ({ kind: t.getAttribute('data-kind'), label: t.getAttribute('aria-label'), left: box(t).left, right: box(t).right })),
    view: box(main),
    column: para ? { left: box(para).left, right: box(para).right } : null,
    card: cardEl ? {
      ...box(cardEl),
      options: cardEl.querySelectorAll('.glosa-agent-option').length,
      hasInput: Boolean(cardEl.querySelector('.glosa-agent-input')),
      send: Boolean(cardEl.querySelector('.glosa-agent-actions .glosa-primary-button')),
    } : null,
    trayOpen: pane.querySelector('.glosa-annotations-tray')?.hasAttribute('data-open') ?? false,
    railCards: pane.querySelectorAll('.glosa-margin .glosa-agent-card').length,
  };
})()`;

describe("#308 — an agent's question in a real engine", () => {
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
    home = mkdtempSync(join(tmpdir(), "glosa-308-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    superviseDaemonHome(home);
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);
    chromiumPath = await installedChromium(childEnv);

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-308-ws-"));
    writeFileSync(join(workspaceRoot, DOC), longDocument());
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-308-chrome-profile-"));

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
      headers: authHeaders(),
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

  /** A session's request, through the daemon's own route — the one `glosa_ask` drives. */
  async function ask(body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/attention-request`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ path: workspaceRoot, target_path: DOC, action: "ask", ...body }),
    });
    expect(res.status, `attention-request: ${await res.clone().text()}`).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function launch(windowSize: string): Promise<CdpClient> {
    const cdpPort = randomPort();
    chrome = Bun.spawn({
      cmd: [
        chromiumPath,
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--window-size=${windowSize}`,
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
        return page;
      }
      await Bun.sleep(100);
    }
    throw new Error("no page target appeared");
  }

  const pairedUrl = (mode: string) =>
    `http://127.0.0.1:${port}/#${new URLSearchParams({ t: TOKEN, w: slug, a: DOC, mode })}`;

  async function waitFor(page: CdpClient, label: string, accept: (s: AskState) => boolean): Promise<AskState> {
    let last: AskState | null = null;
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        last = await page.evaluate<AskState | null>(askStateExpression);
        if (last && accept(last)) return last;
      } catch {
        // execution context torn down mid-navigation
      }
      await Bun.sleep(50);
    }
    throw new Error(`${label}: never reached the expected state; last=${JSON.stringify(last)}`);
  }

  const scrollToEnd = (page: CdpClient) =>
    page.evaluate(
      `(() => { const m = document.querySelector('.glosa-pane-main'); m.scrollTop = m.scrollHeight; return m.scrollTop; })()`,
    );
  const click = (page: CdpClient, selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

  test(
    "below the rail: told where, never moved, there in one action, and answered beside the words",
    async () => {
      // FIRST LOAD: the question exists before the page does.
      const first = await ask({
        message: "This sentence carries the whole second half. Keep it flat, or earn it first?",
        target: { quote: { exact: ASKED } },
        answer_options: ["Keep as is", "Earn it first"],
      });
      const page = await launch("1000,800");
      await page.navigate(pairedUrl("read"));
      // Dockview briefly renders content in a zero-height placeholder before laying out
      // the pane. Its scroll range is not the reader's range yet.
      await waitFor(
        page,
        "the document laid out with its band",
        (s) => s.bands.length === 1 && s.view.bottom > s.view.top && s.scrollMax > 1500,
      );

      await scrollToEnd(page);
      const away = await waitFor(
        page,
        "reader at the end, notice standing",
        (s) => s.scrollTop > 1500 && s.notice?.hidden === false,
      );
      // The reported case, exactly: the passage is far above the visible band…
      expect(away.bands[0]!.bottom).toBeLessThan(away.view.top - 1000);
      // …and this time the reader is told, in words, with one action on offer.
      expect(away.notice!.text).toContain("is asking about a passage");
      expect(away.notice!.go).toBe("Go to it");
      expect(away.mode).toBe("read");

      // NEVER MOVED: a second request arrives while they are reading the end.
      await ask({ message: null, action: "point", target: { quote: { exact: POINTED } } });
      const arrived = await waitFor(page, "the pointer's band appears", (s) => s.bands.length === 2);
      expect(arrived.scrollTop).toBe(away.scrollTop);
      expect(arrived.mode).toBe("read");
      // A pointer earns a band and a tab, never a label and never the notice's count.
      expect(arrived.bands.map((b) => b.kind).sort()).toEqual(["pointer", "question"]);
      expect(arrived.labels).toHaveLength(1);
      expect(arrived.labels[0]).toContain("asks");
      expect(arrived.notice!.count).toBe("");

      // ONE ACTION.
      await click(page, ".glosa-ask-notice-go");
      const there = await waitFor(page, "the passage and its card are on screen", (s) => {
        const band = s.bands.find((b) => b.entry === first);
        return Boolean(band && s.card && band.top > s.view.top && s.card.bottom < s.view.bottom && s.mode === "review");
      });
      const band = there.bands.find((b) => b.entry === first)!;
      // TOGETHER: question, options, free text and Send, directly under the words, tray shut.
      expect(there.card!.options).toBe(2);
      expect(there.card!.hasInput).toBe(true);
      expect(there.card!.send).toBe(true);
      expect(there.card!.top).toBeGreaterThanOrEqual(band.bottom);
      expect(there.card!.top - band.bottom).toBeLessThan(40);
      expect(there.trayOpen).toBe(false);

      // EXACT WORDS: a stepped outline (two vertical runs on each side), starting right of the
      // column's left edge because the sentence starts mid-line. A block-shaped mark fails both.
      expect(
        (band.d.match(/V/g) ?? []).length,
        `band path: ${band.d} column=${JSON.stringify(there.column)} view=${JSON.stringify(there.view)}`,
      ).toBe(3);
      const startX = Number(band.d.match(/^M([\d.]+),/)![1]);
      expect(startX - (there.column!.left - there.view.left)).toBeGreaterThan(40);
      // The tab stands in the gutter, left of the text column, not over the words.
      const tab = there.tabs.find((t) => t.kind === "question")!;
      expect(tab.right).toBeLessThanOrEqual(there.column!.left);
      expect(tab.label).toContain("Question from");

      // ANSWERED: the band goes, and the way back is offered and works.
      await click(page, ".glosa-ask-layer .glosa-agent-option input");
      await click(page, ".glosa-ask-layer .glosa-agent-actions .glosa-primary-button");
      const answered = await waitFor(
        page,
        "the question's band is gone",
        (s) => !s.bands.some((b) => b.entry === first),
      );
      expect(answered.card).toBeNull();
      expect(answered.notice!.back).toBe(true);
      await click(page, ".glosa-ask-notice-back");
      // Review lays the page out a few pixels differently from Read (the notice row comes and goes),
      // so "where they were" is the end of the document again rather than an identical number.
      await waitFor(
        page,
        "back where they were",
        (s) =>
          s.notice?.hidden === true && (Math.abs(s.scrollTop - away.scrollTop) < 80 || s.scrollTop >= s.scrollMax - 8),
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "at rail width the card is already beside the passage, so the notice only speaks when it is off screen",
    async () => {
      const id = await ask({ message: "Is this earned?", target: { quote: { exact: ASKED } } });
      const page = await launch("1700,1000");
      await page.navigate(pairedUrl("review"));
      const top = await waitFor(page, "band and rail card painted", (s) => s.bands.length === 1 && s.railCards === 1);
      // On screen, in Review, with a rail: the question IS beside its words. Saying so again in a
      // notice would be noise.
      expect(top.notice!.hidden).toBe(true);
      expect(top.card).toBeNull();

      await scrollToEnd(page);
      const away = await waitFor(page, "scrolled away", (s) => s.scrollTop > 1000 && s.notice?.hidden === false);
      expect(away.notice!.go).toBe("Go to it");
      await click(page, ".glosa-ask-notice-go");
      await waitFor(page, "back at the passage", (s) => {
        const band = s.bands.find((b) => b.entry === id);
        return Boolean(band && band.top > s.view.top && band.bottom < s.view.bottom);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
