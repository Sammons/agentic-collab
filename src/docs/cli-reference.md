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

### Status

**Orchestrator status:**
```
collab status
```

**Help:**
```
collab help
```
