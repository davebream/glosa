// Shell isolation spike (issue #361 item 1): the four checks the class-F spike left unexercised.
// Run: electron electron-shell-isolation.js <file holding a fresh `glosa open --url` URL>
//
// A. preload scoping — a preload attached to the SPA window exposes an API only on the SPA origin;
//    the same window navigated to the class-F origin exposes nothing; the class-F iframe inside the
//    SPA sees nothing; and an ipcMain handler rejects a call whose senderFrame.origin is not the SPA
//    origin even when an UNSCOPED preload hands the call through.
// B. renderer crash after pairing — the crash details Electron reports, the crash-dump directory and
//    session history carry neither the presentation token nor the durable token.
// C. forged Host — a request with a forged Host header from the shell's main process (net.fetch)
//    gets the daemon's 400 exactly as curl does.
// D. handshake — one MessageChannel is constructed per class-F load, and a second injected
//    `glosa:init` with a fresh port opens no channel: the forged port hears nothing.
const { app, BrowserWindow, ipcMain, net, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const url = fs.readFileSync(process.argv[2], "utf8").trim();
const spaOrigin = new URL(url).origin;
const presentationToken = new URLSearchParams(new URL(url).hash.slice(1)).get("p");
const classfOrigin = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
const result = { electron: process.versions.electron, chrome: process.versions.chrome, spaOrigin, classfOrigin };
const finish = (why) => {
  result.why = why;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scoped preload: exposes nothing unless the page origin is the SPA origin exactly (R-P3).
const scopedPreload = path.join(__dirname, "preload-scoped.js");
fs.writeFileSync(
  scopedPreload,
  `const { contextBridge, ipcRenderer } = require("electron");
   if (location.origin === ${JSON.stringify(spaOrigin)}) {
     contextBridge.exposeInMainWorld("glosaShell", { ping: () => ipcRenderer.invoke("glosa:ping") });
   }`,
);
// Unscoped preload: deliberately wrong, to prove the ipcMain guard holds on its own.
const unscopedPreload = path.join(__dirname, "preload-unscoped.js");
fs.writeFileSync(
  unscopedPreload,
  `const { contextBridge, ipcRenderer } = require("electron");
   contextBridge.exposeInMainWorld("glosaShell", { ping: () => ipcRenderer.invoke("glosa:ping") });`,
);

app.whenReady().then(async () => {
  ipcMain.handle("glosa:ping", (event) => {
    const origin = event.senderFrame?.origin ?? null;
    if (origin !== spaOrigin) throw new Error(`rejected: senderFrame.origin=${origin}`);
    return "ok";
  });
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = new URL(details.url);
    const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname.endsWith(".localhost");
    if (!loop) (result.egress ??= []).push(details.url);
    cb({ cancel: false });
  });

  // ---------- A + D: SPA window with the scoped preload ----------
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: scopedPreload } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // D: count MessageChannel constructions in the top frame before the viewer mounts.
  win.webContents.on("dom-ready", () => {
    void win.webContents.executeJavaScript(
      `(() => { const O = window.MessageChannel; window.__mc = 0; window.MessageChannel = function () { window.__mc += 1; return new O(); }; })()`,
    );
  });
  await win.loadURL(url);
  result.A_spaWindow = {
    exposed: await win.webContents.executeJavaScript("typeof window.glosaShell"),
    ping: await win.webContents.executeJavaScript("window.glosaShell.ping().then(v => v, e => 'threw: ' + e.message)"),
  };
  // Wait for the class-F frame and the probe's verdict.
  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    await sleep(500);
    frame = win.webContents.mainFrame.framesInSubtree.find((f) => f !== win.webContents.mainFrame && f.url.startsWith(classfOrigin));
  }
  if (!frame) return finish("no class-F frame");
  for (let i = 0; i < 20; i++) {
    const t = await frame.executeJavaScript("document.getElementById('out')?.textContent ?? ''").catch(() => "");
    if (t.includes("img=")) break;
    await sleep(500);
  }
  const frameUrl = frame.url;
  result.A_classfFrame = {
    url: frameUrl.replace(/([?&]cap=)[^&]+/, "$1…"),
    origin: await frame.executeJavaScript("location.origin"),
    exposed: await frame.executeJavaScript("typeof window.glosaShell"),
    probe: await frame.executeJavaScript("document.getElementById('out')?.textContent ?? ''"),
  };
  // D: one channel per load; a forged second init hears nothing.
  result.D_handshake = {
    messageChannelsConstructed: await win.webContents.executeJavaScript("window.__mc"),
    forgedPortHeard: await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const iframe = document.querySelector("iframe");
      const ch = new MessageChannel();
      const heard = [];
      ch.port1.onmessage = (e) => heard.push(JSON.stringify(e.data).slice(0, 80));
      ch.port1.start();
      iframe.contentWindow.postMessage({ type: "glosa:init", nonce: "forged" }, "*", [ch.port2]);
      setTimeout(() => resolve(heard), 1500);
    })`),
    bridgeStillAlive: await frame.executeJavaScript("document.getElementById('out')?.textContent ?? ''").then((t) => t.includes("img=")),
  };

  // ---------- B: crash the paired renderer ----------
  const durableToken = await win.webContents.executeJavaScript("localStorage.getItem('glosa_token')");
  const gone = new Promise((resolve) => win.webContents.once("render-process-gone", (_e, details) => resolve(details)));
  win.webContents.forcefullyCrashRenderer();
  const details = await gone;
  const history = win.webContents.navigationHistory.getAllEntries().map((e) => e.url);
  const dumpsDir = app.getPath("crashDumps");
  const dumps = fs.existsSync(dumpsDir) ? fs.readdirSync(dumpsDir, { recursive: true }) : [];
  const haystack = JSON.stringify({ details, history, dumps, title: win.getTitle(), url: win.webContents.getURL() });
  result.B_crash = {
    reason: details.reason,
    exitCode: details.exitCode,
    haystackBytes: haystack.length,
    presentationTokenPresent: presentationToken ? haystack.includes(presentationToken) : "no p= in URL",
    durableTokenPresent: durableToken ? haystack.includes(durableToken) : "no durable token in storage",
    historyUrls: history,
    crashDumpFiles: dumps.length,
  };

  // ---------- C: forged Host from the main process ----------
  const daemon = `http://127.0.0.1:${new URL(url).port}`;
  const forged = await net.fetch(`${daemon}/api/handshake`, { headers: { Host: "evil.example" } }).catch((e) => ({ status: `error: ${e.message}` }));
  const honest = await net.fetch(`${daemon}/api/handshake`).catch((e) => ({ status: `error: ${e.message}` }));
  const nodeForged = await new Promise((resolve) => {
    const req = require("node:http").request({ host: "127.0.0.1", port: Number(new URL(url).port), path: "/api/handshake", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode));
    req.on("error", (e) => resolve(`error: ${e.message}`));
    req.end();
  });
  result.C_forgedHost = { chromiumNetFetchForged: forged.status, nodeHttpForged: nodeForged, honestStatus: honest.status };

  // ---------- A: the same window navigated to the class-F origin ----------
  const loadOrTimeout = (w, u) => {
    const fails = [];
    // What the real shell does for every window (readiness note §3): deny top-frame navigation away.
    w.webContents.on("will-navigate", (e, to) => { fails.push({ deniedNavigation: to }); e.preventDefault(); });
    w.webContents.on("did-fail-load", (_e, code, desc, failedUrl) => fails.push({ code, desc, failedUrl }));
    return Promise.race([w.loadURL(u).then(() => "loaded", (e) => `rejected: ${e.message}`), sleep(8000).then(() => "timeout")]).then((r) => ({ r, fails }));
  };
  const win2 = new BrowserWindow({ show: false, webPreferences: { preload: scopedPreload } });
  result.A_scopedLoad = await loadOrTimeout(win2, frameUrl);
  result.A_scopedPreloadOnClassfOrigin = {
    origin: await win2.webContents.executeJavaScript("location.origin"),
    exposed: await win2.webContents.executeJavaScript("typeof window.glosaShell"),
  };
  const win3 = new BrowserWindow({ show: false, webPreferences: { preload: unscopedPreload } });
  result.A_unscopedLoad = await loadOrTimeout(win3, frameUrl);
  result.A_unscopedPreloadOnClassfOrigin = {
    origin: await win3.webContents.executeJavaScript("location.origin"),
    exposed: await win3.webContents.executeJavaScript("typeof window.glosaShell"),
    ping: await win3.webContents.executeJavaScript("window.glosaShell.ping().then(v => v, e => 'threw: ' + e.message)"),
  };

  finish("done");
});
setTimeout(() => finish("timeout"), 60000);
