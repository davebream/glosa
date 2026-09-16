---
name: glosa-connect
description: Connect this Claude Code session to a registered glosa workspace and open an artifact for human review. Use when the user asks to connect, open, present, or review work in glosa.
---

# Connect to glosa

1. Run `glosa status --json` and use its registered workspace list to resolve the requested directory.
2. Read `CLAUDE_CODE_SESSION_ID` from the current session environment.
3. Call `glosa_session_bind` with that exact session id and the workspace directory.
4. When the user named an artifact, call `glosa_present` with its absolute path. Otherwise choose the workspace's primary markdown artifact from its metadata and call `glosa_present`.

If glosa reports that the workspace is not registered, tell the user to run `glosa open` for the workspace once, then retry. Never edit Claude settings or install hooks.

## Watching for edits made outside glosa

Once bound (step 3), this session may call `glosa_watch` to block until a tracked artifact changes
on disk outside glosa — someone editing the file directly in another editor, not through glosa's own
tools. It requires the session to already be explicitly bound; call `glosa_session_bind` first if it
has not bound yet. Only call it when the user has actually asked to be told about external changes —
it is opt-in per session, on purpose: nobody else is nudged by it, and it is never a substitute for
`glosa_inbox_pull`'s ordinary actionable entries. Self-echo is not filtered: a returned entry may be
this session's own un-leased write to the file, not necessarily someone else's change. When the
response's `has_more` is true, call `glosa_watch` again without `since` to drain the rest.
