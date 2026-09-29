# Browser tab rendering: `<webview>` in the dock, not `WebContentsView` (2026-09-29, #440)

Issue #440 left one question to a spike: whether a desk browser tab should render its page as an
Electron `WebContentsView` laid over the dock panel's rectangle, or as a `<webview>` element inside
the panel. Both were run in the Electron the shell ships (44.4.5, Chromium 152.0.7977.130) by
`docs/research/spikes/electron-browser-tab.cjs`, measured against what the tab has to do for a
person. Run it from `packages/shell` with `./node_modules/.bin/electron ../../docs/research/spikes/electron-browser-tab.cjs`.

## What was measured

Both candidates host a page in a persistent partition of its own while the host window keeps the
shell's loopback-only egress gate on its default session.

| Question | `WebContentsView` | `<webview>` |
|---|---|---|
| Does a menu in the host page draw over the web page? (window composite, sampled on screen) | No: the page covers it | Yes |
| A still image of the page, to stand in under a menu | 190 ms cold, 10 ms and 3 ms warm | Not needed |
| Does the page survive being moved, as the dock moves a panel? | Kept (the view is independent of the DOM) | A bare DOM move destroys the guest and attaches a new one (page reloaded) |
| The same, inside glosa's dock (vendored dockview 8.2.0, `defaultRenderer: "always"`, as `packages/spa/src/dock.js` sets it) | n/a | One attach at load; kept through a tab switch, a move to another group and a move to a new split |
| Can the main process read a page that is not showing? | Yes, 4 ms, view removed from the window | Yes, panel hidden |
| Does a key pressed in the page reach the host document? | No; the main process sees it (`before-input-event`) | No; the main process sees it |
| Is the partition apart from the host origin? | The host's pairing-token stand-in reads `null` in the partition; the partition's cookie is absent from the default session | Same partition, same result |
| Does each session keep its own request policy? | The host's `fetch` to the internet is blocked; the partition loads `example.com` | Same |
| Can a child frame create a guest? | n/a | No: neither a sandboxed `srcdoc` frame (class-F's shape) nor a cross-origin frame produced an attach request |
| Does the SPA's own CSP (`spaCspHeaders`, verbatim) stop a guest? | n/a | No: attached, no CSP violation |

## Decision

`<webview>`, locked down by the main process. With the dock's always-render mode the page survives
every move the dock makes, and every overlay glosa already has (menus, Go to, dialogs, tooltips,
the drop targets of a tab drag) draws over it with no work. A `WebContentsView` would need a still
image of the page under each of those, bounds kept in step with the panel on every layout change,
and hiding during drags; the stills are fast once warm, but the set of overlays is open-ended and
each one missed is a menu drawn under a web page.

Electron's documentation discourages `<webview>` for stability. The cost is accepted with its
mitigations, recorded in `docs/decisions.md`: `webviewTag` on every window, with `will-attach-webview`
as the gate that refuses companion windows and non-web sources and rewrites every guest's
preferences; the spike shows no child frame can reach that gate.

## Found while building on it

- A guest's new windows are dropped before the main process sees them unless the element carries
  `allowpopups`. The shell's window-open handler still denies every one; a web address becomes a
  desk tab beside the page.
- A guest is transparent where its page paints nothing, so glosa's dark paper showed through pages
  that assume the browser's white canvas. The frame gives the guest a white canvas.
- A main-frame load the partition's request policy cancels ends with `did-start-loading` and
  `did-stop-loading` and no `did-fail-load`. The tab refuses glosa's own ports before loading, and
  reads the address back from the committed page when a load stops, so the row never names a page
  that did not load.
- A click into a page never reaches the SPA's document, so dockview does not learn the panel was
  chosen. The guest's `focus` event on the element activates the panel.
