# Pitch: preview-only opens and out-of-workspace artifacts

Status: **accepted direction** — maintainer decisions recorded below (2026-07-23). Per
`AGENTS.md` and `CONTRIBUTING.md`, execution proceeds via one GitHub issue per increment, each
carrying its requirements/appendix delta. Nothing in this document changes the normative
contract by itself.

## Problem

Agents do not always place their artifacts inside the workspace the session runs against, and not
every artifact is meant for review. Two concrete gaps:

1. **Out-of-workspace artifacts.** A coding pipeline works on a repository (a physical directory)
   but writes its plans and design docs elsewhere: a wrapper's hidden directory, a global machine
   location, or a tool's plugin-data directory (Claude plugins storing session artifacts in their
   plugin data dir is a known pattern). Some of these artifacts are still review targets — an
   implementation plan stored outside the repo should remain annotatable and editable, with
   feedback routed to the producing session.
2. **Preview-only artifacts.** Some artifacts are produced for the human to *see*, not to review.
   Today there is no way — CLI or MCP — to open a document with annotation and editing disabled.
   The SPA always offers the full Preview/Annotate/Edit mode set for class-R artifacts.

## What the current architecture already covers

This pitch is narrower than it first appears, because the spec already anticipated most of case 1:

- **A workspace is any directory** — git repo or not (R1, `docs/requirements.md` §3). `glosa open
  <file>` promotes the file's parent directory into a registered workspace
  (`packages/cli/src/open.ts:72-88`, `POST /api/workspaces/open` in
  `packages/daemon/src/http.ts:1337-1355`). A plan sitting in a global directory can be opened
  today; glosa scaffolds `.glosa/` beside it and serves it.
- **Session cwd is already decoupled from the artifact workspace.** This is the explicit-binding
  topology: routing precedence is explicit `workspace_binding` → cwd-ancestor fallback → park
  (R2, A2 §F08; binding resolution in `packages/daemon/src/registry/session-registry.ts:206-219`,
  park/picker decision in `packages/daemon/src/registry/routing.ts:21-44`). The T8 release gate includes
  exactly this scenario: "agent cwd differs from the artifact workspace and routing still
  succeeds" (`docs/requirements.md`, T8). The adversarial review flagged tool-owned artifact
  directories outside the producer's cwd as blocking finding F01
  (`docs/research/codex-review.md`), and `glosa_session_bind` / `workspace_binding` is the
  accepted answer.
- **The SPA already has the mode machinery.** `MODES = ["preview", "annotate", "edit"]` with
  `preview` as default (`packages/spa/src/viewer.js:25,36`), and a precedent for suppressed
  affordances: opaque class-F artifacts (self-contained rendered HTML served via capability URL,
  as opposed to class-R markdown; R6, A1 §5.13) get Preview + Annotate with no Edit tab at all.

So "artifact outside the repo but reviewable" is **not** an unsupported topology. What is actually
missing is (a) sane state placement and blast-radius control when the artifact's parent directory
is a foreign, tool-owned location, (b) one-step ergonomics for the producer, and (c) a
preview-only open mode. Those are the three parts of this pitch.

## Architectural analysis: where out-of-workspace artifacts really hurt

One non-negotiable framing first: **serving a bare file with no owning workspace is not viable.**
Every serving path is a `(workspaceRoot, relPath)` pair confined by `confinePath`
(`packages/daemon/src/confine-path.ts:27-59`, A3 §3); provenance depends on the shadow repo whose
work-tree *is* the workspace root (A4 §F21); the journal, inbox, and per-workspace mutex are all
keyed by the workspace canonical path (A4 §F04, §F19). A workspace-less file would violate A3 as
written and make invariants 2 and 3 (journal as truth, honest provenance) inoperable. Any design
must keep per-root confinement; the question is only *which* root and *where its state lives*.

Given that, the concrete problems with today's parent-dir promotion:

### P1 — glosa writes state into directories other tools own

Promotion scaffolds `<root>/.glosa/` — journal, inbox, quarantine, `shadow.git`
(`packages/daemon/src/bus/paths.ts:8-34`). Inside a repo that is the designed behavior. Inside a
plugin-data directory or a wrapper's hidden directory it means glosa deposits a git repo and an
append-only journal into a directory whose owner may clean, migrate, or checksum it at any time.
Consequences: silent journal/provenance loss when the owner wipes the dir, possible breakage of
the owning tool, and clutter the user never asked for. The root may also simply be read-only.

### P2 — parent-dir promotion has an unbounded blast radius

The tracked-artifact matcher, watcher, sidebar, and shadow-git baseline all operate on everything
matched under the promoted root (R1, A4 §F20). Opening one plan inside a busy tool-owned
directory tracks, watches, and baselines *every* matched sibling file — potentially large, noisy,
and none of the user's business. The matcher's dot-dir exclusion (R1, A4 §F20) protects
subdirectories, not the case where the promoted root itself is deep inside a tool's data tree.

### P3 — workspace proliferation

Every distinct out-of-repo location becomes its own registry workspace with its own slug, state,
and GC lifecycle (`packages/daemon/src/registry/workspace-index.ts`). A pipeline that scatters
artifacts across three locations makes one project appear as four workspaces in the sidebar and
multiplies the session-binding/picker surface. GC (24 h grace) bounds the registry but not the
conceptual mess.

### P4 — producer ergonomics: nothing connects "I wrote it there" to "review it here"

cwd-ancestor fallback can never reach an out-of-repo artifact, by design. The producing session
must (1) open/register the artifact's workspace and (2) explicitly bind to it, or annotations
park until something does. Both primitives exist (`glosa open`, `glosa_session_bind`), but no
single CLI/MCP step does register → bind → present, so real pipelines will skip it and feedback
will strand.

## Proposal

Three increments, ordered by leverage and independence. All keep the six invariants; deltas that
require spec edits are called out.

### 1. Preview-only open mode (CLI + MCP)

- `glosa open <path> --preview` deep-links the SPA with a lock flag (e.g. `#…&mode=preview&lock=1`
  alongside the existing `#t=…&w=…&a=…` fragment, `packages/cli/src/open.ts:116-118`). The SPA
  hides Annotate and Edit for that visit — same pattern as class-F's missing Edit tab.
- **Honest scope:** this is a UI affordance, not a security boundary. The API will still accept
  an annotation POST for that artifact; the lock only shapes the presented surface. That is the
  intended semantics ("this artifact is not for review"), and the doc/issue should say so
  explicitly so it is never mistaken for access control.
- Intent lives **per open, not per document**. Classifying documents by intent ("plans are
  reviewable, reports are not") would be domain knowledge in the core — invariant 1 forbids it.
  A producer that wants a document presented read-only says so at open time.
- MCP: there is currently **no open/present tool at all** — the seven tools are inbox/metadata/
  binding/ack (`packages/cli/src/mcp-tools.ts`). **Decided:** `glosa_present {path, mode}` joins
  the v1 MCP surface. Shape: the tool registers/opens the artifact and **returns the ready URL —
  it never launches a browser itself**; presentation to the human travels through the existing
  delivery ladder or a human click. Spec delta: A6 (CLI contract) + A1 (fragment contract) + the
  MCP tool table.

### 2. Three open modes; single-file opens stop promoting the parent directory

A survey of how editors and writing tools handle "open a single file outside any project"
(VS Code/Cursor empty window + `workspaceStorage/<hash>/`, JetBrains LightEdit, Zed single-file
worktrees, Sublime global session state, Obsidian's explicit-vault requirement, Vim's
`undodir//` convention) is unanimous on three points: no surveyed tool implicitly promotes a
file's parent directory into a project; per-folder state lives in a global app dir keyed by
path, not inside the opened folder; and where tools *do* write into folders (`.vscode/`,
`.idea/`, `.obsidian/`), it happens only after explicit project designation — and is a chronic
source of user complaints even then. glosa's current parent-dir promotion + `.glosa/`
scaffolding on single-file open is the pattern the field rejected.

**Decided design — the argument shape is the intent:**

```
glosa open <dir>            --> workspace UX (sidebar, hierarchy), first file focused
glosa open <dir> <file>     --> workspace UX, that file focused (today's deep-link)
glosa open <file>           --> document UX: no sidebar, no multi-file chrome at all
```

Single-file open is a first-class presentation mode (Zed's model), not a degraded workspace.
Under the hood, presentation is decoupled from state so provenance never forks:

- **File inside an already-registered workspace root:** minimal document UI, but annotations,
  edits, and journal entries flow into that workspace's existing bus and route via its existing
  bindings. The same file must never accumulate two divergent journals (invariant 2).
- **Genuinely loose file:** a bounded single-file registration — the tracked LIST contains just
  that file — with the bus placed under `GLOSA_HOME/state/<workspace-hash>/` instead of
  `<root>/.glosa/`. Nothing is ever written beside the file. The daemon's single-writer mutex,
  journal replay, and shadow-git (`--git-dir` redirected, `--work-tree` unchanged) all survive;
  only the *location* of state moves. A4/A5 spec delta (F04's paths stop being literally under
  the root); the registry records the bus location so daemon and CLI resolve it identically.
  Per-workspace config overrides for such registrations live in the redirected state dir
  (`.glosa/config.json` cannot, since nothing is written to the root).
- **Adoption rule:** if the parent directory is later opened as a full workspace, the daemon
  migrates the redirected journal/shadow history into the workspace's bus — history follows the
  document.
- **Directory opens:** unchanged from today, with one addition — state redirection is also
  available as an opt-in flag for foreign/tool-owned roots, and applies automatically when the
  root is unwritable (a generic filesystem property, not domain knowledge; scaffolding would
  fail there anyway).

### 3. One-step producer flow

`glosa open <path> --bind <session-id>` (CLI) and the same composition via MCP: register the
workspace, bind the calling session, optionally apply `--preview`. This turns the F01 remedy from
"two primitives a pipeline must remember to compose" into one call, which is the difference
between explicit binding existing and explicit binding being used.

## Invariant check

| Invariant | Verdict |
|---|---|
| 1 Generic core | Preserved — intent is per-open UI state; no document classification in core |
| 2 Journal is truth | Preserved — redirection moves the journal's path, not its authority; needs A4 delta |
| 3 Honest provenance | Preserved — shadow repo keeps a real work-tree; out-of-workspace edits without it were never attributable anyway |
| 4 No cmux | Untouched |
| 5 Local-first | Preserved — `GLOSA_HOME` state is still local; no new egress |
| 6 One data-access module | Preserved — lock flag and present flow ride existing API + fragment |

## Decisions (maintainer, 2026-07-23)

1. **Preview lock is UI-only.** It expresses intent, not access control; the API keeps accepting
   annotation POSTs for locked opens, and documentation must never present the lock as a
   security boundary.
2. **State redirection trigger:** opt-in flag, plus automatic redirection when the root is
   unwritable. No tool-path heuristics in the core (invariant 1).
3. **`glosa_present` ships in the v1 MCP surface**, URL-returning, never browser-launching.
4. **Three open modes as above.** Single-file open = document UX (no sidebar, no multi-file
   chrome); loose files get bounded registrations with `GLOSA_HOME`-redirected state; an owning
   workspace's bus always wins over a parallel registration; adoption migrates history.
5. **Sequencing: all increments land before the T8 gate closes**, so the manual rehearsal
   exercises the new open-mode surface rather than the promotion behavior this document retires.

## Process

One GitHub issue per increment (1–3), each carrying its spec delta list (A1/A4/A5/A6 +
requirements.md where governing text changes). This document then becomes background, not
contract.
