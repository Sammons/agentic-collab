# Changelog

All notable changes to agentic-collab are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
