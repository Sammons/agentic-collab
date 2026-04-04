# Persona Reference

Personas are markdown files with YAML frontmatter that configure an agent. They live in the personas directory (default: `~/persistent-agents/`).

## Basic structure

```
---
engine: claude
cwd: /home/user/my-project
group: backend
---
# My Agent

You are a backend specialist. Focus on API routes and database queries.
```

Everything between `---` markers is frontmatter (config). Everything after is the system prompt.

A minimal persona needs only **engine**, **cwd**, and **group** plus the prompt body. All other fields are optional — the engine config provides defaults for model, thinking, permissions, hooks, and indicators.

Persona edits saved from the dashboard Persona tab take effect on the next **Spawn** or **Reload**. They do not apply to a running session. To change a running agent's model: save the persona, then Reload.

## Engine config inheritance

Each engine (claude, codex, opencode) has a default config that provides sensible defaults for hooks, indicators, detection, model, thinking, and permissions. Persona frontmatter fields **override** engine config defaults on a per-field basis:

- If a persona sets `model: sonnet`, that overrides the engine config's model.
- If a persona omits `hookStart`, the engine config's start hook is used.
- If a persona sets `indicators:`, its indicators replace the engine config's indicators entirely.

This means most personas can be minimal — only specify what differs from the engine default. The engine config settings page in the dashboard lets you customize defaults for all agents of that engine type.

Resolution order: **persona field > engine config default > null**.

## Frontmatter fields

### Engine

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| engine | `claude`, `codex`, `opencode` | required | Which AI engine CLI to run |

Each engine wraps a CLI tool: `claude` (Claude Code), `codex` (OpenAI Codex CLI), `opencode` (OpenCode CLI). Only these three are supported — invalid engine values are rejected at create time.

### Optional overrides

These fields are optional. When omitted, the engine config default is used.

| Field | Values | Description |
|-------|--------|-------------|
| model | Engine-specific model name | Override engine config model (e.g. `opus`, `sonnet`, `o3`) |
| thinking | `low`, `medium`, `high` | Thinking/reasoning level (Claude only) |
| permissions | `skip` | Pass `--dangerously-skip-permissions` (auto-approves all tool use) |

**Model examples by engine:**

- claude: `opus`, `sonnet`, `haiku` (maps to `--model` flag)
- codex: `o3`, `o4-mini` (maps to `--model` flag)
- opencode: model set via opencode's own config

### Environment

| Field | Example | Description |
|-------|---------|-------------|
| cwd | `/home/user/project` | Working directory (required) |
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

Hooks control how lifecycle actions are dispatched to the tmux session. Each engine has sensible defaults via its engine config. Override in the persona only when you need custom behavior.

| Field | When it runs |
|-------|-------------|
| start | Agent spawns or reloads |
| resume | Agent resumes from suspended state |
| compact | Compact button pressed |
| exit | Exit button pressed |
| interrupt | Interrupt button pressed |
| submit | Message delivered to the agent |

Most hook fields are optional — the engine config provides defaults for all of them. You only need to specify hooks that differ from the engine default.

**Simple hook** (pasted into tmux with Enter):

```
compact: /compact
```

**Keystrokes hook** (ordered key presses and pastes):

```
exit:
  keystrokes:
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

### Template variables

Template variables are interpolated in **shell hooks and pipeline shell steps only** (not in simple strings or keystrokes).

**Built-in variables:**

| Variable | Value |
|----------|-------|
| `$AGENT_NAME` | The agent's name |
| `$AGENT_CWD` | The agent's working directory |
| `$SESSION_ID` | Current session ID (from DB or captured variable) |
| `$PERSONA_PROMPT` | The full system prompt text (shell-quoted automatically) |
| `$PERSONA_PROMPT_FILEPATH` | Path to the persona file on disk (shell-quoted automatically) |

**Captured variables:**

Pipeline `capture` steps extract values from tmux output and store them as named variables. These are persisted in the agent's `capturedVars` and available as `$VAR_NAME` in subsequent shell steps and future hook invocations.

For example, the default Claude engine config captures `SESSION_ID` from the `/status` output after launch:

```
start:
  - shell: claude --model opus --append-system-prompt $PERSONA_PROMPT
  - wait: 5000
  - shell: /status
  - capture:
      lines: 30
      regex: uuid
      var: SESSION_ID
```

Undefined variables resolve to empty string.

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

Indicators match regex patterns in tmux output and show badges in the dashboard. They can be defined at two levels:

**Engine config level** — applies to all agents using that engine. The default Claude config includes indicators for approval prompts, low context, context limit, logged out, and plan review. Edit these in the dashboard Engine Config settings.

**Persona level** — overrides the engine config indicators for this specific agent. If a persona defines `indicators:`, those replace the engine config indicators entirely.

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

For most agents, the engine config indicators are sufficient. Only add persona-level indicators when you need to detect patterns specific to that agent's workflow.

## Full example

A minimal persona (relies on engine config defaults):

```
---
engine: claude
cwd: /home/user/my-project
group: backend
---
# Backend API Agent

You are a senior backend engineer. Focus on:
- REST API routes in src/routes/
- Database queries in src/db/
- Test coverage for all new endpoints
```

A fully customized persona (overrides engine config defaults):

```
---
engine: claude
model: sonnet
thinking: medium
cwd: /home/user/my-project
group: backend
permissions: skip
env:
  NODE_ENV: development
start:
  shell: claude --model sonnet --session-id $SESSION_ID -p "Start working on the API"
compact: /compact
exit:
  keystrokes:
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
