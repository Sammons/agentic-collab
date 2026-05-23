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

  // "Load older" affordance — shown when at least one selected agent's thread
  // could plausibly have older history (i.e. it isn't known-exhausted).
  const hasMoreAvailable = anyAgentMayHaveOlder();
  const loadOlderHtml = hasMoreAvailable
    ? `<div class="load-older-wrap"><button class="btn ghost" data-load-older>Load older messages</button></div>`
    : '';

  root.innerHTML = loadOlderHtml + merged.map((m) => msgHtml(m)).join('');
  wireProfileTriggers(root);
  wireLoadOlder(root);

  // If a search result asked us to focus a specific message, scroll to it
  // and add a transient highlight class. Otherwise default to bottom.
  if (pendingFocusId !== null) {
    const target = root.querySelector<HTMLElement>(`[data-msg-id="${pendingFocusId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      target.classList.add('focus-flash');
      setTimeout(() => target.classList.remove('focus-flash'), 1800);
    } else {
      // Not in the rendered set — fall back to bottom.
      root.scrollTop = root.scrollHeight;
    }
    pendingFocusId = null;
  } else {
    root.scrollTop = root.scrollHeight;
  }
}

// Track which agents we know are exhausted (the server returned 0 older rows
// in response to a paginated request). Lets us hide the button once we've
// scrolled all the way back. Reset on init (full reconnect).
const exhaustedAgents = new Set<string>();

// init from connection.ts repopulates threads — clear pagination state so we
// re-offer "Load older" against the fresh window.
on('init', () => exhaustedAgents.clear());

function anyAgentMayHaveOlder(): boolean {
  for (const agentName of Object.keys(state.threads)) {
    if (exhaustedAgents.has(agentName)) continue;
    const isSelected = state.selectedAgents.has(agentName);
    const isSystemThread = SYSTEM_THREADS.has(agentName);
    if (!isSelected && !isSystemThread) continue;
    // The init cap is 200/agent; threads that started below that are short
    // enough that we don't need to bother offering a "Load older" button.
    if ((state.threads[agentName]?.length ?? 0) >= INIT_THREAD_CAP) return true;
  }
  return false;
}

const INIT_THREAD_CAP = 200;

function wireLoadOlder(scope: HTMLElement): void {
  const btn = scope.querySelector<HTMLButtonElement>('[data-load-older]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    // Anchor the scroll to the message currently at the top of the window
    // so the user's reading position doesn't snap to the bottom after we
    // prepend older content.
    const anchorId = firstVisibleMessageId();
    await loadOlderForVisibleAgents();
    if (anchorId !== null) pendingFocusId = anchorId;
    renderThread();
  });
}

function firstVisibleMessageId(): number | null {
  const thread = document.getElementById('chat-thread');
  if (!thread) return null;
  const rows = thread.querySelectorAll<HTMLElement>('[data-msg-id]');
  for (const row of rows) {
    if (row.offsetTop + row.offsetHeight >= thread.scrollTop) {
      const id = parseInt(row.dataset['msgId'] ?? '', 10);
      return Number.isFinite(id) ? id : null;
    }
  }
  return null;
}

async function loadOlderForVisibleAgents(): Promise<void> {
  const candidates: string[] = [];
  for (const agentName of Object.keys(state.threads)) {
    if (exhaustedAgents.has(agentName)) continue;
    const isSelected = state.selectedAgents.has(agentName);
    const isSystemThread = SYSTEM_THREADS.has(agentName);
    if (!isSelected && !isSystemThread) continue;
    if ((state.threads[agentName]?.length ?? 0) >= INIT_THREAD_CAP) candidates.push(agentName);
  }
  await Promise.all(candidates.map(loadOlderForAgent));
}

async function loadOlderForAgent(agentName: string): Promise<void> {
  const thread = state.threads[agentName] ?? [];
  // Lowest positive id is the oldest server-known message in the window.
  const oldest = thread.find((m) => m.id > 0);
  const beforeId = oldest?.id ?? null;
  try {
    const url = `/api/dashboard/threads/${encodeURIComponent(agentName)}/older${beforeId !== null ? `?beforeId=${beforeId}` : ''}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const body = await res.json() as { messages: DashboardMessage[] };
    if (!body.messages || body.messages.length === 0) {
      exhaustedAgents.add(agentName);
      return;
    }
    // Prepend chronologically — server already returned ASC order.
    state.threads[agentName] = [...body.messages, ...thread];
    if (body.messages.length < INIT_THREAD_CAP) exhaustedAgents.add(agentName);
  } catch {
    // Network error — leave the button visible so the user can retry.
  }
}

let pendingFocusId: number | null = null;

/**
 * Request that the next chat render scrolls to + highlights a specific
 * message id. Called by search.ts when the user clicks a message result.
 */
export function focusMessage(id: number): void {
  pendingFocusId = id;
}

// Threads whose name isn't a registered agent but still belongs in the
// merged feed — operator-visible system context (approval auto-notify,
// lifecycle banners, etc.).
const SYSTEM_THREADS = new Set(['dashboard', 'system']);

function mergeMessages(): DashboardMessage[] {
  const seen = new Set<number>();
  const out: DashboardMessage[] = [];
  for (const [agentName, thread] of Object.entries(state.threads)) {
    const isSelected = state.selectedAgents.has(agentName);
    const isSystemThread = SYSTEM_THREADS.has(agentName);
    if (!isSelected && !isSystemThread) continue;
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

  const topic = m.topic || 'general';
  return `
    <div class="${cls.join(' ')}" data-msg-id="${m.id}">
      <div class="head">
        <span class="who" data-profile-for="${escapeHtml(fromAgent ?? '')}">${statusDot(fromAgent)}${escapeHtml(whoLabel)}</span>
        <span class="arrow">→</span>
        <span class="to" data-profile-for="${escapeHtml(toAgent ?? '')}">${statusDot(toAgent)}${escapeHtml(toLabel)}</span>
        <span class="topic ${topic === 'general' ? 'default' : ''}" title="topic">#${escapeHtml(topic)}</span>
        <span class="time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="body">${m.withdrawn ? '(withdrawn)' : renderMessageBody(m.message)}</div>
    </div>
  `;
}

/**
 * Spawn-status dot rendered before an agent name in a chat head. Green for
 * running (active/idle/spawning/resuming), grey amber for transient, red for
 * suspended/failed. Returns '' for non-agent participants ("you", "dashboard",
 * "system", ephemeral instance addresses) so the head stays clean.
 */
function statusDot(agentName: string | null | undefined): string {
  if (!agentName) return '';
  if (agentName === 'dashboard' || agentName === 'system') return '';
  const a = state.agents.find((x) => x.name === agentName);
  if (!a) return ''; // ephemeral / unknown — no dot
  // Map to a CSS class that owns its own shape *and* color so colorblind
  // users can still distinguish states. suspended and failed collapse to
  // the same "down" indicator (solid brick disc with × glyph) — in
  // practice both mean "not running, won't come back on its own".
  let cls = 'void';
  if (['active', 'idle', 'spawning', 'resuming'].includes(a.state)) cls = 'on';
  else if (a.state === 'suspending') cls = 'transient';
  else if (a.state === 'suspended' || a.state === 'failed') cls = 'failed';
  return `<span class="status-dot ${cls}" title="${escapeHtml(a.state)}"></span>`;
}

/** Compact one-line event row used for lifecycle / system messages. */
function systemMsgHtml(m: DashboardMessage): string {
  // Normalize the body: strip the legacy "[system] " prefix (pre-fix data)
  // and ensure the agent name leads. Older messages stored just "Spawned"
  // / "Resumed" / etc. without the agent name — we prepend m.agent so the
  // user can always tell which agent the event belongs to.
  let text = m.message.replace(/^\[system\]\s*/i, '').trim();
  if (m.agent && !text.toLowerCase().startsWith(m.agent.toLowerCase())) {
    text = `${m.agent} ${text.toLowerCase()}`;
  }
  const isLifecycle = m.topic === 'lifecycle';
  const cls = `sys-event ${isLifecycle ? 'lifecycle' : ''}`;
  return `
    <div class="${cls}" data-msg-id="${m.id}">
      <span class="body">
        <span class="who" data-profile-for="${escapeHtml(m.agent ?? '')}">${statusDot(m.agent)}${escapeHtml(m.agent ?? '')}</span>
        <span class="rest">${escapeHtml(text.slice((m.agent ?? '').length).trim())}</span>
      </span>
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

  // Stat shape:
  //  - message count is from the live cache (cap-200 per agent today),
  //    so it's "messages currently visible" rather than lifetime — close
  //    enough for a quick scan.
  //  - lastActivity comes from the heartbeat path; null when never spawned.
  //  - createdAt is the row creation; "started" is approximated as the
  //    most recent of those two so the popover shows when the agent was
  //    last brought up.
  const msgCount = (state.threads[agentName] ?? []).filter((m) => m.id > 0).length;
  const lastActive = agent.lastActivity ? relativeTime(agent.lastActivity) : 'never';
  const startedRaw = agent.lastActivity ?? agent.createdAt;
  const started = startedRaw ? relativeTime(startedRaw) : '—';
  const proxy = agent.proxyId ?? 'none';
  const cwd = agent.cwd ?? '—';

  // Action availability — keyed by current state. Suspending/resuming are
  // transient: hide both controls so the user doesn't issue conflicting
  // requests against an in-flight transition.
  const isRunning = ['active', 'idle', 'spawning'].includes(agent.state);
  const isTransient = ['suspending', 'resuming'].includes(agent.state);
  const canStart = !isRunning && !isTransient;
  const canKill = isRunning;
  // Suspended state takes the /resume endpoint; everything else uses /spawn.
  const startVerb = agent.state === 'suspended' ? 'Resume' : 'Start';
  const startAction = agent.state === 'suspended' ? 'resume' : 'spawn';

  pop.innerHTML = `
    <div class="ph">
      <div class="kind ${kindClass}">${escapeHtml(agent.engine ?? 'persistent')} · ${escapeHtml(agent.state ?? 'unknown')}</div>
      <h2 class="nm">${escapeHtml(agent.name)}</h2>
    </div>
    <div class="meta">
      <span class="k">Address</span><span class="v mono">agent:${escapeHtml(agent.name)}</span>
      <span class="k">CWD</span><span class="v mono trunc" title="${escapeHtml(cwd)}">${escapeHtml(cwd)}</span>
      <span class="k">Engine</span><span class="v">${escapeHtml(agent.engine ?? '—')}${agent.model ? ` · ${escapeHtml(agent.model)}` : ''}</span>
      <span class="k">Proxy</span><span class="v mono">${escapeHtml(proxy)}</span>
      <span class="k">Messages</span><span class="v">${msgCount.toLocaleString()}</span>
      <span class="k">Last active</span><span class="v">${escapeHtml(lastActive)}</span>
      <span class="k">Started</span><span class="v">${escapeHtml(started)}</span>
      ${agent.spawnCount > 0 ? `<span class="k">Spawns</span><span class="v">${agent.spawnCount}×</span>` : ''}
    </div>
    <div class="pa primary">
      ${canStart ? `<button class="btn primary" data-pop-start>${startVerb}</button>` : ''}
      ${canKill  ? `<button class="btn" data-pop-kill>Kill</button>` : ''}
      <button class="btn ghost" data-pop-watch>Watch</button>
      <button class="btn ghost" data-pop-persona>Persona</button>
    </div>
    <div class="pa secondary">
      <button class="btn ghost" data-pop-filter>Filter chat</button>
      <button class="btn ghost" data-pop-copy>Copy address</button>
    </div>
  `;

  // Position near anchor. Append first so we can measure, then clamp to
  // viewport so an anchor near the right edge doesn't push the popover
  // off-screen now that we're 360px wide. On narrow viewports the CSS
  // @media rule overrides this to pin the popover as a bottom sheet.
  document.body.appendChild(pop);
  activePop = pop;
  pop.style.position = 'fixed';
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 12;
  let top = rect.bottom + 6;
  let left = rect.left - 8;
  // Flip above the anchor if there's not enough room below.
  if (top + popRect.height > window.innerHeight - margin && rect.top - popRect.height - 6 > margin) {
    top = rect.top - popRect.height - 6;
  }
  // Clamp horizontally so the right edge stays inside the viewport.
  left = Math.min(left, window.innerWidth - popRect.width - margin);
  left = Math.max(left, margin);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

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
  pop.querySelector<HTMLElement>('[data-pop-start]')?.addEventListener('click', () => {
    void lifecycleAction(agentName, startAction, startVerb.toLowerCase() + 'ing');
    closeProfilePopover();
  });
  pop.querySelector<HTMLElement>('[data-pop-kill]')?.addEventListener('click', () => {
    void lifecycleAction(agentName, 'kill', 'killing');
    closeProfilePopover();
  });
  pop.querySelector<HTMLElement>('[data-pop-persona]')?.addEventListener('click', async () => {
    closeProfilePopover();
    const { openEditPersonaModal } = await import('./overlays.ts');
    openEditPersonaModal(agentName);
  });
}

async function lifecycleAction(name: string, action: string, gerund: string): Promise<void> {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/${action}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast(`${gerund} failed: ${body?.error ?? res.status}`);
      return;
    }
    toast(`${name} ${gerund}…`);
  } catch {
    toast('Network error');
  }
}

function relativeTime(iso: string): string {
  try {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const dt = Date.now() - t;
    if (dt < 0) return 'just now';
    const sec = Math.floor(dt / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 14) return `${day}d ago`;
    return new Date(t).toLocaleDateString();
  } catch { return '—'; }
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

  // Restore the last sent prefix so the user picks up where they left off.
  const savedPrefix = loadPrefix();
  if (savedPrefix && !input.value) {
    input.value = savedPrefix;
    input.setSelectionRange(input.value.length, input.value.length);
  }

  const updateHint = () => {
    const parsed = parseComposer(input.value);
    if (parsed.agents.length > 0) {
      const list = parsed.agents.map((a) => `<span class="target">@${escapeHtml(a)}</span>`).join(', ');
      const topicsChip = parsed.topics.length === 1 && parsed.topics[0] === 'general'
        ? ''
        : ` on ${parsed.topics.map((t) => `<span class="target">#${escapeHtml(t)}</span>`).join(', ')}`;
      const total = parsed.agents.length * parsed.topics.length;
      const messageReady = parsed.message.length > 0;

      // Explosion warning: any time we'd fan out across multiple topics,
      // give the user an explicit count + an Escape Topics shortcut.
      const explode = parsed.topics.length > 1 && parsed.topics.some((t) => t !== 'general');
      const escapeBtn = explode
        ? ` <button class="escape-topics" data-escape-topics type="button">Escape Topics</button>`
        : '';
      const countNote = total > 1
        ? ` <span class="explode">→ ${total} messages</span>`
        : '';

      hint.innerHTML = messageReady
        ? `Sending to ${list}${topicsChip}${countNote}${escapeBtn}`
        : `${list}${topicsChip}${countNote}${escapeBtn} — type a message`;
      sendBtn.disabled = !messageReady;
      sendBtn.textContent = total > 1 ? `Send → ${total}` : 'Send';

      // Wire the Escape Topics button (re-bound on every render).
      hint.querySelector<HTMLElement>('[data-escape-topics]')?.addEventListener('click', () => {
        // Insert a space after each leading `#` token so the parser stops
        // recognising them as topics. Leaves the body text + caret intact.
        input.value = neutralizeLeadingTopics(input.value);
        input.focus();
        updateHint();
      });
    } else {
      hint.innerHTML = `No target — type <span class="target">@</span> to pick an agent, <span class="target">#</span> for a topic.`;
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
    if (e.key !== 'Enter') return;
    // Honor the Settings → Preferences "Submit mode" choice.
    //   'enter'      → Enter sends, Shift+Enter inserts newline.
    //   'cmd-enter'  → Cmd/Ctrl+Enter sends, Enter inserts newline (default).
    const submitMode = readSubmitMode();
    const wantsSend = submitMode === 'enter'
      ? !e.shiftKey
      : (e.metaKey || e.ctrlKey);
    if (wantsSend) {
      e.preventDefault();
      if (!sendBtn.disabled) handleSend(input);
    }
  });
  input.addEventListener('blur', () => {
    // Touch on mobile: blur fires before the synthesized click/pointerdown
    // on the popover item. Skip the close if a pop interaction is in flight.
    if (mention.isInteracting()) return;
    setTimeout(() => {
      if (!mention.isInteracting()) mention.close();
    }, 200);
  });
  sendBtn.addEventListener('click', () => handleSend(input));
  updateHint();
}

/* ── @-mention autocomplete ────────────────────────────────────────── */

type MentionApi = {
  isOpen: () => boolean;
  isInteracting: () => boolean;
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
  let lastPartial: string | null = null;
  // Set briefly when a pointer (touch or mouse) lands on a popover item;
  // the textarea's blur handler reads it to avoid closing the popover
  // mid-tap on mobile, where the synthesized click arrives AFTER blur.
  let interactingWithPopover = false;

  const close = () => {
    if (pop) { pop.remove(); pop = null; }
    matches = [];
    activeRange = null;
    lastPartial = null;
    selectedIdx = 0;
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
      // pointerdown covers both touch and mouse. preventDefault keeps the
      // textarea focused so the blur-close doesn't race the tap on mobile.
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        interactingWithPopover = true;
        selectedIdx = Number(el.dataset['idx']);
        pick();
        // Release the guard after pick() runs.
        setTimeout(() => { interactingWithPopover = false; }, 50);
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
    // Reset highlight to the top match whenever the typed partial changes
    // (typing "@brain" should land you on brain-hygiene, not whatever index
    // your mouse last hovered over). Hover/arrow within the same partial
    // still preserves selectedIdx because lastPartial hasn't changed.
    if (tok.partial !== lastPartial) {
      selectedIdx = 0;
      lastPartial = tok.partial;
    } else {
      selectedIdx = Math.min(selectedIdx, Math.max(0, matches.length - 1));
    }
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
    // Mirror the autocomplete into the sidebar: add the agent to the
    // selection (additive — composer can target multiple) and expand
    // every team containing them so the row is visible in the tree.
    if (!state.selectedAgents.has(name)) {
      state.selectedAgents.add(name);
      void import('./state.ts').then((s) => s.emit('selection-changed'));
    }
    void import('./sidebar.ts').then((s) => s.ensureAgentVisible(name));
    afterSelect();
  };

  const move = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    selectedIdx = (selectedIdx + dir + matches.length) % matches.length;
    render();
  };

  return {
    isOpen: () => pop !== null,
    isInteracting: () => interactingWithPopover,
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
    // suspended + failed → same "down" indicator
    case 'suspended':
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

type Parsed = { agents: string[]; topics: string[]; message: string };

/**
 * Parse the composer with paste-safety guards:
 *   • `@X` consumes only if X is a registered agent — pasting a tweet
 *     that starts with `@someuser` won't accidentally target anyone.
 *   • `#Y` consumes only after at least one `@` has been consumed —
 *     pasting "# Introduction" or "# TODO" stays inline.
 *   • Multiple `#topic` tokens accumulate (deduped). The actual send
 *     fans out as a Cartesian product: agents × topics.
 *   • Tokens are only recognized in the leading prefix.
 *
 *   "@a hello"                  → agents=['a'], topics=['general']
 *   "@a @b #release fix"        → agents=['a','b'], topics=['release']
 *   "@a #x #y hi"               → 2 messages (a/x, a/y)
 *   "@a @b #x #y hi"            → 4 messages
 *   "@notareal hi"              → @notareal unknown → msg='@notareal hi'
 *   "# Introduction"            → no @ → msg='# Introduction'
 */
function parseComposer(text: string): Parsed {
  const knownAgents = new Set(state.agents.map((a) => a.name));
  let rest = text.replace(/^\s+/, '');
  const agents: string[] = [];
  const topics: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const at = rest.match(/^@([a-zA-Z0-9_\-/]+)(\s+|$)/);
    if (at && knownAgents.has(at[1]!)) {
      if (!agents.includes(at[1]!)) agents.push(at[1]!);
      rest = rest.slice(at[0].length).replace(/^\s+/, '');
      continue;
    }
    const hash = rest.match(/^#([a-zA-Z0-9_\-]+)(\s+|$)/);
    if (hash && agents.length > 0) {
      if (!topics.includes(hash[1]!)) topics.push(hash[1]!);
      rest = rest.slice(hash[0].length).replace(/^\s+/, '');
      continue;
    }
    break;
  }
  return {
    agents,
    topics: topics.length > 0 ? topics : ['general'],
    message: rest.trim(),
  };
}

async function handleSend(input: HTMLTextAreaElement): Promise<void> {
  const parsed = parseComposer(input.value);
  if (parsed.agents.length === 0 || !parsed.message) return;

  // Cartesian fanout — one optimistic row + one POST per (agent × topic)
  // pair. Each lives in the recipient agent's thread (independent of topic).
  // Failures get individual toasts; the rest still go through.
  const now = new Date().toISOString();
  const pending: Array<{
    agent: string;
    topic: string;
    optimisticId: number;
    list: DashboardMessage[];
  }> = [];
  let stamp = Date.now();
  for (const agent of parsed.agents) {
    const list = state.threads[agent] ?? [];
    for (const topic of parsed.topics) {
      const optimisticId = -(stamp++);
      list.push({
        id: optimisticId,
        agent,
        direction: 'to_agent',
        sourceAgent: null,
        targetAgent: agent,
        topic,
        message: parsed.message,
        queueId: null,
        deliveryStatus: 'pending',
        withdrawn: false,
        createdAt: now,
      });
      pending.push({ agent, topic, optimisticId, list });
    }
    state.threads[agent] = list;
  }
  renderThread();
  // Repopulate the input with the same leading prefix so the user can
  // keep typing in the same channel without retyping @ + #. Persist the
  // prefix so it survives reloads.
  const prefix = buildPrefix(parsed.agents, parsed.topics);
  input.value = prefix;
  savePrefix(prefix);
  input.setSelectionRange(input.value.length, input.value.length);
  input.focus();
  // Refresh hint + send-button state from the new value.
  input.dispatchEvent(new Event('input'));

  let okCount = 0;
  let failCount = 0;
  await Promise.all(pending.map(async ({ agent, topic, optimisticId, list }) => {
    try {
      const target = agent.includes(':') || agent.includes('/') ? agent : `agent:${agent}`;
      const res = await fetch('/api/dashboard/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ agent: target, message: parsed.message, topic }),
      });
      if (!res.ok) {
        const idx = list.findIndex((m) => m.id === optimisticId);
        if (idx >= 0) list.splice(idx, 1);
        failCount++;
        const body = await res.json().catch(() => null);
        toast(`@${agent} #${topic}: ${body?.error ?? 'send failed'}`, 'error');
      } else {
        okCount++;
      }
    } catch {
      const idx = list.findIndex((m) => m.id === optimisticId);
      if (idx >= 0) list.splice(idx, 1);
      failCount++;
      toast(`@${agent} #${topic}: network error`, 'error');
    }
  }));
  renderThread();
  if (okCount > 1 && failCount === 0) {
    toast(`Sent ${okCount} messages`);
  }
}

/* ── helpers ───────────────────────────────────────────────────────── */

/**
 * Read the composer submit-mode preference from localStorage. Same key
 * the Settings page writes to (`dashboardPrefs_v3`).
 *   'cmd-enter' (default) — Cmd/Ctrl+Enter sends, Enter is a newline.
 *   'enter'               — Enter sends, Shift+Enter is a newline.
 */
function readSubmitMode(): 'cmd-enter' | 'enter' {
  try {
    const raw = JSON.parse(localStorage.getItem('dashboardPrefs_v3') ?? '{}');
    return raw.submitMode === 'enter' ? 'enter' : 'cmd-enter';
  } catch {
    return 'cmd-enter';
  }
}

/** Reconstruct the leading prefix (no message body) for repopulation. */
function buildPrefix(agents: string[], topics: string[]): string {
  if (agents.length === 0) return '';
  const ats = agents.map((a) => `@${a}`).join(' ');
  const hashes = topics
    .filter((t) => t !== 'general')
    .map((t) => `#${t}`)
    .join(' ');
  return hashes ? `${ats} ${hashes} ` : `${ats} `;
}

const PREFIX_KEY = 'v3_composer_prefix';
function savePrefix(prefix: string): void {
  try { localStorage.setItem(PREFIX_KEY, prefix); } catch {}
}
function loadPrefix(): string {
  try { return localStorage.getItem(PREFIX_KEY) ?? ''; } catch { return ''; }
}

/**
 * Walk the leading prefix and insert a space after each `#X` token so
 * the parser stops recognising it as a topic. Leaves `@X` tokens alone
 * (they're recipient identity, not the source of the explosion warning).
 *
 *   "@a #x #y hi"  →  "@a # x # y hi"
 *   "@a @b #x hi"  →  "@a @b # x hi"
 */
function neutralizeLeadingTopics(text: string): string {
  const lead = text.match(/^\s+/)?.[0] ?? '';
  let rest = text.slice(lead.length);
  const known = new Set(state.agents.map((a) => a.name));
  const out: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const at = rest.match(/^@([a-zA-Z0-9_\-/]+)(\s+|$)/);
    if (at && known.has(at[1]!)) {
      out.push(at[0]);
      rest = rest.slice(at[0].length);
      continue;
    }
    const hash = rest.match(/^(#)([a-zA-Z0-9_\-]+)(\s+|$)/);
    if (hash) {
      // Insert a space after # so it no longer matches the topic regex.
      out.push(`${hash[1]} ${hash[2]}${hash[3]}`);
      rest = rest.slice(hash[0].length);
      continue;
    }
    break;
  }
  return lead + out.join('') + rest;
}

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
