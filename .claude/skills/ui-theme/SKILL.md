---
name: ui-theme
description: The Greenroom design system — palette, typography, composition rules, component patterns, and anti-patterns extracted from the v3 dashboard work. Apply when building or implementing any UI in this codebase.
argument-hint: "<topic to look up · or 'show' to read full reference>"
allowed-tools: Bash, Read, Edit, Write
---

# Greenroom — UI Theme

This skill encodes the visual design system used by the agentic-collab v3 dashboard. The
authoritative live mock is `docs/v3-dashboard-design.html`; this skill captures the
**reusable bits** so future UI work stays consistent without re-discovering the rules.

## When this skill is invoked

1. **Always read `REFERENCE.md` first.** It contains the full design system: tokens, type,
   composition rules, component patterns, status-color semantics, and anti-patterns. Most
   questions are answered in there directly.

2. **Use the live mock as the source of truth for visuals.** `docs/v3-dashboard-design.html`
   is ~6000 lines of fully-worked HTML+CSS. When `REFERENCE.md` describes a pattern, the
   mock is where the concrete implementation lives. For exact CSS, copy from the mock.

3. **Apply the rules to the task at hand.** This skill is consulted when:
   - Building a new UI surface in this codebase
   - Implementing the v3 mock as real `src/dashboard/` code
   - Reviewing a UI change for theme consistency
   - Answering "what color / typography / pattern should X use?"

4. **Never describe Greenroom from training data.** It's a project-specific system. If
   you're unsure, read `REFERENCE.md` again rather than guessing.

## What this skill is NOT for

- Iterating on the design mock itself — use the `/design` skill for that. `/design` edits
  `docs/v3-dashboard-design.html`; `/ui-theme` is the read-only reference.
- General CSS or web-dev advice unrelated to this project's theme.

## Hard rules (the discipline that makes it cohere)

- **One clay moment per surface.** Clay (`#b85a3a`) is reserved for the primary action
  button and at most one other accent point (e.g., the "now" bar in a histogram). Never
  use it for body text, borders on cards, badge fills, or multiple action buttons.
- **No card chrome on row-list pages.** Rows are separated by `--rule-soft` borders +
  hover-paper-2 background. Avoid stacked card backgrounds.
- **Typographic-forward forms.** Borderless inputs with a bottom rule that strengthens to
  ink on focus. Mono uppercase labels in a 130px left column. No pill-shaped boxes.
- **No decorative borders.** No dashed/dotted (two narrow exceptions documented in
  `REFERENCE.md`).
- **No ambient motion.** No pulses, scanning rows, ticker tape, animated dots. Transitions
  ≤200ms; page-load fade and composer caret blink are allowed.
- **Status as a small colored dot, not a badge.** 5-7px circle, color-keyed (see
  `REFERENCE.md#status-semantics`).

## Files

- `REFERENCE.md` — the design system (this is where 95% of the content lives)
- `../design/REFERENCE.md` — per-screen design decisions for the v3 mock (companion)
- `../../../docs/v3-dashboard-design.html` — the authoritative live mock
