/**
 * Agents page — flat list of all agents.
 *
 * Sorted by state priority: failed → spawning/resuming/suspending → active
 * → suspended → idle → void. Clicking a row navigates to Watch. The
 * always-visible action buttons are: Watch (eye), Edit (pencil), More (⋯).
 *
 * The More menu wraps the existing lifecycle endpoints
 * (/api/agents/:name/spawn|kill|destroy|reload|etc.). Edit persona is a
 * placeholder until PR 9 ships the persona modal — for now it prompts a
 * link.
 */
import type { AgentRecord, AgentState, Team } from '../shared/types.ts';
import { state, on, authHeaders, emit } from './state.ts';
import { registerRoute, go } from './routing.ts';
import { openNewAgentModal, openEditPersonaModal } from './overlays.ts';

const STATE_PRIORITY: Record<AgentState, number> = {
  failed:     0,
  spawning:   1,
  resuming:   1,
  suspending: 1,
  active:     2,
  idle:       3,
  suspended:  4,
  void:       5,
};

type Filter = 'all' | 'running' | 'failed' | 'no-team';
let activeFilter: Filter = 'all';

export function setupAgents(): void {
  registerRoute('agents', render);
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="ag-pane">
      <div class="pg-hdr">
        <div>
          <h1 class="pg-title">Agents</h1>
          <div class="pg-stats" data-stats></div>
        </div>
        <div class="right">
          <button class="btn" data-reload-all>↻ Reload all</button>
          <button class="btn primary" data-new-agent>+ New agent</button>
        </div>
      </div>
      <div class="pg-chips" data-chips></div>
      <div class="pg-list" data-list></div>
    </div>
  `;

  rerender();

  detachers.push(on('agents-changed', rerender));
  detachers.push(on('teams-changed', rerender));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'agents') teardown();
  }));
}

const detachers: Array<() => void> = [];
function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
  closeMenu();
}

function rerender(): void {
  const root = document.querySelector<HTMLElement>('.ag-pane');
  if (!root) return;

  const stats = root.querySelector<HTMLElement>('[data-stats]');
  if (stats) stats.innerHTML = statsHtml();

  const chips = root.querySelector<HTMLElement>('[data-chips]');
  if (chips) {
    chips.innerHTML = chipsHtml();
    chips.querySelectorAll<HTMLElement>('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        activeFilter = (el.dataset['filter'] as Filter) ?? 'all';
        rerender();
      });
    });
  }

  const list = root.querySelector<HTMLElement>('[data-list]');
  if (list) {
    const sorted = sortedAgents();
    if (sorted.length === 0) {
      list.innerHTML = `<div class="pg-empty">No agents match this filter.</div>`;
    } else {
      list.innerHTML = sorted.map((a) => rowHtml(a)).join('');
      list.querySelectorAll<HTMLElement>('.pg-row').forEach((rowEl) => wireRow(rowEl));
    }
  }

  root.querySelector<HTMLElement>('[data-new-agent]')?.addEventListener('click', () => {
    openNewAgentModal();
  });
  root.querySelector<HTMLElement>('[data-reload-all]')?.addEventListener('click', reloadAll);
}

/* ── stats + chips ─────────────────────────────────────────────────── */

function statsHtml(): string {
  const all = state.agents;
  const running = all.filter((a) => a.state === 'active' || a.state === 'spawning' || a.state === 'resuming').length;
  const failed = all.filter((a) => a.state === 'failed').length;
  return `
    <span class="num">${all.length}</span> total
    <span class="sep">·</span>
    <span class="running">${running} running</span>
    ${failed > 0 ? `<span class="sep">·</span><span class="urgent">${failed} failed</span>` : ''}
  `;
}

function chipsHtml(): string {
  const all = state.agents;
  const running = all.filter((a) => a.state === 'active').length;
  const failed = all.filter((a) => a.state === 'failed').length;
  const noTeam = all.filter((a) => agentTeams(a.name).length === 0).length;
  return `
    <span class="chip ${activeFilter === 'all' ? 'on' : ''}" data-filter="all">All <span class="ct">${all.length}</span></span>
    <span class="chip ${activeFilter === 'running' ? 'on' : ''}" data-filter="running">Running <span class="ct">${running}</span></span>
    <span class="chip ${activeFilter === 'failed' ? 'on' : ''}" data-filter="failed">Failed <span class="ct">${failed}</span></span>
    <span class="chip ${activeFilter === 'no-team' ? 'on' : ''}" data-filter="no-team">No team <span class="ct">${noTeam}</span></span>
  `;
}

/* ── rows ──────────────────────────────────────────────────────────── */

function sortedAgents(): AgentRecord[] {
  let list = state.agents.slice();
  switch (activeFilter) {
    case 'running': list = list.filter((a) => a.state === 'active'); break;
    case 'failed':  list = list.filter((a) => a.state === 'failed'); break;
    case 'no-team': list = list.filter((a) => agentTeams(a.name).length === 0); break;
  }
  list.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] ?? 99;
    const pb = STATE_PRIORITY[b.state] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
  return list;
}

function rowHtml(a: AgentRecord): string {
  const failed = a.state === 'failed';
  const teams = agentTeams(a.name);
  const teamsHtml = teams.length
    ? teams.map((t) => `<span class="t-chip">${escapeHtml(t.name)}</span>`).join('')
    : `<span class="none">no team</span>`;

  return `
    <div class="pg-row ${failed ? 'failed-row' : ''}" data-agent="${escapeHtml(a.name)}">
      <span class="nm">${escapeHtml(a.name)}</span>
      <span class="kind per">persistent</span>
      <span class="teams">${teamsHtml}</span>
      <span class="state ${a.state}"><span class="dot"></span>${a.state}</span>
      <span class="actions">
        <button title="Watch" data-act="watch">${icons.eye}</button>
        <button title="Edit persona" data-act="edit">${icons.edit}</button>
        <button title="More" data-act="more">${icons.dots}</button>
      </span>
    </div>
  `;
}

function agentTeams(agentName: string): Team[] {
  return state.teams.filter((t) => t.members.includes(agentName));
}

/* ── row wiring ────────────────────────────────────────────────────── */

function wireRow(rowEl: HTMLElement): void {
  const name = rowEl.dataset['agent']!;
  rowEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    go({ kind: 'watch', agentName: name });
  });
  rowEl.querySelectorAll<HTMLElement>('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset['act']!;
      if (act === 'watch') return go({ kind: 'watch', agentName: name });
      if (act === 'edit')  return void openEditPersonaModal(name);
      if (act === 'more')  return openMenu(btn, name);
    });
  });
}

/* ── More menu ─────────────────────────────────────────────────────── */

let activeMenu: HTMLElement | null = null;
function openMenu(anchor: HTMLElement, agentName: string): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.innerHTML = `
    <div class="item primary" data-mi="spawn"><span class="ico">${icons.play}</span><span>Spawn</span></div>
    <div class="item" data-mi="kill"><span class="ico">${icons.stop}</span><span>Kill</span></div>
    <div class="item" data-mi="watch"><span class="ico">${icons.eye}</span><span>Watch</span></div>
    <div class="item" data-mi="tmux"><span class="ico">${icons.tmux}</span><span>Open in tmux</span></div>
    <div class="item" data-mi="edit"><span class="ico">${icons.edit}</span><span>Edit persona</span></div>
    <div class="item" data-mi="copy"><span class="ico">${icons.copy}</span><span>Copy address</span></div>
    <div class="divider"></div>
    <div class="item danger" data-mi="delete"><span class="ico">${icons.trash}</span><span>Delete</span></div>
  `;
  document.body.appendChild(menu);
  activeMenu = menu;

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 280)}px`;
  menu.style.left = `${Math.min(rect.left - 180, window.innerWidth - 240)}px`;

  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.querySelectorAll<HTMLElement>('[data-mi]').forEach((it) => {
    it.addEventListener('click', () => {
      const mi = it.dataset['mi']!;
      closeMenu();
      handleMenuItem(mi, agentName);
    });
  });

  setTimeout(() => {
    document.addEventListener('click', closeMenu, { once: true });
  }, 0);
}

function closeMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

async function handleMenuItem(item: string, name: string): Promise<void> {
  switch (item) {
    case 'spawn':  return doAction(name, 'spawn',  'spawning');
    case 'kill':   return doAction(name, 'kill',   'killing');
    case 'watch':  go({ kind: 'watch', agentName: name }); return;
    case 'tmux': {
      const cmd = `tmux attach -t agent-${name}`;
      await navigator.clipboard?.writeText(cmd).catch(() => {});
      showToast(`Copied: ${cmd}`);
      return;
    }
    case 'edit':   return void openEditPersonaModal(name);
    case 'copy': {
      await navigator.clipboard?.writeText(`agent:${name}`).catch(() => {});
      showToast(`Copied agent:${name}`);
      return;
    }
    case 'delete': {
      if (!window.confirm(`Delete agent "${name}"? This is permanent.`)) return;
      return doAction(name, 'destroy', 'deleting');
    }
  }
}

async function doAction(agentName: string, action: string, gerund: string): Promise<void> {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/${action}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      showToast(`${gerund} failed: ${body?.error ?? res.status}`, 'error');
      return;
    }
    showToast(`Agent ${agentName} ${gerund}…`);
  } catch {
    showToast('Network error', 'error');
  }
}

async function reloadAll(): Promise<void> {
  let ok = 0, fail = 0;
  for (const a of state.agents) {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(a.name)}/reload`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      if (res.ok) ok++; else fail++;
    } catch { fail++; }
  }
  showToast(`Reload: ${ok} ok, ${fail} failed`, fail > 0 ? 'error' : 'info');
}

/* ── icons + helpers ───────────────────────────────────────────────── */

const icons = {
  eye:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
  edit:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-9 9H2v-3l9-9z"/></svg>`,
  dots:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></svg>`,
  play:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 3 13 8 4 13"/></svg>`,
  stop:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><line x1="6" y1="6" x2="10" y2="10"/><line x1="10" y1="6" x2="6" y2="10"/></svg>`,
  tmux:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 7l2 1.5L5 10"/><line x1="9" y1="10" x2="11" y2="10"/></svg>`,
  copy:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="8" height="11" rx="1"/><rect x="6" y="1.5" width="4" height="2" rx="0.5"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12"/><path d="M5 4V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M3.5 4l1 10a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1l1-10"/></svg>`,
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `chat-toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
