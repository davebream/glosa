// SPDX-License-Identifier: Apache-2.0
// Desk browser tabs (#440): what a typed address means, what the row shows, what a failed load
// says, and the pane's states. The pane is driven through a stand-in `<webview>`: happy-dom has no
// guest, so the test gives the element the methods Electron's has and fires the events Electron
// fires. What that cannot prove (a real guest, its partition, the shell's refusals) is proved by
// packages/shell/test/shell-real-engine.electron.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addressProblem,
  browserTabLabel,
  describeLoadFailure,
  describeUrl,
  isGlosaAddress,
  isLocalUrl,
  parseAddress,
} from "../src/browser-address.js";
import { createBrowserPane } from "../src/browser-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("what a typed address means (#440)", () => {
  test("a host becomes an https address; this machine and private networks get http", () => {
    const cases: Array<[string, string]> = [
      ["example.org", "https://example.org/"],
      ["docs.tidewater.dev/getting-started?x=1#y", "https://docs.tidewater.dev/getting-started?x=1#y"],
      ["localhost:5173/docs", "http://localhost:5173/docs"],
      ["localhost", "http://localhost/"],
      ["app.localhost:3000", "http://app.localhost:3000/"],
      ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
      ["[::1]:3000/x", "http://[::1]:3000/x"],
      ["192.168.1.20:8080", "http://192.168.1.20:8080/"],
      ["http://example.org", "http://example.org/"],
    ];
    for (const [typed, url] of cases) {
      const parsed = parseAddress(typed);
      expect(parsed, typed).toEqual({ ok: true, url });
    }
  });

  test("words are words: glosa never sends them to a search engine", () => {
    for (const typed of ["tide table api", "notes", "v1.2", "what is a glosa?"]) {
      const parsed = parseAddress(typed);
      expect(parsed.ok, typed).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("not-an-address");
    }
    expect(addressProblem(parseAddress("tide table api"))).toBe(
      `"tide table api" isn't a web address. glosa doesn't search the web.`,
    );
  });

  test("another scheme is refused, not guessed at", () => {
    for (const typed of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "mailto:a@b.c",
      "glosa://open?path=/x",
      "about:blank",
    ]) {
      const parsed = parseAddress(typed);
      expect(parsed, typed).toMatchObject({ ok: false, reason: "unsupported" });
    }
    expect(addressProblem(parseAddress("file:///etc/passwd"))).toContain("Browser tabs open http and https pages.");
    expect(parseAddress("   ")).toEqual({ ok: false, reason: "empty", text: "" });
    expect(addressProblem(parseAddress(""))).toBe("");
  });

  test("the row says where a page lives: Local, Not secure, or nothing for https", () => {
    expect(describeUrl("http://localhost:5173/docs/start")).toMatchObject({
      where: "Local",
      host: "localhost:5173",
      rest: "/docs/start",
    });
    expect(describeUrl("http://harbour-office.example/reports")).toMatchObject({ where: "Not secure", local: false });
    expect(describeUrl("https://example.org/")).toMatchObject({
      where: "",
      host: "example.org",
      rest: "",
      secure: true,
    });
  });

  test("a local page is one on this machine, and glosa's own ports are glosa", () => {
    expect(isLocalUrl("http://localhost:3000/")).toBe(true);
    expect(isLocalUrl("http://127.0.0.2/")).toBe(true);
    expect(isLocalUrl("https://example.org/")).toBe(false);
    expect(isLocalUrl("file:///x")).toBe(false);
    const spa = "http://glosa.localhost:4646/#w=ws";
    expect(isGlosaAddress("http://127.0.0.1:4646/api/handshake", spa)).toBe(true);
    expect(isGlosaAddress("http://localhost:4647/doc/x", spa)).toBe(true);
    expect(isGlosaAddress("http://localhost:5173/", spa)).toBe(false);
    expect(isGlosaAddress("http://example.org:4646/", spa)).toBe(false);
  });

  test("a tab is named by its page, then its host, then as a new tab", () => {
    expect(browserTabLabel({ title: "Getting started", url: "http://localhost:5173/" })).toBe("Getting started");
    expect(browserTabLabel({ title: "  ", url: "https://example.org/a" })).toBe("example.org");
    expect(browserTabLabel({ title: "", url: "" })).toBe("New browser tab");
  });

  test("a failed load says what happened and offers one way on", () => {
    expect(describeLoadFailure(-3, "https://example.org/")).toBeNull();
    expect(describeLoadFailure(-102, "http://localhost:5173/")).toEqual({
      title: "Nothing is answering at localhost:5173",
      body: "The dev server may not be running. Start it, then reload.",
      action: "reload",
    });
    expect(describeLoadFailure(-105, "https://nowhere.example/")).toMatchObject({
      title: "glosa couldn't find nowhere.example",
      action: "reload",
    });
    expect(describeLoadFailure(-202, "https://staging.tidewater.dev/")).toMatchObject({
      title: "staging.tidewater.dev has a certificate glosa can't trust",
      action: "open-outside",
    });
    expect(describeLoadFailure(-20, "http://127.0.0.1:4646/")).toMatchObject({ action: null });
    expect(describeLoadFailure(-1, "https://example.org/")).toMatchObject({ title: "glosa couldn't load example.org" });
  });
});

describe("the browser pane (#440)", () => {
  let dom: DomEnv;
  let host: any;
  let outside: string[];
  let navigated: Array<{ url: string; title: string }>;

  beforeEach(() => {
    dom = installDom();
    (dom.window as any).happyDOM.setURL("http://glosa.localhost:4646/#w=ws&kind=desk");
    host = dom.document.createElement("div");
    dom.document.body.append(host);
    outside = [];
    navigated = [];
  });
  afterEach(() => {
    dom.teardown();
  });

  const open = (options: Record<string, unknown> = {}) =>
    createBrowserPane(host, {
      openOutside: (url: string) => void outside.push(url),
      onNavigate: (page: { url: string; title: string }) => void navigated.push(page),
      ...options,
    } as any);
  const one = (selector: string): any => host.querySelector(selector);
  /** The guest Electron would attach, as far as the pane can tell: its methods and its events. */
  const guest = (history: { back?: boolean; forward?: boolean; url?: string } = {}) => {
    const view = one("webview");
    const calls: string[] = [];
    Object.assign(view, {
      loadURL: (url: string) => void calls.push(`load ${url}`),
      reload: () => void calls.push("reload"),
      stop: () => void calls.push("stop"),
      goBack: () => void calls.push("back"),
      goForward: () => void calls.push("forward"),
      canGoBack: () => Boolean(history.back),
      canGoForward: () => Boolean(history.forward),
      getURL: () => history.url ?? view.getAttribute("src"),
      getWebContentsId: () => 7,
    });
    return { view, calls };
  };
  const fire = (view: any, type: string, fields: Record<string, unknown> = {}) =>
    view.dispatchEvent(Object.assign(new dom.window.Event(type), fields));
  const submit = (typed: string) => {
    const input = one(".glosa-browser-input");
    input.value = typed;
    input.dispatchEvent(new dom.window.Event("input"));
    one(".glosa-browser-address").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  };

  test("a tab restored with an internet address fetches nothing until Load page", () => {
    open({ url: "https://developer.mozilla.org/en-US/docs/Web/API/Popover_API", restored: true });
    expect(one(".glosa-browser").dataset.state).toBe("unloaded");
    expect(one("webview")).toBeNull();
    expect(one(".glosa-browser-sheet-title").textContent).toBe("developer.mozilla.org");
    expect(one(".glosa-browser-sheet-why").textContent).toContain("fetches nothing until you load it");
    const load = [...host.querySelectorAll(".glosa-browser-sheet button")].find(
      (b: any) => b.textContent === "Load page",
    ) as any;
    load.click();
    expect(one("webview").getAttribute("src")).toBe("https://developer.mozilla.org/en-US/docs/Web/API/Popover_API");
    expect(one("webview").getAttribute("partition")).toBe("persist:glosa-browser");
  });

  test("a tab restored with a local address loads at once; a person's new tab always loads", () => {
    open({ url: "http://localhost:5173/docs", restored: true });
    expect(one("webview").getAttribute("src")).toBe("http://localhost:5173/docs");
    host.replaceChildren();
    open({ url: "https://example.org/", restored: false });
    expect(one("webview").getAttribute("src")).toBe("https://example.org/");
  });

  test("a blank tab explains the field; words get a reason, an address gets a page", () => {
    open();
    expect(one(".glosa-browser").dataset.state).toBe("empty");
    expect(one(".glosa-browser-intro").textContent).toContain("Type an address and press Return.");
    submit("tide table api");
    expect(one("webview")).toBeNull();
    expect(one(".glosa-browser-helper").hidden).toBe(false);
    expect(one(".glosa-browser-input").getAttribute("aria-invalid")).toBe("true");
    submit("localhost:5173");
    expect(one(".glosa-browser-helper").hidden).toBe(true);
    expect(one("webview").getAttribute("src")).toBe("http://localhost:5173/");
    expect(navigated.at(-1)?.url).toBe("http://localhost:5173/");
  });

  test("glosa's own address is refused before anything loads", () => {
    open();
    submit("127.0.0.1:4646/api/handshake");
    expect(one("webview")).toBeNull();
    expect(one(".glosa-browser").dataset.state).toBe("failed");
    expect(one(".glosa-browser-message-title").textContent).toBe("glosa doesn't show 127.0.0.1:4646 in a browser tab");
  });

  test("a failed load is said over the page, and the next load clears it", () => {
    open({ url: "http://localhost:5173/" });
    const { view } = guest();
    fire(view, "dom-ready");
    fire(view, "did-fail-load", { errorCode: -102, validatedURL: "http://localhost:5173/", isMainFrame: true });
    expect(one(".glosa-browser").dataset.state).toBe("failed");
    expect(one(".glosa-browser-message-title").textContent).toBe("Nothing is answering at localhost:5173");
    expect(view.classList.contains("glosa-browser-view-covered")).toBe(true);
    // A frame inside the page failing is the page's business.
    fire(view, "did-start-loading");
    fire(view, "did-fail-load", { errorCode: -102, validatedURL: "http://ads.example/", isMainFrame: false });
    expect(one(".glosa-browser-message")).toBeNull();
    expect(one(".glosa-browser").dataset.state).toBe("loading");
  });

  test("a load that ends without committing leaves the row naming the page that is showing", () => {
    open({ url: "http://localhost:5173/a" });
    const { view } = guest({ url: "http://localhost:5173/a" });
    fire(view, "dom-ready");
    fire(view, "did-navigate", { url: "http://localhost:5173/a" });
    submit("localhost:5173/b");
    expect(one(".glosa-browser-input").value).toBe("http://localhost:5173/b");
    // The shell cancelled it: no failure event, only a stop, and the page is still /a.
    fire(view, "did-start-loading");
    fire(view, "did-stop-loading");
    expect(one(".glosa-browser-input").value).toBe("http://localhost:5173/a");
    expect(one(".glosa-browser-host").textContent).toBe("localhost:5173");
    expect(one(".glosa-browser-rest").textContent).toBe("/a");
  });

  test("back, forward and reload follow the page; reload becomes stop while loading", () => {
    open({ url: "http://localhost:5173/" });
    const { view, calls } = guest({ back: true });
    expect(one(".glosa-browser-back").disabled).toBe(true); // not ready yet
    fire(view, "dom-ready");
    fire(view, "did-navigate", { url: "http://localhost:5173/next" });
    expect(one(".glosa-browser-back").disabled).toBe(false);
    expect(one(".glosa-browser-forward").disabled).toBe(true);
    one(".glosa-browser-back").click();
    fire(view, "did-start-loading");
    expect(one(".glosa-browser-reload").getAttribute("aria-label")).toBe("Stop");
    expect(one(".glosa-browser-progress").hidden).toBe(false);
    one(".glosa-browser-reload").click();
    fire(view, "did-stop-loading");
    expect(one(".glosa-browser-reload").getAttribute("aria-label")).toBe("Reload");
    one(".glosa-browser-reload").click();
    expect(calls).toEqual(["back", "stop", "reload"]);
  });

  test("the title names the tab; a crash offers reload", () => {
    const pane = open({ url: "http://localhost:5173/" });
    const { view } = guest();
    fire(view, "dom-ready");
    fire(view, "page-title-updated", { title: "Getting started · Tidewater" });
    expect(pane.title).toBe("Getting started · Tidewater");
    expect(navigated.at(-1)).toEqual({ url: "http://localhost:5173/", title: "Getting started · Tidewater" });
    fire(view, "render-process-gone");
    expect(one(".glosa-browser").dataset.state).toBe("crashed");
    expect(one(".glosa-browser-message-title").textContent).toBe("This page stopped working");
  });

  test("what the shell refused is said once, with the way out", () => {
    const pane = open({ url: "http://localhost:5173/" });
    pane.handleShellEvent({
      type: "download-blocked",
      name: "tides-2026.pdf",
      url: "http://localhost:5173/report.pdf",
    });
    expect(one(".glosa-browser-notice").hidden).toBe(false);
    expect(one(".glosa-browser-notice-text").textContent).toBe(
      "This page tried to download tides-2026.pdf. glosa doesn't save downloads.",
    );
    one(".glosa-browser-notice-action").click();
    expect(outside).toEqual(["http://localhost:5173/report.pdf"]);
    pane.handleShellEvent({ type: "permission-refused", words: "to show notifications" });
    expect(one(".glosa-browser-notice-text").textContent).toBe(
      "This page asked to show notifications. glosa doesn't allow that.",
    );
    expect(one(".glosa-browser-notice-action").hidden).toBe(true);
    one(".glosa-browser-notice-close").click();
    expect(one(".glosa-browser-notice").hidden).toBe(true);
  });

  test("Open in your browser hands the page's address to the person's own browser", () => {
    open({ url: "https://example.org/a" });
    one(".glosa-browser-outside").click();
    expect(outside).toEqual(["https://example.org/a"]);
  });
});
