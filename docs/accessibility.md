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
| Workspace and artifact navigation | Tab reaches the workspace list and one roving tree item; arrow keys navigate the tree; Enter/Space opens an item. |
| Compact artifact drawer | Opening moves focus into the drawer; Escape/backdrop closes and restores the trigger; choosing an artifact returns focus to its rendered content. |
| Preview / Annotate / Edit | Tab reaches every mode; Command/Ctrl+1–3 switches modes; focus remains on the active mode after its DOM refresh. |
| Annotation composition | In Annotate, Tab reaches rendered passages; Enter/Space opens the composer; Escape/Cancel restores the passage; Command/Ctrl+Enter sends. |
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
- [ ] Chrome + VoiceOver: repeat the conversation mirror/composer and disconnected/error states,
  including newly arriving status announcements.
- [ ] macOS keyboard-only: run every workflow above with Full Keyboard Access both off and on and
  confirm no trap, invisible focus, or focus loss remains.
- [ ] Browser zoom at 200% and text-only enlargement: repeat desktop and narrow workflows with a
  long artifact, long workspace/path names, history rows, a diff, and open composers.
- [ ] macOS Reduce Motion and Increase Contrast: confirm state remains understandable when motion
  is removed and system contrast preferences are enabled.
