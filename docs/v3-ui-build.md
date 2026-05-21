# v3 Dashboard UI — Build Tracker

The v3 dashboard is being implemented in 10 phased PRs against the locked design
in `docs/v3-dashboard-design.html` (the Greenroom mock).

**Design system source of truth:** `.claude/skills/ui-theme/REFERENCE.md`
**Per-screen design locks:** `.claude/skills/design/REFERENCE.md`
**Authoritative mock:** `docs/v3-dashboard-design.html` (~6000 lines)

## Strategy

- Clean-room rewrite in a new `src/dashboard-v3/` directory served at `/v3/` while
  the v2 dashboard keeps running at `/`.
- Same constraints as the rest of the codebase: zero deps, Node 24 native TypeScript,
  no build step, custom-elements + plain CSS.
- Each phase is one PR (one commit cluster).
- **Cutover happens at PR 10:** v3 reaches feature parity, v2 is archived, v3 is
  promoted from `/v3/` to `/`.

## Scoping decisions (locked)

- **Teams:** server-side `/api/teams` CRUD + DB table. Teams sync across browsers.
  (Alternative was client-side localStorage; rejected for sync.)
- **Merged chat feed:** client-side merge of `state.threads{}`. Fine for thousands of
  messages; can move to server-side `/api/dashboard/feed` later if needed.
- **Search:** client-side multi-type aggregation for v0. No new endpoint.
- **Cadence:** one PR per phase (10 PRs total).
- **Cutover:** at parity, archive v2.

## Phases

| PR  | Subject                                                  | Status      | Notes                                                                |
|-----|----------------------------------------------------------|-------------|----------------------------------------------------------------------|
| 1   | Foundation + sidebar/routing + Teams API                 | done        | Backend Teams CRUD + DB migration + WS event + serve `/v3/`. Frontend shell, sidebar (Teams tree), hash router, placeholder routes. 26 unit tests for the Teams API; full orchestrator suite still green (pre-existing macOS persona symlink quirk unrelated). |
| 2   | Dashboard merged chat + composer + profile popover       | done        | Client-side merge, dedup by id. Optimistic-send. @-mention parsing in composer. Profile popover on sender click with Watch / Filter / Copy actions. Mention + inline-code rendering. Withdrawn state visual. `tsconfig.json` excludes `src/dashboard-v3/**/*.ts` (browser code). |
| 3   | Agents page (flat list)                                  | done        | State-priority sorting (failed → spawning → active → idle). Filter chips (All / Running / Failed / No team). Click row → Watch. Hover actions + More menu (Spawn / Kill / Watch / Open in tmux / Edit persona / Copy address / Delete). Edit-persona deferred to PR 9. |
| 4   | Watch screen                                             | pending     | Wraps `/api/agents/:name/peek` + key injection. New chrome.          |
| 5   | Approvals master-detail + Amend modal                    | pending     | Reuses `/api/approvals/*`.                                           |
| 6   | Reminders (fan-out)                                      | pending     | Per-agent grouping, sortOrder field ignored by UI.                   |
| 7   | Settings (5 sections)                                    | pending     | Engine configs, prefs, pages, stores, destinations.                  |
| 8   | Search (client-side multi-type)                          | pending     | Cmd+K + scope chips, client aggregation.                             |
| 9   | Overlays (New agent, New team, Edit persona)             | pending     | Shared `.ov-*` vocabulary.                                           |
| 10  | Cutover (archive v2, promote v3 to `/`)                  | pending     | Final step.                                                          |

## PR 1 scope

### Backend (`src/orchestrator/`)

- **DB migration** in `database.ts::migrate()`:
  - `CREATE TABLE IF NOT EXISTS teams (id INTEGER PK AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime(...)))`
  - `CREATE TABLE IF NOT EXISTS team_members (team_id INTEGER NOT NULL, agent_name TEXT NOT NULL, added_at TEXT NOT NULL DEFAULT (...), PRIMARY KEY (team_id, agent_name), FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE)`
- **`Database` methods**: `listTeams()`, `createTeam(name, members?)`, `updateTeamName(id, name)`, `deleteTeam(id)`, `addTeamMember(teamId, agentName)`, `removeTeamMember(teamId, agentName)`
- **New endpoints** in `routes.ts`:
  - `GET /api/teams` → `Team[]` with member arrays
  - `POST /api/teams` `{ name, members? }` → `Team`
  - `PATCH /api/teams/:id` `{ name }` → `Team`
  - `DELETE /api/teams/:id` → `204`
  - `POST /api/teams/:id/members` `{ agentName }` → `Team`
  - `DELETE /api/teams/:id/members/:agentName` → `Team`
- **New WS event** `teams_update` broadcast on every team mutation.
- **`init` payload** in `main.ts` gains `teams: db.listTeams()`.
- **Static serving** in `routes.ts`:
  - `GET /v3` → serves `src/dashboard-v3/index.html`
  - `GET /v3/assets/:path+` → serves files under `src/dashboard-v3/`
- **`Team` type** in `src/shared/types.ts`.

### Frontend (`src/dashboard-v3/`)

- `index.html` — Greenroom shell with sidebar + main, Google Fonts (Bricolage + Geist Mono).
- `main.ts` — entry: wires connection → state → routing → sidebar.
- `state.ts` — single source of truth + pub/sub event bus (agents, teams, threads, selected, sidebar selection set, connected).
- `connection.ts` — WebSocket client. Subscribes to `init`, `agents_update`, `agent_update`, `teams_update`, `message`. Auto-reconnect.
- `routing.ts` — hash router mapping `#/`, `#/agents`, `#/watch/:name`, `#/approvals`, `#/reminders`, `#/settings`, `#/search` to handlers.
- `sidebar.ts` — `<v3-sidebar>` web component: tri-state All-toggle, Team rows (chev, folder, name, count, expand on click), Member rows (checkbox + name + eye icon), bottom nav (Settings).
- `styles/base.css` — `:root` tokens copied from mock, body, font wiring, reset, scrollbar.
- `styles/layout.css` — shell grid (sidebar 224px + main 1fr).
- `styles/sidebar.css` — sidebar component CSS.
- `styles/buttons.css` — `.btn`, `.btn.primary`, `.btn.danger`, `.btn.ghost`.
- Placeholder content for each of the 7 routes (h1 + lede).

### Verification

- `npx tsc --noEmit` passes.
- `node --test src/orchestrator/teams.test.ts` passes (CRUD round-trip + membership + cascade delete).
- Manual: `./start.sh`, open `http://localhost:3000/v3/`, sidebar renders, can create a team via the network tab, hash routing switches placeholders.

### Out of scope for PR 1

Everything else. PR 1 only builds the foundation and the Teams API. No chat content,
no Agents list, no Watch wrapping, no Approvals UI, no Reminders, no Settings UI, no
Search, no overlay modals. Those are PRs 2–9. Cutover is PR 10.

## Working notes

This doc is updated as each PR lands. Each PR's commit should reference the row above
and update the **Status** column.
