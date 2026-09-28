// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomPort } from "../../daemon/test/helpers.ts";
import { join, resolve } from "node:path";

test("composer uses native undo, retains focus, and places the picker outside clipped panes", async () => {
  const executable = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find(existsSync);
  if (!executable) throw new Error("This layout gate requires installed Chromium.");
  const home = mkdtempSync(join(tmpdir(), "glosa-composer-browser-"));
  const root = resolve(import.meta.dir, "../src");
  const page = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div style="height:300px"></div><div style="overflow:hidden;height:190px;width:340px" id="pane" class="glosa-chat-pane"><div class="glosa-chat-composer"><textarea class="glosa-chat-draft" aria-label="Message"></textarea></div></div><script type="module">
import {createComposerPicker} from '/composer-picker.js';
const input=document.querySelector('textarea');
const results=[];
const check=(value,name)=>{if(!value)throw Error(name);results.push(name)};
const picker=createComposerPicker(input,{getFiles:()=>['notes.md','writing/a very long name with spaces.md'],getCatalog:async()=>({loaded:true,commands:[{id:'review',name:'review',description:'Review writing',kind:'skill'}]}),loadCatalog:async()=>{throw Error('Unexpected process start')},onAction:async()=>true,onChange(){}});
const frame=()=>new Promise(resolve=>setTimeout(resolve,0));
try {
 await document.fonts.ready;
 input.focus();document.execCommand('insertText',false,'@no');await frame();
 const popup=document.querySelector('.glosa-composer-picker');
 check(input.getAttribute('aria-expanded')==='true','popup open');
 check(popup.getBoundingClientRect().bottom<=input.getBoundingClientRect().top,'popup above composer');
 check(popup.getBoundingClientRect().left>=0 && popup.getBoundingClientRect().right<=innerWidth,'popup fits narrow viewport');
 check(popup.matches(':popover-open'),'native top layer escapes clipping');
 const before=input.value;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
 check(input.value===before,'IME does not accept');
 input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await frame();
 check(input.value==='@notes.md ','keyboard selection');check(document.activeElement===input,'focus retained');
 check(picker.references.length===1,'selection bound');
 check(document.querySelector('.glosa-chat-reference-mirror mark').textContent==='@notes.md','highlight aligned text');
 document.execCommand('undo');await frame();check(input.value!=='@notes.md ','native undo');check(picker.references.length===0,'undo unbinds');
 input.value='/review ';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input'));picker.setReferences([{kind:'command',id:'review',text:'/review',start:0,end:7}]);
 check(getComputedStyle(input).color!=='rgba(0, 0, 0, 0)','native text opaque');
 document.body.dataset.result=JSON.stringify({ok:true,results});
} catch(error){document.body.dataset.result=JSON.stringify({ok:false,error:error.message,results})} finally {picker.destroy()}
</script></body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html" } });
      const path = resolve(root, `.${pathname}`);
      return path.startsWith(`${root}/`) && existsSync(path)
        ? new Response(Bun.file(path))
        : new Response(null, { status: 404 });
    },
  });
  const port = await randomPort();
  let child: Bun.Subprocess | undefined;
  let client: CdpClient | undefined;
  try {
    child = Bun.spawn({
      cmd: [
        executable,
        "--headless=new",
        `--remote-debugging-port=${port}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-gpu",
        "--disable-sync",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--metrics-recording-only",
        "--use-mock-keychain",
        `--user-data-dir=${home}/browser`,
        "--window-size=420,700",
        "about:blank",
      ],
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: home },
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = Date.now() + 15_000;
    let endpoint: string | undefined;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const list = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })
        ).json()) as { type: string; webSocketDebuggerUrl: string }[];
        endpoint = list.find((item) => item.type === "page")?.webSocketDebuggerUrl;
        if (endpoint) break;
      } catch {
        /* Browser endpoint is not ready yet. */
      }
      await Bun.sleep(50);
    }
    if (!endpoint) throw new Error("Chromium did not expose an owned page before the deadline.");
    client = await CdpClient.connect(endpoint);
    await client.send("Page.enable");
    await client.navigate(`http://127.0.0.1:${server.port}/`);
    let result: { ok: boolean; error?: string } | undefined;
    while (Date.now() < deadline) {
      result = await client.evaluate("document.body.dataset.result && JSON.parse(document.body.dataset.result)");
      if (result) break;
      await Bun.sleep(25);
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  } finally {
    client?.close();
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

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
