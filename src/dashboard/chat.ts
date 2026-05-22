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
  // System lifecycle events render as a distinct compact row, not a
  // chat bubble — see mock §01 .trigger-banner / .exit-banner.
  if (m.sourceAgent === 'system') {
    return systemMsgHtml(m);
  }

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

/** Compact one-line event row used for lifecycle / system messages. */
function systemMsgHtml(m: DashboardMessage): string {
  // The body already includes the agent name (per the orchestrator's
  // broadcastLifecycleEvent change). topic="lifecycle" → use the trigger
  // banner styling; anything else falls through to plain.
  const isLifecycle = m.topic === 'lifecycle';
  const cls = `sys-event ${isLifecycle ? 'lifecycle' : ''}`;
  return `
    <div class="${cls}" data-msg-id="${m.id}">
      <span class="body">${escapeHtml(m.message)}</span>
      <span class="time">${formatTime(m.createdAt)}</span>
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
  const inputWrap = root.querySelector<HTMLElement>('.composer .input-wrap');
  if (!input || !sendBtn || !hint || !inputWrap) return;

  const updateHint = () => {
    const parsed = parseComposer(input.value);
    if (parsed.agents.length > 0) {
      const list = parsed.agents.map((a) => `<span class="target">@${escapeHtml(a)}</span>`).join(', ');
      const messageReady = parsed.message.length > 0;
      hint.innerHTML = messageReady
        ? `Sending to ${list}`
        : `${list} — type a message`;
      sendBtn.disabled = !messageReady;
      sendBtn.textContent = parsed.agents.length > 1
        ? `Send → ${parsed.agents.length}`
        : 'Send';
    } else {
      hint.innerHTML = `No target — type <span class="target">@</span> to pick an agent.`;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Send';
    }
  };

  const mention = setupMentionAutocomplete(input, inputWrap, updateHint);

  input.addEventListener('input', () => {
    mention.refresh();
    updateHint();
  });
  input.addEventListener('keydown', (e) => {
    // Mention popover gets first crack at navigation keys.
    if (mention.isOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mention.move(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); mention.move(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); mention.pick(); return;
      }
      if (e.key === 'Escape')    { e.preventDefault(); mention.close(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!sendBtn.disabled) handleSend(input);
    }
  });
  input.addEventListener('blur', () => {
    // Delay so a click on a popover item still registers.
    setTimeout(() => mention.close(), 120);
  });
  sendBtn.addEventListener('click', () => handleSend(input));
  updateHint();
}

/* ── @-mention autocomplete ────────────────────────────────────────── */

type MentionApi = {
  isOpen: () => boolean;
  refresh: () => void;
  move: (dir: 1 | -1) => void;
  pick: () => void;
  close: () => void;
};

function setupMentionAutocomplete(
  input: HTMLTextAreaElement,
  anchor: HTMLElement,
  afterSelect: () => void,
): MentionApi {
  let pop: HTMLElement | null = null;
  let matches: string[] = [];
  let selectedIdx = 0;
  let activeRange: { start: number; end: number } | null = null;

  const close = () => {
    if (pop) { pop.remove(); pop = null; }
    matches = [];
    activeRange = null;
  };

  const detectToken = (): { partial: string; start: number; end: number } | null => {
    const pos = input.selectionStart ?? 0;
    const before = input.value.slice(0, pos);
    // Match an @-token: `@` not preceded by alphanumeric, followed by zero+
    // [a-zA-Z0-9_\-/] chars, anchored to the caret.
    const m = before.match(/(?:^|\s)(@[a-zA-Z0-9_\-/]*)$/);
    if (!m) return null;
    const start = pos - m[1]!.length;
    return { partial: m[1]!.slice(1), start, end: pos };
  };

  const computeMatches = (partial: string): string[] => {
    const lower = partial.toLowerCase();
    const all = state.agents.map((a) => a.name);
    if (!lower) return all.slice(0, 8);
    const starts: string[] = [];
    const contains: string[] = [];
    for (const n of all) {
      const ln = n.toLowerCase();
      if (ln.startsWith(lower)) starts.push(n);
      else if (ln.includes(lower)) contains.push(n);
    }
    return [...starts, ...contains].slice(0, 8);
  };

  const render = () => {
    if (!pop) return;
    if (matches.length === 0) {
      pop.innerHTML = `<div class="mention-empty">no agents match</div>`;
      return;
    }
    pop.innerHTML = matches.map((name, i) => {
      const agent = state.agents.find((a) => a.name === name);
      const dot = agent ? statusClass(agent.state) : 'offline';
      return `
        <div class="mention-item ${i === selectedIdx ? 'sel' : ''}" data-idx="${i}">
          <span class="status ${dot}"></span>
          <span class="nm">${escapeHtml(name)}</span>
          ${agent ? `<span class="meta">${escapeHtml(agent.state ?? '')}</span>` : ''}
        </div>
      `;
    }).join('');
    pop.querySelectorAll<HTMLElement>('[data-idx]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur the textarea
        selectedIdx = Number(el.dataset['idx']);
        pick();
      });
      el.addEventListener('mouseenter', () => {
        selectedIdx = Number(el.dataset['idx']);
        render();
      });
    });
  };

  const refresh = () => {
    const tok = detectToken();
    if (!tok) { close(); return; }
    matches = computeMatches(tok.partial);
    activeRange = { start: tok.start, end: tok.end };
    if (matches.length === 0 && tok.partial === '') { close(); return; }
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'mention-popover';
      anchor.appendChild(pop);
    }
    selectedIdx = Math.min(selectedIdx, Math.max(0, matches.length - 1));
    render();
  };

  const pick = () => {
    if (!activeRange) { close(); return; }
    const name = matches[selectedIdx];
    if (!name) { close(); return; }
    const before = input.value.slice(0, activeRange.start);
    const after = input.value.slice(activeRange.end);
    const replacement = `@${name} `;
    input.value = before + replacement + after;
    const caret = before.length + replacement.length;
    input.setSelectionRange(caret, caret);
    close();
    input.focus();
    afterSelect();
  };

  const move = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    selectedIdx = (selectedIdx + dir + matches.length) % matches.length;
    render();
  };

  return {
    isOpen: () => pop !== null,
    refresh,
    move,
    pick,
    close,
  };
}

function statusClass(state: string | undefined): string {
  switch (state) {
    case 'active':
    case 'idle':       return 'online';
    case 'spawning':
    case 'resuming':
    case 'suspending': return 'busy';
    case 'suspended':  return 'paused';
    case 'failed':     return 'failed';
    default:           return 'offline';
  }
}

function wireClearFilter(): void {
  document.querySelector<HTMLElement>('.chat-pane [data-clear-filter]')?.addEventListener('click', () => {
    for (const a of state.agents) state.selectedAgents.add(a.name);
    import('./state.ts').then((s) => s.emit('selection-changed'));
  });
}

type Parsed = { agents: string[]; message: string };

/**
 * Parse the composer: extract every leading `@name` token, the remainder
 * is the message body. Examples:
 *   "@a hello"              → { agents: ['a'], message: 'hello' }
 *   "@a @b @c please look"  → { agents: ['a','b','c'], message: 'please look' }
 *   "@a"                    → { agents: ['a'], message: '' }   (target known, msg empty)
 *   "hello"                 → { agents: [],    message: 'hello' }
 * Mentions appearing mid-message (after non-mention words) are NOT treated
 * as targets — they're just inline references.
 */
function parseComposer(text: string): Parsed {
  let rest = text.replace(/^\s+/, '');
  const agents: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = rest.match(/^@([a-zA-Z0-9_\-/]+)(\s+|$)/);
    if (!m) break;
    if (!agents.includes(m[1]!)) agents.push(m[1]!);
    rest = rest.slice(m[0].length).replace(/^\s+/, '');
  }
  return { agents, message: rest.trim() };
}

async function handleSend(input: HTMLTextAreaElement): Promise<void> {
  const parsed = parseComposer(input.value);
  if (parsed.agents.length === 0 || !parsed.message) return;

  // Fan out — append one optimistic row per recipient, fire one POST per
  // recipient. Each lives in its own thread so the merge view shows them
  // as parallel entries. Failures get individual toasts; the others still
  // go through.
  const now = new Date().toISOString();
  const pending: Array<{ agent: string; optimisticId: number; list: DashboardMessage[] }> = [];
  let stamp = Date.now();
  for (const agent of parsed.agents) {
    const optimisticId = -(stamp++);
    const optimistic: DashboardMessage = {
      id: optimisticId,
      agent,
      direction: 'to_agent',
      sourceAgent: null,
      targetAgent: agent,
      topic: 'general',
      message: parsed.message,
      queueId: null,
      deliveryStatus: 'pending',
      withdrawn: false,
      createdAt: now,
    };
    const list = state.threads[agent] ?? [];
    list.push(optimistic);
    state.threads[agent] = list;
    pending.push({ agent, optimisticId, list });
  }
  renderThread();
  input.value = '';
  const hint = document.querySelector<HTMLElement>('[data-target-hint]');
  if (hint) hint.innerHTML = `No target — type <span class="target">@</span> to pick an agent.`;
  const sendBtn = document.querySelector<HTMLButtonElement>('[data-send]');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Send'; }

  let okCount = 0;
  let failCount = 0;
  await Promise.all(pending.map(async ({ agent, optimisticId, list }) => {
    try {
      const target = agent.includes(':') || agent.includes('/') ? agent : `agent:${agent}`;
      const res = await fetch('/api/dashboard/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ agent: target, message: parsed.message, topic: 'general' }),
      });
      if (!res.ok) {
        const idx = list.findIndex((m) => m.id === optimisticId);
        if (idx >= 0) list.splice(idx, 1);
        failCount++;
        const body = await res.json().catch(() => null);
        toast(`@${agent}: ${body?.error ?? 'send failed'}`, 'error');
      } else {
        okCount++;
      }
    } catch {
      const idx = list.findIndex((m) => m.id === optimisticId);
      if (idx >= 0) list.splice(idx, 1);
      failCount++;
      toast(`@${agent}: network error`, 'error');
    }
  }));
  renderThread();
  if (okCount > 1 && failCount === 0) {
    toast(`Sent to ${okCount} agents`);
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
