# glosa - docs

Technical design and requirements for glosa. Current product direction lives in
the root [`ROADMAP.md`](../ROADMAP.md); live execution status belongs in the public
[Glosa Roadmap project](https://github.com/users/davebream/projects/5).

| File | What it is |
|---|---|
| **`requirements.md`** | **The normative v1 technical contract (v2).** Requirements R1-R9, fixed stack, tasks T0-T8, and the release gate. Start here for implementation behavior, not current priority. |
| `appendices/A1-api-transport.md` | Normative: HTTP v1.1, metadata, attention, streaming-SSE, capability URLs, versioning. |
| `appendices/A2-claude-code-integration.md` | Normative: optional Channels, fallback delivery, explicit binding, transcript tailer, hook shapes. |
| `appendices/A3-security.md` | Normative: two-origin split, CSP, MessageChannel bridge, token lifecycle, confinePath, attack→test matrix. |
| `appendices/A4-filebus-concurrency.md` | Normative: journal-as-truth durability, apply-lease attribution, shadow-git, matcher, slug. |
| `appendices/A5-daemon-architecture.md` | Normative: daemon lifecycle, workspace index, lifecycle state table, anchoring resolution contract. |
| `appendices/A6-cli-platform.md` | Normative: command surface, exit codes, `init` merge/uninstall, platform pins, checkpoint/restore. |
| `decisions.md` | Current public boundary decisions. |
| `options.md` | Concise accepted/rejected integration options. |
| `accessibility.md` | Repeatable WCAG-oriented browser checks and the remaining manual assistive-technology checklist. |
| `research/codex-review.md` | The adversarial review that turned v1 → v2 (32 findings). |
| `research/jsonl-ui-components.md` | Landscape of Claude Code JSONL/stream-json UI components. |
| `research/electron-vs-tauri.md` | Shell research (v1 ships no shell; relevant to a future decision). |
**Precedence**: where `requirements.md` and an appendix disagree, `requirements.md` governs.
