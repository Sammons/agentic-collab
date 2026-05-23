/**
 * Search — global multi-type search across already-loaded data.
 *
 * Client-side aggregation across:
 *   - Agents (name + cwd substring match)
 *   - Messages (state.threads — substring on message body)
 *   - Reminders (loaded from /api/reminders)
 *   - Approvals (loaded from /api/approvals)
 *   - Pages (loaded from /api/pages)
 *
 * Scope-by-type chips narrow the result list. Cmd+K focuses the input.
 */
import type { AgentRecord, DashboardMessage, Reminder, ApprovalRow, PageRecord } from '../shared/types.ts';
import { state, on, authHeaders } from './state.ts';
import { registerRoute, go } from './routing.ts';
import { focusMessage } from './chat.ts';

type Hit =
  | { kind: 'agent';     score: number; matched: string[]; record: AgentRecord }
  | { kind: 'message';   score: number; matched: string[]; record: DashboardMessage }
  | { kind: 'reminder';  score: number; matched: string[]; record: Reminder }
  | { kind: 'approval';  score: number; matched: string[]; record: ApprovalRow }
  | { kind: 'page';      score: number; matched: string[]; record: PageRecord };

let query = '';
let scope: 'all' | Hit['kind'] = 'all';
let reminders: Reminder[] = [];
let approvals: ApprovalRow[] = [];
let pages: PageRecord[] = [];
const detachers: Array<() => void> = [];

export function setupSearch(): void {
  registerRoute('search', render);
  // Cmd+K shortcut from anywhere
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      go({ kind: 'search' });
      setTimeout(() => document.querySelector<HTMLInputElement>('.sr-input')?.focus(), 50);
    }
  });
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="sr-page" style="height:100vh;overflow-y:auto;background:var(--paper);">
      <div class="sr-hdr">
        <div class="eyebrow">
          <span>Search</span>
          <span class="stats" data-stats>type a query to search agents, messages, approvals, reminders, pages</span>
          <span class="right"><kbd>⌘</kbd><kbd>K</kbd> from anywhere</span>
        </div>
        <div class="sr-input-wrap">
          <span class="glyph">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16" y2="16"/></svg>
          </span>
          <input class="sr-input" type="text" placeholder="Search…" autofocus>
          <button class="clear" data-clear>clear · esc</button>
        </div>
      </div>
      <div class="sr-scope-chips" data-chips></div>
      <div class="sr-results" data-results></div>
      <div class="sr-foot">
        <span class="kb"><kbd>↵</kbd> open · <kbd>esc</kbd> clear / close · scope follows sidebar — uncheck agents to narrow results.</span>
      </div>
    </div>
  `;

  void loadAuxData();
  wire(root);
  rerender();

  detachers.push(on('message', () => rerender()));
  detachers.push(on('agents-changed', () => rerender()));
  detachers.push(on('ws:reminder_update', () => void loadReminders().then(rerender)));
  detachers.push(on('ws:approval_changed', () => void loadApprovals().then(rerender)));
  detachers.push(on('ws:pages_update', () => void loadPages().then(rerender)));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'search') teardown();
  }));
}

function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
}

async function loadAuxData(): Promise<void> {
  await Promise.all([loadReminders(), loadApprovals(), loadPages()]);
  rerender();
}
async function loadReminders(): Promise<void> {
  try { const r = await fetch('/api/reminders', { headers: authHeaders() }); if (r.ok) reminders = await r.json() as Reminder[]; } catch {}
}
async function loadApprovals(): Promise<void> {
  try { const r = await fetch('/api/approvals', { headers: authHeaders() }); if (r.ok) approvals = await r.json() as ApprovalRow[]; } catch {}
}
async function loadPages(): Promise<void> {
  try { const r = await fetch('/api/pages', { headers: authHeaders() }); if (r.ok) pages = await r.json() as PageRecord[]; } catch {}
}

/* ── wiring ────────────────────────────────────────────────────────── */

function wire(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>('.sr-input');
  input?.addEventListener('input', () => {
    query = input.value;
    rerender();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = ''; query = '';
      rerender();
      input.blur();
    }
    if (e.key === 'Enter') {
      const first = document.querySelector<HTMLElement>('.sr-result');
      first?.click();
    }
  });
  root.querySelector<HTMLElement>('[data-clear]')?.addEventListener('click', () => {
    if (input) input.value = '';
    query = '';
    rerender();
  });
}

/* ── search core ───────────────────────────────────────────────────── */

function rerender(): void {
  const root = document.querySelector<HTMLElement>('.sr-page');
  if (!root) return;
  const hits = search(query);

  const counts = { agent: 0, message: 0, reminder: 0, approval: 0, page: 0 };
  for (const h of hits) counts[h.kind]++;

  const chips = root.querySelector<HTMLElement>('[data-chips]');
  if (chips) {
    chips.innerHTML = `
      <span class="chip ${scope === 'all' ? 'on' : ''}" data-scope="all">All <span class="ct">${hits.length}</span></span>
      <span class="chip ${scope === 'agent' ? 'on' : ''}" data-scope="agent">Agents <span class="ct">${counts.agent}</span></span>
      <span class="chip ${scope === 'message' ? 'on' : ''}" data-scope="message">Messages <span class="ct">${counts.message}</span></span>
      <span class="chip ${scope === 'approval' ? 'on' : ''}" data-scope="approval">Approvals <span class="ct">${counts.approval}</span></span>
      <span class="chip ${scope === 'reminder' ? 'on' : ''}" data-scope="reminder">Reminders <span class="ct">${counts.reminder}</span></span>
      <span class="chip ${scope === 'page' ? 'on' : ''}" data-scope="page">Pages <span class="ct">${counts.page}</span></span>
    `;
    chips.querySelectorAll<HTMLElement>('[data-scope]').forEach((el) => {
      el.addEventListener('click', () => {
        scope = (el.dataset['scope'] as typeof scope) ?? 'all';
        rerender();
      });
    });
  }

  const stats = root.querySelector<HTMLElement>('[data-stats]');
  if (stats) {
    if (!query.trim()) {
      stats.textContent = 'type a query to search agents, messages, approvals, reminders, pages';
    } else {
      stats.innerHTML = `<span class="num">${hits.length}</span> results · scope: <span class="num">${state.selectedAgents.size}</span>/${state.agents.length} agents`;
    }
  }

  const results = root.querySelector<HTMLElement>('[data-results]');
  if (!results) return;
  if (!query.trim()) {
    results.innerHTML = `
      <div class="sr-empty">
        <div class="lg">What are you looking for?</div>
        Start typing — results filter live. Press <kbd style="font-family:var(--mono);background:var(--paper-card);border:1px solid var(--rule);padding:0 5px;border-radius:2px;color:var(--ink-3);font-size:11px;">⌘</kbd><kbd style="font-family:var(--mono);background:var(--paper-card);border:1px solid var(--rule);padding:0 5px;border-radius:2px;color:var(--ink-3);font-size:11px;">K</kbd> from anywhere to focus the input.
      </div>
    `;
    return;
  }
  const visible = scope === 'all' ? hits : hits.filter((h) => h.kind === scope);
  if (visible.length === 0) {
    results.innerHTML = `<div class="sr-empty">No results for <strong style="color:var(--ink);">${escapeHtml(query)}</strong>.</div>`;
    return;
  }
  results.innerHTML = renderSections(visible);
  wireResults(results);
}

function search(q: string): Hit[] {
  if (!q.trim()) return [];
  const needle = q.toLowerCase();
  const hits: Hit[] = [];
  const scoped = state.selectedAgents;
  const inScope = (name: string) => scoped.size === 0 || scoped.has(name);

  // Agents
  for (const a of state.agents) {
    if (!inScope(a.name)) continue;
    const matched: string[] = [];
    if (a.name.toLowerCase().includes(needle)) matched.push('name');
    if (a.cwd?.toLowerCase().includes(needle)) matched.push('cwd');
    if (matched.length > 0) hits.push({ kind: 'agent', score: 100, matched, record: a });
  }

  // Messages — dedupe by id across threads
  const seen = new Set<number>();
  for (const [agentName, thread] of Object.entries(state.threads)) {
    if (!inScope(agentName)) continue;
    for (const m of thread) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.message.toLowerCase().includes(needle)) {
        hits.push({ kind: 'message', score: 80, matched: ['body'], record: m });
      }
    }
  }

  // Reminders
  for (const r of reminders) {
    if (!inScope(r.agentName)) continue;
    if (r.prompt.toLowerCase().includes(needle) || r.agentName.toLowerCase().includes(needle)) {
      hits.push({ kind: 'reminder', score: 70, matched: ['prompt'], record: r });
    }
  }

  // Approvals (no scope filter — approvals span agents)
  for (const a of approvals) {
    const hitChannel = a.channel.toLowerCase().includes(needle);
    const hitPayload = a.payload.toLowerCase().includes(needle);
    const hitId = a.id.toLowerCase().includes(needle);
    if (hitChannel || hitPayload || hitId) {
      const matched = [hitChannel && 'channel', hitPayload && 'payload', hitId && 'id'].filter(Boolean) as string[];
      hits.push({ kind: 'approval', score: 60, matched, record: a });
    }
  }

  // Pages
  for (const p of pages) {
    if (p.slug.toLowerCase().includes(needle)) {
      hits.push({ kind: 'page', score: 50, matched: ['slug'], record: p });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/* ── result rendering ──────────────────────────────────────────────── */

function renderSections(hits: Hit[]): string {
  const groups: Record<Hit['kind'], Hit[]> = { agent: [], message: [], reminder: [], approval: [], page: [] };
  for (const h of hits) groups[h.kind].push(h);
  const out: string[] = [];

  if (groups.agent.length > 0) out.push(sectionHtml('Agents', groups.agent));
  if (groups.message.length > 0) out.push(sectionHtml('Messages', groups.message));
  if (groups.approval.length > 0) out.push(sectionHtml('Approvals', groups.approval));
  if (groups.reminder.length > 0) out.push(sectionHtml('Reminders', groups.reminder));
  if (groups.page.length > 0) out.push(sectionHtml('Pages', groups.page));

  return out.join('');
}

function sectionHtml(title: string, hits: Hit[]): string {
  return `
    <div class="sr-section">
      <div class="sr-section-hdr">${escapeHtml(title)} <span class="ct">${hits.length}</span></div>
      ${hits.map(resultHtml).join('')}
    </div>
  `;
}

function resultHtml(h: Hit): string {
  switch (h.kind) {
    case 'agent': {
      const a = h.record;
      return `
        <div class="sr-result agent" data-kind="agent" data-go="${escapeHtml(a.name)}">
          <span class="dot"></span>
          <div class="body">
            <div class="hdr">
              <span class="nm"><a>${highlight(a.name)}</a></span>
              <span class="kind">${escapeHtml(a.engine ?? 'agent')}</span>
              <span class="state ${a.state}">${a.state}</span>
            </div>
            ${a.cwd ? `<div class="snippet mono">${highlight(a.cwd)}</div>` : ''}
            <div class="meta">matched in <span style="color:var(--ink-2);">${h.matched.join(', ')}</span></div>
          </div>
        </div>
      `;
    }
    case 'message': {
      const m = h.record;
      const who = m.sourceAgent ?? 'you';
      const to = m.targetAgent ?? '—';
      return `
        <div class="sr-result message" data-kind="message" data-msg-id="${m.id}" data-msg-agent="${escapeHtml(m.agent)}">
          <span class="dot"></span>
          <div class="body">
            <div class="hdr">
              <span class="nm">${escapeHtml(who)}</span>
              <span class="kind">→</span>
              <span class="nm">${escapeHtml(to)}</span>
              <span class="state">${formatTime(m.createdAt)}</span>
            </div>
            <div class="snippet">${highlight(m.message.slice(0, 240))}${m.message.length > 240 ? '…' : ''}</div>
          </div>
        </div>
      `;
    }
    case 'approval': {
      const a = h.record;
      return `
        <div class="sr-result approval" data-kind="approval" data-approval="${escapeHtml(a.id)}">
          <span class="dot"></span>
          <div class="body">
            <div class="hdr">
              <span class="nm">${escapeHtml(a.id)}</span>
              <span class="kind">channel:</span>
              <span class="nm">${highlight(a.channel)}</span>
              <span class="state ${a.state}">● ${a.state}</span>
            </div>
            <div class="snippet quote"><span class="gl">›</span><span>${highlight(a.payload.slice(0, 240))}${a.payload.length > 240 ? '…' : ''}</span></div>
            <div class="meta">matched in <span style="color:var(--ink-2);">${h.matched.join(', ')}</span></div>
          </div>
        </div>
      `;
    }
    case 'reminder': {
      const r = h.record;
      return `
        <div class="sr-result reminder" data-kind="reminder">
          <span class="dot"></span>
          <div class="body">
            <div class="hdr">
              <span class="nm">to ${escapeHtml(r.agentName)}</span>
              <span class="kind">${r.status}</span>
            </div>
            <div class="snippet quote"><span class="gl">›</span><span>${highlight(r.prompt)}</span></div>
            <div class="meta">every ${r.cadenceMinutes}m · ${r.createdBy ? 'by ' + escapeHtml(r.createdBy) : ''}</div>
          </div>
        </div>
      `;
    }
    case 'page': {
      const p = h.record;
      return `
        <div class="sr-result page" data-kind="page" data-page-slug="${escapeHtml(p.slug)}">
          <span class="dot"></span>
          <div class="body">
            <div class="hdr">
              <span class="nm"><a href="/pages/${escapeHtml(p.slug)}" target="_blank">${highlight(p.slug)}</a></span>
              <span class="kind">page</span>
            </div>
            <div class="meta">${p.fileCount ?? 0} files${p.agent ? ' · by ' + escapeHtml(p.agent) : ''}</div>
          </div>
        </div>
      `;
    }
  }
}

function wireResults(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('.sr-result.agent').forEach((el) => {
    el.addEventListener('click', () => {
      const name = el.dataset['go']!;
      go({ kind: 'watch', agentName: name });
    });
  });
  scope.querySelectorAll<HTMLElement>('.sr-result.message').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset['msgId']);
      const agentName = el.dataset['msgAgent'];
      if (!Number.isFinite(id)) return;
      // Make sure the thread is in the merged feed: add the agent to the
      // sidebar selection if it isn't already. Chat re-reads state on
      // route entry, no emit needed.
      if (agentName && !state.selectedAgents.has(agentName)) {
        state.selectedAgents.add(agentName);
      }
      focusMessage(id);
      go({ kind: 'dashboard' });
    });
  });
  scope.querySelectorAll<HTMLElement>('.sr-result.approval').forEach((el) => {
    el.addEventListener('click', () => {
      go({ kind: 'approvals' });
    });
  });
  scope.querySelectorAll<HTMLElement>('.sr-result.reminder').forEach((el) => {
    el.addEventListener('click', () => {
      go({ kind: 'reminders' });
    });
  });
  scope.querySelectorAll<HTMLElement>('.sr-result.page').forEach((el) => {
    // Already a link; no override needed.
  });
}

/* ── helpers ───────────────────────────────────────────────────────── */

function highlight(text: string): string {
  if (!query.trim()) return escapeHtml(text);
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) { out.push(escapeHtml(text.slice(i))); break; }
    out.push(escapeHtml(text.slice(i, idx)));
    out.push(`<mark>${escapeHtml(text.slice(idx, idx + needle.length))}</mark>`);
    i = idx + needle.length;
  }
  return out.join('');
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
