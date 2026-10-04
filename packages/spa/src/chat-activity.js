// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — what a chat turn is doing, in a reader's words. Pure: a turn and its content in,
// plain labels out. The chat pane draws them; nothing here touches the DOM or the daemon.
//
// A session reports its work as tool items named in its own vocabulary (`Read`, `Bash`,
// `commandExecution`, `mcp__server__tool`). A person reading a conversation wants the act, not the
// identifier: "Reading outline.md", then "Read outline.md" once it is done. A tool this file does
// not know keeps its reported name, so nothing is ever hidden or guessed at.

const ACTIVE = new Set(["dispatching", "running", "waiting", "stopping"]);

/** `[while running, once done]` for the tools both agents report. `%s` is the step's subject. */
const VERBS = {
  Read: ["Reading %s", "Read %s", "a file"],
  Write: ["Writing %s", "Wrote %s", "a file"],
  Edit: ["Editing %s", "Edited %s", "a file"],
  MultiEdit: ["Editing %s", "Edited %s", "a file"],
  NotebookEdit: ["Editing %s", "Edited %s", "a notebook"],
  Bash: ["Running a command", "Ran a command"],
  Grep: ["Searching the files", "Searched the files"],
  Glob: ["Looking for files", "Looked for files"],
  WebSearch: ["Searching the web", "Searched the web"],
  WebFetch: ["Reading %s", "Read %s", "a web page"],
  Task: ["Working with a helper", "Worked with a helper"],
  Agent: ["Working with a helper", "Worked with a helper"],
  TodoWrite: ["Updating its plan", "Updated its plan"],
  commandExecution: ["Running a command", "Ran a command"],
  fileChange: ["Editing files", "Edited files"],
  webSearch: ["Searching the web", "Searched the web"],
  imageView: ["Looking at an image", "Looked at an image"],
};

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** The thing a step acts on, when its reported input names one: a file's name or a page's host. */
function subject(input) {
  if (!input) return "";
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === "string" && path) return path.split("/").filter(Boolean).pop() ?? "";
  if (typeof input.url === "string") {
    try {
      return new URL(input.url).host;
    } catch {
      return "";
    }
  }
  return "";
}

const words = (name) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase();

/**
 * A step's two labels. `subjectHint` is a subject remembered from when the step started: a finished
 * tool reports its result in place of its input, so the name it acted on is gone from `item.text`.
 * @param {{name?: string, text?: string}} item
 * @param {string} [subjectHint]
 * @returns {{doing: string, done: string, subject: string}}
 */
export function stepLabel(item, subjectHint = "") {
  const name = item.name || "Tool";
  const input = parse(item.text ?? "");
  // `mcp__server__tool` (Claude Code) and Codex's `mcpToolCall {server, tool}` are the same act.
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  const server = mcp?.[1] ?? (name === "mcpToolCall" && typeof input?.server === "string" ? input.server : "");
  if (server) {
    const tool = words(mcp?.[2] ?? (typeof input?.tool === "string" ? input.tool : ""));
    const what = `${words(server)}${tool ? `: ${tool}` : ""}`;
    return { doing: `Using ${what}`, done: `Used ${what}`, subject: "" };
  }
  const verb = VERBS[name];
  if (!verb) return { doing: `Using ${name}`, done: `Used ${name}`, subject: "" };
  const about = subjectHint || subject(input);
  const fill = (template) => template.replace("%s", about || (verb[2] ?? ""));
  return { doing: fill(verb[0]), done: fill(verb[1]), subject: about };
}

/**
 * What one turn shows about its own work.
 *   live   the line at the thread's tail while the turn is active, or null once it has ended.
 *   steps  its tool steps in order, each with a label for its state.
 *   summary  the closed steps row: a count, and how many failed.
 * @param {{status: string}} turn
 * @param {{id: string, kind: string, name?: string, text?: string, status?: string}[]} items
 * @param {Map<string, string>} [subjects] step id to remembered subject; filled as steps are seen.
 */
export function turnActivity(turn, items, subjects = new Map()) {
  const steps = items
    .filter((item) => item.kind === "tool")
    .map((item) => {
      const label = stepLabel(item, subjects.get(item.id));
      if (label.subject) subjects.set(item.id, label.subject);
      // A turn that has ended leaves no step running, whatever its last report said.
      const state = item.status === "running" && !ACTIVE.has(turn.status) ? "stopped" : (item.status ?? "completed");
      return { id: item.id, state, label: state === "running" ? label.doing : label.done, detail: item.text ?? "" };
    });
  const failed = steps.filter((step) => step.state === "failed").length;
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  const summary = steps.length ? (failed ? `${count} · ${failed} failed` : count) : "";
  if (!ACTIVE.has(turn.status)) return { live: null, steps, summary };
  const running = steps.findLast((step) => step.state === "running");
  const last = items.at(-1);
  const live =
    turn.status === "dispatching"
      ? "Starting"
      : turn.status === "waiting"
        ? "Waiting for your reply"
        : turn.status === "stopping"
          ? "Stopping"
          : running
            ? running.label
            : last?.kind === "text"
              ? "Writing"
              : "Thinking";
  return { live, steps, summary };
}

/** Seconds as a reader counts them: `8s`, then `1m 05s`. */
export function elapsedLabel(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** Where a message stands in line, as a reader counts: 2nd, 3rd, 4th. */
const ordinal = (place) => ({ 2: "2nd", 3: "3rd" })[place] ?? `${place}th`;
const WAITING = new Set(["accepted", "queued", "held"]);
const AT_WORK = new Set(["dispatching", "running", "waiting", "stopping"]);

/** Where each of a chat's messages stands: the one at work, the one starting, and the ones that
 * wait in the tray above the composer. A message is in the thread once it is the one going to the
 * agent; until then it is a row in the tray, and one removed from there never appears at all.
 * @param {{id: string, status: string, text?: string, started?: boolean}[]} turns the chat's turns, oldest first
 * @param {{id: string, state: "sending" | "failed", text: string}[]} [outbox] sent here, not yet taken by the daemon
 * @param {Set<string>} [kept] cancelled before starting, but to stay in the thread for reuse
 */
export function chatQueue(turns, outbox = [], kept = new Set()) {
  const active = turns.findLast((turn) => AT_WORK.has(turn.status)) ?? null;
  const waiting = turns.filter((turn) => WAITING.has(turn.status));
  // With nothing at work, the first message free to go is already on its way: it is starting.
  const head = active ? null : (waiting.find((turn) => turn.status !== "held") ?? null);
  const local = outbox
    .filter((entry) => !turns.some((turn) => turn.id === entry.id))
    .map((entry) => ({ id: entry.id, kind: entry.state === "failed" ? "failed" : "sending", text: entry.text, entry }));
  const localHead = !active && !head && local[0]?.kind === "sending" ? local.shift() : null;
  let place = 0;
  const tray = [
    ...waiting
      .filter((turn) => turn !== head)
      .map((turn) => ({ id: turn.id, kind: turn.status === "held" ? "held" : "queued", text: turn.text, turn })),
    ...local,
  ].map((row) => ({
    ...row,
    label:
      row.kind === "held"
        ? "Held"
        : row.kind === "failed"
          ? "Not sent"
          : row.kind === "sending"
            ? "Sending"
            : ++place === 1
              ? "Next"
              : ordinal(place),
  }));
  const hidden = new Set(tray.map((row) => row.id));
  for (const turn of turns) if (turn.status === "cancelled" && !turn.started && !kept.has(turn.id)) hidden.add(turn.id);
  return { active, head, localHead, tray, hidden };
}
