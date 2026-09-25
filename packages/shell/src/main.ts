// SPDX-License-Identifier: Apache-2.0
// glosa desktop shell — the Electron main process. A window on the daemon-served SPA and nothing
// more: the daemon and SPA are what the CLI installed, served unbundled (requirements §4 exception
// covers packaging only). Every rule here is a call into policy.ts; this file is wiring.
//
// Contracts: docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md (R-O*, R-P*),
// docs/research/2026-09-25-desktop-shell-readiness.md §3 (what Electron's defaults leave open),
// docs/appendices/A3-security.md "Desktop shell".
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import {
  compatibility,
  egressDecision,
  loopbackApiOrigin,
  navigationDecision,
  parseOpenEnvelope,
  scrubChildEnv,
  splitPresentationToken,
} from "./policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  version: string;
  glosa: { minimumDaemon: string; releases: string };
};
const PRELOAD = join(here, "preload.cjs");
const log = (line: string): void => {
  process.stderr.write(`[glosa-shell] ${line}\n`);
};

// ---------- the CLI is the install of truth (R-O1) ----------

/** Where the CLI is when the app was launched from the Dock with a bare PATH. */
function resolveCli(): string {
  const override = process.env.GLOSA_SHELL_CLI;
  if (override) return override;
  const candidates = [
    join(homedir(), ".glosa", "bin", "glosa"),
    join(homedir(), ".bun", "bin", "glosa"),
    "/opt/homebrew/bin/glosa",
    "/usr/local/bin/glosa",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "glosa";
}

/** `glosa open <target> --url --json`: registers the folder, ensures a daemon (the CLI's own
 * spawn-only-when-absent, R-O3), mints a one-shot presentation token into the URL fragment. */
function runOpen(target: string, focus: string | null = null): Promise<{ url: string; slug: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCli(),
      ["open", target, ...(focus ? [focus] : []), "--url", "--json"],
      { env: scrubChildEnv(process.env), timeout: 30_000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        if (error && !stdout) return reject(new Error(`glosa open failed: ${stderr.trim() || error.message}`));
        try {
          resolve(parseOpenEnvelope(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

async function handshake(origin: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${origin}/api/handshake`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- token handover (R-P1, R-P2): one token per window load, never in the URL ----------

const pendingTokens = new Map<number, string>();
const spaOrigins = new Map<number, string>();

function blockingScreen(title: string, command: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>glosa</title><body style="font:16px/1.5 -apple-system,system-ui;margin:3rem;max-width:40rem"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>Run this in a terminal, then reopen the folder:</p><pre style="padding:1rem;background:#f4f4f4">${esc(command)}</pre><p>The app never changes the glosa install itself.</p>`,
  )}`;
}

/**
 * Opens `target` in `existing` when that window already serves the same origin, otherwise in a new
 * window created for that origin. The origin is only known after `glosa open` answers, and the
 * preload must learn it at window creation (R-P3), which is why the window comes second.
 */
async function openInWindow(
  target: string,
  existing: BrowserWindow | null,
  focus: string | null = null,
): Promise<BrowserWindow> {
  let opened: { url: string; slug: string };
  const started = Date.now();
  try {
    opened = await runOpen(target, focus);
  } catch (e) {
    log(`glosa open failed after ${Date.now() - started} ms via ${resolveCli()}: ${(e as Error).message}`);
    const win = existing ?? createWindow(null);
    await win.loadURL(blockingScreen("glosa could not open that folder", (e as Error).message));
    return win;
  }
  log(`glosa open answered in ${Date.now() - started} ms for ${opened.slug}`);
  const origin = new URL(opened.url).origin;
  const win = existing && spaOrigins.get(existing.webContents.id) === origin ? existing : createWindow(origin);
  const compat = compatibility(await handshake(loopbackApiOrigin(origin)), pkg.glosa.minimumDaemon);
  if (compat.state !== "ok") {
    log(`compatibility: ${compat.state}`);
    const titles = {
      down: "The glosa daemon is not answering",
      "too-old": `This app needs glosa ${pkg.glosa.minimumDaemon} or newer`,
      incompatible: "This app and the glosa daemon speak different contracts",
    };
    await win.loadURL(blockingScreen(titles[compat.state], compat.command));
    return win;
  }
  const { tokenlessUrl, token } = splitPresentationToken(opened.url);
  if (token) pendingTokens.set(win.webContents.id, token);
  await win.loadURL(tokenlessUrl);
  return win;
}

function createWindow(origin: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "glosa",
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload reads this to decide whether to expose anything at all (R-P3). It is the
      // origin the CLI links to, learned from `glosa open`; a window with no origin exposes nothing.
      additionalArguments: origin ? [`--glosa-spa-origin=${origin}`] : [],
    },
  });
  const wc = win.webContents;
  if (origin) spaOrigins.set(wc.id, origin);
  // What Electron's defaults leave open for the TOP frame (readiness note §3).
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    const origin = spaOrigins.get(wc.id);
    if (!origin || navigationDecision(url, origin) === "deny") {
      log(`denied navigation to ${new URL(url).origin}`);
      event.preventDefault();
    }
  });
  wc.session.on("will-download", (event) => event.preventDefault());
  // A `beforeunload` guard in the SPA (unsaved edits) would otherwise cancel the close silently.
  wc.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Stay", "Leave"],
      defaultId: 0,
      cancelId: 0,
      message: "This page has unsaved edits.",
      detail: "Leaving discards them.",
    });
    if (choice === 1) event.preventDefault();
  });
  wc.on("render-process-gone", (_e, details) => log(`renderer gone: ${details.reason}`));
  win.on("closed", () => {
    pendingTokens.delete(wc.id);
    spaOrigins.delete(wc.id);
  });
  return win;
}

async function chooseFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts = { properties: ["openDirectory" as const], message: "Choose a folder to open in glosa" };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0] ?? null;
}

async function openFolderFlow(existing: BrowserWindow | null): Promise<void> {
  const folder = await chooseFolder(existing);
  if (!folder) return;
  await openInWindow(folder, existing);
}

function buildMenu(): void {
  const focused = () => BrowserWindow.getFocusedWindow();
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolderFlow(focused()) },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => void openFolderFlow(null) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      // No Cmd+1–3, no Cmd+K, no Ctrl+Tab: those belong to the SPA (docs/accessibility.md).
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as Electron.MenuItemConstructorOptions]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          // Explicit, on click, nothing scheduled: the app makes no update check on its own
          // (invariant 5; A6 §F33). This opens the releases page in the user's browser.
          label: "Check for Updates…",
          click: () => void shell.openExternal(pkg.glosa.releases),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installIpc(): void {
  const fromSpa = (event: Electron.IpcMainInvokeEvent): boolean => {
    const origin = spaOrigins.get(event.sender.id);
    // The class-F document reports `null` here (opaque origin under its CSP sandbox); this check,
    // not the preload's, is the boundary (readiness note §1b).
    return Boolean(origin) && event.senderFrame?.origin === origin;
  };
  ipcMain.handle("glosa:presentation-token", (event) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    const token = pendingTokens.get(event.sender.id) ?? null;
    pendingTokens.delete(event.sender.id);
    return token;
  });
  ipcMain.handle("glosa:open-folder", async (event) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    await openFolderFlow(BrowserWindow.fromWebContents(event.sender));
  });
  ipcMain.handle("glosa:notify", (event, payload: unknown) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    const p = payload as { title?: unknown; body?: unknown } | null;
    const title = typeof p?.title === "string" ? p.title.slice(0, 120) : "glosa";
    const body = typeof p?.body === "string" ? p.body.slice(0, 400) : "";
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
}

function installEgressGate(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const decision = egressDecision(details.url);
    if (decision === "cancel") log(`cancelled egress to ${details.url.slice(0, 120)}`);
    callback({ cancel: decision === "cancel" });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

app.whenReady().then(async () => {
  installEgressGate();
  installIpc();
  buildMenu();
  // `glosa-shell <folder> [artifact]`, the same two positionals `glosa open` takes.
  const positionals = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  const target = positionals[0] ?? null;
  if (target) {
    await openInWindow(target, null, positionals[1] ?? null);
    return;
  }
  await openFolderFlow(null);
  if (BrowserWindow.getAllWindows().length === 0) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void openFolderFlow(null);
});

// R-O4: the daemon outlives the shell. The shell delegated every spawn to the CLI, owns no daemon,
// and stops nothing on quit (policy.quitDecision always answers "leave" for it).
app.on("window-all-closed", () => {
  app.quit();
});
