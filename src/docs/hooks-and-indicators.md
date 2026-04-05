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

### Engine config indicators

Indicators defined on an engine config cascade to **every agent using that engine**. Agent-level indicators override the engine config defaults (agent frontmatter takes priority). This means you define common indicators once on the engine config and only override at the agent level when you need something different.

The resolution order is:

1. Agent-level `indicators` (from persona frontmatter)
2. Engine config `indicators` (from Settings → Engine Configs)

If the agent has its own indicators, those are used. Otherwise, the engine config indicators apply. Manage engine config indicators via **Settings → Engine Configs** in the dashboard.

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

### Built-in default indicators

Each engine ships with a set of built-in indicators. These are restored when you click **Reset Defaults** on the Engine Configs settings page.

| Indicator | Regex | Badge | Style | Engines |
|-----------|-------|-------|-------|---------|
| unsafe | `.` | Unsafe | danger | claude, codex |
| approval | `(Yes)\s*/\s*(No)\s*/\s*(Always allow)` | Needs Approval | warning | claude |
| plan-review | `(approve)\s*/\s*(deny)\s*/\s*(edit)` | Plan Review | warning | claude |
| low-context | `Context left until` | Low Context | danger | claude, opencode |
| context-limit | `Context limit reached` | Context Limit | danger | claude, opencode |
| logged-out | `Not logged in` | Logged Out | danger | claude |
| local-agents | `·\s*(\d+) local agents?` | $1 Local Agents | info | claude |

The `approval` and `plan-review` indicators include actions that resolve capture groups into clickable buttons (Yes/No/Always allow and approve/deny/edit respectively). The `local-agents` indicator uses a capture group in its badge text to display the count dynamically.

Add your own in the persona frontmatter to detect engine-specific patterns.

## Detection

Detection controls how the health monitor determines whether an agent is **active** or **idle**. Each engine config can define a `detection` block with regex patterns and tuning knobs. Like indicators, detection config is defined on the engine config and cascades to all agents using that engine.

### Detection patterns

There are three categories of patterns:

- **`activePatterns`** — regex patterns that indicate the agent is doing work (tool calls, spinners, sub-agent activity). If any active pattern matches, the agent is immediately considered active.
- **`idlePatterns`** — regex patterns that indicate the agent is waiting for input (prompt characters, empty input lines). If an idle pattern matches and no active pattern matched, the agent trends toward idle.
- **`contextPattern`** — a single regex with a capture group that extracts context usage (token count or percentage) from pane output.

Each pattern can be either a plain string or an object with a `lines` field to restrict matching to the last N lines of pane output:

```yaml
# Plain string — matches against full pane output
activePatterns:
  - '^\s*(Read|Write|Edit|Bash)\s'

# Object with lines scope — matches only last 5 lines
idlePatterns:
  - pattern: '^[❯>]\s*$'
    lines: 5
```

The `lines` field is useful for patterns that only appear in specific regions of the output (e.g., prompt characters at the bottom, status bar indicators in the last few lines).

### Detection priority

The health monitor evaluates patterns in this order on each poll cycle:

1. **Active patterns** — checked first. If any match, the agent is marked active and the idle counter resets. The `activeGraceMs` timer restarts.
2. **Idle patterns** — checked second. If any match (and no active pattern matched), the idle counter increments. The agent transitions to idle when the counter reaches `idleThreshold`.
3. **Screen-diff fallback** — if no detection patterns are configured (or none matched), the monitor falls back to comparing raw pane snapshots between poll cycles. If the output is unchanged across `idleThreshold` consecutive polls, the agent is considered idle.

This priority means active signals always win. An agent producing intermittent output won't flicker between active and idle thanks to the grace period.

### Detection tuning knobs

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `idleThreshold` | number | 2 | Consecutive idle-pattern matches (or unchanged snapshots) required before marking idle |
| `activeGraceMs` | number | 10000 | Milliseconds after last detected activity before allowing idle transition |
| `snapshotLines` | number | 30 | Number of trailing pane lines captured for screen-diff comparison |

With the default fast-poll interval of 2 seconds and an `idleThreshold` of 2, idle detection takes roughly 4-6 seconds after the agent stops producing output.

### Example detection config

Here is the built-in detection block for the Claude engine (YAML representation):

```yaml
detection:
  idlePatterns:
    - pattern: '^[❯>]\s*$'
      lines: 5
  activePatterns:
    - '^\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\s'
    - '^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'
    - pattern: '·\s*\d+ local agents?'
      lines: 3
  contextPattern: '(\d+)\s*tokens'
  idleThreshold: 2
  activeGraceMs: 10000
  snapshotLines: 30
```

The Codex and OpenCode engines have their own detection defaults tuned for their respective TUI layouts. All three can be viewed and edited via **Settings → Engine Configs** in the dashboard. Click **Reset Defaults** to restore the built-in detection config for any engine.
