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
