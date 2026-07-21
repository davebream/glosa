// SPDX-License-Identifier: Apache-2.0
// P3.3 test-only helper: installs a happy-dom `Window`'s DOM globals onto the real `globalThis`
// for the duration of one test file (pure-JS happy-dom, no native addon — matches the repo's
// "no compiled addons" invariant). Copies every non-undefined property happy-dom's `Window`
// exposes EXCEPT `console` — happy-dom's own virtual console doesn't forward to real stdout, so
// blindly copying it silently swallows every `console.log` in the test run (found the hard way
// while prototyping this helper). Skipping already-`undefined` properties is equally load-
// bearing: happy-dom doesn't implement everything (e.g. `WeakSet`), and a naive copy would
// otherwise clobber the real global with `undefined`.
import { Window } from "happy-dom";

export interface DomEnv {
  window: InstanceType<typeof Window>;
  // Deliberately happy-dom's OWN `Document` type (`Window["document"]`), not the ambient TS-lib
  // `Document` — happy-dom's DOM classes (Range, Event, Selection, ...) carry private/symbol
  // fields that make them nominally distinct from lib.dom's same-named interfaces even though
  // they're structurally similar, so mixing the two type systems (e.g. casting this to lib.dom's
  // `Document`) makes every value it produces (`createRange()`, `createElement()`, ...) fail to
  // satisfy the OTHER happy-dom APIs that actually consume them (`Selection#addRange`, etc.).
  // Consumers use happy-dom types throughout instead of casting to `HTMLElement`/`Range`/`Event`.
  document: InstanceType<typeof Window>["document"];
  /** Restores every global this call touched to its pre-install value (or deletes it if it
   * didn't exist before). Call in `afterEach` so DOM state never leaks between test files. */
  teardown: () => void;
}

const SKIP = new Set(["window", "self", "top", "parent", "globalThis", "console"]);

export function installDom(): DomEnv {
  const win = new Window();
  const restore: Array<[string, boolean, unknown]> = [];

  for (const key of Object.getOwnPropertyNames(win)) {
    if (SKIP.has(key)) continue;
    const value = (win as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const g = globalThis as unknown as Record<string, unknown>;
    restore.push([key, Object.hasOwn(g, key), g[key]]);
    g[key] = value;
  }

  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = Object.hasOwn(g, "window");
  const prevWindow = g.window;
  const hadDocument = Object.hasOwn(g, "document");
  const prevDocument = g.document;
  g.window = win;
  g.document = win.document;

  return {
    window: win,
    document: win.document,
    teardown: () => {
      for (const [key, had, prev] of restore) {
        if (had) g[key] = prev;
        else delete g[key];
      }
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
      if (hadDocument) g.document = prevDocument;
      else delete g.document;
    },
  };
}
