# Persona Reference

Personas are markdown files with YAML frontmatter that configure an agent. They live in the personas directory (default: `~/persistent-agents/`).

## Basic structure

```
---
engine: claude
model: opus
cwd: /home/user/my-project
group: backend
---
# My Agent

You are a backend specialist. Focus on API routes and database queries.
```

Everything between `---` markers is frontmatter (config). Everything after is the system prompt.

Persona edits saved from the dashboard Persona tab take effect on the next **Spawn** or **Reload**. They do not apply to a running session. To change a running agent's model: save the persona, then Reload.

## Frontmatter fields

### Engine & model

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| engine | `claude`, `codex`, `opencode` | required | Which AI engine CLI to run |
| model | Engine-specific model name | Engine default | See below |
| thinking | `low`, `medium`, `high` | null | Thinking/reasoning level (Claude only) |

Each engine wraps a CLI tool: `claude` (Claude Code), `codex` (OpenAI Codex CLI), `opencode` (OpenCode CLI). Only these three are supported — invalid engine values are rejected at create time.

**Model examples by engine:**

- claude: `opus`, `sonnet`, `haiku` (maps to `--model` flag)
- codex: `o3`, `o4-mini` (maps to `--model` flag)
- opencode: model set via opencode's own config

### Environment

| Field | Example | Description |
|-------|---------|-------------|
| cwd | `/home/user/project` | Working directory (required) |
| permissions | `skip` | Omit for normal prompting. Set to `skip` to pass `--dangerously-skip-permissions` (auto-approves all tool use — no confirmation prompts) |
| group | `backend` | Dashboard sidebar grouping label (visual only, no effect on routing) |
| account | `my-pro-account` | Named credential account — agent runs with that account's Claude Code credentials via HOME isolation |

### Environment variables

Inject env vars into the agent's tmux session on spawn/resume/reload:

```
env:
  MY_API_KEY: abc123
  DEBUG: true
```

### Hooks

Hooks control how lifecycle actions are dispatched to the tmux session. Each engine has sensible defaults. Override when you need custom behavior.

| Field | When it runs |
|-------|-------------|
| start | Agent spawns or reloads |
| resume | Agent resumes from suspended state |
| compact | Compact button pressed |
| exit | Exit button pressed |
| interrupt | Interrupt button pressed |
| submit | Message delivered to the agent |

**Simple hook** (pasted into tmux with Enter):

```
compact: /compact
```

**Keystrokes hook** (ordered key presses and pastes):

```
exit:
  send:
    - keystroke: Escape
    - keystroke: Escape
    - paste: /exit
```

**Shell hook** (supports template variables):

```
start:
  shell: claude --model opus --session-id $SESSION_ID
  env:
    CUSTOM_VAR: value
```

Template variables (`$AGENT_NAME`, `$AGENT_CWD`, `$SESSION_ID`, `$PERSONA_PROMPT_FILEPATH`) are only interpolated in shell hooks, not in simple or keystroke hooks.

See [Hooks & Indicators](hooks-and-indicators) for the full hook format reference.

### Custom buttons

Add buttons to the agent's dashboard thread header. Buttons are only clickable when the agent has an active tmux session (active or idle state).

```
custom_buttons:
  deploy:
    - shell: ./deploy.sh
  run-tests:
    - keystroke: Escape
    - paste: /test
```

Each button is a named array of pipeline steps (`shell`, `keystroke`, `paste`, `wait`, `capture`). See [Hooks & Indicators](hooks-and-indicators) for step syntax.

Shell steps are pasted into the agent's tmux session (not executed in a separate process). Ensure paths are relative to the agent's `cwd`. Template variables `$AGENT_NAME` and `$AGENT_CWD` are available in shell steps.

### Indicators

Match regex patterns in tmux output and show badges in the dashboard:

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
  low-context:
    regex: 'Context left until'
    badge: Low Context
    style: danger
```

Required: `regex` and `badge`. Optional: `style` (defaults to `info`), `actions`.

Styles: `warning` (yellow), `danger` (red), `info` (blue).

## Full example

```
---
engine: claude
model: opus
thinking: medium
cwd: /home/user/my-project
group: backend
permissions: skip
env:
  NODE_ENV: development
start:
  shell: claude --model opus --session-id $SESSION_ID -p "Start working on the API"
compact: /compact
exit:
  send:
    - keystroke: Escape
    - keystroke: Escape
    - paste: /exit
indicators:
  approval:
    regex: '(Yes)\s*/\s*(No)'
    badge: Needs Approval
    style: warning
    actions:
      $1:
        - keystroke: $1
      $2:
        - keystroke: $2
custom_buttons:
  run-tests:
    - shell: pnpm test
---
# Backend API Agent

You are a senior backend engineer. Focus on:
- REST API routes in src/routes/
- Database queries in src/db/
- Test coverage for all new endpoints
```
