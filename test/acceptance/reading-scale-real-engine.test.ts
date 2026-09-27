// SPDX-License-Identifier: Apache-2.0
// #406 — the reading surfaces at the sizes a reader asks for, in a real engine. #407 — the styles a
// document is set in (Editorial, Spec, Mono) and a folder's default style, in the same engine.
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
//   * #407: one synthetic document holding every element, set in each style at two steps, measured
//     against the style table (face, sizes, weights, leading, margins, the painted line), with Spec's
//     wide table and code block widening past the prose line and never under the note rail; and a
//     folder default set from one window's More menu reaching another window without a reload.
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

/** #407: one document with every element a style sets. The narrow table stays on the prose line in
 * every style; the wide table and the code block are wider than it, so Spec can widen them. */
const STYLES_DOC = "styles.md";
const STYLES_NOTED = "the gap between blocks are all measured";
function stylesDocument(): string {
  return [
    "# Styles, set out in full",
    "",
    "The opening paragraph runs long enough to wrap across several lines at every size, so its line length and its leading can both be read off the page, and it carries `inline code` the way a specification names a file or a flag in passing, which is the case a style has to set well.",
    "",
    "## A section heading",
    "",
    `A paragraph under the section heading, long enough to wrap too, so the space above and below the heading and ${STYLES_NOTED} against real text rather than a single line.`,
    "",
    "### A subhead",
    "",
    "- A first item in a list",
    "- A second item, rather longer, so that it wraps onto a second line at the larger sizes",
    "",
    "#### A fourth-level heading",
    "",
    "Text under the fourth-level heading.",
    "",
    "##### A fifth-level heading",
    "",
    "Text under the fifth-level heading.",
    "",
    "###### A sixth-level heading",
    "",
    "Text under the sixth-level heading, then three tables and a code block.",
    "",
    "| Term | Meaning |",
    "| --- | --- |",
    "| Style | A document's dress |",
    "| Step | One rung of the ladder |",
    "",
    "| Requirement | Owner | State | What it needs before it can be closed, written out at length so the table is wider than the prose line |",
    "| --- | --- | --- | --- |",
    "| R-1: the folder default is kept beside the folder | daemon | done | A route that names the workspace by slug and never by path, written atomically at mode 0600 |",
    "| R-2: every window on the folder follows a change | spa | open | A stream invalidation, read again through the one data-access module, with no reload |",
    "",
    "| Digest | Note |",
    "| --- | --- |",
    `| ${"0123456789abcdef".repeat(8)} | one word too long to wrap, wider than any lane |`,
    "",
    "```",
    'const style = resolveStyle(document.own, folder.default) ?? "editorial"; // a line long enough to widen the block past the prose line',
    "```",
    "",
    "A closing paragraph after the code block, so the block has a gap on both sides.",
    "",
  ].join("\n");
}

/** Where `GLOSA_SHOTS_DIR` names a directory, the #407 tests save what they measured there as PNGs
 * for review. Unset (CI), they save nothing. */
const SHOTS_DIR = Bun.env.GLOSA_SHOTS_DIR ?? "";

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
    chat:'.glosa-chat-history',draft:'.glosa-chat-composer',decision:'.glosa-chat-decision'};
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

interface ChatFixture {
  reply: string;
  person: string;
  draft: string;
  /** Decisions waiting on the person, in the shape the daemon's chat store keeps them. */
  decisions?: unknown[];
}
/** A reply with a heading, a list, a code block and a link, a question from the person and a draft. */
const CHAT_FIXTURE: ChatFixture = {
  reply:
    "The outline holds, with one gap. **The second section** promises a comparison it never makes.\n\n### What to change\n\n- Name the two options before weighing them.\n- Move the example with a long path, `packages/spa/src/chat-pane.js`, into its own paragraph.\n\n```\nconst unchanged = true; // a code line long enough to need its own sideways scroll inside the block\n```\n\nRead [the outline guide](https://example.com/guide) before revising.",
  person: "Review my outline, and say where the argument is weakest.",
  draft: "A draft that runs long enough to wrap across two lines of the composer before it is sent.",
};

/** A chat mounted from the production module with a scripted transport. `alone` replaces the page's
 * body, so an audit measures the chat alone; `hidden` lays it out of the way, unseen, beside the
 * document, for its sizes to be read; `beside` narrows the desk by `width` and shows the chat in the
 * room that leaves, as a chat docked beside the document is seen. */
const mountChat = (
  where: "alone" | "hidden" | "beside",
  fixture: ChatFixture = CHAT_FIXTURE,
  width = 640,
) => `(async()=>{
  const { createChatPane } = await import('/app/chat-pane.js');
  const fixture=${JSON.stringify(fixture)},where=${JSON.stringify(where)};
  const host=document.createElement('main');
  if(where==='alone'){host.style.cssText='height:100vh;width:100%;padding:12px;box-sizing:border-box';document.body.replaceChildren(host);}
  else if(where==='hidden'){host.style.cssText='position:fixed;left:0;bottom:0;height:420px;width:640px;visibility:hidden;pointer-events:none';document.body.append(host);}
  else{document.getElementById('app').style.width='calc(100% - ${width}px)';
    host.style.cssText='position:fixed;right:0;top:0;height:100vh;width:${width}px;border-left:1px solid var(--rule)';
    document.body.append(host);}
  const state={id:'fixture',profileId:'a',provider:'claude-code',title:'Review the outline',revision:1,configRevision:1,draftRevision:0,
    draft:fixture.draft,draftAttachments:[],archived:false,
    settings:{model:'model',effort:'high',permissionMode:'default'},
    turns:[{id:'first',text:fixture.person,status:'completed'}],
    content:[{id:'reply',turnId:'first',kind:'text',role:'assistant',text:fixture.reply}],
    decisions:(fixture.decisions??[]).map(d=>({...d,expiresAt:new Date(Date.now()+9*60000).toISOString()}))};
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
    writeFileSync(join(workspaceRoot, STYLES_DOC), stylesDocument());
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
    // #407: one note on the styles document, so Review has a rail for Spec's wide blocks to keep clear of.
    const styled = await fetch(`http://127.0.0.1:${port}/w/${slug}/annotations`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        artifact_path: STYLES_DOC,
        body: NOTE_BODY,
        intent: "content",
        target: { quote: { exact: STYLES_NOTED, prefix: "", suffix: "" } },
      }),
    });
    expect(styled.status, `annotation: ${await styled.clone().text()}`).toBe(201);
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    browserTarget = null;
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
    browserTarget = { browser, cdpPort };
    return openPage();
  }

  /** The browser `launch` started, so a test can open a second window on it. */
  let browserTarget: { browser: CdpClient; cdpPort: number } | null = null;

  /** One more page target on the launched browser, with its domains enabled. A second window opens
   * in a window of its own: as a tab it would hide the first, and a hidden page draws no frames. */
  async function openPage({ newWindow = false } = {}): Promise<CdpClient> {
    if (!browserTarget) throw new Error("launch() first");
    const { browser, cdpPort } = browserTarget;
    const created = await browser.send("Target.createTarget", { url: "about:blank", newWindow });
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

  /** What the desk holds, for a failure message: each pane's mode and width, the tabs, the window. */
  const DESK = `JSON.stringify({panes:[...document.querySelectorAll('.glosa-pane')].map(p=>({mode:p.dataset.mode,
    width:Math.round(p.getBoundingClientRect().width)})),tabs:document.querySelectorAll('.dv-tab').length,window:innerWidth})`;

  /** The document, notes shown, laid out and settled: its words on the page, its notes listed, and
   * the desk done laying out, with the document as its only pane and that pane's width unchanged for
   * five frames. Every query below reads the first `.glosa-pane`, and the rail's measurements take
   * the desk around it from the pane's width, so a pane read before the desk has placed it (a
   * layout restored on reload, a group still settling) would mislead every measurement after it. */
  async function openInReview(page: CdpClient): Promise<void> {
    await page.navigate(
      `http://127.0.0.1:${port}/#${new URLSearchParams({ t: TOKEN, w: slug, a: DOC, mode: "review" })}`,
    );
    await page.evaluate(`(async()=>{const deadline=Date.now()+15000;
      const ready=()=>{const pane=document.querySelector('.glosa-pane[data-mode="review"]');
        return pane&&pane.querySelector('.glosa-content')?.textContent.includes(${JSON.stringify(NOTED[1])})
          &&pane.querySelectorAll('.glosa-annotation').length>=${NOTED.length};};
      while(!ready()){if(Date.now()>deadline) throw new Error('the document and its notes never rendered in Review');
        await new Promise(r=>setTimeout(r,50));}
      let last=-1,still=0;
      while(still<5){
        if(Date.now()>deadline) throw new Error('the desk never settled on the document alone: '+${DESK});
        await new Promise(r=>requestAnimationFrame(r));
        const panes=document.querySelectorAll('.glosa-pane');
        const width=panes.length===1&&panes[0].dataset.mode==='review'?panes[0].getBoundingClientRect().width:0;
        still=width>0&&width===last?still+1:0;last=width;}})()`);
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

      await page.evaluate(mountChat("alone"));
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

      await page.evaluate(mountChat("alone"));
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
    return {style:pane.dataset.style,body:read(':scope > p'),h1:read('h1'),h2:read('h2'),h3:read('h3'),
      h4:read('h4'),h5:read('h5'),h6:read('h6'),pre:read('pre'),table:read('table'),th:read('th'),
      leading:parseFloat(getComputedStyle(content).lineHeight)/parseFloat(getComputedStyle(content).fontSize),
      measure:(parseFloat(getComputedStyle(content).maxWidth)-4*root)/ch};
  })()`;

  /** Chooses a style the way a reader does, from the pane's More menu. */
  async function chooseStyle(page: CdpClient, style: "editorial" | "spec" | "mono"): Promise<void> {
    await page.evaluate(`(async()=>{const pane=document.querySelector('.glosa-pane');
      pane.querySelector('.glosa-tools-trigger').click();
      const row=pane.querySelector('.glosa-style-option[data-style="${style}"]');
      if(!row) throw new Error('the More menu has no ${style} row');
      row.click();
      const deadline=Date.now()+3000;
      while(pane.dataset.style!=='${style}'){if(Date.now()>deadline) throw new Error('the ${style} style never applied');
        await new Promise(r=>requestAnimationFrame(r));}})()`);
    await page.evaluate(SETTLE);
  }

  test(
    "#406: at the default step the document keeps its sizes, sets h4 to h6 at the body's size in 650, and each style keeps its own line length",
    async () => {
      const page = await launch();
      await pin(page, { width: 1440, height: 900 });
      await openInReview(page);
      type Type = Record<
        "body" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "table" | "th",
        { size: number; weight: number }
      > & {
        style: string;
        leading: number;
        measure: number;
      };
      const serif = await page.evaluate<Type>(TYPE);
      expect(serif.style, "a document with no style of its own and no folder default is Editorial").toBe("editorial");
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

      // #407: the Sans face became the Spec style, 1.5 leading and 650 on every heading, h5 and h6 at
      // the body's size. The #407 test below holds the rest of the style's values.
      await chooseStyle(page, "spec");
      const sans = await page.evaluate<Type>(TYPE);
      expect(sans.style).toBe("spec");
      expect(sans.body.size).toBe(16);
      expect(sans.leading).toBeCloseTo(1.5, 2);
      expect(sans.measure, "the sans sets more letters in a ch, so its line is shorter").toBeCloseTo(64, 0);
      expect({ h4: sans.h4, h5: sans.h5, h6: sans.h6 }).toEqual({
        h4: { size: 17, weight: 650 },
        h5: { size: 16, weight: 650 },
        h6: { size: 16, weight: 650 },
      });

      await chooseStyle(page, "mono");
      const mono = await page.evaluate<Type>(TYPE);
      expect(mono.style).toBe("mono");
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
        if(Date.now()>deadline) throw new Error('the More menu never showed the text size stepper: '+JSON.stringify({
          open:document.querySelector('.glosa-pane .glosa-pane-tools')?.dataset.open??null,
          stepper:Boolean(document.querySelector('${PANE_STEPPER}')),focus:document.activeElement?.className??null,
          desk:JSON.parse(${DESK})}));
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
      await page.evaluate(mountChat("hidden"));
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
        // #408 restates #406's 12px: a code block in a reply keeps the page's relation to its text,
        // 13px beside a 16px reply, and still never goes under 12.
        expect(
          seen.chat.code,
          `${where}: a code block in a reply is 13px at the default and never goes under 12`,
        ).toBeCloseTo(Math.max(12, (13 * chat) / 16), 2);
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
      // In the smaller styles the body stops at its 15px floor; h4 keeps its sixteenth above it (in
      // Mono at the weight of bold text, where only size can lift it), and h3 stands above h4.
      for (const style of ["spec", "mono"] as const) {
        await chooseStyle(page, style);
        const styled = await page.evaluate<Reading>(READING);
        expect(styled.body, `${style} at 15: the body at its floor`).toBe(15);
        expect(styled.h4, `${style} at 15: h4 stands above the body`).toBeGreaterThan(styled.body);
        expect(styled.h3, `${style} at 15: h3 stands above h4`).toBeGreaterThan(styled.h4);
      }
      await chooseStyle(page, "editorial");
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

  // ---------- #407: styles and the folder default ----------

  /** The pane showing the document whose words include `text`, as a page expression. A second window
   * on the workspace may restore another document's tab beside it, so "the first pane" will not do. */
  const paneOf = (text: string) =>
    `[...document.querySelectorAll('.glosa-pane')].find(p=>p.getBoundingClientRect().width>0&&p.querySelector('.glosa-content')?.textContent.includes(${JSON.stringify(text)}))`;

  /** Opens `doc` in Review and waits, as openInReview does, for its words and notes and then for the
   * desk to settle: the pane showing it holds the same width for five frames. */
  async function openDocument(
    page: CdpClient,
    doc: string,
    text: string,
    notes: number,
    mode: "review" | "edit" = "review",
  ): Promise<void> {
    await page.navigate(`http://127.0.0.1:${port}/#${new URLSearchParams({ t: TOKEN, w: slug, a: doc, mode })}`);
    await page.evaluate(`(async()=>{const deadline=Date.now()+15000;
      const pane=()=>${paneOf(text)};
      const ready=()=>{const p=pane();return p&&p.dataset.mode==='${mode}'&&p.querySelectorAll('.glosa-annotation').length>=${notes};};
      while(!ready()){if(Date.now()>deadline) throw new Error('${doc} and its notes never rendered in ${mode}: '+${DESK});
        await new Promise(r=>setTimeout(r,50));}
      let last=-1,still=0;
      while(still<5){
        if(Date.now()>deadline) throw new Error('the desk never settled on ${doc}: '+${DESK});
        await new Promise(r=>requestAnimationFrame(r));
        const width=pane()?.getBoundingClientRect().width??0;
        still=width>0&&width===last?still+1:0;last=width;}})()`);
    await page.evaluate(SETTLE);
  }

  /** Chooses a style for the document whose words include `text`, from its pane's More menu. */
  async function chooseStyleOf(page: CdpClient, text: string, style: "editorial" | "spec" | "mono"): Promise<void> {
    await page.evaluate(`(async()=>{const pane=${paneOf(text)};
      if(pane.querySelector('.glosa-pane-tools').dataset.open!=='true') pane.querySelector('.glosa-tools-trigger').click();
      const row=pane.querySelector('.glosa-style-option[data-style="${style}"]');
      if(!row) throw new Error('the More menu has no ${style} row');
      row.click();
      const deadline=Date.now()+3000;
      while(pane.dataset.style!=='${style}'){if(Date.now()>deadline) throw new Error('the ${style} style never applied');
        await new Promise(r=>requestAnimationFrame(r));}})()`);
    await page.evaluate(SETTLE);
  }

  /** Pins the colour scheme the way `pin` pins everything, with motion and contrast still pinned. */
  async function scheme(page: CdpClient, value: "light" | "dark"): Promise<void> {
    await page.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value },
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-contrast", value: "no-preference" },
      ],
    });
    await page.evaluate(SETTLE);
  }

  /** Saves what the page shows, when `GLOSA_SHOTS_DIR` asks for it. `selector` crops to an element
   * with `pad` pixels of context around it. */
  async function shot(page: CdpClient, name: string, selector?: string, pad = 24): Promise<void> {
    if (!SHOTS_DIR) return;
    const clip = selector
      ? await page.evaluate<{ x: number; y: number; width: number; height: number }>(`(()=>{
          const r=(${selector}).getBoundingClientRect();
          const x=Math.max(0,r.left-${pad}),y=Math.max(0,r.top-${pad});
          return {x,y,width:Math.min(innerWidth-x,r.width+2*${pad}),height:Math.min(innerHeight-y,r.height+2*${pad})};})()`)
      : undefined;
    const res = await page.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(join(SHOTS_DIR, `${name}.png`), Buffer.from(res.result.data, "base64"));
  }

  interface Box {
    family: string;
    size: number;
    weight: number;
    leading: number;
    top: number;
    bottom: number;
  }
  interface StyleReading {
    style: string;
    step: number;
    ch: number;
    loaded: boolean;
    body: Box;
    h1: Box;
    h2: Box;
    h3: Box;
    h4: Box;
    h5: Box;
    h6: Box;
    table: Box;
    th: Box;
    cell: { top: number; left: number };
    code: Box;
    pre: Box;
    /** The column's text width, the first paragraph's box, and the widest line painted in it. */
    line: { column: number; paragraph: number; widest: number };
    column: { left: number; right: number };
    narrow: { left: number; right: number; width: number };
    wide: { left: number; right: number; width: number };
    /** A table with a word too long for any lane, which its cell breaks. */
    oversize: { left: number; right: number; width: number };
    /** The right edge of the rightmost table cell on the page, and of what the pane shows. */
    cells: number;
    visible: number;
    /** Spec's wide lane beyond the line, as the page resolved `--wide-extra`: 0 in other styles. */
    extra: number;
    /** Each table's `data-fit` mark, in document order. */
    fit: Array<string | null>;
    /** Words split across two lines in the cells of every table that is not marked to break words. A
     * hyphen is a place a line may break, so the parts either side of one count as words. */
    split: string[];
    /** The pane's inline size (what `cqi` measures) and the column's painted width it lays out around. */
    pane: { inline: number; block: number };
    block: { left: number; right: number; width: number };
    /** The left edge of every note card in the rail beside the column, when there is a rail. */
    rail: number[];
    sideways: number;
  }
  /** Everything a style sets in the styles document, read in one evaluate. */
  const STYLE_READING = `(()=>{
    const pane=${paneOf(STYLES_NOTED)},content=pane.querySelector('.glosa-content');
    const q=(selector)=>content.querySelector(selector);
    const box=(el)=>{const s=getComputedStyle(el),size=parseFloat(s.fontSize);
      return {family:s.fontFamily.split(',')[0].replace(/["']/g,'').trim(),size,weight:Number(s.fontWeight),
        leading:parseFloat(s.lineHeight)/size,top:parseFloat(s.marginTop),bottom:parseFloat(s.marginBottom)};};
    const zero=document.createElement('span');zero.textContent='0';content.append(zero);
    const ch=zero.getBoundingClientRect().width;zero.remove();
    const first=q(':scope > p'),range=document.createRange();range.selectNodeContents(first);
    const rights=new Map();for(const r of range.getClientRects()){if(r.width<1) continue;
      const top=Math.round(r.top);rights.set(top,Math.max(rights.get(top)??-Infinity,r.right));}
    const left=first.getBoundingClientRect().left;
    const cs=getComputedStyle(content),col=content.getBoundingClientRect();
    const column={left:col.left+parseFloat(cs.paddingLeft),right:col.right-parseFloat(cs.paddingRight)};
    const rect=(el)=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
    const [narrow,wide,oversize]=[...content.querySelectorAll(':scope > table')];
    const ps=getComputedStyle(pane),pr=pane.getBoundingClientRect(),main=pane.querySelector('.glosa-pane-main');
    const cell=getComputedStyle(wide.querySelector('td:nth-child(2)'));
    return {style:pane.dataset.style,step:Number(document.documentElement.dataset.textSize),ch,
      loaded:document.fonts.check('16px "Source Serif 4"')&&document.fonts.check('16px "Source Sans 3"'),
      body:box(first),h1:box(q('h1')),h2:box(q('h2')),h3:box(q('h3')),h4:box(q('h4')),h5:box(q('h5')),h6:box(q('h6')),
      table:box(wide),th:box(wide.querySelector('th')),cell:{top:parseFloat(cell.paddingTop),left:parseFloat(cell.paddingLeft)},
      code:box(first.querySelector('code')),pre:box(q(':scope > pre')),
      line:{column:column.right-column.left,paragraph:first.clientWidth,widest:Math.max(...[...rights.values()].map(r=>r-left))},
      column,narrow:rect(narrow),wide:rect(wide),oversize:rect(oversize),block:rect(q(':scope > pre')),
      cells:Math.max(...[...content.querySelectorAll('th,td')].map(c=>c.getBoundingClientRect().right)),
      visible:main.getBoundingClientRect().left+main.clientWidth,
      extra:parseFloat(getComputedStyle(content).getPropertyValue('--wide-extra'))||0,
      fit:[...content.querySelectorAll(':scope > table')].map(t=>t.getAttribute('data-fit')),
      split:[...content.querySelectorAll(':scope > table:not([data-fit]) :is(th,td)')].flatMap(cell=>{
        const out=[],walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
        for(let node=walk.nextNode();node;node=walk.nextNode()) for(const m of node.data.matchAll(/[^\\s-]+/g)){
          const r=document.createRange();r.setStart(node,m.index);r.setEnd(node,m.index+m[0].length);
          if(new Set([...r.getClientRects()].filter(x=>x.width>0).map(x=>Math.round(x.top))).size>1) out.push(m[0]);}
        return out;}),
      pane:{inline:pr.width-parseFloat(ps.paddingLeft)-parseFloat(ps.paddingRight)-parseFloat(ps.borderLeftWidth)-parseFloat(ps.borderRightWidth),
        block:parseFloat(pane.style.getPropertyValue('--manuscript-block'))},
      rail:[...pane.querySelectorAll('.glosa-margin.glosa-margin-side .glosa-annotation')].map(c=>c.getBoundingClientRect().left),
      sideways:document.scrollingElement.scrollWidth-document.scrollingElement.clientWidth};
  })()`;

  type StyleName = "editorial" | "spec" | "mono";
  type Expected = Record<
    "body" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "table" | "th" | "code" | "pre",
    Partial<Box>
  > & {
    measure: number;
    gap: number;
    cell: { top: number; left: number };
  };

  /** The style table of #407, on the reading scale: every value at the default step times the step
   * over 18, each stopping at its floor (no body under 15px, no table under 13px, no code block or
   * table head under 12px). Margins stay rem. The pane is over 800px wide, so Editorial's title and
   * section heading are at their largest. */
  function styleTable(style: StyleName, step: number): Expected {
    const s = step / 18;
    const serif = "Source Serif 4";
    const sans = "Source Sans 3";
    const mono = "ui-monospace";
    if (style === "spec") {
      const body = Math.max(15, 16 * s);
      const minor = { weight: 650, leading: 1.35, top: 24, bottom: 6 };
      return {
        measure: 64,
        gap: body,
        body: { family: sans, size: body, weight: 400, leading: 1.5 },
        h1: { family: sans, size: 32 * s, weight: 650, leading: 1.2, top: 0, bottom: 24 },
        h2: { size: 24 * s, weight: 650, leading: 1.25, top: 36, bottom: 8 },
        h3: { size: 20 * s, weight: 650, leading: 1.3, top: 28, bottom: 8 },
        h4: { size: Math.max(1.0625 * body, 17 * s), ...minor },
        h5: { size: Math.max(body, 16 * s), ...minor },
        h6: { size: Math.max(body, 16 * s), ...minor },
        table: { family: sans, size: body },
        th: { size: body, weight: 650 },
        cell: { top: 0.5 * body, left: 0.75 * body },
        code: { family: mono, size: 0.9 * body },
        pre: { family: mono, size: Math.max(12, 14 * s), leading: 1.5 },
      };
    }
    const body = style === "mono" ? Math.max(15, 15 * s) : 18 * s;
    const minor =
      style === "mono"
        ? { size: Math.max(1.0625 * body, 17 * s), weight: 600, leading: 1.4, top: 24, bottom: 8 }
        : { size: Math.max(body, 17 * s), weight: 650, leading: 1.4, top: 24, bottom: 8 };
    return {
      measure: 68,
      gap: 1.2 * body,
      body: {
        family: style === "mono" ? mono : serif,
        size: body,
        weight: 400,
        leading: style === "mono" ? 1.65 : 1.62,
      },
      h1: { family: style === "mono" ? mono : serif, size: 40 * s, weight: 650, leading: 1.1, top: 0, bottom: 32 },
      h2: { size: 26 * s, weight: 620, leading: 1.25, top: 48, bottom: 12 },
      h3: { size: 20 * s, weight: 620, leading: 1.3, top: 32, bottom: 8 },
      h4: minor,
      h5: minor,
      h6: minor,
      table: { family: sans, size: Math.max(13, 15 * s) },
      th: { size: Math.max(12, 13 * s), weight: 600 },
      cell: { top: 8, left: 12 },
      code: { family: mono, size: 0.85 * body },
      pre: { family: mono, size: Math.max(12, 13 * s), leading: 1.6 },
    };
  }

  const round = (value: number) => Math.round(value * 100) / 100;
  /** The measured values the table names, rounded to hundredths, for one diff per style and step. */
  function pick(seen: StyleReading, expected: Expected) {
    const out: Record<string, unknown> = {};
    for (const key of ["body", "h1", "h2", "h3", "h4", "h5", "h6", "table", "th", "code", "pre"] as const) {
      const want = expected[key];
      const got = seen[key];
      out[key] = Object.fromEntries(
        Object.keys(want).map((field) => {
          const value = got[field as keyof Box];
          return [field, typeof value === "number" ? round(value) : value];
        }),
      );
    }
    return {
      ...out,
      gap: round(seen.body.bottom),
      cell: { top: round(seen.cell.top), left: round(seen.cell.left) },
    };
  }
  function want(expected: Expected) {
    const out: Record<string, unknown> = {};
    for (const key of ["body", "h1", "h2", "h3", "h4", "h5", "h6", "table", "th", "code", "pre"] as const) {
      out[key] = Object.fromEntries(
        Object.entries(expected[key]).map(([field, value]) => [
          field,
          typeof value === "number" ? round(value) : value,
        ]),
      );
    }
    return {
      ...out,
      gap: round(expected.gap),
      cell: { top: round(expected.cell.top), left: round(expected.cell.left) },
    };
  }

  test(
    "#407: each style sets every element of one document to its table at the default step and at 22, Spec's wide table and code block widen past its line to about 96ch and never under the note rail, keep that place when edited in place, and the others stay on the line",
    async () => {
      const page = await launch();
      await pin(page, { width: 1920, height: 1200 });
      for (const step of [18, 22]) {
        if (step !== 18) await page.evaluate(`localStorage.setItem('glosa_text_size','${step}')`);
        await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
        for (const style of ["editorial", "spec", "mono"] as const) {
          await chooseStyleOf(page, STYLES_NOTED, style);
          // A reload reads the style back from where the menu stored it, before the page paints.
          await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
          const seen = await page.evaluate<StyleReading>(STYLE_READING);
          const where = `${style} at ${step}`;
          expect({ style: seen.style, step: seen.step, loaded: seen.loaded }, where).toEqual({
            style,
            step,
            loaded: true,
          });
          const table = styleTable(style, step);
          expect(pick(seen, table), `${where}: the style table`).toEqual(want(table));
          // The line length in characters of the body's own face. Measured against a rendered "0",
          // which a variable face's optical size can set a hair wider than the `ch` the CSS resolved.
          expect(
            Math.abs(seen.line.column / seen.ch - table.measure),
            `${where}: a ${table.measure}ch line`,
          ).toBeLessThan(0.2);
          // The line as it paints: the paragraph fills the column, and its longest line reaches within
          // a word of the column's edge without crossing it.
          expect(
            Math.abs(seen.line.paragraph - seen.line.column),
            `${where}: the paragraph is the column's width`,
          ).toBeLessThan(1);
          expect(seen.line.widest, `${where}: no line runs past the column`).toBeLessThanOrEqual(
            seen.line.column + 0.5,
          );
          expect(seen.line.widest, `${where}: the longest line fills the column`).toBeGreaterThan(
            seen.line.column * 0.85,
          );
          expect(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
          expect(seen.cells, `${where}: every table cell ends inside what the pane shows`).toBeLessThanOrEqual(
            seen.visible + 0.5,
          );
          // Only the table with a word too long for any column breaks words; the others keep theirs.
          expect(seen.fit, `${where}: only the digest table is marked to break words`).toEqual([null, null, "break"]);
          expect(seen.split, `${where}: no word breaks in the other tables`).toEqual([]);
          // A narrow table stays at its own width on the prose's left edge in every style.
          expect(seen.narrow.width, `${where}: the narrow table keeps its own width`).toBeLessThan(seen.line.column);
          expect(
            Math.abs(seen.narrow.left - seen.column.left),
            `${where}: the narrow table on the prose edge`,
          ).toBeLessThan(0.5);
          const centre = (seen.column.left + seen.column.right) / 2;
          if (style === "spec") {
            // A 1920px desk leaves room beyond a full rail, so both widen to Spec's cap, centred on the
            // column, and stop short of the rail's cards.
            for (const [what, block] of [
              ["the wide table", seen.wide],
              ["the code block", seen.block],
            ] as const) {
              expect(block.width, `${where}: ${what} widens past the line`).toBeGreaterThan(seen.line.column + 1);
              expect(Math.abs(block.width - 96 * seen.ch), `${where}: ${what} stops near 96ch`).toBeLessThan(1.5);
              expect(Math.abs((block.left + block.right) / 2 - centre), `${where}: ${what} is centred`).toBeLessThan(1);
            }
            expect(seen.rail.length, `${where}: the note is in the rail`).toBeGreaterThan(0);
            for (const left of seen.rail) {
              expect(left, `${where}: a rail card starts right of the wide blocks`).toBeGreaterThanOrEqual(
                Math.max(seen.wide.right, seen.block.right),
              );
            }
            // A word too long for the lane breaks inside its cell, so the table fits the lane: it
            // starts at the lane's left edge and ends at or inside its right edge.
            const lane = { left: seen.column.left - seen.extra / 2, right: seen.column.right + seen.extra / 2 };
            expect(Math.abs(seen.extra - 32 * seen.ch), `${where}: the lane is 32ch past the line`).toBeLessThan(1);
            expect(seen.oversize.left, `${where}: the digest table starts at the lane's left edge`).toBeGreaterThan(
              lane.left - 0.5,
            );
            expect(seen.oversize.right, `${where}: the digest table fits the lane`).toBeLessThanOrEqual(
              lane.right + 0.5,
            );
          } else {
            expect(seen.wide.width, `${where}: the wide table stays on the line`).toBeLessThanOrEqual(
              seen.line.column + 0.5,
            );
            expect(
              Math.abs(seen.wide.left - seen.column.left),
              `${where}: the wide table on the prose edge`,
            ).toBeLessThan(0.5);
            expect(
              Math.abs(seen.block.width - seen.line.column),
              `${where}: the code block is the column`,
            ).toBeLessThan(0.5);
            // A word too long for the line breaks inside its cell, so the table fits the line.
            expect(
              Math.abs(seen.oversize.left - seen.column.left),
              `${where}: the digest table starts on the line`,
            ).toBeLessThan(0.5);
            expect(seen.oversize.right, `${where}: the digest table fits the line`).toBeLessThanOrEqual(
              seen.column.right + 0.5,
            );
          }
          if (step === 18 && SHOTS_DIR) {
            await page.send("Emulation.setDeviceMetricsOverride", {
              width: 1600,
              height: 2000,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await page.evaluate(SETTLE);
            await shot(page, `${style}-light`, paneOf(STYLES_NOTED), 0);
            if (style === "spec") {
              await scheme(page, "dark");
              await shot(page, "spec-dark", paneOf(STYLES_NOTED), 0);
              await scheme(page, "light");
            }
            await pin(page, { width: 1920, height: 1200 });
            if (style === "spec") {
              await page.evaluate(
                `(${paneOf(STYLES_NOTED)}).querySelectorAll('.glosa-content > table')[1].scrollIntoView({block:'center'})`,
              );
              await page.evaluate(SETTLE);
              await shot(page, "spec-wide-table-light", paneOf(STYLES_NOTED), 0);
            }
          }
          if (style === "spec" && step === 18) {
            // Editing a wide block in place keeps it where it was: the run editor that takes its place
            // holds the same table, at the same width and on the same line. The digest table too: in
            // the editor its long word still breaks, so it fits the lane there as on the page.
            await openDocument(page, STYLES_DOC, STYLES_NOTED, 0, "edit");
            for (const [index, what] of [
              [1, "the wide table"],
              [2, "the digest table"],
            ] as const) {
              const editing = await page.evaluate<{
                before: StyleReading["wide"];
                after: StyleReading["wide"];
              }>(`(async()=>{
                const pane=${paneOf(STYLES_NOTED)},content=pane.querySelector('.glosa-content');
                const rect=(el)=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
                const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                const table=content.querySelectorAll(':scope > table')[${index}];table.scrollIntoView({block:'center'});
                await frame();
                const before=rect(table),cell=table.querySelector('td').getBoundingClientRect();
                table.querySelector('td').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:cell.left+4,clientY:cell.top+4}));
                const deadline=Date.now()+5000;let host;
                while(!(host=content.querySelector('.glosa-run-editor'))?.querySelector('table')){
                  if(Date.now()>deadline) throw new Error('the run editor never opened on ${what}');
                  await new Promise(r=>setTimeout(r,25));}
                await frame();
                const after=rect(host.querySelector('table'));
                document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
                while(content.querySelector('.glosa-run-editor')){
                  if(Date.now()>deadline) throw new Error('the run editor on ${what} never closed');
                  await new Promise(r=>setTimeout(r,25));}
                await frame();
                return {before,after};})()`);
              expect(
                Math.abs(editing.after.left - editing.before.left),
                `${what} being edited stays on its line`,
              ).toBeLessThan(1);
              expect(Math.abs(editing.after.width - editing.before.width), `${what} keeps its width`).toBeLessThan(1);
            }
            await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
          }
        }
      }

      // At a 1440px desk the pane has no room beyond a full rail, so Spec keeps its wide blocks on
      // the line rather than let them reach the rail. The room is worked out from the pane's width
      // alone, not from whether the rail is showing, so entering Review cannot move them.
      await page.evaluate(`localStorage.removeItem('glosa_text_size')`);
      await pin(page, { width: 1440, height: 900 });
      await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
      await chooseStyleOf(page, STYLES_NOTED, "spec");
      const desk = await page.evaluate<StyleReading>(STYLE_READING);
      expect(desk.rail.length, "a 1440px desk shows the rail").toBeGreaterThan(0);
      expect(desk.wide.width, "Spec's wide table stays on the line beside a rail").toBeLessThanOrEqual(
        desk.line.column + 0.5,
      );
      expect(Math.abs(desk.block.width - desk.line.column), "and so does its code block").toBeLessThan(0.5);
      expect(
        Math.abs(desk.oversize.left - desk.column.left),
        "a table with a word too long to fit starts on the line",
      ).toBeLessThan(0.5);
      expect(desk.oversize.right, "and fits it").toBeLessThanOrEqual(desk.column.right + 0.5);
      expect(desk.cells, "every table cell ends inside what the pane shows").toBeLessThanOrEqual(desk.visible + 0.5);
      expect(desk.split, "no word breaks in the other tables, squeezed onto the line").toEqual([]);
      for (const left of desk.rail) expect(left).toBeGreaterThanOrEqual(desk.column.right);

      // Between those two desks the room beyond a full rail decides the width: none below a pane of
      // about 1230px at the default size, all of it in between, and the 96ch cap from about 1485px.
      const around = await deskAround(page);
      for (const width of [1225, 1360, 1490]) {
        await paneAt(page, width, around);
        const at = await page.evaluate<StyleReading>(STYLE_READING);
        const room = at.pane.inline - at.pane.block - 2 * 8 - 2 * 320;
        const extra = Math.max(0, Math.min(32 * at.ch, room));
        const where = `a ${width}px pane (room ${Math.round(room)}px)`;
        expect(Math.abs(at.wide.width - (at.line.column + extra)), `${where}: the wide table's width`).toBeLessThan(
          1.5,
        );
        expect(Math.abs(at.block.width - (at.line.column + extra)), `${where}: the code block's width`).toBeLessThan(
          1.5,
        );
        expect(
          Math.abs(at.oversize.width - (at.line.column + extra)),
          `${where}: the digest table fills the lane and no more`,
        ).toBeLessThan(1.5);
        expect(at.split, `${where}: no word breaks in the other tables`).toEqual([]);
        if (width === 1225) expect(room, `${where}: no room below about 1230px`).toBeLessThan(0);
        if (width === 1360) expect(extra, `${where}: the room decides`).toBeGreaterThan(0);
        if (width === 1360) expect(extra, `${where}: under the cap`).toBeLessThan(32 * at.ch);
        if (width === 1490) expect(extra, `${where}: the 96ch cap from about 1485px`).toBe(32 * at.ch);
        for (const left of at.rail) {
          expect(left, `${where}: a rail card starts right of the wide blocks`).toBeGreaterThanOrEqual(
            Math.max(at.wide.right, at.block.right),
          );
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  interface StyleMenu {
    heading: string | null;
    rows: string[];
    checked: string | null;
    note: string | null;
    useAsDefault: string | null;
    status: string | null;
    /** Where the status line is: inside the Style group, above the Text size row, and which shown
     * element it sits directly under. Null while it says nothing. */
    place: { inGroup: boolean; aboveTextSize: boolean; under: string | null } | null;
  }
  /** The Style group of a pane's open More menu, as a reader finds it. */
  const MENU = (text: string) => `(()=>{const pane=${paneOf(text)},group=pane.querySelector('.glosa-style-group');
    const shown=(el)=>Boolean(el)&&!el.hidden&&el.getBoundingClientRect().width>0;
    const menu=pane.querySelector('.glosa-pane-menu'),size=menu.querySelector('.glosa-text-size');
    const status=[...menu.querySelectorAll('[role="status"]')].find(shown)??null,
      note=group.querySelector('.glosa-style-folder-note'),use=group.querySelector('.glosa-style-folder');
    let above=status?.previousElementSibling??null;while(above&&!shown(above)) above=above.previousElementSibling;
    return {heading:group.querySelector('.glosa-pane-menu-heading')?.textContent??null,
      rows:[...group.querySelectorAll('.glosa-style-option')].filter(shown).map(r=>r.querySelector('span:last-child').textContent),
      checked:group.querySelector('.glosa-style-option[aria-checked="true"]')?.dataset.style??null,
      note:shown(note)?note.textContent:null,useAsDefault:shown(use)?use.textContent:null,
      status:status?status.textContent:null,
      place:status?{inGroup:group.contains(status),
        aboveTextSize:status.getBoundingClientRect().bottom<=size.getBoundingClientRect().top+0.5,
        under:above?above.className:null}:null};})()`;

  async function openMenuOf(page: CdpClient, text: string): Promise<void> {
    await page.evaluate(`(async()=>{const pane=${paneOf(text)};
      if(pane.querySelector('.glosa-pane-tools').dataset.open!=='true') pane.querySelector('.glosa-tools-trigger').click();
      const deadline=Date.now()+3000;
      while(!pane.querySelector('.glosa-style-group .glosa-style-option')?.getBoundingClientRect().width){
        if(Date.now()>deadline) throw new Error('the More menu never showed the Style group');
        await new Promise(r=>requestAnimationFrame(r));}})()`);
    await page.evaluate(SETTLE);
  }

  test(
    "#407: Use as folder default in one window's More menu sets the folder's style, another window on the folder follows it without a reload, and a document's own Editorial holds against it",
    async () => {
      const a = await launch();
      await pin(a, { width: 1440, height: 900 });
      await openDocument(a, STYLES_DOC, STYLES_NOTED, 1);
      const b = await openPage({ newWindow: true });
      await pin(b, { width: 1440, height: 900 });
      await openDocument(b, DOC, NOTED[1], NOTED.length);
      await b.evaluate("window.__sameDocument = true");
      const styleIn = (page: CdpClient, text: string) => page.evaluate<string>(`(${paneOf(text)}).dataset.style`);
      expect(await styleIn(b, NOTED[1]), "no choice and no folder default: Editorial").toBe("editorial");

      await chooseStyleOf(a, STYLES_NOTED, "spec");
      await openMenuOf(a, STYLES_NOTED);
      const rows = ["Editorial (Serif)", "Spec (Sans)", "Mono"];
      expect(await a.evaluate<StyleMenu>(MENU(STYLES_NOTED)), "no folder default yet").toEqual({
        heading: "Style",
        rows,
        checked: "spec",
        note: null,
        useAsDefault: "Use as folder default",
        status: null,
        place: null,
      });
      const menu = `(${paneOf(STYLES_NOTED)}).querySelector('.glosa-pane-menu')`;
      await shot(a, "menu-style-light", menu, 16);
      await scheme(a, "dark");
      await shot(a, "menu-style-dark", menu, 16);
      await scheme(a, "light");

      // A save that never reaches the daemon says so in the menu, changes nothing, and leaves the row
      // (and the reader's focus) where they were, to try again. The engine itself fails the request.
      await a.send("Fetch.enable", { patterns: [{ urlPattern: "*/folder-style", requestStage: "Request" }] });
      const stopFailing = a.on((msg) => {
        if (msg.method !== "Fetch.requestPaused") return;
        const { requestId, request } = msg.params;
        void a.send(
          request.method === "PUT" ? "Fetch.failRequest" : "Fetch.continueRequest",
          request.method === "PUT" ? { requestId, errorReason: "ConnectionRefused" } : { requestId },
        );
      });
      await clickAt(a, ".glosa-pane .glosa-style-folder");
      await a.evaluate(`(async()=>{const deadline=Date.now()+5000;
        while(!(${MENU(STYLES_NOTED)}).status){if(Date.now()>deadline) throw new Error('the failed save never said so');
          await new Promise(r=>requestAnimationFrame(r));}})()`);
      await a.evaluate(SETTLE);
      expect(await a.evaluate<StyleMenu>(MENU(STYLES_NOTED)), "a failed save changes nothing and says so").toEqual({
        heading: "Style",
        rows,
        checked: "spec",
        note: null,
        useAsDefault: "Use as folder default",
        status: "Couldn't set the folder default, so nothing changed. Try again.",
        // Said in the Style group, right under the row that failed, above Text size.
        place: { inGroup: true, aboveTextSize: true, under: "glosa-pane-menu-item glosa-style-folder" },
      });
      expect(
        await a.evaluate<boolean>("document.activeElement?.classList.contains('glosa-style-folder') ?? false"),
        "focus is back on the row, to try again",
      ).toBe(true);
      await shot(a, "menu-style-folder-default-failed-light", menu, 16);
      stopFailing();
      await a.send("Fetch.disable");

      await clickAt(a, ".glosa-pane .glosa-style-folder");
      await a.evaluate(`(async()=>{const deadline=Date.now()+5000;
        while(!(${MENU(STYLES_NOTED)}).note){if(Date.now()>deadline) throw new Error('the folder default never showed');
          await new Promise(r=>requestAnimationFrame(r));}})()`);
      await a.evaluate(SETTLE);
      expect(
        await a.evaluate<StyleMenu>(MENU(STYLES_NOTED)),
        "the folder's default is Spec, and this document follows it",
      ).toEqual({
        heading: "Style",
        rows,
        checked: "spec",
        note: "Folder default: Spec",
        useAsDefault: null,
        status: "Spec is now this folder's default.",
        // The row has hidden, so it is said right under "Folder default: Spec", above Text size.
        place: { inGroup: true, aboveTextSize: true, under: "glosa-style-folder-note" },
      });
      expect(
        await a.evaluate<string>("document.activeElement?.dataset?.style ?? ''"),
        "focus moves from the row that hid itself to the chosen style",
      ).toBe("spec");
      await shot(a, "menu-style-folder-default-light", menu, 16);
      await scheme(a, "dark");
      await shot(a, "menu-style-folder-default-dark", menu, 16);
      await scheme(a, "light");

      // The other window takes the folder's Spec from its stream, with no reload.
      await b.evaluate(`(async()=>{const deadline=Date.now()+5000;
        while((${paneOf(NOTED[1])}).dataset.style!=='spec'){
          if(Date.now()>deadline) throw new Error('the other window never took the folder default');
          await new Promise(r=>setTimeout(r,50));}})()`);
      expect(await b.evaluate<boolean>("window.__sameDocument === true"), "no reload").toBe(true);

      // Its own Editorial is a choice of its own: it holds in a Spec folder, and the menu says so.
      await chooseStyleOf(b, NOTED[1], "editorial");
      await openMenuOf(b, NOTED[1]);
      expect(
        await b.evaluate<StyleMenu>(MENU(NOTED[1])),
        "overridden: Editorial applies, over a Spec folder",
      ).toMatchObject({
        checked: "editorial",
        note: "Folder default: Spec",
        useAsDefault: "Use as folder default",
      });
      const menuB = `(${paneOf(NOTED[1])}).querySelector('.glosa-pane-menu')`;
      await shot(b, "menu-style-overridden-light", menuB, 16);

      // Both hold across a reload: the other window's Editorial, and this window's following Spec.
      await openDocument(b, DOC, NOTED[1], NOTED.length);
      expect(await styleIn(b, NOTED[1])).toBe("editorial");
      await openDocument(a, STYLES_DOC, STYLES_NOTED, 1);
      expect(await styleIn(a, STYLES_NOTED)).toBe("spec");
    },
    TEST_TIMEOUT_MS,
  );
  // ---------- #408: the Conversation style ----------

  /** #408: a reply holding every Markdown element a reply can carry, a message from the person long
   * enough to wrap, and a draft. The opening paragraph runs to several lines at every step, so the
   * characters on each of its lines can be counted where it paints. One table fits the column; the
   * other holds a word too long for any column. */
  const CONVERSATION: ChatFixture = {
    reply: [
      "# A title in a reply",
      "",
      "The opening paragraph of the reply runs long enough to wrap across several lines of the chat at every text size, so the characters on each of its lines can be counted where it paints; it names `packages/spa/src/chat-pane.js` in passing, stresses **one phrase in bold**, and points to [the outline guide](https://example.com/guide) the way a reply sends a reader somewhere else to read.",
      "",
      "## A section heading",
      "",
      "A paragraph under the section heading.",
      "",
      "### A subhead",
      "",
      "- A first item in a list",
      "- A second item, rather longer, so that it wraps onto a second line at the larger sizes",
      "",
      "#### A fourth-level heading",
      "",
      "1. A numbered step",
      "2. Another numbered step",
      "",
      "##### A fifth-level heading",
      "",
      "> A quotation the reply keeps, set as a blockquote.",
      "",
      "###### A sixth-level heading",
      "",
      "```",
      "const unchanged = true; // a code line long enough to need its own sideways scroll inside the block",
      "```",
      "",
      "| Term | Meaning |",
      "| --- | --- |",
      "| Style | A document's dress |",
      "| Step | One rung of the ladder |",
      "",
      "| Digest | Note |",
      "| --- | --- |",
      `| ${"0123456789abcdef".repeat(6)} | one word too long for any column |`,
      "",
      "---",
      "",
      "A closing paragraph after the rule.",
    ].join("\n"),
    person:
      "Review my outline, and say where the argument is weakest. The second section feels thin, and I am not sure the example in it earns its place, so tell me whether to cut it or move it.",
    draft: "A draft that runs long enough to wrap across two lines of the composer before it is sent.",
    // A question Claude Code's AskUserQuestion raises, as its provider maps it: the questions as the
    // detail, two questions with the longest labels and descriptions a reply like this one invites,
    // and "Submit answers", the longest button a provider sends.
    decisions: [
      {
        id: "decision",
        nativeId: "native-decision",
        generation: 1,
        turnId: "first",
        kind: "question",
        status: "pending",
        title: "AskUserQuestion",
        detail: JSON.stringify({
          questions: [
            { question: "Which part of the second section should carry the comparison it promises?" },
            { question: "Which examples should stay in the outline once the section is revised?" },
          ],
        }),
        choices: [
          { id: "allow", label: "Submit answers" },
          { id: "deny", label: "Cancel" },
        ],
        allowText: true,
        questions: [
          {
            id: "comparison",
            question: "Which part of the second section should carry the comparison it promises?",
            multiple: false,
            options: [
              {
                label: "Move the comparison up so that it opens the second section",
                description: "The section then leads with what it promised, and the example follows as support.",
              },
              {
                label: "Keep the order and close the section with a paragraph that makes the comparison",
                description: "Nothing moves; the promise is kept at the end, where a reader may have stopped.",
              },
              { label: "Cut the promise from the section's opening sentence instead" },
            ],
          },
          {
            id: "examples",
            question: "Which examples should stay in the outline once the section is revised?",
            multiple: true,
            options: [
              { label: "The long path, packages/spa/src/chat-pane.js, in its own paragraph" },
              { label: "The table of terms" },
              { label: "The quotation" },
            ],
          },
        ],
      },
    ],
  };

  interface Type {
    family: string;
    size: number;
    weight: number;
    leading: number;
    italic: boolean;
    /** `ink` or `muted` when the colour is that token's, as the chat's own cascade resolves it. */
    colour: string;
  }
  type Rect = { left: number; right: number; width: number };
  interface ChatReading {
    fonts: boolean;
    step: number;
    /** The size of the document's h3 beside the chat: no heading in a reply is larger. */
    documentH3: number;
    type: Record<
      | "p"
      | "li"
      | "ol"
      | "h1"
      | "h2"
      | "h3"
      | "h4"
      | "h5"
      | "h6"
      | "strong"
      | "quote"
      | "code"
      | "pre"
      | "preCode"
      | "table"
      | "th"
      | "td"
      | "person"
      | "draft",
      Type
    >;
    gap: number;
    link: { reply: string; document: string };
    /** Characters on each full line of the opening paragraph, the reply's column and that paragraph. */
    line: { chars: number[]; column: Rect; paragraph: Rect };
    person: Rect;
    composer: Rect;
    fit: Array<string | null>;
    tables: Rect[];
    split: string[];
    sideways: number;
  }
  /** Everything the Conversation style sets, read from the chat beside the document in one evaluate.
   * Colours are named by the token they resolve to in the chat's own cascade, so a reply in the
   * session's ink or a heading in the chrome's grey reads as that, not as a number. */
  const CHAT_READING = `(()=>{
    const r2=(v)=>Math.round(v*100)/100;
    const history=document.querySelector('.glosa-chat-history'),reply=history.querySelector('.glosa-chat-markdown');
    const q=(selector)=>reply.querySelector(selector);
    const paint=(css)=>{const s=document.createElement('span');s.style.color=css;reply.append(s);
      const c=getComputedStyle(s).color;s.remove();return c;};
    const ink=paint('var(--ink)'),muted=paint('var(--muted)');
    const box=(el)=>{const s=getComputedStyle(el),size=parseFloat(s.fontSize);
      return {family:s.fontFamily.split(',')[0].replace(/["']/g,'').trim(),size:r2(size),weight:Number(s.fontWeight),
        leading:r2(parseFloat(s.lineHeight)/size),italic:s.fontStyle==='italic',
        colour:s.color===ink?'ink':s.color===muted?'muted':s.color};};
    const pane=[...document.querySelectorAll('.glosa-pane')].find(p=>p.getBoundingClientRect().width>0);
    const content=pane.querySelector('.glosa-content');
    const probe=document.createElement('a');probe.href='#';probe.textContent='a link';content.append(probe);
    const documentLink=getComputedStyle(probe).color;probe.remove();
    const first=q(':scope > p'),top=first.getBoundingClientRect().top,line=parseFloat(getComputedStyle(first).lineHeight);
    const counts=[],range=document.createRange(),walk=document.createTreeWalker(first,NodeFilter.SHOW_TEXT);
    for(let n=walk.nextNode();n;n=walk.nextNode()) for(let i=0;i<n.data.length;i++){range.setStart(n,i);range.setEnd(n,i+1);
      const r=[...range.getClientRects()].find(x=>x.height>0);if(!r) continue;
      const at=Math.floor((r.top+r.height/2-top)/line);counts[at]=(counts[at]??0)+1;}
    const rect=(el)=>{const r=el.getBoundingClientRect();return {left:r2(r.left),right:r2(r.right),width:r2(r.width)};};
    const human=document.querySelector('.glosa-chat-message[data-kind="human"]');
    const tables=[...reply.querySelectorAll('table')];
    return {fonts:document.fonts.check('16px "Source Serif 4"')&&document.fonts.check('16px "Source Sans 3"'),
      step:Number(document.documentElement.dataset.textSize),
      documentH3:r2(parseFloat(getComputedStyle(content.querySelector('h3')).fontSize)),
      type:{p:box(first),li:box(q('ul > li')),ol:box(q('ol > li')),h1:box(q('h1')),h2:box(q('h2')),h3:box(q('h3')),
        h4:box(q('h4')),h5:box(q('h5')),h6:box(q('h6')),strong:box(q('strong')),quote:box(q('blockquote > p')),
        code:box(q('p code')),pre:box(q('pre')),preCode:box(q('pre code')),table:box(q('table')),th:box(q('th')),
        td:box(q('td')),person:box(human.querySelector('.glosa-chat-text')),draft:box(document.querySelector('.glosa-chat-draft'))},
      gap:r2(parseFloat(getComputedStyle(first).marginBottom)),
      link:{reply:getComputedStyle(q('a')).color,document:documentLink},
      line:{chars:counts.slice(0,-1),column:rect(reply.closest('.glosa-chat-message')),paragraph:rect(first)},
      person:rect(human),composer:rect(document.querySelector('.glosa-chat-composer')),
      fit:tables.map(t=>t.getAttribute('data-fit')),tables:tables.map(rect),
      split:[...reply.querySelectorAll('table:not([data-fit]) :is(th,td)')].flatMap(cell=>{
        const out=[],walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
        for(let node=walk.nextNode();node;node=walk.nextNode()) for(const m of node.data.matchAll(/[^\\s-]+/g)){
          const r=document.createRange();r.setStart(node,m.index);r.setEnd(node,m.index+m[0].length);
          if(new Set([...r.getClientRects()].filter(x=>x.width>0).map(x=>Math.round(x.top))).size>1) out.push(m[0]);}
        return out;}),
      sideways:history.scrollWidth-history.clientWidth};
  })()`;

  /** The Conversation style of #408 at a step: the reply, the person's message and the draft in the
   * serif one step under the document (CHAT_UNDER), with the document's rules for every element in
   * the reply's own em. Headings run 1.25em, 1.125em, then the reply's size, and none is ever larger
   * than the document's h3 (20px at the default step); code, tables and table heads stop at the
   * reading scale's floors of 12px, 13px and 12px. */
  function conversation(step: number): ChatReading["type"] {
    const size = CHAT_UNDER[step] ?? Number.NaN;
    const h3 = (20 * step) / 18;
    const serif = (px: number, weight: number, leading: number): Type => ({
      family: "Source Serif 4",
      size: round(px),
      weight,
      leading,
      italic: false,
      colour: "ink",
    });
    const pre = Math.max(12, (13 * size) / 16);
    const table = Math.max(13, (14 * size) / 16);
    const minor = serif(size, 650, 1.4);
    return {
      p: serif(size, 400, 1.62),
      li: serif(size, 400, 1.62),
      ol: serif(size, 400, 1.62),
      h1: serif(Math.min(1.25 * size, h3), 620, 1.25),
      h2: serif(Math.min(1.25 * size, h3), 620, 1.25),
      h3: serif(Math.min(1.125 * size, h3), 620, 1.3),
      h4: minor,
      h5: minor,
      h6: minor,
      strong: serif(size, 600, 1.62),
      quote: { ...serif(size, 400, 1.62), italic: true, colour: "muted" },
      code: { ...serif(0.85 * size, 400, 1.62), family: "ui-monospace" },
      pre: { ...serif(pre, 400, 1.6), family: "ui-monospace" },
      preCode: { ...serif(pre, 400, 1.6), family: "ui-monospace" },
      table: { ...serif(table, 400, 1.62), family: "Source Sans 3" },
      th: { ...serif(Math.max(12, (13 * size) / 16), 600, 1.62), family: "Source Sans 3", colour: "muted" },
      td: { ...serif(table, 400, 1.62), family: "Source Sans 3" },
      person: serif(size, 400, 1.62),
      draft: serif(size, 400, 1.62),
    };
  }
  interface DecisionReading {
    shown: boolean;
    card: Rect;
    column: Rect;
    /** The card's content box, inside its border and padding. */
    inner: { left: number; right: number };
    options: number;
    buttons: Array<{ label: string; left: number; right: number; overflow: number }>;
    /** How far the card, and each of its question groups, runs past its own box sideways. */
    overflow: number[];
    /** Options whose radio or checkbox is not on the first line of the option's own words. */
    apart: string[];
  }
  /** The decision card waiting on the person, against the reply's column, in one evaluate. */
  const DECISION_READING = `(()=>{
    const r2=(v)=>Math.round(v*100)/100;
    const rect=(el)=>{const r=el.getBoundingClientRect();return {left:r2(r.left),right:r2(r.right),width:r2(r.width)};};
    const card=document.querySelector('.glosa-chat-decision');
    const column=document.querySelector('.glosa-chat-history .glosa-chat-markdown').closest('.glosa-chat-message');
    const s=getComputedStyle(card),box=card.getBoundingClientRect();
    return {shown:!card.hidden&&box.width>0,card:rect(card),column:rect(column),
      inner:{left:r2(box.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft)),
        right:r2(box.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight))},
      options:card.querySelectorAll('fieldset label').length,
      buttons:[...card.querySelectorAll(':scope > button')].map(b=>({label:b.textContent,...rect(b),overflow:b.scrollWidth-b.clientWidth})),
      overflow:[card,...card.querySelectorAll('fieldset')].map(el=>el.scrollWidth-el.clientWidth),
      apart:[...card.querySelectorAll('fieldset label')].flatMap(label=>{
        const control=label.querySelector('input').getBoundingClientRect(),words=document.createRange();
        const text=[...label.childNodes].find(n=>n.nodeType===3&&n.data.trim());words.selectNodeContents(text);
        const first=[...words.getClientRects()].find(r=>r.width>0);
        return first&&control.bottom>first.top&&control.top<first.bottom?[]:[text.data.slice(0,40)];})};
  })()`;

  /** What a person or a session wrote in a reply: set in the serif, in ink (quotes excepted). */
  const WRITING = ["p", "li", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "person", "draft"] as const;
  const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

  test(
    "#408: a reply, the person's message and the draft are set in the Conversation style, serif one step under the document with the document's rules for every Markdown element, on a column of 34em that the composer matches, the same beside a document in Editorial, Spec and Mono and at the smallest and largest steps",
    async () => {
      const page = await launch();
      await pin(page, { width: 1920, height: 1600 });
      const CHAT = "document.querySelector('.glosa-chat-pane')";
      // Everything is measured first and judged after, so the screenshots for review exist even when a
      // value is wrong.
      await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
      await page.evaluate(mountChat("beside", CONVERSATION, 720));
      await page.evaluate(SETTLE);
      const DECISIONS = "document.querySelector('.glosa-chat-decisions')";
      const decisions: Record<number, DecisionReading> = {
        18: await page.evaluate<DecisionReading>(DECISION_READING),
      };
      const audits: Record<number, Audit> = { 18: await page.evaluate<Audit>(AUDIT) };
      await shot(page, "chat-light", CHAT, 0);
      await shot(page, "decision-card-light", DECISIONS, 120);
      await scheme(page, "dark");
      await shot(page, "chat-dark", CHAT, 0);
      await shot(page, "decision-card-dark", DECISIONS, 120);
      await scheme(page, "light");
      const styles: Partial<Record<StyleName, ChatReading>> = {};
      for (const style of ["editorial", "spec", "mono"] as const) {
        await chooseStyleOf(page, STYLES_NOTED, style);
        styles[style] = await page.evaluate<ChatReading>(CHAT_READING);
        if (style === "spec") await shot(page, "chat-beside-spec");
      }
      await chooseStyleOf(page, STYLES_NOTED, "editorial");
      const steps: Record<number, ChatReading> = { 18: styles.editorial as ChatReading };
      for (const step of [24, 15]) {
        await page.evaluate(`localStorage.setItem('glosa_text_size','${step}')`);
        await openDocument(page, STYLES_DOC, STYLES_NOTED, 1);
        await page.evaluate(mountChat("beside", CONVERSATION, 960));
        await page.evaluate(SETTLE);
        steps[step] = await page.evaluate<ChatReading>(CHAT_READING);
        if (step === 24) {
          decisions[step] = await page.evaluate<DecisionReading>(DECISION_READING);
          audits[step] = await page.evaluate<Audit>(AUDIT);
          await shot(page, "chat-largest", CHAT, 0);
        }
      }

      const editorial = styles.editorial as ChatReading;
      expect(editorial.fonts, "the vendored faces have loaded").toBe(true);
      // One Conversation style, whatever the document beside it is set in: a Spec page sits beside a
      // serif chat.
      for (const style of ["spec", "mono"] as const) {
        expect(styles[style]?.type, `beside a ${style} document the chat keeps the Conversation style`).toEqual(
          editorial.type,
        );
      }
      for (const [at, seen] of Object.entries(steps)) {
        const step = Number(at);
        const where = `at step ${step}`;
        expect(seen.step, where).toBe(step);
        expect(seen.type, `${where}: the Conversation style`).toEqual(conversation(step));
        // The invariants, whatever the values: writing in the serif and in ink, no heading over the
        // document's h3, and links as the document draws them.
        for (const key of WRITING) {
          expect(seen.type[key].family, `${where}: ${key} is writing, set in the serif`).toBe("Source Serif 4");
          expect(seen.type[key].colour, `${where}: ${key} is in ink, never the session's`).toBe("ink");
        }
        for (const key of HEADINGS) {
          expect(
            seen.type[key].size,
            `${where}: a reply's ${key} is no larger than the document's h3`,
          ).toBeLessThanOrEqual(seen.documentH3);
        }
        expect(seen.link.reply, `${where}: a reply's link is the colour of the document's`).toBe(seen.link.document);
        // The composer's frame is the reply's column, and the person's bubble, narrower than the column
        // even when the message wraps, keeps to its right edge: alignment and shape tell the speakers
        // apart, not the tint.
        const { column } = seen.line;
        expect(Math.abs(seen.composer.left - column.left), `${where}: the composer starts on the column`).toBeLessThan(
          1,
        );
        expect(Math.abs(seen.composer.right - column.right), `${where}: the composer ends on the column`).toBeLessThan(
          1,
        );
        expect(
          Math.abs(seen.person.right - column.right),
          `${where}: the person's bubble on the column's right edge`,
        ).toBeLessThan(1);
        expect(seen.person.left, `${where}: the person's bubble stops short of the column's left edge`).toBeGreaterThan(
          column.left + column.width * 0.1,
        );
        // A table keeps its words whole unless a word is too long for any column; that one breaks it,
        // so the table fits the column and the chat never scrolls sideways (the Cell Break Rule).
        expect(seen.fit, `${where}: only the digest table is marked to break words`).toEqual([null, "break"]);
        expect(seen.split, `${where}: no word breaks in the other table`).toEqual([]);
        expect(seen.tables[1]?.right, `${where}: the digest table fits the column`).toBeLessThanOrEqual(
          column.right + 0.5,
        );
        expect(seen.sideways, `${where}: the chat does not scroll sideways`).toBeLessThanOrEqual(0);
      }
      expect(editorial.gap, "blocks in a reply are 0.9em of it apart").toBe(round(0.9 * 16));
      // The column is 34em of the reply, so a text size step keeps its line: the same count of
      // characters at the default step and at the largest.
      const mean = (chars: number[]) => chars.reduce((sum, n) => sum + n, 0) / chars.length;
      const lines: Record<number, number> = {};
      for (const step of [18, 24]) {
        const seen = steps[step] as ChatReading;
        const size = CHAT_UNDER[step] ?? Number.NaN;
        expect(
          Math.abs(seen.line.column.width - 34 * size),
          `at step ${step}: the column is 34em of the reply`,
        ).toBeLessThan(0.5);
        expect(
          seen.line.chars.length,
          `at step ${step}: the opening paragraph runs to several full lines`,
        ).toBeGreaterThanOrEqual(3);
        lines[step] = round(mean(seen.line.chars));
      }
      console.log(
        `#408 painted line length, characters per full line of the opening paragraph: step 18 ${JSON.stringify(steps[18]?.line.chars)} (mean ${lines[18]}), step 24 ${JSON.stringify(steps[24]?.line.chars)} (mean ${lines[24]})`,
      );
      // Within a few characters: the serif's optical size draws a little narrower at 22px than at 16px,
      // and a word moving between lines shifts the mean. A cap in rem would lose over a quarter of the
      // line at the largest step, where the reply is 22px against 16px.
      expect(Math.abs((lines[18] ?? 0) - (lines[24] ?? 0)), "the largest step keeps the line length").toBeLessThan(6);
      for (const step of [18, 24]) {
        expect(lines[step], `at step ${step}: a reading line of about 70 characters`).toBeGreaterThanOrEqual(62);
        expect(lines[step], `at step ${step}: a reading line of about 70 characters`).toBeLessThanOrEqual(78);
      }
      // A decision waiting on the person sits in the reply's column, edge to edge with the composer,
      // and nothing in it is cut off, painted over or pushed out of the card: not its longest option,
      // not its buttons.
      for (const step of [18, 24]) {
        const where = `at step ${step}`;
        const seen = decisions[step] as DecisionReading;
        expect(seen.shown, `${where}: the question is shown as a card`).toBe(true);
        expect(seen.options, `${where}: the card holds every option`).toBe(6);
        expect(
          Math.abs(seen.card.left - seen.column.left),
          `${where}: the decision card starts on the reply's column`,
        ).toBeLessThan(1);
        expect(
          Math.abs(seen.card.right - seen.column.right),
          `${where}: the decision card ends on the reply's column`,
        ).toBeLessThan(1);
        expect(
          seen.buttons.map((button) => button.label),
          `${where}: the card offers its choices`,
        ).toEqual(["Submit answers", "Cancel"]);
        for (const button of seen.buttons) {
          expect(button.left, `${where}: ${button.label} starts inside the card`).toBeGreaterThanOrEqual(
            seen.inner.left - 0.5,
          );
          expect(button.right, `${where}: ${button.label} ends inside the card`).toBeLessThanOrEqual(
            seen.inner.right + 0.5,
          );
          expect(button.overflow, `${where}: ${button.label} fits its own button`).toBeLessThanOrEqual(0);
        }
        expect(seen.overflow, `${where}: nothing in the card runs past it sideways`).toEqual(
          seen.overflow.map(() => 0),
        );
        expect(seen.apart, `${where}: every option's control sits on the first line of its words`).toEqual([]);
        expectClean(audits[step] as Audit, `${where}: the chat with a decision card`, 40);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
