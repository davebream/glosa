---
target: agent settings page
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-09-24T10-43-43Z
slug: packages-spa-src-agent-settings-js
---
Method: dual-agent (A: /root/settings_design_critique · B: /root/settings_evidence_critique)

# Agent settings critique

Reviewed the account settings renderer at `/Users/dawid/code/glosa/packages/spa/src/agent-settings.js`, shared controls and styles, and the live isolated preview on 2026-09-24. This records the pre-remediation state; no authentication, installation, profile mutation or model call was needed for the review.

## Design health

| Heuristic | Score / 4 | Finding |
|---|---:|---|
| Visibility of system status | 3 | Connection and installation feedback is useful. |
| Match with real world | 3 | Runtime and MCP need contextual explanation. |
| User control and freedom | 3 | Good confirmations; Enabled looks passive. |
| Consistency and standards | 2 | Account menu stretches almost to window height. |
| Error prevention | 3 | Runtime prerequisites and destructive confirmations exist. |
| Recognition rather than recall | 2 | Long account names lose distinguishing text. |
| Flexibility and efficiency | 2 | Default selection is buried in account actions. |
| Aesthetic and minimalist design | 3 | Healthy runtime maintenance has too much prominence. |
| Error recovery | 3 | Account guidance is helpful; caught errors can remain technical. |
| Help and documentation | 3 | Default-account scope is explained clearly. |
| **Total** | **27/40** | **Acceptable; targeted improvements needed.** |

## Anti-pattern verdict

The warm surfaces, small monochrome marks and restrained typography fit Glosa. There is no reason to replace its visual identity. The conspicuously unfamiliar component is the account action menu: five options stretch through almost the entire viewport.

The bundled detector found 95 advisories across 49 scannable SPA files: 62 color, 16 radius, 12 layout-transition, three font-size, one font and one side-tab finding. Eighty-two concern vendored CSS. Thirteen concern `packages/spa/src/app.css`; only two directly concern settings: menu shadow `#0002` at the reviewed line 6421 and default badge radius `3px` at line 6650. These are token consistency observations, not demonstrated usability defects. The SVG stroke-width transition and eight vendor calc-radius findings are parser false positives. A direct JS renderer scan returned no findings, but does not assess the rendered DOM. Dark-theme measured text contrast passed (muted approximately 7.21:1, headings 14.58:1).

Browser detector injection was blocked by the application's script-src self CSP. No overlay ran. Screenshots, DOM measurements and source inspection provide the visual evidence.

## Overall impression and strengths

This is a sound account-management surface with a small number of consequential interaction defects. Improve behavior and hierarchy before changing decoration.

- Provider → account → details is a useful hierarchy; one account occupies the detail pane.
- The default explanation clearly states that new chats change while existing chats retain their account.
- Connection state, identity and verification details support trust; status uses text as well as shape.

## Priority issues

### P1: Account menu expands almost to window height — bug

At 1440 × 1000, the five-action popover measured 224 × 984, from y=8 to y=992. Actions become disconnected from their account; sign-out and removal share the same treatment as maintenance.

Fix intrinsic height and row alignment; cap height only when content requires scrolling. Separate routine and destructive actions. Verify mouse opening, keyboard opening, Escape and focus return. Suggested command: `$impeccable harden`.

### P2: Account navigation hides distinguishing names — design flaw

The fixed 160px list ellipsizes names before their distinguishing endings. Users must select profiles repeatedly to identify subscriptions.

Wrap labels and provide a full-name fallback; add supporting account identity. Keep connection health separate from Default so a stale or expired default cannot conceal an actionable state. Suggested command: `$impeccable clarify`.

### P2: Availability appears passive but stops accounts — design flaw

Enabled resembles a status yet initiates disabling and stopping chats. Disabled profiles still emphasize a disabled Sign in control. Default selection is hidden in a generic menu.

Use explicit Enable/Disable account actions. Make Enable account the primary recovery for disabled profiles, with the effect explained beside it. Preserve consequence confirmations. Give default selection a discoverable dedicated control. Suggested command: `$impeccable clarify`.

### P2: Healthy runtime maintenance competes with accounts — design flaw

A large repair panel precedes the routine account task even when installation is healthy.

Retain prominent setup for missing, installing or failed runtimes. Collapse healthy runtime information and Verify/repair into a quiet maintenance disclosure, with plain-language context. Suggested command: `$impeccable distill`.

## Cognitive load

Moderate: three of eight checklist areas fail — chunking, visual hierarchy and minimal choices. Single focus, grouping, one decision at a time, working memory and progressive disclosure broadly work. The five-item action menu is the confirmed decision point with more than four peer options; grouping can remove the scanning penalty without deleting capabilities.

## Emotional journey

Settings opens calmly; provider/account selection and identity reassure. Opening the oversized maintenance menu causes a confidence dip. Consequence confirmations restore control. The settled state should clearly communicate that the selected account is ready for writing.

## Persona red flags

| Persona | Concrete friction |
|---|---|
| Experienced user | Hidden default controls and similar truncated names slow routine changes. |
| First-time connector | Runtime/MCP jargon and the clickable Enabled status obscure necessary next steps. |
| Keyboard/low-vision user | Focus is present; truncation, compact targets and the tall menu impede scanning. Full screen-reader validation was not performed. |

## Minor observations

- Make renaming discoverable rather than relying solely on an input border appearing on hover.
- Improve compact targets: the menu measured 28 × 28, actions 32px high and the MCP summary 19px high. These measurements alone do not establish a WCAG failure.
- Explain technical connection settings where they are disclosed; distinguish user-facing recovery from technical error details.
- Narrow browser emulation initially retained stale dock bounds. Reload with artifacts hidden produced a correctly reflowed 360px settings component without internal horizontal overflow. Reproduce actual pane behavior before declaring a responsive defect or changing the application's desktop width policy.

## Design questions resolved for implementation

- Healthy runtime: compact status plus maintenance disclosure.
- Availability: explicit Enable/Disable actions, preserving confirmation.
- Identity: wrapped account labels with supporting identity and independent health/default state.

The user requested implementing all actionable findings sequentially after this critique. A final browser pass must distinguish repaired component behavior from the unresolved browser/dock resizing observation. This report was cold-read to separate confirmed defects, source-only states and limits of browser evidence.
