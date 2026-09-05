# Review mode — the anchored two-way surface

Design brief. Status: implemented.

## 1. Job and audience

The human reviewer working beside a live agent session, mid-document, who needs to answer what the
agent is asking **about a specific passage** without leaving the document, losing their place, or
losing work in progress. Visitor mode: **Operate**.

Before this, that person had two places to receive an agent's request — the top-bar Attention tray,
and nothing anchored — and no way to be shown *where in the text* a question was about.

## 2. Outcome and proof

The agent marks a passage and optionally asks about it; the human answers in the margin; the answer
releases a turn that was genuinely blocked waiting for it.

Success is that a reviewer can go from "the agent needs me" to "answered, agent resumed" without
ever losing (a) the passage in question, (b) an unsaved edit, or (c) the ability to answer outside
the agent's vocabulary.

Product-specific truth a generic review tool cannot claim: **the mark is proven, the name is only
claimed.** The provider identity comes from a verified session binding; any friendly label comes
from the agent and is rendered as a claim, never as something glosa verified.

## 3. Selected direction

Modes divide by what the human is doing, not by who the counterparty is:

| Mode | The human is | The agent is |
|---|---|---|
| **Read** | reading | absent |
| **Review** | working with the agent on this text, in the margin | able to start a thread |
| **Edit** | changing the file | invisible plumbing |

One destination for every agent-originated request, unconditionally. Routing a question to one mode
and a bare pointer to another would leave the reviewer asking "why did my mode switch this time?",
and would make it impossible to see a session's marks and one's own annotations together — which is
exactly the comparison a reviewer wants.

The **card**, not the mode, is the unit of variation, matching how annotation cards already vary
their verbs by state:

```
agent points, no question    → mark + card, non-blocking
agent points, with question  → mark + card + composer, a call blocked on it
agent requests review        → unanchored card, verdict-shaped
human annotates              → mark + card (unchanged)
human answers                → releases the block
```

`request-review` is the degenerate case of the same shape: target is the whole artifact, no anchor.
The **Attention tray stops being somewhere you answer and becomes somewhere you find** — anything
with an artifact sends the reader to that artifact's margin. Only a request with no artifact, and
therefore no margin, keeps an inline answer.

### Why "Review" and not "Annotate"

The surface now holds things that are not annotation: answering a question, giving a verdict.
`Review` is also the only candidate that makes "a session requested a review" self-explanatory, and
it converges with Word's Review tab, Drawboard's Review mode, and Acrobat's Review umbrella.

`Preview` had to move for it: in a segmented control at Label type the two share a length class and
the distinctive `-view` chunk, putting near-identical labels side by side. `Read · Review · Edit`
are three short verbs with no shared chunk.

The former names remain valid on the wire (`mode=preview`, `mode=annotate`, `lock=preview`,
`--preview`, and `glosa_present`'s enum all normalize), and only the new names are written back.

## 4. Scope and boundaries

**In:** the mode rename and its two-way rail; agent-originated marks and cards; free-text and
option-shaped questions; the blocking MCP tool; draft parking across an agent-forced switch; agent
identity display; the tray's demotion to an index.

**Untouched:** the Conversation pane keeps its name and its job — the anchored/unanchored split is
the point. Edit's routing stays silent: no delivery chrome, no "this will be sent" banner. The
anchoring resolver's contract, the journal's append-only law, and zero-adapter operation.

**Anti-goals:** a fourth mode; chat affordances in the margin; any surface that lets the agent close
the human's answer vocabulary; any composer in Read.

## 5. States and ranges

- **Rail contents:** 0 cards typical on open; 1–3 agent asks in the common scenario; legible at ~20
  mixed human/agent cards on a long manuscript.
- **Answer:** the existing 4096-byte response cap. Options: 1–8, 96 bytes each.
- **Card states:** waiting on you · answered · unanswered (deadline passed) · withdrawn.
- **Anchor states:** resolved · **unanchored** — the session quoted text the artifact no longer
  contains, or text that occurs twice with nothing to tell the two apart. The card says so and keeps
  the original quote rather than underlining a guess.
- **Overlap:** an agent mark and a human annotation can cover the same words; both stay readable.

## 6. Interaction and layout

Three highlight vocabularies coexist and are distinguishable achromatically:

```
text selection      transient, browser-native      (unchanged)
human annotation    ON the words: underline → wash (unchanged)
agent pointer       BESIDE them: graphite sideline, olive when focused
```

Wash-vs-sideline survives greyscale and survives overlap; a second colour wash would fail both and
would spend the Accent Rarity budget on something that is not the reviewer's own action.

**The forced switch.** glosa focuses the artifact, enters Review, brings the mark into the reading
band, and announces the change in a live region. Any unsaved Edit source **and** any half-written
margin note are parked, not discarded, and the Edit segment carries a dot so held work is visible.
The switch waits for a gap in typing (900ms, capped at 15s) because landing mid-sentence is hostile
even when it costs nothing.

This is a deliberate exception to "the human performs the transition"; parking plus reversibility
plus the announcement is what buys it. It fires only for a genuinely new question — never on first
load, never on a refresh, never for a bare pointer, and never more than once at a time.

**Identity on the card:** the provider in Ink at label weight, the session's claimed label in mono
inside a dashed outline. Different weights, never concatenated.

## 7. Constraints

- **Anchoring runs the other way here.** `anchoring.ts` maps rendered→source because a human selects
  rendered text. A session quotes *source* markdown, so `locateQuote` maps source→rendered, with a
  ladder (literal → inline-markdown-flattened → whitespace-folded) and a refusal to guess.
- **A read-locked visit cannot answer.** `glosa_present` with `mode: read` creates a read-locked
  visit; a session that asks a question must not create one, or the human is shown a question they
  cannot answer.
- **Class F** rides the existing chunk-manifest path; nothing new.
- Zero-adapter operation, no new network egress, `human` attribution still only where a lease proves
  it.

## 8. Decisions taken during implementation

- **Granularity:** one call carries one anchored ask. The rail is already the queue.
- **Unanswered:** the agent sets a deadline; on timeout the call returns `unanswered` and the agent
  proceeds, but the card stays in the rail so a later answer still routes home. Nothing typed is
  discarded.
- **Options:** single-select plus the mandatory free-text escape. A chosen option is rejected unless
  the request offered it.
- **The discard prompt is gone from mode switching.** It existed only because the switch destroyed
  the draft. Closing a pane still asks, because closing really does end a draft's life.
