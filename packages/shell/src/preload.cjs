// SPDX-License-Identifier: Apache-2.0
// The preload is a per-origin capability (R-P3). It is plain CommonJS on purpose: a sandboxed
// preload is loaded by Electron, not by Node, so no type stripping applies here. It exposes
// nothing unless the page's origin is exactly the SPA origin the main process named, and even
// then every call is re-checked in the main process against `event.senderFrame.origin`.
const { contextBridge, ipcRenderer } = require("electron");

const originArg = process.argv.find((a) => a.startsWith("--glosa-spa-origin="));
const spaOrigin = originArg ? originArg.slice("--glosa-spa-origin=".length) : null;

if (spaOrigin && globalThis.location && globalThis.location.origin === spaOrigin) {
  contextBridge.exposeInMainWorld("glosaShell", {
    /** One-shot: the presentation token for this window load, or null once taken (R-P1, R-P2). */
    presentationToken: () => ipcRenderer.invoke("glosa:presentation-token"),
    /** Opens the native folder picker; the main process runs `glosa open` on the choice. */
    openFolder: () => ipcRenderer.invoke("glosa:open-folder"),
    /** An OS notification. Title and body only; the main process truncates both. */
    notify: (title, body) => ipcRenderer.invoke("glosa:notify", { title, body }),
  });
}
