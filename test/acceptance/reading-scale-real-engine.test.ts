// SPDX-License-Identifier: Apache-2.0
// #406 — the reading surfaces at the sizes a reader asks for, in a real engine.
//
// Every claim here is about layout, so none of it can be settled in happy-dom, which lays nothing
// out: whether text is clipped or overlapped, whether the page scrolls sideways, and how wide the
// document column actually paints.
//
//   * WCAG 2.2 SC 1.4.4 (resize text): at an effective 200 percent zoom, a long document in Review,
//     its margin notes, an open composer and the chat reflow. Nothing is clipped or overlapped, and
//     the page does not scroll sideways outside a pane's own scrolling.
//   * WCAG 2.2 SC 1.4.12 (text spacing): with the criterion's four overrides forced on every element,
//     as the W3C's own bookmarklet forces them, the same surfaces lose nothing.
//
// Real, not simulated: one real `glosa __daemon` subprocess, one real registered workspace holding a
// long synthetic document, notes saved through the daemon's own route, one installed Chromium driven
// over raw CDP. The chat's transport is the one fixture: a chat needs a signed-in agent, so its pane
// is mounted with a scripted data access, which proves the chat's layout and not a live session. The
// CDP client is file-local on purpose, as in the other real-engine gates: sharing one would couple
// two gates' failure modes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../../packages/daemon/src/security/token.ts";
import { randomPort, superviseDaemonHome } from "../../packages/daemon/test/helpers.ts";

const MAIN_PATH = new URL("../../packages/cli/src/main.ts", import.meta.url).pathname;
const TOKEN = "reading-scale-real-engine-token-0123456789ab";
const TEST_TIMEOUT_MS = 90_000;

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

const DOC = "reading.md";
/** Words each note is anchored to. Each occurs once in the document, so each note has a place. */
const NOTED = ["the premise a reader has to take on trust", "a realistic length for section three"] as const;
const NOTE_BODY = "Earn this before asking for it. A second sentence makes the note wrap across lines.";

/** A document long enough to scroll many screens, with every block the manuscript styles. */
function readingDocument(sections = 10): string {
  const parts = ["# The reading scale, set out at length", ""];
  for (let s = 1; s <= sections; s += 1) {
    const noted = s === 1 ? ` It rests on ${NOTED[0]}.` : s === 3 ? ` The paragraph reaches ${NOTED[1]}.` : "";
    parts.push(
      `## Section ${s}: what the page has to hold`,
      "",
      `Section ${s} opens with a paragraph long enough to wrap across several lines at every size, with a word like "interoperability" and a path such as \`packages/spa/src/artifact-pane.js\` that must wrap too.${noted}`,
      "",
      `### A subhead in section ${s}`,
      "",
      "Body text under the subhead, so a reader can see whether the measure holds and whether each heading stays above the text it introduces.",
      "",
      `#### A minor heading, section ${s}`,
      "",
      "- A first item in a list",
      "- A second item, rather longer, so that it wraps onto a second line at the larger sizes",
      "",
      `##### A fifth-level heading, section ${s}`,
      "",
      "> A quotation the writer wants to keep, set as a blockquote, running to two lines.",
      "",
      `###### A sixth-level heading, section ${s}`,
      "",
    );
    if (s % 3 === 0) {
      parts.push(
        "```",
        `const section = ${s}; // a long line that scrolls inside its own block rather than pushing the page sideways`,
        "```",
        "",
      );
    }
    if (s % 4 === 0) {
      parts.push(
        "| Term | Meaning | Count |",
        "| --- | --- | --- |",
        `| Step | One rung of the ladder | ${s} |`,
        "| Rail | The column of notes beside the page | 2 |",
        "",
      );
    }
  }
  return parts.join("\n");
}

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

  /** Arms a listener BEFORE the caller issues the command that produces the event. */
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

  close(): void {
    this.#ws.close();
  }
}

/** Waits for layout to settle: fonts loaded, every running transition or animation finished, and
 * two frames drawn after that. */
const SETTLE = `(async()=>{await document.fonts.ready;
  await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
  for (let frame=0; frame<2; frame++) await new Promise(r=>requestAnimationFrame(r));})()`;

interface Finding {
  el: string;
  text: string;
  by?: string;
  with?: string;
}
interface Audit {
  /** The page's own sideways scroll: the document and the app root, against their visible width. */
  sideways: { document: number; app: number };
  /** Text a box cuts off where nothing scrolls to reveal it. */
  clipped: Finding[];
  /** Text cut short on purpose by an ellipsis or a line clamp. Reported, not failed: a note's quote
   * repeats words the page shows in full, and a truncated tab name is the navigator's full row. */
  truncated: Finding[];
  /** Two runs of text painted over each other inside one reading surface, or a margin note over the
   * document column. */
  overlapped: Finding[];
  /** How many text-bearing elements were checked, so an audit of an empty page cannot pass. */
  checked: number;
}

/** Audits every text-bearing element on the page for clipping, and the reading surfaces for text
 * painted over other text. Coordinates are the engine's own: `getClientRects` of each text node. */
const AUDIT = `(()=>{
  const name=(e)=>e.tagName.toLowerCase()+(e.classList.length?'.'+[...e.classList].join('.'):'');
  const shown=(e)=>e.checkVisibility?e.checkVisibility({visibilityProperty:true,opacityProperty:true}):true;
  // A label for screen readers only: text inside a 1px box that hides its overflow is never painted.
  const spoken=(e)=>{for(let a=e;a&&a!==document.body;a=a.parentElement){const b=a.getBoundingClientRect();
    if((b.width<=1||b.height<=1)&&getComputedStyle(a).overflow!=='visible') return true;} return false;};
  const textRects=(e)=>{const out=[];const range=document.createRange();
    for(const n of e.childNodes) if(n.nodeType===3&&n.data.trim()){range.selectNodeContents(n);
      out.push(...[...range.getClientRects()].filter(r=>r.width>0&&r.height>0));}
    return out;};
  const truncates=(e)=>{const s=getComputedStyle(e);return s.textOverflow==='ellipsis'||(s.webkitLineClamp&&s.webkitLineClamp!=='none');};
  const hides=(v)=>v==='hidden'||v==='clip';
  const scrolls=(v)=>v==='auto'||v==='scroll';
  const out={sideways:{document:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth,
    app:(()=>{const app=document.getElementById('app');return app?app.scrollWidth-app.clientWidth:0;})()},
    clipped:[],truncated:[],overlapped:[],checked:0};
  for(const el of document.querySelectorAll('body *')){
    if(!shown(el)||spoken(el)) continue;
    const rects=textRects(el); if(!rects.length) continue;
    out.checked++;
    let onPurpose=false; for(let a=el;a&&a!==document.body;a=a.parentElement) if(truncates(a)){onPurpose=true;break;}
    // Walk out to the first box that hides overflow on an axis nothing inside it scrolls: text
    // outside that box is gone. A 1px box is a screen-reader-only label, not a clip.
    const reach={x:false,y:false};
    for(let a=el;a&&a!==document.documentElement;a=a.parentElement){
      const s=getComputedStyle(a),box=a.getBoundingClientRect();
      const left=box.left+parseFloat(s.borderLeftWidth),top=box.top+parseFloat(s.borderTopWidth);
      const x=!reach.x&&hides(s.overflowX),y=!reach.y&&hides(s.overflowY);
      const cut=rects.find(r=>(x&&(r.left<left-1||r.right>left+a.clientWidth+1))||(y&&(r.top<top-1||r.bottom>top+a.clientHeight+1)));
      if(cut){(onPurpose?out.truncated:out.clipped).push({el:name(el),text:el.textContent.trim().slice(0,60),by:name(a)});break;}
      if(scrolls(s.overflowX)) reach.x=true;
      if(scrolls(s.overflowY)) reach.y=true;
      if(reach.x&&reach.y) break;
    }
  }
  // Overlap is checked within each reading surface, and between the margin and the document. The
  // composer and the collection tray float over the page by design, so neither is compared with it.
  const surfaces={document:'.glosa-pane .glosa-content',margin:'.glosa-margin',composer:'.glosa-composer-layer',
    chat:'.glosa-chat-history',draft:'.glosa-chat-composer'};
  const runs={};
  for(const [key,selector] of Object.entries(surfaces)){
    runs[key]=[];
    for(const root of document.querySelectorAll(selector)) for(const el of [root,...root.querySelectorAll('*')]){
      if(!shown(el)||spoken(el)) continue; const rects=textRects(el); if(rects.length) runs[key].push({el,rects});
    }
  }
  const meet=(a,b)=>a.rects.some(r=>b.rects.some(s=>Math.min(r.right,s.right)-Math.max(r.left,s.left)>1&&Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)>1));
  const compare=(one,two)=>{for(let i=0;i<one.length;i++) for(let j=one===two?i+1:0;j<two.length;j++){
    const a=one[i],b=two[j]; if(a.el.contains(b.el)||b.el.contains(a.el)) continue;
    if(meet(a,b)) out.overlapped.push({el:name(a.el),text:a.el.textContent.trim().slice(0,60),with:name(b.el)+' '+b.el.textContent.trim().slice(0,60)});}};
  for(const key of Object.keys(surfaces)) compare(runs[key],runs[key]);
  compare(runs.margin,runs.document);
  return out;
})()`;

/** The WCAG 1.4.12 overrides, exactly as the W3C's text spacing bookmarklet applies them: to every
 * element, with `!important`, so no rule of the page's own can win. */
const TEXT_SPACING = `(()=>{const style=document.getElementById('wcag-text-spacing')??document.createElement('style');style.id='wcag-text-spacing';
  style.textContent='*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}';
  document.head.append(style);return true;})()`;

/** A chat with a reply, a question from the person and a draft, mounted from the production module
 * with a scripted transport. `alone` replaces the page's body, so an audit measures the chat alone;
 * otherwise it is laid out out of the way, unseen, beside the document, for its sizes to be read. */
const mountChat = (alone: boolean) => `(async()=>{
  const { createChatPane } = await import('/app/chat-pane.js');
  const host=document.createElement('main');
  host.style.cssText=${
    alone
      ? `'height:100vh;width:100%;padding:12px;box-sizing:border-box'`
      : `'position:fixed;left:0;bottom:0;height:420px;width:640px;visibility:hidden;pointer-events:none'`
  };
  if (${alone}) document.body.replaceChildren(host); else document.body.append(host);
  const reply='The outline holds, with one gap. **The second section** promises a comparison it never makes.\\n\\n### What to change\\n\\n- Name the two options before weighing them.\\n- Move the example with a long path, \`packages/spa/src/chat-pane.js\`, into its own paragraph.\\n\\n\`\`\`\\nconst unchanged = true; // a code line long enough to need its own sideways scroll inside the block\\n\`\`\`\\n\\nRead [the outline guide](https://example.com/guide) before revising.';
  const state={id:'fixture',profileId:'a',provider:'claude-code',title:'Review the outline',revision:1,configRevision:1,draftRevision:0,
    draft:'A draft that runs long enough to wrap across two lines of the composer before it is sent.',draftAttachments:[],archived:false,
    settings:{model:'model',effort:'high',permissionMode:'default'},
    turns:[{id:'first',text:'Review my outline, and say where the argument is weakest.',status:'completed'}],
    content:[{id:'reply',turnId:'first',kind:'text',role:'assistant',text:reply}],decisions:[]};
  const access={
    getAgentStatus:async()=>({available:true,profiles:[{id:'a',provider:'claude-code',label:'Personal',enabled:true}],capabilities:{a:{models:[{id:'model',name:'Model',efforts:['high']}]}}}),
    getChat:async()=>structuredClone(state),openChatStream:()=>()=>{},
    saveChatDraft:async(_s,_i,input)=>{state.draft=input.text;state.draftRevision++;return structuredClone(state);},
  };
  const pane=createChatPane(host,{dataAccess:access,slug:'fixture',chatId:'fixture',onChange(){},onSettings(){}});
  await pane.ready;
  const deadline=Date.now()+5000;
  while(!document.querySelector('.glosa-chat-history .glosa-chat-markdown p')){
    if(Date.now()>deadline) throw new Error('the chat never rendered its reply');
    await new Promise(r=>requestAnimationFrame(r));
  }
  return true;
})()`;

describe("#406 — the reading surfaces at the sizes a reader asks for, in a real engine", () => {
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
    home = mkdtempSync(join(tmpdir(), "glosa-406-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    superviseDaemonHome(home);
    childEnv = buildChildEnv(Bun.env as Record<string, string | undefined>, home);
    chromiumPath = await installedChromium(childEnv);

    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-406-ws-"));
    writeFileSync(join(workspaceRoot, DOC), readingDocument());
    chromeProfile = mkdtempSync(join(tmpdir(), "glosa-406-chrome-profile-"));

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

    // Two saved notes, through the route the composer's Send uses, so the margin has entries with a
    // place on the page.
    for (const exact of NOTED) {
      const noted = await fetch(`http://127.0.0.1:${port}/w/${slug}/annotations`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          artifact_path: DOC,
          body: NOTE_BODY,
          intent: "content",
          target: { quote: { exact, prefix: "", suffix: "" } },
        }),
      });
      expect(noted.status, `annotation: ${await noted.clone().text()}`).toBe(201);
    }
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

  /** One headless Chromium and one page target on it, with its domains enabled. */
  async function launch(): Promise<CdpClient> {
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
        return page;
      }
      await Bun.sleep(100);
    }
    throw new Error("no page target appeared");
  }

  /** Every media preference a measurement here could depend on is pinned, never read from the host:
   * CI's macOS runner reports reduced motion and a local run does not, and the host's scheme decides
   * the palette. Reduced motion also means a card or the composer is where it will stay, not on its
   * way there. `width` and `height` are CSS pixels; `scale` is device pixels per CSS pixel. */
  async function pin(page: CdpClient, { width, height, scale = 1 }: { width: number; height: number; scale?: number }) {
    await page.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-contrast", value: "no-preference" },
      ],
    });
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await page.evaluate(SETTLE);
  }

  /** The document, notes shown, laid out and settled: its words on the page and its notes listed. */
  async function openInReview(page: CdpClient): Promise<void> {
    await page.navigate(
      `http://127.0.0.1:${port}/#${new URLSearchParams({ t: TOKEN, w: slug, a: DOC, mode: "review" })}`,
    );
    await page.evaluate(`(async()=>{const deadline=Date.now()+15000;
      const ready=()=>{const pane=document.querySelector('.glosa-pane[data-mode="review"]');
        return pane&&pane.querySelector('.glosa-content')?.textContent.includes(${JSON.stringify(NOTED[1])})
          &&pane.querySelectorAll('.glosa-annotation').length>=${NOTED.length};};
      while(!ready()){if(Date.now()>deadline) throw new Error('the document and its notes never rendered in Review');
        await new Promise(r=>setTimeout(r,50));}})()`);
    await page.evaluate(SETTLE);
  }

  /** Opens the real composer on the first words of a paragraph in the middle of the document, the way
   * a reader does, and types a draft long enough to wrap. */
  async function openComposer(page: CdpClient): Promise<void> {
    await page.evaluate(`(async()=>{
      const pane=document.querySelector('.glosa-pane');
      const content=pane.querySelector('.glosa-content');
      const paragraph=[...content.querySelectorAll(':scope > p')][4];
      paragraph.scrollIntoView({block:'center'});
      const range=document.createRange();range.setStart(paragraph.firstChild,0);range.setEnd(paragraph.firstChild,18);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      content.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      const deadline=Date.now()+5000;
      while(!pane.querySelector('.glosa-composer-layer .glosa-composer')){
        if(Date.now()>deadline) throw new Error('selecting words in Review did not open the composer');
        await new Promise(r=>requestAnimationFrame(r));
      }
      pane.querySelector('.glosa-composer-input').value='A draft that runs long enough to wrap onto a second and a third line of the composer field.';
    })()`);
    await page.evaluate(SETTLE);
  }

  /** Audits the page at several scroll positions of the document, so a clip or an overlap anywhere
   * in its length is seen, not only on the first screen. */
  async function auditDocument(page: CdpClient): Promise<Audit[]> {
    const audits: Audit[] = [];
    for (const at of [0, 0.35, 0.7, 1]) {
      await page.evaluate(`(()=>{const main=document.querySelector('.glosa-pane-main');
        main.scrollTop=(main.scrollHeight-main.clientHeight)*${at};})()`);
      await page.evaluate(SETTLE);
      audits.push(await page.evaluate<Audit>(AUDIT));
    }
    return audits;
  }

  /** `least` is how many runs of text the surface is known to hold, so an audit that found nothing to
   * check (an empty page, a surface that never rendered) fails instead of passing vacuously. */
  const expectClean = (audit: Audit, where: string, least: number) => {
    expect(audit.checked, `${where}: the audit found text to check`).toBeGreaterThanOrEqual(least);
    expect(audit.sideways, `${where}: the page does not scroll sideways`).toEqual({ document: 0, app: 0 });
    expect(audit.clipped, `${where}: text a box cuts off`).toEqual([]);
    expect(audit.overlapped, `${where}: text painted over text`).toEqual([]);
  };

  test(
    "WCAG 1.4.4: at an effective 200 percent zoom the document, its notes, the composer and the chat reflow, with nothing clipped or overlapped and no sideways page scroll",
    async () => {
      const page = await launch();
      // A 1440 by 900 desk at 200 percent: the same window, half the CSS pixels, each drawn twice.
      await pin(page, { width: 720, height: 450, scale: 2 });
      await openInReview(page);
      for (const [index, audit] of (await auditDocument(page)).entries()) {
        expectClean(audit, `the document at scroll position ${index}`, 40);
      }
      await openComposer(page);
      expectClean(await page.evaluate<Audit>(AUDIT), "the open composer", 40);

      await page.evaluate(mountChat(true));
      await page.evaluate(SETTLE);
      expectClean(await page.evaluate<Audit>(AUDIT), "the chat", 15);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "WCAG 1.4.12: text spacing forced on every element (line height 1.5, paragraphs 2em apart, letters 0.12em, words 0.16em) clips and overlaps nothing in the document, its notes, the composer or the chat",
    async () => {
      const page = await launch();
      // 1440 by 900 at 100 percent: a pane of about 1208px, just wide enough for the note rail, so the
      // spaced-out notes sit beside the spaced-out column they must not cross.
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      expect(await page.evaluate<boolean>(TEXT_SPACING)).toBe(true);
      await page.evaluate(SETTLE);
      const railShown = await page.evaluate<boolean>(
        "Boolean(document.querySelector('.glosa-margin.glosa-margin-side .glosa-annotation'))",
      );
      expect(railShown, "the notes are in the rail beside the column").toBe(true);
      for (const [index, audit] of (await auditDocument(page)).entries()) {
        expectClean(audit, `the spaced document at scroll position ${index}`, 40);
      }
      await openComposer(page);
      expectClean(await page.evaluate<Audit>(AUDIT), "the spaced composer", 40);

      await page.evaluate(mountChat(true));
      expect(await page.evaluate<boolean>(TEXT_SPACING)).toBe(true);
      await page.evaluate(SETTLE);
      expectClean(await page.evaluate<Audit>(AUDIT), "the spaced chat", 15);
    },
    TEST_TIMEOUT_MS,
  );
  /** Every size the document sets, and its line length in its own face, read in one evaluate. */
  const TYPE = `(()=>{
    const pane=document.querySelector('.glosa-pane'),content=pane.querySelector('.glosa-content');
    const read=(selector)=>{const el=content.querySelector(selector),s=getComputedStyle(el);
      return {size:parseFloat(s.fontSize),weight:Number(s.fontWeight)};};
    const zero=document.createElement('span');zero.textContent='0';content.append(zero);
    const ch=zero.getBoundingClientRect().width;zero.remove();
    const root=parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {face:pane.dataset.face??'default',body:read(':scope > p'),h1:read('h1'),h2:read('h2'),h3:read('h3'),
      h4:read('h4'),h5:read('h5'),h6:read('h6'),pre:read('pre'),table:read('table'),th:read('th'),
      leading:parseFloat(getComputedStyle(content).lineHeight)/parseFloat(getComputedStyle(content).fontSize),
      measure:(parseFloat(getComputedStyle(content).maxWidth)-4*root)/ch};
  })()`;

  /** Chooses a face the way a reader does, from the pane's More menu. */
  async function chooseFace(page: CdpClient, face: "default" | "sans" | "mono"): Promise<void> {
    await page.evaluate(`(async()=>{const pane=document.querySelector('.glosa-pane');
      pane.querySelector('.glosa-tools-trigger').click();
      const row=pane.querySelector('.glosa-face-option[data-face="${face}"]');
      if(!row) throw new Error('the More menu has no ${face} row');
      row.click();
      const deadline=Date.now()+3000;
      while((pane.dataset.face??'default')!=='${face}'){if(Date.now()>deadline) throw new Error('the ${face} face never applied');
        await new Promise(r=>requestAnimationFrame(r));}})()`);
    await page.evaluate(SETTLE);
  }

  test(
    "#406: at the default step the document keeps its sizes, sets h4 to h6 at the body's size in 650, and each face keeps its own line length",
    async () => {
      const page = await launch();
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      type Type = Record<
        "body" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "table" | "th",
        { size: number; weight: number }
      > & {
        face: string;
        leading: number;
        measure: number;
      };
      const serif = await page.evaluate<Type>(TYPE);
      // h1 to h3, code and tables keep today's sizes at the default step (the pane is over 800px, so
      // the title and section heading are at their widest).
      expect({
        body: serif.body,
        h1: serif.h1.size,
        h2: serif.h2.size,
        h3: serif.h3.size,
        pre: serif.pre.size,
        table: serif.table.size,
        th: serif.th.size,
      }).toEqual({ body: { size: 18, weight: 400 }, h1: 40, h2: 26, h3: 20, pre: 13, table: 15, th: 13 });
      // h4 to h6 were 17px at 600, smaller than the 18px body they head; now they are the body's size,
      // and 650 keeps them above bold body text, which is 600.
      for (const level of ["h4", "h5", "h6"] as const) expect(serif[level], level).toEqual({ size: 18, weight: 650 });
      expect(serif.leading).toBeCloseTo(1.62, 2);
      expect(serif.measure, "the serif keeps its 68ch line").toBeCloseTo(68, 0);

      await chooseFace(page, "sans");
      const sans = await page.evaluate<Type>(TYPE);
      expect(sans.face).toBe("sans");
      expect(sans.body.size).toBe(16);
      expect(sans.leading).toBeCloseTo(1.6, 2);
      expect(sans.measure, "the sans sets more letters in a ch, so its line is shorter").toBeCloseTo(64, 0);
      expect({ h4: sans.h4, h5: sans.h5, h6: sans.h6 }).toEqual({
        h4: { size: 17, weight: 600 },
        h5: { size: 17, weight: 600 },
        h6: { size: 17, weight: 600 },
      });

      await chooseFace(page, "mono");
      const mono = await page.evaluate<Type>(TYPE);
      expect(mono.face).toBe("mono");
      expect(mono.body.size).toBe(15);
      expect(mono.measure, "mono keeps its 68ch line").toBeCloseTo(68, 0);
      expect(mono.h4).toEqual({ size: 17, weight: 600 });
    },
    TEST_TIMEOUT_MS,
  );
  interface RailState {
    pane: number;
    /** The rail beside the column holds its notes: `.glosa-margin-side`, with cards laid out. */
    rail: boolean;
    body: number;
    column: { left: number; right: number };
    /** The rail's box and every card in it. */
    boxes: Array<{ what: string; left: number; right: number }>;
  }
  const RAIL = `(()=>{
    const pane=document.querySelector('.glosa-pane'),content=pane.querySelector('.glosa-content');
    const margin=pane.querySelector('.glosa-margin'),column=content.getBoundingClientRect();
    const rail=margin.classList.contains('glosa-margin-side');
    const cards=rail?[...margin.querySelectorAll('.glosa-annotation')].filter(c=>c.getBoundingClientRect().width>0):[];
    return {pane:pane.getBoundingClientRect().width,rail:rail&&cards.length>0,body:parseFloat(getComputedStyle(content).fontSize),
      column:{left:column.left,right:column.right},
      boxes:rail?[margin,...cards].map((el)=>{const r=el.getBoundingClientRect();
        return {what:el===margin?'rail':'card '+el.textContent.trim().slice(0,24),left:r.left,right:r.right};}):[]};
  })()`;

  /** What the desk takes beside the pane (the navigator and its rule), measured once per layout. */
  const deskAround = (page: CdpClient) =>
    page.evaluate<number>("innerWidth-document.querySelector('.glosa-pane').getBoundingClientRect().width");

  /** Lays the pane out at `width` CSS pixels by sizing the viewport around it, and waits for the
   * dock to have laid the pane out and the pane's own width observer to have placed the notes. */
  async function paneAt(page: CdpClient, width: number, around: number): Promise<RailState> {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(width + around),
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(`(async()=>{const deadline=Date.now()+5000;
      while(Math.abs(document.querySelector('.glosa-pane').getBoundingClientRect().width-${width})>0.5){
        if(Date.now()>deadline) return;
        await new Promise(r=>requestAnimationFrame(r));}})()`);
    await page.evaluate(SETTLE);
    const state = await page.evaluate<RailState>(RAIL);
    expect(Math.abs(state.pane - width), `the pane is laid out ${width}px wide`).toBeLessThanOrEqual(0.5);
    return state;
  }

  /** The narrowest pane that shows the rail: below it the notes are in the tray. Bisected, then
   * settled by widening one pixel at a time from just below, the way a sash opens a pane, since the
   * pane skips a resize its observer rounds to the width it already had. */
  async function railFloor(page: CdpClient, around: number): Promise<number> {
    let lo = 900;
    let hi = 2400;
    expect((await paneAt(page, lo, around)).rail, `no rail in a ${lo}px pane`).toBe(false);
    expect((await paneAt(page, hi, around)).rail, `a rail in a ${hi}px pane`).toBe(true);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await paneAt(page, mid, around)).rail) hi = mid;
      else lo = mid;
    }
    let width = hi - 4;
    expect((await paneAt(page, width, around)).rail, `no rail in a ${width}px pane, just under the floor`).toBe(false);
    while (!(await paneAt(page, width, around)).rail) {
      width += 1;
      expect(width, "the rail opens within a few pixels of the bisected floor").toBeLessThanOrEqual(hi + 4);
    }
    return width;
  }

  const expectBesideColumn = (state: RailState, where: string) => {
    expect(state.rail, `${where}: the notes are in the rail`).toBe(true);
    for (const box of state.boxes) {
      expect(box.left, `${where}: ${box.what} starts at or after the column's right edge`).toBeGreaterThanOrEqual(
        state.column.right,
      );
    }
  };

  test(
    "#406: the note rail opens only where it fits beside the column as it paints, at the largest step and at a browser default of 20px, and never crosses it",
    async () => {
      const page = await launch();
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      const cases = [
        { browserDefault: 16, step: 24 },
        { browserDefault: 20, step: 18 },
        { browserDefault: 20, step: 24 },
      ];
      for (const { browserDefault, step } of cases) {
        // The step is stored the way the stepper stores it and read back by the page's own first
        // paint, as a reader coming back to the document would find it.
        await page.send("Page.setFontSizes", { fontSizes: { standard: browserDefault, fixed: 13 } });
        await page.evaluate(`localStorage.setItem('glosa_text_size','${step}')`);
        await openInReview(page);
        const around = await deskAround(page);
        const floor = await railFloor(page, around);
        const at = await paneAt(page, floor, around);
        expect(at.rail, `the rail at its floor, ${floor}px`).toBe(true);
        // The browser's default font size carries the step: 24px of text at 16px, 30px at 20px.
        expect(at.body, `the body at step ${step} and a ${browserDefault}px browser default`).toBe(
          (step * browserDefault) / 16,
        );
        for (const width of [floor, floor + 1, floor + 37, floor + 160]) {
          expectBesideColumn(
            await paneAt(page, width, around),
            `a ${width}px pane at step ${step} and a ${browserDefault}px browser default`,
          );
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
  /** A real pointer click at the middle of the first element `selector` matches, through the
   * browser's own input pipeline. */
  async function clickAt(page: CdpClient, selector: string): Promise<void> {
    const at = await page.evaluate<{ x: number; y: number } | null>(`(()=>{
      const el=document.querySelector(${JSON.stringify(selector)});if(!el) return null;
      const r=el.getBoundingClientRect();if(!r.width||!r.height) return null;
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!at) throw new Error(`nothing laid out to click at ${selector}`);
    for (const [type, buttons] of [
      ["mouseMoved", 0],
      ["mousePressed", 1],
      ["mouseReleased", 0],
    ] as const) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
  }

  /** A real key press on whatever has focus. */
  async function press(page: CdpClient, key: string, code: string, windowsVirtualKeyCode: number): Promise<void> {
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await page.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode });
    }
  }

  const PANE_STEPPER = ".glosa-pane .glosa-pane-tools .glosa-text-size";

  /** Opens the document's More menu with a real click, unless it is open. */
  async function openMoreMenu(page: CdpClient): Promise<void> {
    const open = await page.evaluate<boolean>(
      "document.querySelector('.glosa-pane .glosa-pane-tools')?.dataset.open==='true'",
    );
    if (!open) await clickAt(page, ".glosa-pane .glosa-tools-trigger");
    await page.evaluate(`(async()=>{const deadline=Date.now()+3000;
      while(!document.querySelector('${PANE_STEPPER}')?.getBoundingClientRect().width){
        if(Date.now()>deadline) throw new Error('the More menu never showed the text size stepper');
        await new Promise(r=>requestAnimationFrame(r));}})()`);
  }

  interface Reading {
    step: number;
    shown: string;
    body: number;
    h3: number;
    h4: number;
    h5: number;
    h6: number;
    note: number;
    quote: number;
    composer: number;
    composerOpen: boolean;
    chat: { reply: number; person: number; draft: number; code: number };
    tab: { size: number; height: number };
  }
  /** Every size a step moves, and the one chrome label it must not, read in one evaluate. */
  const READING = `(()=>{
    const pane=document.querySelector('.glosa-pane'),content=pane.querySelector('.glosa-content');
    const size=(el)=>el?parseFloat(getComputedStyle(el).fontSize):NaN;
    const tab=document.querySelector('.glosa-tab-label');
    return {step:Number(document.documentElement.dataset.textSize),
      shown:pane.querySelector('.glosa-text-size .glosa-stepper-value')?.textContent??'',
      body:size(content.querySelector(':scope > p')),h3:size(content.querySelector('h3')),h4:size(content.querySelector('h4')),
      h5:size(content.querySelector('h5')),h6:size(content.querySelector('h6')),
      note:size(pane.querySelector('.glosa-annotation-body')),quote:size(pane.querySelector('.glosa-annotation-quote')),
      composer:size(pane.querySelector('.glosa-composer-input')),
      composerOpen:Boolean(pane.querySelector('.glosa-composer-layer .glosa-composer')),
      chat:{reply:size(document.querySelector('.glosa-chat-history .glosa-chat-markdown p')),
        person:size(document.querySelector('.glosa-chat-message[data-kind="human"] .glosa-chat-text')),
        draft:size(document.querySelector('.glosa-chat-draft')),code:size(document.querySelector('.glosa-chat-markdown pre'))},
      tab:{size:size(tab),height:tab.closest('.dv-tab')?.getBoundingClientRect().height??0}};
  })()`;

  /** Where the notes sit, two steps under the document, stopping at 15. */
  const NOTE_UNDER: Record<number, number> = { 15: 15, 16: 15, 18: 15, 20: 16, 22: 18, 24: 20 };
  /** Where the chat sits, one step under the document, stopping at 15. */
  const CHAT_UNDER: Record<number, number> = { 15: 15, 16: 15, 18: 16, 20: 18, 22: 20, 24: 22 };

  test(
    "#406: at every step h3 stays above the body and h4 to h6 never under it, the notes and the composer follow, the chat sits one step under, a tab title does not move, and Settings shows the same step",
    async () => {
      const page = await launch();
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      await page.evaluate(mountChat(false));
      await openComposer(page);
      await openMoreMenu(page);
      const first = await page.evaluate<Reading>(READING);
      expect(first.step, "the default step").toBe(18);

      const expectStep = async (step: number) => {
        await page.evaluate(SETTLE);
        const seen = await page.evaluate<Reading>(READING);
        const where = `at ${step}`;
        expect({ step: seen.step, shown: seen.shown, body: seen.body }, where).toEqual({
          step,
          shown: String(step),
          body: step,
        });
        expect(seen.h3, `${where}: h3 is larger than the body`).toBeGreaterThan(seen.body);
        for (const level of ["h4", "h5", "h6"] as const) {
          expect(seen[level], `${where}: ${level} is not smaller than the body`).toBeGreaterThanOrEqual(seen.body);
        }
        const note = NOTE_UNDER[step] ?? Number.NaN;
        expect(seen.note, `${where}: a note sits two steps under, stopping at 15`).toBe(note);
        expect(seen.quote, `${where}: a note's quote keeps its ratio to the note`).toBeCloseTo((13 * note) / 15, 2);
        expect(seen.composerOpen, `${where}: the draft is still open`).toBe(true);
        expect(seen.composer, `${where}: the composer's field is set as a note`).toBe(note);
        const chat = CHAT_UNDER[step] ?? Number.NaN;
        expect(
          { reply: seen.chat.reply, person: seen.chat.person, draft: seen.chat.draft },
          `${where}: the chat's reply, the person's message and the draft sit one step under, stopping at 15`,
        ).toEqual({ reply: chat, person: chat, draft: chat });
        expect(seen.chat.code, `${where}: a code block in a reply keeps 12px at the default and never goes under`).toBe(
          Math.max(12, (12 * chat) / 16),
        );
        expect(seen.tab, `${where}: a tab title follows zoom, not the step`).toEqual(first.tab);
      };

      await expectStep(18);
      // Down with the pointer to the foot of the ladder, where − stops.
      for (const step of [16, 15]) {
        await clickAt(page, `${PANE_STEPPER} [data-step="down"]`);
        await expectStep(step);
      }
      expect(
        await page.evaluate<boolean>(`document.querySelector('${PANE_STEPPER} [data-step="down"]').disabled`),
        "− is disabled at 15",
      ).toBe(true);
      // In the smaller faces the body stops at its 15px floor; h4 to h6, at the weight of bold text,
      // must still stand above it, and h3 above them.
      for (const face of ["sans", "mono"] as const) {
        await chooseFace(page, face);
        const faced = await page.evaluate<Reading>(READING);
        expect(faced.body, `${face} at 15: the body at its floor`).toBe(15);
        expect(faced.h4, `${face} at 15: h4 stands above the body`).toBeGreaterThan(faced.body);
        expect(faced.h3, `${face} at 15: h3 stands above h4`).toBeGreaterThan(faced.h4);
      }
      await chooseFace(page, "default");
      await openMoreMenu(page);
      // Up with the keyboard, on the spinbutton, to the top, where it stops.
      await page.evaluate(`document.querySelector('${PANE_STEPPER} [role="spinbutton"]').focus()`);
      for (const step of [16, 18, 20, 22, 24]) {
        await press(page, "ArrowUp", "ArrowUp", 38);
        await expectStep(step);
      }
      await press(page, "ArrowUp", "ArrowUp", 38);
      await expectStep(24);
      expect(
        await page.evaluate<boolean>(`document.querySelector('${PANE_STEPPER} [data-step="up"]').disabled`),
        "+ is disabled at 24",
      ).toBe(true);

      // Settings > Appearance mirrors the same step, and a change there is the document's too.
      await clickAt(page, ".glosa-sidebar-settings");
      await page.evaluate(`(async()=>{const deadline=Date.now()+5000;let nav;
        while(!(nav=[...document.querySelectorAll('.glosa-settings-nav button')].find(b=>b.textContent==='Appearance'))){
          if(Date.now()>deadline) throw new Error('Settings never opened');await new Promise(r=>setTimeout(r,50));}
        nav.click();})()`);
      const SETTINGS_STEPPER = '.glosa-text-size[data-variant="settings"]';
      await page.evaluate(SETTLE);
      expect(
        await page.evaluate<string>(`document.querySelector('${SETTINGS_STEPPER} [role="spinbutton"]').textContent`),
      ).toBe("24");
      await clickAt(page, `${SETTINGS_STEPPER} .glosa-text-size-reset`);
      await page.evaluate(SETTLE);
      expect(
        await page.evaluate<{ step: string; settings: string; menu: string; reset: boolean }>(`({
          step:document.documentElement.dataset.textSize,
          settings:document.querySelector('${SETTINGS_STEPPER} [role="spinbutton"]').textContent,
          menu:document.querySelector('${PANE_STEPPER} [role="spinbutton"]').textContent,
          reset:!document.querySelector('${SETTINGS_STEPPER} .glosa-text-size-reset').hidden})`),
        "Reset in Settings brings the page, and the More menu's stepper, back to 18",
      ).toEqual({ step: "18", settings: "18", menu: "18", reset: false });
    },
    TEST_TIMEOUT_MS,
  );
  interface TopBlock {
    index: number;
    text: string;
    /** How much of the block has scrolled past the pane's top edge. */
    fraction: number;
    scrollTop: number;
  }
  /** The first block of the document still showing at the top of the pane. */
  const TOP_BLOCK = `(()=>{const main=document.querySelector('.glosa-pane-main'),top=main.getBoundingClientRect().top;
    const blocks=[...document.querySelector('.glosa-pane .glosa-content').children];
    for(const [index,block] of blocks.entries()){const r=block.getBoundingClientRect();
      if(r.height<=0||r.bottom<=top+1) continue;
      return {index,text:block.textContent.trim().slice(0,48),fraction:r.top<top?(top-r.top)/r.height:0,scrollTop:main.scrollTop};}
    return null;})()`;

  test(
    "#406: a new text size keeps the block at the top of the pane where the reader left it, with and without the engine's own scroll anchoring",
    async () => {
      const page = await launch();
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      await openMoreMenu(page);
      for (const engineAnchors of [true, false]) {
        if (!engineAnchors) {
          // Safari has no CSS scroll anchoring. With Chromium's own switched off, only the pane's
          // anchoring can hold the reader's place.
          await page.evaluate(`(()=>{const style=document.createElement('style');
            style.textContent='.glosa-pane-main{overflow-anchor:none!important}';document.head.append(style);})()`);
        }
        // Forty percent of a paragraph halfway down the document has scrolled past the top edge.
        await page.evaluate(`(()=>{const main=document.querySelector('.glosa-pane-main');
          const block=[...document.querySelectorAll('.glosa-pane .glosa-content > p')][12];
          const r=block.getBoundingClientRect(),top=main.getBoundingClientRect().top;
          main.scrollTop+=r.top-top+r.height*0.4;})()`);
        await page.evaluate(SETTLE);
        const before = await page.evaluate<TopBlock>(TOP_BLOCK);
        expect(before.fraction, "the reader is part way into a paragraph").toBeGreaterThan(0.3);
        await page.evaluate(`document.querySelector('${PANE_STEPPER} [role="spinbutton"]').focus()`);
        for (const [key, code, keyCode] of [
          ["ArrowUp", "ArrowUp", 38],
          ["ArrowUp", "ArrowUp", 38],
          ["ArrowDown", "ArrowDown", 40],
          ["Home", "Home", 36],
        ] as const) {
          await press(page, key, code, keyCode);
          await page.evaluate(SETTLE);
          const after = await page.evaluate<TopBlock>(TOP_BLOCK);
          const where = `after ${key} to ${await page.evaluate<string>("document.documentElement.dataset.textSize")}, ${
            engineAnchors ? "with" : "without"
          } the engine's anchoring`;
          expect(after.text, `${where}: the same block is at the top`).toBe(before.text);
          expect(after.fraction, `${where}: as far into it as before`).toBeCloseTo(before.fraction, 1);
        }
        // The next pass starts on a fresh page at the default step.
        await page.evaluate(`localStorage.removeItem('glosa_text_size')`);
        await openInReview(page);
        await openMoreMenu(page);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
