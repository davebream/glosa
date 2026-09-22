---
name: glosa-connect
description: Connect this Claude Code session to a registered glosa workspace and open an artifact for human review. Use when the user asks to connect, open, present, or review work in glosa.
---

# Connect to glosa

Work through these in order. Say nothing until the last step — no progress narration.

## 1. Resolve the workspace, before calling any glosa tool

Run `glosa status --json` and look in `data.workspaces`. Keep every row whose `path` contains the
requested directory, compare canonical paths (`realpath`, so `/tmp` and `/private/tmp` match), and
take the longest match. This is the same rule the session monitor uses; if you pick differently,
the two disagree about which workspace this session belongs to.

- **No row contains it** — stop and tell the user to run `glosa open <dir>` once, then retry. Do
  this *before* any glosa tool call: the first one registers whatever directory you happen to be
  in as a workspace of its own, which is rarely the one they meant.
- **The best match has `lifecycle: "forgetting"`** — a `glosa forget` was interrupted part way.
  Stop here. Do not bind, do not open anything, do not offer to. Print that row's `remedy` string
  verbatim; if the row has none, say that the workspace is mid-deletion and that
  `glosa forget <slug> --yes` finishes removing it. Never run `glosa forget` yourself — it deletes
  data. Add one line saying you opened nothing.
- **Only a `forgetting` ancestor matched, and the directory itself is unregistered** — carry on.
  `glosa_present` will register the directory itself. Mention the stuck parent once, at the end.

## 2. Bind

Call `glosa_session_bind` with that workspace directory and the exact value of
`CLAUDE_CODE_SESSION_ID` from this session's environment.

## 3. Start a monitor, unless the host suppresses monitors

Unless `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is `1`, start a monitor
with the Monitor tool, `persistent: true`:

```
glosa monitor --project-dir <the workspace directory>
```

Do not wait for it, do not read its output, and do not mention it. One monitor runs per session no
matter how many things start one, so a redundant one exits immediately and silently — starting it
is cheaper than working out whether you need to.

When either variable *is* set, skip this: the host suppresses glosa's monitor and every other, so
starting one does nothing.

## 4. Present

Call `glosa_present` with the artifact's absolute path — the one the user named, or the workspace's
primary markdown artifact from its metadata.

## 5. Report, in one line

Re-read `glosa status --json` and find this session in `data.sessions` by its session id.

- `push.connected` is `true` —
  `<file> is open in glosa: <url> — your notes reach me here as you write them.`
- `push.connected` is `false` —
  `<file> is open in glosa: <url> — but push delivery is not running, so your notes wait in the
  inbox. Message me and I will pull them.`
- Monitors are suppressed by an environment variable —
  `<file> is open in glosa: <url> — push delivery is off while <VAR> is set. Your notes queue
  safely; message me and I will pull them.`
- The row has no `push` field at all — this daemon is older and cannot say. Report that, not that
  push is down.

Say this on every run, including the good one. Silence is not a report: a healthy session, a check
you skipped, and a crash all look the same to someone about to write notes and walk away.

## When something else fails

Show glosa's message word for word, say `glosa doctor` will explain more, and stop. Errors from
these tools start with a stable code — `workspace-forgetting` and the like — so match on that
rather than on the wording.

Do not open the artifact anyway. `glosa_present` returns a live annotation surface, so a document
that *looks* connected and is not is the exact failure this skill exists to prevent. In the same
line, offer to open it for reading with no routing, and wait to be asked.

Never edit Claude settings and never install hooks.

## Watching for edits made outside glosa

Once bound, this session may call `glosa_watch` to block until a tracked artifact changes on disk
outside glosa. It is opt-in per session on purpose — call it only when the user has asked to be
told about changes made in another editor. Its tool description carries the rest of the contract.
