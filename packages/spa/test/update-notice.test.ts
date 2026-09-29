// SPDX-License-Identifier: Apache-2.0
// The update notice (#432, R-L6 and R-L8): what the page says when the daemon that served it
// changes, when it asks the desktop shell for a daemon, and that it reloads only on a click.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createUpdateNotice,
  ENSURE_DAEMON_AFTER_MS,
  TERMINAL_HINT_AFTER_MS,
  UPDATE_COPY,
} from "../src/update-notice.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("the update notice", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  /** Manual timers: every scheduled callback with its delay, run on demand. */
  function timers() {
    const pending: { fn: () => void; ms: number }[] = [];
    return {
      pending,
      setTimeout: (fn: () => void, ms: number) => {
        const entry = { fn, ms };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        const i = pending.indexOf(handle as { fn: () => void; ms: number });
        if (i >= 0) pending.splice(i, 1);
      },
      runAll: () => {
        for (const entry of pending.splice(0)) entry.fn();
      },
    };
  }

  const shown = (notice: ReturnType<typeof createUpdateNotice>) => ({
    text: notice.element?.querySelector("span")?.textContent ?? null,
    reload: notice.element?.querySelector("button")?.hidden === false,
  });

  test("a new build offers Reload, and reloads only when it is clicked", () => {
    let reloads = 0;
    const notice = createUpdateNotice({ document: dom.document as never, reload: () => reloads++ });
    notice.show("build-changed");
    expect(shown(notice)).toEqual({ text: UPDATE_COPY.reload, reload: true });
    expect(reloads).toBe(0);
    const button = notice.element?.querySelector("button");
    if (!button) throw new Error("the notice has no Reload button");
    (button as unknown as HTMLButtonElement).click();
    expect(reloads).toBe(1);
  });

  test("it sits in the workbench's banner row when there is one", () => {
    const row = dom.document.createElement("div");
    row.className = "glosa-banners";
    dom.document.body.append(row);
    const notice = createUpdateNotice({ document: dom.document as never, reload: () => {} });
    notice.show("install-changed");
    expect(notice.element?.parentElement).toBe(row as never);
  });

  test("in a plain browser it says glosa is restarting, then how to start it, unless the new build answers", () => {
    const t = timers();
    const notice = createUpdateNotice({ document: dom.document as never, reload: () => {}, ...t });
    notice.show("install-changed");
    expect(shown(notice)).toEqual({ text: UPDATE_COPY.restarting, reload: false });
    expect(t.pending.map((p) => p.ms)).toEqual([TERMINAL_HINT_AFTER_MS]);
    t.runAll();
    expect(shown(notice).text).toBe(UPDATE_COPY.terminal);

    const t2 = timers();
    const second = createUpdateNotice({ document: dom.document as never, reload: () => {}, ...t2 });
    second.show("install-changed");
    second.show("build-changed");
    expect(t2.pending).toHaveLength(0);
    expect(shown(second)).toEqual({ text: UPDATE_COPY.reload, reload: true });
  });

  test("in the desktop app it asks the shell for a daemon, and says why when the shell cannot", async () => {
    for (const [result, expected] of [
      [{ ok: true }, UPDATE_COPY.restarting],
      [{ ok: false, reason: "removed" }, UPDATE_COPY.removed],
      [{ ok: false, reason: "foreign" }, UPDATE_COPY.foreign],
      [{ ok: false, reason: "failed", message: "glosa open failed: boom." }, "glosa open failed: boom."],
    ] as const) {
      const t = timers();
      let asked = 0;
      const notice = createUpdateNotice({
        document: dom.document as never,
        reload: () => {},
        shell: {
          ensureDaemon: async () => {
            asked++;
            return result;
          },
        },
        ...t,
      });
      notice.show("install-changed");
      expect(t.pending.map((p) => p.ms)).toEqual([ENSURE_DAEMON_AFTER_MS]);
      t.runAll();
      await Bun.sleep(0);
      expect(asked).toBe(1);
      expect(shown(notice).text).toBe(expected);
      notice.element?.remove();
    }
  });

  test("no em dash in anything the notice can say", () => {
    for (const line of Object.values(UPDATE_COPY)) expect(line).not.toContain("—");
  });
});
