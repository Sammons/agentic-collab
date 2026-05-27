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
import { state, on, authHeaders, agentsByName, isFocusMode, toggleFocusMode, updateFocusTargets } from './state.ts';
import { registerRoute, go } from './routing.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { initVoice, voiceState, clearUsedFlag } from './voice.ts';
import { escapeHtml, formatTime, toast } from './util.ts';

// Threads whose name isn't a registered agent but still belongs in the
// merged feed — operator-visible system context (approval auto-notify,
// lifecycle banners, etc.).
const SYSTEM_THREADS = new Set(['dashboard', 'system']);

// Staged files: list of file IDs ready to attach to the next message.
// Files are uploaded to orchestrator storage on drag-drop/paste,
// then attached to the message when Send is clicked.
type StagedFile = { id: string; name: string; size: number };
const stagedFiles: StagedFile[] = [];

// Reference to the current updateHint function for direct invocation from
// handleFileUpload. Populated by wire() when the dashboard is mounted.
let currentUpdateHint: (() => void) | null = null;

/** Get staged file IDs. */
function getStagedFileIds(): string[] {
  console.log('[DEBUG] getStagedFileIds called, stagedFiles:', JSON.stringify(stagedFiles));
  return stagedFiles.map(f => f.id);
}

/** Get staged file count for display. */
function getStagedFileCount(): number {
  return stagedFiles.length;
}

/** Get staged file names for display. */
function getStagedFileNames(): string[] {
  return stagedFiles.map(f => f.name);
}

/** Clear all staged files after send. */
function clearStagedFiles(): void {
  stagedFiles.length = 0;
}

/** Add a staged file. */
function addStagedFile(file: StagedFile): void {
  console.log('[DEBUG] addStagedFile called:', JSON.stringify(file));
  stagedFiles.push(file);
  console.log('[DEBUG] stagedFiles after add:', JSON.stringify(stagedFiles));
}

/** Remove a staged file by ID. */
function removeStagedFile(id: string): void {
  console.log('[DEBUG] removeStagedFile called with id:', id);
  console.log('[DEBUG] stagedFiles before remove:', JSON.stringify(stagedFiles));
  const idx = stagedFiles.findIndex(f => f.id === id);
  console.log('[DEBUG] found index:', idx);
  if (idx >= 0) stagedFiles.splice(idx, 1);
  console.log('[DEBUG] stagedFiles after remove:', JSON.stringify(stagedFiles));
}

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
        <div class="staged-files-row" data-staged-files></div>
        <div class="voice-status" data-voice-status style="display:none"></div>
        <div class="ctrls">
          <span class="hint" data-target-hint>No target — start with <span class="target">@agent</span> to send.</span>
          <span class="spacer"></span>
          <div class="voice-ctrls" data-voice-toggle>
            <button data-mode="off" class="active" title="Voice off">Off</button>
            <button data-mode="ptt" title="Push-to-talk">PTT</button>
          </div>
          <button class="voice-btn inactive" data-voice-btn title="Hold to speak">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
          </button>
          <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> send</span>
          <button class="btn primary" data-send disabled>Send</button>
        </div>
      </div>
    </div>
  `;

  // Initial load — don't rely on events since they may have already fired
  void loadInitialFeed();
  wire(root);

  // Subscribe to state changes.
  // For new messages: cache the body and schedule debounced feed re-fetch
  detachers.push(on('message', (msg) => {
    const m = msg as DashboardMessage;
    if (m.id > 0) messageCache.set(m.id, m);
    if (state.selectedAgents.has(m.agent) || SYSTEM_THREADS.has(m.agent)) {
      scheduleRefetch();
    }
  }));
  detachers.push(on('message-withdrawn', (msg) => {
    const m = msg as DashboardMessage;
    const idx = feedState.messages.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      feedState.messages[idx] = m;
      scheduleRender();
    }
  }));
  detachers.push(on('selection-changed', () => {
    updateFilterSummary();
    // Selection changed — need fresh fetch from server
    void loadInitialFeed();
  }));
  detachers.push(on('agents-changed', () => {
    updateFilterSummary();
    // Don't re-fetch on agent status changes, just update UI
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
  // Clear any pending debounced render
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  // Clear the updateHint reference to avoid calling a stale closure
  currentUpdateHint = null;
}

// ── Virtual scroll state ──────────────────────────────────────────────────
// Instead of loading all messages into the DOM, we fetch pages from the server
// and only render what's visible + a buffer. This keeps DOM size ~50-100 nodes.

const PAGE_SIZE = 25;
const SCROLL_BUFFER = 20; // extra messages above/below viewport

// Content cache: id → full message body. Survives across feed re-fetches so we
// don't re-download bodies we already have. The feed endpoint returns thin
// results; we hydrate from cache or fetch missing bodies.
const messageCache = new Map<number, DashboardMessage>();

type FeedState = {
  messages: DashboardMessage[];
  hasMore: boolean;      // older messages available
  hasNewer: boolean;     // newer messages available (when scrolled up)
  loading: boolean;
  lastAgentsKey: string; // to detect selection changes
  totalCount: number;
};

const feedState: FeedState = {
  messages: [],
  hasMore: false,
  hasNewer: false,
  loading: false,
  lastAgentsKey: '',
  totalCount: 0,
};

// Render state
let renderTimer: ReturnType<typeof setTimeout> | null = null;
const RENDER_DEBOUNCE_MS = 50;

function scheduleRender(): void {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void renderFeed();
  }, RENDER_DEBOUNCE_MS);
}

// Debounce feed re-fetch on rapid message arrivals
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
const REFETCH_DEBOUNCE_MS = 300;

function scheduleRefetch(): void {
  if (refetchTimer !== null) clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void loadInitialFeed();
  }, REFETCH_DEBOUNCE_MS);
}

function getAgentsKey(): string {
  return [...state.selectedAgents].sort().join(',');
}

async function fetchFeed(before?: number, after?: number): Promise<void> {
  if (feedState.loading) return;
  feedState.loading = true;

  const agents = [...state.selectedAgents, ...SYSTEM_THREADS];
  const params = new URLSearchParams();
  params.set('agents', agents.join(','));
  params.set('limit', String(PAGE_SIZE));
  if (before !== undefined) params.set('before', String(before));
  if (after !== undefined) params.set('after', String(after));

  try {
    const res = await fetch(`/api/dashboard/messages/feed?${params}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;

    const data = await res.json() as {
      messages: DashboardMessage[];
      hasMore: boolean;
      hasNewer: boolean;
      totalCount: number;
    };

    // Populate content cache with fetched messages
    for (const m of data.messages) {
      if (m.id > 0) messageCache.set(m.id, m);
    }

    if (before !== undefined) {
      // Prepend older messages
      feedState.messages = [...data.messages, ...feedState.messages];
      feedState.hasMore = data.hasMore;
    } else if (after !== undefined) {
      // Append newer messages
      feedState.messages = [...feedState.messages, ...data.messages];
      feedState.hasNewer = data.hasNewer;
    } else {
      // Initial load — replace wholesale with server truth
      feedState.messages = data.messages;
      feedState.hasMore = data.hasMore;
      feedState.hasNewer = data.hasNewer;
    }
    feedState.totalCount = data.totalCount;
  } finally {
    feedState.loading = false;
  }
}

async function loadInitialFeed(): Promise<void> {
  feedState.messages = [];
  feedState.hasMore = false;
  feedState.hasNewer = false;
  feedState.lastAgentsKey = getAgentsKey();
  await fetchFeed();
  scheduleRender();
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

/**
 * Render the chat feed using backend-paginated messages.
 * Only renders messages currently in feedState — scroll handlers trigger
 * additional fetches as needed.
 */
async function renderFeed(forceScrollBottom = false): Promise<void> {
  const root = document.getElementById('chat-thread');
  if (!root) return;

  // Check if agent selection changed — need fresh fetch
  const currentKey = getAgentsKey();
  if (currentKey !== feedState.lastAgentsKey) {
    await loadInitialFeed();
    return; // loadInitialFeed calls scheduleRender
  }

  // Capture scroll state before DOM update
  const scrollGap = root.scrollHeight - root.scrollTop - root.clientHeight;
  const wasAtBottom = scrollGap < 60;

  if (feedState.messages.length === 0 && !feedState.loading) {
    root.innerHTML = `
      <div class="empty">
        ${state.selectedAgents.size === 0
          ? 'Check at least one agent in the sidebar to see messages.'
          : 'No messages yet. Start one with <code class="inl">@agent-name</code> below.'}
      </div>
    `;
    return;
  }

  // Build DOM
  const fragment = document.createDocumentFragment();

  // "Load older" button
  if (feedState.hasMore && !feedState.loading) {
    const wrap = document.createElement('div');
    wrap.className = 'load-older-wrap';
    wrap.innerHTML = '<button class="btn ghost" data-load-older>Load older messages</button>';
    fragment.appendChild(wrap);
  } else if (feedState.loading) {
    const wrap = document.createElement('div');
    wrap.className = 'load-older-wrap';
    wrap.innerHTML = '<span class="loading">Loading...</span>';
    fragment.appendChild(wrap);
  }

  // Render messages oldest-first (chat convention: newest at bottom)
  const chronological = [...feedState.messages].reverse();
  for (const m of chronological) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = msgHtml(m);
    const el = wrapper.firstElementChild;
    if (el) fragment.appendChild(el);
  }

  root.replaceChildren(fragment);
  wireProfileTriggers(root);
  wireFeedControls(root);
  wireCollapsibleMessages(root);
  wireCopyOnClick(root);

  // Scroll handling
  if (pendingFocusId !== null) {
    const target = root.querySelector<HTMLElement>(`[data-msg-id="${pendingFocusId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      target.classList.add('focus-flash');
      setTimeout(() => target.classList.remove('focus-flash'), 1800);
    } else {
      root.scrollTop = root.scrollHeight;
    }
    pendingFocusId = null;
  } else if (forceScrollBottom || wasAtBottom) {
    root.scrollTop = root.scrollHeight;
  }
}

function wireFeedControls(root: HTMLElement): void {
  const loadOlderBtn = root.querySelector<HTMLButtonElement>('[data-load-older]');
  if (loadOlderBtn) {
    loadOlderBtn.addEventListener('click', async () => {
      if (feedState.messages.length === 0) return;
      // Messages are stored newest-first (DESC), so oldest is at the end
      const oldestId = feedState.messages[feedState.messages.length - 1]!.id;
      await fetchFeed(oldestId);
      scheduleRender();
    });
  }
}

const COLLAPSE_THRESHOLD = 200;

function wireCollapsibleMessages(root: HTMLElement): void {
  const bodies = root.querySelectorAll<HTMLElement>('.msg .body');
  for (const body of bodies) {
    const text = body.textContent ?? '';
    if (text.length > COLLAPSE_THRESHOLD) {
      body.classList.add('collapsed');
      // Button goes AFTER body (sibling) so it's not clipped by line-clamp overflow
      const btn = document.createElement('button');
      btn.className = 'expand-btn';
      btn.textContent = '… more';
      btn.addEventListener('click', () => {
        const isCollapsed = body.classList.contains('collapsed');
        body.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? 'less' : '… more';
      });
      body.after(btn);
    }
  }
}

function wireCopyOnClick(root: HTMLElement): void {
  const bodies = root.querySelectorAll<HTMLElement>('.msg .body[data-raw-message]');
  for (const body of bodies) {
    body.style.cursor = 'pointer';
    body.addEventListener('click', async (e) => {
      // Don't copy if clicking a link or button inside the body
      if ((e.target as HTMLElement).closest('a, button')) return;

      const raw = body.dataset['rawMessage'] ?? body.textContent ?? '';
      try {
        await navigator.clipboard.writeText(raw);
        body.classList.add('copied');
        setTimeout(() => body.classList.remove('copied'), 600);
      } catch {
        // Clipboard API may fail in some contexts
      }
    });
  }
}

/** Trigger initial feed load or re-render. */
function renderThread(forceScrollBottom = false): void {
  if (feedState.lastAgentsKey !== getAgentsKey()) {
    void loadInitialFeed();
  } else {
    void renderFeed(forceScrollBottom);
  }
}

// Reset feed state on init (reconnect)
on('init', () => {
  feedState.messages = [];
  feedState.hasMore = false;
  feedState.hasNewer = false;
  feedState.lastAgentsKey = '';
});

let pendingFocusId: number | null = null;

/**
 * Request that the next chat render scrolls to + highlights a specific
 * message id. Called by search.ts when the user clicks a message result.
 */
export function focusMessage(id: number): void {
  pendingFocusId = id;
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
  const fileCount = m.fileIds?.length ?? 0;
  const filesHtml = fileCount > 0
    ? `<div class="attachments">${m.fileIds!.map((id, i) =>
        `<a href="/api/files/${escapeHtml(id)}" target="_blank" class="file-link" title="Open file in new tab">📎 File ${i + 1}</a>`
      ).join(' ')}</div>`
    : '';
  return `
    <div class="${cls.join(' ')}" data-msg-id="${m.id}">
      <div class="head">
        <span class="who" data-profile-for="${escapeHtml(fromAgent ?? '')}">${statusDot(fromAgent)}${escapeHtml(whoLabel)}</span>
        <span class="arrow">→</span>
        <span class="to" data-profile-for="${escapeHtml(toAgent ?? '')}">${statusDot(toAgent)}${escapeHtml(toLabel)}</span>
        <span class="topic ${topic === 'general' ? 'default' : ''}" title="topic">#${escapeHtml(topic)}</span>
        <span class="time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="body" data-raw-message="${escapeHtml(m.message)}">${m.withdrawn ? '(withdrawn)' : renderMessageBody(m.message, m.id)}${filesHtml}</div>
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
  const a = agentsByName.get(agentName);
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
  const a = agentsByName.get(agentName);
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

// Markdown cache: avoid re-parsing unchanged messages on every render.
// Key: message ID + content length (fast proxy for content identity).
const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_MAX = 2000;

function renderMessageBody(text: string, msgId?: number): string {
  const cacheKey = msgId !== undefined ? `${msgId}:${text.length}` : null;
  if (cacheKey) {
    const cached = markdownCache.get(cacheKey);
    if (cached) return cached;
  }

  // Normalize excessive whitespace: collapse 3+ newlines to 2 (one blank line)
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();

  // Escape first, then apply markdown rendering
  let html = escapeHtml(normalized);
  html = renderMarkdown(html);
  // Highlight @mentions (after markdown so they don't interfere with link syntax)
  html = html.replace(/(^|[\s>])(@[a-zA-Z0-9_\-/]+)/g, (_, lead, mention) => {
    return `${lead}<span class="mention">${mention}</span>`;
  });

  if (cacheKey) {
    // Evict oldest entries if cache is full
    if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
      const first = markdownCache.keys().next().value;
      if (first) markdownCache.delete(first);
    }
    markdownCache.set(cacheKey, html);
  }
  return html;
}

/* ── agent name click → direct to watch ────────────────────────────── */

function wireProfileTriggers(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('[data-profile-for]').forEach((el) => {
    const agentName = el.dataset['profileFor'];
    if (!agentName) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (agentsByName.has(agentName)) {
        go({ kind: 'watch', agentName });
      }
    });
  });
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

  // Consume any pending composer text from cross-route navigation (e.g. search → dashboard)
  if (state.pendingComposerText) {
    input.value = state.pendingComposerText;
    state.pendingComposerText = null;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const updateHint = () => {
    const parsed = parseComposer(input.value);

    // If in focus mode, keep the focus targets in sync with composer targets
    if (isFocusMode() && parsed.agents.length > 0) {
      updateFocusTargets(parsed.agents);
    }

    if (parsed.agents.length > 0) {
      const list = parsed.agents.map((a) => `<span class="target">@${escapeHtml(a)}</span>`).join(', ');
      const topicsChip = parsed.topics.length === 1 && parsed.topics[0] === 'general'
        ? ''
        : ` on ${parsed.topics.map((t) => `<span class="target">#${escapeHtml(t)}</span>`).join(', ')}`;
      const total = parsed.agents.length * parsed.topics.length;
      const hasFiles = getStagedFileCount() > 0;
      const messageReady = parsed.message.length > 0 || hasFiles;

      // Check if any target is a template (will spawn new ephemeral)
      const templateTargets = parsed.agents.filter((a) => {
        const agent = agentsByName.get(a);
        return agent?.isTemplate === true;
      });
      const spawnNote = templateTargets.length > 0
        ? ` <span class="spawn-warn">⚡ spawns new ${templateTargets.map(t => `@${escapeHtml(t)}`).join(', ')}</span>`
        : '';

      // Check if any target is dead (needs spawn/resume before message delivery)
      const deadTargets = parsed.agents.filter((a) => {
        const agent = agentsByName.get(a);
        if (!agent || agent.isTemplate) return false;
        return ['void', 'failed', 'suspended'].includes(agent.state);
      });
      const allTargetsDead = deadTargets.length > 0 && deadTargets.length === parsed.agents.length;

      // Focus button: toggles chat filter to only show the targeted agents
      const focused = isFocusMode();
      const focusBtn = ` <button class="focus-btn${focused ? ' on' : ''}" data-focus type="button">${focused ? '⊗ Unfocus' : '⊙ Focus'}</button>`;

      // Explosion warning: any time we'd fan out across multiple topics,
      // give the user an explicit count + an Escape Topics shortcut.
      const explode = parsed.topics.length > 1 && parsed.topics.some((t) => t !== 'general');
      const escapeBtn = explode
        ? ` <button class="escape-topics" data-escape-topics type="button">Escape Topics</button>`
        : '';
      const countNote = total > 1
        ? ` <span class="explode">→ ${total} messages</span>`
        : '';

      // Staged files indicator
      const stagedCount = getStagedFileCount();
      const stagedNote = stagedCount > 0
        ? ` <span class="staged-files">📎 ${stagedCount} file${stagedCount > 1 ? 's' : ''}</span>`
        : '';

      // Button text: "Spawn" if all targets are dead, otherwise "Send"
      const btnText = allTargetsDead
        ? (total > 1 ? `Spawn → ${total}` : 'Spawn')
        : (total > 1 ? `Send → ${total}` : 'Send');

      const hasMessage = parsed.message.length > 0;
      const hintPrefix = hasMessage ? 'Sending to' : (hasFiles ? 'Attaching to' : '');
      hint.innerHTML = messageReady
        ? `${hintPrefix} ${list}${topicsChip}${spawnNote}${stagedNote}${countNote}${focusBtn}${escapeBtn}`
        : `${list}${topicsChip}${spawnNote}${stagedNote}${countNote}${focusBtn}${escapeBtn} — type a message or attach files`;
      sendBtn.disabled = !messageReady;
      sendBtn.textContent = btnText;

      // Wire the Focus button (re-bound on every render).
      hint.querySelector<HTMLElement>('[data-focus]')?.addEventListener('click', () => {
        toggleFocusMode(parsed.agents);
        updateHint();
      });

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

  // Staged files row — shows chips for each staged file with remove button
  const stagedRow = root.querySelector<HTMLElement>('[data-staged-files]');
  const renderStagedFiles = () => {
    console.log('[DEBUG] renderStagedFiles called, stagedFiles.length:', stagedFiles.length);
    if (!stagedRow) {
      console.log('[DEBUG] stagedRow is null!');
      return;
    }
    if (stagedFiles.length === 0) {
      stagedRow.innerHTML = '';
      stagedRow.style.display = 'none';
      return;
    }
    stagedRow.style.display = 'flex';
    const html = stagedFiles.map(f => `
      <span class="file-chip" data-file-id="${escapeHtml(f.id)}">
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="size">${formatFileSize(f.size)}</span>
        <button class="remove" title="Remove file">×</button>
      </span>
    `).join('');
    console.log('[DEBUG] renderStagedFiles HTML:', html);
    stagedRow.innerHTML = html;
    // Wire remove buttons
    stagedRow.querySelectorAll<HTMLElement>('.file-chip .remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const chip = btn.closest<HTMLElement>('.file-chip');
        const fileId = chip?.dataset['fileId'];
        console.log('[DEBUG] remove click, fileId:', fileId);
        if (fileId) {
          removeStagedFile(fileId);
          renderStagedFiles();
          updateHint();
        }
      });
    });
  };

  // Register the updateHint function for direct invocation from handleFileUpload
  currentUpdateHint = () => {
    updateHint();
    renderStagedFiles();
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

  // Drag-and-drop file upload on the chat pane
  const chatPane = root.querySelector<HTMLElement>('.chat-pane');
  if (chatPane) {
    chatPane.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatPane.classList.add('drag-over');
    });
    chatPane.addEventListener('dragleave', (e) => {
      // Only remove highlight when leaving the pane entirely, not child elements
      if (!chatPane.contains(e.relatedTarget as Node)) {
        chatPane.classList.remove('drag-over');
      }
    });
    chatPane.addEventListener('drop', (e) => {
      console.log('[DEBUG] drop event received');
      e.preventDefault();
      chatPane.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      console.log('[DEBUG] drop files:', files?.length);
      if (files && files.length > 0) {
        const parsed = parseComposer(input.value);
        console.log('[DEBUG] parseComposer result:', JSON.stringify({ agents: parsed.agents, topics: parsed.topics }));
        if (parsed.agents.length === 0) {
          toast('Drop target missing — start with @agent-name to specify where to upload', 'error');
          return;
        }
        console.log('[DEBUG] calling handleFileUpload with', files.length, 'files');
        // Upload files without message text — file attachment only, fan out to all agents
        // Keep composer text so user can continue editing/send their message after upload
        handleFileUpload(Array.from(files), parsed.agents, '', parsed.topics[0] ?? 'file-upload');
      }
    });
  }

  // Paste file from clipboard
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    const parsed = parseComposer(input.value);
    if (parsed.agents.length === 0) {
      toast('Paste target missing — start with @agent-name to specify where to upload', 'error');
      return;
    }
    // Upload files without message text — file attachment only, fan out to all agents
    // Keep composer text so user can continue editing/send their message after upload
    handleFileUpload(files, parsed.agents, '', parsed.topics[0] ?? 'file-upload');
  });

  updateHint();

  // Initialize voice controls
  const voiceToggle = root.querySelector<HTMLElement>('[data-voice-toggle]');
  const voiceBtn = root.querySelector<HTMLElement>('[data-voice-btn]');
  const voiceStatus = root.querySelector<HTMLElement>('[data-voice-status]');
  if (voiceToggle && voiceBtn && voiceStatus) {
    initVoice(input, voiceStatus, voiceToggle, voiceBtn).then((cleanup) => {
      detachers.push(cleanup);
    });
  }

  // Initial render of staged files (if any survive from before route change)
  renderStagedFiles();
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
      const agent = agentsByName.get(name);
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
  // Collect staged file IDs first, before validation
  const fileIds = getStagedFileIds();
  console.log('[DEBUG] handleSend: parsed.message=', JSON.stringify(parsed.message), 'fileIds=', fileIds);

  // Allow send if there's a message OR there are staged files
  if (parsed.agents.length === 0) return;
  if (!parsed.message && fileIds.length === 0) return;
  if (fileIds.length > 0) {
    clearStagedFiles();
    // Update UI to reflect cleared staging
    if (currentUpdateHint) currentUpdateHint();
  }
  const finalMessage = parsed.message || '(attached files)';

  // Spawn dead agents before sending — suspended agents resume, others spawn
  const deadAgents = parsed.agents.filter((name) => {
    const agent = agentsByName.get(name);
    if (!agent || agent.isTemplate) return false;
    return ['void', 'failed', 'suspended'].includes(agent.state);
  });

  if (deadAgents.length > 0) {
    toast(`Spawning ${deadAgents.length} agent${deadAgents.length > 1 ? 's' : ''}…`);
    await Promise.all(deadAgents.map(async (name) => {
      const agent = agentsByName.get(name);
      if (!agent) return;
      const action = agent.state === 'suspended' ? 'resume' : 'spawn';
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(name)}/${action}`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          toast(`Failed to ${action} @${name}: ${body?.error ?? 'unknown'}`, 'error');
        }
      } catch {
        toast(`Failed to ${action} @${name}: network error`, 'error');
      }
    }));
  }

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
        message: finalMessage,
        fileIds: fileIds.length > 0 ? fileIds : null,
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
      const payload: Record<string, unknown> = { agent: target, message: finalMessage, topic };
      if (fileIds.length > 0) payload.fileIds = fileIds;
      const res = await fetch('/api/dashboard/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
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
  // Reset voice "used since send" flag so next voice session starts fresh
  clearUsedFlag();
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


/* ── file upload ───────────────────────────────────────────────────── */

const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Upload a file to orchestrator storage, returns file record. */
async function uploadFileToStorage(file: File): Promise<{ ok: boolean; id?: string; name?: string; size?: number; error?: string }> {
  const url = `/api/files?filename=${encodeURIComponent(file.name)}`;
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (state.token) headers['authorization'] = `Bearer ${state.token}`;

  const res = await fetch(url, { method: 'POST', headers, body: file });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return {
    ok: res.ok,
    id: body.id as string | undefined,
    name: body.name as string | undefined,
    size: body.size as number | undefined,
    error: body.error as string | undefined,
  };
}

async function handleFileUpload(files: File[], _agents: string[], _message: string, _topic: string = 'file-upload'): Promise<void> {
  if (files.length === 0) return;

  // Warn about large files
  const largeFiles = files.filter(f => f.size >= LARGE_FILE_THRESHOLD);
  if (largeFiles.length > 0) {
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const confirmed = window.confirm(
      `${largeFiles.length} file${largeFiles.length > 1 ? 's are' : ' is'} large (total ${formatFileSize(totalSize)}). Upload may take a while. Continue?`
    );
    if (!confirmed) return;
  }

  toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);

  try {
    // Upload all files to orchestrator storage
    const uploads = files.map(f => uploadFileToStorage(f));
    const results = await Promise.allSettled(uploads);

    let succeeded = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ok && result.value.id) {
        succeeded++;
        addStagedFile({
          id: result.value.id,
          name: result.value.name ?? 'unknown',
          size: result.value.size ?? 0,
        });
      } else {
        failed++;
      }
    }

    if (failed === 0) {
      toast(`Staged ${succeeded} file${succeeded > 1 ? 's' : ''} — will be attached to your next message`);
    } else {
      toast(`${failed} upload${failed > 1 ? 's' : ''} failed`, 'error');
    }

    // Trigger hint update to show staged files.
    if (currentUpdateHint) {
      currentUpdateHint();
    } else {
      const input = document.querySelector<HTMLTextAreaElement>('[data-composer-input]');
      if (input) input.dispatchEvent(new Event('input'));
    }
  } catch {
    toast('Upload failed', 'error');
  }
}
