// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { chatQueue, elapsedLabel, stepLabel, turnActivity } from "../src/chat-activity.js";

const tool = (id: string, name: string, status: string, text = "") => ({ id, kind: "tool", name, status, text });

test("a step is named for what it does, in the tense of its state, and never guessed at", () => {
  expect(stepLabel({ name: "Read", text: '{"file_path":"/work/notes/outline.md"}' })).toEqual({
    doing: "Reading outline.md",
    done: "Read outline.md",
    subject: "outline.md",
  });
  // A finished tool reports its result where its input was: the file's name comes from the hint.
  expect(stepLabel({ name: "Read", text: "1→# Outline" }, "outline.md").done).toBe("Read outline.md");
  expect(stepLabel({ name: "Read", text: "1→# Outline" }).done).toBe("Read a file");
  expect(stepLabel({ name: "WebFetch", text: '{"url":"https://example.com/guide?x=1"}' }).doing).toBe(
    "Reading example.com",
  );
  expect(stepLabel({ name: "mcp__claude_of_alexandria__get_verse", text: "{}" }).doing).toBe(
    "Using claude of alexandria: get verse",
  );
  expect(stepLabel({ name: "mcpToolCall", text: '{"server":"glosa","tool":"glosa_present"}' }).done).toBe(
    "Used glosa: glosa present",
  );
  expect(stepLabel({ name: "commandExecution", text: '{"command":"ls"}' }).doing).toBe("Running a command");
  // A tool outside the vocabulary keeps the name the session reported.
  expect(stepLabel({ name: "SomethingNew", text: "{}" }).doing).toBe("Using SomethingNew");
});

test("a turn at work says what it is doing now; a finished one keeps only its steps", () => {
  const subjects = new Map<string, string>();
  expect(turnActivity({ status: "dispatching" }, []).live).toBe("Starting");
  expect(turnActivity({ status: "running" }, []).live).toBe("Thinking");
  const reading = [tool("t1", "Read", "running", '{"file_path":"a/outline.md"}')];
  expect(turnActivity({ status: "running" }, reading, subjects)).toEqual({
    live: "Reading outline.md",
    summary: "1 step",
    steps: [{ id: "t1", state: "running", label: "Reading outline.md", detail: '{"file_path":"a/outline.md"}' }],
  });
  const written = [
    tool("t1", "Read", "completed", "# Outline"),
    tool("t2", "Bash", "failed", "exit 1"),
    { id: "a", kind: "text", text: "Here is" },
  ];
  const writing = turnActivity({ status: "running" }, written, subjects);
  expect(writing.live).toBe("Writing");
  expect(writing.summary).toBe("2 steps · 1 failed");
  expect(writing.steps.map((step) => step.label)).toEqual(["Read outline.md", "Ran a command"]);
  expect(turnActivity({ status: "waiting" }, written, subjects).live).toBe("Waiting for your reply");
  expect(turnActivity({ status: "stopping" }, written, subjects).live).toBe("Stopping");
  // An ended turn has nothing live, and a step it left running is shown as stopped, not at work.
  const ended = turnActivity({ status: "cancelled" }, [tool("t3", "Bash", "running")]);
  expect(ended.live).toBeNull();
  expect(ended.steps[0]).toMatchObject({ state: "stopped", label: "Ran a command" });
  expect(turnActivity({ status: "completed" }, []).summary).toBe("");
});

test("elapsed time reads as a person counts it", () => {
  expect([0, 8.9, 59, 60, 65, 600].map(elapsedLabel)).toEqual(["0s", "8s", "59s", "1m 00s", "1m 05s", "10m 00s"]);
});

test("chatQueue: the message at work or starting is in the thread, the rest wait in the tray in order", () => {
  const turn = (id: string, status: string, more = {}) => ({ id, status, text: id, ...more });
  // A reply at work: everything behind it waits, counted from "Next".
  const busy = chatQueue([turn("a", "running"), turn("b", "queued"), turn("c", "held"), turn("d", "queued")]);
  expect(busy.active!.id).toBe("a");
  expect(busy.head).toBeNull();
  expect(busy.tray.map((row) => `${row.id}:${row.label}`)).toEqual(["b:Next", "c:Held", "d:2nd"]);
  expect([...busy.hidden]).toEqual(["b", "c", "d"]);
  // Nothing at work: the first message free to go is starting, so it is in the thread, not the tray.
  const idle = chatQueue([turn("a", "completed"), turn("b", "held"), turn("c", "queued"), turn("d", "queued")]);
  expect(idle.head!.id).toBe("c");
  expect(idle.tray.map((row) => `${row.id}:${row.label}`)).toEqual(["b:Held", "d:Next"]);
  // Sent here and not yet taken: in the thread when nothing is ahead, otherwise at the tray's end.
  const sending = { id: "x", state: "sending" as const, text: "x" };
  expect(chatQueue([turn("a", "completed")], [sending]).localHead!.id).toBe("x");
  const behind = chatQueue([turn("a", "running")], [sending, { id: "y", state: "failed", text: "y" }]);
  expect(behind.localHead).toBeNull();
  expect(behind.tray.map((row) => `${row.id}:${row.label}`)).toEqual(["x:Sending", "y:Not sent"]);
  // An entry the daemon has after all is the daemon's turn, not a second row.
  expect(chatQueue([turn("a", "running"), turn("x", "queued")], [sending]).tray.map((row) => row.id)).toEqual(["x"]);
  // Cancelled before it reached the agent, a message is not in the thread unless it was kept.
  const cancelled = [turn("a", "cancelled"), turn("b", "cancelled", { started: true })];
  expect([...chatQueue(cancelled).hidden]).toEqual(["a"]);
  expect([...chatQueue(cancelled, [], new Set(["a"])).hidden]).toEqual([]);
});
