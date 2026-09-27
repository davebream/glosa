// SPDX-License-Identifier: Apache-2.0
// glosa desktop shell — the Electron main process. A window on the daemon-served SPA and nothing
// more: the daemon and SPA are whatever the recorded executable (~/.glosa/bin/glosa) is, served
// unbundled. Packaged, the app also carries a CLI and a Bun of its own under Contents/Resources,
// used only when nothing is recorded (#371). Every rule here is a call into policy.ts; this file
// is wiring.
//
// Contracts: docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md (R-O*, R-P*),
// docs/research/2026-09-25-desktop-shell-readiness.md §3 (what Electron's defaults leave open),
// docs/appendices/A3-security.md "Desktop shell".
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell } from "electron";
import {
  cliCandidates,
  compatibility,
  egressDecision,
  linkFromArgv,
  loopbackApiOrigin,
  navigationDecision,
  needsConfirmation,
  type OpenedWorkspace,
  openArgsFor,
  parseGlosaUrl,
  parseOpenEnvelope,
  type RoutedWindow,
  representedFile,
  revealTarget,
  scrubChildEnv,
  splitPresentationToken,
  surfaceKind,
  windowFor,
  withRoute,
} from "./policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The name the app menu, About panel and userData path use. The Dock and the app switcher read the
// bundle instead: packaged, that is productName in package.json; unpackaged, scripts/brand-electron.ts
// rewrites node_modules/electron's bundle after install so a `bun run start` also says glosa.
app.setName("glosa");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  version: string;
  glosa: { minimumDaemon: string; releases: string };
};
const PRELOAD = join(here, "preload.cjs");
const log = (line: string): void => {
  process.stderr.write(`[glosa-shell] ${line}\n`);
};

// ---------- the recorded executable is the install of truth (R-O1) ----------

/** Where the CLI is, also when the app was launched from the Dock with a bare PATH (#371). */
function resolveCli(): string {
  const candidates = cliCandidates({
    override: process.env.GLOSA_SHELL_CLI,
    glosaHome: process.env.GLOSA_HOME,
    homeDir: homedir(),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
  });
  // existsSync follows symlinks, so a dangling recorded executable reads as absent. An override is
  // used as given: the harness names exactly what it wants run.
  if (process.env.GLOSA_SHELL_CLI) return candidates[0] ?? "glosa";
  for (const c of candidates) if (c === "glosa" || existsSync(c)) return c;
  return "glosa";
}

/** `glosa open <args> --url --json`: registers the folder, ensures a daemon (the CLI's own
 * spawn-only-when-absent, R-O3), mints a one-shot presentation token into the URL fragment. `args`
 * are the positionals and flags before `--url --json`: a target and focus, or what a `glosa://`
 * link maps to (`openArgsFor`). */
function runOpen(args: readonly string[]): Promise<OpenedWorkspace> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveCli(),
      ["open", ...args, "--url", "--json"],
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

/**
 * What the shell knows about each window, keyed by its webContents id (#160). `origin` is set at
 * creation (the preload needs it, R-P3); the rest once `glosa open` has answered. `folder` is the
 * daemon's absolute `worktree_path` and `slug` the workspace's, never the argument the shell was
 * given; `kind` is the surface the link opened, read from its fragment, which is what the
 * `glosa://` handler (#392) routes windows by.
 */
interface WindowState {
  origin: string;
  folder: string | null;
  slug: string | null;
  kind: "desk" | "companion" | null;
}
const windows = new Map<number, WindowState>();

function blockingScreen(title: string, command: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>glosa</title><body style="font:16px/1.5 -apple-system,system-ui;margin:3rem;max-width:40rem"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>Run this in a terminal, then reopen the folder:</p><pre style="padding:1rem;background:#f4f4f4">${esc(command)}</pre><p>The app never changes the glosa install itself.</p>`,
  )}`;
}

interface OpenOptions {
  /** The window `glosa open`'s answer goes into, or null for a new window for its origin. */
  reuse: (opened: OpenedWorkspace, origin: string) => BrowserWindow | null;
  /** Where a refusal is shown; null creates a window for it. */
  errorWindow: BrowserWindow | null;
  /** Rewrites the answered URL's route before it loads (a link's kind and mode). */
  route?: (url: string) => string;
}

/**
 * Runs `glosa open` with `args` and loads its answer into the window `reuse` picks, or into a new
 * window for that origin. The origin is only known after `glosa open` answers, and the preload must
 * learn it at window creation (R-P3), which is why the window comes second.
 */
async function openWith(args: readonly string[], options: OpenOptions): Promise<BrowserWindow> {
  let opened: OpenedWorkspace;
  const started = Date.now();
  try {
    opened = await runOpen(args);
  } catch (e) {
    log(`glosa open failed after ${Date.now() - started} ms via ${resolveCli()}: ${(e as Error).message}`);
    const win = options.errorWindow ?? createWindow(null);
    await win.loadURL(blockingScreen("glosa could not open that folder", (e as Error).message));
    return win;
  }
  log(`glosa open answered in ${Date.now() - started} ms for ${opened.slug}`);
  const url = options.route ? options.route(opened.url) : opened.url;
  const origin = new URL(url).origin;
  const win = options.reuse(opened, origin) ?? createWindow(origin);
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
  const { tokenlessUrl, token } = splitPresentationToken(url);
  if (token) pendingTokens.set(win.webContents.id, token);
  windows.set(win.webContents.id, {
    origin,
    folder: opened.path,
    slug: opened.slug,
    kind: surfaceKind(url),
  });
  await win.loadURL(tokenlessUrl);
  return win;
}

/** Opens `target` in `existing` when that window already serves the same origin, otherwise in a
 * new window: the folder picker and a folder named on launch. */
function openInWindow(
  target: string,
  existing: BrowserWindow | null,
  focus: string | null = null,
): Promise<BrowserWindow> {
  return openWith([target, ...(focus ? [focus] : [])], {
    reuse: (_opened, origin) => (existing && windows.get(existing.webContents.id)?.origin === origin ? existing : null),
    errorWindow: existing,
  });
}

/** Every open window as link routing sees it. */
function routedWindows(): RoutedWindow[] {
  const routed: RoutedWindow[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    const state = windows.get(win.webContents.id);
    if (state) routed.push({ id: win.webContents.id, origin: state.origin, folder: state.folder, kind: state.kind });
  }
  return routed;
}

/**
 * Asks before a link opens a folder no window shows (#392). `GLOSA_SHELL_CONFIRM=yes` answers for
 * the person, and is read only by an unpackaged app: it is how the real-Electron test drives a link
 * without a dialog, never a way to silence the question in a shipped app.
 */
async function confirmOpen(path: string): Promise<boolean> {
  if (!app.isPackaged && process.env.GLOSA_SHELL_CONFIRM === "yes") return true;
  const answer = await dialog.showMessageBox({
    type: "question",
    buttons: ["Open", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Open ${path} in glosa?`,
    detail: "A glosa:// link asked to open it. Links can come from any page or app.",
  });
  return answer.response === 0;
}

/**
 * A `glosa://open?...` link (#392): parsed and refused unless well formed, confirmed when no window
 * shows its folder, opened through `glosa open` like any other open, then routed. A window is
 * reused only when origin, folder and kind all match; otherwise the link gets a new window.
 */
async function openLink(url: string): Promise<void> {
  const link = parseGlosaUrl(url);
  if (!link) {
    log("ignored a glosa:// link that does not parse");
    return;
  }
  if (needsConfirmation(link.path, routedWindows()) && !(await confirmOpen(link.path))) return;
  const win = await openWith(openArgsFor(link), {
    route: (answered) => withRoute(answered, { kind: link.kind, mode: link.mode }),
    reuse: (opened, origin) => {
      const id = windowFor({ origin, folder: opened.path, kind: link.kind }, routedWindows());
      return id === null ? null : (BrowserWindow.getAllWindows().find((w) => w.webContents.id === id) ?? null);
    },
    errorWindow: null,
  });
  if (win.isMinimized()) win.restore();
  win.focus();
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
  if (origin) windows.set(wc.id, { origin, folder: null, slug: null, kind: null });
  // What Electron's defaults leave open for the TOP frame (readiness note §3).
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    const origin = windows.get(wc.id)?.origin;
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
  // The page owns the title (`<file> — <folder>`); the window adds the proxy icon an editor has.
  const represent = () => {
    const state = windows.get(wc.id);
    if (!state?.folder || !state.slug) return;
    win.setRepresentedFilename(representedFile(wc.getURL(), state.folder, state.slug) ?? "");
  };
  wc.on("page-title-updated", represent);
  wc.on("did-navigate-in-page", represent);
  win.on("closed", () => {
    pendingTokens.delete(wc.id);
    windows.delete(wc.id);
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
  // A companion window keeps its kind (feature map decision 5): a person opening a folder from it
  // gets a new window rather than turning an agent's presentation into a desk.
  const reusable = existing && windows.get(existing.webContents.id)?.kind !== "companion" ? existing : null;
  await openInWindow(folder, reusable);
}

/**
 * Reveal in Finder for `win` (#160): the document its route shows, or its folder. No path comes
 * from the page (A3 "Desktop shell"); `revealTarget` derives it from the window's own URL and the
 * folder `glosa open` answered with, and refuses anything that resolves outside that folder.
 */
function revealIn(win: BrowserWindow | null): boolean {
  if (!win) return false;
  const state = windows.get(win.webContents.id);
  if (!state?.folder || !state.slug) return false;
  const target = revealTarget(
    win.webContents.getURL(),
    { folder: state.folder, slug: state.slug },
    {
      realpath: (path) => {
        try {
          return realpathSync(path);
        } catch {
          return null;
        }
      },
      exists: (path) => existsSync(path),
    },
  );
  if (target === null) {
    log("reveal: nothing to reveal for this window's route");
    return false;
  }
  shell.showItemInFolder(target);
  return true;
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
        // Worked out here from the focused window, so the menu needs no call from the page.
        { label: "Reveal in Finder", accelerator: "Alt+CmdOrCtrl+R", click: () => void revealIn(focused()) },
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
    const origin = windows.get(event.sender.id)?.origin;
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
  // Takes nothing from the page: which file is revealed is decided here (revealIn).
  ipcMain.handle("glosa:reveal", (event) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    return revealIn(BrowserWindow.fromWebContents(event.sender));
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

app.setAboutPanelOptions({ applicationName: "glosa", applicationVersion: pkg.version });

// ---------- glosa:// links arrive before, at and after launch (#392) ----------

// One app per user data directory: a second launch (a link clicked while the app runs, or
// `open -a glosa <folder>`) hands its arguments to this one and quits.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

// macOS delivers a link that launched the app before `ready`, so the listener is registered now and
// links wait until windows can be created.
let ready = false;
const waitingLinks: string[] = [];
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (ready) void openLink(url);
  else waitingLinks.push(url);
});

app.on("second-instance", (_event, argv) => {
  const link = linkFromArgv(argv);
  if (link) {
    void openLink(link);
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (!primary) return;
  // The Dock image follows the system appearance: paper squircle in light, ink in dark. An .icns
  // carries one image, so the Finder icon stays the light one; this is the Dock only.
  const dockIcon = () => {
    if (process.platform !== "darwin") return;
    const name = nativeTheme.shouldUseDarkColors ? "icon-dark-512.png" : "icon-512.png";
    app.dock?.setIcon(join(here, "..", "assets", name));
  };
  nativeTheme.on("updated", dockIcon);
  dockIcon();
  installEgressGate();
  installIpc();
  buildMenu();
  // A packaged app declares the scheme in its bundle (build.protocols); this makes it the default
  // handler. An unpackaged run does not claim it, so tests and `bun run start` never register the
  // development Electron.app with LaunchServices.
  if (app.isPackaged && !app.isDefaultProtocolClient("glosa")) app.setAsDefaultProtocolClient("glosa");
  ready = true;
  // `glosa-shell <folder> [artifact]`, the same two positionals `glosa open` takes, or a glosa://
  // link, which is also how the tests hand one over.
  const positionals = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  const argvLink = linkFromArgv(positionals);
  const links = [...(argvLink ? [argvLink] : []), ...waitingLinks];
  waitingLinks.length = 0;
  if (links.length > 0) {
    for (const link of links) await openLink(link);
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
    return;
  }
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
