// Browser tab rendering spike (issue #440, open question 1): WebContentsView or the <webview> tag.
// Run from packages/shell: ./node_modules/.bin/electron ../../docs/research/spikes/electron-browser-tab.cjs
//
// Both candidates host a page in a persistent partition of its own while the host window keeps a
// loopback-only egress gate on the default session, as the shell does. Each is measured against
// the brief's UX contract:
//   overlay   - does a DOM element in the host page draw over the web page? (window composite)
//   reparent  - does the page survive its element or view being moved, as the dock moves panels?
//   keys      - does a key pressed in the page reach the host document; can the main process see it?
//   isolation - is the partition's storage apart from the host origin's; does each session keep
//               its own request policy?
//   hidden    - can the main process read a page that is not showing (an agent reading a
//               background tab)?
//   frames    - (webview) can a sandboxed or cross-origin child frame create a <webview>?
// It prints one JSON result and exits. It reaches the internet once, for example.com, to prove the
// partition's policy is its own.
const { app, BrowserWindow, WebContentsView, session, nativeImage } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PARTITION = "persist:spike-browser";
const result = { electron: process.versions.electron, chrome: process.versions.chrome };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tab-spike-"));

function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[new URL(req.url, "http://x").pathname];
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body());
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

let portA, portB;
const page = () => `<!doctype html><title>Foreign page</title>
  <body style="margin:0;background:#fff;height:100vh"><input id="f" autofocus>
  <script>window.__born = performance.timeOrigin + performance.now();
  window.__keys = []; addEventListener("keydown", (e) => window.__keys.push((e.metaKey ? "Meta+" : "") + e.key));
  document.cookie = "site=foreign; max-age=3600";</script></body>`;
const probe = () => `<!doctype html><title>Probe</title><script>
  window.__token = localStorage.getItem("glosa-token");</script>`;
const makeWebview = () => `<!doctype html><script>
  const w = document.createElement("webview"); w.setAttribute("src", "http://127.0.0.1:${portB}/page");
  document.body.append(w);</script>`;
const host = () => `<!doctype html><title>Host</title>
  <style>body{margin:0;font:14px system-ui} #bar{height:100px;background:#eee}
  #slot,#slot2{position:absolute;left:0;top:100px;width:600px;height:400px}
  #slot2{left:620px} webview{width:100%;height:100%;display:flex}
  #overlay{position:fixed;left:50px;top:150px;width:100px;height:100px;background:#f0f;z-index:10}</style>
  <div id="bar"></div><div id="slot"></div><div id="slot2"></div><div id="overlay" hidden></div>
  <iframe id="sbx" sandbox="allow-scripts" srcdoc="${makeWebview().replace(/"/g, "&quot;")}" style="display:none"></iframe>
  <script>localStorage.setItem("glosa-token", "secret");
  window.__hostKeys = []; addEventListener("keydown", (e) => window.__hostKeys.push((e.metaKey ? "Meta+" : "") + e.key));
  window.__fetchExternal = () => fetch("https://example.com/").then(() => "reached", (e) => "blocked: " + e.message);</script>`;

// Samples the on-screen window at host CSS point (x, y): "overlay" (magenta), "page" (white), or what it saw.
function sampleWindow(win, x, y) {
  const id = win.getMediaSourceId().split(":")[1];
  const out = path.join(tmp, `cap-${Date.now()}.png`);
  try {
    execFileSync("screencapture", ["-x", "-o", `-l${id}`, out]);
  } catch (e) {
    return `capture failed: ${e.message.split("\n")[0]}`;
  }
  const img = nativeImage.createFromPath(out);
  const { width } = img.getSize();
  const scale = width / win.getContentBounds().width;
  const titlebar = img.getSize().height / scale - win.getContentBounds().height;
  const bmp = img.toBitmap();
  const px = Math.round(x * scale),
    py = Math.round((y + titlebar) * scale);
  const i = (py * width + px) * 4;
  const [b, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]];
  if (r > 200 && b > 200 && g < 60) return "overlay";
  if (r > 240 && g > 240 && b > 240) return "page";
  return `rgb(${r},${g},${b})`;
}

async function webContentsViewRun(win) {
  const r = {};
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const loads = [];
  view.webContents.on("did-finish-load", () => loads.push(view.webContents.getURL()));
  const mainSeen = [];
  view.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown") mainSeen.push((input.meta ? "Meta+" : "") + input.key);
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 100, width: 600, height: 400 });
  await view.webContents.loadURL(`http://127.0.0.1:${portB}/page`);
  const born = await view.webContents.executeJavaScript("window.__born");

  await win.webContents.executeJavaScript("document.getElementById('overlay').hidden = false");
  await sleep(300);
  r.overlay = sampleWindow(win, 100, 200);
  await win.webContents.executeJavaScript("document.getElementById('overlay').hidden = true");

  let t = performance.now();
  const still = await view.webContents.capturePage();
  r.stillMs = Math.round(performance.now() - t);
  r.stillSize = still.getSize();
  t = performance.now();
  await view.webContents.capturePage();
  r.secondStillMs = Math.round(performance.now() - t);

  // Moving the view: to another rectangle, and out of the window and back (a hidden tab).
  view.setBounds({ x: 620, y: 100, width: 600, height: 400 });
  win.contentView.removeChildView(view);
  t = performance.now();
  r.hiddenRead = await view.webContents.executeJavaScript("document.title");
  r.hiddenReadMs = Math.round(performance.now() - t);
  win.contentView.addChildView(view);
  await sleep(200);
  r.reparent = (await view.webContents.executeJavaScript("window.__born")) === born ? "kept" : "reloaded";
  r.loads = loads.length;

  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "keyDown", keyCode: "w", modifiers: ["meta"] });
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: "w", modifiers: ["meta"] });
  view.webContents.sendInputEvent({ type: "keyDown", keyCode: "a" });
  view.webContents.sendInputEvent({ type: "char", keyCode: "a" });
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: "a" });
  await sleep(200);
  r.keys = {
    page: await view.webContents.executeJavaScript("window.__keys"),
    host: await win.webContents.executeJavaScript("window.__hostKeys.splice(0)"),
    mainProcess: mainSeen,
  };

  await view.webContents.loadURL(`http://127.0.0.1:${portA}/probe`);
  r.isolation = {
    hostTokenSeenInPartition: await view.webContents.executeJavaScript("window.__token"),
    partitionCookieInDefaultSession: (await session.defaultSession.cookies.get({ name: "site" })).length,
    partitionCookieInPartition: (await session.fromPartition(PARTITION).cookies.get({ name: "site" })).length,
  };
  try {
    await view.webContents.loadURL("https://example.com/");
    r.isolation.partitionReachesInternet = await view.webContents.executeJavaScript("document.title");
  } catch (e) {
    r.isolation.partitionReachesInternet = `failed: ${e.message}`;
  }
  win.contentView.removeChildView(view);
  view.webContents.close();
  return r;
}

async function webviewRun(win) {
  const r = { attachRequests: [] };
  let guest = null;
  win.webContents.on("will-attach-webview", (event, prefs, params) => {
    r.attachRequests.push({ src: params.src, eventKeys: Object.keys(event).filter((k) => k !== "sender") });
    // The lock-down the shell would apply: its own partition, no preload, sandboxed, http(s) only.
    delete prefs.preload;
    prefs.partition = PARTITION;
    prefs.sandbox = true;
    prefs.contextIsolation = true;
    prefs.nodeIntegration = false;
    if (!/^https?:/.test(params.src)) event.preventDefault();
  });
  const attached = new Promise((resolve) =>
    win.webContents.once("did-attach-webview", (_e, wc) => {
      guest ??= wc;
      resolve(wc);
    }),
  );
  await win.webContents.executeJavaScript(`
    const w = document.createElement("webview");
    w.id = "wv"; w.setAttribute("src", "http://127.0.0.1:${portB}/page");
    document.getElementById("slot").append(w); true`);
  const wc = await attached;
  const loads = [];
  wc.on("did-finish-load", () => loads.push(wc.getURL()));
  const mainSeen = [];
  wc.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown") mainSeen.push((input.meta ? "Meta+" : "") + input.key);
  });
  await new Promise((resolve) => (wc.isLoading() ? wc.once("did-finish-load", resolve) : resolve()));
  const born = await wc.executeJavaScript("window.__born");

  await win.webContents.executeJavaScript("document.getElementById('overlay').hidden = false");
  await sleep(300);
  r.overlay = sampleWindow(win, 100, 200);
  await win.webContents.executeJavaScript("document.getElementById('overlay').hidden = true");

  // The dock moves a panel's element to another group's container; a hidden tab is display:none.
  await win.webContents.executeJavaScript("document.getElementById('slot').style.display = 'none'; true");
  await sleep(200);
  try {
    r.hiddenRead = await Promise.race([wc.executeJavaScript("document.title"), sleep(3000).then(() => "timed out")]);
  } catch (e) {
    r.hiddenRead = `failed: ${e.message}`;
  }
  await win.webContents.executeJavaScript("document.getElementById('slot').style.display = ''; true");
  await win.webContents.executeJavaScript(
    "document.getElementById('slot2').append(document.getElementById('wv')); true",
  );
  await sleep(1500);
  try {
    const now = await Promise.race([wc.executeJavaScript("window.__born"), sleep(3000).then(() => "timed out")]);
    r.reparent = now === born ? "kept" : wc.isDestroyed() ? "guest destroyed" : "reloaded";
  } catch (e) {
    r.reparent = `guest gone: ${e.message}`;
  }
  r.loadsAfterFirst = loads.length;
  r.guestsAttached = r.attachRequests.length;

  if (!wc.isDestroyed()) {
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: "w", modifiers: ["meta"] });
    wc.sendInputEvent({ type: "keyUp", keyCode: "w", modifiers: ["meta"] });
    await sleep(200);
    r.keys = {
      page: await wc.executeJavaScript("window.__keys"),
      host: await win.webContents.executeJavaScript("window.__hostKeys.splice(0)"),
      mainProcess: mainSeen,
    };
  }

  // Child frames: a sandboxed srcdoc frame (like class-F's) and a cross-origin frame try to make one.
  const before = r.attachRequests.length;
  await win.webContents.executeJavaScript(`
    document.getElementById("sbx").style.display = "block";
    const x = document.createElement("iframe"); x.src = "http://127.0.0.1:${portB}/mkwv"; document.body.append(x); true`);
  await sleep(2000);
  r.childFrameAttachRequests = r.attachRequests.slice(before);
  return r;
}

// The same <webview>, inside glosa's own dock (vendored dockview, defaultRenderer "always" as in
// packages/spa/src/dock.js): does the page survive a tab switch, a move to another group and a
// move back, which is what a person does when they drag tabs around?
async function webviewInDockRun(win) {
  const vendor = path.join(__dirname, "../../../packages/spa/src/vendor");
  const port = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://x").pathname;
      if (name === "/dockview.js")
        res
          .writeHead(200, { "content-type": "text/javascript" })
          .end(fs.readFileSync(path.join(vendor, "dockview.js")));
      else if (name === "/dockview.css")
        res.writeHead(200, { "content-type": "text/css" }).end(fs.readFileSync(path.join(vendor, "dockview.css")));
      else if (name === "/dock")
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html>
        <link rel="stylesheet" href="/dockview.css"><style>html,body,#d{margin:0;height:100%}</style><div id="d"></div>
        <script type="module">import { createDockview } from "/dockview.js";
        const api = createDockview(document.getElementById("d"), { defaultRenderer: "always", disableFloatingGroups: true,
          createComponent: ({ id }) => { const element = document.createElement("div"); element.style.height = "100%";
            return { element, init(p) { if (p.params.kind === "browser") { const w = document.createElement("webview");
              w.setAttribute("src", p.params.url); w.style.height = "100%"; w.style.display = "flex"; element.append(w); }
              else element.textContent = "document"; } }; } });
        window.__dock = api;
        api.addPanel({ id: "doc", component: "pane", params: { kind: "doc" } });
        api.addPanel({ id: "web", component: "pane", params: { kind: "browser", url: "http://127.0.0.1:${portB}/page" } });
        </script>`);
      else res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  const r = { attaches: [] };
  let guest = null,
    step = "load";
  const onAttach = (_e, wc) => {
    r.attaches.push({ step, guestId: wc.id });
    guest = wc;
  };
  win.webContents.on("did-attach-webview", onAttach);
  win.webContents.on("will-attach-webview", (_event, prefs) => {
    delete prefs.preload;
    prefs.partition = PARTITION;
    prefs.sandbox = true;
    prefs.contextIsolation = true;
    prefs.nodeIntegration = false;
  });
  await win.loadURL(`http://127.0.0.1:${port}/dock`);
  for (let i = 0; i < 50 && !guest; i++) await sleep(100);
  await new Promise((resolve) => (guest.isLoading() ? guest.once("did-finish-load", resolve) : resolve()));
  const born = await guest.executeJavaScript("window.__born");
  const alive = async () => {
    if (guest.isDestroyed()) return "guest destroyed";
    const now = await Promise.race([guest.executeJavaScript("window.__born"), sleep(3000).then(() => "timed out")]);
    return now === born ? "kept" : "reloaded";
  };
  step = "switch away";
  await win.webContents.executeJavaScript(`__dock.getPanel("doc").api.setActive(); true`);
  await sleep(400);
  r.whileAnotherTabIsActive = await alive();
  r.hiddenRead = guest.isDestroyed() ? "guest destroyed" : await guest.executeJavaScript("document.title");
  step = "switch back";
  await win.webContents.executeJavaScript(`__dock.getPanel("web").api.setActive(); true`);
  await sleep(400);
  r.afterTabSwitch = await alive();
  step = "move to another group";
  await win.webContents.executeJavaScript(`
    __dock.addPanel({ id: "doc2", component: "pane", params: { kind: "doc" }, position: { referencePanel: "doc", direction: "right" } });
    const target = __dock.getPanel("doc2").group;
    __dock.getPanel("web").api.moveTo({ group: target, position: "center" }); true`);
  await sleep(800);
  r.afterMoveToAnotherGroup = await alive();
  step = "move to new split";
  await win.webContents.executeJavaScript(
    `__dock.getPanel("web").api.moveTo({ group: __dock.getPanel("doc").group, position: "right" }); true`,
  );
  await sleep(800);
  r.afterMoveToNewSplit = await alive();
  win.webContents.off("did-attach-webview", onAttach);
  r.webviewOverlaid = await win.webContents.executeJavaScript(
    `!!document.querySelector("webview").closest(".dv-render-overlay")`,
  );
  return r;
}

// The SPA's own CSP (packages/daemon/src/security/csp.ts, spaCspHeaders, verbatim with a made-up
// class-F port): does it let the host page attach a <webview>? It must not have to change.
async function webviewUnderSpaCspRun(win) {
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "frame-src http://127.0.0.1:4647; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none';";
  const port = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = new URL(req.url, "http://x").pathname;
      if (name === "/csp")
        res
          .writeHead(200, { "content-type": "text/html", "content-security-policy": csp })
          .end(`<!doctype html><div id="slot" style="height:300px"></div><script src="/csp.js"></script>`);
      else if (name === "/csp.js")
        res
          .writeHead(200, { "content-type": "text/javascript", "content-security-policy": csp })
          .end(
            `const w = document.createElement("webview"); w.setAttribute("src", "http://127.0.0.1:${portB}/page"); w.style.height = "300px"; w.style.display = "flex"; document.getElementById("slot").append(w);`,
          );
      else res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  const r = { cspViolations: [] };
  let guest = null;
  win.webContents.on("did-attach-webview", (_e, wc) => {
    guest = wc;
  });
  win.webContents.on("console-message", (e) => {
    const m = e.message ?? "";
    if (/Content Security Policy/i.test(m)) r.cspViolations.push(m.slice(0, 160));
  });
  await win.loadURL(`http://127.0.0.1:${port}/csp`);
  for (let i = 0; i < 40 && !guest; i++) await sleep(100);
  if (!guest) {
    r.attached = false;
    return r;
  }
  await new Promise((resolve) => (guest.isLoading() ? guest.once("did-finish-load", resolve) : resolve()));
  r.attached = true;
  r.title = await guest.executeJavaScript("document.title");
  return r;
}

app.whenReady().then(async () => {
  portB = await serve({ "/page": page, "/mkwv": makeWebview });
  portA = await serve({ "/host": host, "/probe": probe });
  // The shell's gate on its own session: loopback http only.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const u = new URL(d.url);
    const loop = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname.endsWith("localhost"));
    cb({ cancel: !(loop || u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "devtools:") });
  });
  // The browser partition's own policy: http(s) allowed; permissions and downloads refused.
  const browser = session.fromPartition(PARTITION);
  const seen = [];
  browser.webRequest.onBeforeRequest((d, cb) => {
    seen.push(new URL(d.url).origin);
    cb({ cancel: !/^https?:$/.test(new URL(d.url).protocol) });
  });
  browser.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  browser.on("will-download", (e) => e.preventDefault());

  const win = new BrowserWindow({
    width: 1240,
    height: 560,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  await win.loadURL(`http://127.0.0.1:${portA}/host`);
  result.hostFetchToInternet = await win.webContents.executeJavaScript("window.__fetchExternal()");
  result.webContentsView = await webContentsViewRun(win);
  await win.loadURL(`http://127.0.0.1:${portA}/host`);
  result.webview = await webviewRun(win);
  result.webviewInDock = await webviewInDockRun(win);
  result.webviewUnderSpaCsp = await webviewUnderSpaCspRun(win);
  result.partitionOrigins = [...new Set(seen)];
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
});
