# Changelog

All notable changes to agentic-collab are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## 2.0.0 — 2026-04-03

### Breaking Changes
- **`engine` field is now the config lookup key** — the separate `engineConfig` foreign key field is removed. Each agent's `engine` name is looked up in the `engine_configs` table for defaults (model, thinking, permissions, hooks). Persona frontmatter fields override config defaults. Default engine configs seeded on startup: claude (opus), codex (gpt-4.1), opencode (sonnet).
- **Archive feature removed** — `<archive-panel>` Web Component deleted, archive tab removed from thread view, archive API endpoints removed. Progressive scroll-back replaces archive for message history.

### Features
- **Browser back/forward navigation** — agent selection, tab switches, and Settings open/close push to the History API. URL format: `/dashboard?agent=NAME&tab=TAB` or `/dashboard?settings=1`. On initial load, URL params restore state; defers agent selection until WebSocket init completes if needed.
- **Engine config contextPattern for context % parsing** — health monitor uses the engine config's `contextPattern` regex as the primary source for context percentage, converting token counts via 200k window assumption, falling back to per-engine adapters.
- **Pages** — static file hosting under the orchestrator. Agents and CLI can publish HTML/assets to named pages served at `/pages/<slug>`. Admin via `POST /api/pages` (tar/file upload), `GET /api/pages` (list), `DELETE /api/pages/:slug`. Public serving at `GET /pages/<slug>`. Published Pages section in Settings with delete. CLI `publish`/`pages list`/`pages delete` commands.
- **Settings page** — new dashboard page with engine config management (list/create/edit/delete via YAML frontmatter editor) and global preferences (submit mode, close keyboard on send). Accessible from header button.
- **Engine config indicators** — engine configs support an `indicators` field with default indicator badges: claude (6 indicators including unsafe, approval, plan-review), codex (unsafe), opencode (context indicators). Indicator badges shown on agent cards and in thread header alongside state badge.
- **Configurable detection patterns** — engine configs support a `detection` field with `idlePatterns`, `activePatterns`, `contextPattern`, and tuning knobs (`idleThreshold`, `activeGraceMs`, `snapshotLines`). Active patterns checked first, then idle patterns, then screen-diff fallback. Detection config cached per engine with invalidation on change.
- **Per-pattern line capture** — detection patterns can specify how many trailing lines to match against via `{ pattern: '...', lines: N }` format, preventing false positives from conversation content matching status bar patterns.
- **Local agents indicator** — shows 'N Local Agents' info badge when Claude sub-agents are running, and marks the agent as active to prevent idle transition.
- **Accept any engine string** — the hardcoded `VALID_ENGINES` set (claude, codex, opencode) is removed. Any non-empty engine string is accepted. Engine configs provide defaults but are not required.
- **Hot-reload persona files** — persona directory watched for file changes with 500ms debounce; changes re-sync to DB and broadcast to dashboard.
- **Engine dropdown in persona view** — persona tab shows an engine dropdown populated from engine configs. Changing the dropdown updates the persona file via API.
- **Redesigned agent cards** — compact 2-row layout with inline indicator badges in header row, stars hidden until hover (always visible when starred). Action buttons moved from cards to thread header for progressive disclosure.
- **Collapse engine config YAML** — engine configs in Settings show as collapsed `<details>` by default to reduce visual noise.
- **Agent card meta simplified** — ctx% and unsafe permission badge removed from card meta line; driven by indicators now.
- **Reset defaults button** — Settings page has Reset Defaults button that deletes and recreates engine configs to clear stale fields.
- **`POST /api/engine-configs/reset-defaults`** endpoint for resetting engine configs to defaults.

### Fixes
- **model/thinking/permissions removed from default engine configs** — these fields are now persona-level overrides only, not engine config defaults. Send message fallback improved.
- **Health monitor resolves engine config** for indicators and detection on each poll cycle.
- **Persona watcher switched from fs.watch to polling** — fs.watch was unreliable across filesystems.
- **Keystroke steps showing 'undefined'** in engine config YAML rendering fixed.
- **Fast poll path skips detection patterns** when pane content unchanged.
- **Local agents regex anchored** to status bar middle dot prefix to prevent false matches.
- **Settings panel no longer breaks mobile back button**.
- **Filter chip toggle rebuilds DOM** — un-filtering now restores all groups correctly.
- **Hide empty groups during filtering**, prevent star click from selecting agent.
- **Prevent text selection** on filter chip tap (mobile) and watch panel keys.
- **No auto-keyboard on mobile** agent select, textarea auto-resizes.
- **Sent flash** visual feedback added to watch panel.
- **Star icon alignment** — margin, nudge, and translateY fixes for consistent vertical alignment.
- **Agent card spacing** tightened for consistent vertical rhythm.
- **Thread header layout** — tabs above actions, all rows visible on mobile.
- **Active tab** gets accent border and taller padding (4px to 6px).
- **Star always visible and tappable** — removed hover dependency.
- **CLI pages commands** use correct variable names and `api()` helper.
- **Indicator badges row** bottom margin added.
- **Agent cards not draggable** while search/filter is active (desktop and mobile).

### UI/UX
- **Tab order changed** — Messages, Watch, Reminders, Persona (was Messages, Persona, Watch, Reminders).
- **Agent action buttons relocated** — Compact, Reload, Exit, Kill, Copy tmux, Resume, Spawn, Destroy buttons now appear in thread header when an agent is selected instead of on each card.
- **Indicator badges in thread header** — shown alongside state badge for the selected agent.

## 0.1.1 — 2026-04-01

### Added
- **Dashboard modularization** — monolithic `index.html` script extracted into 16 TypeScript modules and 6 Web Components (`<agent-card>`, `<message-list>`, `<message-input>`, `<watch-panel>`, `<reminder-panel>`, `<archive-panel>`) across a 5-story epic (#195–#210)
- **SVG icon system** — all emoji icons replaced with inline SVG for consistent rendering across platforms (#211)
- **Collapsible sidebar** — toggle sidebar with Cmd/Ctrl+B, thread panel fills space via CSS `:has()` (#230)
- **Reload button** on agent cards — one-click agent reload without destroy/recreate (#233)
- **Permission badge** on agent cards — shows current permission level at a glance (#230)
- **Interrupt button** — stop active agents directly from the message input area (#225, #226, #227)
- **Auto-heal failed agents** — health monitor detects CLI alive in tmux and recovers failed state (#224)
- **Per-account usage polling** — context percentage tracked per credential account (#222)
- **Per-agent credential accounts** — agents can use different API credentials (#221)
- **Proxy dropdown in Create Agent** — replaced `proxy_host` text field with proxy picker (#220)
- **Frontmatter validation** for `cwd` and `proxy_host` fields (#220)
- **Dashboard TypeScript conversion** — all dashboard modules converted to `.ts` with browser-native type stripping (#212)
- **CSS split** — single `dashboard.css` split into 8 component-scoped stylesheets (#210)
- **UI test framework** — mock server, test probe, browser automation runner (#228, #229)
- **105 UI regression tests** across 8 test suites, 17 browser-dependent (graceful skip in CI) (#229, #231)
- **Dashboard syntax validation** test via `vm.compileFunction` — catches errors in browser-only `.ts` files excluded from tsconfig

### Changed
- **Message layout simplified** — removed per-message routing header and topic badge; cross-agent labels shown only for inter-agent messages
- **Tab title** shows unread count for selected agent only (was global total across all agents)
- **Recent filter** capped at 7 agents (was 10)
- **Copy/unsend buttons** always visible at 40% opacity (was hover-only, invisible on mobile)
- **Idle detection** unified across fast and main poll loops with tmux activity timestamps (#223)

### Fixed
- **iOS copy button** — works without dismissing keyboard; uses `touchend` handler instead of suppressing `click` via `touchstart`
- **Copy icon shrinking** after click — `e.target` (SVG child) replaced with `e.currentTarget` (button element)
- **Scrollbars** themed thin and dark, no longer visually jarring on agent list and messages
- **Sidebar collapse dead space** — CSS grid column now collapses to 0px when sidebar hidden
- **Progressive message loading** — render last 30 messages on load, prepend older on scroll-up; eliminates full-thread DOM rebuild (#206, #207, #208)
- **Layout thrashing** — agent cards patched in-place, search filtering without DOM rebuild (#196–#200)
- **Textarea auto-resize** removed — was causing 48ms reflow per keystroke (#199)
- **Markdown images** now render in dashboard messages (`dashboard/utils.ts`); double-escaping fixed in docs renderer (`docs/render.ts`) (#213, #214)
- **Ordered list numbering** preserved across blank lines (#216)
- **Topic breadcrumb scroll** — `overflow-x` was `hidden` instead of `auto` (#215)
- **Drag-drop zone** expanded to entire thread panel (#215)
- **Interrupt button** CSS specificity issue causing hidden state (#226, #227)
- **Heal sweep after restart** prevented — stale pane output no longer triggers false recovery (#224)
- **Session ID resume** fallback when no session captured yet (#232, #233)
- **Agents showing suspended** during redeploy — state transition guard added (#232)
- **PTT toggle wrapping** on iPhone (#220)
- **Exit hook timing** — tmux session preserved on exit (#220)

### Deprecated
- `proxy_host` frontmatter field — use proxy dropdown in Create Agent modal instead (#220)

## 2026-03-24

### Added
- **Quick filter chips** — Active, Idle, Unread, Recent one-tap filters in sidebar (#194)
- **Create agent modal** — replaced inline form with full persona editor modal, engine template picker (Claude/Codex/OpenCode) (#184, #185)
- **File upload with message** — type a message then upload a file, both sent together (#183)
- **Markdown renderer tests** — extracted to `src/shared/markdown.ts` with 42 dedicated tests (#182)

### Changed
- **Search and create controls** pulled out of scroll container — always visible (#178, #179)
- **Idle detection snapshot** bumped from 15 to 30 lines — prevents false idle with large task lists (#188)
- **Auth token** persisted in localStorage instead of sessionStorage — survives tab close (#189)

### Fixed
- **Proxy token rotation** caused persistent 401s on heartbeat failure — token now stable for process lifetime (#191)
- **SESSION_ID fallback** on resume — falls back to agent name when no session captured yet (#177)
- **iOS Safari auto-zoom** prevented via viewport meta tag (#180, #190)
- **PTT voice** reliability on iOS — AudioContext.resume() called synchronously in user gesture (#192)
- **Upload error toast** now shows actual error reason instead of generic count (#193)
- **Create modal stability** — pointer events + stopPropagation prevent accidental dismissal (#186, #187)
- **Filter styling** — mobile padding, clear button, 16px font size (#180, #181)
- **Persona scan** excludes `_`-prefixed files (templates no longer create phantom agents) (#176)
- **Single-column table** rendering in markdown (#182)

## 2026-03-15

### Added
- **Composable hook pipelines** — hooks can now be ordered lists of steps instead of single operations (#160, #161)
- **Pipeline step types**: `shell`, `keystroke`, `keystrokes`, `capture`, `wait` (#161, #168, #169)
- **Generic variable capture** — `capture` steps extract values from tmux pane output via regex and store as named variables (#162)
- **`uuid` shorthand** for capture regex — `regex: uuid` expands to the full UUID pattern (#170)
- **`wait` step** — pause pipeline execution for timing-sensitive flows like CLI init (#168)
- **Flat `keystroke` step** — `- keystroke: Escape` replaces verbose `keystrokes:` nesting for single keys (#169)
- **Custom dashboard buttons** (`custom_buttons` frontmatter) — user-defined buttons on agent cards that trigger pipeline steps (#163)
- **`POST /api/agents/:name/custom/:button`** endpoint for custom button dispatch (#163)
- **Env injection for pipeline hooks** — first shell step in pipeline start/resume/reload gets COLLAB_AGENT/COLLAB_PERSONA_FILE/launchEnv (#169)
- **Collapsible frontmatter** in persona panel — starts collapsed, click to expand (#171)

### Changed
- **`keystrokes` preferred over `send`** as hook mode name (backward compatible) (#160)
- **Session detection via capture steps** — replaces dedicated `detect_session` hook and `detect_session_regex` field (#166, #167)
- **Claude resume uses `$SESSION_ID`** from captured vars instead of `$AGENT_NAME`
- **All personas updated** to new pipeline hook format with engine-specific defaults
- **New Agent form** moved below New Group button, no longer sticky-positioned (#172)
- **README** updated with pipeline hooks, capture, custom buttons, engine defaults (#173)

### Fixed
- **Reply hint** used hardcoded 'operator' instead of actual sender name (#164)
- **Dashboard persona view** didn't render pipeline arrays or custom_buttons (#165)

### Deprecated
- `detect_session` hook field — use `capture` steps in exit/start pipelines instead
- `detect_session_regex` field — use `capture` steps instead
- `send` hook mode name — use `keystrokes` (still works, just not preferred)

## 2026-03-14

### Added
- **Reduced CLI surface** — simplified agent-facing `collab` commands (#152)
- **Updated injected cheatsheet** to match reduced CLI (#153)

## 2026-03-13

### Added
- **`env` frontmatter** — launch-time environment variables for spawn/resume/reload (#142, #143, #144, #145)
- **Reminders** — completed reminders now show in the panel (last 5) (#146)

### Fixed
- Mobile message metadata wrapping (#136)
- Removed dispatcher idle gating that blocked Codex message delivery (#135)

## 2026-03-12

### Added
- **Proxy runs in tmux** — dedicated `agentic-proxy` session survives agent reloads (#132)
- **Codex adapter** defaults to `--dangerously-bypass-approvals-and-sandbox` (#129)
- **`detect_session_regex`** frontmatter for session ID extraction on exit (#127)
- **Template variable interpolation** for shell hooks (`$AGENT_NAME`, `$SESSION_ID`, `$PERSONA_PROMPT`) (#124, #125)
- **`wait_for_idle`** frontmatter field for message delivery control (#126)

### Fixed
- Destroy agent now deletes persona file to prevent resurrection on sync (#128)
- Voice-to-text label clarified (#134)

## 2026-03-11

### Added
- **Cmd+K fuzzy search** for agent navigation (#110)
- **Topic breadcrumbs** in message input with required topics (#112, #115, #116)
- **Voice-to-text** input with `[voice]` prefix (#109, #118, #120)
- **Hotkey hints** in dashboard header (#113)
- **`POST /api/sync-personas`** endpoint (#107)
- **Markdown table rendering** in dashboard (#108)

### Fixed
- Robust CLI exit detection in health monitor (#121, #122)
- Topic breadcrumb overflow and limits (#119, #123)
- Codex update dialog dismissed in usage poller (#114)
- Topic chip focus preservation on mobile (#117)
