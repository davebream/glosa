---
target: Agent chat, sidebar and AI settings
total_score: 21
p0_count: 0
p1_count: 4
timestamp: 2026-09-23T22-33-39Z
slug: packages-spa-src-chat-pane-js
---
Method: independent design assessment and detector/browser assessment.

# Agent chat, sidebar and settings critique

This snapshot records the baseline before the accompanying interface rebuild. Its priority findings informed that rebuild; the scores are not a post-implementation rating.

The existing implementation is a functional engineering control panel appended to Glosa's writing desk. Preserve the palette, draft safety and controls; rebuild their hierarchy.

| Heuristic | Score / 4 | Finding |
|---|---:|---|
| System status | 2 | Selected chat and account readiness unclear |
| Familiar language | 2 | Internal terminology in product controls |
| User control | 3 | Stop, export and draft protection work |
| Consistency | 2 | Mixed component sizes and inherited styles |
| Error prevention | 3 | Confirmations strong; readiness appears late |
| Recognition | 2 | Truncated identity; no agent marks |
| Efficiency | 2 | Maintenance competes with everyday controls |
| Minimalist design | 1 | Controls displace conversation |
| Error recovery | 2 | Missing model catalog lacks local recovery |
| Contextual help | 2 | Switching and permissions under-explained |
| Total | 21/40 | Significant improvements needed |

## Anti-pattern verdict

No decorative template, but generic equal-weight controls make the interface feel unfinished. The deterministic detector returned zero findings on the three JS targets. Its regex scanner does not model imperative DOM construction, so that is not a clean rendered-UI verdict. Browser measurements and source inspection independently confirm the hierarchy issues. CSP blocked all three overlay attempts; no overlay was displayed.

## Strengths

- Warm palette, restrained rules and existing type fit the product.
- Draft preservation, Stop, selection-safe streaming and explicit confirmations protect user work.
- Existing tool, reasoning and usage disclosures are the correct starting point for progressive disclosure.

## Priorities

1. **P1: Controls displace conversation.** At 390px, after hiding the sidebar, message history occupied 196px of a 760px chat pane. Use a compact title/context header, one action menu and cohesive composer. Preserve all controls. Commands: `$impeccable layout`, `$impeccable distill`.
2. **P1: Chat identity is lost.** One ellipsized string combines title/provider/account/status, with no selected state. Use genuine monochrome marks, title and secondary metadata, active state and full-name tooltip. Command: `$impeccable polish`.
3. **P1: Readiness has no local recovery.** Model/effort show unavailable while Send looks ready. Distinguish missing catalog, unsupported selection and unavailable account; provide Load models or Manage account beside the explanation. Explain account switching before it happens. Commands: `$impeccable clarify`, `$impeccable harden`.
4. **P1: Seven peer account actions overwhelm.** Show identity, enabled/default state and one useful next action. Disclose maintenance/MCP and make runtime management quieter. Commands: `$impeccable distill`, `$impeccable polish`.
5. **P2: Components are unfinished.** Raw file input, 23px selects beside 34px buttons, text-only brand identity, inconsistent typography and annotation-style collisions. Use scoped components, a labeled attachment trigger and distinguish human/agent content. Command: `$impeccable polish`.

## Cognitive and emotional journey

Six of eight cognitive-load checks fail: focus, chunking, hierarchy, one decision at a time, minimal choices and progressive disclosure. Calm outer chrome initially reassures, but opening chat exposes administrative controls and ambiguous unavailable states. The desired ending is a clearly ready composer with named account/model/permissions and one obvious Send action.

## Personas

| Persona | Red flag |
|---|---|
| Frequent user | Repeated scanning, ambiguous Pin/unpin labels, unannounced new-chat account switch |
| First-time user | Technical readiness language and unclear distinction between managed accounts and external terminal sessions |
| Keyboard/assistive user | No announced active chat; repeated account-label fields; real focus-ring check inconclusive |

## Minor observations

Hide empty history navigation; hide zero-count feedback until relevant; scope checkbox widths; shrink Copy affordances; avoid the 3px colored decision stripe. Narrow settings overflow when persistent sidebar leaves less than the dock's minimum pane width. Computed message/status contrast passed AA in light and dark.

## Design questions

Can the composer communicate readiness in one compact group? Can each account show one next action? Can the topic lead while provider/account/status remain supporting information?

Implementation scope is already authorized: all three surfaces, actual monochrome marks, complete working controls. No further scope question is needed.
