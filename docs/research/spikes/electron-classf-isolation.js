// class-F isolation spike: load the daemon-served SPA in a default-security BrowserWindow, find the
// sandboxed class-F frame, read the probe's verdicts from INSIDE the frame via WebFrameMain, and
// log every network request that leaves loopback, every window.open, every navigation attempt.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const url = fs.readFileSync(process.argv[2], "utf8").trim();
const result = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  egress: [],
  windowOpen: [],
  navigations: [],
  frames: [],
  console: [],
};
const finish = (why) => {
  result.why = why;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
};
app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = new URL(details.url);
    const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname.endsWith(".localhost");
    if (!loop) result.egress.push({ url: details.url, type: details.resourceType, frame: details.frame?.url ?? null });
    cb({ cancel: false }); // observe only: the question is whether the SPA's CSP alone stops it
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {} });
  win.webContents.setWindowOpenHandler((d) => {
    result.windowOpen.push(d.url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, to) => {
    result.navigations.push({ kind: "top", to });
    e.preventDefault();
  });
  win.webContents.on("will-frame-navigate", (e) => {
    result.navigations.push({ kind: "frame", to: e.url, isMain: e.isMainFrame });
  });
  win.webContents.on("console-message", (_e, _level, message) => {
    if (result.console.length < 40) result.console.push(message.slice(0, 160));
  });
  await win.loadURL(url);
  result.topSecureContext = await win.webContents.executeJavaScript(
    "String(window.isSecureContext) + ' ' + location.origin",
  );
  result.topUrlAfterLoad = win.webContents.getURL();
  // Give the SPA time to mount the viewer, mint the capability and load the frame.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const frames = win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame);
    if (frames.length) {
      result.frames = [];
      for (const f of frames) {
        let probe = null,
          _storage = null,
          origin = null;
        try {
          probe = await f.executeJavaScript(
            "document.getElementById('out') && document.getElementById('out').textContent",
          );
        } catch (e) {
          probe = `exec-failed: ${e.message}`;
        }
        try {
          origin = await f.executeJavaScript(
            "location.origin + ' secure=' + window.isSecureContext + ' sandboxedFrame=' + String(window.frameElement === null)",
          );
        } catch (_e) {
          origin = "exec-failed";
        }
        result.frames.push({ url: f.url, origin, probe });
      }
      if (result.frames.some((fr) => typeof fr.probe === "string" && fr.probe.includes("img="))) break;
    }
  }
  result.sessionHistory = win.webContents.navigationHistory.getAllEntries().map((e) => e.url);
  finish("done");
});
setTimeout(() => finish("timeout"), 40000);
