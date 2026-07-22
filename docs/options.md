# Integration boundary options

The v1 boundary is settled: external integrations supply declarative metadata; glosa does not
embed their packages or workflow logic.

| Option | Decision | Reason |
|---|---|---|
| Import external integration packages | Rejected | Couples releases, dependencies, and domain vocabulary to glosa's core. |
| Infer workflows from filenames or directory layouts | Rejected | Produces hidden, brittle behavior and breaks zero-adapter operation. |
| Register a declarative descriptor through CLI/MCP | Accepted | Durable, inspectable, local, and implementable through the existing generic adapter seam. |
| Keep session binding implicit in terminal cwd | Fallback only | Useful for ordinary workspaces, but incorrect when an agent works from a different directory. |
| Bind a live session explicitly | Accepted | Makes routing intentional without persisting session identity as workspace metadata. |

`WorkspaceMetadataDescriptor` v1 is intentionally small. New fields require a generic use case,
an API version decision, validation and confinement rules, and preserved zero-adapter behavior.

Historical exploration is retained under `docs/archive/`; it is not normative build input.
