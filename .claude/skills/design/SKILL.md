---
name: design
description: Iterate on the agentic-collab v3 dashboard design mock (docs/v3-dashboard-design.html)
argument-hint: "<change to make · or 'show' to just open the file>"
allowed-tools: Bash, Read, Edit, Write
---

# Design — v3 Dashboard Mock

Iterates on `docs/v3-dashboard-design.html` — the high-fidelity design mock for the v3
dashboard. Single HTML file, embedded CSS, no JS framework. This mock serves as the spec
for the eventual `src/dashboard/` implementation.

## When this skill is invoked

1. **Read `../ui-theme/REFERENCE.md` FIRST.** It's the systemic source of truth — the
   Greenroom palette, typography, composition rules ("one clay moment per surface"),
   anti-patterns, and the visual vocabulary that this mock implements. Don't try to
   re-derive the system from this file.

2. **Then read `REFERENCE.md` in this skill folder.** It contains the *mock-specific*
   decisions — structural locks (Teams in sidebar, merged chat, no Templates tab), the
   per-screen design notes, and the per-component subtractions already applied. Anything
   that's not about THIS mock specifically lives in `../ui-theme/REFERENCE.md` instead.

3. **Read the current `docs/v3-dashboard-design.html`** before editing to ground in the
   current state.

4. **Make the change the user asked for.** Prefer `Edit` for targeted tweaks. Only `Write`
   the whole file if the change is a top-to-bottom aesthetic pivot (rare — the theme is
   locked).

5. **Open the file in the browser** after editing:
   ```bash
   open docs/v3-dashboard-design.html
   ```

6. **Briefly describe what changed** — one or two sentences, no recap of the whole design.

## Hard rules (mock-specific)

The systemic rules — palette, typography, the single-clay rule, anti-patterns — live in
`../ui-theme/REFERENCE.md`. These rules below are *additional* and apply specifically to
this mock:

- **Do not change the structural model** — unified Agents list (no Templates tab), merged
  chat stream filtered by sidebar checkboxes (no per-agent threads), `@`-mention to trigger
  an ephemeral, separate Approvals page. Two user redirections have already locked this;
  don't reopen unless told.
- **Keep it a single HTML file** with embedded CSS. Use Google Fonts via `<link>` for type.
  No JS framework, no build step.
- **Don't reintroduce a "Templates" tab.** Ephemeral recipes and persistent agents live in
  one Agents list.
- **Reminders fan out** — every pending reminder fires independently. No queue framing.
- **Filter follows the sidebar** for chat, Reminders, and Search. Don't add in-page agent
  filters that duplicate the sidebar.

## What "iterate" usually means

Small, targeted edits at the scope the user asked for:
- Specific component refinements (the composer, the diff modal, the overlay form)
- Density tweaks (tighter/looser spacing)
- Content corrections / new sample data
- Adding a missing affordance to a screen
- Reorganizing a section's hierarchy

If the user asks for "darker borders," don't redesign the whole thing. If they ask for a
palette change — refer them back to `../ui-theme/REFERENCE.md` first, since the palette is
locked at the system level.

## Files

- `docs/v3-dashboard-design.html` — the live mock (this is what you edit)
- `../ui-theme/REFERENCE.md` — **the design-system source of truth** (read first)
- `REFERENCE.md` (in this folder) — mock-specific structural locks + per-screen decisions
- `docs/v3-wireframes.md` and `docs/v3-wireframes.html` — earlier wireframes, background only
