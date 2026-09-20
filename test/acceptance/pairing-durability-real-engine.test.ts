// SPDX-License-Identifier: Apache-2.0
// #229 — the pairing credential outlives the tab, in a real browser engine.
//
// What #229 reported: after `glosa open --url`, the SPA strips `t=` from the fragment and a reload
// shows "This tab isn't paired." The credential WAS being persisted even then — into
// `sessionStorage`, which a host that rebuilds its web view throws away, and which a second tab on
// the same origin never sees at all. The fix moves it to origin-scoped `localStorage`; this file is
// the thing that can tell the two apart.
//
// Why a real engine and not a fake store: `packages/spa/test/bootstrap.test.ts` passes a fake
// `Storage` into `scrubSecrets`, so it is green under EITHER store by construction — it cannot see
// this bug. `test/acceptance/security-attack-matrix.test.ts` pins which global the production
// source wires up, which is a source guard, not a behavioural one: it would stay green if Chromium
// scoped `localStorage` differently than assumed. The discriminating step below is step 3, a SECOND
// TAB on the same origin opened at a token-free URL. Under `sessionStorage` that tab is unpaired no
// matter what the source says; under `localStorage` it renders.
//
// Real, not simulated: one real `glosa __daemon` subprocess, one real registered workspace, one
// installed Chromium engine from the same fixed candidate list
// `test/acceptance/browser-security-real-engine.test.ts` uses, driven over its own raw CDP
// WebSocket. No Playwright, no Puppeteer, no downloaded browser, no user profile. The CDP client
// here is file-local on purpose: importing one out of another acceptance test would couple two
// gates' failure modes together.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeToken, tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "pairing-durability-real-engine-token-0123456789ab";
const TEST_TIMEOUT_MS = 60_000;
const ARTIFACT = "notes.md";
const ARTIFACT_TEXT = "The pairing credential has to outlive this tab.";

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

/** The one child environment every subprocess here gets (AGENTS.md invariant 5: scrub
 * `ANTHROPIC_API_KEY` from EVERY spawned child). `HOME` points at this test's private throwaway
 * home, so nothing spawned can read or write the real user's home even incidentally. */
function buildChildEnv(ambient: Record<string, string | undefined>, home: string): Record<string, string> {
  const env = { ...ambient } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  env.HOME = home;
  return env;
}

/** Kills `proc` if alive and waits for its REAL exit — never fire-and-forget. */
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

/** A tiny raw-CDP client: one WebSocket, one `id -> {resolve,reject}` map. Same wire protocol
 * Chrome's own DevTools speaks, over a socket this process opened to a browser it spawned. Every
 * pending call is bounded and every pending call is rejected the moment the socket closes, so a
 * browser that stays alive without answering fails the waiting call instead of hanging. */
class CdpClient {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void }>();
  #terminated: Error | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data as string);
      const pending = msg.id === undefined ? undefined : this.#pending.get(msg.id);
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

  /** Arms a listener for `method` BEFORE the caller issues the command that produces it — the
   * event can land before a command's own reply does, and arming afterwards loses that race. */
  waitForEvent(method: string, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#ws.removeEventListener("message", handler);
        reject(new Error(`CDP event ${method} did not arrive within ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (ev: MessageEvent) => {
        if (JSON.parse(ev.data as string).method !== method) return;
        clearTimeout(timer);
        this.#ws.removeEventListener("message", handler);
        resolve();
      };
      this.#ws.addEventListener("message", handler);
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

  close(): void {
    this.#ws.close();
  }
}

/** Everything the page can tell us about pairing, read in ONE evaluate so the fields can never
 * disagree about which moment they describe. */
const PAGE_STATE = `(() => {
  const app = document.querySelector('.glosa-app[data-surface]');
  const active = app?.querySelector('.glosa-pane[data-active="true"]');
  const screens = Array.from(document.querySelectorAll('[data-screen]'))
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute('data-screen'));
  return {
    screens,
    surface: app?.getAttribute('data-surface') ?? null,
    text: active?.querySelector('.glosa-content')?.textContent ?? '',
    hash: location.hash,
    token: localStorage.getItem('glosa_token'),
    install: localStorage.getItem('glosa_install'),
    sessionToken: sessionStorage.getItem('glosa_token'),
    cookie: document.cookie,
  };
})()`;

interface PageState {
  screens: string[];
  surface: string | null;
  text: string;
  hash: string;
  token: string | null;
  install: string | null;
  sessionToken: string | null;
  cookie: string;
}

/** Polls `PAGE_STATE` until `accept` holds. Evaluate errors are swallowed while polling: during a
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
      last = await client.evaluate<PageState>(PAGE_STATE);
      if (last && accept(last)) return last;
    } catch {
      // execution context torn down mid-reload
    }
    await Bun.sleep(50);
  }
  throw new Error(`${label}: never reached the expected state; last=${JSON.stringify(last)}`);
}

const waitForDocument = (client: CdpClient, label: string) =>
  waitForState(
    client,
    label,
    (s) => s.screens.includes("ready") && s.surface === "document" && s.text.includes(ARTIFACT_TEXT),
  );

const waitForScreen = (client: CdpClient, label: string, screen: string) =>
  waitForState(client, label, (s) => s.screens.includes(screen));

describe("#229 — a pairing survives reload, a second tab, and a rebuilt web view", () => {
  let home: string;
  let workspaceRoot: string;
  let chromeProfile: string;
  let childEnv: Record<string, string>;
  let chromiumPath: string;
  let port: number;
  let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let chrome: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let clients: CdpClient[] = [];
  let installId: string;
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-229-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    // A test runner killed mid-run reparents its children; this guardian reaps the daemon that
    // owns exactly this throwaway home rather than leaving it on the port.
    superviseDaemonHome(home);
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);
    chromiumPath = await installedChromium(childEnv);

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-229-ws-"));
    writeFileSync(join(workspaceRoot, ARTIFACT), `# Notes\n\n${ARTIFACT_TEXT}\n`);
    // ONE profile directory per test, reused across the relaunch below — that reuse is the whole
    // point of the rebuilt-web-view case, so it cannot be a fresh directory each launch.
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-229-chrome-profile-"));

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
    installId = handshake!.install_id;
    expect(installId).toBeString();

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

  /** `127.0.0.1` and not `glosa.localhost`: the harness's `--host-resolver-rules` refuses every
   * name, and the daemon's Host allowlist accepts the IP. Pairing scope is per ORIGIN, so this
   * test says nothing about the name-based origin — by design, they are separate pairings. */
  const origin = () => `http://127.0.0.1:${port}`;
  const focusHash = () => `#${new URLSearchParams({ w: slug, a: ARTIFACT, surface: "document", mode: "read" })}`;
  const pairedUrl = () =>
    `${origin()}/#${new URLSearchParams({ t: TOKEN, w: slug, a: ARTIFACT, surface: "document", mode: "read" })}`;
  const tokenFreeUrl = () => `${origin()}/${focusHash()}`;

  /** Launches Chromium on THIS test's profile directory with CDP enabled and returns the
   * browser-level client plus the CDP port. Every post-launch step lives in one try/catch that
   * terminates the browser, awaits its real exit and reports argv plus both streams — a launch
   * that never produced a target must not read as a product regression. */
  async function launchBrowser(): Promise<{ browser: CdpClient; cdpPort: number; argv: string[] }> {
    const cdpPort = randomPort();
    const argv = [
      chromiumPath,
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
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
      return { browser, cdpPort, argv };
    } catch (error) {
      browser?.close();
      await killAndAwait(chrome);
      const [out, err] = await Promise.all([drain(chrome?.stdout ?? null), drain(chrome?.stderr ?? null)]);
      throw new Error(
        `${(error as Error).message}\nargv=${JSON.stringify(argv)}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    }
  }

  /** Opens a NEW tab in the running browser at `url` and returns a client attached to its own page
   * target. `Target.createTarget` is what makes step 3 a genuine second tab sharing one origin,
   * rather than the same tab navigated twice. */
  async function openTab(browser: CdpClient, cdpPort: number, url: string): Promise<CdpClient> {
    const created = await browser.send("Target.createTarget", { url });
    const targetId = created.result?.targetId;
    if (!targetId) throw new Error(`Target.createTarget returned no targetId: ${JSON.stringify(created)}`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const list: Array<{ id: string; type: string; webSocketDebuggerUrl?: string }> = await (
        await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2_000) })
      ).json();
      const target = list.find((entry) => entry.id === targetId && entry.webSocketDebuggerUrl);
      if (target) {
        const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
        clients.push(client);
        await client.send("Page.enable");
        await client.send("Runtime.enable");
        return client;
      }
      await Bun.sleep(100);
    }
    throw new Error(`no page target appeared for ${targetId}`);
  }

  test(
    "one `glosa open` pairs the ORIGIN: reload and a second tab both render, and a revoke unpairs both",
    async () => {
      const { browser, cdpPort } = await launchBrowser();

      // 1. Tab A follows the `glosa open --url` link once.
      const tabA = await openTab(browser, cdpPort, pairedUrl());
      const opened = await waitForDocument(tabA, "tab A initial open");
      expect(opened.token).toBe(TOKEN);
      expect(opened.install).toBe(installId);
      // A3 §3/F24 is unchanged by #229: the secret leaves the address bar and never enters a cookie.
      expect(new URLSearchParams(opened.hash.slice(1)).has("t")).toBe(false);
      expect(opened.hash).toBe(focusHash());
      expect(opened.sessionToken).toBeNull();
      expect(opened.cookie).toBe("");

      // 2. The reported scenario: reload the tab whose URL no longer carries the token. (This step
      // alone passes under sessionStorage in Chromium — it is here because it is what #229 says
      // fails, not because it discriminates.)
      await tabA.reload();
      const reloaded = await waitForDocument(tabA, "tab A after reload");
      expect(reloaded.token).toBe(TOKEN);
      expect(reloaded.install).toBe(installId);
      expect(new URLSearchParams(reloaded.hash.slice(1)).has("t")).toBe(false);
      expect(reloaded.sessionToken).toBeNull();
      expect(reloaded.cookie).toBe("");

      // 3. THE DISCRIMINATING STEP. A second tab on the same origin, at a URL that never carried a
      // token. Tab-scoped storage cannot reach this state; origin-scoped storage is exactly this.
      const tabB = await openTab(browser, cdpPort, tokenFreeUrl());
      const second = await waitForDocument(tabB, "tab B (token-free URL, never paired itself)");
      expect(second.token).toBe(TOKEN);
      expect(second.install).toBe(installId);
      expect(second.sessionToken).toBeNull();
      expect(second.cookie).toBe("");

      // 4. Revocation is what bounds the credential's life now that the tab does not. Deleting the
      // token file bumps the daemon's generation, which aborts the open SSE; the reconnect 401s,
      // the SPA attributes it to its OWN daemon (`paired: false` on the tokenless handshake) and
      // drops the credential — from the origin store, so every tab loses it together.
      expect(revokeToken(home)).toBe(true);
      const unpairedA = await waitForScreen(tabA, "tab A after revoke", "unpaired");
      expect(unpairedA.token).toBeNull();

      // Tab B reaches the same verdict without its own 401: the credential is simply gone from the
      // store it shares. No `storage` event, no cross-tab messaging — one store, one removal.
      await tabB.reload();
      const unpairedB = await waitForScreen(tabB, "tab B after revoke", "unpaired");
      expect(unpairedB.token).toBeNull();

      // And the revoked credential really is refused on the wire, not merely forgotten by the SPA.
      const rejected = await fetch(`${origin()}/api/workspaces`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(rejected.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  // Deliberately its own test, on its own daemon and its own profile: it is the only step that
  // depends on Chromium flushing Local Storage to disk on a graceful close. If that ever proves
  // flaky it can be dropped without weakening the three steps above, which need no disk at all.
  test(
    "a rebuilt web view on the same profile is still paired",
    async () => {
      const first = await launchBrowser();
      const tab = await openTab(first.browser, first.cdpPort, pairedUrl());
      const opened = await waitForDocument(tab, "tab before browser close");
      expect(opened.token).toBe(TOKEN);

      // Graceful close, not SIGKILL: this asserts the credential is DURABLE, which is a claim
      // about what a normally-closed browser writes out, not about crash recovery.
      await first.browser.send("Browser.close").catch(() => {});
      for (const client of clients) client.close();
      clients = [];
      await Promise.race([chrome!.exited, Bun.sleep(10_000)]);
      await killAndAwait(chrome);
      chrome = null;

      const second = await launchBrowser();
      const rebuilt = await openTab(second.browser, second.cdpPort, tokenFreeUrl());
      const state = await waitForDocument(rebuilt, "tab after relaunch on the same profile");
      expect(state.token).toBe(TOKEN);
      expect(state.sessionToken).toBeNull();
      expect(state.cookie).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});
