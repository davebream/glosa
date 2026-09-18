// SPDX-License-Identifier: Apache-2.0
// #183 — the rich face's `EditorView` DOM round trip, in a real browser.
//
// `packages/spa/test/rich-editor.test.ts` drives `parseMarkdown`/`serializeMarkdown`/`spliceMarkdown`
// directly and is DOM-free by construction (its own header says so). That is precisely why it could
// not see this defect: the loss #183 reports happens inside `EditorView`'s own DOM-change reading,
// between a keypress and the document `getSave()` reads — a seam only a real `EditorView`, mounted
// in a real contenteditable, in a real browser, can exercise. A parser/serializer success cannot
// prove a soft break survives a keypress; this file is the thing that can.
//
// Real, not simulated: one real `glosa __daemon` subprocess (spawned the way
// `packages/daemon/test/concurrency-real-subprocess.test.ts` does), one real registered workspace
// holding hand-written fixture files, one installed Chromium engine from the same fixed candidate
// list `test/acceptance/browser-security-real-engine.test.ts` uses — no Playwright, no Puppeteer, no
// downloaded browser, no external service, no user profile. Chrome is driven over its own raw CDP
// WebSocket (the browser's own protocol, not a third-party driver): `Input.dispatchKeyEvent`
// dispatches a genuine keyDown/char/keyUp sequence through the browser's real input pipeline — not
// `execCommand`, which invokes a scripted editing command rather than emulating a keystroke — and
// `mountRichEditor`'s `getDoc()` reads `view.state.doc` directly, so the newline count asserted below
// is read off the ProseMirror document itself, not off a post-splice save or a DOM textContent proxy.
//
// Both the rich-editor.js module AND the data-access.js module this test imports are fetched from
// the real daemon's own `/app/*` static routes — the exact bytes production serves, not a copy.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "rich-editor-browser-roundtrip-test-token-0123456789abcdef";
const TEST_TIMEOUT_MS = 30_000;

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

/** The ONE child environment every subprocess this file spawns gets — the version probe, the
 * daemon, and Chromium alike (AGENTS.md invariant 5: scrub `ANTHROPIC_API_KEY` from EVERY spawned
 * child, not just the ones that obviously need it). `HOME` is redirected to the private,
 * throwaway home this test creates before spawning anything, so nothing here can read or write
 * the real user's home directory even incidentally (crash reporters, keychain probing, config
 * discovery none of these processes need for this test to work). A pure function of its inputs so
 * the credential boundary is testable on its own, without a browser — see the check below. */
function buildChildEnv(ambient: Record<string, string | undefined>, home: string): Record<string, string> {
  const env = { ...ambient } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  env.HOME = home;
  return env;
}

/** Every child this file spawns, recorded at the spawn boundary.
 *
 *  `buildChildEnv` being correct is not the property that matters — a spawn USING it is. A test of
 *  the pure function stays green if any call site stops passing its result and inherits the real
 *  environment instead, which is precisely the hole this recorder closes: the guard below asserts
 *  both that every recorded env is clean AND that the recorded COUNT matches the children the
 *  scenario actually starts. Without the count a spawn that bypassed this wrapper would pass
 *  vacuously, by contributing nothing to assert over. */
const spawnedChildren: Array<{ label: string; env: Record<string, string> | undefined }> = [];

function spawnChild<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable,
>(
  label: string,
  options: Bun.SpawnOptions.OptionsObject<In, Out, Err> & { cmd: string[]; env?: Record<string, string> },
): Bun.Subprocess<In, Out, Err> {
  spawnedChildren.push({ label, env: options.env });
  return Bun.spawn(options);
}

/** Bounded read of a subprocess's stdout: resolves with whatever text arrived, or `""` if the
 * deadline passes first — never hangs on a child that started but never produces output. */
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

/** Kills `proc` if it is still alive and waits for its REAL exit — never a fire-and-forget
 * `kill()`, which can leave a zombie or, worse, a process that outlives the check that thought it
 * cleaned up. Safe to call on an already-exited process. */
async function killAndAwait(proc: Bun.Subprocess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    // already exited
  }
  await proc.exited;
}

async function installedChromium(
  env: Record<string, string>,
  onSpawn: (proc: Bun.Subprocess<"ignore", "pipe", "ignore">) => void,
  probeTimeoutMs = 5_000,
): Promise<string> {
  for (const executable of CHROMIUM_CANDIDATES) {
    if (!existsSync(executable)) continue;
    const probe = spawnChild("chromium-version-probe", {
      cmd: [executable, "--version"],
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    onSpawn(probe);
    const version = (await readBounded(probe.stdout, probeTimeoutMs)).trim();
    // Bounded lifecycle: whether the read above completed or timed out, the probe is terminated
    // and its real exit awaited before this function ever looks at it again — a hung `--version`
    // must not consume the suite's own timeout budget or outlive this function.
    await killAndAwait(probe);
    const major = Number(version.match(/\b(\d{3})\b/)?.[1]);
    if (probe.exitCode === 0 && Number.isFinite(major) && major >= 111) return executable;
  }
  throw new Error(`this gate requires installed Chromium >=111; checked: ${CHROMIUM_CANDIDATES.join(", ")}`);
}

/** Drains a subprocess's real exit and both real streams — never a fixed-window poll (learning
 * `L-issue-184-learning-4`: an isolated macOS Chromium check can time out before it produces
 * anything while passing when run alone; a check that observes a subprocess must observe its real
 * exit and drain its output rather than guess from a short window). */
async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
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

/** The one CDP key each test needs to press, by character: `code`/`windowsVirtualKeyCode` are what
 * `Input.dispatchKeyEvent` needs to look like a real key, not just carry the resulting text. */
const KEY_SPECS: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  X: { code: "KeyX", windowsVirtualKeyCode: 88 },
  " ": { code: "Space", windowsVirtualKeyCode: 32 },
};

/** A tiny raw-CDP client: one WebSocket, one `id -> {resolve,reject}` map. No Puppeteer/Playwright —
 * this is the same wire protocol Chrome's own DevTools speaks to itself, over a socket this process
 * opened to a browser this process spawned.
 *
 * Every pending call is bounded and every pending call is rejected the moment the socket closes or
 * errors — a browser that stays alive without ever answering (page never loads, evaluation never
 * settles) fails the call that is waiting, rather than hanging until the outer test timeout with no
 * indication of which step never returned. */
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

  async navigate(url: string, timeoutMs = 15_000): Promise<void> {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Page.loadEventFired did not arrive within ${timeoutMs}ms for ${url}`)),
        timeoutMs,
      );
      const handler = (ev: MessageEvent) => {
        if (JSON.parse(ev.data as string).method === "Page.loadEventFired") {
          clearTimeout(timer);
          this.#ws.removeEventListener("message", handler);
          resolve(undefined);
        }
      };
      this.#ws.addEventListener("message", handler);
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Runs `expression` (an async IIFE) in the page and returns its resolved value, by-value. */
  async evaluate<T = unknown>(expression: string, timeoutMs = 20_000): Promise<T> {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.result?.exceptionDetails) {
      throw new Error(`page evaluation threw: ${JSON.stringify(res.result.exceptionDetails)}`);
    }
    return res.result?.result?.value;
  }

  /** A REAL keyboard event for one printable character — `keyDown` (the physical key going down),
   * `char` (the character it produces; Chrome inserts text on THIS event type, not `keyDown`, and
   * putting `text` on both double-inserts — measured), `keyUp`. This drives the browser's actual
   * input pipeline (composition, `beforeinput`, `input`), which is what a real keystroke does and
   * `document.execCommand("insertText")` — a scripted editing command, not an emulated key — does
   * not. */
  async keyPress(char: string): Promise<void> {
    const spec = KEY_SPECS[char];
    if (!spec) throw new Error(`no CDP key mapping for ${JSON.stringify(char)}`);
    const { code, windowsVirtualKeyCode: vk } = spec;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "char",
      key: char,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: char,
      unmodifiedText: char,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    });
  }

  close(): void {
    this.#ws.close();
  }
}

describe("#183 — a soft line break survives EditorView's real DOM round trip", () => {
  let home: string;
  let workspaceRoot: string;
  let childEnv: Record<string, string>;
  let port: number;
  let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let chromiumPath: string;
  let chrome: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let chromeProfile: string | null = null;
  let cdp: CdpClient | null = null;
  // The `--version` probe: tracked here, not only inside `installedChromium`, so `afterEach` can
  // still reap it if a test fails or times out before that function's own bounded cleanup runs.
  let probeProcess: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;
  let slug: string;

  const PARAGRAPH_SOURCE = [
    "A paragraph with a deliberate single newline",
    "in the middle of it, staying wrapped by the writer's own hand.",
    "",
  ].join("\n");
  // #175's own real-browser fixture: a `%%`-fenced comment, so the ONE new rich-face affordance
  // this issue adds (a labeled, editable `glosa_raw[data-glosa-kind="comment"]` region — the
  // metadata header's OWN raw-node editing was never exercised in this file before #175 either,
  // so this is new coverage for the mechanism, not a re-run of an existing one) is driven through
  // a real keypress and a real save, not only through `parseMarkdown`/`spliceMarkdown` directly.
  const COMMENT_SOURCE = ["%%", "A private note about this passage.", "%%", ""].join("\n");
  const BLOCKQUOTE_SOURCE = [
    "> [!info] A callout",
    "> with a second deliberate line, staying wrapped by the writer's own hand.",
    "",
  ].join("\n");

  beforeEach(async () => {
    spawnedChildren.length = 0;
    // The private home exists before ANY subprocess starts — including the version probe, which
    // used to run first and inherit the real environment entirely.
    home = mkdtempSync(join(tmpdir(), "glosa-183-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);

    chromiumPath = await installedChromium(childEnv, (proc) => {
      probeProcess = proc;
    });
    probeProcess = null; // installedChromium already terminated and awaited it before returning

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-183-ws-"));
    writeFileSync(join(workspaceRoot, "paragraph.md"), PARAGRAPH_SOURCE);
    writeFileSync(join(workspaceRoot, "blockquote.md"), BLOCKQUOTE_SOURCE);
    writeFileSync(join(workspaceRoot, "comment.md"), COMMENT_SOURCE);

    port = randomPort();
    // The same scrubbed, HOME-redirected environment every child of this file gets; `GLOSA_HOME`
    // is the daemon-specific addition on top of it.
    const daemonEnv: Record<string, string> = { ...childEnv };
    daemonEnv.GLOSA_HOME = home;
    daemonEnv.GLOSA_PORT = String(port);
    daemonEnv.GLOSA_CLASSF_PORT = String(port + 1);
    daemon = spawnChild("glosa-daemon", {
      cmd: [process.execPath, MAIN_PATH, "__daemon"],
      env: daemonEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const up = await waitForHandshake(port, 15_000, daemon);
    expect(up, `daemon handshake failed (exitCode=${daemon.exitCode})`).toBe(true);

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
    cdp?.close();
    cdp = null;
    await killAndAwait(probeProcess);
    probeProcess = null;
    await killAndAwait(chrome);
    chrome = null;
    if (chromeProfile) {
      rmSync(chromeProfile, { recursive: true, force: true });
      chromeProfile = null;
    }
    await killAndAwait(daemon ?? null);
    if (home) rmSync(home, { recursive: true, force: true });
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  /** Terminates Chromium and waits for its REAL exit before touching its streams — draining first
   * (the prior shape of this helper) waits for EOF, and a browser that is still alive because it
   * never opened CDP, or whose page evaluation never settles, never closes that pipe, so the drain
   * hangs until the outer test timeout instead of reporting anything. Kill, await exit, THEN drain,
   * so a genuine hang reports its argv and whatever streams it did produce instead of silently
   * consuming the whole timeout budget. */
  async function terminateAndDrainChrome(): Promise<{ out: string; err: string }> {
    await killAndAwait(chrome);
    const [out, err] = await Promise.all([drain(chrome?.stdout ?? null), drain(chrome?.stderr ?? null)]);
    return { out, err };
  }

  /** Launches a fresh, throwaway-profile Chromium with CDP enabled and returns a connected client.
   * The launch argv is returned too — the contract's second recorded hazard is a builder assuming
   * a product regression from what was actually a launch that never produced a DOM; the argv is
   * evidence against that reading, retained alongside any failure.
   *
   * EVERY post-launch step — the version-endpoint poll, the target-list fetch, the CDP connect and
   * navigate — lives inside ONE try/catch that terminates Chromium, awaits its real exit, drains
   * both streams and reports argv on ANY of their failures. Two of those used to sit outside it
   * (the version poll had its own copy of the same cleanup; the target-list fetch had none at
   * all), which is exactly the shape that let a stalled `/json/list` consume the outer test
   * timeout while reporting nothing. `deadlineMs`/`targetFetchTimeoutMs`/`executablePath` are
   * override points for the failure-path checks below, which need to fail fast rather than wait
   * out the real defaults. */
  async function launchBrowser(
    opts: { deadlineMs?: number; targetFetchTimeoutMs?: number; executablePath?: string; initialUrl?: string } = {},
  ): Promise<{ client: CdpClient; argv: string[] }> {
    const { deadlineMs = 10_000, targetFetchTimeoutMs = 5_000, executablePath = chromiumPath } = opts;
    const cdpPort = randomPort();
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-183-chrome-profile-"));
    const argv = [
      executablePath,
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      // The same loopback-only constraint `browser-security-real-engine.test.ts` uses: nothing
      // this browser resolves can reach a real host, only 127.0.0.1.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      `--user-data-dir=${chromeProfile}`,
      "about:blank",
    ];
    chrome = spawnChild("chromium", { cmd: argv, env: childEnv, stdout: "pipe", stderr: "pipe" });

    let client: CdpClient | undefined;
    try {
      let versionEndpoint: { webSocketDebuggerUrl?: string } | null = null;
      const deadline = Date.now() + deadlineMs;
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
      if (!versionEndpoint) throw new Error("Chromium did not open its CDP endpoint before the deadline");

      const targets: Array<{ webSocketDebuggerUrl: string }> = await (
        await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(targetFetchTimeoutMs) })
      ).json();
      const target = targets[0];
      if (!target) throw new Error("Chromium opened no CDP target");

      client = await CdpClient.connect(target.webSocketDebuggerUrl);
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      // Module tests need only the origin. Route tests supply a complete deep link so the real
      // shell, bootstrap and viewer are composed instead of mounted independently in the test.
      await client.navigate(opts.initialUrl ?? `http://127.0.0.1:${port}/`);
    } catch (error) {
      client?.close();
      const { out, err } = await terminateAndDrainChrome();
      throw new Error(
        `${(error as Error).message}\nargv=${JSON.stringify(argv)}\n--- chrome stdout ---\n${out}\n--- chrome stderr ---\n${err}`,
      );
    }
    return { client, argv };
  }

  function documentUrl(surface: string, artifact = "paragraph.md", mode = "read") {
    return `http://127.0.0.1:${port}/#${new URLSearchParams({
      t: TOKEN,
      w: slug,
      a: artifact,
      surface,
      mode,
    })}`;
  }

  async function waitForRoute(client: CdpClient, surface: string, text: string) {
    let state: any;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        state = await client.evaluate(`(() => {
          const root = document.querySelector('.glosa-app');
          const active = root?.querySelector('.glosa-pane[data-active="true"]');
          return { surface: root?.getAttribute('data-surface'),
            text: active?.querySelector('.glosa-content')?.textContent ?? '',
            panes: root?.querySelectorAll('.glosa-pane').length,
            navigatorHidden: root?.querySelector('.glosa-nav-toggle')?.hidden,
            sidebarHidden: root?.querySelector('.glosa-sidebar')?.hidden,
            mode: active?.getAttribute('data-mode'),
            readLocked: root?.getAttribute('data-preview-lock') === 'true',
            hash: location.hash, paired: sessionStorage.getItem('glosa_token') !== null };
        })()`);
        if (state.surface === surface && state.text.includes(text)) return state;
      } catch {
        // The previous execution context disappears during the guarded route reload.
      }
      await Bun.sleep(50);
    }
    throw new Error(`route did not render ${surface}: ${JSON.stringify(state)}`);
  }

  // R6's morph invariant, in the engine it is for. An external write reaches the open page over
  // SSE and is morphed into it (vendor/idiomorph.js) rather than replacing it. viewer.test.ts pins
  // node identity under happy-dom, which performs no layout and has no real focus or scroll; this
  // is the check a vendored-idiomorph bump has to pass in a real browser.
  test(
    "R6: an external write morphs the open page in place, keeping what did not change",
    async () => {
      const path = "morph.md";
      const filler = Array.from(
        { length: 40 },
        (_, i) => `Filler paragraph ${i + 1}, long enough to make the page scroll.`,
      );
      const before = [
        "# Morph",
        "",
        "Kept paragraph with [a link](https://example.invalid/) in it.",
        "",
        ...filler.flatMap((line) => [line, ""]),
        "Changed paragraph, before.",
        "",
      ].join("\n");
      writeFileSync(join(workspaceRoot, path), before);

      const { client } = await launchBrowser({ initialUrl: documentUrl("document", path) });
      cdp = client;
      await waitForRoute(client, "document", "Changed paragraph, before.");

      const setup: any = await client.evaluate(`(async () => {
        window.__morphLogs = [];
        for (const level of ["warn", "error"]) {
          const original = console[level];
          console[level] = (...args) => {
            window.__morphLogs.push(level + ": " + args.map(String).join(" "));
            original.apply(console, args);
          };
        }
        const content = document.querySelector('.glosa-pane[data-active="true"] .glosa-content');
        const kept = [...content.querySelectorAll("p")].find((p) => p.textContent.startsWith("Kept paragraph"));
        const link = kept.querySelector("a");
        let scroller = content;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
        if (!scroller) return { ok: false, reason: "nothing on the page scrolls" };
        scroller.scrollTop = 200;
        link.focus();
        window.__morph = { kept, link, scroller, scrollTop: scroller.scrollTop };
        return { ok: true, scrollTop: scroller.scrollTop, focused: document.activeElement === link };
      })()`);
      if (!setup.ok) throw new Error(setup.reason);
      expect(setup.scrollTop).toBeGreaterThan(0);
      expect(setup.focused).toBe(true);

      writeFileSync(
        join(workspaceRoot, path),
        before.replace("Changed paragraph, before.", "Changed paragraph, after."),
      );

      const after: any = await client.evaluate(`(async () => {
        const content = () => document.querySelector('.glosa-pane[data-active="true"] .glosa-content');
        for (let i = 0; i < 200 && !content()?.textContent.includes("Changed paragraph, after."); i++)
          await new Promise((resolve) => setTimeout(resolve, 25));
        const { kept, link, scroller, scrollTop } = window.__morph;
        return {
          updated: content().textContent.includes("Changed paragraph, after."),
          keptIsSameNode: content().contains(kept),
          focusKept: document.activeElement === link,
          scrollKept: scroller.scrollTop === scrollTop,
          logs: window.__morphLogs,
        };
      })()`);
      expect(after.updated).toBe(true);
      expect(after.keptIsSameNode).toBe(true);
      expect(after.focusKept).toBe(true);
      expect(after.scrollKept).toBe(true);
      expect(after.logs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#145: a document fragment reaches one rendered pane without navigator",
    async () => {
      const { client } = await launchBrowser({ initialUrl: documentUrl("document") });
      cdp = client;
      const state = await waitForRoute(client, "document", "A paragraph with a deliberate single newline");
      expect(state.panes).toBe(1);
      expect(state.navigatorHidden).toBe(true);
      expect(state.sidebarHidden).toBe(true);
      expect(state.paired).toBe(true);
      expect(new URLSearchParams(state.hash.slice(1)).has("t")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#145: a reused workspace tab follows a document fragment",
    async () => {
      const { client } = await launchBrowser({ initialUrl: documentUrl("workspace") });
      cdp = client;
      await waitForRoute(client, "workspace", "A paragraph with a deliberate single newline");
      const layoutBefore = await client.evaluate<string>("JSON.stringify(localStorage)");
      const next = new URL(documentUrl("document", "blockquote.md")).hash;
      await client.evaluate(`location.hash = ${JSON.stringify(next)}`);
      const state = await waitForRoute(client, "document", "A callout");
      expect(state.panes).toBe(1);
      expect(state.navigatorHidden).toBe(true);
      expect(state.sidebarHidden).toBe(true);
      expect(state.paired).toBe(true);
      expect(new URLSearchParams(state.hash.slice(1)).has("t")).toBe(false);
      expect(await client.evaluate<string>("JSON.stringify(localStorage)")).toBe(layoutBefore);
      const workspace = new URL(documentUrl("workspace")).hash;
      await client.evaluate(`location.hash = ${JSON.stringify(workspace)}`);
      await waitForRoute(client, "workspace", "A paragraph with a deliberate single newline");
      await client.evaluate("history.back()");
      await waitForRoute(client, "document", "A callout");
      await client.evaluate("history.forward()");
      await waitForRoute(client, "workspace", "A paragraph with a deliberate single newline");
      await client.evaluate(`location.hash = ${JSON.stringify(next)}`);
      await waitForRoute(client, "document", "A callout");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#145: changing a route preserves read-lock semantics",
    async () => {
      const { client } = await launchBrowser({ initialUrl: documentUrl("workspace") });
      cdp = client;
      await waitForRoute(client, "workspace", "A paragraph with a deliberate single newline");
      const next = `${new URL(documentUrl("document", "blockquote.md", "edit")).hash}&lock=read`;
      await client.evaluate(`location.hash = ${JSON.stringify(next)}`);
      const state = await waitForRoute(client, "document", "A callout");
      expect(state.readLocked).toBe(true);
      expect(state.mode).toBe("read");
      expect(state.navigatorHidden).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#145: cancelling a document link preserves the edited source and its current URL",
    async () => {
      const { client } = await launchBrowser({ initialUrl: documentUrl("workspace", "paragraph.md", "edit") });
      cdp = client;
      // Read-mode content is hidden in Edit; wait for the actual editable source face instead.
      await client.evaluate(`(async () => {
      // Edit opens on the manuscript now; the full-page faces are a tool in More, asked for by name.
      for (let i = 0; i < 120 && !document.querySelector('.glosa-tools-edit-source'); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      document.querySelector('.glosa-tools-edit-source').click();
      for (let i = 0; i < 120 && !document.querySelector('.glosa-face-source'); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      document.querySelector('.glosa-face-source').click();
      for (let i = 0; i < 120 && (document.querySelector('.glosa-edit-area').hidden || document.querySelector('.glosa-edit-area').value !== ${JSON.stringify(PARAGRAPH_SOURCE)}); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      const source = document.querySelector('.glosa-edit-area');
      if (source.value !== ${JSON.stringify(PARAGRAPH_SOURCE)}) throw new Error('source did not finish loading');
      source.focus(); source.setSelectionRange(source.value.length, source.value.length);
    })()`);
      await client.send("Input.insertText", { text: "UNSAVED ROUTE DRAFT" });
      const before: any = await client.evaluate(
        `({ hash: location.hash, text: document.querySelector('.glosa-edit-area').value })`,
      );
      expect(before.text).toContain("UNSAVED ROUTE DRAFT");
      const next = new URL(documentUrl("document", "blockquote.md")).hash;
      await client.evaluate(`location.hash = ${JSON.stringify(next)}`);
      const prompt: any = await client.evaluate(`(async () => {
      for (let i = 0; i < 120 && !document.querySelector('dialog[open]'); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      const dialog = document.querySelector('dialog[open]');
      if (!dialog) throw new Error('navigation did not ask before discarding the editor');
      const title = dialog.querySelector('h2').textContent;
      if (new URLSearchParams(location.hash.slice(1)).has('t')) throw new Error('pairing token visible during consent');
      const editor = document.querySelector('.glosa-edit-area');
      [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
      // While consent is pending the address bar holds the requested link; the accepted URL is
      // restored only once the refusal settles. Wait for that outcome, not for a fixed delay.
      const settled = () => !document.querySelector('dialog[open]') && location.hash === ${JSON.stringify(before.hash)};
      for (let i = 0; i < 120 && !settled(); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      if (!settled())
        throw new Error('cancel did not settle: dialog open=' + Boolean(document.querySelector('dialog[open]')) + ', hash=' + location.hash);
      if (document.querySelector('.glosa-edit-area') !== editor || !editor.isConnected)
        throw new Error('cancel replaced the dirty editor instead of keeping it mounted');
      return { title, hash: location.hash, text: document.querySelector('.glosa-edit-area').value,
        surface: document.querySelector('.glosa-app').getAttribute('data-surface') };
    })()`);
      expect(prompt.title).toBe("Discard unsaved edits?");
      expect(prompt.hash).toBe(before.hash);
      expect(prompt.text).toBe(before.text);
      expect(prompt.surface).toBe("workspace");
      expect(readFileSync(join(workspaceRoot, "paragraph.md"), "utf8")).toBe(PARAGRAPH_SOURCE);
      await client.evaluate(`location.hash = ${JSON.stringify(next)}`);
      await client.evaluate(`(async () => {
      for (let i = 0; i < 120 && !document.querySelector('dialog[open]'); i++)
        await new Promise(resolve => setTimeout(resolve, 25));
      document.querySelector('dialog[open] .glosa-btn-danger').click();
    })()`);
      await waitForRoute(client, "document", "A callout");
      expect(readFileSync(join(workspaceRoot, "paragraph.md"), "utf8")).toBe(PARAGRAPH_SOURCE);
    },
    TEST_TIMEOUT_MS,
  );

  /** Mounts the REAL `mountRichEditor` (imported from the daemon's own `/app/` route) over markdown
   * fetched through the REAL `/w/:slug/artifacts/:path` route, and places the caret right after
   * `needle` — the one thing this script does synthetically, because a real keystroke still needs a
   * real caret position to land at, exactly as a user clicking there first would produce. The editor,
   * the data-access client and the artifact are parked on `window` so a SEPARATE `evaluate()` call,
   * made after the real CDP keyboard event below, can reach them. */
  function mountAndPlaceCaretScript(slug: string, path: string, needle: string): string {
    return `
    (async () => {
      const { createDataAccess } = await import("/app/data-access.js");
      const { mountRichEditor } = await import("/app/rich-editor.js");
      sessionStorage.setItem("glosa_token", ${JSON.stringify(TOKEN)});
      const dataAccess = createDataAccess();
      const artifact = await dataAccess.getArtifact(${JSON.stringify(slug)}, ${JSON.stringify(path)});

      const container = document.createElement("div");
      document.body.appendChild(container);
      const editor = mountRichEditor(container, { markdown: artifact.content });
      window.__glosaTest = { editor, dataAccess, artifact, container };

      const host = container.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]");
      if (!host) return { ok: false, reason: "EditorView did not mount a contenteditable" };

      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node, idx = -1;
      while ((node = walker.nextNode())) {
        idx = node.nodeValue.indexOf(${JSON.stringify(needle)});
        if (idx !== -1) break;
      }
      if (idx === -1) return { ok: false, reason: "needle not found in the mounted document" };

      const range = document.createRange();
      range.setStart(node, idx + ${JSON.stringify(needle)}.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      host.focus();
      return { ok: true };
    })()
  `;
  }

  /** Runs after the real CDP keypress. Reads `editor.getDoc()` — `view.state.doc` itself, with no
   * `splice()`/serialization in between — for criterion 1's newline count, then calls `getSave()`
   * and writes it through the REAL `PUT` route for criterion 2, exactly what `artifact-pane.js`'s
   * Save button does. */
  function readDocAndSaveScript(slug: string, path: string): string {
    return `
    (async () => {
      const { editor, dataAccess, artifact, container } = window.__glosaTest;
      // EditorView reads the DOM mutation via its own MutationObserver, which flushes after this
      // task yields — not synchronously inside the keyboard event. Two animation frames is the real
      // browser signal that the observer callback (and PM's dispatchTransaction from it) has run,
      // rather than a guessed fixed sleep.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const doc = editor.getDoc();
      const docText = doc.textContent;
      const save = editor.getSave();
      const putResult = await dataAccess.putArtifact(${JSON.stringify(slug)}, ${JSON.stringify(path)}, save.markdown, {
        ifMatch: artifact.source_sha256,
      });
      editor.destroy();
      container.remove();
      delete window.__glosaTest;
      return {
        ok: true,
        docText,
        docNewlines: (docText.match(/\\n/g) || []).length,
        save,
        putResult,
      };
    })()
  `;
  }

  async function mountOutlinePane(client: CdpClient) {
    writeFileSync(join(workspaceRoot, "outline.md"), "# Old heading\n\nBody.\n\n## Tail heading\n");
    await client.evaluate(`(async () => {
      const { createDataAccess } = await import("/app/data-access.js");
      const { createArtifactPane } = await import("/app/artifact-pane.js");
      sessionStorage.setItem("glosa_token", ${JSON.stringify(TOKEN)});
      const host = document.createElement("div");
      document.body.append(host);
      const pane = createArtifactPane(host, {
        dataAccess: createDataAccess(), slug: ${JSON.stringify(slug)}, path: "outline.md",
        loadRichEditor: async () => (await import("/app/rich-editor.js")).mountRichEditor,
      });
      await pane.ready;
      window.__outlineTest = { pane, host };
    })()`);
  }

  test(
    "#175: returning to Source refreshes carried heading labels and jump offsets",
    async () => {
      const { client } = await launchBrowser();
      cdp = client;
      await mountOutlinePane(client);
      const initial: any = await client.evaluate(`(async () => {
      const { pane, host } = window.__outlineTest;
      pane.setMode("edit");
      // Edit opens on the manuscript now; the full-page faces are a tool in More, asked for by name.
      host.querySelector(".glosa-tools-edit-source").click();
      host.querySelector(".glosa-face-source").click();
      await import("/app/markdown-parser.js");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // The outline the Go to palette lists: the pane's own entries, read as data.
      const labels = pane.getOutline().entries.map(entry => entry.text);
      host.querySelector(".glosa-face-rich").click();
      for (let i = 0; i < 100 && !host.querySelector(".ProseMirror h1"); i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      const heading = host.querySelector(".ProseMirror h1");
      if (!heading) throw new Error("rich heading did not mount");
      const range = document.createRange();
      range.selectNodeContents(heading); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      heading.closest("[contenteditable]").focus();
      return labels;
    })()`);
      expect(initial).toEqual(["Old heading", "Tail heading"]);
      await client.keyPress("X");
      const result: any = await client.evaluate(`(async () => {
      const { pane, host } = window.__outlineTest;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      host.querySelector(".glosa-face-source").click();
      const area = host.querySelector("textarea.glosa-edit-area");
      const entries = pane.getOutline().entries;
      const labels = entries.map(entry => entry.text);
      entries[1].jump();
      const result = { labels, text: area.value, offset: area.selectionStart };
      pane.destroy(); host.remove(); delete window.__outlineTest;
      return result;
    })()`);
      expect(result.text).toContain("# Old headingX");
      expect(result.labels).toEqual(["Old headingX", "Tail heading"]);
      expect(result.offset).toBe(result.text.indexOf("## Tail heading"));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#175: pending source parser uses the current face after switching to Read",
    async () => {
      const { client } = await launchBrowser();
      cdp = client;
      await mountOutlinePane(client);
      const result: any = await client.evaluate(`(async () => {
      const { pane, host } = window.__outlineTest;
      pane.setMode("edit");
      // Edit opens on the manuscript now; the full-page faces are a tool in More, asked for by name.
      host.querySelector(".glosa-tools-edit-source").click();
      host.querySelector(".glosa-face-source").click();
      const area = host.querySelector("textarea.glosa-edit-area");
      area.value = "# Unsaved source heading\\n\\n## Another source heading";
      area.dispatchEvent(new Event("input", { bubbles: true }));
      pane.setMode("read");
      await import("/app/markdown-parser.js");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Entry text is the bare heading; a rendered heading's § address travels separately.
      const result = { mode: pane.getMode(), labels: pane.getOutline().entries.map(entry => entry.text) };
      pane.destroy(); host.remove(); delete window.__outlineTest;
      return result;
    })()`);
      expect(result).toEqual({ mode: "read", labels: ["Old heading", "Tail heading"] });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a pane opened directly in Edit fills the rich face with the file even when the editor module loads before the annotations do",
    async () => {
      // The race CI hit under load: the editor module resolved after the artifact arrived but while
      // `hydrateAnnotations` was still waiting, and the face mounted over the empty string a mount
      // started during the load had captured — an empty editor over a file that has content, which
      // a save would then write back. Here the annotations are held until the module has resolved
      // (or 1.5 s pass, for a pane that correctly does not load the module until the file is in), so
      // the ordering is forced rather than left to the machine's speed.
      const path = "opened-in-edit.md";
      writeFileSync(join(workspaceRoot, path), "# Opened in Edit\n\nThe body the face must show.\n");

      const { client } = await launchBrowser();
      cdp = client;

      const mounted: any = await client.evaluate(`(async () => {
        const { createDataAccess } = await import("/app/data-access.js");
        const { createArtifactPane } = await import("/app/artifact-pane.js");
        sessionStorage.setItem("glosa_token", ${JSON.stringify(TOKEN)});
        const host = document.createElement("div");
        document.body.append(host);
        const dataAccess = createDataAccess();
        let moduleLoaded = false;
        const realGetAnnotations = dataAccess.getAnnotations.bind(dataAccess);
        dataAccess.getAnnotations = async (...args) => {
          for (let i = 0; i < 60 && !moduleLoaded; i++) await new Promise(resolve => setTimeout(resolve, 25));
          return realGetAnnotations(...args);
        };
        const pane = createArtifactPane(host, {
          dataAccess,
          slug: ${JSON.stringify(slug)},
          path: ${JSON.stringify(path)},
          initialMode: "edit",
          loadRichEditor: async () => {
            const { mountRichEditor } = await import("/app/rich-editor.js");
            moduleLoaded = true;
            return mountRichEditor;
          },
        });
        await pane.ready;
        // Edit opens on the manuscript; the full-page rich face is a tool, asked for by name.
        host.querySelector(".glosa-tools-edit-source")?.click();
        let editable = null;
        for (let i = 0; i < 200; i++) {
          editable = host.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]");
          if (editable) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = { mounted: Boolean(editable), text: editable?.textContent ?? null };
        pane.destroy(); host.remove();
        return result;
      })()`);
      expect(mounted).toEqual({ mounted: true, text: "Opened in EditThe body the face must show." });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#182: Keep mine merges a real keypress in the rich editor with a real disk-only change, byte-exact on disk",
    async () => {
      const path = "keepmine.md";
      const base = [
        "# Title",
        "",
        "Paragraph A holds the writer's own words.",
        "",
        "Paragraph B holds a different sentence entirely.",
        "",
      ].join("\n");
      writeFileSync(join(workspaceRoot, path), base);

      const { client } = await launchBrowser();
      cdp = client;

      await client.evaluate(`(async () => {
        const { createDataAccess } = await import("/app/data-access.js");
        const { createArtifactPane } = await import("/app/artifact-pane.js");
        sessionStorage.setItem("glosa_token", ${JSON.stringify(TOKEN)});
        const host = document.createElement("div");
        document.body.append(host);
        const dataAccess = createDataAccess();
        // Records every PUT this scenario issues — the assertion below pins there are exactly
        // two: the writer's own stale attempt (refused), then Keep mine's real merge (the
        // property this whole test exists to prove, criterion 4).
        window.__putCalls = [];
        const realPut = dataAccess.putArtifact.bind(dataAccess);
        dataAccess.putArtifact = async (...args) => {
          window.__putCalls.push({ path: args[1], content: args[2], ifMatch: args[3]?.ifMatch });
          return realPut(...args);
        };
        const pane = createArtifactPane(host, {
          dataAccess,
          slug: ${JSON.stringify(slug)},
          path: ${JSON.stringify(path)},
          initialMode: "edit",
          loadRichEditor: async () => (await import("/app/rich-editor.js")).mountRichEditor,
        });
        await pane.ready;
        window.__keepMineTest = { pane, host };
      })()`);

      const placed: any = await client.evaluate(`(async () => {
        const { host } = window.__keepMineTest;
        host.querySelector(".glosa-tools-edit-source")?.click();
        for (let i = 0; i < 200 && !host.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]"); i++)
          await new Promise(resolve => setTimeout(resolve, 25));
        const editable = host.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]");
        if (!editable) return { ok: false, reason: "rich face did not mount" };
        const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
        let node, idx = -1;
        const needle = ${JSON.stringify("own words.")};
        while ((node = walker.nextNode())) {
          idx = node.nodeValue.indexOf(needle);
          if (idx !== -1) break;
        }
        if (idx === -1) return { ok: false, reason: "needle not found in the mounted document" };
        const range = document.createRange();
        range.setStart(node, idx + needle.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        editable.focus();
        return { ok: true };
      })()`);
      if (!placed.ok) throw new Error(`caret placement failed: ${placed.reason}`);

      // A genuine keypress, through the browser's own input pipeline, into paragraph A —
      // `Input.dispatchKeyEvent` (via `keyPress`), never `Input.insertText`/`execCommand`, which
      // do not exercise the same DOM-mutation path a real keystroke does (see this file's header).
      await client.keyPress("X");
      const afterKeypress: any = await client.evaluate(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const { host } = window.__keepMineTest;
        const editable = host.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]");
        return { text: editable?.textContent ?? null };
      })()`);
      // Criterion 1's "read `getDoc()`, not a screenshot" applies equally to the pane-level flow:
      // the keypress actually landed in the live ProseMirror document before Save is ever clicked.
      expect(afterKeypress.text).toContain("own words.XParagraph B");

      // Someone else writes paragraph B directly to disk WHILE the pane still holds its original
      // baseline sha — the exact race #182 exists for. Not through glosa at all: a plain fs write,
      // standing in for a second writer (another glosa instance, or a hand edit).
      const onDisk = base.replace(
        "Paragraph B holds a different sentence entirely.",
        "Paragraph B holds a different sentence entirely, replaced on disk.",
      );
      writeFileSync(join(workspaceRoot, path), onDisk);

      const staleDialog: any = await client.evaluate(`(async () => {
        const { host } = window.__keepMineTest;
        host.querySelector(".glosa-save").click();
        for (let i = 0; i < 200 && !document.querySelector("dialog[open] h2"); i++)
          await new Promise(resolve => setTimeout(resolve, 25));
        const dialog = document.querySelector("dialog[open]");
        if (!dialog) return { ok: false, reason: "the stale-save dialog never opened" };
        return {
          ok: true,
          title: dialog.querySelector("h2")?.textContent,
          detail: dialog.querySelector(".glosa-dialog-detail")?.textContent ?? null,
        };
      })()`);
      if (!staleDialog.ok) throw new Error(staleDialog.reason);
      expect(staleDialog.title).toBe("This file changed while you were editing");
      // The preview names disk's kept change WITHOUT a checkpoint pin (D9) — computed from the
      // merge itself.
      expect(staleDialog.detail).toContain("1 change from disk will be kept.");

      const settled: any = await client.evaluate(`(async () => {
        const { host } = window.__keepMineTest;
        const dialog = document.querySelector("dialog[open]");
        const buttons = [...dialog.querySelectorAll("button")];
        const button = buttons.find((b) => b.textContent === "Keep mine");
        if (!button) return { ok: false, reason: "no Keep mine button", buttonTexts: buttons.map((b) => b.textContent) };
        button.click();
        let remaining = null;
        for (let i = 0; i < 200; i++) {
          remaining = document.querySelector("dialog[open]");
          const status = host.querySelector(".glosa-edit-status")?.textContent ?? "";
          // Not just "the dialog closed" — the pane's own settle sequence (writeAndSettle's
          // re-GET/remount tail) must have finished too, or the disk read below could win a race
          // against the write it is trying to observe.
          if (!remaining && status === "Saved.") return { ok: true };
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return {
          ok: false,
          reason: "Keep mine did not settle (dialog closed + status Saved.) before the deadline",
          status: host.querySelector(".glosa-edit-status")?.textContent ?? null,
          title: remaining?.querySelector("h2")?.textContent ?? null,
          buttons: [...(remaining?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
        };
      })()`);
      if (!settled.ok) throw new Error(JSON.stringify(settled));

      const putCalls: any = await client.evaluate(`window.__putCalls`);
      // Exactly two writes: the writer's own stale attempt (refused, disk untouched by it), then
      // Keep mine's real three-way merge — both survive, at once, in ONE further write (#182).
      expect(putCalls).toHaveLength(2);
      expect(putCalls[0].content).not.toContain("replaced on disk");
      expect(putCalls[1].content).toContain("replaced on disk");
      expect(putCalls[1].content).toContain("own words.X");

      // Byte-exact on disk: both survive. Not the DOM, not a screenshot — the saved source file.
      const finalDiskContent = readFileSync(join(workspaceRoot, path), "utf8");
      expect(finalDiskContent).toBe(
        [
          "# Title",
          "",
          "Paragraph A holds the writer's own words.X",
          "",
          "Paragraph B holds a different sentence entirely, replaced on disk.",
          "",
        ].join("\n"),
      );

      await client.evaluate(`(() => {
        const { pane, host } = window.__keepMineTest;
        pane.destroy();
        host.remove();
        delete window.__keepMineTest;
      })()`);
    },
    TEST_TIMEOUT_MS,
  );

  async function runScenario(path: string, source: string, needle: string, insertChar: string) {
    const { client, argv } = await launchBrowser();
    cdp = client;
    let mounted: any;
    try {
      mounted = await client.evaluate(mountAndPlaceCaretScript(slug, path, needle));
      if (!mounted.ok) throw new Error(mounted.reason ?? "mount failed");
      await client.keyPress(insertChar);
    } catch (error) {
      const { out, err } = await terminateAndDrainChrome();
      throw new Error(
        `${path}: in-browser edit failed: ${error}\nargv=${JSON.stringify(argv)}\n` +
          `--- chrome stdout ---\n${out}\n--- chrome stderr ---\n${err}`,
      );
    }
    let result: any;
    try {
      result = await client.evaluate(readDocAndSaveScript(slug, path));
    } catch (error) {
      const { out, err } = await terminateAndDrainChrome();
      throw new Error(
        `${path}: reading back the document failed: ${error}\nargv=${JSON.stringify(argv)}\n` +
          `--- chrome stdout ---\n${out}\n--- chrome stderr ---\n${err}`,
      );
    }
    const edited = source.replace(needle, needle + insertChar);
    return { result, edited, diskContent: readFileSync(join(workspaceRoot, path), "utf8") };
  }

  test(
    "a hand-wrapped paragraph keeps its newline count after one keypress, and the save is byte-exact",
    async () => {
      const { result, edited, diskContent } = await runScenario("paragraph.md", PARAGRAPH_SOURCE, "deliberate", "X");
      // Criterion 1: the newline count read directly off the document `EditorView` holds
      // (`getDoc().textContent`, not a screenshot and not the post-`splice()` save markdown).
      // The document's own text excludes the file's trailing newline (that's outside every block's
      // span, not an embedded break), so the source is trimmed the same way before counting.
      const sourceBreaks = (PARAGRAPH_SOURCE.replace(/\n$/, "").match(/\n/g) ?? []).length;
      expect(result.docNewlines, "the break the writer already had must still be there after one keypress").toBe(
        sourceBreaks,
      );
      // Criterion 2: the write is exactly the writer's edit, nothing degraded, nothing to consent to.
      expect(result.save.markdown).toBe(edited);
      expect(result.save.degraded).toBe(false);
      expect(result.save.collateral).toEqual([]);
      expect(diskContent, "the saved bytes on disk are what the writer typed, byte for byte").toBe(edited);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a hand-wrapped block inside a blockquote keeps its newline count after one keypress, and the save is byte-exact",
    async () => {
      const { result, edited, diskContent } = await runScenario("blockquote.md", BLOCKQUOTE_SOURCE, "deliberate", "X");
      // Same trim as the paragraph case: the blockquote's own paragraph text excludes the file's
      // trailing newline, and the "> " prefixes are parse-time markup, not embedded breaks.
      const sourceBreaks = (BLOCKQUOTE_SOURCE.replace(/\n$/, "").match(/\n/g) ?? []).length;
      expect(result.docNewlines, "the break inside the blockquote must still be there after one keypress").toBe(
        sourceBreaks,
      );
      expect(result.save.markdown).toBe(edited);
      expect(result.save.degraded).toBe(false);
      expect(result.save.collateral).toEqual([]);
      expect(diskContent, "the saved bytes on disk are what the writer typed, byte for byte").toBe(edited);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "#175: a `%%` comment mounts as a labeled, editable glosa_raw region, and a real keypress saves byte-exact",
    async () => {
      const { client, argv } = await launchBrowser();
      cdp = client;
      let mounted: any;
      try {
        mounted = await client.evaluate(mountAndPlaceCaretScript(slug, "comment.md", "private note"));
        if (!mounted.ok) throw new Error(mounted.reason ?? "mount failed");
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(`comment.md: mount failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`);
      }
      // The label, read the way a real reader would see it: a real `<pre class="glosa-raw">`
      // element in the mounted DOM, carrying `data-glosa-kind="comment"` (rich-editor.js's
      // `toDOM`), and the computed `::before` content app.css attaches to it — not a copy of
      // either string re-typed into this test, so a future rename of either has to change BOTH
      // the product code and this assertion or this goes red.
      const label: any = await client.evaluate(`
        (async () => {
          const { container } = window.__glosaTest;
          const raw = container.querySelector(".glosa-raw");
          if (!raw) return { ok: false, reason: "no .glosa-raw element mounted" };
          return {
            ok: true,
            kind: raw.getAttribute("data-glosa-kind"),
            beforeContent: getComputedStyle(raw, "::before").content,
          };
        })()
      `);
      expect(label.ok, String(label.reason ?? "")).toBe(true);
      expect(label.kind).toBe("comment");
      // `content` computes to a CSS-quoted string ("\"Private note …\""); a substring match through
      // the quoting is what proves the LABEL TEXT itself, not merely that some `content` exists.
      expect(label.beforeContent).toContain("Private note");
      expect(label.beforeContent).toContain("hidden from Read/Review");

      try {
        await client.keyPress("X");
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(`comment.md: in-browser edit failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`);
      }
      let result: any;
      try {
        result = await client.evaluate(readDocAndSaveScript(slug, "comment.md"));
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(
          `comment.md: reading back the document failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`,
        );
      }
      const edited = COMMENT_SOURCE.replace("private note", "private noteX");
      const diskContent = readFileSync(join(workspaceRoot, "comment.md"), "utf8");
      expect(result.save.markdown).toBe(edited);
      expect(result.save.degraded).toBe(false);
      expect(result.save.collateral).toEqual([]);
      expect(diskContent, "the saved bytes on disk are what the writer typed, byte for byte").toBe(edited);
    },
    TEST_TIMEOUT_MS,
  );

  const NOTE_EDIT_CASES = [
    { name: "inline interior", source: "Before %% private note %% after.\n", needle: "private note" },
    { name: "inline neighbor", source: "Before %% private note %% after.\n", needle: "after" },
    { name: "inline original spelling", source: "Before _em_ &amp; %%private note%% after.\n", needle: "private note" },
    {
      name: "inline original spelling neighbor",
      source: "Before _em_ &amp; %%private note%% after.\n",
      needle: "after",
    },
    { name: "asterisk list note", source: "* %%\n  private note\n  %%\n* After.\n", needle: "private note" },
    { name: "plus list note", source: "+ %%\n  private note\n  %%\n+ After.\n", needle: "private note" },
    { name: "parenthesized list note", source: "1) %%\n   private note\n   %%\n2) After.\n", needle: "private note" },
    { name: "extra-spaced quote note", source: ">  %%\n>  private note\n>  %%\n\nAfter.\n", needle: "private note" },
    { name: "mixed line ending note", source: "%%\r\nprivate note\n%%\r\n\r\nAfter.\n", needle: "private note" },
    { name: "empty inline neighbor", source: "Before %%%% after.\n", needle: "after" },
    { name: "heading inline", source: "# Public %% private note %% title\n", needle: "private note" },
    { name: "CRLF comment", source: "%%\r\nprivate note\r\n%%\r\n\r\nAfter.\r\n", needle: "private note" },
    { name: "list comment", source: "- %%\n  private note\n  %%\n- After.\n", needle: "private note" },
    { name: "blockquote comment", source: "> %%\n> private note\n> %%\n\nAfter.\n", needle: "private note" },
    {
      name: "nested list comment",
      source: "- Outer\n  - %%\n    private note\n    %%\n  - After.\n",
      needle: "private note",
    },
  ];
  for (const { name, source, needle } of NOTE_EDIT_CASES) {
    test(
      `#175: real input and disk save preserve ${name}`,
      async () => {
        const path = "note-edit.md";
        writeFileSync(join(workspaceRoot, path), source);
        const { client } = await launchBrowser();
        cdp = client;
        const mounted: any = await client.evaluate(mountAndPlaceCaretScript(slug, path, needle));
        expect(mounted.ok, String(mounted.reason ?? "")).toBe(true);
        const inline: any = await client.evaluate(`(async () => {
        const {container} = window.__glosaTest;
        const note = container.querySelector(".glosa-comment-inline");
        const {collectRenderedHeadings} = await import("/app/outline.js");
        return {raw:container.querySelector(".glosa-raw code")?.textContent ?? null,
          label:note ? getComputedStyle(note,"::before").content : null,
          title:note?.title,headings:collectRenderedHeadings(container).map(row=>row.text)};
      })()`);
        if (name.includes("inline")) {
          expect(inline.label).toContain("Private note");
          expect(inline.title).toContain("hidden from Read/Review");
        }
        if (inline.raw !== null) expect(inline.raw).toBe("%%\nprivate note\n%%");
        if (name === "heading inline") expect(inline.headings).toEqual(["Public title"]);
        await client.keyPress("X");
        const result: any = await client.evaluate(readDocAndSaveScript(slug, path));
        const expected = source.replace(needle, `${needle}X`);
        expect(result.save).toEqual({ markdown: expected, collateral: [], degraded: false });
        expect(readFileSync(join(workspaceRoot, path), "utf8")).toBe(expected);
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "criterion 3: typing several spaces in a row invents no bytes beyond what was typed",
    async () => {
      const source = "A paragraph where the writer types words apart.\n";
      writeFileSync(join(workspaceRoot, "spaces.md"), source);
      const { client, argv } = await launchBrowser();
      cdp = client;
      let mounted: any;
      try {
        mounted = await client.evaluate(mountAndPlaceCaretScript(slug, "spaces.md", "apart"));
        if (!mounted.ok) throw new Error(mounted.reason ?? "mount failed");
        // Four separate real keyboard events — exactly what four real spacebar presses do to a
        // live contenteditable, not a single string handed to one editing command.
        for (let i = 0; i < 4; i += 1) await client.keyPress(" ");
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(`spaces.md: in-browser edit failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`);
      }
      let result: any;
      try {
        result = await client.evaluate(readDocAndSaveScript(slug, "spaces.md"));
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(
          `spaces.md: reading back the document failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`,
        );
      }
      // Four real keypresses must produce exactly four bytes of new whitespace — not more, and the
      // pre-existing space run/indentation behaviour (unaffected by #183's fix; see rich-editor.js's
      // PARAGRAPH_SPEC comment) is what this pins.
      expect(result.save.markdown).toBe("A paragraph where the writer types words apart    .\n");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "criterion 3 (paste): a pasted multi-space run, a tab, and leading indentation collapse exactly as they did before #183",
    async () => {
      const source = "Alpha.\n";
      writeFileSync(join(workspaceRoot, "paste.md"), source);
      const { client, argv } = await launchBrowser();
      cdp = client;
      // A synthetic ClipboardEvent, dispatched on the real contenteditable — the standard way to
      // drive a real paste handler in a headless browser with no OS clipboard to source from. The
      // event and its handling are entirely real; only the origin of the clipboard data is
      // synthesized, exactly as a unit test constructing a File object stands in for a real upload.
      const script = `
        (async () => {
          const { createDataAccess } = await import("/app/data-access.js");
          const { mountRichEditor } = await import("/app/rich-editor.js");
          sessionStorage.setItem("glosa_token", ${JSON.stringify(TOKEN)});
          const dataAccess = createDataAccess();
          const artifact = await dataAccess.getArtifact(${JSON.stringify(slug)}, "paste.md");
          const container = document.createElement("div");
          document.body.appendChild(container);
          const editor = mountRichEditor(container, { markdown: artifact.content });
          const host = container.querySelector(".glosa-rich-surface .ProseMirror[contenteditable]");
          if (!host) return { ok: false, reason: "no contenteditable" };
          const range = document.createRange();
          range.selectNodeContents(host);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          host.focus();
          const html = "<p>alpha  beta   gamma\\tdelta</p><p>   indented</p><p>line one\\nline two</p>";
          const dt = new DataTransfer();
          dt.setData("text/html", html);
          dt.setData("text/plain", html.replace(/<[^>]+>/g, ""));
          const pasted = host.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const save = editor.getSave();
          const putResult = await dataAccess.putArtifact(${JSON.stringify(slug)}, "paste.md", save.markdown, {
            ifMatch: artifact.source_sha256,
          });
          editor.destroy();
          container.remove();
          return { ok: true, pasted, save, putResult };
        })()
      `;
      let result: any;
      try {
        result = await client.evaluate(script);
      } catch (error) {
        const { out, err } = await terminateAndDrainChrome();
        throw new Error(`paste.md: in-browser paste failed: ${error}\nargv=${JSON.stringify(argv)}\n${out}\n${err}`);
      }
      expect(result.ok, String(result.reason ?? "")).toBe(true);
      // Ordinary HTML-paste collapse — a run of spaces to one, a tab to one, leading indentation
      // trimmed, a raw newline inside the pasted markup folded to a space — byte for byte the
      // same as this test asserts against the fully unmodified schema (git-stashing
      // PARAGRAPH_SPEC entirely and rerunning this exact test produces this exact string; see
      // docs/decisions.md's own entry for where that comparison is recorded).
      const expected = "alpha beta gamma delta\n\nindented\n\nline one line twoAlpha.\n";
      expect(result.save.markdown).toBe(expected);
      // Not just `getSave()`: the same real PUT route the keypress tests use, and the same disk
      // readback, so this is what actually lands in the file, not merely what the in-memory splice
      // report claims it would write.
      const diskContent = readFileSync(join(workspaceRoot, "paste.md"), "utf8");
      expect(diskContent, "the pasted-and-saved file on disk matches getSave()'s own markdown").toBe(expected);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "failure path: a Chromium that never opens CDP is reported with argv and streams, and does not survive",
    async () => {
      // A fake "chromium" that starts, proves it ran (so the retained stderr/stdout has something
      // to show), and then hangs well past the overridden deadline below — never opening the port
      // `launchBrowser`'s poll is waiting on. This is the diagnostic path itself under test, not
      // the product: a real Chromium hanging this way is exactly hazard #2 from the contract
      // ("an isolated macOS Chromium check can time out before it produces its DOM").
      const fakeChromium = join(workspaceRoot, "fake-chromium.sh");
      // `exec`, not a bare `sleep 30`: POSIX `exec` replaces the shell's own process image rather
      // than forking a child, so the one pid Bun tracks IS the sleeping process — measured without
      // it, a bare `sleep 30` forks, `kill(pid)` only reaches the now-exited parent shell, and the
      // orphaned `sleep` survives the test that thought it had cleaned up.
      writeFileSync(fakeChromium, "#!/bin/sh\necho fake-chromium-started\nexec sleep 30\n", { mode: 0o755 });

      const startedAt = Date.now();
      let thrown: Error | null = null;
      try {
        await launchBrowser({ deadlineMs: 1_500, targetFetchTimeoutMs: 1_500, executablePath: fakeChromium });
      } catch (error) {
        thrown = error as Error;
      }
      const elapsedMs = Date.now() - startedAt;

      expect(thrown, "a browser that never opens CDP must be reported as a failure, not silently hang").not.toBe(null);
      expect(thrown?.message).toContain("did not open its CDP endpoint");
      expect(thrown?.message, "argv is retained on the diagnostic path, not only on success").toContain(
        `"${fakeChromium}"`,
      );
      expect(thrown?.message, "the fake process's own stdout is drained and reported").toContain(
        "fake-chromium-started",
      );
      // The override was 1.5s, not the real 10s default: returning in well under the outer test
      // timeout is what proves this failure is reported promptly rather than by outlasting
      // something else's budget.
      expect(elapsedMs, "the diagnostic must return near the overridden deadline").toBeLessThan(5_000);
      // Ownership: `launchBrowser`'s own catch path terminates and awaits the process it spawned
      // before this test ever asks — a surviving `sleep 30` here would mean the boundary this
      // finding exists to fix is still open.
      expect(chrome, "the fake chromium handle is still the one launchBrowser tracked").not.toBe(null);
      // A SIGKILLed process reports `exitCode: null` in Bun's model (it died by signal, not by
      // returning a status), so the real proof of death is the signal itself, plus that the PID no
      // longer answers `kill(pid, 0)` — Bun's own `proc.exited` having resolved is not, on its own,
      // distinguishable from "resolved because the process was already gone before we ever awaited
      // it", which a stale handle could also produce.
      expect(chrome?.signalCode, "the fake chromium process was actually killed, not merely asked to exit").toBe(
        "SIGKILL",
      );
      const pid = chrome?.pid;
      expect(pid, "a pid must exist to check").not.toBeUndefined();
      let stillAlive = true;
      try {
        process.kill(pid as number, 0);
      } catch {
        stillAlive = false;
      }
      expect(stillAlive, "no process with the fake chromium's pid may still be running").toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "failure path: a stalled /json/list is bounded by its own deadline, not by the outer timeout",
    async () => {
      // The preceding test's fake never opens the CDP port at all, so `launchBrowser` throws at the
      // `/json/version` poll and never reaches the target-list fetch. That left the second repaired
      // boundary — the `/json/list` deadline — asserted by source reading only. This fake gets
      // PAST the version poll and then stalls exactly where that deadline is the only thing that
      // can end the wait.
      const fakeServer = join(workspaceRoot, "fake-cdp.js");
      writeFileSync(
        fakeServer,
        [
          "const port = Number(Bun.argv.find((a) => a.startsWith('--remote-debugging-port='))?.split('=')[1]);",
          "console.log('fake-cdp-started');",
          "Bun.serve({",
          "  port,",
          "  hostname: '127.0.0.1',",
          "  async fetch(req) {",
          "    const url = new URL(req.url);",
          "    if (url.pathname === '/json/version') {",
          "      return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` });",
          "    }",
          "    // /json/list answers, but LATE — deliberately later than the deadline under test and",
          "    // earlier than the outer test timeout. Never answering at all would mean that removing",
          "    // the deadline leaves execution parked inside fetch until the suite's own timeout, so",
          "    // the elapsed-time assertion below would never be REACHED and could not fail. Answering",
          "    // late is what makes the ablation land on the assertion instead.",
          "    await Bun.sleep(6000);",
          "    return Response.json([{ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fake` }]);",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      const fakeChromium = join(workspaceRoot, "fake-cdp.sh");
      // `exec` for the same reason as the test above: the pid Bun tracks must BE the server, not a
      // parent shell whose death would orphan it.
      writeFileSync(fakeChromium, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`, { mode: 0o755 });

      const startedAt = Date.now();
      let thrown: Error | null = null;
      try {
        // A generous version-poll deadline: the fake answers /json/version promptly, so reaching
        // the stall is the expected path. The SHORT budget is the target fetch, under test here.
        await launchBrowser({ deadlineMs: 10_000, targetFetchTimeoutMs: 1_500, executablePath: fakeChromium });
      } catch (error) {
        thrown = error as Error;
      }
      const elapsedMs = Date.now() - startedAt;

      expect(thrown, "a stalled /json/list must fail the call, not hang it").not.toBe(null);
      expect(thrown?.message, "the launch argv is reported").toContain(`"${fakeChromium}"`);
      expect(thrown?.message, "the fake server's own stdout is drained and reported").toContain("fake-cdp-started");
      // The assertion that carries the finding, and it is REACHABLE in both directions. With the
      // deadline the fetch aborts at ~1.5s and lands here well under the bound. Remove
      // `AbortSignal.timeout(targetFetchTimeoutMs)` and the fake's own 6s answer arrives instead,
      // so this same line runs and FAILS on the elapsed time — a named red on the assertion rather
      // than the suite quietly dying on its own timeout with nothing reported.
      expect(elapsedMs, "bounded by the target-fetch deadline, not by the fake's late answer").toBeLessThan(4_000);

      let stillAlive = true;
      try {
        process.kill(chrome!.pid, 0);
      } catch {
        stillAlive = false;
      }
      expect(stillAlive, "the stalled fake server is terminated and awaited, never left running").toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "failure path: a bounded read gives up on a child that answers after its deadline",
    async () => {
      // A real child that starts, then writes its stdout LATE — after `readBounded`'s own deadline
      // and well before this test's own timeout. A child that never writes at all would leave the
      // read parked inside `new Response(stream).text()` with nothing for the assertion below to
      // reach if the timeout were removed (the same defect that produced this issue — see test 6's
      // own comment, and `L-issue-140-3`); answering late is what makes the ablation land on the
      // assertion instead of hanging the suite.
      const fakeChild = join(workspaceRoot, "fake-slow-reader.sh");
      writeFileSync(fakeChild, "#!/bin/sh\nsleep 3\necho late-output\n", { mode: 0o755 });
      const proc = spawnChild("slow-reader-canary", {
        cmd: [fakeChild],
        env: childEnv,
        stdout: "pipe",
        stderr: "ignore",
      });

      const startedAt = Date.now();
      const text = await readBounded(proc.stdout, 500);
      const elapsedMs = Date.now() - startedAt;
      await killAndAwait(proc);

      expect(text, "a read that times out returns empty, not the child's late output").toBe("");
      // The 3s write is well inside this test's own 30s timeout, so a removed deadline would not
      // hang the suite — it would resolve with "late-output\n" instead, failing the line above, and
      // land here at ~3000ms, failing this bound too. Either failure is a named red, not a hang.
      expect(elapsedMs, "bounded by readBounded's own deadline, not by the child's late write").toBeLessThan(2_000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "failure path: a CDP call that answers after its deadline is reported, not awaited forever",
    async () => {
      // An in-process fake CDP peer: a WebSocket server that accepts the connection immediately (so
      // `CdpClient.connect` resolves) but answers the one call it receives LATE — after that call's
      // own deadline and well before this test's own timeout. A peer that never answers at all would
      // leave the call's promise with nothing to race if the timer were removed; answering late is
      // what makes the ablation land on the assertion below rather than hanging the suite.
      let sawCall: (id: number) => void;
      const called = new Promise<number>((resolve) => {
        sawCall = resolve;
      });
      const fakePeer = Bun.serve({
        hostname: "127.0.0.1",
        port: randomPort(),
        fetch(req, srv) {
          if (srv.upgrade(req)) return undefined;
          return new Response("upgrade required", { status: 400 });
        },
        websocket: {
          message(ws, message) {
            const msg = JSON.parse(message as string);
            sawCall(msg.id);
            setTimeout(() => ws.send(JSON.stringify({ id: msg.id, result: {} })), 3_000);
          },
        },
      });

      try {
        const client = await CdpClient.connect(`ws://127.0.0.1:${fakePeer.port}/`);
        try {
          const startedAt = Date.now();
          let thrown: Error | null = null;
          try {
            await client.send("Fake.method", {}, 500);
          } catch (error) {
            thrown = error as Error;
          }
          const elapsedMs = Date.now() - startedAt;
          // Proves the fake actually received the call (not a red caused by a dead socket, which
          // would be a false positive for the deadline under test).
          await called;

          expect(thrown, "a CDP call that answers after its deadline must be reported, not hang").not.toBe(null);
          expect(thrown?.message).toContain("Fake.method did not answer within 500ms");
          expect(elapsedMs, "bounded by the call's own deadline, not by the peer's late answer").toBeLessThan(2_000);
        } finally {
          client.close();
        }
      } finally {
        fakePeer.stop(true);
      }
    },
    TEST_TIMEOUT_MS,
  );

  /** The credential boundary asserted at the SPAWN, not at the pure function that builds the env.
   *
   *  A test of `buildChildEnv` alone stays green if any call site stops using its result, which is
   *  the whole failure this guard exists to catch. Two assertions do that together: every recorded
   *  child's env must be clean, AND the recorded label set must be exactly this scenario's EXPECTED
   *  recorded labels — `chromium-version-probe` and `glosa-daemon` before the browser launches, plus
   *  `chromium` after, with the daemon additionally carrying `GLOSA_HOME`. Expected RECORDED, not
   *  every child started: a child that bypasses `spawnChild` is started and never recorded, so it
   *  cannot appear in or perturb this set. That gap is the source guard's, not this test's, and the
   *  paragraph below says so. Other tests in this file spawn their own labelled children;
   *  `spawnedChildren` is reset per test, so they are not in this set, and no count here is stated
   *  as a file-wide total — that is the kind of number that rots the moment a call site is added.
   *
   *  WHAT THIS CATCHES, EXACTLY. Converting one of this scenario's labelled `spawnChild(...)` call
   *  sites back to a bare `Bun.spawn(...)` removes its entry from `spawnedChildren` entirely, so
   *  the count/label-set assertions below go red on exactly that label — and on `HOME` too, if the
   *  bare call also drops `env`. That is a real, ablatable guard, exercised below.
   *
   *  WHAT THIS CANNOT CATCH — narrowed here rather than left to overclaim (`L-pipeline-graph-gate-1`).
   *  A spawn added somewhere in this file that never went through `spawnChild` at all — not
   *  replacing one of this scenario's call sites, just a new one — pushes no entry onto
   *  `spawnedChildren`, so it changes neither the recorded label set nor any count: a recorder
   *  cannot enumerate the calls that bypass it. The assertions below are worded to say only what
   *  they can prove; the source-level guard in the fixture-free describe below (`the only Bun.spawn
   *  call in this file's source is inside the spawn wrapper`) is what covers that case instead. */
  test(
    "every recorded child of this scenario carries the scrubbed environment, and no unexpected label appears",
    async () => {
      // An inventory, not a literal list. `installedChromium` loops over every candidate until one
      // qualifies, so a machine whose FIRST installed browser is too old records two probes and
      // is still perfectly isolated — pinning "exactly one probe" would fail that environment for
      // no reason. What stays exact is the deterministic pair, and `>= 1` on the probe is still
      // enough to catch a bypass, because bypassing the only probe records ZERO.
      const tally = () =>
        spawnedChildren.reduce<Record<string, number>>((acc, c) => {
          acc[c.label] = (acc[c.label] ?? 0) + 1;
          return acc;
        }, {});

      let counts = tally();
      expect(counts["chromium-version-probe"] ?? 0, "the version probe went through spawnChild").toBeGreaterThanOrEqual(
        1,
      );
      expect(counts["glosa-daemon"] ?? 0, "exactly one daemon, spawned through spawnChild").toBe(1);
      expect(
        Object.keys(counts).sort(),
        "the recorded spawnChild label set is exactly these two — no known label missing, no unexpected label added",
      ).toEqual(["chromium-version-probe", "glosa-daemon"]);

      const { client } = await launchBrowser();
      cdp = client;

      counts = tally();
      expect(counts.chromium ?? 0, "exactly one Chromium, spawned through spawnChild").toBe(1);
      expect(Object.keys(counts).sort(), "launching the browser adds Chromium and nothing else").toEqual([
        "chromium",
        "chromium-version-probe",
        "glosa-daemon",
      ]);

      for (const child of spawnedChildren) {
        expect(child.env, `${child.label} was spawned with an explicit environment`).toBeDefined();
        expect(
          child.env?.ANTHROPIC_API_KEY,
          `${child.label}: AGENTS.md invariant 5 — the key is scrubbed from EVERY spawned child`,
        ).toBeUndefined();
        expect(child.env?.HOME, `${child.label}: HOME points at this test's private home`).toBe(home);
      }

      // The daemon additionally carries its own state root, and it must be inside the private home
      // rather than anywhere the real user's environment would have pointed it.
      const daemonChild = spawnedChildren.find((c) => c.label === "glosa-daemon");
      expect(daemonChild?.env?.GLOSA_HOME, "the daemon's state root is the private home").toBe(home);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("#183 — child-environment isolation (fast, no browser)", () => {
  /** The half of #201's claim the recorder above cannot carry: catching a bypass WITHOUT running
   *  anything, so it fails on a bare spawn even in a scenario the recorder-based test above never
   *  exercises.
   *
   *  THE REAL GUARANTEE IS THE COMPILER'S, NOT THIS SCAN'S. `spawnChild` (declared near the top of
   *  this file) is not exported — this is a test file, not a package entry point, so nothing
   *  outside it can import, wrap, or reach around it. That already rules out a bypass from any
   *  OTHER module in the repository; a bare `Bun.spawn` in some unrelated file (there are many —
   *  the daemon, the CLI, other acceptance tests) has nothing to do with THIS wrapper, and scanning
   *  the whole tree for the literal text "Bun.spawn(" would flag all of them and prove nothing
   *  about this file's own boundary.
   *
   *  WHAT MODULE PRIVACY DOES NOT COVER: a future edit to THIS file calling `Bun.spawn` directly
   *  instead of `spawnChild`, which is exactly the bypass #201 and the guard above are about. That
   *  is the one thing this scan checks — a literal `Bun.spawn(` in this file's own source, outside
   *  `spawnChild`'s own body, with block comments stripped first so the ABLATION notes elsewhere in
   *  this file (which quote that exact text) are not counted as a real call.
   *
   *  THE CLAIM IS NO LARGER THAN THE CHECK (`L-issue-146-3`): this recognises one spelling of a
   *  spawn — the literal token sequence `Bun.spawn(` — not the construct. `Bun["spawn"](...)`, a
   *  rebound `const spawn = Bun.spawn`, or a subprocess started through something other than
   *  `Bun.spawn` entirely (`Bun.spawnSync`, a dynamically imported module) would not be caught
   *  here. Stated as the narrower thing it is, per the same review history that produced
   *  `packages/daemon/test/registry/import-guard.test.ts`.
   *
   *  ONE TRAP FOR WHOEVER EDITS THIS NEXT. The scan reads this file's own source with only BLOCK
   *  comments stripped, so a string literal — an assertion message, say — that spells the matched
   *  token verbatim counts as a call and reds this test. That is not hypothetical: rewording the
   *  message below to quote the token did exactly that. Say "direct spawn call" in prose instead.
   *  Line comments are safe only because none of them happen to quote it. */
  test("the only Bun.spawn call in this file's source is inside the spawn wrapper", () => {
    const selfPath = new URL(import.meta.url).pathname;
    const source = readFileSync(selfPath, "utf8");
    // Block comments only: this file's line (`//`) comments never quote the exact call-site text
    // this scan looks for, so stripping them is unneeded and would risk mistaking a "://" inside a
    // string (this file has several, e.g. an http URL) for the start of a line comment.
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
      "\n".repeat((block.match(/\n/g) ?? []).length),
    );

    const declStart = withoutBlockComments.indexOf("function spawnChild");
    expect(declStart, "spawnChild's own declaration must still be findable to bound this scan").toBeGreaterThan(-1);
    // The `{` right after the parameter list's own closing `)` is the function body's opening
    // brace — NOT the first `{` after the declaration, which lands inside the `options` parameter's
    // own inline object type (`{ cmd: string[]; env?: ... }`) and would bound the wrong span.
    const paramsClose = withoutBlockComments.indexOf(")", declStart);
    expect(paramsClose, "spawnChild's own parameter list must still be findable to bound this scan").toBeGreaterThan(
      declStart,
    );
    const bodyOpen = withoutBlockComments.indexOf("{", paramsClose);
    let depth = 0;
    let bodyEnd = -1;
    for (let i = bodyOpen; i < withoutBlockComments.length; i += 1) {
      if (withoutBlockComments[i] === "{") depth += 1;
      else if (withoutBlockComments[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    expect(bodyEnd, "spawnChild's closing brace must be findable to bound this scan").toBeGreaterThan(bodyOpen);

    const matches = [...withoutBlockComments.matchAll(/\bBun\.spawn\s*\(/g)];
    expect(matches.length, "exactly one direct spawn call in this file: the one inside spawnChild itself").toBe(1);
    const onlyMatch = matches[0];
    expect(onlyMatch, "the single matched occurrence must be locatable").toBeDefined();
    expect(
      (onlyMatch?.index ?? -1) > bodyOpen && (onlyMatch?.index ?? -1) < bodyEnd,
      "the one Bun.spawn call in this file must be inside spawnChild's own body, not a new call site outside it",
    ).toBe(true);
  });

  /** The credential boundary observed from INSIDE a real child, which is the only place it is
   *  actually true or false.
   *
   *  The inventory guard below catches a call site that bypasses `spawnChild`. It cannot catch
   *  `spawnChild` itself recording a clean `options.env` and then handing the process something
   *  else — every label and every recorded-env assertion stays green while the real child inherits
   *  the ambient key. So this spawns a canary THROUGH the same wrapper, under a deliberately dirty
   *  ambient environment, and reads what the process itself reports.
   *
   *  It deliberately spawns nothing but the canary — no daemon, no browser — so that ablating
   *  the wrapper's env forwarding fails on THIS assertion. Inside the browser describe it failed
   *  first on the daemon handshake, which is a red caused by the ablation but not one attributable
   *  to the boundary under test.
   *
   *  ABLATION: change `spawnChild` to `Bun.spawn({ ...options, env: Bun.env })` and this goes red
   *  on the leaked key, while the inventory guard stays green — which is exactly the gap it exists
   *  to close. */
  test(
    "a real child spawned through the wrapper receives the scrubbed environment, not the ambient one",
    async () => {
      const privateHome = mkdtempSync(join(tmpdir(), "glosa-183-canary-home-"));
      const canary = join(privateHome, "env-canary.js");
      writeFileSync(
        canary,
        "console.log(JSON.stringify({ key: Bun.env.ANTHROPIC_API_KEY ?? null, home: Bun.env.HOME ?? null }));\n",
      );

      // Poisoned on purpose: a check that only passes because this machine happens to have no key
      // set proves nothing at all.
      const dirtyAmbient = {
        ...Bun.env,
        ANTHROPIC_API_KEY: "leaked-secret-that-must-not-reach-a-child",
        HOME: "/Users/not-this-test",
      } as Record<string, string | undefined>;
      const canaryEnv = buildChildEnv(dirtyAmbient, privateHome);

      const proc = spawnChild("env-canary", {
        cmd: [process.execPath, canary],
        env: canaryEnv,
        stdout: "pipe",
        stderr: "ignore",
      });
      const reported = JSON.parse((await readBounded(proc.stdout, 10_000)).trim() || "{}");
      await killAndAwait(proc);

      expect(proc.exitCode, "the canary ran to completion").toBe(0);
      expect(
        reported.key,
        "AGENTS.md invariant 5: the child PROCESS must not see ANTHROPIC_API_KEY, whatever was recorded",
      ).toBe(null);
      expect(reported.home, "the child PROCESS sees this test's private home").toBe(privateHome);
    },
    TEST_TIMEOUT_MS,
  );

  test("the shared child environment scrubs ANTHROPIC_API_KEY and redirects HOME, regardless of the ambient shell", () => {
    // Explicitly injected rather than relying on whatever the CI/dev shell happens to have set —
    // a check that only passes because the ambient environment happens to be clean proves nothing.
    const ambient = { ...Bun.env, ANTHROPIC_API_KEY: "leaked-secret", HOME: "/Users/real-person" } as Record<
      string,
      string | undefined
    >;
    const env = buildChildEnv(ambient, "/private/throwaway-home");
    expect(env.ANTHROPIC_API_KEY, "AGENTS.md invariant 5: scrub the key from every spawned child").toBeUndefined();
    expect(env.HOME, "HOME is redirected to the private home, never the real one").toBe("/private/throwaway-home");
    // Everything else the ambient shell carries (PATH, etc.) still passes through — this is a
    // scrub, not a wipe; the child still has to be able to find its own binaries.
    expect(env.PATH, "unrelated ambient variables are preserved").toBe(Bun.env.PATH);
  });
});
