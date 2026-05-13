# agentic-collab

Zero-dependency orchestrator for AI coding agents via tmux. Node 24 native TypeScript — no build step, no npm install.

## Quick Start

```bash
./start.sh          # orchestrator (Docker :3000) + proxy (host :3100)
node --test 'src/**/*.test.ts'  # ~875 tests
npx tsc --noEmit    # type check
```

## Architecture

```
Orchestrator (Docker :3000)      Proxy (host :3100)
  SQLite WAL | HTTP API           tmux session mgmt
  WebSocket | Health Monitor  ←→  File upload streaming
  Persona loader                  Heartbeats every 15s
```

Agent state machine: `void → spawning → active ↔ idle → suspending → suspended → failed`

## Source Map

```
src/
├── orchestrator/        # Docker container
│   ├── main.ts, database.ts, routes.ts
│   ├── lifecycle.ts     # 3-phase locking, watchdog timers
│   ├── health-monitor.ts
│   ├── persona.ts       # YAML frontmatter parsing
│   └── adapters/        # claude.ts, codex.ts, opencode.ts
├── proxy/               # Host process
│   ├── main.ts, tmux.ts
├── shared/              # types.ts, lock.ts, websocket-server.ts
└── dashboard/           # Vanilla JS SPA (index.html)
```

## Key Patterns

- **3-phase locking**: lifecycle.ts uses optimistic concurrency via version column
- **Health monitor**: 30s poll cycle, idle detection via tmux parsing, 80%→compact, 90%→reload
- **Message dispatch**: event-driven queue with cool-down coordination (300ms after lifecycle ops)
- **Personas**: `persistent-agents/*.md` with YAML frontmatter (engine, cwd, model, hooks)

## Capacity Scaling

Spin up parallel instances of an existing persona on isolated git worktrees:

```bash
# Create a new agent from an existing persona
./scripts/scale-up.sh <base-persona> <new-name> <branch> [<base-branch>]
./scripts/scale-up.sh dev dev-a feature/issue-101
./scripts/scale-up.sh reviewer reviewer-a hotfix/critical

# Tear it down when done
./scripts/scale-down.sh dev-a                  # removes worktree + branch
./scripts/scale-down.sh dev-a --keep-branch    # keep the git branch
./scripts/scale-down.sh dev-a --force          # discard uncommitted changes
```

- `scale-up.sh` creates a worktree at `<repo>-worktrees/<new-name>`, copies the base persona with `cwd` updated, and the filesystem watcher auto-registers it (`void` state); spawn via dashboard or `curl -X POST .../api/agents/<name>/spawn`
- `scale-down.sh` calls `/api/agents/<name>/destroy`, removes the worktree, and optionally deletes the local branch; refuses if uncommitted changes exist (use `--force` to override)

## Testing

```bash
node --test 'src/**/*.test.ts'           # all tests
node --test --watch 'src/**/*.test.ts'   # watch mode
node --test src/orchestrator/*.test.ts   # subset
```

## Commits

Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`

For story-linked work:
```
<story-slug>: description

Motivation: <why>
Changes:
 - <file>: <one-line>
```

## Don't

- Add npm dependencies (zero-dep is a design constraint)
- Skip the type check (`npx tsc --noEmit`)
- Push directly to main (use worktree + PR)
- Use --no-verify on commits
