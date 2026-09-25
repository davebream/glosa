// SPDX-License-Identifier: Apache-2.0
// Go to (⌘K): the palette that replaced the fore-edge rail. Sections of the active document
// first, then the workspace's files; typed words filter, arrows move, Enter goes, Esc closes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommandPalette } from "../src/palette.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("the Go to palette", () => {
  let dom: DomEnv;
  let host: any;
  // happy-dom's DOM classes are nominally distinct from lib.dom's (see dom-env.ts), so DOM
  // handles are read loosely here — the same idiom viewer.test.ts and workbench.test.ts use.
  const one = (selector: string): any => host.querySelector(selector);
  const all = (selector: string): any[] => Array.from(host.querySelectorAll(selector));
  const labels = () => all(".glosa-palette-item .glosa-palette-label").map((node) => node.textContent);
  const key = (name: string) =>
    one(".glosa-palette-input").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true }));
  const type = (value: string) => {
    const input = one(".glosa-palette-input");
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };

  const jumps: string[] = [];
  const opened: string[] = [];
  const section = (text: string, depth = 1, address: string | null = null) => ({
    level: depth,
    depth,
    text,
    address,
    jump: () => jumps.push(text),
  });
  let sections: any = null;
  let files: string[] = [];

  const mount = () =>
    createCommandPalette({
      host,
      getFiles: () => files,
      getSections: () => sections,
      onOpenFile: (path) => opened.push(path),
    });

  beforeEach(() => {
    dom = installDom();
    host = dom.document.createElement("div");
    dom.document.body.append(host);
    jumps.length = 0;
    opened.length = 0;
    files = ["README.md", "docs/requirements.md", "docs/decisions.md"];
    sections = {
      title: "docs/requirements.md",
      entries: [section("Goals", 1, "§1"), section("Scope", 2, "§1.1"), section("Delivery", 1, "§2")],
      current: 1,
    };
  });
  afterEach(() => dom.teardown());

  test("chat search includes older content matches, paginates, and ignores stale responses", async () => {
    const requests: { query: string; after?: string; resolve: (value: any) => void }[] = [];
    const palette = createCommandPalette({
      host,
      getFiles: () => files,
      getSections: () => null,
      onOpenFile: () => {},
      onOpenChat: (id) => opened.push(id),
      searchChats: (query, after) => new Promise((resolve) => requests.push({ query, after, resolve })),
    });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const waitForRequests = async (count: number) => {
      const deadline = Date.now() + 1000;
      while (requests.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(requests).toHaveLength(count);
    };
    try {
      palette.open();
      type("needle");
      await waitForRequests(2);
      requests[1]!.resolve({ chats: [{ id: "old", title: "Older conversation" }], next: "old" });
      await flush();
      expect(labels()).toEqual(["Older conversation"]); // Match is in its contents, not its title.
      requests[0]!.resolve({ chats: [{ id: "stale", title: "Unrelated result" }] });
      await flush();
      expect(labels()).toEqual(["Older conversation"]);
      one(".glosa-palette-more").click();
      expect(requests[2]!.after).toBe("old");
      requests[2]!.resolve({
        chats: [
          { id: "old", title: "Older conversation" },
          { id: "older", title: "Another old chat" },
        ],
      });
      await flush();
      expect(labels()).toEqual(["Older conversation", "Another old chat"]);
      expect(one(".glosa-palette-more").hidden).toBe(true);
      key("ArrowDown");
      key("Enter");
      expect(opened).toEqual(["older"]);
    } finally {
      palette.destroy();
    }
  });

  test("Enter on a search filter keeps native activation instead of opening the active result", () => {
    const palette = mount();
    palette.open();
    const button = one('[data-filter="chat"]');
    button.focus();
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(palette.isOpen()).toBe(true);
    expect(opened).toEqual([]);
    expect(jumps).toEqual([]);
    button.click();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(labels()).toEqual([]);
    palette.destroy();
  });

  test("commands follow sections and files, keep their order, narrow with > and run on Enter", () => {
    const ran: string[] = [];
    const palette = createCommandPalette({
      host,
      getFiles: () => files,
      getSections: () => sections,
      onOpenFile: (path) => opened.push(path),
      getCommands: () => [
        { id: "notes", label: "Hide notes", run: () => ran.push("notes") },
        { id: "edit", label: "Edit", detail: "⌘E", run: () => ran.push("edit") },
      ],
    });
    palette.open();
    expect(all(".glosa-palette-group").map((node) => node.textContent)).toEqual([
      "Sections · docs/requirements.md",
      "Files",
      "Commands",
    ]);
    type(">");
    expect(labels()).toEqual(["Hide notes", "Edit"]);
    key("ArrowDown");
    key("Enter");
    expect(ran).toEqual(["edit"]);
    expect(one(".glosa-palette").hidden).toBe(true);
  });

  test("stays hidden until asked, then lists the active document's sections before the files", () => {
    const palette = mount();
    expect(one(".glosa-palette").hidden).toBe(true);
    palette.open();
    expect(one(".glosa-palette").hidden).toBe(false);
    expect(all(".glosa-palette-group").map((node) => node.textContent)).toEqual([
      "Sections · docs/requirements.md",
      "Files",
    ]);
    expect(labels()).toEqual(["Goals", "Scope", "Delivery", "README.md", "requirements.md", "decisions.md"]);
    expect(all(".glosa-palette-address").map((node) => node.textContent)).toEqual(["§1", "§1.1", "§2"]);
    // Opens on the section the reader is standing in, so ↓ means "the next section" at once.
    expect(one('.glosa-palette-item[aria-selected="true"] .glosa-palette-label').textContent).toBe("Scope");
    expect(one('.glosa-palette-item[aria-current="location"] .glosa-palette-label').textContent).toBe("Scope");
  });

  test("a pane without an outline offers the files alone", () => {
    sections = null;
    mount().open();
    expect(all(".glosa-palette-group").map((node) => node.textContent)).toEqual(["Files"]);
    expect(labels()).toEqual(["README.md", "requirements.md", "decisions.md"]);
  });

  test("every typed word must match, sections keep document order, and prefixes narrow the group", () => {
    mount().open();
    type("de");
    expect(labels()).toEqual(["Delivery", "decisions.md"]);
    type("docs re");
    expect(labels()).toEqual(["requirements.md"]);
    type("#");
    expect(labels()).toEqual(["Goals", "Scope", "Delivery"]);
    type("/");
    expect(labels()).toEqual(["README.md", "requirements.md", "decisions.md"]);
    type("nothing here");
    expect(labels()).toEqual([]);
    expect(one(".glosa-palette-empty").hidden).toBe(false);
  });

  test("arrows move, Enter jumps to a section, and the palette closes", () => {
    const palette = mount();
    palette.open();
    key("ArrowDown");
    expect(one('.glosa-palette-item[aria-selected="true"] .glosa-palette-label').textContent).toBe("Delivery");
    key("Enter");
    expect(jumps).toEqual(["Delivery"]);
    expect(opened).toEqual([]);
    expect(palette.isOpen()).toBe(false);
    expect(one(".glosa-palette").hidden).toBe(true);
  });

  test("Enter on a file opens it by path", () => {
    mount().open();
    type("decisions");
    key("Enter");
    expect(opened).toEqual(["docs/decisions.md"]);
    expect(jumps).toEqual([]);
  });

  test("Escape closes without going anywhere, and toggle is one key both ways", () => {
    const palette = mount();
    palette.toggle();
    expect(palette.isOpen()).toBe(true);
    key("Escape");
    expect(palette.isOpen()).toBe(false);
    expect(jumps).toEqual([]);
    expect(opened).toEqual([]);
    palette.toggle();
    expect(palette.isOpen()).toBe(true);
    palette.toggle();
    expect(palette.isOpen()).toBe(false);
  });

  test("destroy removes the sheet", () => {
    const palette = mount();
    palette.open();
    palette.destroy();
    expect(one(".glosa-palette")).toBeNull();
  });
});
