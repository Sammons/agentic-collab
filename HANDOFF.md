# Agentic-Collab Handoff Brief

> Last updated: 2026-03-08 — 410+ tests, all passing

---

## What Is This?

A zero-dependency orchestrator for managing AI coding agents (Claude, Codex, OpenCode) via tmux sessions. Node 24, no build step, no `npm install`. SQLite persistence via `node:sqlite`. Single-file SPA dashboard.

**Repo**: GitHub — `Sammons/agentic-collab`

---

## Architecture

```
┌──────────────────────────────────┐
│  Orchestrator (Docker, :3000)    │
│  SQLite (WAL) · HTTP API (25+)  │
│  WebSocket · Health Monitor     │
│  Rate Limiter · HEALTHCHECK     │
└───────────────┬──────────────────┘
                │ HTTP
┌───────────────▼──────────────────┐
│  Proxy (host machine, :3100)     │
│  tmux session management         │
│  File upload streaming to disk   │
│  Heartbeats every 15s            │
└──────────────────────────────────┘
```

**Orchestrator** runs in Docker. **Proxy** runs on the host (needs tmux). Multiple proxies can register with one orchestrator.

---

## File Map

```
src/
├── orchestrator/
│   ├── main.ts              # HTTP server entry point, port 3000
│   ├── database.ts          # SQLite: agents, events, messages, proxies
│   ├── routes.ts            # 25+ HTTP endpoints + rate limiter (sliding window per-IP)
│   ├── lifecycle.ts         # State machine: spawn/resume/suspend/destroy/reload/compact
│   ├── health-monitor.ts    # 30s poll: idle detection, context thresholds, message delivery
│   ├── network.ts           # Graceful shutdown + crash recovery (stuck suspending/resuming)
│   ├── persona.ts           # Persona loading, frontmatter parsing, startup sync to SQLite
│   ├── adapters/
│   │   ├── index.ts         # Adapter registry
│   │   ├── claude.ts        # Claude CLI adapter
│   │   ├── codex.ts         # Codex CLI adapter
│   │   ├── opencode.ts      # OpenCode CLI adapter
│   │   └── types.ts         # EngineAdapter interface
│   ├── *.test.ts            # Tests for each module
│   └── integration.test.ts  # Full integration tests
├── proxy/
│   ├── main.ts              # Proxy server, heartbeat, /upload streaming endpoint
│   ├── tmux.ts              # tmux operations (create, paste, capture, kill, send-keys)
│   ├── tmux.test.ts
│   └── upload.test.ts       # Upload integration tests
├── shared/
│   ├── types.ts             # All shared types (AgentState, EngineType, ProxyCommand, etc.)
│   ├── lock.ts              # SQLite-based lock manager (poll-wait, not try-lock)
│   ├── agent-entity.ts      # State helpers (isRunning, canSuspend, canResume, sessionName)
│   ├── sanitize.ts          # Message sanitization + token generation
│   ├── websocket-server.ts  # RFC 6455 WebSocket (zero deps)
│   ├── utils.ts             # Shell quoting, sleep
│   └── *.test.ts
└── dashboard/
    └── index.html           # Single-file SPA (vanilla JS, no framework)
```

**Other root files**: `Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `LICENSE`

---

## How To Run

```bash
# 1. Start orchestrator (Docker)
export ORCHESTRATOR_SECRET=your-secret   # optional — unset = no auth
docker compose up -d
# Dashboard at http://localhost:3000/dashboard

# 2. Start proxy (host — needs tmux)
export ORCHESTRATOR_SECRET=your-secret
node src/proxy/main.ts
# Registers with orchestrator, heartbeats every 15s

# 3. Run tests
node --test 'src/**/*.test.ts'
# 410+ tests, ~3s
```

**Prereqs**: Node 24+, Docker, tmux, at least one of: `claude`, `codex`, `opencode`

**Note**: Node 24 runs `.ts` natively. No `--experimental-strip-types` flag needed. You'll see a harmless `ExperimentalWarning: Type Stripping` and `ExperimentalWarning: SQLite` on stderr — that's expected.

---

## Where We Came From (Build History)

Chronological feature progression across ~15 commits:

1. **Core scaffolding** — SQLite DB, agent CRUD, proxy registration, heartbeat
2. **Lifecycle state machine** — spawn/suspend/resume/destroy with 3-phase locking + optimistic concurrency (version column)
3. **Health monitor** — 30s poll, context thresholds (80% compact, 90% reload), idle detection, message delivery
4. **Dashboard** — Real-time WebSocket SPA, agent cards, create form, confirmations, keyboard nav
5. **Security hardening** — Timing-safe auth (`crypto.timingSafeEqual`), persona TOCTOU fix, proxy auth
6. **Streaming file upload** — Dashboard → Orchestrator → Proxy → disk. `req.pipe(proxyReq)`, no buffering. 500MB+ works at LAN speed.
7. **Upload hardening** — Backpressure, size limits (512MB default), partial file cleanup, Firefox drag-drop, `Promise.allSettled` for multi-file
8. **Engine adapters** — Claude/Codex/OpenCode with engine-specific CLI flags, thinking modes, interrupt sequences
9. **Final hardening round** (commit `7855cc3`):
   - Path traversal fix: `startsWith(base + '/')` → `path.relative()` + `isAbsolute()` (prefix attack)
   - Migration safety: `PRAGMA table_info` instead of try/catch ALTER TABLE
   - Rate limiting: sliding-window per-IP (120 POST/min, 30 uploads/min), configurable via env
   - Configurable timeouts: all 9 lifecycle timeouts via env vars
   - Docker HEALTHCHECK
   - Crash recovery tests for stuck agents (suspending/resuming states)

---

## Where We Are Now

**Everything works. 410+ tests pass. Production-tested with 15+ concurrent agents.**

### What's Solid

- Full agent lifecycle with crash recovery
- Streaming file uploads (zero-copy piping, no memory spikes)
- Multi-engine support (Claude, Codex, OpenCode)
- Real-time dashboard with WebSocket
- Rate limiting, auth, path traversal protection
- Graceful shutdown/restore across orchestrator restarts
- Zero external dependencies

### Known Caveats (Not Bugs)

- `ExperimentalWarning: SQLite` on stderr — Node 24 built-in, works fine
- `ExperimentalWarning: Type Stripping` — harmless, Node runs .ts natively
- Rate limit constants are module-level (read at import time). In tests, `process.env` must be set before `routes.ts` is first imported. Not a production issue.
- Proxy host validation is intentionally absent — proxy is a trusted partner authenticated via shared secret
- `host.docker.internal` on Linux requires Docker Engine 20.10+ with host-gateway. See comment in `docker-compose.yml` for workarounds.

---

## Environment Variables

### Orchestrator

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `/data/.agentic-collab/orchestrator.db` | SQLite path |
| `ORCHESTRATOR_SECRET` | _(none)_ | Bearer token for API auth |
| `ORCHESTRATOR_HOST` | `http://localhost:{PORT}` | Public URL for agent system prompts |
| `RATE_LIMIT_MAX` | `120` | POST requests per IP per minute |
| `RATE_LIMIT_UPLOAD_MAX` | `30` | File uploads per IP per minute |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `SPAWN_TIMEOUT_MS` | `30000` | Spawn watchdog |
| `SUSPEND_TIMEOUT_MS` | `60000` | Suspend watchdog |
| `RESUME_TIMEOUT_MS` | `60000` | Resume watchdog |
| `RELOAD_TIMEOUT_MS` | `90000` | Reload watchdog |
| `RENAME_DELAY_MS` | `3000` | Post-rename delay |
| `EXIT_WAIT_MS` | `10000` | Exit wait |
| `POST_SPAWN_ACTIVE_DELAY_MS` | `2000` | Post-spawn active delay |
| `POST_RENAME_TASK_DELAY_MS` | `1000` | Post-rename task delay |
| `INTERRUPT_KEY_DELAY_MS` | `300` | Interrupt key delay |

### Proxy

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROXY_PORT` | `3100` | HTTP port |
| `ORCHESTRATOR_URL` | `http://localhost:3000` | Orchestrator address |
| `PROXY_HOST` | `host.docker.internal:{PROXY_PORT}` | How orchestrator reaches proxy |
| `PROXY_ID` | `os.hostname()` | Unique proxy ID (defaults to machine hostname) |
| `ORCHESTRATOR_SECRET` | _(none)_ | Must match orchestrator |
| `MAX_UPLOAD_BYTES` | `536870912` | Max upload size (512MB) |

---

## Key Patterns to Understand

### Agent State Machine

```
void → spawning → active ↔ idle → suspending → suspended → resuming → active
                    ↓                                         ↓
                  failed ←────────────────────────────────────┘
```

All transitions use **3-phase locking** with **optimistic concurrency** (version column in SQLite). Watchdog timers (configurable via env) prevent hung operations. The `LockManager` uses poll-based wait-locks, not try-locks — contention delays, doesn't fail.

### Message Delivery

Messages are enqueued in `pending_messages` table. The health monitor delivers one message per poll cycle when an agent is idle. Messages are pasted into the tmux session via the proxy. Format: `[from: <source>, reply with /collaboration reply]: '<message>'`.

### Crash Recovery (`network.ts`)

On startup, `restoreAllAgents()`:
1. Agents with `stateBeforeShutdown` set → resume them
2. Agents stuck in `suspending` or `resuming` → mark failed, then re-resume
3. Active agents → check if tmux session exists via proxy `has_session`; if not, re-resume
4. Agents with no proxy available → skip with warning

### Streaming Upload Pipeline

```
Browser fetch(file) → Orchestrator req.pipe(proxyReq) → Proxy req.pipe(writeStream)
```

No buffering anywhere. Memory usage: O(chunk size). Metadata via query params, binary via body.

### Engine Adapters

Each adapter implements: `buildCommand()`, `parseIdleState()`, `parseContextUsage()`, `interruptKeys()`, `compactCommand()`. Tests verify exact CLI flag arrays per engine.

---

## What Was Built This Session

1. **Persona frontmatter system** — `persistent-agents/*.md` files with YAML-like frontmatter (engine, model, thinking, cwd, proxy_host, permissions). Idempotent startup sync to SQLite. Persona API (GET list, GET detail, PUT write).
2. **Workstream removal** — Removed workstream feature (use Notion instead). Cleaned up database, routes, types, tests.
3. **Proxy hostname identification** — Proxies self-identify via `os.hostname()` instead of random IDs. Persona `proxy_host` field pins agents to specific machines.
4. **Permission skip from frontmatter** — `permissions: skip` in frontmatter instead of hardcoded `dangerouslySkipPermissions: true`.
5. **Dashboard improvements** — Search/filter agents, mobile responsive layout with back navigation, persona tab shows structured frontmatter table, 6 screenshots (desktop + mobile).
6. **README update** — Persona docs, desktop/mobile screenshot table, updated env vars.

### Recent additions (post-persona)

7. **Event-driven message delivery** — `MessageDispatcher` delivers messages immediately when agents go idle, replacing the poll-only approach.
8. **Usage poller** — Tracks token usage across agent sessions via CLI tooling.
9. **Voice dictation proxy** — WebSocket-based voice input via ElevenLabs STT (optional).
10. **Dashboard unread persistence** — Server-side read cursors (message ID-based) survive page refresh.
11. **Proxy version handshake** — Proxies present git SHA during registration; orchestrator compares and warns on mismatch. Dashboard shows amber "stale proxy" badge.
12. **Idle detection fixes** — Hybrid tmux activity + content regex, handles self-heal recovery and Codex TUI changes.
13. **`collab` CLI** — Standalone agent CLI (`bin/collab`) for sending messages, managing lifecycle, checking status from within tmux sessions.

## Onboarding Pattern

The recommended way to use agentic-collab is to start with a **team lead agent** that bootstraps the rest:

1. `docker compose up -d` — starts orchestrator, creates shared secret
2. `node src/proxy/main.ts` — auto-discovers orchestrator, no config needed
3. Copy `persistent-agents/team-lead.example.md` → `persistent-agents/team-lead.md`, edit for your project
4. Spawn the team lead with a high-level objective
5. The team lead creates specialist agents, assigns tasks, coordinates

See `persistent-agents/team-lead.example.md` for the full template.

## What Could Be Built Next

1. **MCP config support** — `mcp` field in frontmatter → `--mcp-config <path>` for Claude adapter
2. **Dashboard empty state** — Getting-started guide when no agents/proxies exist
3. **Dashboard dark/light toggle** — Currently dark-only; light mode for accessibility

---

## Running Tests

```bash
# All tests
node --test 'src/**/*.test.ts'

# Specific module
node --test src/orchestrator/lifecycle.test.ts

# Watch mode
node --test --watch 'src/**/*.test.ts'

# Type check only
npx tsc --noEmit
```

Test suites: database, lifecycle, health-monitor, network, routes, persona, adapters, integration, lock, agent-entity, sanitize, utils, websocket-server, tmux, upload.

---

## Commit Style

Conventional commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`. Include body when non-trivial. Co-author line: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

---

## Quick Reference Commands

```bash
# Start everything
docker compose up -d && node src/proxy/main.ts

# Create an agent via API
curl -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $SECRET' \
  -d '{"name": "my-agent", "engine": "claude", "cwd": "/path/to/project"}'

# Spawn it
curl -X POST http://localhost:3000/api/agents/my-agent/spawn \
  -H 'Authorization: Bearer $SECRET'

# Upload a file
curl -X POST "http://localhost:3000/api/dashboard/upload?agent=my-agent&filename=data.json" \
  -H 'Authorization: Bearer $SECRET' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @data.json

# Graceful shutdown (suspends all agents with state preserved)
curl -X POST http://localhost:3000/api/orchestrator/shutdown \
  -H 'Authorization: Bearer $SECRET'

# Restore after restart
curl -X POST http://localhost:3000/api/orchestrator/restore \
  -H 'Authorization: Bearer $SECRET'
```
