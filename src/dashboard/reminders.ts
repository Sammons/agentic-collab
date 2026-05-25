/**
 * Reminders — fan-out per-agent recurring prompts.
 *
 * Loads /api/reminders (no agent filter — get them all) and renders grouped
 * by agent. Each pending reminder fires independently on its own cadence;
 * the UI doesn't expose any queue/sortOrder concept (every pending row is
 * "firing"). Marking done completes it via POST /api/reminders/:id/complete;
 * deleting removes it via DELETE.
 *
 * Filter is the sidebar Teams tree — same as chat. Reminders only show for
 * agents in state.selectedAgents.
 */
import type { Reminder } from '../shared/types.ts';
import { state, on, authHeaders } from './state.ts';
import { registerRoute } from './routing.ts';
import { escapeHtml, toast } from './util.ts';

let reminders: Reminder[] = [];
const detachers: Array<() => void> = [];

export function setupReminders(): void {
  registerRoute('reminders', render);
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="rm-page" style="display:flex;flex-direction:column;height:100vh;background:var(--paper);overflow:hidden;">
      <div class="rm-hdr">
        <div>
          <div class="eyebrow">Reminders</div>
          <h1 class="filter-summary" data-summary>—</h1>
          <div class="pg-stats" data-stats>—</div>
          <span class="lede">
            Recurring prompts pasted into an agent&rsquo;s tmux session on a cadence until
            marked done. Each reminder fires independently. Filter via the sidebar Teams tree.
            Also addable via <code>collab reminder add</code>.
          </span>
        </div>
        <div class="right">
          <button class="btn primary" data-new>+ New reminder</button>
        </div>
      </div>
      <div class="rm-quickadd" style="margin: 14px 32px;">
        <span class="agent-pick empty" data-qa-agent>Pick agent… <span class="caret">▾</span></span>
        <input type="text" class="prompt-in" placeholder="Reminder prompt — pasted into the agent&rsquo;s tmux on cadence" data-qa-prompt>
        <span class="pill" data-qa-cadence>every 30m <span class="caret">▾</span></span>
        <span class="skip" data-qa-skip>
          <span class="box"></span>
          skip if active
        </span>
        <button class="btn primary" data-qa-add>Add</button>
      </div>
      <div class="rm-list" style="flex:1;overflow-y:auto;" data-list>Loading…</div>
      <div class="rm-foot" data-foot>—</div>
    </div>
  `;

  void loadAll();
  wireQuickadd(root);

  detachers.push(on('ws:reminder_update', () => void loadAll()));
  detachers.push(on('selection-changed', () => rerender()));
  detachers.push(on('agents-changed', () => rerender()));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'reminders') teardown();
  }));
}

function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
  reminders = [];
}

async function loadAll(): Promise<void> {
  try {
    const res = await fetch('/api/reminders', { headers: authHeaders() });
    if (!res.ok) {
      const list = document.querySelector<HTMLElement>('[data-list]');
      if (list) list.innerHTML = `<div style="padding:24px;color:var(--ink-3);font-style:italic;">Failed to load reminders.</div>`;
      return;
    }
    reminders = await res.json() as Reminder[];
    rerender();
  } catch {
    const list = document.querySelector<HTMLElement>('[data-list]');
    if (list) list.innerHTML = `<div style="padding:24px;color:var(--ink-3);font-style:italic;">Network error.</div>`;
  }
}

function rerender(): void {
  const root = document.querySelector<HTMLElement>('.rm-page');
  if (!root) return;
  const filtered = reminders.filter((r) => state.selectedAgents.has(r.agentName));
  const pending = filtered.filter((r) => r.status === 'pending');
  const completed = filtered.filter((r) => r.status === 'completed');

  // Summary
  const sel = state.selectedAgents.size;
  const total = state.agents.length;
  const summary = root.querySelector<HTMLElement>('[data-summary]');
  if (summary) {
    if (sel === 0) {
      summary.innerHTML = `<span class="where">No agents</span><span class="sub">— check agents in the sidebar</span>`;
    } else if (sel === total) {
      summary.innerHTML = `<span class="where">All agents</span><span class="sub">· all ${total} selected</span>`;
    } else {
      summary.innerHTML = `<span class="where">${sel} agents</span><span class="sub">· filtered from ${total}</span>`;
    }
  }

  const stats = root.querySelector<HTMLElement>('[data-stats]');
  if (stats) {
    stats.innerHTML = `
      <span class="num">${pending.length}</span> firing
      <span class="sep">·</span>
      <span class="num">${completed.length}</span> completed recently
    `;
  }

  const foot = root.querySelector<HTMLElement>('[data-foot]');
  if (foot) {
    foot.innerHTML = `<span class="num">${pending.length}</span> firing · <span class="num">${completed.length}</span> completed in last 7d · scoped to <span class="num">${sel}</span> agent${sel === 1 ? '' : 's'}`;
  }

  // List grouped by agent
  const list = root.querySelector<HTMLElement>('[data-list]');
  if (!list) return;
  if (pending.length === 0 && completed.length === 0) {
    list.innerHTML = `
      <div style="padding:48px 32px;text-align:center;color:var(--ink-3);font-style:italic;">
        No reminders in the current filter. Try checking more agents, or add one with <code style="font-family:var(--mono);color:var(--ink-2);">collab reminder add &lt;agent&gt; &quot;&lt;prompt&gt;&quot; --cadence 30m</code>.
      </div>
    `;
    return;
  }
  const byAgent: Record<string, Reminder[]> = {};
  for (const r of pending) {
    (byAgent[r.agentName] ??= []).push(r);
  }
  const agentBlocks = Object.entries(byAgent).map(([name, rs]) => agentBlockHtml(name, rs)).join('');
  const doneBlock = completed.length > 0 ? doneBlockHtml(completed) : '';
  list.innerHTML = agentBlocks + doneBlock;
  wireList(list);
}

function agentBlockHtml(name: string, rs: Reminder[]): string {
  return `
    <div class="rm-agent">
      <div class="rm-agent-hdr">
        <span class="nm">${escapeHtml(name)}</span>
        <span class="kind per">persistent</span>
        <span class="meta"><span class="num">${rs.length}</span> reminder${rs.length === 1 ? '' : 's'}</span>
      </div>
      ${rs.map(reminderRowHtml).join('')}
    </div>
  `;
}

function reminderRowHtml(r: Reminder): string {
  const last = r.lastDeliveredAt ? `last ${ago(r.lastDeliveredAt)} ago` : 'not yet fired';
  return `
    <div class="rm-rem" data-id="${r.id}">
      <span class="status-dot"></span>
      <div class="body">
        <div class="prompt">${escapeHtml(r.prompt)}</div>
        <div class="meta">
          every <span class="num">${formatCadence(r.cadenceMinutes)}</span>
          <span class="sep">·</span>
          ${last}
          ${r.createdBy ? `<span class="sep">·</span> by <span class="who">${escapeHtml(r.createdBy)}</span>` : ''}
          ${r.skipIfActive ? `<span class="sep">·</span><span class="skip">skip if active</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button data-act="complete" data-id="${r.id}">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>
          Mark done
        </button>
        <button class="del icon-only" data-act="delete" data-id="${r.id}" title="Delete">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10"/><path d="M5 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M4.5 5l.8 8.5a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9L11.5 5"/></svg>
        </button>
      </div>
    </div>
  `;
}

function doneBlockHtml(completed: Reminder[]): string {
  // Show up to 8 most recent.
  const recent = completed
    .slice()
    .sort((a, b) => (a.completedAt && b.completedAt ? (a.completedAt < b.completedAt ? 1 : -1) : 0))
    .slice(0, 8);
  return `
    <div class="rm-done">
      <div class="rm-done-hdr">
        Recently completed <span class="ct">${recent.length} shown · ${completed.length} total</span>
      </div>
      ${recent.map((r) => `
        <div class="rm-rem done">
          <span class="status-dot"></span>
          <div class="body">
            <div class="prompt">${escapeHtml(r.prompt)}</div>
            <div class="meta">
              ${escapeHtml(r.agentName)} <span class="sep">·</span>
              every <span class="num">${formatCadence(r.cadenceMinutes)}</span>
              ${r.completedAt ? `<span class="sep">·</span> done ${ago(r.completedAt)} ago` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function wireList(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset['id']);
      const act = btn.dataset['act'];
      if (act === 'complete') await complete(id);
      else if (act === 'delete') {
        if (!window.confirm('Delete this reminder?')) return;
        await del(id);
      }
    });
  });
}

async function complete(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/reminders/${id}/complete`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) { showToast('Complete failed', 'error'); return; }
    void loadAll();
  } catch { showToast('Network error', 'error'); }
}

async function del(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) { showToast('Delete failed', 'error'); return; }
    void loadAll();
  } catch { showToast('Network error', 'error'); }
}

/* ── quick-add ─────────────────────────────────────────────────────── */

let qaCadence = 30;
let qaSkip = false;
let qaAgentName: string | null = null;

function wireQuickadd(root: HTMLElement): void {
  const agentPick = root.querySelector<HTMLElement>('[data-qa-agent]');
  const cadence = root.querySelector<HTMLElement>('[data-qa-cadence]');
  const skip = root.querySelector<HTMLElement>('[data-qa-skip]');
  const addBtn = root.querySelector<HTMLButtonElement>('[data-qa-add]');
  const promptIn = root.querySelector<HTMLInputElement>('[data-qa-prompt]');

  agentPick?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.agents.length === 0) {
      showToast('No agents — create one from the Agents page first.');
      return;
    }
    openAgentMenu(agentPick, state.agents.map((a) => a.name), (picked) => {
      qaAgentName = picked;
      agentPick.classList.remove('empty');
      agentPick.innerHTML = `${escapeHtml(picked)} <span class="caret">▾</span>`;
    });
  });

  cadence?.addEventListener('click', (e) => {
    e.stopPropagation();
    openCadenceMenu(cadence, qaCadence, (picked) => {
      qaCadence = picked;
      cadence.innerHTML = `every ${formatCadence(picked)} <span class="caret">▾</span>`;
    });
  });

  skip?.addEventListener('click', () => {
    qaSkip = !qaSkip;
    skip.classList.toggle('on', qaSkip);
  });

  addBtn?.addEventListener('click', async () => {
    const promptText = promptIn?.value.trim();
    if (!qaAgentName) { showToast('Pick an agent first', 'error'); return; }
    if (!promptText) { showToast('Prompt is required', 'error'); return; }
    try {
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          agentName: qaAgentName,
          prompt: promptText,
          cadenceMinutes: qaCadence,
          skipIfActive: qaSkip,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        showToast(b?.error ?? 'Add failed', 'error');
        return;
      }
      if (promptIn) promptIn.value = '';
      void loadAll();
    } catch { showToast('Network error', 'error'); }
  });
}

/* ── inline popovers (agent picker + cadence picker) ────────────────── */

let openPopover: HTMLElement | null = null;
function closePopover(): void {
  if (openPopover) { openPopover.remove(); openPopover = null; }
  document.removeEventListener('click', closePopover);
}

function openAgentMenu(anchor: HTMLElement, names: string[], onPick: (name: string) => void): void {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'rm-qa-pop';
  pop.innerHTML = names.map((n) => {
    const agent = state.agents.find((a) => a.name === n);
    const dot = statusDot(agent?.state);
    return `
      <div class="rm-qa-item" data-name="${escapeHtml(n)}">
        <span class="status ${dot}"></span>
        <span class="nm">${escapeHtml(n)}</span>
        ${agent ? `<span class="meta">${escapeHtml(agent.state)}</span>` : ''}
      </div>
    `;
  }).join('');
  document.body.appendChild(pop);
  positionBelow(pop, anchor);
  pop.querySelectorAll<HTMLElement>('[data-name]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onPick(el.dataset['name']!);
      closePopover();
    });
  });
  openPopover = pop;
  // Close on next outside click — schedule so the trigger click doesn't dismiss.
  setTimeout(() => document.addEventListener('click', closePopover), 0);
  pop.addEventListener('click', (e) => e.stopPropagation());
}

const CADENCE_PRESETS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

function openCadenceMenu(anchor: HTMLElement, current: number, onPick: (min: number) => void): void {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'rm-qa-pop cadence';
  const presetRows = CADENCE_PRESETS.map((n) => `
    <div class="rm-qa-item ${n === current ? 'sel' : ''}" data-min="${n}">
      <span class="nm">every ${formatCadence(n)}</span>
    </div>
  `).join('');
  pop.innerHTML = `
    ${presetRows}
    <div class="rm-qa-divider">custom</div>
    <div class="rm-qa-custom">
      <input type="number" min="5" step="1" value="${current}" data-custom-min>
      <span class="suffix">min</span>
      <button class="btn primary" type="button" data-custom-set>Set</button>
    </div>
  `;
  document.body.appendChild(pop);
  positionBelow(pop, anchor);
  pop.querySelectorAll<HTMLElement>('[data-min]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onPick(Number(el.dataset['min']));
      closePopover();
    });
  });
  const customInput = pop.querySelector<HTMLInputElement>('[data-custom-min]')!;
  const customBtn = pop.querySelector<HTMLButtonElement>('[data-custom-set]')!;
  const commitCustom = () => {
    const n = parseInt(customInput.value, 10);
    if (!Number.isFinite(n) || n < 5) {
      showToast('Cadence must be ≥ 5 minutes', 'error');
      return;
    }
    onPick(n);
    closePopover();
  };
  customBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); commitCustom(); });
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
  });
  openPopover = pop;
  setTimeout(() => document.addEventListener('click', closePopover), 0);
  pop.addEventListener('click', (e) => e.stopPropagation());
}

function positionBelow(pop: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
}

function statusDot(state: string | undefined): string {
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

/* ── helpers ───────────────────────────────────────────────────────── */

function formatCadence(min: number): string {
  if (min >= 60 && min % 60 === 0) return `${min / 60}h`;
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440}d`;
  return `${min}m`;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

// Use toast from util.ts, aliased as showToast for backward compat
const showToast = toast;
