# Desk browser tabs: design brief (2026-09-29, #440)

Confirmed by the maintainer on 2026-09-29 from rendered comps
(`docs/research/spikes/browser-tab-comps.html`; open it over a local server from the repository root,
e.g. `python3 -m http.server`, so it loads the SPA's own stylesheets and faces). The product decisions
behind it are the issue's (2026-09-28) and `docs/decisions.md` (2026-09-29).

## What it is

A desk-only browser panel. In the desktop app, a person, and the desk chat's agent, open web pages
as dock tabs beside documents and chats. In a plain browser the same actions hand the address to the
person's own browser. The page is someone else's design: glosa frames it and never restyles it.

**Primary action:** check a page beside the writing (the dev server the agent just changed, the
reference a document links to) and get back to the document without leaving the desk.

## Direction

Restrained, on glosa's existing tokens. Scene: a writer at the desk in daylight, glancing at a page
for a minute, then back to the draft; the tab follows the chosen appearance and the page keeps its own
colours. Anchors: the artifact bar (A1), a session's bracket (C2), cmux's strip-corner tools (E3b).

| Decision | Chosen | Rejected |
|---|---|---|
| Address row | **A1**: the artifact bar's row, address field centred as its one object | A2 full-width toolbar (least like the desk); A3 printed address (less obviously a place to type) |
| A tab that came back without loading | **B1**: a quiet sheet naming the site, the full address, why nothing loaded, Load page and Open in your browser | B2 a small Load in the row over blank paper |
| An agent driving the tab | **C2**: a 2px Session Ink rule on the page's top edge, "Claude is reading" printed in the row, a "reading" badge on the tab; afterwards a 1px rule and "Opened by Claude" until the person navigates. A label hanging into the page was rejected in the comps: it covered the site's own Sign in button | C1 a notice strip (costs page height); C3 the tab only (invisible while looking at the page) |
| Opening a blank tab | **E3b**: New chat and New browser tab tools at the right end of every desk tab strip, opening in that group; plus ⌘T and Go to's command | E1 no chrome (the maintainer wanted a visible tool); E2 a + menu; E3a browser only; E3c cmux parity with split tools (glosa has no empty pane) |
| Agent sign-in links | The person's own browser, always | A desk browser tab |
| Existing agent consents | Asked once more when browser tools arrive | Copy-only change; a separate browser permission |
| Agent tools with no desk window | Refuse with a clear reason | Wait for a window; hide the tools |

## States

New blank tab (focused field, a hint, no suggestions); loading (reload becomes Stop, a 2px ink line);
loaded local ("Local"), https (no label), plain http ("Not secure"); restored internet tab (B1);
failures, each with one action: nothing answering on a local port, a site not found or unreachable,
offline, a certificate glosa cannot trust (no override; open it in your browser), a redirect loop,
glosa's own address (refused before loading), a crashed page; refusals as a notice row: a download,
a permission; words typed as an address; menus over the page; the plain-browser hand-off prompt;
nothing at all on a companion surface.

## Interaction

Loopback and private addresses get `http://`, anything else `https://`; words are never searched.
⌘L focuses the address, ⌘[ and ⌘] go back and forward, ⌘R reloads the page while it has focus, and
⌘W, ⌘K, ⌘T and tab cycling keep working from inside a page. A page's new window becomes a tab beside
it; a page that needs a real pop-up points to Open in your browser. A click into a page makes its
panel the active one. Agent reads (PR 2) return the page's title, address and visible text, capped
with a marker when cut; only the desk chat's agent drives tabs.

## Delivery

Two stacked PRs: people's browser tabs (shell guests and their partition, the pane, link routing,
the hand-off, restore, the privacy documents and their tests), then the agent's open, navigate and
read with consent renewal and the C2 mark. The rendering question was settled by a spike before the
build: `docs/research/2026-09-29-browser-tab-rendering.md`.
