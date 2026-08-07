// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — a real line-level unified diff for `glosa init --print` (issue #96).
//
// The previous renderer (one copy in init.ts, another in scoped-init.ts) emitted EVERY before-line
// prefixed `-` followed by EVERY after-line prefixed `+`. The merge underneath was already
// surgical — `mergeSettingsHooks` mutates the parsed object in place and never touches a foreign
// sibling — but a one-hook insert still printed as "the entire file removed and re-added", which
// is what #96 reported and is indistinguishable, on screen, from `init` actually clobbering the
// user's `.claude/settings.json`. `--print` is the consent surface for a config write; it has to
// show what would really change.
//
// Implemented here rather than pulled in: the stack is fixed and dependency-light (AGENTS.md), and
// the one diff package already vendored — diff2html — RENDERS a unified diff, it does not compute
// one. This is ~80 lines of standard Myers/LCS + hunk assembly with no runtime dependency.

const DEFAULT_CONTEXT = 3;

type Op = { kind: "equal" | "delete" | "insert"; line: string };

/**
 * Longest-common-subsequence line alignment.
 *
 * The DP table is O(n*m) in cells. That is fine for the files this renders — `.claude/settings.json`,
 * `.mcp.json`, `.codex/hooks.json`, `.codex/config.toml` are configuration, tens to low-hundreds of
 * lines. `MAX_DP_CELLS` is a guard for the pathological case (someone's settings file is a
 * generated monster): past it, fall back to the old whole-file replacement rather than allocating
 * hundreds of megabytes. A degraded diff beats an OOM, and the fallback is still correct output.
 */
const MAX_DP_CELLS = 4_000_000;

function diffOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;

  if ((n + 1) * (m + 1) > MAX_DP_CELLS) {
    return [
      ...before.map((line): Op => ({ kind: "delete", line })),
      ...after.map((line): Op => ({ kind: "insert", line })),
    ];
  }

  // lcs[i][j] = LCS length of before[i..] and after[j..]
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", line: before[i] as string });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      ops.push({ kind: "delete", line: before[i] as string });
      i++;
    } else {
      ops.push({ kind: "insert", line: after[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "delete", line: before[i++] as string });
  while (j < m) ops.push({ kind: "insert", line: after[j++] as string });
  return ops;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

/** Group the op stream into `@@` hunks, each padded with up to `context` unchanged lines on either
 * side; runs of more than `2 * context` unchanged lines split one hunk from the next. */
function toHunks(ops: Op[], context: number): Hunk[] {
  const changedIndexes = ops.flatMap((op, index) => (op.kind === "equal" ? [] : [index]));
  if (changedIndexes.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const hunks: Hunk[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let cursor = 0;
  for (const [start, end] of ranges) {
    for (; cursor < start; cursor++) {
      const op = ops[cursor] as Op;
      if (op.kind !== "insert") beforeLine++;
      if (op.kind !== "delete") afterLine++;
    }
    const hunk: Hunk = {
      beforeStart: beforeLine,
      beforeCount: 0,
      afterStart: afterLine,
      afterCount: 0,
      lines: [],
    };
    for (; cursor <= end; cursor++) {
      const op = ops[cursor] as Op;
      if (op.kind === "equal") {
        hunk.lines.push(` ${op.line}`);
        hunk.beforeCount++;
        hunk.afterCount++;
        beforeLine++;
        afterLine++;
      } else if (op.kind === "delete") {
        hunk.lines.push(`-${op.line}`);
        hunk.beforeCount++;
        beforeLine++;
      } else {
        hunk.lines.push(`+${op.line}`);
        hunk.afterCount++;
        afterLine++;
      }
    }
    hunks.push(hunk);
  }
  return hunks;
}

/** `@@ -a,b +c,d @@`, collapsing the git-standard `,1` and using start 0 for an empty side. */
function hunkHeader(hunk: Hunk): string {
  const range = (start: number, count: number) =>
    count === 1 ? `${start}` : `${count === 0 ? 0 : start},${count}`;
  return `@@ -${range(hunk.beforeStart, hunk.beforeCount)} +${range(hunk.afterStart, hunk.afterCount)} @@`;
}

/**
 * Render a standard unified diff for one file. `before === null` means the file does not exist yet
 * (rendered `--- /dev/null`, the whole body as `+` lines). Returns `""` when the two sides are
 * identical — callers gate their own "nothing to do" reporting on that.
 *
 * Trailing-newline handling: a file written as `"…}\n"` splits to a final empty element, which
 * would otherwise show up as a phantom blank line in every diff. It is stripped from both sides
 * before aligning, so a real trailing-blank-line change still renders (the line before it differs).
 */
export function renderUnifiedDiff(
  path: string,
  before: string | null,
  after: string,
  context = DEFAULT_CONTEXT,
): string {
  const split = (text: string): string[] => {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const beforeLines = before === null ? [] : split(before);
  const afterLines = split(after);
  const hunks = toHunks(diffOps(beforeLines, afterLines), context);
  if (hunks.length === 0) return "";

  const out = [`--- ${before === null ? "/dev/null" : path}`, `+++ ${path}`];
  for (const hunk of hunks) {
    out.push(hunkHeader(hunk), ...hunk.lines);
  }
  return `${out.join("\n")}\n`;
}
