# Quanta dossiers

Per-quantum reports for the agentic-collab v3 upgrade. The root orchestrator (see [`../v3-claude-code-prompt.md`](../v3-claude-code-prompt.md)) writes one file here after each quantum completes.

Naming: `Q<n>-<name>.md` — e.g. `Q3-ephemeral-lifecycle-kernel.md`.

Each dossier follows this shape:

```markdown
# Q<n> · <name>

## Plan
<summary of the planner's output; full plan checked in or linked>

## Critic findings (full fan-out only)
- Vision conformance: <blockers or "none">
- Backwards-compat: <blockers or "none">
- Code-style: <blockers or "none">

## Builder report
- Files changed: <list with line counts>
- Tests added: <list>
- Migrations: <inline SQL or n/a>
- Gates: type check <pass/fail> · tests <pass/fail>

## Hostile review
- Blockers found: <count>
- Iterations: <count>
- Final verdict: <approved | …>

## Tests + smoke
- New tests: <names>
- Smoke run: <pass/fail/n-a> · last run timestamp

## Final commit
- SHA: <…>
- Branch: <name>

## Open questions for follow-up
<bullets or "none">
```

Empty until the root prompt's loop reaches that quantum.
