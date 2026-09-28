// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";

export function editReferences(before, after, references) {
  let start = 0,
    oldEnd = before.length,
    newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return references.flatMap((ref) => {
    if (ref.end === start && newEnd > start && /\S/u.test(after[start])) return [];
    if (ref.end <= start) return [ref];
    if (ref.start >= oldEnd) return [{ ...ref, start: ref.start + newEnd - oldEnd, end: ref.end + newEnd - oldEnd }];
    return [];
  });
}
export function composerToken(text, caret) {
  const head = text.slice(0, caret);
  const slash = /^(\s*)\/([^\s]*)$/u.exec(head);
  if (slash) return { kind: "command", start: slash[1].length, end: caret, query: slash[2] };
  const file = /(?:^|\s)(@(?:"[^"\n]*|[^\s@]*))$/u.exec(head);
  return file
    ? { kind: "file", start: caret - file[1].length, end: caret, query: file[1].slice(1).replace(/^"/u, "") }
    : null;
}
export const fileMention = (path) => `@${/^[\p{L}\p{N}_./-]+$/u.test(path) ? path : JSON.stringify(path)}`;

/** A textarea keeps native selection, dictation, IME and undo. The popup never owns focus. */
export function createComposerPicker(
  input,
  { getFiles, getCatalog, loadCatalog, onAction, onChange, enabled = () => true },
) {
  const prefix = `composer-${crypto.randomUUID()}`;
  const popup = el("div", {
    id: prefix,
    className: "glosa-composer-picker",
    popover: "manual",
    role: "listbox",
    "aria-label": "Files and commands",
    hidden: true,
  });
  const live = el("span", { className: "glosa-visually-hidden", role: "status", "aria-live": "polite" });
  const mirror = el("div", { className: "glosa-chat-reference-mirror", "aria-hidden": "true" });
  const wrapper = el("div", { className: "glosa-chat-input-wrap" });
  input.replaceWith(wrapper);
  wrapper.append(mirror, input, live);
  document.body.append(popup);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", prefix);
  input.setAttribute("aria-expanded", "false");
  let references = [],
    previous = input.value,
    token,
    entries = [],
    index = 0;
  let catalog = { commands: [], loaded: false },
    reading = false,
    loading = false,
    error = "",
    disposed = false,
    scope = "",
    generation = 0,
    suppressed = false;
  const appCommands = [
    { id: "mcp", name: "mcp", description: "Tools & workspace access", kind: "app" },
    { id: "mcp-status", name: "mcp-status", description: "Show current tool connections", kind: "app" },
  ];
  function highlight() {
    mirror.replaceChildren();
    let offset = 0;
    for (const ref of [...references].sort((a, b) => a.start - b.start)) {
      mirror.append(
        document.createTextNode(input.value.slice(offset, ref.start)),
        el("mark", { textContent: input.value.slice(ref.start, ref.end) }),
      );
      offset = ref.end;
    }
    mirror.append(document.createTextNode(input.value.slice(offset) + "\n"));
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }
  function close() {
    popup.hidePopover?.();
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    entries = [];
  }
  function position() {
    if (popup.hidden) return;
    const box = wrapper.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    popup.style.width = `${Math.max(0, Math.min(box.width, width - 16))}px`;
    popup.style.left = `${Math.max(left + 8, Math.min(box.left, left + width - popup.offsetWidth - 8))}px`;
    popup.style.maxHeight = `${Math.max(44, Math.min(320, box.top - top - 12))}px`;
    popup.style.top = `${Math.max(top + 8, box.top - popup.offsetHeight - 6)}px`;
  }
  function select(next) {
    index = next;
    for (const [i, row] of [...popup.querySelectorAll('[role="option"]')].entries())
      row.setAttribute("aria-selected", String(i === index));
    const active = popup.querySelector('[aria-selected="true"]');
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function render() {
    if (disposed || suppressed || !enabled() || input.selectionStart !== input.selectionEnd) return close();
    token = composerToken(input.value, input.selectionStart);
    if (!token || document.activeElement !== input) return close();
    const words = token.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const all =
      token.kind === "file"
        ? getFiles().map((path) => ({ id: path, name: path, description: "Workspace file", kind: "file" }))
        : [...appCommands, ...catalog.commands];
    const matches = all.filter((entry) =>
      words.every((word) =>
        `${entry.name} ${entry.description} ${entry.source ?? ""}`.toLocaleLowerCase().includes(word),
      ),
    );
    entries = matches.slice(0, 50);
    if (token.kind === "command")
      entries.push({
        id: "load",
        name: loading ? "Loading commands…" : catalog.loaded ? "Refresh commands" : "Load commands",
        description: error || "Read this account’s native command list",
        kind: "load",
      });
    popup.replaceChildren();
    const groups = new Set(entries.map((entry) => entry.kind));
    let group;
    entries.forEach((entry, i) => {
      if (groups.size > 1 && entry.kind !== group) {
        group = entry.kind;
        popup.append(
          el("div", {
            className: "glosa-composer-group",
            role: "presentation",
            textContent: { app: "Glosa", skill: "Skills", command: "Commands", load: "Account", file: "Files" }[group],
          }),
        );
      }
      const row = el("div", {
        id: `${prefix}-${i}`,
        role: "option",
        "aria-selected": "false",
        className: "glosa-composer-option",
      });
      row.append(
        el("span", {
          className: "glosa-composer-name",
          textContent: `${entry.kind === "file" ? "@" : entry.kind === "load" ? "" : "/"}${entry.name}`,
        }),
        el("span", { className: "glosa-composer-description", textContent: entry.description }),
      );
      if (entry.argumentHint)
        row.append(el("span", { className: "glosa-composer-hint", textContent: entry.argumentHint }));
      if (entry.source) row.append(el("span", { className: "glosa-composer-source", textContent: entry.source }));
      row.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      row.addEventListener("click", () => {
        select(i);
        void accept();
      });
      popup.append(row);
    });
    if (!matches.length && catalog.loaded)
      popup.prepend(el("div", { className: "glosa-composer-empty", textContent: "No matches" }));
    if (!entries.length) popup.append(el("div", { className: "glosa-composer-empty", textContent: "No matches" }));
    if (matches.length > 50)
      popup.append(
        el("div", {
          className: "glosa-composer-empty",
          textContent: `${matches.length} matches. Keep typing to narrow the list.`,
        }),
      );
    popup.hidden = false;
    if (popup.showPopover) {
      try {
        if (!popup.matches(":popover-open")) popup.showPopover();
      } catch {
        /* Fixed positioning is the fallback. */
      }
    }
    input.setAttribute("aria-expanded", "true");
    select(matches.length || !catalog.loaded ? 0 : -1);
    position();
    const announcement = `${matches.length} matches${catalog.stale ? ". Command list needs refreshing" : ""}`;
    if (live.textContent !== announcement) live.textContent = announcement;
    if (token.kind === "command" && !reading) {
      reading = true;
      const current = generation;
      void getCatalog().then(
        (value) => {
          if (!disposed && current === generation) {
            catalog = value;
            resolveTyped();
            render();
          }
        },
        (failure) => {
          if (!disposed && current === generation) {
            error = failure.message;
            render();
          }
        },
      );
    }
  }
  function insert(text, reference) {
    const insertion = { ...token };
    input.focus();
    input.setSelectionRange(insertion.start, insertion.end);
    // insertText is still the browser API that joins a textarea's native undo history.
    if (!document.execCommand?.("insertText", false, text)) {
      input.setRangeText(text, insertion.start, insertion.end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (reference) {
      references = references.filter(
        (ref) => ref.end <= insertion.start || ref.start >= insertion.start + text.trimEnd().length,
      );
      references.push({
        ...reference,
        start: insertion.start,
        end: insertion.start + text.trimEnd().length,
        text: text.trimEnd(),
      });
    }
    previous = input.value;
    highlight();
    onChange();
    close();
    suppressed = true;
  }
  async function accept() {
    const entry = entries[index];
    if (!entry) return false;
    const selectedToken = token;
    const selectedText = input.value,
      selectedGeneration = generation;
    if (entry.kind === "load") {
      if (loading) return true;
      loading = true;
      error = "";
      render();
      const current = generation;
      try {
        const value = await loadCatalog();
        if (current === generation) catalog = value;
      } catch (failure) {
        if (current === generation) error = failure.message;
      } finally {
        if (current === generation) {
          loading = false;
          render();
        }
      }
    } else if (entry.kind === "app") {
      if (input.value.trim() !== `/${selectedToken.query}`) {
        live.textContent = "Use this action on its own. Your draft has been kept.";
        return true;
      }
      try {
        if (await onAction(entry.id)) {
          if (!disposed && input.value === selectedText && selectedGeneration === generation) {
            token = selectedToken;
            insert("", null);
          }
        }
      } catch (failure) {
        live.textContent = failure.message;
      }
    } else
      insert(`${entry.kind === "file" ? fileMention(entry.id) : `/${entry.name}`} `, {
        kind: entry.kind === "file" ? "file" : "command",
        id: entry.id,
      });
    return true;
  }
  function changed() {
    references = editReferences(previous, input.value, references);
    previous = input.value;
    suppressed = false;
    resolveTyped();
    render();
  }
  function keydown(event) {
    if (event.isComposing || event.keyCode === 229 || popup.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      suppressed = true;
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && entries.length) {
      event.preventDefault();
      select((index + (event.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length);
    } else if (["Enter", "Tab"].includes(event.key) && !event.shiftKey && entries[index]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void accept();
    }
  }
  const events = [
    [input, "input", changed],
    [input, "keydown", keydown],
    [input, "click", render],
    [input, "focus", render],
    [input, "blur", close],
    [input, "scroll", highlight],
    [window, "resize", position],
    [document, "scroll", position],
  ];
  for (const [node, name, listener] of events) node.addEventListener(name, listener, true);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          highlight();
          position();
        });
  observer?.observe(wrapper);
  highlight();
  function resolveTyped() {
    const before = JSON.stringify(references);
    const text = input.value;
    const match = /^(\s*)\/([^\s]+)/u.exec(text);
    if (match && !references.some((ref) => ref.kind === "command")) {
      const entries = catalog.commands.filter((entry) => entry.name === match[2]);
      if (entries.length === 1 && !appCommands.some((entry) => entry.name === match[2]))
        references.push({
          kind: "command",
          id: entries[0].id,
          start: match[1].length,
          end: match[0].length,
          text: `/${match[2]}`,
        });
    }
    const files = new Map(getFiles().map((path) => [fileMention(path), path]));
    for (const match of text.matchAll(/(?:^|\s)(@(?:"(?:\\.|[^"\\])*"|[^\s]+))/gu)) {
      const mention = match[1],
        path = files.get(mention);
      const start = match.index + match[0].length - mention.length,
        end = start + mention.length;
      if (path && !references.some((ref) => start < ref.end && end > ref.start))
        references.push({ kind: "file", id: path, text: mention, start, end });
    }
    highlight();
    if (JSON.stringify(references) !== before) onChange();
  }
  return {
    get references() {
      return structuredClone(references);
    },
    setReferences(value) {
      references = structuredClone(value ?? []);
      previous = input.value;
      highlight();
      close();
    },
    setScope(value) {
      if (scope !== value) {
        scope = value;
        generation++;
        reading = false;
        loading = false;
        error = "";
        catalog = { commands: [], loaded: false };
        close();
      }
    },
    resolveTyped,
    destroy() {
      disposed = true;
      generation++;
      observer?.disconnect();
      for (const [node, name, listener] of events) node.removeEventListener(name, listener, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      popup.remove();
    },
  };
}
