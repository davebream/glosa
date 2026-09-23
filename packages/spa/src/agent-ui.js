// SPDX-License-Identifier: Apache-2.0
// Presentation only. Brand artwork attribution is in THIRD_PARTY_NOTICES.md.
import { createElement as el } from "./viewer-shell.js";

const brands = {
  "claude-code": {
    viewBox: "0 0 24 24",
    paths: [
      "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z",
    ],
  },
  codex: {
    viewBox: "0 0 320 320",
    paths: [
      "m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z",
    ],
  },
};
export const agentName = (provider) => ({ "claude-code": "Claude Code", codex: "Codex" })[provider] ?? provider;

export function agentIcon(provider) {
  const brand = brands[provider];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", brand?.viewBox ?? "0 0 24 24");
  svg.setAttribute("class", "glosa-agent-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of brand?.paths ?? ["M4 4h16v16H4z"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}

/** Native top-layer popovers avoid clipping inside split panes. Ordinary tab order, Escape,
 * and outside-click dismissal are supplied by the browser; no document listeners are retained. */
export function actionMenu(label) {
  const popup = el("div", {
    id: `agent-menu-${crypto.randomUUID()}`,
    className: "glosa-agent-menu",
    popover: "auto",
    "aria-label": label,
  });
  const trigger = el("button", {
    type: "button",
    className: "glosa-agent-menu-trigger",
    textContent: "···",
    "aria-label": label,
    title: label,
    "aria-expanded": "false",
    "aria-controls": popup.id,
    onClick: () => {
      const box = trigger.getBoundingClientRect();
      popup.style.maxHeight = `${Math.max(80, window.innerHeight - 16)}px`;
      popup.style.left = `${Math.max(8, Math.min(box.right - 224, window.innerWidth - 232))}px`;
      popup.togglePopover?.();
      const height = popup.getBoundingClientRect().height;
      const below = box.bottom + 6;
      const top = below + height <= window.innerHeight - 8 ? below : box.top - height - 6;
      popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    },
  });
  popup.addEventListener("toggle", (event) => trigger.setAttribute("aria-expanded", String(event.newState === "open")));
  popup.addEventListener("click", (event) => {
    if (event.target.closest("button")) popup.hidePopover?.();
  });
  popup.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    popup.hidePopover?.();
    trigger.focus();
  });
  const element = el("div", { className: "glosa-agent-menu-anchor" }, [trigger, popup]);
  return { element, popup, trigger };
}
