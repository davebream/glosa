# Product

## Register

product

## Platform

web

## Users

glosa is for people doing serious long-form writing with AI coding agents, especially users who need to read, annotate, edit, and route feedback while the agent continues running in its normal terminal session. The primary user is the human reviewer/writer working beside Claude Code, Codex, or another hook-capable CLI. Secondary users are implementers extending providers and content adapters without weakening the generic core.

Users are in a focused review workflow: reading rendered artifacts, marking precise margin feedback, making source edits when needed, and trusting that glosa routes every annotation or edit back to the right session with honest provenance.

## Product Purpose

glosa eliminates four failure modes of agent-assisted writing: unreadable terminal rendering for long-form dialogue, no artifact preview or annotation beside the agent, manual edits that are invisible to the agent, and rendered-output annotation that requires copy-paste. It is a local-first singleton daemon plus browser SPA that turns a directory of artifacts into a reviewable, annotatable workspace while preserving provenance.

Success means the user can review a real writing artifact, annotate rendered output, edit source, see history, and get feedback delivered to the correct live or parked agent session without relying on cloud services, telemetry, cmux, or false attribution.

## Positioning

glosa is the local-first marginal workspace that lets a human and multiple terminal-native coding agents collaborate on writing artifacts with rendered context and honest provenance.

## Brand Personality

Calm, exacting, and trustworthy. The product voice should feel like a careful editor and systems engineer: direct, legible, provenance-aware, and allergic to hand-wavy automation. It should not sound like a growth SaaS, a chat companion, or an agent spectacle.

## Anti-references

Avoid generic AI-workflow dashboards, SaaS landing-page gloss, dark-mode purple gradients, glassmorphism, decorative agent theatrics, and anything that makes provenance feel magical or approximate. Avoid cmux-shaped mental models in product copy or UI. Avoid interfaces that hide routing, attribution, or delivery state behind vague "synced" language.

## Design Principles

1. Render the writing first. The artifact is the authoritative surface; controls, metadata, and agent state support reading instead of competing with it.
2. Make provenance visible and boring. Human, session, and unknown attribution should be clear, consistent, and impossible to overstate.
3. Keep the core generic. UI language should reinforce that providers and adapters carry specifics; the main workspace stays domain-agnostic.
4. Preserve local-first trust. Security boundaries, localhost origins, and zero telemetry should feel designed-in rather than bolted-on.
5. Prefer task density over decoration. Users are reviewing and resolving work; stable navigation, readable state, and predictable controls matter more than surprise.

## Accessibility & Inclusion

Target WCAG 2.2 AA for contrast, keyboard access, focus visibility, and readable rendered documents. Reduced motion is required. Color can reinforce status, but never be the only channel for provenance, delivery state, errors, or annotation intent. Long-form reading should support comfortable line length, resilient text sizing, preserved scroll position, and non-destructive editor/review transitions.
