// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — the fore-edge index: one pane's document outline, in the space a manuscript
// already leaves empty.
//
// A thick manuscript on a desk is navigated from its edge — you see the page block side-on and
// the sections as bands in it. That is what this draws. A column of hairline rules sits at the
// pane's left inset, one rule per heading, placed where that heading actually falls in the
// document and cut to a length that states its depth. At rest it is graphite: you read your own
// position and the shape of the document without reading a word. Hover it, or reach it with the
// keyboard, and it becomes the labelled outline.
//
// Three rules govern it, and each is load-bearing:
//
//   * IT IS PAINTED, NEVER RESERVED. The rail and its panel are absolutely positioned at every
//     width and in every mode, so no gutter is ever subtracted from the measure. A pane narrow
//     enough that the artifact fills it keeps the full artifact; the rail simply moves into the
//     2rem gutter `.glosa-content` and `.glosa-edit-wrap` already leave inside their own padding,
//     where it cannot touch a glyph. This is the same promise §7 of the 2026-09-04 brief makes
//     about the annotation rail, held at the other edge.
//   * IT IS PANE FURNITURE, NOT A MARK ON THE TEXT. It pins to the pane and does not scroll with
//     the content. DESIGN.md already spends the immediate gutter on two vocabularies — a
//     reviewer's annotation ON the words, a session's sideline BESIDE them — and a third hairline
//     idiom 14px from the text would be unreadable against them. Distance and stillness are what
//     keep it a fourth thing.
//   * IT NEVER COVERS THE WRITING IF IT CAN AVOID IT. The panel opens rightward into the
//     whitespace and is sized from the measured text block, so on a wide pane the outline lands
//     entirely beside the manuscript. On a pane too narrow to hold it there it overlays, the way
//     every other transient popover in the workbench does.
//
// Transport-free by construction: the pane hands this module its entries and its jump callbacks;
// it never reads an artifact, and never touches data-access.

import { createElement as el } from "./viewer-shell.js";

/** Rule length by outline depth, in px. Right edges stay flush, so depth reads as indentation
 * turned on its side — the same shape the labelled panel draws, one glance cheaper. */
const RULE_WIDTHS = [14, 11, 8, 6, 5, 4];
const RULE_HEIGHT = 2;
/** Two rules closer than this are one smudge. `distributeRules` spends real document position
 * down to this gap and then starts trading it for legibility. */
const MIN_RULE_GAP = 5;
/** Long enough that crossing the rail on the way to the navigator does not open it; short enough
 * that reaching for it deliberately never feels like waiting. */
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 200;
/** Matches artifact-tree.js, so the two navigators forget a half-typed query at the same speed. */
const FILTER_IDLE_MS = 650;
/** How far below the scroller's top edge a heading counts as "the section you are in". A heading
 * exactly at the top edge is the one you just arrived at, so the line has to sit below it. */
const CURRENT_HEADING_OFFSET = 96;
/** Air left above a jumped-to heading, so it lands as the top of a section rather than flush
 * against the pane's chrome. */
const JUMP_HEADROOM = 24;

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/**
 * @typedef {{ level: number, depth: number, text: string, fraction: number, jump: () => void }} OutlineEntry
 */

/** Markdown source is not rendered text: a heading reads `## The **hard** part` on disk and
 * `The hard part` on the page. The panel shows one document, so both paths have to arrive at the
 * same string. Deliberately shallow — enough for emphasis, code spans, and links, which is what
 * headings actually carry. */
/** @param {unknown} raw */
export function plainHeadingText(raw) {
  return String(raw ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](href) and ![alt](src)
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1") // [label][ref]
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headings out of a rendered artifact (Read, Review, and Edit's rich face all paint real DOM).
 *
 * @param {{ querySelectorAll: (selector: string) => Iterable<any> } | null} root
 * @returns {{ level: number, text: string, el: Element }[]}
 */
export function collectRenderedHeadings(root) {
  if (!root) return [];
  /** @type {{ level: number, text: string, el: Element }[]} */
  const found = [];
  for (const node of root.querySelectorAll(HEADING_SELECTOR)) {
    const text = plainHeadingText(node.textContent ?? "");
    if (!text) continue; // an empty heading is a typo, not a destination
    found.push({ level: Number(node.tagName.slice(1)) || 1, text, el: node });
  }
  return found;
}

/**
 * Headings out of markdown source (Edit's source face has no rendered DOM to read).
 *
 * Fenced blocks are skipped, because `# not a heading` inside a shell example is exactly the kind
 * of false destination that makes an outline untrustworthy. Setext headings (`===` / `---` under
 * a line) are included too — they are rare in this corpus but they are real headings, and an
 * outline that silently drops one is worse than no outline.
 *
 * @param {string} source
 * @returns {{ level: number, text: string, line: number, offset: number }[]}
 */
export function collectSourceHeadings(source) {
  const text = String(source ?? "");
  const lines = text.split("\n");
  /** @type {{ level: number, text: string, line: number, offset: number }[]} */
  const found = [];
  let offset = 0;
  let previousStart = 0;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineStart = offset;
    // Captured before any `continue` below, so a setext underline can always name the offset of
    // the line above it no matter which branch skipped that line.
    const prevStart = previousStart;
    previousStart = lineStart;
    offset += line.length + 1;

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = fenceMatch?.[1] ?? "";
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }

    const atx = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(line);
    if (atx) {
      const body = plainHeadingText((atx[2] ?? "").replace(/\s+#+\s*$/, ""));
      if (body) found.push({ level: (atx[1] ?? "#").length, text: body, line: index, offset: lineStart });
      continue;
    }

    const setext = /^\s{0,3}(=+|-+)\s*$/.exec(line);
    if (setext && index > 0) {
      const previous = lines[index - 1] ?? "";
      // A `---` under a blank line is a thematic break, and under a list item it is that item's
      // rule — neither is a heading, and both are common.
      if (previous.trim() && !/^\s{0,3}([-*+]|\d+[.)])\s/.test(previous) && !/^\s{0,3}(#{1,6})\s/.test(previous)) {
        const body = plainHeadingText(previous);
        // The offset is the heading's own line, not its underline: jumping here must put the
        // caret on the words, not on the rule under them.
        if (body) {
          found.push({ level: setext[1]?.[0] === "=" ? 1 : 2, text: body, line: index - 1, offset: prevStart });
        }
      }
    }
  }
  return found;
}

/**
 * Turns raw heading levels into outline depth. A document whose headings start at `##` — most
 * fragments, and every file this workspace holds that is a section of something larger — must
 * indent from its own first level, not from an absent `#`.
 *
 * @param {{ level: number }[]} headings
 * @returns {number[]} one 1-based depth per heading
 */
export function outlineDepths(headings) {
  if (!headings.length) return [];
  const top = Math.min(...headings.map((heading) => heading.level));
  /** @type {number[]} */
  const stack = [];
  return headings.map((heading) => {
    const level = Math.max(heading.level, top);
    while (stack.length && (stack[stack.length - 1] ?? 0) >= level) stack.pop();
    stack.push(level);
    return stack.length;
  });
}

/**
 * Places one rule per heading along a rail of `railHeight` pixels.
 *
 * The rail is a map, not a list: a rule's position is where its section actually falls in the
 * document, so a reader sees that section 3 is half the file and section 8 is a stub. Two rules
 * that land within `minGap` of each other would say nothing, so the crowd is spread — forward
 * first, then pulled back off the bottom if the spread ran past the end. Density survives as
 * texture, which is honest: that part of the document really is dense.
 *
 * Pure, and the reason this is a separate export: the placement is the one part of the fore-edge
 * that has to be right without a browser to look at.
 *
 * @param {number[]} fractions 0..1 positions in document order
 * @param {number} railHeight
 * @param {{ ruleHeight?: number, minGap?: number }} [options]
 * @returns {number[]} one top offset in px per fraction
 */
export function distributeRules(fractions, railHeight, { ruleHeight = RULE_HEIGHT, minGap = MIN_RULE_GAP } = {}) {
  const count = fractions.length;
  if (!count) return [];
  const span = Math.max(0, railHeight - ruleHeight);
  const tops = fractions.map((fraction) => {
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    return Math.round(clamped * span);
  });
  /** @param {number} index */
  const at = (index) => tops[index] ?? 0;
  for (let index = 1; index < count; index += 1) {
    if (at(index) - at(index - 1) < minGap) tops[index] = at(index - 1) + minGap;
  }
  if (at(count - 1) > span) {
    tops[count - 1] = span;
    for (let index = count - 2; index >= 0; index -= 1) {
      if (at(index + 1) - at(index) < minGap) tops[index] = at(index + 1) - minGap;
    }
  }
  return tops.map((top) => Math.min(span, Math.max(0, top)));
}

/**
 * Every whitespace-separated word in the query must appear in the heading, case-insensitively and
 * in any order — `func req` finds "Functional requirements", `attention` finds "R9 — attention
 * model", `r4 delivery` finds "R4 — delivery: provider-based, cmux-free".
 *
 * Deliberately NOT a scattered-letter fuzzy match. Headings here are prose, and long: this file's
 * own outline contains "R3 — file bus: inbox, journal (=truth), provenance (detail: A4 §F04/§F05,
 * A5 §F23)". Across strings that long, a subsequence matcher finds `attn` inside "What changed
 * from v1 (orientation for anyone who read v1)" and returns it beside the heading the reader
 * actually wanted. A filter that answers with things you cannot see why it chose is worse than a
 * stricter one that never surprises you.
 *
 * Matches never reorder the list either. The outline's order IS the document, and sorting by score
 * would answer "which heading is most like what I typed" when the question was "where in this
 * document is it".
 *
 * @param {string} text
 * @param {string} query
 */
export function matchesQuery(text, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = text.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * The index of the heading a reader is currently inside: the last one whose top has passed the
 * reading line. Before the first heading, nothing is current — the reader is in the preamble, and
 * claiming they are in section 1 would be a small lie told constantly.
 *
 * @param {number[]} tops heading offsets in the scroller's content, in document order
 * @param {number} scrollTop
 * @param {number} [line]
 * @returns {number} index, or -1
 */
export function currentHeadingIndex(tops, scrollTop, line = CURRENT_HEADING_OFFSET) {
  let current = -1;
  for (let index = 0; index < tops.length; index += 1) {
    if ((tops[index] ?? 0) - scrollTop <= line) current = index;
    else break;
  }
  return current;
}

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Mounts the fore-edge into a pane.
 *
 * `host` must be a positioned element (`.glosa-pane` is `position: relative`). Everything this
 * returns is driven by the pane: it knows which surface is showing, so it collects the entries and
 * owns the jump; this module owns the instrument.
 *
 * @param {{
 *   host: any,
 *   id: string,
 *   onOpenChange?: (open: boolean) => void,
 * }} options
 */
export function createOutlineController({ host, id, onOpenChange = () => {} }) {
  /** @type {OutlineEntry[]} */
  let entries = [];
  let currentIndex = -1;
  let open = false;
  /** Opened by pointer, or held open by keyboard/⌘J. A sticky panel ignores pointer-leave, so
   * moving the mouse away while reading with the keyboard does not close it under you. */
  let sticky = false;
  let filter = "";
  /** @type {any} */ let filterIdleTimer = null;
  /** @type {any} */ let openTimer = null;
  /** @type {any} */ let closeTimer = null;
  /** Row index that owns the roving tabindex, in the FILTERED list. */
  let activeRow = 0;
  let signature = "";
  /** True when the pane has no whitespace left to open the panel into. Hover-to-open is withdrawn
   * there — see `setCompact`. */
  let compact = false;
  let destroyed = false;

  const rulesEl = el("span", { className: "glosa-foreedge-rules", "aria-hidden": "true" });
  const railEl = el("button", {
    className: "glosa-foreedge-rail",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": id,
  });
  railEl.append(el("span", { className: "glosa-visually-hidden", textContent: "Outline" }), rulesEl);

  const filterEl = el("input", {
    className: "glosa-foreedge-filter",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Filter headings",
    "aria-label": "Filter headings",
  });
  const listEl = el("div", { className: "glosa-foreedge-list", role: "tree", "aria-label": "Outline" });
  const emptyEl = el("p", {
    className: "glosa-foreedge-empty",
    role: "status",
    textContent: "No heading matches that.",
    hidden: true,
  });
  const panelEl = el("div", { className: "glosa-foreedge-panel", id, hidden: true }, [filterEl, listEl, emptyEl]);
  const rootEl = el("nav", { className: "glosa-foreedge", "aria-label": "Document outline", hidden: true }, [
    railEl,
    panelEl,
  ]);
  host.append(rootEl);

  const visibleEntries = () => entries.filter((entry) => matchesQuery(entry.text, filter));

  function clearTimers() {
    if (openTimer) clearTimeout(openTimer);
    if (closeTimer) clearTimeout(closeTimer);
    openTimer = null;
    closeTimer = null;
  }

  function renderRules() {
    rulesEl.textContent = "";
    if (!entries.length) return;
    const railHeight = rulesEl.clientHeight || railEl.clientHeight;
    if (!railHeight) return;
    const tops = distributeRules(
      entries.map((entry) => entry.fraction),
      railHeight,
    );
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const rule = el("i", { className: "glosa-foreedge-rule" });
      rule.style.top = `${tops[index] ?? 0}px`;
      rule.style.width = `${RULE_WIDTHS[Math.min(entry.depth, RULE_WIDTHS.length) - 1]}px`;
      if (index === currentIndex) rule.setAttribute("data-current", "true");
      rulesEl.append(rule);
    }
  }

  function renderList() {
    const shown = visibleEntries();
    listEl.textContent = "";
    emptyEl.hidden = shown.length > 0 || !entries.length;
    activeRow = Math.min(activeRow, Math.max(0, shown.length - 1));
    for (let index = 0; index < shown.length; index += 1) {
      const entry = shown[index];
      if (!entry) continue;
      const row = el("button", {
        className: "glosa-foreedge-row",
        type: "button",
        role: "treeitem",
        tabIndex: index === activeRow ? 0 : -1,
        "aria-level": String(entry.depth),
        textContent: entry.text,
        title: entry.text, // rows ellipsize at 200-288px; the full heading stays recoverable
      });
      const depth = Math.min(entry.depth, 6) - 1;
      row.style.setProperty("--outline-depth", String(depth));
      row.setAttribute("data-depth", String(depth));
      if (entry === entries[currentIndex]) row.setAttribute("aria-current", "location");
      row.addEventListener("click", () => {
        entry.jump();
        close({ restoreFocus: false });
      });
      listEl.append(row);
    }
  }

  function rows() {
    return /** @type {any[]} */ ([...listEl.querySelectorAll(".glosa-foreedge-row")]);
  }

  /** @param {number} index */
  function focusRow(index) {
    const all = rows();
    if (!all.length) return;
    activeRow = Math.min(Math.max(index, 0), all.length - 1);
    for (let i = 0; i < all.length; i += 1) all[i].tabIndex = i === activeRow ? 0 : -1;
    all[activeRow]?.focus({ preventScroll: true });
  }

  /** @param {boolean} next @param {{ focus?: boolean }} [options] */
  function setOpen(next, { focus = false } = {}) {
    if (destroyed || (next && !entries.length)) return;
    if (open === next && !focus) return;
    open = next;
    sticky = next && focus;
    rootEl.setAttribute("data-open", String(open));
    railEl.setAttribute("aria-expanded", String(open));
    panelEl.hidden = !open;
    if (!open) {
      filter = "";
      filterEl.value = "";
      activeRow = 0;
    } else {
      // The outline opens on the section the reader is standing in, not at the top of a document
      // they have already scrolled halfway down.
      const shown = visibleEntries();
      const anchor = entries[currentIndex];
      activeRow = Math.max(0, anchor ? shown.indexOf(anchor) : 0);
      renderList();
      scrollActiveIntoView();
    }
    if (open && focus) queueMicrotask(() => filterEl.focus({ preventScroll: true }));
    onOpenChange(open);
  }

  function scrollActiveIntoView() {
    const all = rows();
    all[activeRow]?.scrollIntoView({ block: "nearest" });
  }

  function close({ restoreFocus = true } = {}) {
    clearTimers();
    const wasOpen = open;
    setOpen(false);
    if (wasOpen && restoreFocus) queueMicrotask(() => railEl.focus({ preventScroll: true }));
  }

  function onPointerEnter() {
    // Hover opens the outline only where opening it costs the reader nothing. Once the artifact
    // fills its pane the panel has nowhere to go but over the words, and the rail is sitting in
    // the margin the pointer crosses on its way to the first character of a line — so the same
    // gesture that selects a sentence would keep throwing a panel over it. There it waits to be
    // asked: a click, Enter, ⌘J, or the pane's Outline row.
    if (destroyed || compact || !entries.length) return;
    clearTimers();
    if (open) return;
    openTimer = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
  }

  function onPointerLeave() {
    clearTimers();
    if (!open || sticky) return;
    closeTimer = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  }

  function onRailClick() {
    // Hover has usually opened it already; this is the touch and click path, and the way back for
    // a pointer that left and came back before the close timer ran.
    if (open) sticky = true;
    else setOpen(true);
  }

  /** @param {any} event */
  function onRailKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // Deliberately NOT on focus. Tab landing on the rail names it and shows a ring; opening a
      // panel over the manuscript because focus passed through would be a surprise, and closing
      // it returns focus here — which, on a focus-to-open rail, reopens what you just closed.
      setOpen(true);
      sticky = true;
      focusRow(activeRow);
      return;
    }
    if (event.key === "Escape") close();
  }

  function onFilterInput() {
    filter = filterEl.value;
    activeRow = 0;
    renderList();
    if (filterIdleTimer) clearTimeout(filterIdleTimer);
    // A query left behind after a pause is a trap the next reader falls into. The panel forgets
    // it on the same idle clock the artifact tree uses.
    filterIdleTimer = setTimeout(() => {
      filterIdleTimer = null;
    }, FILTER_IDLE_MS);
  }

  /** @param {any} event */
  function onFilterKeydown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = visibleEntries()[0];
      if (!first) return;
      first.jump();
      close({ restoreFocus: false });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (filterEl.value) {
        filterEl.value = "";
        onFilterInput();
        return;
      }
      close();
    }
  }

  /** @param {any} event */
  function onListKeydown(event) {
    const all = rows();
    if (!all.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowUp" && activeRow === 0) {
      event.preventDefault();
      filterEl.focus({ preventScroll: true });
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? activeRow + 1
        : event.key === "ArrowUp"
          ? activeRow - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    focusRow(next);
  }

  /** @param {any} event */
  function onFocusOut(event) {
    if (!sticky) return;
    // Focus leaving the whole instrument closes it; moving between the filter and a row does not.
    if (rootEl.contains(event.relatedTarget)) return;
    setOpen(false);
  }

  rootEl.addEventListener("pointerenter", onPointerEnter);
  rootEl.addEventListener("pointerleave", onPointerLeave);
  rootEl.addEventListener("focusout", onFocusOut);
  railEl.addEventListener("keydown", onRailKeydown);
  railEl.addEventListener("click", onRailClick);
  filterEl.addEventListener("input", onFilterInput);
  filterEl.addEventListener("keydown", onFilterKeydown);
  listEl.addEventListener("keydown", onListKeydown);

  return {
    element: rootEl,

    /**
     * Replaces the outline. Cheap to call on every render: an unchanged document rebuilds nothing,
     * which matters because a live artifact re-renders on every journal event.
     *
     * @param {OutlineEntry[]} next
     */
    setEntries(next) {
      const incoming = Array.isArray(next) ? next : [];
      // Fewer than two headings is not an outline — it is a title, and the reader is already
      // looking at it. The instrument stands down rather than offering a list of one.
      const usable = incoming.length >= 2 ? incoming : [];
      const nextSignature = usable
        .map((entry) => `${entry.depth}:${entry.fraction.toFixed(4)}:${entry.text}`)
        .join("|");
      entries = usable;
      rootEl.hidden = !usable.length;
      if (!usable.length) {
        signature = "";
        if (open) setOpen(false);
        rulesEl.textContent = "";
        return;
      }
      if (nextSignature === signature) return;
      signature = nextSignature;
      renderRules();
      if (open) renderList();
    },

    /** @param {number} index */
    setCurrent(index) {
      const next = Number.isInteger(index) ? index : -1;
      if (next === currentIndex) return;
      currentIndex = next;
      const all = [...rulesEl.children];
      for (let i = 0; i < all.length; i += 1) {
        if (i === currentIndex) all[i]?.setAttribute("data-current", "true");
        else all[i]?.removeAttribute("data-current");
      }
      // A colon, not a dash: headings in this corpus carry em dashes of their own, and
      // "Outline — in R4 — delivery" is a sentence a screen reader cannot punctuate.
      railEl.setAttribute(
        "aria-label",
        currentIndex >= 0 && entries[currentIndex] ? `Outline: in ${entries[currentIndex]?.text}` : "Outline",
      );
      // Marks the row in place rather than rebuilding the list: scrolling the manuscript while the
      // outline is open must not take the keyboard focus, or the typed filter, out from under the
      // reader.
      if (!open) return;
      const marker = entries[currentIndex];
      for (const row of rows()) {
        if (marker && row.textContent === marker.text) row.setAttribute("aria-current", "location");
        else row.removeAttribute("aria-current");
      }
    },

    /** Re-places the rules after the rail's own height changed (a pane resize, a mode switch). */
    remeasure() {
      if (entries.length) renderRules();
    },

    hasEntries: () => entries.length > 0,
    isOpen: () => open,

    /** @param {boolean} next whether the pane has run out of whitespace beside the text */
    setCompact(next) {
      compact = Boolean(next);
      rootEl.setAttribute("data-compact", String(compact));
    },

    /** The keyboard door — ⌘J, and the pane's ⋯ menu. Toggles, so the same key closes it. */
    toggle() {
      if (open) close();
      else setOpen(true, { focus: true });
    },

    close,

    destroy() {
      destroyed = true;
      clearTimers();
      if (filterIdleTimer) clearTimeout(filterIdleTimer);
      rootEl.removeEventListener("pointerenter", onPointerEnter);
      rootEl.removeEventListener("pointerleave", onPointerLeave);
      rootEl.removeEventListener("focusout", onFocusOut);
      railEl.removeEventListener("keydown", onRailKeydown);
      railEl.removeEventListener("click", onRailClick);
      filterEl.removeEventListener("input", onFilterInput);
      filterEl.removeEventListener("keydown", onFilterKeydown);
      listEl.removeEventListener("keydown", onListKeydown);
      rootEl.remove();
    },
  };
}

/**
 * Pixel offsets of `offsets` character positions inside a textarea, measured through a mirror
 * element that carries the textarea's own metrics.
 *
 * A textarea gives no geometry for its own content, and `line * lineHeight` is wrong the moment a
 * paragraph wraps — which, in markdown source at a 100-character measure, is most paragraphs. The
 * mirror is the only way to get this right, so it is worth its twenty lines.
 *
 * @param {any} textarea
 * @param {number[]} offsets
 * @returns {number[]}
 */
export function measureTextareaOffsets(textarea, offsets) {
  if (!offsets.length || typeof document === "undefined") return offsets.map(() => 0);
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of [
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "tabSize",
    "textIndent",
    "textTransform",
    "wordSpacing",
    "overflowWrap",
  ]) {
    /** @type {any} */ (mirror.style)[property] = /** @type {any} */ (computed)[property];
  }
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = "auto";
  document.body.append(mirror);
  const marker = document.createElement("span");
  marker.textContent = "​";
  const text = textarea.value ?? "";
  const results = offsets.map((offset) => {
    mirror.textContent = text.slice(0, Math.max(0, offset));
    mirror.append(marker);
    return marker.offsetTop;
  });
  mirror.remove();
  return results;
}

/**
 * Scrolls a container so `top` lands just under its upper edge, honouring reduced motion.
 *
 * @param {any} scroller
 * @param {number} top
 */
export function scrollToOffset(scroller, top) {
  const target = Math.max(0, top - JUMP_HEADROOM);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: target, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return;
  }
  scroller.scrollTop = target;
}

export const OUTLINE_TUNING = {
  RULE_WIDTHS,
  RULE_HEIGHT,
  MIN_RULE_GAP,
  HOVER_OPEN_MS,
  HOVER_CLOSE_MS,
  CURRENT_HEADING_OFFSET,
  JUMP_HEADROOM,
};
