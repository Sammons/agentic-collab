/**
 * v3 sidebar — nav actions on top + Teams checkbox tree + Settings on bottom.
 *
 * Plain function (not a custom element — keeps PR 1 minimal). Renders into
 * the #sidebar mount on init and on every relevant state change.
 *
 * Filter model: each agent name in `state.selectedAgents` is "on". The
 * sidebar exposes three toggles:
 *   - All-agents (master): tri-state checkbox
 *   - Team row: toggles every member of the team
 *   - Member row: toggles that one agent
 *
 * Selection is purely a filter signal; it never navigates. Nav actions and
 * the Watch eye icon DO navigate (via routing.ts).
 */
import { state, on, toggleAgentSelected, toggleTeam, toggleAllAgents, agentsByName, enterFocusMode } from './state.ts';
import { go } from './routing.ts';
import { openNewTeamModal, openEditTeamModal } from './overlays.ts';
import type { Team } from '../shared/types.ts';
import { escapeHtml } from './util.ts';

const root = (): HTMLElement => document.getElementById('sidebar')!;

/** Icon SVG strings — keyed by name. */
const icons: Record<string, string> = {
  chat:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1V4z"/></svg>`,
  brain:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>`,
  search:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><line x1="14" y1="14" x2="10.5" y2="10.5"/></svg>`,
  approvals: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3.5L13 5"/></svg>`,
  clock:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4 8 8 10.5 9.5"/></svg>`,
  gear:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M14.36 5.64l-1.41 1.41M3.05 12.95l-1.41 1.41M15 8h-2M3 8H1M14.36 10.36l-1.41-1.41M3.05 3.05l-1.41-1.41"/></svg>`,
  chev:      `<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M2 3 L8 3 L5 7 z"/></svg>`,
  folder:    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/></svg>`,
  eye:       `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
  focus:     `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><line x1="14" y1="14" x2="10" y2="10"/></svg>`,
  edit:      `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z"/></svg>`,
};

/** Track expanded teams locally — sidebar state, not app state. */
const openTeams = new Set<number>();

/**
 * Expand every team that contains `agentName` so the agent is visible in
 * the sidebar tree without the user having to click a chevron. Called
 * after @-mention autocompletion. Triggers a render via the same
 * selection-changed event the sidebar already listens to.
 */
export function ensureAgentVisible(agentName: string): void {
  let changed = false;
  for (const team of state.teams) {
    if (team.members.includes(agentName) && !openTeams.has(team.id)) {
      openTeams.add(team.id);
      changed = true;
    }
  }
  if (changed) render();
}

// Debounce sidebar renders to avoid thrashing on rapid agent_update events.
// Health monitor updates can fire many agent_update messages in quick succession.
let sidebarRenderTimer: ReturnType<typeof setTimeout> | null = null;
const SIDEBAR_DEBOUNCE_MS = 100;

function scheduleRender(): void {
  if (sidebarRenderTimer !== null) return;
  sidebarRenderTimer = setTimeout(() => {
    sidebarRenderTimer = null;
    render();
  }, SIDEBAR_DEBOUNCE_MS);
}

export function setupSidebar(): void {
  on('init', render); // init renders immediately
  on('agents-changed', scheduleRender);
  on('teams-changed', scheduleRender);
  on('selection-changed', render); // selection changes render immediately for responsiveness
  on('route-changed', render); // route changes render immediately
  render();
}

function render(): void {
  const r = root();
  if (state.connected === 'connecting' && state.agents.length === 0) {
    r.innerHTML = `<div class="sidebar-inner"><div class="sidebar-loading">Connecting…</div></div>`;
    return;
  }

  // Preserve the teams-tree scroll position across re-renders. Every click
  // that toggles selection / expands a team triggers a full innerHTML
  // rewrite, which would otherwise snap the scroll back to 0 mid-interaction.
  const prevScroll = r.querySelector<HTMLElement>('.teams')?.scrollTop ?? 0;

  r.innerHTML = `
    <div class="sidebar-inner">
      ${navActionsHtml()}
      ${navSectionLabelHtml()}
      ${teamsTreeHtml()}
      ${navBottomHtml()}
    </div>
  `;
  wire(r);

  const teams = r.querySelector<HTMLElement>('.teams');
  if (teams && prevScroll > 0) teams.scrollTop = prevScroll;
}

function navActionsHtml(): string {
  const active = (kind: string) => (state.route.kind === kind ? 'active' : '');
  // TODO PR 5/6: real approvals + reminders pending counts.
  return `
    <div class="nav-actions">
      <button class="nav-action ${active('dashboard')}" data-go="dashboard">
        <span class="ico">${icons['chat']}</span>
        <span class="label">Chat</span>
      </button>
      <button class="nav-action ${active('agents')}" data-go="agents">
        <span class="ico">${icons['brain']}</span>
        <span class="label">Agents</span>
      </button>
      <button class="nav-action ${active('search')}" data-go="search">
        <span class="ico">${icons['search']}</span>
        <span class="label">Search</span>
      </button>
      <button class="nav-action ${active('approvals')}" data-go="approvals">
        <span class="ico">${icons['approvals']}</span>
        <span class="label">Approvals</span>
      </button>
      <button class="nav-action ${active('reminders')}" data-go="reminders">
        <span class="ico">${icons['clock']}</span>
        <span class="label">Reminders</span>
      </button>
    </div>
  `;
}

function navSectionLabelHtml(): string {
  return `
    <div class="nav-section-label">
      Teams
      <span class="ct">${state.teams.length}</span>
    </div>
  `;
}

function teamsTreeHtml(): string {
  const total = state.agents.length;
  const selected = state.selectedAgents.size;
  let allClass = '';
  let allCount = `${total}`;
  if (selected === 0) {
    allClass = '';
    allCount = `${total}`;
  } else if (selected === total) {
    allClass = 'checked';
    allCount = `${total}`;
  } else {
    allClass = 'indeterminate';
    allCount = `${selected} / ${total}`;
  }

  const teamsHtml = state.teams.map((t) => teamHtml(t)).join('');

  // Synthetic "no team" group — agents not in any team still need to be
  // visible & checkable. Rendered as a non-deletable team-like row using
  // a virtual id of -1 (won't collide with real DB ids).
  const claimed = new Set<string>();
  for (const t of state.teams) for (const m of t.members) claimed.add(m);
  const orphans = state.agents.map((a) => a.name).filter((n) => !claimed.has(n));
  const noTeamHtml = orphans.length > 0 ? noTeamGroupHtml(orphans) : '';

  return `
    <div class="teams">
      <div class="all-toggle ${allClass}" data-toggle-all>
        <span class="check"></span>
        <span class="nm">All agents</span>
        <span class="ct">${allCount}</span>
      </div>
      ${teamsHtml}
      ${noTeamHtml}
      <div class="nav-newteam" data-new-team>
        <span class="plus">+</span>
        <span>New team</span>
      </div>
    </div>
  `;
}

function noTeamGroupHtml(orphans: string[]): string {
  const VIRTUAL_ID = -1;
  const open = openTeams.has(VIRTUAL_ID);
  const selectedCount = orphans.filter((n) => state.selectedAgents.has(n)).length;
  const isSelected = selectedCount > 0;
  const klass = `team ${open ? 'open' : ''} ${isSelected ? 'selected' : ''}`.trim();

  const membersHtml = orphans.map((n) => memberHtml(n)).join('');

  return `
    <div class="${klass} no-team" data-team-id="${VIRTUAL_ID}">
      <div class="team-row" data-team-toggle>
        <span class="chev" data-team-chev="${VIRTUAL_ID}">${icons['chev']}</span>
        <span class="folder">${icons['folder']}</span>
        <span class="name">no team</span>
        <span class="ct">${orphans.length}</span>
      </div>
      <div class="team-members">${membersHtml}</div>
    </div>
  `;
}

function teamHtml(team: Team): string {
  const open = openTeams.has(team.id);
  // Silently drop members that don't match a registered agent — the team
  // record can hold wishful-thinking references (pre-create the team before
  // agents land) but the sidebar only renders the actual roster.
  const knownAgentNames = new Set(state.agents.map((a) => a.name));
  const realMembers = team.members.filter((m) => knownAgentNames.has(m));
  const selectedInTeam = realMembers.filter((m) => state.selectedAgents.has(m)).length;
  const isSelected = selectedInTeam > 0;
  const klass = `team ${open ? 'open' : ''} ${isSelected ? 'selected' : ''}`.trim();

  const membersHtml = realMembers.map((agentName) => memberHtml(agentName)).join('');

  return `
    <div class="${klass}" data-team-id="${team.id}">
      <div class="team-row" data-team-toggle>
        <span class="chev" data-team-chev="${team.id}">${icons['chev']}</span>
        <span class="folder">${icons['folder']}</span>
        <span class="name">${escapeHtml(team.name)}</span>
        <span class="ct">${realMembers.length}</span>
        <span class="team-edit" data-team-edit="${team.id}" title="Edit team — add/remove agents, rename, delete">${icons['edit']}</span>
      </div>
      <div class="team-members">${membersHtml}</div>
    </div>
  `;
}

function memberHtml(agentName: string): string {
  // Caller (teamHtml) has already filtered orphans, so `agent` is guaranteed.
  const checked = state.selectedAgents.has(agentName) ? 'checked' : '';
  const agent = agentsByName.get(agentName)!;
  const isTemplate = agent.isTemplate ?? false;
  const status = isTemplate ? 'template' : statusClass(agent.state);
  const stateTip = isTemplate
    ? `${agentName} — template (messaging spawns new agent)`
    : `${agentName} — ${agent.state}`;
  // Template styling is handled via .member.is-template .nm in CSS.
  // Selection is an IDE-file-nav-style highlighted row (`.member.checked`),
  // not a checkbox — see sidebar.css. The .status dot still conveys liveness.
  const iconHtml = agent.icon ? `<span class="agent-icon">${escapeHtml(agent.icon)}</span>` : '';
  return `
    <div class="member ${checked}${isTemplate ? ' is-template' : ''}" data-member="${escapeHtml(agentName)}">
      <span class="status ${status}" title="${escapeHtml(stateTip)}">${isTemplate ? '+' : ''}</span>
      ${iconHtml}
      <span class="nm">${escapeHtml(agentName)}</span>
      <span class="focus" data-focus="${escapeHtml(agentName)}" title="Focus on ${escapeHtml(agentName)}">${icons['focus']}</span>
      <span class="eye" data-eye="${escapeHtml(agentName)}" title="Watch ${escapeHtml(agentName)}">${icons['eye']}</span>
    </div>
  `;
}

/**
 * Map an AgentState (or undefined) to a single online/offline-style class.
 *  - online (moss):  active, idle — alive and reachable
 *  - busy   (clay):  spawning, resuming, suspending — in transition
 *  - paused (plum):  suspended — paused on purpose
 *  - failed (brick): failed — broken, needs attention
 *  - offline (grey): void or missing — never started / not in registry
 */
function statusClass(state: string | undefined): string {
  switch (state) {
    case 'active':
    case 'idle':       return 'online';
    case 'spawning':
    case 'resuming':
    case 'suspending': return 'busy';
    // suspended + failed → same "down" indicator
    case 'suspended':
    case 'failed':     return 'failed';
    default:           return 'offline';
  }
}

function navBottomHtml(): string {
  const active = state.route.kind === 'settings' ? 'active' : '';
  return `
    <div class="nav-bottom">
      <button class="nav-action ${active}" data-go="settings">
        <span class="ico">${icons['gear']}</span>
        <span class="label">Settings</span>
      </button>
    </div>
  `;
}

function wire(r: HTMLElement): void {
  // Nav actions
  r.querySelectorAll<HTMLElement>('[data-go]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = el.dataset['go']!;
      switch (kind) {
        case 'dashboard': go({ kind: 'dashboard' }); break;
        case 'agents':    go({ kind: 'agents' }); break;
        case 'search':    go({ kind: 'search' }); break;
        case 'approvals': go({ kind: 'approvals' }); break;
        case 'reminders': go({ kind: 'reminders' }); break;
        case 'settings':  go({ kind: 'settings' }); break;
      }
    });
  });

  // All-agents master toggle
  r.querySelector<HTMLElement>('[data-toggle-all]')?.addEventListener('click', toggleAllAgents);

  // Team row: chevron toggles open; name area toggles team membership.
  // The virtual "no team" group has id === -1; chev still works, but the
  // row's name-area click toggles the orphan agents as a group.
  r.querySelectorAll<HTMLElement>('[data-team-id]').forEach((teamEl) => {
    const teamId = Number(teamEl.dataset['teamId']);
    const isVirtual = teamId === -1;
    const team = isVirtual ? null : state.teams.find((t) => t.id === teamId);
    if (!isVirtual && !team) return;

    const chev = teamEl.querySelector<HTMLElement>('[data-team-chev]');
    chev?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openTeams.has(teamId)) openTeams.delete(teamId);
      else openTeams.add(teamId);
      render();
    });

    // Pencil edit icon (real teams only) — opens the edit-team modal so
    // the user can add/remove agents, rename, or delete the team.
    if (!isVirtual && team) {
      const edit = teamEl.querySelector<HTMLElement>('[data-team-edit]');
      edit?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditTeamModal(team);
      });
    }

    const row = teamEl.querySelector<HTMLElement>('[data-team-toggle]');
    row?.addEventListener('click', (e) => {
      // Skip if the user clicked the chev or pencil (handled above).
      const t = e.target as HTMLElement;
      if (t.closest('[data-team-chev]') || t.closest('[data-team-edit]')) return;
      if (isVirtual) {
        // Toggle the orphan agents as a group.
        const claimed = new Set<string>();
        for (const t of state.teams) for (const m of t.members) claimed.add(m);
        const orphans = state.agents.map((a) => a.name).filter((n) => !claimed.has(n));
        const synthetic: Team = { id: -1, name: 'no team', members: orphans, createdAt: '' };
        toggleTeam(synthetic);
      } else if (team) {
        toggleTeam(team);
      }
    });
  });

  // Member-row click handler. Selection is shown as an IDE-file-nav-style
  // highlighted row (no checkbox affordance); the whole row is the toggle
  // target.
  //
  //   eye / focus icon → handled by separate listeners below (no toggle)
  //   composer empty / only @mentions+#topics
  //                    → inject "@<agent> " into the composer + focus, and
  //                      ensure the agent is selected. Saves re-typing the
  //                      mention just confirmed in the sidebar.
  //   anywhere else    → toggle selection (multi-select drives chat filter)
  //
  // Off-dashboard: any non-eye/focus tap replaces the selection with this
  // agent and routes to chat.
  r.querySelectorAll<HTMLElement>('[data-member]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-eye]') || target.closest('[data-focus]')) return;
      const name = el.dataset['member']!;

      if (state.route.kind !== 'dashboard') {
        state.selectedAgents.clear();
        state.selectedAgents.add(name);
        import('./state.ts').then((s) => s.emit('selection-changed'));
        go({ kind: 'dashboard' });
        return;
      }

      // On dashboard:
      const composer = document.querySelector<HTMLTextAreaElement>('[data-composer-input]');

      // Smart @mention injection:
      // - If composer is empty → inject @agent
      // - If composer has only @mentions and #topics (no message body) → replace @agent, keep topics
      // - Otherwise → toggle selection as usual
      if (composer) {
        const value = composer.value.trim();
        // Check if value is empty or only contains @mentions and optional #topics (no actual message)
        const onlyPrefixes = value === '' || /^([@#][a-zA-Z0-9_\-/]+\s*)+$/.test(value);
        if (onlyPrefixes) {
          // Extract any #topics from the current value to preserve them
          const topics = value.match(/#[a-zA-Z0-9_\-]+/g) || [];
          const topicSuffix = topics.length > 0 ? ' ' + topics.join(' ') + ' ' : '';
          composer.value = `@${name}${topicSuffix || ' '}`;
          composer.focus();
          composer.setSelectionRange(composer.value.length, composer.value.length);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          // Also select the agent in the sidebar if not already
          if (!state.selectedAgents.has(name)) {
            state.selectedAgents.add(name);
            import('./state.ts').then((s) => s.emit('selection-changed'));
          }
          return;
        }
      }

      // Default: toggle selection.
      toggleAgentSelected(name);
    });
  });

  // Focus icon → enter focus mode for this agent and go to dashboard
  r.querySelectorAll<HTMLElement>('[data-focus]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset['focus']!;
      enterFocusMode([name]);
      go({ kind: 'dashboard' });
    });
  });

  // Eye icon → Watch route
  r.querySelectorAll<HTMLElement>('[data-eye]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset['eye']!;
      go({ kind: 'watch', agentName: name });
    });
  });

  // New team — opens the overlay modal.
  r.querySelector<HTMLElement>('[data-new-team]')?.addEventListener('click', () => {
    openNewTeamModal();
  });
}

