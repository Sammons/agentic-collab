# CLI Reference

The `collab` CLI is available on every agent's PATH and can be used from any terminal that can reach the orchestrator.

## Connection

The CLI auto-discovers the orchestrator. Inside agent tmux sessions, these env vars are set automatically at spawn:

- `COLLAB_AGENT` -- the agent's own name (used as sender identity)
- `COLLAB_ORCHESTRATOR_URL` -- orchestrator URL
- `COLLAB_PERSONA_FILE` -- path to the agent's persona file

To use `collab` from your own terminal (outside Docker), set:

```
export COLLAB_ORCHESTRATOR_URL=http://localhost:3000
```

## Commands

### Agent management

**List agents:**
```
collab agents
collab list-agents    # alias
```

**Create an agent (manual):**
```
collab create <name> <engine> <cwd>
collab create my-agent claude /home/user/project
```

Creates a bare agent with no persona. You still need to `collab spawn` it afterward.

**Create from persona file (recommended):**
```
collab create-agent <persona-file>
collab create-agent ~/persistent-agents/my-agent.md
```

Reads the persona markdown file, extracts frontmatter config, and creates/updates the agent. This is the standard way to create agents -- the persona file is the source of truth.

**Spawn (start) an agent:**
```
collab spawn <name> [task...]
collab spawn my-agent "Fix the login bug"
```

**Resume a suspended agent:**
```
collab resume <name> [task...]
collab resume my-agent "Continue where you left off"
```

**Reload (kill + respawn):**
```
collab reload <name> [task...]
```

### Agent control

**Exit (graceful stop):**
```
collab exit <name>
```

**Interrupt (send Escape):**
```
collab interrupt <name>
```

**Compact context:**
```
collab compact <name>
```

**Kill session:**
```
collab kill <name>
```

**Destroy permanently:**
```
collab destroy <name>
```

### Messaging

**Send to the dashboard (operator):**
```
collab send operator --topic status "Task complete"
```

**Send to another agent:**
```
collab send other-agent --topic review "Please review my PR"
```

**Reply (alias for send operator):**
```
collab reply --topic status "Done"
```

The `--in-reply-to` flag quotes the original message for context:

```
collab send other-agent --topic review --in-reply-to "review my PR" "LGTM, merged"
```

Messages are pasted into the target agent's tmux session. If the target is suspended or idle, the message queues and delivers when possible. Messages to void agents (not yet spawned) are rejected immediately.

### Observation

**Peek at agent output** (last 30 lines of tmux pane):
```
collab peek <name>
```

Returns the raw terminal output — what you'd see if you `tmux attach`ed to the session.

**View event log** (spawns, state changes, messages, errors):
```
collab events <name> [--limit 20]
```

Each event shows timestamp, event type, and details. Useful for diagnosing why an agent failed or went idle.

**Check message queue** (pending/failed deliveries):
```
collab queue [--agent <name>]
```

**Send tmux keys:**
```
collab keys <name> <keys>
collab keys my-agent "Enter"
```

**Constrained tmux passthrough:**
```
collab tmux <agent> -- <tmux-subcommand> [args...]
collab tmux my-agent -- capture-pane -p
```

### Reminders

Reminders periodically paste a prompt into an agent's tmux session until marked done. Only the top reminder (by sort order) is actively delivered per agent. Completing one promotes the next.

**Add a reminder:**
```
collab reminder add <agent> "<prompt>" --cadence 10m [--from <name>] [--skip-if-active]
```

- `--cadence`: How often to re-deliver (e.g. `5m`, `30m`, `2h`). Minimum 5 minutes.
- `--from`: Who created the reminder (shown in the delivery envelope).
- `--skip-if-active`: Skip delivery while the agent is actively producing output. Useful for nudges that should only fire when idle.

**What the agent sees:**
```
[reminder #42 from dashboard]: Please commit your changes
Mark done when complete: collab reminder done 42
```

**List reminders:**
```
collab reminder list [--agent <name>]
```

**Mark done:**
```
collab reminder done <id>
```

Completing the active reminder promotes the next pending one in the queue.

**Cancel:**
```
collab reminder cancel <id>
```

**Reorder:**
```
collab reminder swap <id1> <id2>
```

Controls which reminder is delivered first (lower sort order = delivered first).

### Pages

Publish static content to the orchestrator's built-in web server. Pages are served at `<orchestrator>/pages/<slug>`.

**Publish a directory:**
```
collab publish <slug> <dir>
collab publish my-report ./output
```

Tars the directory contents and uploads them. The slug becomes the URL path.

**Publish from a template:**
```
collab publish <slug> --template <name> --store <store> --title <title>
collab publish metrics-dash --template dashboard --store metrics --title "Metrics Dashboard"
```

Renders an HTML template with the given store and title injected, then publishes it. `--title` defaults to the slug if omitted. Run `collab templates` to see available templates.

**List published pages:**
```
collab pages list
collab pages         # same — list is the default
```

Shows slug, file count, size, publishing agent, and last update time.

**Delete a page:**
```
collab pages delete <slug>
collab pages delete my-report
```

**List available templates:**
```
collab templates
```

Shows template names from `src/templates/`. Each can be used with `collab publish --template`.

### Data Stores

SQLite-backed data stores that agents can create, query, and share. Each store is a separate database managed by the orchestrator.

**Create a store:**
```
collab db create <name>
collab db create metrics
```

Creates an empty SQLite store. If `COLLAB_AGENT` is set, the store is associated with that agent.

**Execute SQL:**
```
collab db query <name> <sql>
collab db query metrics "CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, ts TEXT)"
collab db query metrics "INSERT INTO events (name, ts) VALUES ('deploy', '2026-04-03')"
collab db query metrics "SELECT * FROM events"
```

Returns results as JSON. Any valid SQL is accepted — CREATE, INSERT, SELECT, etc.

**Show schema:**
```
collab db schema <name>
collab db schema metrics
```

Lists all tables and their columns with types, primary key, and NOT NULL constraints.

**List all stores:**
```
collab db list
collab db            # same — list is the default
```

Shows store name, owning agent, and last update time.

**Delete a store:**
```
collab db delete <name>
collab db delete metrics
```

### Destinations

External notification targets (e.g. Telegram). Agents can send messages to destinations using the standard `collab send` command.

**Add a destination:**
```
collab destinations add <name> <type> --bot-token <token> --chat-id <id>
collab destinations add my-telegram telegram --bot-token 123:ABC --chat-id -100123
```

Currently supported type: `telegram` (requires `--bot-token` and `--chat-id`).

**List destinations:**
```
collab destinations list
collab destinations       # same — list is the default
```

Shows name, type, enabled/disabled status, and last update time.

**Delete a destination:**
```
collab destinations delete <name>
collab destinations delete my-telegram
```

**Send a test message:**
```
collab destinations test <name>
collab destinations test my-telegram
```

Sends a test message through the destination to verify the configuration works.

**Send via a destination:**
```
collab send telegram "message"
collab send telegram:my-telegram "message with specific destination"
```

Routes through the existing `send` command. Bare `telegram` picks the first enabled telegram destination. `telegram:<name>` targets a specific one by name. Supports `--topic` and `--in-reply-to` flags like normal sends.

### Status

**Orchestrator status:**
```
collab status
```

**Help:**
```
collab help
```
