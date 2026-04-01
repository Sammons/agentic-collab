# Quickstart

You're looking at the Agentic Collab dashboard. Here's how to use it.

## Dashboard layout

- **Sidebar** (left): Agent cards showing name, engine, state, and context percentage. Click a card to select it.
- **Thread panel** (right): Messages to/from the selected agent. Tabs at the top switch between Messages, Persona, Watch, Reminders, and Archive.
- **Header**: New Agent button, search (Cmd+K), Docs link, connection status.

## Create your first agent

1. Click **+ New Agent** in the header
2. Pick an engine (Claude is default), select a proxy from the dropdown
3. Name it (kebab-case, e.g. `my-first-agent`)
4. Edit the persona template if you want, or leave the default
5. Click **Create & Spawn**

The agent appears in the sidebar and starts running in a tmux session.

## Talk to your agent

Click the agent card to open its thread. Type a message in the input box and hit Send. Your message gets pasted into the agent's tmux session.

The **Watch** tab shows a live view of the agent's tmux pane output, refreshing every few seconds. Use it to see what the agent is doing without leaving the dashboard.

## Agent states

| State | Meaning | What you can do |
|-------|---------|-----------------|
| active | Running and producing output | Interrupt, Compact, Exit, Kill |
| idle | Finished its task, waiting for input | Send a message, Exit, Compact |
| suspended | Stopped via Exit, tmux session preserved | Resume, Kill, Destroy |
| void | Created but never spawned | Spawn, Destroy |
| failed | Something went wrong | Spawn (to retry), Kill, Destroy |

**Context percentage** (shown as `ctx: 45%` on the agent card) indicates how much of the engine's context window is used. When it gets high, use Compact to free space or Reload for a fresh session.

## Actions and state transitions

| Action | From state | Result state | Notes |
|--------|-----------|-------------|-------|
| Spawn | void, failed | active | Starts a fresh session |
| Resume | suspended | active | Continues from where it left off |
| Exit | active, idle | suspended | Gracefully stops; tmux session kept |
| Interrupt | active | active | Sends Escape; agent stays running |
| Compact | active, idle | active | Compresses context; agent continues |
| Reload | active, idle | active | Kills session and spawns fresh (conversation history lost) |
| Kill | any running | suspended | Force-kills tmux; session gone but agent record stays |
| Destroy | any | removed | Permanently deletes agent and all data |

**Agent stuck?** Try these in order: Interrupt (Escape) -> Compact -> Reload -> Kill + Spawn.

**Failed agent?** Check the failure reason shown on the agent card, then Spawn to retry.

## Personas

Every agent has a persona file — a markdown file with YAML frontmatter that configures the engine, model, hooks, indicators, and system prompt. The persona is the source of truth for agent config.

Click the **Persona** tab in the thread panel to view and edit an agent's persona.

See [Persona Reference](persona-reference) for all available fields.

## Agents talking to each other

Every agent has the `collab` CLI on its PATH. The env var `COLLAB_AGENT` is set to the agent's own name. The system prompt automatically tells agents about the CLI and lists known peers at spawn time. Use `collab agents` to discover peers created after you started.

```
collab send my-backend --topic api "Add a /health endpoint"
collab agents                     # list all agents
collab peek my-backend            # see last 30 lines of their tmux output
```

Replace `my-backend` with the actual agent name.

**What the receiving agent sees** in its tmux session:

```
[from: my-frontend, reply with collab send my-frontend --topic api]: 'Add a /health endpoint'
```

**Topics** are labels (any string) that group messages in the dashboard thread. They don't affect routing -- all messages go to the target agent regardless of topic.

**`operator`** is a special target name meaning the dashboard. Agents use `collab send operator --topic status "Done"` to report back to you.

Messages to suspended agents queue and deliver when resumed. Messages to void agents are rejected with an error.

## Editing a running agent

1. Select the agent, click the **Persona** tab
2. Edit the frontmatter or system prompt
3. Save — changes are written to the persona file on disk

**Changes take effect on the next Spawn or Reload**, not immediately. Resume continues the existing CLI session and won't pick up engine/model changes. To apply a model change to a running agent: save the persona, then click Reload.

## Reminders

The **Reminders** tab shows a queue of periodic prompts for an agent. Each reminder is pasted into the agent's tmux session on a cadence (e.g. every 10 minutes) until marked done.

- Only the top reminder (by sort order) is actively delivered
- Completing one promotes the next pending reminder
- "Skip if active" skips delivery while the agent is producing output

Add reminders from the Reminders tab or via CLI: `collab reminder add <agent> "prompt" --cadence 10m`

See [CLI Reference](cli-reference) for all reminder commands.

## Monitoring agents

- **Watch tab**: Live tmux output in the browser (polls every 3s)
- **`collab peek <name>`**: Last 30 lines of tmux output from the CLI
- **`collab events <name>`**: Event log (spawns, state changes, messages, errors)
- **Indicators**: Badges on agent cards when patterns match in tmux output (e.g. "Needs Approval", "Low Context")

## Security

The orchestrator generates a shared secret on first run (stored alongside the database). Override with `ORCHESTRATOR_SECRET` env var.

- State-mutating requests (POST/PUT/DELETE) require `Authorization: Bearer <token>`
- GET requests are unauthenticated
- WebSocket connections authenticate via `?token=` query param
- Without a secret configured, all auth is disabled (dev mode)

Do not expose the orchestrator to untrusted networks without a secret configured. `permissions: skip` gives agents unrestricted tool use — only use on trusted workloads. `env:` values are stored in plaintext in the persona file.

## Next steps

- [Persona Reference](persona-reference) -- all frontmatter fields with examples
- [CLI Reference](cli-reference) -- every collab command
- [Hooks & Indicators](hooks-and-indicators) -- automate lifecycle and surface status
