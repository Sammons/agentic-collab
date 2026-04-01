# Hooks & Indicators

## Hooks

Hooks define how lifecycle actions get dispatched to an agent's tmux session. Each engine has sensible defaults -- override when you need custom behavior.

### Which format to use

- **Simple string**: One command, no special keys needed (e.g. `/compact`)
- **Keystrokes**: Need to press keys first (e.g. Escape before pasting)
- **Shell**: Need template variables or hook-local env vars
- **Pipeline**: Need multi-step flows with captures, waits, or variable extraction

Start with the simplest format that works.

### Hook formats

**1. Simple string** -- pasted into tmux and Enter pressed:

```
compact: /compact
```

**2. Keystrokes** -- ordered key presses and pastes:

```
exit:
  send:
    - keystroke: Escape
    - keystroke: Escape
    - paste: /exit
```

Both `send:` and `keystrokes:` work for this format. `keystrokes:` is preferred.

**3. Shell command** -- supports template variable interpolation:

```
start:
  shell: claude --model opus --session-id $SESSION_ID
```

Optional hook-local env vars:

```
start:
  shell: claude --model opus --session-id $SESSION_ID
  env:
    CUSTOM_VAR: value
```

**4. Pipeline** -- multi-step array directly under the hook key:

```
start:
  - shell: claude --model opus --session-id $SESSION_ID
  - wait: 3000
  - capture:
      lines: 50
      regex: 'session:([a-f0-9-]+)'
      var: CAPTURED_SESSION
```

### Pipeline step types

| Step | Fields | What it does |
|------|--------|-------------|
| keystroke | `key` | Send a single key (e.g. `Escape`, `Enter`, `C-c`) |
| keystrokes | `actions` | Send a sequence of keys/pastes |
| shell | `command`, `env` (optional) | Execute a shell command (pasted + Enter) |
| wait | `ms` | Pause for N milliseconds |
| capture | `lines`, `regex`, `var` | Capture tmux output, extract with regex, store in a named variable |

### Template variables

Available in **shell hooks and pipeline shell steps only** (not in simple strings or keystrokes):

| Variable | Value |
|----------|-------|
| `$AGENT_NAME` | The agent's name |
| `$AGENT_CWD` | The agent's working directory |
| `$SESSION_ID` | Generated UUID for session tracking |
| `$PERSONA_PROMPT` | The system prompt text (shell-quoted) |
| `$PERSONA_PROMPT_FILEPATH` | Path to the persona file on disk (shell-quoted) |

Variables from pipeline `capture` steps are also available as `$VAR_NAME` in subsequent shell steps and hooks.

Undefined variables resolve to empty string.

### Keystroke actions

Used inside `send:`/`keystrokes:` and pipeline `keystrokes` steps:

| Action | Example | Description |
|--------|---------|-------------|
| keystroke | `keystroke: Escape` | Send a tmux key |
| paste | `paste: /exit` | Paste text into tmux (no Enter) |
| text | `text: hello` | Send text as individual keystrokes |

Each action can have `post_wait_ms` to delay after execution:

```
send:
  - keystroke: Escape
    post_wait_ms: 100
  - paste: /compact
```

## Indicators

Indicators are **passive monitors** — they scan tmux pane output for regex patterns and display badges on the agent card in the dashboard. Indicators with actions show clickable buttons, but **actions are never automatic**. You must click the button to trigger the action.

If you want fully automatic tool approval without clicking, use `permissions: skip` in the persona frontmatter instead.

The health monitor checks tmux output every 2-30 seconds (faster for active agents). Regex patterns use JavaScript syntax.

### Basic indicator

```
indicators:
  low-context:
    regex: 'Context left until'
    badge: Low Context
    style: danger
```

Required fields: `regex` and `badge`. If either is missing, the indicator is silently skipped.

Optional: `style` (defaults to `info`), `actions`.

### Indicator with actions

When an indicator has actions, clicking the badge in the dashboard shows action buttons:

```
indicators:
  approval:
    regex: '(Yes)\s*/\s*(No)\s*/\s*(Always allow)'
    badge: Needs Approval
    style: warning
    actions:
      $1:
        - keystroke: $1
      $2:
        - keystroke: $2
      $3:
        - keystroke: $3
```

Action names can reference regex capture groups (`$1`, `$2`, etc.). In the example above, `$1` resolves to "Yes" (the first capture group), so the button label is "Yes" and `keystroke: $1` sends the literal text "Yes" to tmux. Each action is an array of pipeline steps.

### Styles

| Style | Color | Use for |
|-------|-------|---------|
| info | Blue (default) | Informational status |
| warning | Yellow | Needs attention (approvals, prompts) |
| danger | Red | Critical (low context, logged out, errors) |

### Built-in indicators (Claude template)

The default Claude engine template includes:

| Indicator | Matches | Badge | Style |
|-----------|---------|-------|-------|
| approval | `(Yes)\s*/\s*(No)\s*/\s*(Always allow)` | Needs Approval | warning |
| low-context | `Context left until` | Low Context | danger |
| logged-out | `Not logged in` | Logged Out | danger |
| context-limit | `Context limit reached` | Context Limit | danger |

Add your own in the persona frontmatter to detect engine-specific patterns.
