// SPDX-License-Identifier: Apache-2.0
// The text size step (#406): one size per device for the document, its notes and the chat. These pin
// what a click through the stepper would not show: a stored value that is not a step reads as the
// default, a storage failure still changes the page, the first paint already carries the stored
// step, and the control is a named spinbutton that stops at the ends of the ladder.
//
// What the step does to the page's layout (sizes at each step, the rail, the reader's place) needs a
// real engine and is proved in test/acceptance/reading-scale-real-engine.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import {
  createTextSizeStore,
  DEFAULT_TEXT_SIZE,
  mountTextSizeControl,
  readTextSize,
  TEXT_SIZE_STORAGE_KEY,
  TEXT_SIZES,
} from "../src/text-size.js";
import { type DomEnv, installDom } from "./dom-env.ts";

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(TEXT_SIZE_STORAGE_KEY, initial);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage & { map: Map<string, string> };
}

const failingStorage = {
  getItem: () => {
    throw new Error("unavailable");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("unavailable");
  },
} as unknown as Storage;

/** The three properties and the attribute the step writes on <html>. */
const written = (root: {
  style: { getPropertyValue(name: string): string };
  dataset: Record<string, string | undefined>;
}) => ({
  reading: root.style.getPropertyValue("--reading-step"),
  chat: root.style.getPropertyValue("--chat-step"),
  note: root.style.getPropertyValue("--note-step"),
  size: root.dataset.textSize,
});

describe("the ladder and a stored step", () => {
  test("the ladder runs 15 to 24 with 18 the default", () => {
    expect([...TEXT_SIZES]).toEqual([15, 16, 18, 20, 22, 24]);
    expect(DEFAULT_TEXT_SIZE).toBe(18);
  });

  test("a stored value that is not a step, or storage that cannot be read, is the default", () => {
    expect(readTextSize(fakeStorage("20"))).toBe(20);
    for (const bad of ["19", "18.5", "20px", " 20", "", "large", "__proto__"]) {
      expect(readTextSize(fakeStorage(bad)), JSON.stringify(bad)).toBe(18);
    }
    expect(readTextSize(fakeStorage())).toBe(18);
    expect(readTextSize(failingStorage)).toBe(18);
    expect(readTextSize(undefined)).toBe(18);
  });
});

describe("the text size store", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  const root = () => dom.document.createElement("html") as unknown as HTMLElement;

  test("applies the stored step, the chat one step under and notes two under, on creation", () => {
    const html = root();
    createTextSizeStore({ root: html, storage: fakeStorage("24") });
    expect(written(html)).toEqual({ reading: "24", chat: "22", note: "20", size: "24" });
  });

  test("a chosen step persists, and the default leaves nothing behind", () => {
    const storage = fakeStorage();
    const html = root();
    const store = createTextSizeStore({ root: html, storage });
    const seen: number[] = [];
    store.subscribe((size: number) => seen.push(size));
    store.set(22);
    expect(storage.map.get(TEXT_SIZE_STORAGE_KEY)).toBe("22");
    expect(written(html)).toEqual({ reading: "22", chat: "20", note: "18", size: "22" });
    store.reset();
    expect(storage.map.has(TEXT_SIZE_STORAGE_KEY)).toBe(false);
    expect(seen).toEqual([18, 22, 18]);
  });

  test("a storage failure still changes the page and holds the choice for it", () => {
    const html = root();
    const store = createTextSizeStore({ root: html, storage: failingStorage });
    expect(store.get()).toBe(18);
    store.set(20);
    expect(store.get()).toBe(20);
    expect(written(html)).toEqual({ reading: "20", chat: "18", note: "16", size: "20" });
  });

  test("steps stop at the ends of the ladder, where the chat and notes stop at 15, and a size off it is refused", () => {
    const html = root();
    const store = createTextSizeStore({ root: html, storage: fakeStorage("16") });
    store.step(-1);
    store.step(-1);
    expect(store.get()).toBe(15);
    expect(written(html)).toEqual({ reading: "15", chat: "15", note: "15", size: "15" });
    store.set(24);
    store.step(1);
    expect(store.get()).toBe(24);
    expect(() => store.set(19)).toThrow(TypeError);
    expect(store.get()).toBe(24);
  });

  test("a pane is told before the page takes a new size, while it is still laid out at the old one", () => {
    const html = root();
    const store = createTextSizeStore({ root: html, storage: fakeStorage() });
    const before: string[] = [];
    const after: string[] = [];
    store.beforeChange((next: number) => before.push(`${html.style.getPropertyValue("--reading-step")}->${next}`));
    store.subscribe(() => after.push(html.style.getPropertyValue("--reading-step")));
    store.set(20);
    // Choosing the size already in force is no change: nobody is told.
    store.set(20);
    expect(before).toEqual(["18->20"]);
    expect(after).toEqual(["18", "20"]);
  });
});

// A classic script runs in the page's one global scope: here, the realm the SPA's modules run in.
const runClassicScript = (source: string, filename: string) => runInThisContext(source, { filename });

describe("the step before first paint", () => {
  const PRELOAD_SOURCE = readFileSync(new URL("../src/text-size-preload.js", import.meta.url), "utf8");
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  test("the preload applies the stored step to <html>, and anything unlisted as the default", () => {
    const html = dom.document.documentElement as unknown as HTMLElement;
    dom.window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "16");
    runClassicScript(PRELOAD_SOURCE, "text-size-preload.js");
    expect(written(html)).toEqual({ reading: "16", chat: "15", note: "15", size: "16" });
    dom.window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "huge");
    runClassicScript(PRELOAD_SOURCE, "text-size-preload.js");
    expect(written(html)).toEqual({ reading: "18", chat: "16", note: "15", size: "18" });
  });

  test("the preload paints the default when storage cannot be read", () => {
    const html = dom.document.documentElement as unknown as HTMLElement;
    const described = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
    Object.defineProperty(dom.window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    try {
      runClassicScript(PRELOAD_SOURCE, "text-size-preload.js");
    } finally {
      if (described) Object.defineProperty(dom.window, "localStorage", described);
    }
    expect(written(html)).toEqual({ reading: "18", chat: "16", note: "15", size: "18" });
  });

  test("it loads blocking, after the appearance preload and before the stylesheet", () => {
    const shell = readFileSync(new URL("../src/shell.html", import.meta.url), "utf8");
    const appearance = shell.indexOf('<script src="/app/appearance-preload.js"></script>');
    const textSize = shell.indexOf('<script src="/app/text-size-preload.js"></script>');
    expect(appearance).toBeGreaterThan(-1);
    expect(textSize).toBeGreaterThan(appearance);
    expect(textSize).toBeLessThan(shell.indexOf("/app/app.css"));
  });
});

describe("the text size stepper", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  const key = (target: any, name: string) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  function mount(store: ReturnType<typeof createTextSizeStore>, variant: "menu" | "settings" = "menu") {
    const host = dom.document.createElement("div") as any;
    dom.document.body.append(host);
    const control = mountTextSizeControl(host, store, { variant });
    const q = (selector: string) => host.querySelector(selector);
    return {
      host,
      control,
      value: q('[role="spinbutton"]'),
      smaller: q('[data-step="down"]'),
      larger: q('[data-step="up"]'),
      reset: q(".glosa-text-size-reset"),
    };
  }

  test("is a group named Text size around a spinbutton that carries the step, with − and + outside the tab order", () => {
    const store = createTextSizeStore({ root: dom.document.createElement("html") as any, storage: fakeStorage() });
    const { host, value, smaller, larger, reset } = mount(store);
    const label = dom.document.getElementById(host.getAttribute("aria-labelledby"));
    expect(host.getAttribute("role")).toBe("group");
    expect(label?.textContent).toBe("Text size");
    expect(value.getAttribute("aria-labelledby")).toBe(label?.id);
    expect({
      now: value.getAttribute("aria-valuenow"),
      text: value.getAttribute("aria-valuetext"),
      min: value.getAttribute("aria-valuemin"),
      max: value.getAttribute("aria-valuemax"),
      shown: value.textContent,
      tabIndex: value.tabIndex,
    }).toEqual({ now: "18", text: "18, the default", min: "15", max: "24", shown: "18", tabIndex: 0 });
    expect([smaller.getAttribute("aria-label"), larger.getAttribute("aria-label")]).toEqual([
      "Smaller text",
      "Larger text",
    ]);
    expect([smaller.tabIndex, larger.tabIndex]).toEqual([-1, -1]);
    expect(reset.hidden, "Reset is not offered at the default").toBe(true);
  });

  test("the keys step the size and stay inside the control; − and + stop at the ends and say so", () => {
    const store = createTextSizeStore({ root: dom.document.createElement("html") as any, storage: fakeStorage() });
    const { host, value, smaller, larger } = mount(store);
    // The menu around the control navigates on the arrow keys; it must not see these.
    const reachedMenu: string[] = [];
    host.addEventListener("keydown", (event: KeyboardEvent) => reachedMenu.push(event.key));

    expect(key(value, "ArrowUp").defaultPrevented).toBe(true);
    expect(store.get()).toBe(20);
    key(value, "ArrowRight");
    expect(store.get()).toBe(22);
    key(value, "End");
    expect(store.get()).toBe(24);
    expect(value.getAttribute("aria-valuenow")).toBe("24");
    expect(larger.disabled).toBe(true);
    expect(larger.title).toBe("This is the largest size");
    larger.click();
    expect(store.get()).toBe(24);

    key(value, "Home");
    expect(store.get()).toBe(15);
    expect(smaller.disabled).toBe(true);
    expect(smaller.title).toBe("This is the smallest size");
    key(value, "ArrowDown");
    expect(store.get()).toBe(15);
    expect(reachedMenu, "no stepping key reaches the menu").toEqual([]);

    // Keys that are not the spinbutton's pass through: Escape still closes the menu.
    expect(key(value, "Escape").defaultPrevented).toBe(false);
    expect(reachedMenu).toEqual(["Escape"]);

    larger.click();
    expect(store.get()).toBe(16);
    expect([smaller.disabled, larger.disabled]).toEqual([false, false]);
  });

  test("Reset appears off the default, brings back 18 and hands focus to the value", () => {
    const store = createTextSizeStore({ root: dom.document.createElement("html") as any, storage: fakeStorage("22") });
    const { value, reset } = mount(store);
    expect(reset.hidden).toBe(false);
    expect(reset.getAttribute("aria-label")).toBe("Reset text size to 18");
    reset.focus();
    reset.click();
    expect(store.get()).toBe(18);
    expect(reset.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(value);
  });

  test("the More menu's stepper and Settings' stay in step on one store", () => {
    const store = createTextSizeStore({ root: dom.document.createElement("html") as any, storage: fakeStorage() });
    const menu = mount(store, "menu");
    const settings = mount(store, "settings");
    menu.larger.click();
    expect(settings.value.textContent).toBe("20");
    settings.smaller.click();
    settings.smaller.click();
    expect(menu.value.getAttribute("aria-valuenow")).toBe("16");
    // Each carries its own label id, so two on one page never name each other's value.
    expect(menu.host.getAttribute("aria-labelledby")).not.toBe(settings.host.getAttribute("aria-labelledby"));
    menu.control.destroy();
    settings.larger.click();
    expect(menu.host.childElementCount, "a destroyed control is gone and no longer listening").toBe(0);
  });
});
