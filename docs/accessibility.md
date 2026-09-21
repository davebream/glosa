# Accessibility verification

Glosa targets WCAG 2.2 AA for the core browser review workflow. This document records the
repeatable checks around that target and the assistive-technology checks that still require a
human. It is not a conformance claim.

## Automated and browser checks

Run before release:

```sh
bun test packages/spa/test
bun run typecheck
```

The focused SPA coverage includes WAI-ARIA tree navigation, labeled history controls, keyboard
annotation composition, dialog naming and focus restoration, editor and iframe names, live text
errors, appearance persistence, and reduced-motion CSS. In a Chromium browser, also run a
Lighthouse accessibility snapshot with Preview, History, Conversation, Edit, and the annotation
composer each exposed; scanning only the initial Preview state misses conditional controls.

The 2026-07-22 browser pass covered light, dark, and system-resolved appearances; a 1440 × 900
desktop viewport; the browser's 500 × 844 minimum emulated narrow viewport; keyboard traversal;
and horizontal-overflow checks. The light and dark text/status tokens used for active content met
4.5:1 against their intended reading and control surfaces. Disabled `--faint` text is intentionally
exempt from contrast requirements and is not used for active information.

## Keyboard interaction matrix

| Workflow | Expected keyboard behavior |
|---|---|
| Workspace and artifact navigation | Tab reaches the workspace list and one roving tree item; arrow keys navigate the tree; Enter/Space opens an item. The workspace switcher is a disclosure with `aria-expanded` and `aria-controls`, and collapsing it never hides the artifact tree. |
| Artifact column (every width) | The column takes no focus when it appears, survives opening an artifact, and is not dismissed by Escape. Hiding it returns focus to the control that hid it. Its one top-bar control reports state through `aria-expanded` and a filled glyph rather than color alone, and a hidden navigator is `inert`. |
| Read / Review / Edit | Tab reaches every mode; Command/Ctrl+1–3 switches the active pane's mode; focus remains on the active mode after its DOM refresh. Only the focused pane exposes a mode control, so several open artifacts never present several switchers to the same keyboard. |
| Tabs and panes | Ctrl+Tab and Ctrl+Shift+Tab step through the active pane's tabs; Command/Ctrl+Option+Left/Right move focus between panes; Command/Ctrl+\\ moves the active tab into a new split; Command/Ctrl+W closes it through the unsaved-edit prompt. Every drag the dock offers has a single-pointer equivalent under the pane's More menu (WCAG 2.2 SC 2.5.7), and a direction that would do nothing is disabled rather than silently inert. |
| Annotation composition | In Annotate, Tab reaches rendered passages; Enter/Space opens the composer; Escape/Cancel restores the passage; Command/Ctrl+Enter sends. |
| A session's question or pointer (#308) | glosa never moves the page or the focus when a request arrives. A question is announced once through the workspace's polite live region ("… is asking about a passage in notes.md"); a pointer is not announced. Whenever a question is not beside its words (passage off screen, pane not in Review, or no rail and its card not open) a notice appears under the artifact bar, in the tab order, with **Go to it** and a dismiss button; dismissing the notice leaves the question open. Each marked passage has a gutter tab that is a real button, named with the passage address and "Question from …" or "Pointer from …". **Go to it**, a tab, a tray row and a card's quote are the only things that scroll to a passage, and they move focus to the question's first answer control. Below the rail width the question floats at its passage; Escape closes it and returns focus to the passage's tab. After an answer is sent, focus goes to the notice, which offers the next question and **Back to where you were**; that control restores the previous scroll position and focus. The mark does not rely on colour: it is an outline with a printed "… asks" label and a glyph tab, against the reader's wash and underline. Scrolling is instant and both arrival animations are off under `prefers-reduced-motion`. |
| History and conversation | Disclosure buttons expose `aria-expanded` and `aria-controls`; comparison checkboxes have complete names; async results and errors are textual live status. |
| Unsaved-edit dialog | Focus starts on Cancel for a destructive choice, stays trapped by the native modal, and returns to the invoking mode control. |
| Appearance menu | Arrow keys move through System/Light/Dark; Enter chooses; focus returns to the trigger. |

## Remaining manual assistive-technology checks

These must be completed on release-candidate builds because DOM tests and Lighthouse cannot
establish practical screen-reader usability:

- [ ] Safari + VoiceOver: read the workspace landmarks in order and operate the artifact tree,
  including collapsed folders and the current artifact announcement.
- [ ] Safari + VoiceOver: create, send, revisit, and remove an annotation; confirm quote, intent,
  delivery state, and errors are announced without depending on visual color.
- [ ] Safari + VoiceOver: edit in both Rich and Source faces, exercise the formatting toolbar,
  encounter the unsaved-edit dialog, and verify focus restoration.
- [ ] Safari + VoiceOver: compare two history versions and inspect the diff reading order; verify
  provenance labels (“You”, “An agent session”, “Unknown change”) are unambiguous.
- [ ] Safari + VoiceOver: with the passage off screen, have a session ask a question; confirm it is
  announced without focus moving, reach the notice by Tab, use **Go to it**, answer from the
  card at the passage, and use **Back to where you were**. Confirm the gutter tab's name reads
  the address and the author, and that Escape on the floating card returns to that tab.
- [ ] Chrome + VoiceOver: repeat the conversation mirror/composer and disconnected/error states,
  including newly arriving status announcements.
- [ ] macOS keyboard-only: run every workflow above with Full Keyboard Access both off and on and
  confirm no trap, invisible focus, or focus loss remains.
- [ ] Browser zoom at 200% and text-only enlargement: repeat desktop and narrow workflows with a
  long artifact, long workspace/path names, history rows, a diff, and open composers.
- [ ] macOS Reduce Motion and Increase Contrast: confirm state remains understandable when motion
  is removed and system contrast preferences are enabled.
