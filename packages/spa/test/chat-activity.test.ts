// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { elapsedLabel, stepLabel, turnActivity } from "../src/chat-activity.js";

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
