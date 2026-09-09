# Public boundary decisions

This file records current architectural boundaries. `docs/requirements.md` and its normative
appendices remain the authoritative build input.

## External integrations are declarative

External integrations own their packages, workflow logic, and domain vocabulary. They register a
`WorkspaceMetadataDescriptor` v1 through glosa's CLI or MCP tools. glosa persists one active
descriptor per workspace and exposes it through the existing generic `ContentAdapter` interface.

The descriptor may declare artifact class, ordering, a derived-from edge, and a manifest location.
The core interprets only those generic fields. It does not import an integration package, inspect
an integration's state schema, or infer workflow behavior from filenames.

## Session routing is explicit when cwd is insufficient

Providers register live sessions. An external integration may then bind a live session to a glosa
workspace through `glosa session bind` or `glosa_session_bind`. Bindings are session-scoped and
must be restored explicitly after daemon restart. MCP activity restores registration automatically;
explicit binding also registers unknown identities and renews expired leases. Provider identity comes
from the provider environment or an explicit selector; absent evidence uses generic MCP, never a
transcript-recency guess. Open transport connections refresh the shared registry lease; closing one
stops refreshes and leaves expiry to the TTL. Monitor and Codex subscription transports consume this
contract in their own follow-up issues.

## Runtime trust boundary

glosa remains local-first and makes no telemetry or external runtime calls. Channels are an
optional delivery optimization. Hook, turn-boundary, and MCP delivery remain supported fallbacks.

## Token lifecycle is a local filesystem authority

Rotation and revocation mutate the single mode-0600 token file directly instead of calling an API
route. This keeps recovery available when the daemon is stopped or its in-memory token state is stale,
and avoids a second persisted epoch whose update could not be atomic with the token file. Atomic rename
or unlink is the durable linearization point; the daemon derives an in-memory generation from the
complete current value.

The daemon combines a directory watcher with request-time refresh. A generation change aborts existing
credential-bound streams and clears class-F capabilities; subsequent Bearer checks accept only the new
value. The CLI never returns the replacement token. `glosa open` remains the explicit browser-pairing
boundary and recovery path.

## The URL fragment is the canonical on-screen focus

The SPA reflects the current workspace and open artifact into the address-bar fragment
(`#w=<slug>&a=<artifact>`) via `history.replaceState` as the user navigates, not only on load. This
makes reload/refresh restore the view and makes the URL shareable, so focus lives in one place
instead of duplicated UI state. The deep-link is no longer one-shot: `readRoute` seeds the initial
view and `writeFocus` keeps it current thereafter.

Three constraints hold this inside the security boundary:

- **Fragment, never query string.** Focus stays in the `#` fragment so it is never sent to the
  daemon or written to its request path (A1 §2) — the same reason the pairing token uses the
  fragment.
- **The written fragment carries only `w`/`a`, never `t=`.** `focusHash` is rebuilt from scratch on
  every call and reads only slug/artifact, so live-reflecting focus can never re-expose the pairing
  token that `scrubSecrets` strips on load (A3 §3/F24). This is structural, not a runtime filter.
- **`replaceState`, not `pushState`.** Reflecting focus does not spawn a history entry per artifact;
  it mutates the current one.

Mode (Preview/Annotate/Edit) is deliberately **not** in the URL. It is an act with a stateful save
guard (leaving Edit while dirty is blocked pending a discard prompt), and a shareable link should
land in Preview rather than the source editor — modes are acts, not defaults.

## Ownership rule

A change that needs integration-specific code belongs outside this repository. A change belongs in
glosa only when it strengthens a generic contract that remains useful with zero adapters loaded.

## Agent onboarding is scoped, targeted, and lazy

Research snapshot: 2026-07-25. The comparison uses first-party documentation and the current Sentry
Wizard source rather than assuming the examples in issue #65 remained unchanged.

| Tool | Scope model | Target detection/selection | Interaction pattern |
|---|---|---|---|
| Claude Code | MCP has explicit `local` (private project), `project` (shared `.mcp.json`), and `user` scopes; settings also have user, shared-project, and local-project layers. | Single-agent tool, so no agent selection. | `claude mcp add` is flag-driven; `--scope` is explicit and no setup wizard is required. |
| Codex | Personal defaults live in `~/.codex/config.toml`; trusted repositories may add `.codex/config.toml`. Hooks follow the same user/project split. `codex mcp add` currently writes the user config; project scope is configured in the project file. | Single-agent tool, so no agent selection. | CLI add is flag-driven. Authentication may prompt, but scope selection is not a wizard. |
| Sentry Wizard | Mutates the selected project; it has no user/global configuration scope. | The integration is supplied with `--integration` or selected from a prompt. Contrary to the original issue snapshot, the current dispatcher does not auto-detect the framework. | Interactive by default where choices are missing; explicit flags support scripted runs. `--quiet` prevents fallback questions in legacy flows, and a narrower `--non-interactive` mode exists for agentic Apple setup. |
| glosa (decision) | `workspace` (default) or explicit `user`. | Repeated `--agent` flags are authoritative. Provider-owned, local-only probes may resolve an omitted target when exactly one provider is present; ambiguous selection gets one TTY prompt or a usage error in non-interactive mode. | Flags are the complete automation surface. Prompts fill only an unresolved provider choice and never occur in `--json` or non-TTY mode. |

Sources:

- [Claude Code MCP scopes](https://docs.anthropic.com/en/docs/claude-code/mcp#installation-scope)
  and [settings precedence](https://docs.anthropic.com/en/docs/claude-code/settings#settings-files)
- [Codex configuration layers](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Sentry Wizard options](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/README.md#options),
  [CLI flags](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/bin.ts),
  and [integration selection](https://github.com/getsentry/sentry-wizard/blob/3aaa362582cf848da7c1ba7936356af8ef9e8721/src/run.ts)

The resulting glosa design is:

- `glosa open` is the first-run path. It creates workspace state and opens Preview without installing
  hooks or agent configuration. Preview-only `glosa_present` remains session-independent.
- `glosa init` installs delivery integration only when the user wants feedback routing, hooks,
  conversation delivery, or optional Channels. It never runs implicitly from `open`.
- `--scope workspace` is the compatibility-preserving default. `--scope user` is an explicit choice
  because user hooks run in every project and therefore have a wider overhead and trust surface.
- Agent detection is advisory and local-only: provider executables and existing provider config may
  inform a default, but glosa never launches an agent, reads a transcript, or performs network
  discovery during init.
- Provider-specific config paths, detection, desired nodes, and activation help come from
  `packages/providers/*`. The generic CLI owns selection, transaction/rollback, backups, and the
  ownership manifest; it does not gain Claude Code or Codex branches.

## A glosa install never stops a daemon it did not start

`build_id` answers "which bytes is this daemon running"; it cannot answer "whose daemon is this".
Those are different questions, and conflating them made every command a takeover: a source checkout
and a published install of the same version each read the other as a divergent build and SIGTERMed
it, so the two evicted each other continuously. Observed in the wild as seven daemons from three
source trees contending for one port, with the process count halving every few seconds.

Daemons therefore publish an `install_id` — `sha256(realpath(<package root>))`, truncated — in the
lock and the handshake, and a client refuses to signal a daemon that identity proves belongs to
somewhere else.

Three deliberate consequences:

- **An absent `install_id` is unknown, never "mine".** Two `undefined`s do not compare equal for
  this purpose. Equal-version-different-bytes is ambiguous — a developer editing their own source,
  or two installs sharing a home — so it needs proof of ownership and resolves the unknown case to
  refusal.
- **An upgrade is exempt from that burden.** A strictly newer client replacing an older daemon is
  the documented path, and every existing daemon predates the field, so requiring proof there would
  break every user's next upgrade exactly once. It restarts unless the daemon is provably foreign.
- **The id is a hash, not the path.** `/api/handshake` is tokenless, and a filesystem path on an
  unauthenticated endpoint is a privacy regression for a tool holding manuscripts. The hash is not
  a secrecy boundary either — its input is guessable, and A3's threat model is hostile web content,
  not a same-uid process, which can read `<home>/token` directly regardless.

## A source checkout gets its own home and port

Running glosa from a checkout used to mean sharing `~/.glosa` and port 4646 with whatever the user
had installed: one lock, one pairing token, one workspace index, two mutually hostile daemons. A
checkout now derives `~/.glosa-dev/<install_id>` and a deterministic port in 60000–65498.

The home lives **outside** the working tree deliberately. `.gitignore` protects only git-mediated
paths — not backups, not sync, and above all not the coding agents that read an entire repository,
which is exactly the tooling glosa is built to sit beside. A plaintext bearer credential inside a
checkout is a credential in the blast radius of every "read all the files in this project".

Deriving rather than refusing: a developer who edits source genuinely wants their own daemon
restarted, and an error would leave the default still pointing at `~/.glosa` for anyone who ignored
it. The cost is that a checkout no longer sees state created before this change; the CLI says which
values it derived, once, on an interactive terminal, and `GLOSA_HOME=~/.glosa` restores the old
behaviour.

## Rejected requests are logged by reason, never by request

A de-pair report could not be settled after the fact, because nothing recorded why a 401 was
returned — "the tab held a stale credential" and "this daemon held no credential" are the same
response on the wire and completely different diagnoses. The daemon now records the reason.

It records nothing else. The request path is attacker-controlled, so logging it would be both an
injection vector into a line-oriented log and unbounded key cardinality — and a throttle keyed on
the path is no throttle at all, since varying the path makes every request a fresh first
occurrence. The key is the reason alone, first occurrence immediate, then at most one line per
minute carrying the suppressed count.

## A 401 from a daemon we did not pair with is not a revocation

The SPA treated every 401 as proof that its credential had been revoked: it removed
`sessionStorage.glosa_token` and reloaded. Bootstrap has already stripped `#t=` from the URL by
then, so nothing could put the credential back — the tab was unpaired permanently, and the only
recovery was a fresh `glosa open`.

That inference is wrong whenever the daemon answering is not the one that issued the credential,
which is precisely what happens when a second glosa install takes the port. The rejection says
nothing about the credential; discarding it destroys the only route back.

Tabs now record the issuing daemon's `install_id` beside the token, and a 401 is classified against
the tokenless handshake before anything is discarded: unreachable (an outage, no verdict), a
different install (foreign), or anything else (revoked, exactly as before).

The safety of keeping a credential in the foreign case rests on not transmitting it, not on
possession. In that state the tab stops sending authenticated requests altogether and polls only the
tokenless handshake, so a process that seizes the port receives strictly less than it does today —
where every stream reconnect re-offers the Bearer to whatever is listening. The wait is bounded at
ten minutes, after which the tab falls back to discarding the credential.

`install_id` is not a proof of possession and is not treated as one. Anything that can bind
127.0.0.1 as this user can also read `<home>/token` directly, so it defends against a coexisting
install, which is an accident, and not against a same-uid attacker, who is outside A3's threat
model either way.

## Claude Code has more than one config root, and glosa has to see all of them

`$CLAUDE_CONFIG_DIR` relocates Claude Code's entire user configuration. Account switchers use
exactly that to give each account its own root, so a machine running one has several live Claude
config directories, each with its own settings, its own MCP registry and its own transcripts.

glosa assumed one. Two consequences, in opposite directions:

- **`init --scope user` wrote the wrong file.** It resolved `~/.claude/settings.json` from the home
  directory and never read the variable, so running it inside a switcher session wired a file that
  session does not load — and reported success. It now targets the root the asking session actually
  reads.
- **Transcripts from every other root were refused.** The daemon is a singleton: it inherits one
  `CLAUDE_CONFIG_DIR` from whichever process spawned it, but serves sessions from all of them. A
  session under another root reports a `transcript_path` outside the daemon's, and single-root
  confinement rejected it with a 400 that looks like a path attack. Confinement now takes a set.

Several roots never weaken confinement. Each is realpath'd independently, an unresolvable one is
simply not a root, and a path is admitted only by resolving inside one of them — so more roots is
more chances to be confined, never a looser check. A symlink escape out of one root is still
refused, because confinement applies to the resolved path.

One `init` still wires one root. Writing to all of them at once means merging into several files
glosa does not own — including per-account `.claude.json` registries a switcher actively rewrites —
and that deserves its own change with its own confinement rules, not a silent widening of what
`--scope user` already means. `doctor` reports the roots it found and which are not wired, so the
gap is visible rather than assumed absent.

Discovery recognises a list of known layouts rather than searching: `$CLAUDE_CONFIG_DIR`,
`~/.claude`, and `~/.ccs/instances/<account>` — the one switcher convention supported so far. A
switcher that arranges its directories differently needs its own entry, and until it has one its
sessions are covered only while they are the active `CLAUDE_CONFIG_DIR`. There is deliberately no
sweep of the home directory for anything Claude-shaped: a wrong guess there widens a confinement
boundary, which is the one kind of mistake this code must not make.

Root discovery is filesystem-only and read-only: no network, no process inspection, nothing
launched (invariant 5). Which variable and which directories matter is provider knowledge and lives
in the claude-code provider; the core supplies only a generic, injectable capability to read the
environment, so it still knows nothing about any particular agent (invariant 1).

## Edit keeps its rich face, and buys honesty by splicing rather than re-serializing

Edit's default face is a rich editor over prosemirror-markdown's CommonMark schema, with the source
textarea one toggle away. That schema models a subset of what people write: it has no node for YAML
front matter, a `> [!info]` callout marker, a `%% ... %%` comment, or raw HTML, and it escapes
brackets conservatively on the way out. Re-serializing a whole document therefore returns a
structurally different file. At the time this decision was made, a collapsed line break was the one
loss among those no round trip could undo once written; "A soft line break is kept by widening one
node's whitespace policy, not by giving it a node" (below) closes that path all the way from the
markdown parse through a live keypress in the rich face, so it is no longer one of this document's
open costs.

The available exits were to retreat to source-only editing, or to make saving preserve the source.
We took the second. The editorial experience is the product, and every other writing tool people
already trust — Typora, iA Writer, Obsidian — preserves the source rather than asking the writer to
give up the rendered face.

The mechanism is the one glosa already relies on elsewhere: prosemirror-markdown parses through
markdown-it, whose block tokens carry the source line `map` that class-R anchoring's `data-line`
stamping also uses. Recording each top-level block's character span at parse time makes two things
possible at once — comparing the edited tree to the parsed original tells you which blocks changed,
and the spans tell you where every other block's bytes are, so they can be copied through
untouched.

Two consequences worth stating plainly:

- **Inside an edited block the schema is still lossy**, so re-serializing one can change markup the
  writer did not touch. That is shown and consented to rather than written, because a save that
  invents an edit is a correctness problem: the rewritten region reaches the agent as a `human_edit`
  and becomes indistinguishable from the writer's own change. Modelling those constructs as opaque
  nodes is what removes the prompt, and is sequenced separately.
- **The splice checks its own work.** The spliced bytes are re-parsed and compared against the
  document the writer is looking at; a mismatch falls back to a whole-document write and says so,
  rather than trusting that every markdown construct was enumerated correctly. Enumeration is how
  this class of bug happens in the first place.

## A closed-unread entry gets its own terminal, `dismissed`, instead of reusing `rejected`

Issue #142 gave inbox entries a second human-reachable close path alongside `resolve`: a person can
now find an entry whose immutable payload has gone missing — moved or deleted by hand — and close it
without a session. That path needed a terminal to land on.

The obvious reuse was `resolve <id> rejected --session ...`'s existing terminal, since both a
declined annotation and a closed-unread one end up "not going anywhere." We rejected that. A session
declining a note is a verdict on its content; a person closing an entry they never read is not a
verdict at all, and collapsing the two loses that distinction the moment the note is skimmed later —
was this rejected, or just cleared? `rejected` already carries exactly this ambiguity once: the SPA's
own withdraw path reuses `rejected` for a human taking a note back, and can only tell that apart from
a session's decline by a `detail.withdrawn` flag riding along in the transition detail — a flag that
has to be checked by every later reader, and that pre-flag journals from an earlier alpha don't even
carry, so `isWithdrawn` also falls back to matching the withdraw path's literal note text. Reusing
`rejected` a second time for dismiss would have meant smuggling in a second disambiguating flag on
top of the first, with the same forever-check-the-detail cost and the same backward-compatibility
seam for journals written before it existed.

A distinct `dismissed` terminal costs one more value in `COMMON_TERMINALS` and one more state the SPA
must render, but it means the fold alone says what happened — no flag to check, no note text to
pattern-match, nothing for an older reader to get subtly wrong on a pre-existing journal. `resolve`
and `dismiss` both still boil down to one journal append (R3, A4 §F04); they only disagree about
which value that append writes, and about whether a session is required to write it.
## A stale save is refused, and the writer chooses what happens next

Maintainer decision, 2026-09-06 (Decision 1, part B). Two writers on one file is glosa's normal
case — the human in Edit mode, an agent applying an annotation — and until now nothing told the
writer their file had moved while they were typing, or stopped a save from silently overwriting an
agent's change. The daemon already carried the mechanism (`If-Match: <source_sha256>`, refused with
a `409`); what was missing was the SPA doing anything with it.

The fix has two parts. While editing, a per-pane banner previews the same condition a save would
hit, before the writer invests keystrokes in what they are about to lose — naming who changed the
file only when a checkpoint proves it, and saying so honestly otherwise. On an actual stale save, a
three-verb dialog — Keep mine, Take disk, Compare — replaces the silent overwrite.

Three decisions carry the mechanism:

- **The save baseline is not the display.** The pane keeps tracking the file for display as it
  always has; a separate baseline records the version the editor was actually filled from, and
  that baseline moves only where a face is filled — never on an ordinary refresh. A baseline that
  advanced on every refresh would let a *clean* editor's next save overwrite an agent's change with
  no refusal and no warning, because the display would have quietly raced ahead of what the writer
  is looking at.
- **The banner names a writer only when a path-matched diff hunk proves it.** A workspace
  checkpoint proves nothing about which file it touched; the per-path attribution the daemon
  already computes is what makes a name honest. Everything else — no checkpoint yet, an unmatched
  path, an unreadable trailer — reads as unattributed rather than guessing, and an edit made in
  glosa's own editor is the only thing ever named as a human edit.
- **The stale-save `409` gets its own problem slug, `source-changed`, instead of sharing the
  daemon's generic `conflict`.** Two distinct `409`s can reach the artifact-save route — a stale
  `If-Match`, and a workspace mid-adoption — and `conflict` already means a dozen other things
  across the daemon. Matching on a bare `409` status would open "this file changed while you were
  editing" during an ordinary workspace adoption; the dedicated slug is what lets the SPA tell the
  two apart.

## An edited block is written back in its own spelling, not the serializer's

Re-serializing an edited block wrote the serializer's spelling of everything in it, so changing one
word also escaped brackets the file had left bare, decoded `&amp;`, inlined a reference link's
target, and dropped a continuation line's indent. Three exits were open: patch the escaping method
on the vendored ProseMirror serializer's prototype, rebuild the vendored bundle from a modified
prosemirror-markdown, or leave the serializer alone and correct its output before it is written.

We correct the output. The pass drops an escape, or restores a run of the block's own original
bytes, only when the candidate re-parses to the tree the writer is looking at; a proposal that
would change what the block says is rejected rather than trusted. The other two exits both make the
vendored bundle something glosa maintains: one reaches a minified private class through an unnamed
prototype and breaks on any rebuild, the other keeps the real change in a patch living outside this
repository. Neither reaches the cases that cost the most either. That the file said `&amp;`, or
wrote a link in reference form, is not carried anywhere in the parsed tree, so no serializer can put
it back; only the source bytes can.

The reference-link form is recovered that way rather than recorded as an attribute on the `link`
mark, which was the alternative. Attributes are what `Node.eq` compares, and `Node.eq` is the
predicate that decides which blocks a save treats as unchanged. Widening it to carry a spelling
would change that pairing for every save in the editor, to answer a question the block's own bytes
already answer.

## A construct the schema cannot model is carried verbatim, and the rule says so rather than listing them

**Decision.** The rich editor parses over a schema DERIVED from prosemirror-markdown's CommonMark
schema, with one added node whose serialization is its own source bytes. A markdown-it block rule
recognises a document's metadata header and emits it as that node.

**Why a property rather than a list.** The entry above warns that enumerating constructs is "how this
class of bug happens in the first place", and it forward-references this work. So the rule is stated
as a property — a top-level construct the schema cannot model is preserved verbatim — and only one
recogniser ships, because measurement said only one was needed. After #174 landed, `%%` comments,
callout markers and raw HTML all round-trip byte-identical under an edit; front matter was the only
one still failing, and the only one that took the WHOLE document down the rewrite path rather than
merely reporting collateral. Shipping recognisers for the other three would have been enumeration
without evidence, and would have cost the rich face: a callout's body is ordinary rich content, and
making it opaque would take formatting away from a construct writers use constantly.

**What the rule knows.** That a `---` fence before any block content, with a non-blank line under it
and a closing fence, is a document metadata header. That is knowledge about markdown documents, not
about Obsidian or GitHub — the same class the editor already carries about fences, setext
underlines and list markers. It deliberately does NOT know `%%` or `[!info]`, which are vendor
dialect and would be a core/provider boundary violation.

**The cost, stated.** The escape relaxation shipped in #174 is per-document: a file holding a header
gets no relaxation anywhere in it. That is deny-by-default working as specified rather than a
regression, and narrowing it is forbidden — relying on a transformation happening to be a no-op over
raw bytes is exactly the corruption the opt-out exists to prevent.

## A fence's two invented blank lines are restored together, never with an unrelated run

**Decision.** A fenced code block inside a tight list item gets a blank line on either side from
the serializer regardless of the source list's own tightness. CommonMark's tight/loose is one
attribute of the whole list, so restoring only one of the two invented blank lines still leaves the
list reading loose — the existing per-run restoration pass, trying them one at a time, could put
neither back. `restoreSourceSpelling` now retries the two together, once, after that pass: restored
as a pair, tight matches tight again and the candidate verifies.

Editing the word directly against one of the two blank lines — nothing else separates them — merges
the edit and the blank line into a single diff run, which the retry above can't reach as a pair.
Peeling the whitespace token off such a run first (gated to runs of equal token length on both
sides, so an HTML entity decode's own many-to-one token collapse is never mistaken for this shape)
recovers the blank line as its own run before the retry.

**Why restricted to the fence's own pair, not every leftover whitespace-only run.** A writer's edit
CAN be whitespace-only — doubling a space is one — so whitespace-only is not by itself evidence that
a run is safe to group. The retry is scoped to runs that are both whitespace-only and adjacent to a
fence delimiter, which the fence's own two blank lines always are and an unrelated edit elsewhere in
the block is not. It is also one extra candidate, tried once, not a search over subsets: a
genuinely unrelated blank line — an already-loose list's own spacing, or the writer's own
tight-to-loose edit — never qualifies, and reverting the writer's edit itself still fails `verify`
exactly as it did before this existed.

**What this does not solve.** CommonMark's tight/loose attribute does not record which blank line
in a list item made it loose. Where a fenced code block's own two invented blanks are entangled with
a writer's deliberate one, a candidate that keeps the tree loose by a different blank line than the
one the writer typed can still verify; the pair-restricted retry above at least keeps this from
crossing into an unrelated edit, and the collateral guard reports the residual mismatch it leaves
rather than committing it silently. Outside that pairing — a fence with only one invented blank
line, the shape the per-run pass alone already handled before this task — the same ambiguity existed
already and is unchanged: solving it in general would mean recording blank-line provenance the
editor's tree does not carry today, which is out of scope here.

## A soft line break is kept by widening one node's whitespace policy, not by giving it a node

**Decision.** #173 keeps a soft break as a bare `\n` inside a text node, on the parser/serializer
side, specifically so `parseMarkdown`/`serializeMarkdown` never gain a new construct. That choice
turned out to be only half the fix: `EditorView`'s own DOM-change reading — the code path that
turns a keypress into a transaction — collapses that same `\n` to a single space whenever it
re-reads a changed paragraph, because the inherited `paragraph` node spec carries no whitespace
policy at all. The loss happened between the keypress and the document `getSave()` reads, which is
why it was invisible to every parser/serializer test #173 and #174 added: none of them mount a real
`EditorView`. Editing any hand-wrapped paragraph, or a paragraph nested in a blockquote or list
item — the same node type — in the rich face was silently rewriting the file underneath it.

`paragraph`'s node spec now sets `whitespace: "pre"`. Traced in the vendored bundle rather than
guessed: the DOM-change reader already asks for `preserveWhitespace: true` on every keypress
touching a non-`"pre"` textblock (never `false`), and that value's own branch for an embedded
newline has exactly two outcomes — split it into ProseMirror's `linebreakReplacement` node, if the
schema declares one, or collapse it to a space, if it does not. `"pre"` selects the branch that
keeps a run of text bytes exactly as read, which for a `\n` means neither of those — it is left
alone, matching what the parser already builds.

**Why not `NodeSpec.linebreakReplacement`** (ProseMirror's own designed-for-this mechanism, which
resolves the same branch by splitting the read text into a dedicated leaf node instead of
collapsing it). It was tried first. It requires that node to be legal everywhere a soft break
already survives on the parser side, and `heading` here is `(text | image)*` — deliberately, per
#173, because a setext heading's break has to stay inside one text run or the node fails to build
and the whole block falls back to a whole-document rewrite (see the round-trip test pinning
`"one\ntwo\n==="` in `rich-editor.test.ts`). Moving softbreak's own token handler to build that node
would need heading's content expression to admit it too, reopening the parse-side redesign #173
chose not to do.

**What tracing the change-reading path alone claims, and where that claim stops.** Read off the
vendored bundle: `readDOMChange`'s own call already asks for `preserveWhitespace: true` on an
ordinary paragraph regardless of `"pre"`, and the branch that value selects for an embedded newline
never touches a run of spaces or tabs — so for THAT ONE CALL SITE, `"pre"` changes nothing about
space or tab handling, only about `\n`. That is a claim about one function, traced from source, and
it is true.

**It is not a claim about the node spec as a whole, and treating it as one was the mistake a
real-browser paste check caught.** `NodeSpec.whitespace` is consulted by `Ai()`'s general fallback
wherever a `<p>` tag is matched through the vendored `DOMParser`'s ORDINARY rule-matching — which
`readDOMChange` bypasses for the paragraph's own wrapper (it hands the changed paragraph in as an
already-resolved `topNode`), but paste does not: `EditorView` wires up its own paste handling by
default, and a pasted `<p>` is matched against the same rule as any other. BROWSER-MEASURED, twice
over, and both runs are retained through the real `editor-roundtrip` gate rather than measured by
hand. The baseline: with the paragraph override removed ENTIRELY — the unmodified CommonMark
schema — the paste check passes, because that schema collapses a pasted run exactly as the check
expects, while both keypress checks fail. That is the comparison this paragraph rests on, and it
is a run rather than an assertion. The isolating ablation: bypassing only the rule override below (keeping `whitespace: "pre"` in
place, so the keypress fix stays live) turns the committed paste check red on exactly this —
pasting a paragraph holding a multi-space run, a tab, and one holding leading indentation kept
every extra space, the tab, and the indentation verbatim in `getSave()`'s own markdown, none of
which the unmodified schema did (ordinary HTML-paste collapse: single spaces, tab folded to one,
leading whitespace trimmed). That is not "the writer typed it"; it is the serializer inventing
bytes on the other side of the same honesty problem #174 exists to prevent.

**The fix is narrowed to the one call site the claim above is actually about.** `paragraph`'s
`parseDOM` rule now carries an explicit `preserveWhitespace: false`, restoring the ordinary
HTML-paste collapse for any caller that rule-matches a `<p>` tag. `readDOMChange` never reaches that
rule for the paragraph's own wrapper, so the keypress fix is unaffected; restoring the override
after the ablation above returns the same check to green. REQ-8's four metrics, unaffected by a
DOM-only change either way, are pinned at their pre-existing counts, and the real-browser check
pins a representative paste (a multi-space run, a tab, leading indentation, and a raw newline
inside the pasted markup) landing on disk — read back from the file the real `PUT` route wrote, not
only `getSave()`'s own report — unchanged from the unmodified schema's own output.

**Scope.** `paragraph` only. Every case #183 reported — a root paragraph, one inside a blockquote,
one inside a list item — is this one node type, so one change covers all three. A setext heading
spanning source lines keeps its pre-existing behavior (a keypress inside it still costs the break);
nothing here makes that case worse, and it is not this fix's to close.
