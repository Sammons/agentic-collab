# Greenroom — Design System Reference

A typographic-forward, calm, characterful design system. Pale celadon paper, deep ink, sparing
clay accent. One bold typographic moment per surface; aggressive subtraction everywhere else.

The authoritative implementation lives in `docs/v3-dashboard-design.html` — when this document
describes a pattern, the mock contains the working CSS. Copy from the mock; don't reinvent.

---

## 1. Identity

**Name:** Greenroom

**Heritage:** Settled after three rejected directions —
1. Terminal-intense (dark bg + neon + pulsing dots) — *too intense*
2. Anthropic editorial (warm cream + Source Serif + dusty palette) — *too "anthropic"*
3. Cool slate calm (slate + muted teal + Hanken Grotesk) — *bland and still busy*

The final direction: **paper-and-ink primary, one clay accent, characterful sans-display +
mono-data type pairing.** The single typographic-moment-per-surface and aggressive
subtraction are what give it identity — not chrome, not color saturation.

---

## 2. Design tokens

### Palette — paste this `:root` block verbatim into any new stylesheet

```css
:root {
  /* paper — base + variants for nesting */
  --paper:        #ecedea;
  --paper-2:      #e4e5e1;
  --paper-card:   #f6f6f3;
  --paper-hover:  #ecede9;
  --paper-sel:    #d8d9d4;

  /* ink — text/icon ramp from black-ish to nearly invisible */
  --ink:          #16181c;
  --ink-2:        #4a4d52;
  --ink-3:        #797c80;
  --ink-4:        #b3b5b1;

  /* rules — borders/dividers from soft to strong */
  --rule:         #cfd0cb;
  --rule-soft:    #dbdcd7;
  --rule-strong:  #b8b9b3;

  /* accent — single bold color, used ONCE per surface */
  --clay:         #b85a3a;
  --clay-soft:    #b85a3a14;

  /* working colors — secondary identity colors */
  --steel:        #436b85;  /* ephemeral working / addresses / links */
  --steel-soft:   #436b8514;
  --steel-bg:     #d6e0e8;

  --moss:         #67855e;  /* active / done / approved */
  --moss-bg:      #d8e1d2;

  --plum:         #6e5982;  /* persistent / creator / amended */
  --plum-bg:      #d9d2e2;

  --brick:        #94584a;  /* failed / rejected / danger */
  --brick-bg:     #e2cfc9;

  /* typography */
  --sans: 'Bricolage Grotesque', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* radii */
  --radius:    4px;
  --radius-lg: 6px;
}
```

### Typography

**Display sans:** [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) (variable font: `opsz`, `wdth` axes).
**Code/data mono:** [Geist Mono](https://fonts.google.com/specimen/Geist+Mono).

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,200..800&family=Geist+Mono:wght@400..700&display=swap">
```

**Hierarchy:**

| Use                  | Size  | Weight   | Family | Tracking      |
|----------------------|-------|----------|--------|---------------|
| Display moment       | 64px  | 300+700  | sans   | -0.025em      |
| Section/page title   | 28px  | 700      | sans   | -0.025em      |
| Filter-summary title | 22px  | 700      | sans   | -0.02em       |
| h3                   | 18px  | 700      | sans   | -0.02em       |
| Item name (mono)     | 14-15px | 600    | mono   | -0.01em       |
| Body                 | 13-13.5px | 400  | sans   | normal        |
| Meta                 | 11.5px | 400     | mono   | normal        |
| Eyebrow label        | 10.5px | 400-600 | mono   | uppercase 0.1em |

**Numbers are tabular** in stats lines: `font-variant-numeric: tabular-nums;`.

### Spacing

| Use              | Value   |
|------------------|---------|
| Page H padding   | 32px    |
| Page V padding   | 22-28px |
| Section gap V    | 18-32px |
| Card padding     | 14-22px |
| Field row V      | 4-12px  |
| Default gap      | 6-10px  |
| Mono separator   | `<span class="sep">·</span>` w/ `margin: 0 6-7px` |

Always lean toward more whitespace, not less.

### Radius

- `--radius` (4px): inputs, chips, buttons, status pills, small blocks
- `--radius-lg` (6px): cards, modals, popovers, larger blocks
- No fully-rounded pill shapes; no zero-radius hard corners

### Rules (borders)

- `--rule` (`#cfd0cb`): default 1px borders
- `--rule-soft` (`#dbdcd7`): inter-row dividers, subtle separators
- `--rule-strong` (`#b8b9b3`): focus state, edit-mode borders, checkbox/radio outlines
- **Never dashed/dotted** except: (a) `+ Add tag` affordances, (b) sender-name link underline in chat

### Shadows

Used sparingly. Only for floating overlays (modals, popovers, callouts):

```css
/* card */
box-shadow:
  0 1px 0 rgba(22,24,28,0.04),
  0 4px 14px -4px rgba(22,24,28,0.05);

/* modal */
box-shadow: 0 24px 60px -12px rgba(22,24,28,0.22);

/* popover */
box-shadow: 0 16px 40px -10px rgba(22,24,28,0.22);
```

No shadows on flat elements, no inset shadows, no glow.

---

## 3. The Greenroom rule

> **One clay moment per surface.**

`--clay` (`#b85a3a`) is reserved for:

1. **The primary action button** per surface (`+ New / Save / Submit / Create`)
2. **At most one other accent point** — e.g. the "now" bar in a histogram, the toggled state of a single critical control, the underline on `<mark>` highlights in search results

**Forbidden uses of clay:**
- On body text
- As a border on cards
- As a fill on badges
- On multiple visible action buttons
- As a hover state for non-primary buttons

If you find yourself wanting clay in two places, pick the more important one and use ink, steel, or plum for the other.

---

## 4. Form language

- 4-6px corners
- Soft borders (use `--rule-soft` between rows, `--rule` for default borders)
- **Zero ambient motion.** No pulsing dots, no scanning bars, no ticker tape, no animated indicators. The composer caret blink and an initial page-load fade are the only allowed motion.
- All explicit transitions ≤200ms (typically 140-150ms)
- No serif typefaces anywhere — Bricolage Grotesque for everything, Geist Mono for code/data

---

## 5. Voice & copy

- **Plain and functional.** Not editorial, not breezy.
- **System events lead with the actor verb-first**: `gitea-lead triggered a7c2b1…3f`, not `a7c2b1…3f started · gitea-lead`.
- **Message heads** read `<from> → <to>` with the recipient dim, sender in identity color.
- **Section labels are short**: `Agents`, `Components`, `Implementation`.
- **Help text** is italic ink-3 prose with `<code>` references in mono.
- **Empty states** are italic ink-3 prose with CLI fallback in mono — never illustrated graphics.
- **Address / hash conventions:** ephemeral instance hashes show as `a7c2b1…3f` (8 chars + ellipsis + 2 chars). Persistent agents addressed as `agent:<name>`. Approval hashes as `a3f1…8b` (4 + ellipsis + 2).
- **Terminology:** `trigger` (not `spawn`) for starting an ephemeral run. `Watch` for following an agent's tmux. `Approval` (not "request") for the human gate.

---

## 6. Component patterns

The mock uses CSS class prefixes per surface to avoid collisions. Use this convention for new surfaces too.

| Prefix    | Surface                          |
|-----------|----------------------------------|
| `.pg-*`   | Agents page (rows, headers)      |
| `.ap-*`   | Approvals (master-detail)        |
| `.rm-*`   | Reminders                        |
| `.sr-*`   | Search                           |
| `.st-*`   | Settings                         |
| `.watch-*`| Watch (live tmux pane)           |
| `.ov-*`   | Overlay modals (shared)          |
| `.pop`    | Profile popover (no prefix needed; unique) |

### 6.1 Sidebar (left rail)

- ~220px fixed width
- Top: `.nav-actions` with Agents · Search · Approvals · Reminders (with optional `.badge`)
- Middle: `.nav-section-label` ("Teams") + `.teams` tree
- Tree: `.all-toggle` (tri-state checkbox: `.checked`, `.indeterminate`, none) + `.team` (with `.open` and `.selected` states) + `.member` (with `.checked` and `.watching` states) — each member has a clickable eye icon for Watch
- Bottom: `.nav-bottom` with Settings nav action

### 6.2 Page header — three variants

1. **Plain page** — `<h1>` title (28px sans/700) + `.pg-stats` (mono) + lede + right action buttons.
2. **Filter-summary** (used on chat, Reminders) — small mono eyebrow above + `.filter-summary` (22px sans/700 with `<span class="where">`, `<span class="sub">`, `<span class="clear">`).
3. **Search input** — eyebrow + giant 28px sans input, borderless underline that strengthens to ink on focus.

### 6.3 Filter chips

```css
.chip {
  font-family: var(--mono);
  font-size: 11.5px;
  background: transparent;
  border: 1px solid var(--rule-soft);
  color: var(--ink-3);
  padding: 4px 10px;
  border-radius: 3px;
}
.chip.on {
  background: var(--ink);
  color: var(--paper-card);
  border-color: var(--ink);
}
```

Counts as `<span class="ct">N</span>` — 10.5px ink-4, or `#fdf6f3aa` on active chips.

### 6.4 List rows

- `border-top: 1px solid var(--rule-soft)` between rows
- First row: no top border
- Hover: `background: var(--paper-2)` (subtle)
- Hover-revealed actions: `opacity: 0` → `opacity: 1` with 150ms transition on `.row:hover .actions`
- Always-visible status indicator dot (5-7px, color-keyed; see §8)

### 6.5 YAML / payload syntax tints

Used in approvals payload, settings engine configs, edit-persona modal.

```css
.gutter { color: var(--ink-4); }        /* line numbers */
.key    { color: var(--steel); }        /* object keys */
.str    { color: var(--moss); }         /* strings */
.num    { color: var(--clay); }         /* numbers */
.bool   { color: var(--plum); }         /* booleans */
.punc   { color: var(--ink-3); }        /* punctuation */
.sect   { color: var(--ink); font-weight: 600; } /* YAML section heads */
.comment{ color: var(--ink-4); font-style: italic; }
```

Note `.num` uses clay — this is the ONE permitted clay use in a syntax tint, because it
serves as a numeric emphasis that reads as a single accent. Don't add clay to other tint classes.

### 6.6 Modal overlay (`.ov-*`)

- `.ov-backdrop` — `position: absolute; inset: 0; background: rgba(22,24,28,0.18);` (18% ink overlay, not 50% — keep it light so context behind is still readable)
- `.ov-modal` — paper-card bg, `--rule` border, `--radius-lg`, box-shadow (modal preset above)
- Size variants: default 720px, `.ov-modal.sm` 480px, `.ov-modal.lg` 880px
- `.hdr` (bold sans title + mono sub + `esc` ghost button) · `.body` (form rows in `.group`s with mono section headers) · `.foot` (left hint with kbd, right Cancel + clay-primary Submit)
- Form fields: borderless inputs with bottom-rule that strengthens to ink on focus
- Labels: mono uppercase ink-4 in a 130px left column
- Sub-pattern for `.ov-radio-card`, `.ov-chips`, `.ov-tags`, `.ov-member-grid`, `.ov-persona-grid` — see mock

### 6.7 Popover (`.pop`)

- 320px wide, NOT a modal (no backdrop, no centering)
- Anchored to a click point via a top-left arrow nub: `.pop::after`
- Header: mono name + kind label + state pill
- `.row` strips (separated by `--rule-soft`): Address (mono code), Teams (paper-2 chips), Activity, Triggered
- `.actions` block (paper bg, separated by rule-soft): each `.item` has icon + label + right-aligned mono kbd hint
- Allowed clay moment: a single `.item.toggled` (e.g., `Watching`) where icon + label go clay

### 6.8 Master-detail (used only by Approvals)

- 340px master / fluid detail grid inside the main pane
- Master: title with counts, chip rows, grouped list with sticky pending at top
- Detail: crumb, large hash + state pill, metadata row, structured sections (Payload, Timeline, Decision)
- Reserved for sequential-review workflows; don't use for browsing

### 6.9 Hero card (used by Reminders' "Next delivery")

- Two-column: 1fr + 360px, both **unboxed** (no border, no background)
- Left: eyebrow line + prompt with leading mono `›` glyph + mono meta row
- Right: 12-column bar histogram, `now` bar in clay

### 6.10 Mark highlighting (Search)

```css
mark {
  background: transparent;
  color: var(--ink);
  font-weight: 700;
  border-bottom: 1.5px solid var(--clay);
  padding: 0;
}
```

Single clay moment, used purposefully. Never a clay text fill or clay background tint.

---

## 7. Buttons

Three variants:

```css
/* default */
.btn {
  background: transparent;
  border: 1px solid var(--rule);
  color: var(--ink-2);
  padding: 5px 12px;
  border-radius: 3px;
  font-size: 13px;
}
.btn:hover { background: var(--paper-2); color: var(--ink); border-color: var(--rule-strong); }

/* primary — clay, used sparingly */
.btn.primary {
  background: var(--clay);
  color: var(--paper-card);
  border-color: var(--clay);
}
.btn.primary:hover { background: #a14d31; border-color: #a14d31; }

/* danger — outlined */
.btn.danger { color: var(--brick); border-color: var(--rule); }
.btn.danger:hover { background: var(--brick-bg); border-color: var(--brick); }

/* ghost — text-only */
.btn.ghost { background: transparent; border-color: transparent; color: var(--ink-3); }
.btn.ghost:hover { color: var(--ink); background: var(--paper-hover); }
```

---

## 8. Status semantics

Color → meaning mapping (consistent across all surfaces):

| Color  | Meaning(s)                                              |
|--------|---------------------------------------------------------|
| moss   | active · done · approved · success                      |
| clay   | running · pending · urgent · primary-action · "now"     |
| steel  | ephemeral kind · firing reminder · addresses · links    |
| plum   | persistent kind · creator (who) · amended state         |
| brick  | failed · rejected · danger · destructive-on-hover       |
| ink-4  | idle · dormant · disabled · placeholder · completed-secondary |

Status indicators are **always small colored dots** (5-7px circles), never filled badges
or rounded pills. Use the bg variants (`--moss-bg`, etc.) only for inline highlights like
diff add/rem lines or `<mark>` background-tint where strictly necessary.

---

## 9. Anti-patterns

### 9.1 Aesthetic directions rejected — do not regress

1. **Terminal intensity** (dark bg, neon green, pulsing dots, ticker tape, grid background) — rejected as "too intense"
2. **Warm Anthropic-editorial** (cream paper, Source Serif headings, Inter Tight, dusty blue + sage + terra palette) — rejected as "too 'anthropic'"
3. **Cool slate calm** (cool stone bg, muted teal accent, all-sans Hanken Grotesk) — rejected as "bland and yet still too much going on"

### 9.2 Compositional anti-patterns

- **Multiple clay moments on one surface.** One per page, max two if the second is small and purposeful.
- **Card backgrounds on row-list pages.** Use rule-soft borders + hover-paper-2 instead of stacked `.card` blocks.
- **Decorative borders.** No dashed, no dotted, except: tag-add affordances and sender-link underlines.
- **Avatars on agent messages.** Use a 3px left identity-color border on the message body + name in identity color.
- **Heavy chrome on form fields.** Use borderless inputs with a bottom rule (not boxes).
- **Filled badges for status.** Use a colored dot + text instead.
- **Multiple decorative typography effects on one surface.** Pick one display moment per page.

### 9.3 Architectural anti-patterns (specific to this codebase)

These were redirected during v3 design — do not reintroduce:

- **Per-agent thread tabs.** Chat is always a **merged stream filtered by the sidebar checkboxes**. Selection is a FILTER, never navigation.
- **A separate "Templates" tab.** Ephemeral recipes and persistent agents live in **one unified Agents list**. Ephemeral status shows as a kind column.
- **A queue concept in Reminders UI.** Reminders **fan out** — each pending reminder fires on its own cadence, independently. No "active vs queued" framing, no position pills, no Move-up/Move-down.
- **Snooze on reminders.** Reminders only have `pending | completed` + `skipIfActive` boolean. No time-based snooze, no due-at.
- **In-page agent filter chips on pages other than Agents.** The **sidebar Teams tree is the filter** for chat, Reminders, and Search. Other pages don't duplicate it.

---

## 10. Per-surface design locks (v3 dashboard)

See `../design/REFERENCE.md` for the screen-by-screen design decisions (Dashboard / Agents / Watch / Approvals + Amend / Reminders / Settings / Search / Overlays). That file is the per-screen companion to this systemic reference.

---

## 11. Implementation conventions

- **Single HTML file with embedded CSS** for the design mock (no JS framework, no build step). This is a constraint of `docs/v3-dashboard-design.html`, not necessarily of production code.
- **Google Fonts via `<link>`** for typography. Bricolage Grotesque + Geist Mono.
- **Status dots are CSS circles, not SVG icons.** `width:5-7px; height:5-7px; border-radius:50%; background: <token>;`
- **Hover-action pattern:** `opacity: 0; transition: opacity 150ms ease;` → `.row:hover .actions { opacity: 1; }`
- **No emoji as icons.** Use small inline SVG (12-14px) with `stroke="currentColor"` so color inherits.
- **SVG icons in the mock:** stroke-based, 1.5-1.6 stroke-width, rounded line caps/joins. Match Lucide / Feather visual weight.

---

## 12. Reference files

- `docs/v3-dashboard-design.html` — **the authoritative live mock** (~6000 lines, single HTML file). When in doubt, look here.
- `../design/REFERENCE.md` — per-screen design decisions for the v3 mock
- `../design/SKILL.md` — the `/design` skill that iterates the mock
- `docs/v3-wireframes.md` and `docs/v3-wireframes.html` — earlier ASCII / styled wireframes (background only, not authoritative)

---

## 13. Quick lookups

**"What color should X be?"**
→ §8 Status semantics. Match by meaning, not by reuse.

**"How big should the input be?"**
→ §2 Typography. Most inputs are 13px mono with a bottom rule. The Search page input is 28px sans (signature moment).

**"Can I add a Save button next to the primary?"**
→ §3 The Greenroom rule. Only one clay primary per surface. Make one of them a ghost or default-style button.

**"How do I represent a status?"**
→ §8 + §6.4. Small colored dot inline. Never a filled badge.

**"Where do filter controls go on a new page?"**
→ §9.3. If the filter is by agent, use the sidebar Teams tree (same as chat). Don't duplicate it as in-page chips.

**"What font should I use?"**
→ §2. Bricolage Grotesque for everything textual, Geist Mono for code/data/addresses/hashes/numbers in stats lines.

**"Can I use a dashed border for a 'draft' state?"**
→ §4 + §9.2. No. Use a soft border + an italic ink-3 label.
