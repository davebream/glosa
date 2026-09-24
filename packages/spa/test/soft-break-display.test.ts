// SPDX-License-Identifier: Apache-2.0
// A soft break is a `\n` the rich face keeps in the text (#173) and Preview draws as a space. The
// editor's surface is `white-space: pre-wrap`, where a `\n` is a line, so without the decoration
// below a hand-wrapped paragraph re-wraps at every source break the moment it becomes editable and
// the whole page below it moves. These tests pin the two halves that make the break collapse: the
// span the view draws around each `\n`, and the rule in app.css that gives that span `normal`.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SOFT_BREAK_CLASS,
  mountRichEditor,
  parseMarkdown,
  softBreakDecorations,
  softBreakPlugin,
} from "../src/rich-editor.js";
import { EditorState, TextSelection } from "../src/vendor/prosemirror.js";
import { type DomEnv, installDom } from "./dom-env.ts";

const WRAPPED =
  "Status: phases 1–3 implemented; phase 4 synthetic validation passed, live\n" +
  "pilot incomplete. Operator contract: `campaign-goals-runtime.md`. Based on the\n" +
  "campaign audit described in `campaign-goals-audit-2026-09-15.md`.";

describe("a soft break is drawn as a space, not a line", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  function mount(markdown: string) {
    const host = dom.document.createElement("div");
    host.className = "glosa-run-editor";
    dom.document.body.append(host);
    // happy-dom's `HTMLElement` is nominally distinct from lib.dom's — see dom-env.ts's header.
    const editor = mountRichEditor(host as any, { markdown, toolbar: false });
    return { host, editor };
  }

  test("the view wraps every `\\n` of a hand-wrapped paragraph, and nothing else, in the span", () => {
    const { host, editor } = mount(WRAPPED);
    const spans = Array.from(host.querySelectorAll(`.ProseMirror .${SOFT_BREAK_CLASS}`));
    expect(spans.map((span) => span.textContent)).toEqual(["\n", "\n"]);
    // The paragraph's text is the source's text (code spans lose their backticks to the mark):
    // the `\n` is still there, only dressed.
    expect(host.querySelector(".ProseMirror p")?.textContent).toBe(WRAPPED.replaceAll("`", ""));
    expect(editor.getMarkdown()).toBe(WRAPPED);
  });

  test("a fenced block's newlines are lines and stay undecorated", () => {
    const doc = parseMarkdown("```\nfirst line\nsecond line\n```\n\nprose that\nwraps");
    const decorations = softBreakDecorations(doc).find();
    expect(decorations).toHaveLength(1);
    const [only] = decorations;
    expect(doc.textBetween(only.from, only.to)).toBe("\n");
    expect(doc.textBetween(only.from - 4, only.from)).toBe("that");
  });

  test("app.css gives that span `white-space: normal`, under the surface that is `pre-wrap`", () => {
    const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
    const rule = css.match(/\.glosa-rich-surface \.glosa-soft-break \{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/white-space:\s*normal;/);
    expect(css).toMatch(/\.glosa-rich-surface \.ProseMirror \{[^}]*white-space:\s*pre-wrap;/);
    expect(SOFT_BREAK_CLASS).toBe("glosa-soft-break");
  });
});

// The two guards that keep the collapsed break a `\n` in the model. Under `white-space: normal` the
// character is collapsible whitespace, and WebKit rewrote it to a no-break space on the first
// keystroke typed beside it (Safari 26.6: `live\npilot` → `live&nbsp;Xpilot`). happy-dom does no
// such rebalancing, so the guards are exercised at the state level, where the plugin's own hooks run.
describe("a soft break survives typing beside it", () => {
  const WRAPPED_SHORT = "one two\nthree four";
  // The vendored bundle's types are loose (`apply` returns an untyped `t`), so the state is `any`.
  const withPlugin = (markdown: string): any =>
    EditorState.create({ doc: parseMarkdown(markdown), plugins: [softBreakPlugin()] });
  const breakPos = (state: any) => {
    let found = -1;
    state.doc.descendants((node: any, pos: number) => {
      if (found === -1 && node.isText && node.text?.includes("\n")) found = pos + node.text.indexOf("\n");
    });
    return found;
  };

  test("a browser rewrite of the break into whitespace is put back, marks and typed text intact", () => {
    const state = withPlugin("one *two\nthree* four");
    const at = breakPos(state);
    // What `readDOMChange` reports after WebKit's rebalance: the `\n` and the typed `X` as one step.
    const rewritten = state.apply(state.tr.replaceWith(at, at + 1, state.schema.text(" X")));
    expect(rewritten.doc.textContent).toBe("one two\nXthree four");
    const restored = rewritten.doc.resolve(at).nodeAfter;
    expect(restored?.text?.startsWith("\n")).toBe(true);
    expect(restored?.marks.map((mark: any) => mark.type.name)).toEqual(["em"]);
    // The caret-before-the-break shape, and a plain space rather than an NBSP.
    const other = state.apply(state.tr.replaceWith(at, at + 1, state.schema.text("X ")));
    expect(other.doc.textContent).toBe("one twoX\nthree four");
  });

  test("a break the writer overtypes, or deletes, is not resurrected", () => {
    const state = withPlugin(WRAPPED_SHORT);
    const at = breakPos(state);
    expect(state.apply(state.tr.replaceWith(at, at + 1, state.schema.text("x"))).doc.textContent).toBe(
      "one twoxthree four",
    );
    expect(state.apply(state.tr.delete(at, at + 1)).doc.textContent).toBe("one twothree four");
    // Typed text arrives through the interceptor and says so; a space typed over a selected break
    // is the writer's decision.
    const typed = state.tr.insertText(" ", at, at + 1).setMeta(softBreakPlugin(), "typed");
    expect(state.apply(typed).doc.textContent).toBe("one two three four");
  });

  test("text input beside a break is taken from the browser and inserted through the model", () => {
    const state = withPlugin(WRAPPED_SHORT);
    const at = breakPos(state);
    const plugin: any = softBreakPlugin();
    const beforeinput = plugin.props.handleDOMEvents.beforeinput as (view: any, event: any) => boolean;
    const run = (selectionAt: number, inputType: string, data: string | null) => {
      let dispatched: any = null;
      const view = {
        state: state.apply(state.tr.setSelection(TextSelection.create(state.doc, selectionAt))),
        dispatch: (tr: any) => {
          dispatched = tr;
        },
      };
      const event = {
        inputType,
        data,
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      const handled = beforeinput(view, event);
      return {
        handled,
        prevented: event.prevented,
        text: dispatched ? view.state.apply(dispatched).doc.textContent : null,
      };
    };
    expect(run(at + 1, "insertText", "X")).toEqual({ handled: true, prevented: true, text: "one two\nXthree four" });
    expect(run(at, "insertText", "X")).toEqual({ handled: true, prevented: true, text: "one twoX\nthree four" });
    // Away from a break the browser keeps the keystroke, and composition is never intercepted.
    expect(run(1, "insertText", "X")).toEqual({ handled: false, prevented: false, text: null });
    expect(run(at + 1, "insertCompositionText", "X")).toEqual({ handled: false, prevented: false, text: null });
  });
});
