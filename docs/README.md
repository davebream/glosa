# glosa - docs

Technical design, requirements, and historical records for glosa. Current product direction lives in
the root [`ROADMAP.md`](../ROADMAP.md); live execution status belongs in the public
[Glosa Roadmap project](https://github.com/users/davebream/projects/5).

| File | What it is |
|---|---|
| **`requirements.md`** | **The normative v1 technical contract (v2).** Requirements R1-R9, fixed stack, tasks T0-T8, and the release gate. Start here for implementation behavior, not current priority. |
| `appendices/A1-api-transport.md` | Normative: HTTP contract, streaming-SSE, cursors/resync, capability URLs, versioning. |
| `appendices/A2-claude-code-integration.md` | Normative: channels, asyncRewake rearm, registry, transcript tailer, hook JSON shapes. |
| `appendices/A3-security.md` | Normative: two-origin split, CSP, MessageChannel bridge, token lifecycle, confinePath, attack→test matrix. |
| `appendices/A4-filebus-concurrency.md` | Normative: journal-as-truth durability, apply-lease attribution, shadow-git, matcher, slug. |
| `appendices/A5-daemon-architecture.md` | Normative: daemon lifecycle, workspace index, lifecycle state table, anchoring resolution contract. |
| `appendices/A6-cli-platform.md` | Normative: command surface, exit codes, `init` merge/uninstall, platform pins, checkpoint/restore. |
| `decisions.md` | The decision log — why things are the way they are. |
| `options.md` | Product rationale / how the design was arrived at. |
| `research/codex-review.md` | The adversarial review that turned v1 → v2 (32 findings). |
| `research/jsonl-ui-components.md` | Landscape of Claude Code JSONL/stream-json UI components. |
| `research/electron-vs-tauri.md` | Shell research (v1 ships no shell; relevant to a future decision). |
| `archive/requirements-v1-superseded.md` | The original v1. **Do not build from this.** |
| `archive/v1-build/` | Frozen autonomous build checklist, log, and orchestrator procedure. Historical evidence only. |

**Precedence**: where `requirements.md` and an appendix disagree, `requirements.md` governs.
