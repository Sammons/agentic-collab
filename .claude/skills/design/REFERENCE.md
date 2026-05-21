# Design Reference — v3 Dashboard Mock

Living memory for the `/design` skill. **Read `../ui-theme/REFERENCE.md` first** for the
systemic design vocabulary (palette, typography, composition rules, anti-patterns). This
file covers only the *mock-specific* decisions on top of that system.

## Locked decisions (structural)

These came from explicit user redirections — do not revisit unless the user says so.

- **Teams in the sidebar, not Agents.** The sidebar is built around **Teams** (groups of agents).
  Agents can belong to multiple teams. Clicking a team name toggles all its members on/off in
  the filter; the chevron is for expand/collapse only.
- **The main pane is always a merged chat stream**, filtered by which agents are checked in
  the sidebar. Selection is a FILTER, never navigation. There is no separate per-agent thread
  view.
- **Sidebar action items.** Top of sidebar: `Agents` · `Search` · `Approvals` (with badge for
  pending count). Bottom of sidebar: `Settings` with a gear icon.
- **Watch entry is in the sidebar.** Each agent row in an expanded team has a small eye icon
  that toggles Watch mode for that agent. Watch is sticky.
- **Clicking a sender name in the chat opens that agent's profile popover** — a small floating
  card showing kind, state, teams, address, and primary actions (Watch, Filter to this, Copy
  address).
- **Triggering via `@`-mention.** You start an ephemeral run by `@`-mentioning the recipe in
  the chat composer (e.g., `@aws-account-lead/provision`). Mid-run, mention a specific
  instance by hash to send it input. The term is **trigger** (not spawn).
- **Dead-letter is watch-only.** If you message an exited ephemeral, the dispatcher returns a
  dead-letter reply, but the dashboard only renders it inline when the user is watching.
- **Single HTML file, embedded CSS.** No JS framework. Google Fonts via `<link>` for type.

## Aesthetic & voice

See `../ui-theme/REFERENCE.md` — palette, typography, composition rules, voice, and the
aesthetic anti-patterns (terminal-intense / Anthropic-editorial / cool-slate-calm) all
live there. Don't duplicate them here.

## Mock-specific rejected directions — do not regress

These are *structural* rejections specific to this mock; aesthetic rejections live in
`../ui-theme/REFERENCE.md` §9.1.

1. **A separate Templates / Workflows / Triggers tab.** Earlier iterations had a 3-segment
   toggle (Agents · Templates · Approvals).
   _Rejected: ephemeral agents are just agents._

2. **Two top-level tabs (Agents · Approvals) with per-agent threads.** The earlier
   iteration had this; now superseded by Teams-as-filter + merged chat.
   _Replaced by: Teams in sidebar, merged stream in main pane._

3. **Avatars on agent messages.** Tried small avatar squares.
   _Replaced by: 3px left identity-color border on message body, name + hash in head._

4. **Topic-detail / queue-stats main pane.** Earlier iteration made the recipe's pane a
   stats dashboard.
   _Rejected: main pane is the merged chat. Stats can live in the profile popover._

5. **A queue with active/queued framing in Reminders.** Sortorder still exists in the
   data model, but the UI fans out — every pending reminder fires independently.
   _Replaced by: flat per-agent list of reminders, each with its own cadence + next-fire._

## Per-component subtractions already applied (do not add back without reason)

- No `via <topic>` text in message heads
- No `Kind / History / Topics` meta row under the main address
- No day separators (one mock doesn't need them)
- No `Attach / JSON / ⌘↵` kbd hints in composer ctrls
- No row descriptions in the @-mention popover
- No `✓ / ×` glyphs on instance ages
- No explanatory paragraphs in component callouts (title + visual only)
- Persistent-agent meta labels reduced to colored dots; idle agents have no meta

## Screens designed so far

- **01 The dashboard (merged chat)** — the default surface. Sidebar Teams filter +
  unified chat stream in the main pane. Profile popover on sender click. An
  "All agents" tri-state checkbox sits above the Teams list as the master toggle
  for the filter.
- **02 Agents · management** — the page you land on when "Agents" is clicked in the
  nav rail. Flat list (no group separation between ephemeral/persistent — kind is
  a column instead) sorted by state priority (failed → running → queued → active
  → paired → idle). Columns: name | kind | teams | state | actions. Action icons
  always visible (Watch, Edit, More), brighter on hover. `+ New agent` and
  `↻ Reload all` in the top right.
  - **Clicking a row navigates to that agent's Watch view.** The Watch eye icon
    and the More menu's "Watch" entry are redundant fast-paths to the same
    destination — multi-path by design for discoverability.
  - The **More menu** (under ⋯): Spawn · Kill · Watch · Open in tmux (copies
    attach command) · Edit persona · Copy address · ─── · Delete.
  - Failed agents render with brick-tinted names; clay accent reserved for
    running/queued counts and the primary "+ New agent" button.
- **03 Watch · remote operator console** — full-screen tmux session view for
  a single agent. Mirrors the existing `src/dashboard/watch-panel.ts`
  functionality: live pane output (polls `/api/agents/:name/peek` every 3s),
  pause/expand/resize controls, special-key row (arrows, Enter/Esc/Tab/S-Tab/
  Space, C-c/C-x/C-z, y/n/q), and a literal-text type input with Send / Send+↵.
  - Header: `← Back to agents` on the left, eyebrow `Watching / <name>` plus a
    large title with state pill, `Open in tmux` + `Stop watching` on the right.
  - Terminal pane uses the paper palette (not a dark terminal) — mono font,
    ANSI-like colors mapped to the project palette (steel for prompts, moss
    for ok, clay for warn, brick for err, ink-3 for dim metadata).
  - A small green pulse + "Live · last 1.4s ago" sits at the right of the
    controls bar so the operator always sees the data is fresh.
  - Special keys styled as physical keyboard keys (`kbd`-style: rounded
    corner, 2px bottom border, slight press-down on `:active`).
- **04 Approvals · inbox + review** — master-detail split inside the main
  pane (340px master / fluid detail). Chosen specifically because approval
  review is sequential — master-detail eliminates back-and-forth navigation
  between list and detail. This is the ONLY screen using master-detail; Agents
  is full list, Watch is full pane.
  - Master: title with counts, two chip rows (Channel, State), grouped list
    (Pending sticky at top, then Recent). Each item shows a state dot, hash id,
    channel name, requester (with state tag if terminal), age.
  - Detail: crumb `aws-account-provision / request from gitea-lead`, large
    mono hash + state pill, metadata row (Requester / Created / Updated),
    Payload (JSON with gutter + syntax colors), Timeline (vertical bullets
    with connecting line), Decision row (Approve clay-primary, Reject brick-
    danger, Amend secondary, Withdraw ghost-disabled-for-non-creators).
  - **04·a Amend modal** — overlay floating over the dimmed detail pane.
    Side-by-side diff (Original v1 left, Amended v2 right) with add/rem line
    backgrounds. Required Note-to-requester textarea below. Submit/Cancel in
    the footer.
  - State chip color: pending = clay (action-needed), approved = moss,
    rejected = brick, amended = plum. Same mapping used elsewhere.
- **05 Reminders · per-agent recurring prompts** — full-pane operator
  overview of all reminders across agents.
  - **What reminders ACTUALLY are** (don't redesign against the wrong model):
    Recurring prompts that get *pasted into the agent's tmux session* on a
    cadence (e.g. every 10m) until the human or the agent marks them done.
    They are addressed AT the agent — the agent sees
    `[reminder #42 from sammons]: <prompt>`. Per-agent scope. Status is
    `pending | completed` — there is no snooze, no due-at, no time-bucketing.
    `Reminder` type lives at `src/shared/types.ts:250`; the existing per-agent
    UI is `src/dashboard/reminder-panel.ts`.
  - **NO queue concept in the UI.** Even though the data model has
    `sortOrder`, the dashboard treats reminders as **fan-out**: every pending
    reminder fires independently on its own cadence. There is no
    "active vs queued" framing, no `#1/#2/#3` position pills, no Move-up /
    Move-down actions, no "waiting for #1 to complete" language. If a user
    wants multiple nudges on one agent, they add multiple reminders and all
    of them fire. `skipIfActive: bool` is the only delivery-suppression
    mechanism.
  - **Theme discipline** — this screen previously drifted; the fix:
    - **Only TWO clay moments** allowed: the primary "Add" button and the
      "now" bar in the histogram. No clay left-borders, no clay-filled
      badges, no clay text emphasis.
    - **No badge fills** anywhere. Status is a single 7px dot in the left
      gutter (steel = firing, ink-4 = dormant, moss = done).
    - **No decorative borders** — no dashed rules, no quote-block left-
      borders, no card backgrounds on the hero cards. Hero is unboxed,
      just sits on the paper.
    - **No colored chip flags** — skip-if-active is plain italic ink-3
      text inline in the meta row, not a plum-bg pill.
  - **Hero row** — two unboxed columns. Left = "Next delivery" — eyebrow
    line (`Next delivery in 3m · to ci-watcher`), the prompt rendered on
    one line with a leading mono `›` glyph (signals "this is the literal
    paste"), then a single mono meta line. Right = "Deliveries · last 24h"
    — 12-bar histogram of paste counts per 2h window, the `now` bar in
    clay, everything else in steel.
  - **Filter is the sidebar — same as chat.** Reminders inherits the Teams
    checkbox tree as its filter source. No in-page chip row, no orthogonal
    sort/state chips. The page header uses the same `.filter-summary` class
    chat uses (`<where> · X of Y selected · clear filter`), prefixed with a
    small mono "Reminders" eyebrow so the page identity remains legible.
    The list, hero ("Next delivery"), histogram, completed block, and
    footer counts all reflect the active sidebar selection. Empty-filter
    states render an italic ink-3 line with a CLI fallback (no graphic).
  - **Quick-add row** (5-col grid): agent picker (italic when empty) ·
    prompt input · cadence pill (`every 30m ▾`) · skip-if-active checkbox
    (ink fill when on, NOT plum) · Add primary button. Borderless inner
    controls, the outer wrapper has a soft border that strengthens on
    focus-within.
  - **List structure** — grouped by AGENT. Each agent block has a header
    (name + kind label + agent-state pill + meta showing `N reminders ·
    next in Xm`) followed by a flat list of reminders. Each reminder fires
    independently; their relative ordering within an agent is by next-fire
    time (the soonest first).
  - **Row anatomy** (3-col grid): 7px status dot · body (prompt in mono +
    single-line meta `every 10m · last 7m ago · next in 3m · 4 deliveries
    · by sammons · skip if active`) · hover-revealed actions (Mark done,
    Edit, Delete). Dormant rows (agent idle + skip-if-active) get an
    ink-4 dot and explicit "waiting for agent to resume" text.
  - **Completed block** at the bottom — `rm-rem.done` rows at opacity 0.55,
    moss status dot, strikethrough prompt. Surfaces `deliveries-to-done`
    count which is operator-useful (was this a polite nudge or did we
    hammer the agent 38 times?).
  - **Footer**: firing count · dormant count · completed last 7d · median
    deliveries-to-done · "Show N more completed" expand.
  - Nav badge: total pending reminders across all agents (here 9).

- **06 Settings · engine configs, prefs, surfaces, destinations** — full-pane
  config surface. Preserves the FIVE concepts from
  `src/dashboard/settings.ts`: Engine configs, Preferences, Published pages,
  Data stores, Destinations. Pure design redo on top of the existing model
  — no concepts added or dropped.
  - **Layout** is a single scrolling main with a **sticky horizontal sub-nav**
    at the top (chip-row: Engine configs · Preferences · Pages · Data stores
    · Destinations). Anchor-jumps; the active section's chip is filled with
    paper-2.
  - **Tone discipline** (same Greenroom rules as Reminders):
    - Two clay moments only: primary `+ New / Add / Save` buttons.
    - No card backgrounds anywhere. Sections separated by 1px rule-soft
      borders + generous padding. Items inside a section separated by
      hairline rule-soft borders. Hero-card chrome and clay left-borders
      are forbidden.
    - YAML view is a single mono block with `.st-yaml` (paper-2 background)
      and reuses the same syntax-tint vocabulary as the Approvals payload
      viewer (`.gutter` ink-4, `.key` steel, `.str` moss, `.num` clay,
      `.bool` plum, `.punc` ink-3, `.sect` ink-bold for top-level YAML keys).
  - **Engine configs** render as `.st-item` rows: name (mono) + engine kind
    label (color-keyed: claude=steel, codex=plum, opencode=moss) + "default
    for N agents" usage badge on the right + hover-revealed Edit/Delete. A
    `meta` paragraph below the header lists what's set inline: `model · 
    thinking · hooks (named) · indicators (named) · detection · custom 
    buttons · env`. The mock shows THREE states side-by-side:
    1. **expanded read** — meta + full `.st-yaml` block visible
    2. **collapsed** — meta + a small `▸ Show YAML` link
    3. **editing** — meta replaced by `.st-edit` block with cursor-positioned
       YAML and a `⌘S save · esc cancel` hint row; Save/Cancel in the
       hdr actions slot. Editing items always show the action buttons (no
       hover required).
  - **Preferences** uses a `.st-pref` two-column layout: label + sub-label on
    the left (200px), radio/checkbox controls on the right. Radios render as
    a 13px ink-bordered circle with an ink dot when selected; checkboxes
    same but rectangular with a moss check glyph. Saves to localStorage; no
    Save button (saves on change).
  - **Published pages**, **Data stores**, and **Destinations** all reuse the
    same `.st-item` row pattern. Differences: pages have an Open button
    (external link icon) and link the name in steel; stores have an Inspect
    button; destinations have Test/Edit alongside Delete and show an
    enabled/disabled state dot.
  - **New Telegram form** is `.st-addform` — the ONLY card-style block on
    the page (because it's a temporary modal-ish state). Border + radius +
    paper-card bg. Field rows use `110px label · 1fr underlined input`
    grid. Help text below the inputs links to BotFather and the
    getUpdates API. Cancel + Add (primary clay) in the footer.
  - **Empty states** are inline italic ink-3 with mono code refs to the
    relevant CLI command. No empty-state graphics.
  - **No master-detail.** Linear scroll, anchored by the sub-nav.

- **07 Search · global** — full-pane page reached by the sidebar Search
  nav item or by `⌘K` from anywhere. Existing app has a Cmd+K agent
  palette (`src/dashboard/voice-palette.ts`) — v3 keeps the shortcut but
  promotes Search to a peer page (not an overlay) because results span
  five+ types: agents, messages, approvals, reminders, pages.
  - **Signature moment**: the search input itself. Oversized Bricolage
    Grotesque (28px, weight 600), borderless, with just a bottom rule
    that strengthens to ink on focus-within. A small magnifying-glass
    glyph on the left and a `clear · esc` button on the right. No
    pill-style search box — the input IS the page title.
  - **Eyebrow row** above the input: small mono `SEARCH` label · `N
    results · across M types · scope: <agent filter>` · right-aligned
    `⌘K from anywhere` kbd hint.
  - **Scope-by-type chips** below the input bar (All · Agents · Messages
    · Approvals · Reminders · Pages · Settings) — sticky-feel, narrow
    the visible sections. Ink-fill on the active chip (same chip pattern
    as Approvals / Settings sub-nav).
  - **Filter follows sidebar.** Search inherits the same agent filter
    chat/Reminders use — checking/unchecking agents in the sidebar
    narrows the searchable scope. The eyebrow stats line names the
    current scope so it's never ambiguous. Footer carries an explicit
    "Scope follows sidebar — uncheck agents to narrow results." note.
  - **Result sections** are grouped by type, each with a mono section
    header and a `Show all N →` link when truncated. Within a section,
    rows are 3-col: a 5px status dot (color-keyed to type: steel=agent,
    ink-3=message, clay=approval, steel=reminder, plum=page, moss=
    completed) · body · hover-revealed actions.
  - **Row anatomy.** Header line carries the mono name (steel link
    style for clickable refs), a kind label, and a state pill where
    applicable. Body holds the match snippet. For prose content
    (messages, persona text) the snippet is sans paragraph with
    `<mark>` inline. For payload-style content (approvals, reminder
    prompts) the snippet uses `.snippet.quote` — a leading mono `›`
    glyph + mono body, signaling "this is the literal text/payload."
    Meta line below shows match attribution (`matched in name, persona`,
    `matched in channel, payload`, etc.) so the user understands WHY
    something matched.
  - **Mark highlighting.** Single clay moment — the `<mark>` element is
    transparent background, ink text, weight 700, with a 1.5px clay
    bottom-border. Same clay accent rules as elsewhere; one accent per
    match, never bg-fills.
  - **Keyboard footer** at the bottom: `↑↓ navigate · ↵ open · ⌘↵ open
    in new pane · tab scope chip · esc clear/close`. Mirrors the
    existing voice-palette kbd hints.
  - **Selected row treatment** uses a darker paper-2 background only —
    no border or accent rule. The first agent result is preselected when
    a query is typed so `Enter` jumps straight to the most likely match
    (preserving the Cmd+K instant-jump feel within the full page).

- **08 Overlays · modals + popovers** — four overlays in one section so the
  shared `.ov-*` and `.pop` vocabulary stays consistent.
  - Shared modal pattern: `.ov-backdrop` (absolute over the dimmed page,
    18% ink overlay) · `.ov-modal` (paper-card, rule border, radius-lg,
    box-shadow) · `.hdr` (bold sans title + mono sub + `esc` ghost button)
    · `.body` (form rows in `.group`s with mono section headers) · `.foot`
    (left hint with kbd, right Cancel + clay-primary Submit).
  - Field controls are typographic-forward: borderless inputs with a
    bottom rule that strengthens to ink on focus (same as Settings
    `.st-addform`). Labels are mono uppercase ink-4 in a 130px left column.
  - One clay moment per overlay: the primary action button. No clay on
    field accents, no clay borders on the modal, no clay in the kind dot.
  - **08·a + New agent** — 720px wide modal with FIVE groups:
    1. **Kind** — two `.ov-radio-card` blocks (Persistent / Ephemeral
       recipe). The selected card gets an ink dot + paper background.
       Selecting changes which downstream groups are visible.
    2. **Identity** — name (kebab-case), engine config dropdown, model
       override, cwd. Help text under name explains the address derivation.
    3. **Ephemeral recipe** — shown only when kind=ephemeral. cwd_base
       (worktree root), topics (tag-style multi-add), prepare hook, cleanup
       hook (both as `.ov-textarea`).
    4. **Teams** — `.ov-chips` multi-select with counts. Trailing dashed
       `+ New team` button. Help text clarifies teams are UI-only filters.
    5. **Persona body** — full-width `.ov-textarea.body` (180px min) for
       the markdown system prompt.
  - **08·b + New team** — 480px wide modal (`.ov-modal.sm`). Name input +
    member-picker grid (`.ov-member-grid`, 2 cols, mono labels, checkbox
    + kind chip per row). Footer shows live count (`3 selected · 11 more
    available`). Centered backdrop variant (`.ov-backdrop.center`).
  - **08·c Edit persona** — 880px wide modal (`.ov-modal.lg`). Two-column
    `.ov-persona-grid`: left = YAML frontmatter (mono textarea), right =
    markdown body (mono textarea). Each column has a mono label with an
    italic hint. Footer carries a `.secondary-check` toggle "Reload
    persona on save" with an italic warning hint ("replaces the running
    tmux session — drains the active queue first").
  - **08·d Profile popover** — 320px wide `.pop` (NOT a modal; no backdrop,
    no centering). Anchored to a sender-name in chat via a top-left arrow
    nub. Has:
    - Header: mono name (15px, bold) + kind label (steel/plum) + agent
      state pill (moss/clay/ink-4 dot)
    - `.row` strip (top-bordered): Address (mono code) · Teams (small
      paper-2 chips) · Activity (message counts + reminder counts) ·
      Triggered (who + when, for ephemeral instances)
    - `.actions` block (paper-bg, separated from rows by rule-soft):
      Watching (clay-toggled when on), Filter chat to just this, Copy
      address, Open in tmux · divider · Edit persona…, More…
    - Each action has a left icon, a label, and a right-aligned mono
      keyboard hint (`w · f · c · t`)
    - Clay-toggled `Watching` is the single clay use in the popover

## Screens still to design

- *(none — all locked screens designed.)*

## Files in play

- `docs/v3-dashboard-design.html` — the live mock
- `docs/v3-wireframes.md` — earlier ASCII wireframes (background, not authoritative)
- `docs/v3-wireframes.html` — earlier styled wireframes (background)
- `src/dashboard/` — the actual dashboard that will eventually consume this design. Don't
  touch this from the `/design` skill.

## When iterating

- Match scope to the ask. Small tweak → `Edit`. Aesthetic pivot → `Write` the whole file
  (rare — the system is locked in `../ui-theme/REFERENCE.md`).
- After changes, `open docs/v3-dashboard-design.html` so the user can see immediately.
- Don't write a summary of the whole design — just the delta from the previous version.
- If a user request seems to conflict with a locked decision (structural here, aesthetic
  in `../ui-theme/REFERENCE.md`), surface that explicitly before acting.
