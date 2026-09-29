// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — a desk browser tab (#440): a web page beside the documents and chats, in the
// desktop app. The page is someone else's design: glosa frames it and never restyles it.
//
// The page is a `<webview>` the desktop shell locks down as it attaches (its own saved partition,
// no preload, sandboxed; A3 §4b). It is created only when a page should load: a tab that came back
// after a relaunch with an internet address shows the address and a Load button and fetches
// nothing until the person asks, because reopening glosa is not choosing to visit that site again
// (maintainer decision 2026-09-28). Loopback pages load at once.
//
// The address row is the artifact bar's idiom (brief A1): navigation left, the address centred as
// the row's one object, "Open in your browser" and More right.

import { actionMenu } from "./agent-ui.js";
import {
  addressProblem,
  browserTabLabel,
  describeLoadFailure,
  describeUrl,
  isGlosaAddress,
  isLocalUrl,
  parseAddress,
} from "./browser-address.js";
import { createElement as el } from "./viewer-shell.js";

/** The shell's partition (packages/shell/src/policy.ts BROWSER_PARTITION). The shell forces it on
 * every guest whatever this says; naming it here keeps a page from starting in another store. */
export const BROWSER_PARTITION = "persist:glosa-browser";

const ICONS = {
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>',
  forward: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
  reload:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 6A5 5 0 1 0 13 8.5"/><path d="M13 2.8V6h-3.2"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
  outside:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/><path d="M11.5 9.5v4h-9v-9h4"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v6.1A1.2 1.2 0 0 0 3.7 11H5"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>',
  move: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.3v.2"/></svg>',
};

/**
 * @param {HTMLElement} host
 * @param {{
 *   url?: string | null,
 *   restored?: boolean,
 *   openOutside: (url: string) => void,
 *   copyText?: (text: string) => Promise<void>,
 *   onNavigate?: (page: { url: string, title: string }) => void,
 *   onStateChange?: () => void,
 *   onFocusPage?: () => void,
 *   closeTab?: () => void,
 *   paneCommands?: { id: string, label: string, run: () => void, isEnabled?: () => boolean }[],
 * }} options
 */
export function createBrowserPane(host, options) {
  const {
    restored = false,
    openOutside,
    copyText = (text) => navigator.clipboard.writeText(text),
    onNavigate = () => {},
    onStateChange = () => {},
    onFocusPage = () => {},
    closeTab = () => {},
    paneCommands = [],
  } = options;
  let url = typeof options.url === "string" && options.url ? options.url : "";
  let title = "";
  let loading = false;
  /** @type {{ title: string, body: string, action: "reload" | "open-outside" | null } | null} */
  let failure = null;
  let crashed = false;
  let ready = false;
  let destroyed = false;
  /** @type {any} */ let view = null;
  /** The state the tab is in: "empty" (nothing typed yet), "unloaded" (a restored internet page
   * that has not been asked for), or "page" (a webview is showing, loading or has failed). */
  let state = url ? (restored && !isLocalUrl(url) ? "unloaded" : "page") : "empty";

  const button = (className, label, icon, onClick) => {
    const b = el("button", {
      type: "button",
      className: `glosa-browser-tool ${className}`,
      "aria-label": label,
      title: label,
      onClick,
    });
    b.innerHTML = icon;
    return b;
  };
  const back = button("glosa-browser-back", "Back", ICONS.back, () => view?.canGoBack() && view.goBack());
  const forward = button(
    "glosa-browser-forward",
    "Forward",
    ICONS.forward,
    () => view?.canGoForward() && view.goForward(),
  );
  const reload = button("glosa-browser-reload", "Reload", ICONS.reload, () => {
    if (loading && ready) view.stop();
    else reloadPage();
  });
  const outside = button("glosa-browser-outside", "Open in your browser", ICONS.outside, () => {
    if (url) openOutside(url);
  });

  const where = el("span", { className: "glosa-browser-where" });
  const displayHost = el("span", { className: "glosa-browser-host" });
  const displayRest = el("span", { className: "glosa-browser-rest" });
  const display = el("span", { className: "glosa-browser-display", "aria-hidden": "true" }, [displayHost, displayRest]);
  const input = el("input", {
    className: "glosa-browser-input",
    type: "text",
    inputMode: "url",
    autocomplete: "off",
    spellcheck: false,
    maxLength: 8192,
    placeholder: "Web address, or localhost and a port",
    "aria-label": "Address",
  });
  const helperId = `glosa-browser-helper-${Math.random().toString(36).slice(2, 9)}`;
  const helper = el("p", { className: "glosa-browser-helper", id: helperId, role: "alert", hidden: true });
  const field = el("div", { className: "glosa-browser-field" }, [display, input]);
  const address = el("form", { className: "glosa-browser-address", noValidate: true }, [where, field]);

  const menu = actionMenu("More");
  menu.trigger.classList.add("glosa-browser-tool", "glosa-browser-more");
  const menuItem = (label, icon, onClick, detail) => {
    const item = el("button", { type: "button", className: "glosa-browser-menu-item", onClick }, [
      el("span", { className: "glosa-browser-menu-icon", "aria-hidden": "true" }),
      el("span", { className: "glosa-browser-menu-label", textContent: label }),
      ...(detail ? [el("kbd", { className: "glosa-browser-menu-key", textContent: detail })] : []),
    ]);
    /** @type {HTMLElement} */ (item.firstElementChild).innerHTML = icon;
    return item;
  };
  const outsideItem = menuItem("Open in your browser", ICONS.outside, () => url && openOutside(url));
  const copyItem = menuItem("Copy address", ICONS.copy, () => {
    if (url) void copyText(url).catch(() => {});
  });
  // Forward leaves the row in a narrow pane (app.css); it is here then instead.
  const forwardItem = menuItem("Forward", ICONS.forward, () => ready && view?.canGoForward() && view.goForward(), "⌘]");
  const reloadItem = menuItem("Reload", ICONS.reload, () => reloadPage(), "⌘R");
  const closeItem = menuItem("Close tab", ICONS.close, () => closeTab(), "⌘W");
  const moves = paneCommands.map((command) => {
    const item = menuItem(command.label, ICONS.move, () => command.run());
    item.setAttribute("data-direction", command.id);
    return { item, command };
  });
  const moveGroup = el("div", { className: "glosa-agent-menu-group", role: "group", "aria-label": "Move tab to" }, [
    el("p", { className: "glosa-browser-menu-heading", textContent: "Move tab to" }),
    ...moves.map((move) => move.item),
  ]);
  menu.popup.append(
    outsideItem,
    copyItem,
    forwardItem,
    reloadItem,
    closeItem,
    ...(moves.length ? [el("hr"), moveGroup] : []),
  );
  // Which directions mean anything depends on a layout that changes between one opening and the
  // next, so it is answered as the menu opens, like the document's own More menu.
  menu.popup.addEventListener("toggle", (event) => {
    if (/** @type {any} */ (event).newState !== "open") return;
    let available = 0;
    for (const { item, command } of moves) {
      const enabled = command.isEnabled ? command.isEnabled() : true;
      item.disabled = !enabled;
      if (enabled) available += 1;
    }
    moveGroup.hidden = available === 0;
    outsideItem.disabled = copyItem.disabled = !url;
    forwardItem.hidden = element.clientWidth > 460;
    forwardItem.disabled = !(ready && view?.canGoForward());
    reloadItem.disabled = state === "empty";
  });

  const bar = el("div", { className: "glosa-browser-bar" }, [
    el("div", { className: "glosa-browser-nav" }, [back, forward, reload]),
    address,
    el("div", { className: "glosa-browser-actions" }, [outside, menu.element]),
  ]);

  const noticeText = el("span", { className: "glosa-browser-notice-text" });
  const noticeAction = el("button", {
    type: "button",
    className: "glosa-browser-notice-action",
    textContent: "Open in your browser",
  });
  const noticeClose = button("glosa-browser-notice-close", "Dismiss", ICONS.close, () => {
    notice.hidden = true;
  });
  const notice = el("div", { className: "glosa-browser-notice", role: "status", hidden: true }, [
    el("span", { className: "glosa-browser-notice-dot", "aria-hidden": "true" }),
    noticeText,
    el("span", { className: "glosa-browser-notice-end" }, [noticeAction, noticeClose]),
  ]);
  let noticeUrl = "";
  noticeAction.addEventListener("click", () => {
    if (noticeUrl) openOutside(noticeUrl);
  });

  const progress = el("div", { className: "glosa-browser-progress", "aria-hidden": "true", hidden: true });
  const cover = el("div", { className: "glosa-browser-cover", hidden: true });
  const frame = el("div", { className: "glosa-browser-frame" }, [cover]);
  const element = el("section", { className: "glosa-browser", "aria-label": "Browser tab", "data-state": state }, [
    bar,
    helper,
    notice,
    progress,
    frame,
  ]);
  host.append(element);

  // ---------- the address ----------

  function showAddress() {
    const shown = describeUrl(url);
    input.value = url;
    displayHost.textContent = url ? shown.host : "";
    displayRest.textContent = url ? shown.rest : "";
    where.textContent = "";
    where.hidden = !url || !shown.where;
    where.classList.toggle("glosa-browser-where-warn", shown.where === "Not secure");
    if (shown.where === "Not secure") where.insertAdjacentHTML("afterbegin", ICONS.warn);
    where.append(shown.where);
    field.dataset.empty = String(!url);
  }

  function clearProblem() {
    helper.hidden = true;
    helper.textContent = "";
    field.removeAttribute("data-error");
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }

  address.addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = parseAddress(input.value);
    if (!parsed.ok) {
      if (parsed.reason === "empty") return;
      helper.textContent = addressProblem(parsed);
      helper.hidden = false;
      field.setAttribute("data-error", "true");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", helperId);
      return;
    }
    clearProblem();
    go(parsed.url);
    input.blur();
    view?.focus();
  });
  input.addEventListener("input", () => {
    if (!helper.hidden) clearProblem();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Like every browser: Escape puts back the address of the page that is showing.
    event.preventDefault();
    clearProblem();
    showAddress();
    input.select();
  });
  // One click selects the whole address, ready to be replaced, as a browser's address bar does.
  let selectOnFocus = false;
  input.addEventListener("pointerdown", () => {
    selectOnFocus = document.activeElement !== input;
  });
  input.addEventListener("focus", () => {
    if (selectOnFocus || !input.value) queueMicrotask(() => input.select());
  });
  input.addEventListener("pointerup", (event) => {
    if (!selectOnFocus) return;
    selectOnFocus = false;
    event.preventDefault();
    input.select();
  });

  // ---------- the page ----------

  function ensureView() {
    if (view) return view;
    view = document.createElement("webview");
    view.className = "glosa-browser-view";
    view.setAttribute("partition", BROWSER_PARTITION);
    // Without it a guest's new windows are dropped before the shell sees them. The shell never lets
    // one open: its window-open handler denies every request and turns a web address into a desk
    // tab beside this one (packages/shell/src/main.ts wireBrowserTab).
    view.setAttribute("allowpopups", "");
    view.addEventListener("dom-ready", () => {
      ready = true;
    });
    view.addEventListener("did-start-loading", () => {
      loading = true;
      failure = null;
      crashed = false;
      render();
    });
    view.addEventListener("did-stop-loading", () => {
      loading = false;
      // A load the shell cancelled ends with no failure event at all, so the address is read back
      // from the page that is actually showing: the row never names a page that did not load.
      const committed = ready ? view.getURL() : "";
      if (!failure && committed && committed !== "about:blank" && committed !== url) {
        url = committed;
        showAddress();
        onNavigate({ url, title });
      }
      render();
    });
    view.addEventListener("did-navigate", (event) => arrived(event.url));
    view.addEventListener("did-navigate-in-page", (event) => {
      if (event.isMainFrame) arrived(event.url);
    });
    view.addEventListener("page-title-updated", (event) => {
      title = String(event.title ?? "");
      view.setAttribute("aria-label", `Web page: ${browserTabLabel({ title, url })}`);
      onNavigate({ url, title });
      onStateChange();
    });
    view.addEventListener("did-fail-load", (event) => {
      if (!event.isMainFrame) return;
      const said = describeLoadFailure(event.errorCode, event.validatedURL || url);
      if (!said) return;
      if (event.validatedURL) url = event.validatedURL;
      failure = said;
      loading = false;
      showAddress();
      render();
    });
    view.addEventListener("render-process-gone", () => {
      crashed = true;
      loading = false;
      render();
    });
    // A click into the page never reaches the SPA's document, so the pane learns it was chosen here,
    // and anything open over the page gives way.
    view.addEventListener("focus", () => {
      menu.popup.hidePopover?.();
      onFocusPage();
    });
    frame.prepend(view);
    return view;
  }

  function arrived(next) {
    if (!next || next === "about:blank") return;
    url = next;
    failure = null;
    showAddress();
    onNavigate({ url, title });
    render();
  }

  function go(next) {
    url = next;
    title = "";
    failure = null;
    crashed = false;
    state = "page";
    showAddress();
    if (isGlosaAddress(next, window.location.href)) {
      failure = describeLoadFailure(-20, next);
      onNavigate({ url, title });
      render();
      return;
    }
    const page = ensureView();
    if (ready) void Promise.resolve(page.loadURL(next)).catch(() => {});
    else page.setAttribute("src", next);
    onNavigate({ url, title });
    render();
  }

  function reloadPage() {
    if (state === "unloaded") return go(url);
    if (!view || !url) return;
    failure = null;
    crashed = false;
    // A guest that never reached dom-ready (its first load failed) takes no calls: start it again.
    if (!ready) {
      view.remove();
      view = null;
      return go(url);
    }
    view.reload();
    render();
  }

  // ---------- rendering ----------

  function coverFor() {
    if (state === "empty") {
      return el("div", { className: "glosa-browser-intro" }, [
        el("p", {}, [
          "Type an address and press Return. ",
          el("code", { textContent: "localhost:3000" }),
          " and other local addresses load at once; anything else loads from the internet.",
        ]),
      ]);
    }
    if (state === "unloaded") {
      const shown = describeUrl(url);
      const load = el("button", {
        type: "button",
        className: "glosa-browser-primary",
        textContent: "Load page",
        onClick: () => go(url),
      });
      return el("div", { className: "glosa-browser-sheet" }, [
        el("h2", { className: "glosa-browser-sheet-title", textContent: shown.host || url }),
        el("p", { className: "glosa-browser-sheet-url", textContent: url }),
        el("p", {
          className: "glosa-browser-sheet-why",
          textContent:
            "Not loaded yet. glosa reopened this tab without visiting the site, and fetches nothing until you load it.",
        }),
        el("div", { className: "glosa-browser-buttons" }, [
          load,
          el("button", {
            type: "button",
            className: "glosa-browser-secondary",
            textContent: "Open in your browser",
            onClick: () => openOutside(url),
          }),
        ]),
      ]);
    }
    const said = crashed
      ? {
          title: "This page stopped working",
          body: "Reload to start it again.",
          action: /** @type {const} */ ("reload"),
        }
      : failure;
    if (!said) return null;
    const action =
      said.action === "reload"
        ? el("button", {
            type: "button",
            className: "glosa-browser-secondary",
            textContent: "Reload",
            onClick: reloadPage,
          })
        : said.action === "open-outside"
          ? el("button", {
              type: "button",
              className: "glosa-browser-secondary",
              textContent: "Open in your browser",
              onClick: () => openOutside(url),
            })
          : null;
    return el("div", { className: "glosa-browser-message", role: "alert" }, [
      el("h2", { className: "glosa-browser-message-title", textContent: said.title }),
      el("p", { className: "glosa-browser-message-body", textContent: said.body }),
      ...(action ? [el("div", { className: "glosa-browser-buttons" }, [action])] : []),
    ]);
  }

  function render() {
    if (destroyed) return;
    element.dataset.state =
      state === "page" ? (crashed ? "crashed" : failure ? "failed" : loading ? "loading" : "loaded") : state;
    const covering = coverFor();
    cover.replaceChildren(...(covering ? [covering] : []));
    cover.hidden = !covering;
    if (view) view.classList.toggle("glosa-browser-view-covered", Boolean(covering));
    progress.hidden = !(state === "page" && loading);
    const live = state === "page" && Boolean(view);
    back.disabled = !(live && ready && view.canGoBack());
    forward.disabled = !(live && ready && view.canGoForward());
    reload.disabled = state === "empty";
    reload.innerHTML = loading ? ICONS.stop : ICONS.reload;
    reload.setAttribute("aria-label", loading ? "Stop" : "Reload");
    reload.title = loading ? "Stop" : "Reload";
    outside.disabled = !url;
    onStateChange();
  }

  function guestId() {
    try {
      return view && ready ? view.getWebContentsId() : null;
    } catch {
      return null;
    }
  }

  function say(text, openUrl) {
    noticeText.textContent = "";
    noticeText.append(...text);
    noticeUrl = openUrl ?? "";
    noticeAction.hidden = !noticeUrl;
    notice.hidden = false;
  }

  showAddress();
  if (state === "page") go(url);
  else render();

  return {
    kind: "browser",
    element,
    get title() {
      return browserTabLabel({ title, url });
    },
    get url() {
      return url;
    },
    get state() {
      return state;
    },
    get loading() {
      return loading;
    },
    guestId,
    isMissing: () => false,
    /** ⌘L: the address, selected, ready to be replaced. */
    focusAddress() {
      input.focus({ preventScroll: true });
      input.select();
    },
    reload: reloadPage,
    /** Something the desktop shell saw in this tab's page (packages/shell/src/preload.cjs). */
    handleShellEvent(event) {
      if (event.type === "download-blocked") {
        say(
          ["This page tried to download ", el("b", { textContent: event.name }), ". glosa doesn't save downloads."],
          event.url,
        );
      } else if (event.type === "permission-refused") {
        const words = String(event.words ?? "");
        say([`This page asked ${words.startsWith("to ") ? words : `for ${words}`}. glosa doesn't allow that.`], "");
      }
    },
    hidden() {
      menu.popup.hidePopover?.();
    },
    destroy() {
      destroyed = true;
      menu.popup.hidePopover?.();
      element.remove();
      view = null;
    },
  };
}
