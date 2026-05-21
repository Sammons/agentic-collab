/**
 * Dashboard — merged chat stream.
 *
 * Mounts at route `dashboard` (the default `#/`). Renders all messages from
 * every checked agent into a single time-sorted feed. Composer sends to a
 * single target derived from a leading `@agent-name` mention in the input.
 *
 * Filter semantics:
 *   - state.selectedAgents determines which messages are visible.
 *   - A message is included if state.selectedAgents includes the thread's
 *     `agent` field (DashboardMessage.agent).
 *   - Messages live in multiple threads (a→b appears in both a's and b's
 *     thread). We dedupe by message id when merging.
 *
 * Profile popover opens on sender-name click. Click outside closes it.
 */
import type { AgentRecord, DashboardMessage } from '../shared/types.ts';
import { state, on, authHeaders } from './state.ts';
import { registerRoute, go } from './routing.ts';

export function setupChat(): void {
  registerRoute('dashboard', render);
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="chat-pane">
      <div class="pane-hdr">
        <h1 class="filter-summary">${filterSummaryHtml()}</h1>
        <div class="right" data-actions></div>
      </div>
      <div class="thread" id="chat-thread" data-thread></div>
      <div class="composer">
        <div class="input-wrap">
          <textarea data-composer-input placeholder="Message — start with @agent-name to target an agent…"></textarea>
        </div>
        <div class="ctrls">
          <span class="hint" data-target-hint>No target — start with <span class="target">@agent</span> to send.</span>
          <span class="spacer"></span>
          <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> send</span>
          <button class="btn primary" data-send disabled>Send</button>
        </div>
      </div>
    </div>
  `;

  renderThread();
  wire(root);

  // Subscribe to state changes that should re-render the thread.
  detachers.push(on('message', () => renderThread()));
  detachers.push(on('message-withdrawn', () => renderThread()));
  detachers.push(on('selection-changed', () => {
    updateFilterSummary();
    renderThread();
  }));
  detachers.push(on('agents-changed', () => {
    updateFilterSummary();
    renderThread();
  }));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'dashboard') teardown();
  }));
}

const detachers: Array<() => void> = [];
function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
}

/* ── header ────────────────────────────────────────────────────────── */

function filterSummaryHtml(): string {
  const total = state.agents.length;
  const sel = state.selectedAgents.size;
  if (sel === 0) {
    return `<span class="where">No agents</span><span class="sub">— check agents in the sidebar to see chat</span>`;
  }
  if (sel === total) {
    return `<span class="where">All agents</span><span class="sub">· all ${total} selected</span>`;
  }
  // Try to find a team that exactly matches the selection.
  const exactTeam = state.teams.find((t) =>
    t.members.length === sel && t.members.every((m) => state.selectedAgents.has(m))
  );
  if (exactTeam) {
    return `
      <span class="where">${escapeHtml(exactTeam.name)}</span>
      <span class="sub">· ${sel} of ${exactTeam.members.length} selected</span>
      <span class="clear" data-clear-filter>clear filter</span>
    `;
  }
  return `
    <span class="where">${sel} agents</span>
    <span class="sub">· filtered from ${total}</span>
    <span class="clear" data-clear-filter>clear filter</span>
  `;
}

function updateFilterSummary(): void {
  const h1 = document.querySelector<HTMLElement>('.chat-pane .filter-summary');
  if (h1) h1.innerHTML = filterSummaryHtml();
  wireClearFilter();
}

/* ── thread render ─────────────────────────────────────────────────── */

function renderThread(): void {
  const root = document.getElementById('chat-thread');
  if (!root) return;

  const merged = mergeMessages();
  if (merged.length === 0) {
    root.innerHTML = `
      <div class="empty">
        ${state.selectedAgents.size === 0
          ? 'Check at least one agent in the sidebar to see messages.'
          : 'No messages yet. Start one with <code class="inl">@agent-name</code> below.'}
      </div>
    `;
    return;
  }

  root.innerHTML = merged.map((m) => msgHtml(m)).join('');
  wireProfileTriggers(root);

  // Scroll to bottom on render (newest at bottom).
  root.scrollTop = root.scrollHeight;
}

function mergeMessages(): DashboardMessage[] {
  const seen = new Set<number>();
  const out: DashboardMessage[] = [];
  for (const [agentName, thread] of Object.entries(state.threads)) {
    if (!state.selectedAgents.has(agentName)) continue;
    for (const m of thread) {
      if (m.id < 0) {
        // optimistic message — always include
        out.push(m);
        continue;
      }
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id - b.id;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
  return out;
}

function msgHtml(m: DashboardMessage): string {
  const fromMe = m.sourceAgent === null || m.sourceAgent === 'dashboard';
  const fromAgent = fromMe ? null : m.sourceAgent;
  const toAgent = m.targetAgent;
  const fromKind = fromAgent ? kindOf(fromAgent) : 'me';
  const cls = ['msg'];
  if (fromKind === 'eph') cls.push('from-eph');
  else if (fromKind === 'per') cls.push('from-per');
  else cls.push('from-me');
  if (m.withdrawn) cls.push('withdrawn');

  const whoLabel = fromMe ? 'you' : (fromAgent ?? 'unknown');
  const toLabel = fromMe ? (toAgent ?? 'broadcast') : (toAgent ?? 'you');

  return `
    <div class="${cls.join(' ')}" data-msg-id="${m.id}">
      <div class="head">
        <span class="who" data-profile-for="${escapeHtml(fromAgent ?? '')}">${escapeHtml(whoLabel)}</span>
        <span class="arrow">→</span>
        <span class="to" data-profile-for="${escapeHtml(toAgent ?? '')}">${escapeHtml(toLabel)}</span>
        ${m.topic && m.topic !== 'general' ? `<span class="to" title="topic">· ${escapeHtml(m.topic)}</span>` : ''}
        <span class="time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="body">${m.withdrawn ? '(withdrawn)' : renderMessageBody(m.message)}</div>
    </div>
  `;
}

function kindOf(agentName: string): 'eph' | 'per' | 'me' {
  // Ephemeral addresses look like `agent-instance:<hash>` or contain @ paths;
  // for in-thread display we treat by AgentRecord.engine null as eph.
  const a = state.agents.find((x) => x.name === agentName);
  if (!a) {
    // Could be an instance address — treat as ephemeral for color.
    return agentName.includes(':') || agentName.includes('@') ? 'eph' : 'me';
  }
  // No explicit "ephemeral" flag on AgentRecord — use a heuristic: ephemeral
  // instances are always in the form `agent-instance:<hash>` or similar; the
  // dashboard's agents list only has persistent agents. Anything else = eph.
  // For now, color persistents as plum and treat everything else as steel.
  return 'per';
}

function renderMessageBody(text: string): string {
  // Escape, then inline simple things:
  //   `code` → <code class="inl">
  //   @mention → highlighted span
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code class="inl">$1</code>');
  html = html.replace(/(^|\s)(@[a-zA-Z0-9_\-/]+)/g, (_, lead, mention) => {
    return `${lead}<span class="mention">${mention}</span>`;
  });
  return html;
}

/* ── profile popover ───────────────────────────────────────────────── */

let activePop: HTMLElement | null = null;
function wireProfileTriggers(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('[data-profile-for]').forEach((el) => {
    const agentName = el.dataset['profileFor'];
    if (!agentName) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openProfilePopover(el, agentName);
    });
  });
  if (!document.body.dataset['popListener']) {
    document.body.dataset['popListener'] = '1';
    document.addEventListener('click', closeProfilePopover);
  }
}

function openProfilePopover(anchor: HTMLElement, agentName: string): void {
  closeProfilePopover();
  const agent = state.agents.find((a) => a.name === agentName);
  if (!agent) return;

  const pop = document.createElement('div');
  pop.className = 'profile-pop';
  const kindClass = kindOf(agentName) === 'per' ? 'per' : '';
  pop.innerHTML = `
    <div class="ph">
      <div class="kind ${kindClass}">${agent.engine ?? 'persistent'} · ${agent.state ?? 'unknown'}</div>
      <h2 class="nm">${escapeHtml(agent.name)}</h2>
    </div>
    <div class="meta">
      <span class="k">Address</span><span class="v mono">agent:${escapeHtml(agent.name)}</span>
      <span class="k">CWD</span><span class="v mono">${escapeHtml(agent.cwd ?? '—')}</span>
      <span class="k">Engine</span><span class="v">${escapeHtml(agent.engine ?? '—')}${agent.model ? ` · ${escapeHtml(agent.model)}` : ''}</span>
      <span class="k">State</span><span class="v">${escapeHtml(agent.state)}</span>
    </div>
    <div class="pa">
      <button class="btn ghost" data-pop-watch>Watch</button>
      <button class="btn ghost" data-pop-filter>Filter chat</button>
      <button class="btn ghost" data-pop-copy>Copy address</button>
    </div>
  `;

  // Position near anchor.
  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${Math.max(rect.bottom + 6, 12)}px`;
  pop.style.left = `${Math.max(rect.left - 8, 12)}px`;

  document.body.appendChild(pop);
  activePop = pop;

  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.querySelector<HTMLElement>('[data-pop-watch]')?.addEventListener('click', () => {
    closeProfilePopover();
    go({ kind: 'watch', agentName });
  });
  pop.querySelector<HTMLElement>('[data-pop-filter]')?.addEventListener('click', () => {
    state.selectedAgents.clear();
    state.selectedAgents.add(agentName);
    state.route = { kind: 'dashboard' };
    closeProfilePopover();
    // emit selection-changed; sidebar + chat will rerender.
    import('./state.ts').then((s) => s.emit('selection-changed'));
  });
  pop.querySelector<HTMLElement>('[data-pop-copy]')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(`agent:${agentName}`).catch(() => {});
    toast('Address copied');
    closeProfilePopover();
  });
}

function closeProfilePopover(): void {
  if (activePop) {
    activePop.remove();
    activePop = null;
  }
}

/* ── composer ──────────────────────────────────────────────────────── */

function wire(root: HTMLElement): void {
  wireClearFilter();

  const input = root.querySelector<HTMLTextAreaElement>('[data-composer-input]');
  const sendBtn = root.querySelector<HTMLButtonElement>('[data-send]');
  const hint = root.querySelector<HTMLElement>('[data-target-hint]');
  if (!input || !sendBtn || !hint) return;

  const updateHint = () => {
    const parsed = parseComposer(input.value);
    if (parsed.agent) {
      hint.innerHTML = `Sending to <span class="target">@${escapeHtml(parsed.agent)}</span>`;
      sendBtn.disabled = !parsed.message;
    } else {
      hint.innerHTML = `No target — start with <span class="target">@agent</span> to send.`;
      sendBtn.disabled = true;
    }
  };

  input.addEventListener('input', updateHint);
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!sendBtn.disabled) handleSend(input);
    }
  });
  sendBtn.addEventListener('click', () => handleSend(input));
  updateHint();
}

function wireClearFilter(): void {
  document.querySelector<HTMLElement>('.chat-pane [data-clear-filter]')?.addEventListener('click', () => {
    for (const a of state.agents) state.selectedAgents.add(a.name);
    import('./state.ts').then((s) => s.emit('selection-changed'));
  });
}

type Parsed = { agent: string | null; message: string };
function parseComposer(text: string): Parsed {
  const trimmed = text.trim();
  if (!trimmed.startsWith('@')) return { agent: null, message: trimmed };
  const m = trimmed.match(/^@([a-zA-Z0-9_\-/]+)\s+([\s\S]+)$/);
  if (!m) return { agent: null, message: trimmed };
  return { agent: m[1]!, message: m[2]!.trim() };
}

async function handleSend(input: HTMLTextAreaElement): Promise<void> {
  const parsed = parseComposer(input.value);
  if (!parsed.agent || !parsed.message) return;

  // Optimistic message — appears immediately, replaced when WS broadcast arrives.
  const optimisticId = -Date.now();
  const now = new Date().toISOString();
  const optimistic: DashboardMessage = {
    id: optimisticId,
    agent: parsed.agent,
    direction: 'to_agent',
    sourceAgent: null,
    targetAgent: parsed.agent,
    topic: 'general',
    message: parsed.message,
    queueId: null,
    deliveryStatus: 'pending',
    withdrawn: false,
    createdAt: now,
  };
  const list = state.threads[parsed.agent] ?? [];
  list.push(optimistic);
  state.threads[parsed.agent] = list;
  renderThread();
  input.value = '';
  const hint = document.querySelector<HTMLElement>('[data-target-hint]');
  if (hint) hint.innerHTML = `No target — start with <span class="target">@agent</span> to send.`;
  const sendBtn = document.querySelector<HTMLButtonElement>('[data-send]');
  if (sendBtn) sendBtn.disabled = true;

  try {
    const target = parsed.agent.includes(':') || parsed.agent.includes('/')
      ? parsed.agent
      : `agent:${parsed.agent}`;
    const res = await fetch('/api/dashboard/send', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent: target, message: parsed.message, topic: 'general' }),
    });
    if (!res.ok) {
      // remove optimistic on failure
      const idx = list.findIndex((m) => m.id === optimisticId);
      if (idx >= 0) list.splice(idx, 1);
      renderThread();
      const body = await res.json().catch(() => null);
      toast(body?.error ?? 'Send failed', 'error');
    }
  } catch (err) {
    const idx = list.findIndex((m) => m.id === optimisticId);
    if (idx >= 0) list.splice(idx, 1);
    renderThread();
    toast('Network error', 'error');
  }
}

/* ── helpers ───────────────────────────────────────────────────────── */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `chat-toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
