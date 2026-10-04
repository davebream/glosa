// SPDX-License-Identifier: Apache-2.0
// The protocol log: a chat's journal as the daemon wrote it, one record a row, newest last. It is
// the chat's own ledger read plainly, the way a traffic monitor shows a wire: what came in, when,
// how big, and the record itself on request. Nothing here can send, answer or start anything.

import { createElement as el } from "./viewer-shell.js";

const PAGE = 200;

/** A record's kind in a reader's words; the raw type stays on the row for the filter. */
const KINDS = {
  created: "chat created",
  changed: "settings changed",
  draft: "draft saved",
  turn: "message accepted",
  turn_status: "turn status",
  content: "content",
  effective_settings: "ran on",
  decision: "decision asked",
  decision_status: "decision status",
  runtime: "runtime",
  usage: "usage",
};

/** `12:04:07.318` for a record's time; the day is the chat's, not the row's. */
function clock(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** `1.2 KB` for a record's size on disk. */
function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/** One line about what a record carries, beside its kind: the status it set, the tool it named. */
function gist(record) {
  const data = record.data ?? {};
  switch (record.type) {
    case "turn_status":
      return `${data.status ?? ""}${data.error ? ` · ${data.error}` : ""}`;
    case "content": {
      const content = data.content ?? {};
      return content.kind === "tool"
        ? `${content.name ?? "tool"} · ${content.status ?? ""}`
        : `${content.kind ?? ""} · ${typeof content.text === "string" ? `${content.text.length} chars` : ""}`;
    }
    case "runtime":
      return data.state ?? "";
    case "decision":
      return data.decision?.title ?? "";
    case "decision_status":
      return data.status ?? "";
    case "effective_settings":
      return [data.model, data.effort].filter(Boolean).join(" · ");
    case "turn":
      return data.turn?.status ?? "";
    case "changed":
      return Object.keys(data)
        .filter((key) => key !== "type")
        .join(", ");
    case "usage":
      return Object.entries(data.value ?? {})
        .map(([key, value]) => `${key} ${value}`)
        .join(" · ");
    default:
      return "";
  }
}

/**
 * @param {HTMLElement} host
 * @param {{ dataAccess: any, slug: string, chatId: string, title?: string }} options
 */
export function createChatLogPane(host, { dataAccess, slug, chatId, title = "Chat" }) {
  let disposed = false,
    records = [],
    hasEarlier = false,
    total = 0,
    filter = "all",
    loading = false,
    stopStream;
  const rows = new Map();
  const element = el("section", {
    className: "glosa-pane glosa-chat-log-pane",
    "aria-label": `Protocol log: ${title}`,
  });
  const heading = el("h2", { className: "glosa-chat-log-title", textContent: "Protocol log" });
  const subject = el("span", { className: "glosa-chat-log-subject", textContent: title });
  const count = el("span", { className: "glosa-chat-log-count", role: "status" });
  const select = el("select", { className: "glosa-chat-log-filter", "aria-label": "Show records of one kind" });
  select.addEventListener("change", () => {
    filter = select.value;
    render();
  });
  const earlier = el("button", {
    type: "button",
    textContent: "Earlier records",
    hidden: true,
    onClick: () => void load(records[0]?.seq),
  });
  const toolbar = el(
    "div",
    { className: "glosa-chat-log-toolbar", role: "toolbar", "aria-label": "Protocol log tools" },
    [heading, subject, count, select],
  );
  const status = el("p", { className: "glosa-chat-log-status", role: "status" });
  const list = el("ol", { className: "glosa-chat-log-list", "aria-label": "Journal records" });
  const scroller = el("div", { className: "glosa-chat-log-scroll" }, [earlier, status, list]);
  element.append(toolbar, scroller);
  host.append(element);

  function kinds() {
    const seen = new Map();
    for (const record of records) seen.set(record.type, (seen.get(record.type) ?? 0) + 1);
    return seen;
  }
  function renderFilter() {
    const seen = kinds();
    const options = [["all", `All kinds · ${records.length}`]].concat(
      [...seen].sort().map(([type, n]) => [type, `${KINDS[type] ?? type} · ${n}`]),
    );
    const signature = options.map(([value, label]) => `${value}:${label}`).join("|");
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.replaceChildren(...options.map(([value, label]) => el("option", { value, textContent: label })));
    select.value = seen.has(filter) || filter === "all" ? filter : "all";
    filter = select.value;
  }
  function row(record) {
    let item = rows.get(record.seq);
    if (item) return item;
    const details = el("details", { className: "glosa-chat-log-record", "data-type": record.type });
    const summary = el("summary", {}, [
      el("span", { className: "glosa-chat-log-seq", textContent: String(record.seq) }),
      el("span", { className: "glosa-chat-log-time", textContent: clock(record.at) }),
      el("span", { className: "glosa-chat-log-kind", textContent: KINDS[record.type] ?? record.type }),
      el("span", { className: "glosa-chat-log-gist", textContent: gist(record) }),
      el("span", { className: "glosa-chat-log-size", textContent: size(record.bytes) }),
    ]);
    const body = el("pre", { className: "glosa-chat-log-body" });
    details.addEventListener("toggle", () => {
      if (details.open && !body.textContent) body.textContent = JSON.stringify(record, null, 2);
    });
    details.append(summary, body);
    item = el("li", {}, [details]);
    rows.set(record.seq, item);
    return item;
  }
  function render() {
    if (disposed) return;
    renderFilter();
    const following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
    const shown = records.filter((record) => filter === "all" || record.type === filter);
    list.replaceChildren(...shown.map(row));
    earlier.hidden = !hasEarlier;
    count.textContent = total ? `${total} ${total === 1 ? "record" : "records"}` : "";
    status.textContent = records.length ? "" : loading ? "Loading the journal…" : "No records yet.";
    if (following) scroller.scrollTop = scroller.scrollHeight;
  }
  async function load(before) {
    if (loading || disposed) return;
    loading = true;
    render();
    try {
      const page = await dataAccess.getChatLog(slug, chatId, before);
      if (disposed) return;
      total = page.total;
      if (before) {
        hasEarlier = page.hasEarlier;
        const seen = new Set(records.map((record) => record.seq));
        records = [...page.records.filter((record) => !seen.has(record.seq)), ...records];
      } else {
        hasEarlier = page.hasEarlier;
        records = page.records;
      }
    } catch (error) {
      status.textContent = error.message || "The journal could not be read.";
    } finally {
      loading = false;
      render();
    }
  }
  function connectStream() {
    stopStream?.();
    stopStream = dataAccess.openChatStream(slug, chatId, {
      onEvent(frame) {
        if (disposed) return;
        if (frame.event === "chat_event") {
          const record = frame.data;
          if (records.some((item) => item.seq === record.seq)) return;
          if (records.length && record.seq !== records.at(-1).seq + 1) return void load();
          records.push({
            seq: record.seq,
            at: record.at,
            type: record.data?.type ?? "unknown",
            ...(record.requestId ? { requestId: record.requestId } : {}),
            bytes: new TextEncoder().encode(JSON.stringify(record)).length + 1,
            data: record.data,
          });
          if (records.length > PAGE * 3) {
            records = records.slice(-PAGE * 2);
            hasEarlier = true;
            for (const seq of [...rows.keys()]) if (seq < records[0].seq) rows.delete(seq);
          }
          total = Math.max(total, record.seq);
          render();
        } else if (frame.event === "chat_snapshot") {
          if (records.length && frame.data.revision > records.at(-1).seq) void load();
        }
      },
    });
  }
  const ready = load().then(() => {
    if (!disposed) connectStream();
  });
  return {
    kind: "chat-log",
    element,
    ready,
    chatId,
    get title() {
      return `Log · ${title}`;
    },
    retitle(next) {
      title = next;
      subject.textContent = next;
      element.setAttribute("aria-label", `Protocol log: ${next}`);
    },
    focus: () => select.focus(),
    rebindPanel() {},
    destroy() {
      disposed = true;
      stopStream?.();
      element.remove();
    },
  };
}
