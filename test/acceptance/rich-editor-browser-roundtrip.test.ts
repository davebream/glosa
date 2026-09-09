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

function spawnChild<In extends Bun.SpawnOptions.Writable, Out extends Bun.SpawnOptions.Readable, Err extends Bun.SpawnOptions.Readable>(
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
    const probe = spawnChild("chromium-version-probe", { cmd: [executable, "--version"], env, stdout: "pipe", stderr: "ignore" });
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
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send("Input.dispatchKeyEvent", {
      type: "char",
      key: char,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      text: char,
      unmodifiedText: char,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: char, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
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
    opts: { deadlineMs?: number; targetFetchTimeoutMs?: number; executablePath?: string } = {},
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
      // No pairing fragment: this test never drives the app shell's own routing, only the daemon's
      // static `/app/` module route, so a bare same-origin navigation is enough to get the right
      // origin for the dynamic imports and `fetch()` calls the in-page script makes.
      await client.navigate(`http://127.0.0.1:${port}/`);
    } catch (error) {
      client?.close();
      const { out, err } = await terminateAndDrainChrome();
      throw new Error(
        `${(error as Error).message}\nargv=${JSON.stringify(argv)}\n--- chrome stdout ---\n${out}\n--- chrome stderr ---\n${err}`,
      );
    }
    return { client, argv };
  }

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
      const { result, edited, diskContent } = await runScenario(
        "blockquote.md",
        BLOCKQUOTE_SOURCE,
        "deliberate",
        "X",
      );
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

      expect(thrown, "a browser that never opens CDP must be reported as a failure, not silently hang").not.toBe(
        null,
      );
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

  /** The credential boundary asserted at the SPAWN, not at the pure function that builds the env.
   *
   *  A test of `buildChildEnv` alone stays green if any call site stops using its result, which is
   *  the whole failure this guard exists to catch. Two assertions do that together, and neither
   *  works alone: every recorded child's env must be clean, AND the recorded count must match the
   *  children this scenario actually starts. Drop the count and a spawn that bypassed `spawnChild`
   *  contributes no record, so "every record is clean" stays trivially true while a real child
   *  inherits the ambient environment.
   *
   *  ABLATION: change any one of the three `spawnChild(...)` call sites back to a bare
   *  `Bun.spawn(...)` and this goes red — on the count for that child, and on `HOME` too if the
   *  bare call also drops `env`. */
  test(
    "every child is spawned through the scrubbed environment, and none bypasses it",
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
      expect(counts["chromium-version-probe"] ?? 0, "the version probe went through spawnChild").toBeGreaterThanOrEqual(1);
      expect(counts["glosa-daemon"] ?? 0, "exactly one daemon, spawned through spawnChild").toBe(1);
      expect(Object.keys(counts).sort(), "no child is spawned outside spawnChild").toEqual([
        "chromium-version-probe",
        "glosa-daemon",
      ]);

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
