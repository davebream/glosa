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
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";
import {
  appearanceDecision,
  BROWSER_PARTITION,
  BROWSER_READ_MAX,
  BROWSER_READ_SCRIPT,
  browserContextMenu,
  browserReadResult,
  browserKeyAction,
  browserNavigationDecision,
  browserRequestDecision,
  browserUserAgent,
  cliCandidates,
  cliChoice,
  compatibility,
  contrastPush,
  contrastPushReaches,
  contrastReply,
  downloadName,
  egressDecision,
  externalLinkDecision,
  firstFrameColor,
  hiddenMode,
  linkFromArgv,
  lockGuestPreferences,
  loopbackApiOrigin,
  navigationDecision,
  needsConfirmation,
  notifyDecision,
  type OpenedWorkspace,
  openArgsFor,
  parseGlosaUrl,
  parsePackageType,
  parseOpenEnvelope,
  permissionNotice,
  RELEASES_API,
  RecentIds,
  type ReconnectResult,
  reconnectOutcome,
  type RoutedWindow,
  representedFile,
  requestReleases,
  revealTarget,
  scrubChildEnv,
  splitPresentationToken,
  surfaceKind,
  targetFromArg,
  updateChannelFor,
  updateDialog,
  updateOutcome,
  webviewAttachDecision,
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

// Test-only: a shipped app ignores this environment variable and always uses its normal UI.
const hidden = hiddenMode({ packaged: app.isPackaged, value: process.env.GLOSA_SHELL_HIDDEN });
if (hidden && process.platform === "darwin") app.setActivationPolicy("accessory");

// ---------- the recorded executable is the install of truth (R-O1) ----------

/** R-L8 (#432): the sentence a packaged app says when its own CLI is gone. */
const REMOVED_MESSAGE = "glosa was removed or updated. Quit glosa and open it again.";

/** True when this packaged app's own bundled CLI is gone (R-L8). Never for an unpackaged run or when
 * the harness names the CLI it wants. */
function ownCliRemoved(): boolean {
  if (!app.isPackaged || process.env.GLOSA_SHELL_CLI) return false;
  return (
    cliChoice({ packaged: true, ownCliExists: existsSync(join(process.resourcesPath, "bin", "glosa")) }) === "removed"
  );
}

/** Where the CLI is, also when the app was launched from the Dock with a bare PATH (#371). */
function resolveCli(): string {
  // A packaged app whose own CLI is gone runs no other install's (R-L8, #432).
  if (ownCliRemoved()) throw new Error(REMOVED_MESSAGE);
  const candidates = cliCandidates({
    override: process.env.GLOSA_SHELL_CLI,
    glosaHome: process.env.GLOSA_HOME,
    homeDir: homedir(),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    platform: process.platform,
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
  /** The install whose daemon this window paired with (#432, R-L8), or null when none was published. */
  installId: string | null;
}
const windows = new Map<number, WindowState>();

/** At most one reconnect per window at a time (R-L8): a second ask shares the first's answer. */
const reconnecting = new Map<number, Promise<ReconnectResult>>();

/** R-L8: bring back the daemon a window was served by, by running `glosa open` for its folder (the
 * CLI's own spawn-only-when-absent, R-O3), then check it is the same install. Never navigates. */
async function ensureWindowDaemon(id: number): Promise<ReconnectResult> {
  const state = windows.get(id);
  if (!state?.folder) return { ok: false, reason: "failed", message: "This window has no folder to reconnect." };
  if (ownCliRemoved()) return { ok: false, reason: "removed" };
  try {
    await runOpen([state.folder]);
  } catch (e) {
    return { ok: false, reason: "failed", message: (e as Error).message };
  }
  const answered = await handshake(loopbackApiOrigin(state.origin));
  return reconnectOutcome(state.installId, typeof answered?.install_id === "string" ? answered.install_id : null);
}

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
    log(`glosa open failed after ${Date.now() - started} ms: ${(e as Error).message}`);
    const win = options.errorWindow ?? createWindow(null);
    await win.loadURL(blockingScreen("glosa could not open that folder", (e as Error).message));
    return win;
  }
  log(`glosa open answered in ${Date.now() - started} ms for ${opened.slug}`);
  const url = options.route ? options.route(opened.url) : opened.url;
  const origin = new URL(url).origin;
  const win = options.reuse(opened, origin) ?? createWindow(origin);
  const answered = await handshake(loopbackApiOrigin(origin));
  const compat = compatibility(answered, pkg.glosa.minimumDaemon);
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
    installId: typeof answered?.install_id === "string" ? answered.install_id : null,
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
  if (hidden) return false;
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
  if (!hidden) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// ---------- the window follows glosa's appearance, the Dock follows macOS (#405) ----------

/**
 * The operating system's own appearance. `nativeTheme.shouldUseDarkColors`,
 * `shouldUseDarkColorsForSystemIntegratedUI` and `systemPreferences.getEffectiveAppearance()` all
 * follow `nativeTheme.themeSource` once the page has set it (Electron 44 docs, and measured: with
 * macOS in Dark and themeSource "light", all three read light). The user default
 * `AppleInterfaceStyle` is macOS's setting itself: "Dark" in Dark mode, absent otherwise.
 */
function osIsDark(): boolean {
  if (process.platform !== "darwin") return nativeTheme.shouldUseDarkColors;
  return systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark";
}

/** The paper the last page reported, for every window opened after it (brief §9). */
let lastReportedPaper: string | null = null;

// ---------- the page follows macOS Increase contrast (#425) ----------

/** The more-contrast value last pushed to the SPA windows; read from `nativeTheme` once ready. */
let pushedContrast = false;

/**
 * Electron passes no contrast preference to pages (`prefers-contrast` never matches in its
 * renderer), so the shell relays `nativeTheme.shouldUseHighContrastColors`, which follows macOS
 * Increase contrast. The preload reads it once per document ("glosa:more-contrast"); this pushes a
 * change to every window the shell opened for the SPA, never to any other window.
 */
function pushContrast(): void {
  const next = contrastPush(pushedContrast, nativeTheme.shouldUseHighContrastColors);
  if (next === null) return;
  pushedContrast = next;
  for (const win of BrowserWindow.getAllWindows()) {
    // The top frame's committed origin, not only the recorded one: a blocking screen loaded into a
    // window after a failed compatibility check keeps the window's recorded origin.
    const frameOrigin = win.webContents.mainFrame?.origin;
    if (contrastPushReaches(windows.get(win.webContents.id)?.origin, frameOrigin))
      win.webContents.send("glosa:more-contrast-changed", next);
  }
  log(`more contrast: ${next ? "on" : "off"}`);
}

function createWindow(origin: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "glosa",
    // Keep Electron's initial-paint default: a hidden window can then run animation frames.
    ...(hidden ? { show: false } : {}),
    // The frame before the page paints: the last paper any window reported, else the paper of the
    // operating system's scheme, so a window opened while glosa is in Dark never flashes white.
    backgroundColor: firstFrameColor(lastReportedPaper, osIsDark()),
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Ask Electron to keep frames running if a test window becomes backgrounded.
      ...(hidden ? { backgroundThrottling: false } : {}),
      // The preload reads this to decide whether to expose anything at all (R-P3). It is the
      // origin the CLI links to, learned from `glosa open`; a window with no origin exposes nothing.
      additionalArguments: origin ? [`--glosa-spa-origin=${origin}`] : [],
      // Desk browser tabs (#440) are `<webview>` guests in the dock. Enabled on every window because
      // a window's kind is known only after `glosa open` answers; `will-attach-webview` below is
      // the gate, and a companion window's request is refused there.
      webviewTag: true,
    },
  });
  const wc = win.webContents;
  if (origin) windows.set(wc.id, { origin, folder: null, slug: null, kind: null, installId: null });
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
  // A guest attaches only to a desk window's SPA frame, for a web address, and always with the
  // browser partition's locked preferences, whatever the page asked for (policy.ts, A3 §4b).
  wc.on("will-attach-webview", (event, prefs, params) => {
    const state = windows.get(wc.id);
    lockGuestPreferences(prefs as unknown as Record<string, unknown>);
    const decision = webviewAttachDecision({
      kind: state?.kind,
      frameOrigin: wc.mainFrame?.origin,
      spaOrigin: state?.origin,
      src: params.src ?? "",
    });
    if (decision === "deny") {
      log("refused a browser tab: not a desk window's SPA frame, or not a web address");
      event.preventDefault();
    }
  });
  wc.on("did-attach-webview", (_event, guest) => wireBrowserTab(wc, guest));
  // A `beforeunload` guard in the SPA (unsaved edits) would otherwise cancel the close silently.
  wc.on("will-prevent-unload", (event) => {
    if (hidden) {
      event.preventDefault();
      return;
    }
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

// ---------- desk browser tabs (#440) ----------

/** The isolated world an agent's read runs in (any id Electron's own worlds do not use). */
const BROWSER_READ_WORLD = 1099;

/** What the shell tells a desk window about one of its browser tabs. The SPA knows each tab by its
 * guest's id (`<webview>.getWebContentsId()`). */
function toHost(host: Electron.WebContents | null | undefined, guest: Electron.WebContents, event: object): void {
  if (host && !host.isDestroyed()) host.send("glosa:browser-event", { guestId: guest.id, ...event });
}

/** The scheme of a refused address, for the log: never the address itself. */
function schemeOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? "malformed";
}

/** One guest, as it attaches: new windows become tabs beside it, only web addresses load in it,
 * glosa's chords keep working inside it, and it gets a right-click menu. */
function wireBrowserTab(host: Electron.WebContents, guest: Electron.WebContents): void {
  guest.setWindowOpenHandler(({ url }) => {
    if (url !== "about:blank" && browserNavigationDecision(url) === "allow")
      toHost(host, guest, { type: "open-tab", url });
    return { action: "deny" };
  });
  const refuse = (event: Electron.Event, url: string) => {
    if (browserNavigationDecision(url) === "allow") return;
    log(`browser tab: refused navigation to a ${schemeOf(url)} address`);
    event.preventDefault();
  };
  guest.on("will-navigate", (event, url) => refuse(event, url));
  guest.on("will-redirect", (event, url) => refuse(event, url));
  const history = guest.navigationHistory;
  guest.on("before-input-event", (event, input) => {
    const action = browserKeyAction(input);
    if (!action) return;
    event.preventDefault();
    if (action === "reload") guest.reload();
    else if (action === "back") {
      if (history.canGoBack()) history.goBack();
    } else if (action === "forward") {
      if (history.canGoForward()) history.goForward();
    } else {
      toHost(host, guest, {
        type: "key",
        key: input.key,
        meta: input.meta,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
      });
    }
  });
  guest.on("context-menu", (_event, params) => {
    const link = params.linkURL;
    const run = (action: string) => {
      if (action === "open-link-in-tab") toHost(host, guest, { type: "open-tab", url: link });
      else if (action === "open-link-outside" && externalLinkDecision(link) === "open") void shell.openExternal(link);
      else if (action === "copy-link") clipboard.writeText(link);
      else if (action === "back" && history.canGoBack()) history.goBack();
      else if (action === "forward" && history.canGoForward()) history.goForward();
      else if (action === "reload") guest.reload();
    };
    const items = browserContextMenu({
      linkURL: link,
      selectionText: params.selectionText,
      isEditable: params.isEditable,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    });
    const template = items.map(
      (item): Electron.MenuItemConstructorOptions =>
        "action" in item ? { label: item.label, click: () => run(item.action) } : item,
    );
    const win = BrowserWindow.fromWebContents(host);
    Menu.buildFromTemplate(template).popup(win ? { window: win } : {});
  });
}

/** Every daemon port an open window is served from, and the class-F port beside each (A3 §1). A
 * page in a browser tab may not reach any of them on a loopback name. */
function glosaPorts(): number[] {
  const ports = new Set<number>();
  for (const state of windows.values()) {
    const port = Number(new URL(state.origin).port);
    if (port) ports.add(port).add(port + 1);
  }
  return [...ports];
}

/**
 * The browser partition's own rules (#440, A3 §4b), installed once at launch. Its request policy
 * lets web pages load and cancels files, custom schemes and glosa's own ports; permissions and
 * downloads are refused, and the ones a person would miss are said in the tab; the user agent
 * names neither Electron nor glosa. The SPA's session and its egress gate are not touched.
 */
function installBrowserSession(): void {
  const browser = session.fromPartition(BROWSER_PARTITION);
  browser.setUserAgent(browserUserAgent(app.userAgentFallback));
  browser.webRequest.onBeforeRequest((details, callback) => {
    const decision = browserRequestDecision(details.url, glosaPorts());
    if (decision === "cancel") log(`browser tab: cancelled a request to a ${schemeOf(details.url)} address`);
    callback({ cancel: decision === "cancel" });
  });
  browser.setPermissionRequestHandler((wc, permission, callback) => {
    callback(false);
    const words = permissionNotice(permission);
    if (words && wc) toHost(wc.hostWebContents, wc, { type: "permission-refused", words });
  });
  browser.setPermissionCheckHandler(() => false);
  browser.setDevicePermissionHandler(() => false);
  browser.on("will-download", (event, item, wc) => {
    event.preventDefault();
    const url = item.getURL();
    toHost(wc?.hostWebContents, wc, {
      type: "download-blocked",
      name: downloadName(item.getFilename()),
      url: externalLinkDecision(url) === "open" ? url : wc.getURL(),
    });
  });
  // Outside macOS, Chromium's spellchecker downloads dictionaries on first use: an unasked-for
  // request (invariant 5). macOS checks spelling with its own, local dictionaries.
  browser.setSpellCheckerEnabled(process.platform === "darwin");
}

async function chooseFolder(win: BrowserWindow | null): Promise<string | null> {
  if (hidden) return null;
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

// ---------- Check for Updates…, on click only (#424) ----------

/** The package manager that installed this app, from the marker the Linux package's build writes
 * beside its resources (#432), or null: macOS, an unpackaged run, or a Linux app pacman did not
 * install. Read once; it cannot change while the app runs. */
const packageType: string | null = (() => {
  if (!app.isPackaged) return null;
  try {
    return parsePackageType(readFileSync(join(process.resourcesPath, "package-type"), "utf8"));
  } catch {
    return null;
  }
})();

/**
 * Where the check asks. `GLOSA_SHELL_RELEASES_API` points it elsewhere and is read only by an
 * unpackaged app: it is how the real-Electron test puts a local stub in GitHub's place, never a way
 * to redirect a shipped app's check.
 */
function releasesApi(): string {
  const override = process.env.GLOSA_SHELL_RELEASES_API;
  return !app.isPackaged && override ? override : RELEASES_API;
}

/** The check in flight, dialog included, so a second click meanwhile starts nothing. */
let updateCheck: Promise<void> | null = null;

/**
 * One GET to GitHub's Releases API when the person clicks, and never at launch, on a timer or on
 * focus (invariant 5, A6 §F33). Node's global `fetch`, not Electron's `net`: `net` requests pass
 * the renderer's egress gate (installEgressGate), which cancels them, and the gate stays as it is.
 * Constant headers, no HTTP cache, no redirect followed, a bounded wait and a byte cap, and nothing
 * written to disk.
 */
function checkForUpdates(): Promise<void> {
  updateCheck ??= runUpdateCheck()
    .catch((e) => log(`update check: ${(e as Error).message}`))
    .finally(() => {
      updateCheck = null;
    });
  return updateCheck;
}

async function runUpdateCheck(): Promise<void> {
  const running = { current: pkg.version, arch: process.arch, platform: process.platform };
  // Node's global fetch. One request: no redirect followed, the body capped, one timeout over both.
  const response = await requestReleases(releasesApi(), fetch);
  const outcome = updateOutcome(response, running);
  if (outcome.kind === "newer") log(`update check: found ${outcome.version} for ${running.arch}`);
  else if (outcome.kind === "current") log(`update check: up to date at ${running.current}`);
  else log(`update check: failed: ${outcome.reason}`);
  const { actions, ...options } = updateDialog(outcome, {
    current: pkg.version,
    releasesPage: pkg.glosa.releases,
    channel: updateChannelFor(process.platform, packageType),
    arch: process.arch,
  });
  if (hidden) return;
  const win = BrowserWindow.getFocusedWindow();
  const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  const action = actions[answer.response] ?? null;
  // Both built in policy.ts: the URL from package.json's releases page, never from GitHub's answer.
  if (action && "open" in action) await shell.openExternal(action.open);
  else if (action && "copy" in action) clipboard.writeText(action.copy);
}

function buildMenu(): void {
  const focused = () => BrowserWindow.getFocusedWindow();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      // The standard app menu, spelled out so Check for Updates… can sit under About, where macOS
      // apps keep it. Explicit, on click, nothing scheduled: the app never checks on its own
      // (invariant 5; A6 §F33). A click asks GitHub once from the main process and says in a
      // dialog whether a newer app exists; it never installs one (checkForUpdates).
      label: app.name,
      submenu: [
        { role: "about" },
        { id: "check-for-updates", label: "Check for Updates…", click: () => void checkForUpdates() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
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
    // No items, but kept: the Help role is where macOS puts its menu search.
    { role: "help", submenu: [] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installIpc(): void {
  const fromSpa = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
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
  ipcMain.handle("glosa:ensure-daemon", (event) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    const id = event.sender.id;
    const pending = reconnecting.get(id);
    if (pending) return pending;
    const attempt = ensureWindowDaemon(id).finally(() => reconnecting.delete(id));
    reconnecting.set(id, attempt);
    return attempt;
  });
  // "Open in your browser", and links that belong outside glosa (#440): the system's own handler,
  // for web and mail addresses only (policy.ts). Any SPA window may ask; a companion window has
  // links too.
  ipcMain.handle("glosa:open-external", async (event, url: unknown) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    if (externalLinkDecision(url) !== "open") throw new Error("rejected: not a web or mail address");
    await shell.openExternal(url as string);
  });
  // A chat agent's read of one of this window's browser tabs (#440): the page's address, title and
  // visible text. Only a desk window's SPA may ask, only for a guest it hosts, and the page is read
  // in an isolated world its own scripts cannot reach.
  ipcMain.handle("glosa:browser-read", async (event, guestId: unknown, maxChars: unknown) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    if (windows.get(event.sender.id)?.kind !== "desk") throw new Error("rejected: not a desk window");
    const guest = typeof guestId === "number" ? webContents.fromId(guestId) : undefined;
    if (!guest || guest.getType() !== "webview" || guest.hostWebContents?.id !== event.sender.id) {
      throw new Error("rejected: not one of this window's browser tabs");
    }
    const raw = await guest.executeJavaScriptInIsolatedWorld(BROWSER_READ_WORLD, [{ code: BROWSER_READ_SCRIPT }]);
    const read = browserReadResult(raw, typeof maxChars === "number" ? maxChars : BROWSER_READ_MAX);
    if (!read) throw new Error("the page could not be read");
    return read;
  });
  ipcMain.handle("glosa:reveal", (event) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    return revealIn(BrowserWindow.fromWebContents(event.sender));
  });
  // Dock badge and notifications (#391). Every window reports the same daemon-wide attention, so
  // the badge is the latest value (never a sum) and a notification id already shown is dropped.
  const shownNotifications = new RecentIds();
  // Held until clicked or closed: an unreferenced Notification can be collected, and its click
  // handler with it.
  const liveNotifications = new Set<Notification>();
  ipcMain.handle("glosa:notify", (event, payload: unknown) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    const decision = notifyDecision(payload, shownNotifications);
    if (decision.badge !== undefined && !hidden) app.setBadgeCount(decision.badge);
    if (decision.show && !hidden && Notification.isSupported()) {
      const note = new Notification(decision.show);
      liveNotifications.add(note);
      note.on("close", () => liveNotifications.delete(note));
      const sender = BrowserWindow.fromWebContents(event.sender);
      note.on("click", () => {
        liveNotifications.delete(note);
        if (!sender || sender.isDestroyed()) return;
        if (sender.isMinimized()) sender.restore();
        sender.show();
        sender.focus();
        app.focus({ steal: true });
      });
      note.show();
    }
  });
  // What the page resolved (#405). `themeSource` is process-wide: native dialogs, menus, the title
  // bar and `prefers-color-scheme` in every frame follow glosa's choice. The background is the
  // reporting window's own, and the first frame of every window opened after it.
  ipcMain.handle("glosa:appearance", (event, payload: unknown) => {
    if (!fromSpa(event)) throw new Error("rejected: not the SPA origin");
    const decision = appearanceDecision(payload);
    if (!decision) throw new Error("rejected: not an appearance");
    lastReportedPaper = decision.background;
    if (nativeTheme.themeSource !== decision.themeSource) nativeTheme.themeSource = decision.themeSource;
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(decision.background);
  });
  // Synchronous, so the page's first-paint script already has it (#425). A `sendSync` left
  // unanswered hangs the renderer, so every path, a refusal and an error included, sets
  // `returnValue`; a refusal is null, which the preload reads as no more contrast.
  ipcMain.on("glosa:more-contrast", (event) => {
    try {
      const allowed = fromSpa(event);
      if (!allowed) log("refused a contrast read: not the SPA origin");
      event.returnValue = contrastReply(allowed, nativeTheme.shouldUseHighContrastColors);
    } catch (e) {
      log(`contrast read failed: ${(e as Error).message}`);
      event.returnValue = null;
    }
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
  if (win && !hidden) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (!primary) return;
  // The Dock image follows macOS's appearance, not glosa's (brief §9: the Dock is the system's
  // surface): paper squircle in light, ink in dark. An .icns carries one image, so the Finder icon
  // stays the light one; this is the Dock only. It reads the OS setting itself (`osIsDark`),
  // because once a page sets `themeSource`, `nativeTheme` answers with glosa's choice, and
  // `nativeTheme` may not report an OS change while it is overridden, so the system's own
  // notification is watched too.
  let dockIsDark: boolean | null = null;
  const dockIcon = () => {
    if (process.platform !== "darwin") return;
    const dark = osIsDark();
    if (dark === dockIsDark) return;
    dockIsDark = dark;
    app.dock?.setIcon(join(here, "..", "assets", dark ? "icon-dark-512.png" : "icon-512.png"));
    log(`dock icon follows macOS: ${dark ? "dark" : "light"}`);
  };
  nativeTheme.on("updated", dockIcon);
  // Increase contrast reaches the page through the shell (#425): `updated` also fires when it
  // changes, and `pushContrast` sends only a change.
  pushedContrast = nativeTheme.shouldUseHighContrastColors === true;
  nativeTheme.on("updated", pushContrast);
  if (process.platform === "darwin") {
    systemPreferences.subscribeNotification("AppleInterfaceThemeChangedNotification", dockIcon);
  }
  dockIcon();
  installEgressGate();
  installBrowserSession();
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
  // A desktop entry's %U hands a folder over as file:///… on Linux (#432); the CLI wants a path.
  const target = positionals[0] ? targetFromArg(positionals[0]) : null;
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
