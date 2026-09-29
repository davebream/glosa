// SPDX-License-Identifier: Apache-2.0
// The preload is a per-origin capability (R-P3). It is plain CommonJS on purpose: a sandboxed
// preload is loaded by Electron, not by Node, so no type stripping applies here. It exposes
// nothing unless the page's origin is exactly the SPA origin the main process named, and even
// then every call is re-checked in the main process against `event.senderFrame.origin`.
const { contextBridge, ipcRenderer } = require("electron");

const originArg = process.argv.find((a) => a.startsWith("--glosa-spa-origin="));
const spaOrigin = originArg ? originArg.slice("--glosa-spa-origin=".length) : null;

if (spaOrigin && globalThis.location && globalThis.location.origin === spaOrigin) {
  // Whether the system asks for more contrast (#425): read synchronously once per document, so the
  // page's first-paint script has the main process's value at this load, then kept current from
  // the main process's pushes. Anything but a boolean is ignored; a refused read is no.
  let moreContrast = false;
  try {
    moreContrast = ipcRenderer.sendSync("glosa:more-contrast") === true;
  } catch {
    // No answer: the page paints as if the system asked for nothing.
  }
  // A push sent while this script runs, before or after the main process answered the read above,
  // is not lost between the read and this listener: an incoming message is dispatched as a later
  // task, after this synchronous script finishes (probed in Electron 44.4.5 with 200 ms between the
  // two). The page may paint the value that was read, and the push then corrects it.
  const contrastListeners = new Set();
  ipcRenderer.on("glosa:more-contrast-changed", (_event, value) => {
    if (typeof value !== "boolean" || value === moreContrast) return;
    moreContrast = value;
    for (const listener of contrastListeners) {
      try {
        listener(value);
      } catch {
        // One page listener failing does not stop the others.
      }
    }
  });
  // What the shell saw in one of this window's browser tabs (#440). Only the known shapes pass, with
  // only their own fields, so the page's listener never receives anything the main process did not
  // mean to send.
  const browserListeners = new Set();
  const BROWSER_EVENTS = {
    "open-tab": ["url"],
    key: ["key", "meta", "control", "shift", "alt"],
    "download-blocked": ["name", "url"],
    "permission-refused": ["words"],
  };
  ipcRenderer.on("glosa:browser-event", (_event, message) => {
    if (!message || typeof message.guestId !== "number" || !Object.hasOwn(BROWSER_EVENTS, message.type)) return;
    const clean = { guestId: message.guestId, type: message.type };
    for (const field of BROWSER_EVENTS[message.type]) {
      const value = message[field];
      if (typeof value === "string" || typeof value === "boolean") clean[field] = value;
    }
    for (const listener of browserListeners) {
      try {
        listener(clean);
      } catch {
        // One page listener failing does not stop the others.
      }
    }
  });
  contextBridge.exposeInMainWorld("glosaShell", {
    /** Desk browser tabs (#440): this shell hosts web pages as locked-down `<webview>` guests in the
     * dock. A version, so an SPA served by a newer daemon can tell an older shell apart. */
    browserTabs: 1,
    /** Opens a web or mail address in the system's own handler ("Open in your browser"). The main
     * process refuses any other scheme (policy.ts). */
    openExternal: (url) => ipcRenderer.invoke("glosa:open-external", url),
    /** Calls `listener(event)` for each thing the shell saw in a browser tab (a new window it turned
     * into a tab, a glosa chord pressed inside a page, a refused download or permission), and
     * returns an unsubscribe. */
    onBrowserEvent: (listener) => {
      if (typeof listener !== "function") return () => {};
      browserListeners.add(listener);
      return () => {
        browserListeners.delete(listener);
      };
    },
    /** One-shot: the presentation token for this window load, or null once taken (R-P1, R-P2). */
    presentationToken: () => ipcRenderer.invoke("glosa:presentation-token"),
    /** Opens the native folder picker; the main process runs `glosa open` on the choice. */
    openFolder: () => ipcRenderer.invoke("glosa:open-folder"),
    /** The Dock badge and OS notifications (#391): `{ id, title, body, badge }`, all optional.
     * A badge alone sets the count; a title or body shows a notification once per id. It carries
     * no path. The main process validates and clamps every field. */
    notify: (message) => ipcRenderer.invoke("glosa:notify", message),
    /** Shows the document this window's route names, or its folder, in Finder. Takes no argument:
     * the main process works out the path from the window's own URL and folder (A3, #160). */
    revealInFinder: () => ipcRenderer.invoke("glosa:reveal"),
    // R-L8 (#432): after glosa was updated, bring back this window's own install's daemon.
    ensureDaemon: () => ipcRenderer.invoke("glosa:ensure-daemon"),
    /** What the page resolved (#405): `{ source, scheme, background }`, "system", "light" or
     * "dark", "light" or "dark", and its paper as `#rrggbb`. The window's background and the
     * native UI follow it. No path; the main process refuses anything else (policy.ts). */
    reportAppearance: (appearance) => ipcRenderer.invoke("glosa:appearance", appearance),
    /** True while macOS asks for more contrast (Increase contrast), which Electron does not pass
     * to `prefers-contrast` (#425). Synchronous: current from before the page's first script. */
    moreContrast: () => moreContrast,
    /** Calls `listener(value)` each time `moreContrast()` changes, and returns an unsubscribe. */
    onMoreContrastChange: (listener) => {
      if (typeof listener !== "function") return () => {};
      contrastListeners.add(listener);
      return () => {
        contrastListeners.delete(listener);
      };
    },
  });
}
