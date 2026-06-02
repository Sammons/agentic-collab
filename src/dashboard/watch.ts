/**
 * Watch — live tmux peek for a specific agent.
 *
 * Polls /api/agents/:name/peek?lines=200 every 3s and renders the output
 * in a mono pane. Provides:
 *   - Back link → Agents
 *   - Pause/Resume polling
 *   - Special-key buttons (arrows, Enter/Esc/Tab/Space, Ctrl-c/x/z, y/n/q)
 *     → POST /api/agents/:name/keys
 *   - Type input with Send / Send↵ → POST /api/agents/:name/type
 *   - Open in tmux (copies attach command)
 *   - Stop watching → back to agents
 *
 * The polling cadence (3s) and key contract match the v2 watch-panel.ts so
 * the orchestrator behavior is unchanged.
 */
import type { AgentRecord } from '../shared/types.ts';
import { state, on, authHeaders } from './state.ts';
import { registerRoute, go, type Route } from './routing.ts';
import { escapeHtml, toast } from './util.ts';

const POLL_INTERVAL_MS = 3000;
const PEEK_LINES = 200;

let pollTimer: number | null = null;
let lastPeekAt: number = 0;
let paused = false;
let currentAgent: string | null = null;
// Signature of the watched agent's last-rendered header inputs. `agents-changed`
// fires for ANY agent update; we only rebuild the header when the watched
// agent's header-relevant state actually changed, to avoid churning (and
// disrupting hover/click on) the header buttons on every unrelated update.
let lastHeaderSig: string | null = null;
let agoTimer: number | null = null;

export function setupWatch(): void {
  registerRoute('watch', render);
}

function render(root: HTMLElement, route: Route): void {
  if (route.kind !== 'watch') return;
  const name = route.agentName;
  currentAgent = name;
  lastHeaderSig = headerSig(name);

  root.innerHTML = `
    <div class="watch-page">
      <div class="watch-hdr">${headerInnerHtml(name)}</div>

      <div class="watch-ctrls">
        <button class="ctrl" data-pause>${paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button class="ctrl" data-refresh>↻ Refresh</button>
        <div class="live ${paused ? 'paused' : ''}" data-live>
          <span class="pulse"></span>
          <span>Live</span>
          <span class="ago" data-ago>—</span>
        </div>
      </div>

      <pre class="watch-pane" data-pane><span class="loading">connecting…</span></pre>

      <div class="watch-keys">
        ${keyBtn('↑',     'Up')}
        ${keyBtn('↓',     'Down')}
        ${keyBtn('←',     'Left')}
        ${keyBtn('→',     'Right')}
        ${keyBtn('Enter', 'Enter', 'wide')}
        ${keyBtn('Esc',   'Escape', 'wide')}
        ${keyBtn('Tab',   'Tab', 'wide')}
        ${keyBtn('Space', 'Space', 'wide')}
        ${keyBtn('C-c',   'C-c', 'wide modifier')}
        ${keyBtn('C-x',   'C-x', 'wide modifier')}
        ${keyBtn('C-z',   'C-z', 'wide modifier')}
        ${keyBtn('y',     'y')}
        ${keyBtn('n',     'n')}
        ${keyBtn('q',     'q')}
      </div>

      <div class="watch-type">
        <div class="input-wrap">
          <input type="text" placeholder="Type literal text into the session…" data-type-input>
        </div>
        <button class="send" data-type-send>Send</button>
        <button class="send primary" data-type-send-enter>Send <span class="returnico">↵</span></button>
      </div>
    </div>
  `;

  wire(root, name);
  startPolling(name);

  // Live header re-render: when an agent dies, reboots, or otherwise changes
  // state, refresh the entire header (state-pill AND the Start/Kill action
  // buttons, whose visibility depends on state) and re-wire it. Previously only
  // the pill was patched, so the action buttons kept their route-entry snapshot
  // and went stale until a full navigation. The live pane/polling is untouched.
  detachers.push(on('agents-changed', () => {
    if (currentAgent !== name) return;
    const sig = headerSig(name);
    if (sig === lastHeaderSig) return; // watched agent's header inputs unchanged
    lastHeaderSig = sig;
    const hdr = document.querySelector<HTMLElement>('.watch-hdr');
    if (!hdr) return;
    hdr.innerHTML = headerInnerHtml(name);
    wireHeader(hdr, name);
  }));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'watch') {
      teardown();
    } else if ((r as Route).kind === 'watch') {
      const newName = (r as Extract<Route, { kind: 'watch' }>).agentName;
      if (newName !== currentAgent) {
        teardown();
      }
    }
  }));
}

const detachers: Array<() => void> = [];
function teardown(): void {
  stopPolling();
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
  currentAgent = null;
}

/* ── polling ───────────────────────────────────────────────────────── */

function startPolling(name: string): void {
  stopPolling();
  void doPeek(name);
  pollTimer = window.setInterval(() => {
    if (!paused) void doPeek(name);
  }, POLL_INTERVAL_MS);
  agoTimer = window.setInterval(updateAgo, 1000);
}
function stopPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
  if (agoTimer !== null) window.clearInterval(agoTimer);
  agoTimer = null;
}

async function doPeek(name: string): Promise<void> {
  if (currentAgent !== name) return;
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/peek?lines=${PEEK_LINES}`, {
      headers: authHeaders(),
    });
    const pane = document.querySelector<HTMLElement>('[data-pane]');
    if (!pane || currentAgent !== name) return;
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      pane.innerHTML = `<span class="err">peek failed: ${escapeHtml(body?.error ?? String(res.status))}</span>`;
      return;
    }
    const data = await res.json() as { output: string };
    pane.textContent = data.output ?? '';
    lastPeekAt = Date.now();
    pane.scrollTop = pane.scrollHeight;
    updateAgo();
  } catch (err) {
    const pane = document.querySelector<HTMLElement>('[data-pane]');
    if (pane && currentAgent === name) {
      pane.innerHTML = `<span class="err">network error</span>`;
    }
  }
}

function updateAgo(): void {
  const el = document.querySelector<HTMLElement>('[data-ago]');
  if (!el) return;
  if (!lastPeekAt) { el.textContent = '—'; return; }
  const ms = Date.now() - lastPeekAt;
  if (ms < 1000) el.textContent = 'just now';
  else if (ms < 60000) el.textContent = `${Math.floor(ms / 1000)}s ago`;
  else el.textContent = `${Math.floor(ms / 60000)}m ago`;
}

/* ── wiring ────────────────────────────────────────────────────────── */

/** Signature of the inputs `headerInnerHtml` renders, to skip no-op rebuilds.
 *  Includes the icon so a header re-render fires when the agent's icon changes. */
function headerSig(name: string): string {
  const agent = state.agents.find((a) => a.name === name);
  return agent ? `${agent.state}|${agent.icon ?? ''}` : 'unknown';
}

/**
 * Build the inner HTML of `.watch-hdr` from the agent's CURRENT state.
 * Called both at initial render and on every `agents-changed` so the
 * state-pill and the state-dependent Start/Kill buttons stay live.
 */
function headerInnerHtml(name: string): string {
  const agent = state.agents.find((a) => a.name === name);
  // State-aware lifecycle button (matches the profile popover behavior):
  // suspended/void/failed → Start (server folds to resume when suspended);
  // active/idle/spawning  → Kill. Transient states hide the button entirely.
  const isRunning = agent ? ['active', 'idle', 'spawning'].includes(agent.state) : false;
  const isTransient = agent ? ['suspending', 'resuming'].includes(agent.state) : false;
  const startLabel = agent?.state === 'suspended' ? 'Resume' : 'Start';
  const iconHtml = agent?.icon ? `<span class="agent-icon">${escapeHtml(agent.icon)}</span>` : '';
  return `
        <button class="back" data-back>←</button>
        <span class="breadcrumb">Watch</span>
        ${agent ? `<span class="state-pill ${agent.state}">${agent.state}</span>` : `<span class="state-pill failed">unknown</span>`}
        <h1 class="title">${iconHtml}${escapeHtml(name)}</h1>
        <div class="right">
          ${!isTransient && !isRunning ? `<button class="btn primary" data-start>${startLabel}</button>` : ''}
          ${isRunning ? `<button class="btn ghost" data-kill>Kill</button>` : ''}
          <button class="btn ghost" data-persona>Persona</button>
          <button class="btn ghost" data-open-tmux>↗ Open in tmux</button>
          <button class="btn ghost danger" data-delete>Delete</button>
          <button class="btn ghost" data-stop>Stop watching</button>
        </div>`;
}

function wire(root: HTMLElement, name: string): void {
  wireHeader(root, name);
  wireBody(root, name);
}

/** Wire the header buttons. Safe to call repeatedly after a header re-render. */
function wireHeader(root: HTMLElement, name: string): void {
  // Back from watch lands on chat (filtered to this agent) rather than
  // the agents grid — closer to the v2 "thread for the agent I was just
  // looking at" mental model. Stop watching does the same.
  const backToChat = async () => {
    state.selectedAgents.clear();
    state.selectedAgents.add(name);
    const s = await import('./state.ts');
    s.emit('selection-changed');
    go({ kind: 'dashboard' });
  };
  root.querySelector<HTMLElement>('[data-back]')?.addEventListener('click', () => void backToChat());
  root.querySelector<HTMLElement>('[data-stop]')?.addEventListener('click', () => void backToChat());
  root.querySelector<HTMLElement>('[data-open-tmux]')?.addEventListener('click', async () => {
    const a = state.agents.find((x) => x.name === name);
    const session = a?.tmuxSession ?? `agent-${name}`;
    const cmd = `tmux attach -t ${session}`;
    await navigator.clipboard?.writeText(cmd).catch(() => {});
    showToast(`Copied: ${cmd}`);
  });

  // Lifecycle (Start/Resume/Kill) — same handler as the profile popover.
  // /spawn folds to /resume server-side when state=suspended, so we always
  // POST to /spawn here regardless of which verb is showing.
  root.querySelector<HTMLElement>('[data-start]')?.addEventListener('click', () => {
    void lifecycleAction(name, 'spawn', 'starting');
  });
  root.querySelector<HTMLElement>('[data-kill]')?.addEventListener('click', () => {
    void lifecycleAction(name, 'kill', 'killing');
  });
  root.querySelector<HTMLElement>('[data-persona]')?.addEventListener('click', () => {
    // Persona editing is now its own full-page route (RFC-007 PR-B). Back
    // from that page returns here (the agent's Watch view).
    go({ kind: 'persona', name });
  });
  root.querySelector<HTMLElement>('[data-delete]')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete agent "${name}"? This will destroy the agent and remove it from the database.`)) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error ?? 'Delete failed', 'error');
        return;
      }
      showToast(`Deleted agent ${name}`);
      go({ kind: 'agents' });
    } catch {
      showToast('Network error', 'error');
    }
  });
}

/** Wire the static body controls (pause/refresh/keys/type). Wired once per render. */
function wireBody(root: HTMLElement, name: string): void {
  root.querySelector<HTMLElement>('[data-pause]')?.addEventListener('click', () => {
    paused = !paused;
    document.querySelector<HTMLElement>('[data-pause]')!.textContent = paused ? '▶ Resume' : '⏸ Pause';
    document.querySelector<HTMLElement>('[data-live]')!.classList.toggle('paused', paused);
    if (!paused) void doPeek(name);
  });
  root.querySelector<HTMLElement>('[data-refresh]')?.addEventListener('click', () => void doPeek(name));

  root.querySelectorAll<HTMLElement>('[data-keys]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const keys = btn.dataset['keys']!;
      btn.classList.add('sent');
      setTimeout(() => btn.classList.remove('sent'), 350);
      try {
        await fetch(`/api/agents/${encodeURIComponent(name)}/keys`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ keys }),
        });
        setTimeout(() => doPeek(name), 250);
      } catch {
        showToast('Send failed', 'error');
      }
    });
  });

  const input = root.querySelector<HTMLInputElement>('[data-type-input]');
  const send  = root.querySelector<HTMLElement>('[data-type-send]');
  const sendEnter = root.querySelector<HTMLElement>('[data-type-send-enter]');
  if (!input || !send || !sendEnter) return;

  const submit = async (pressEnter: boolean) => {
    const text = input.value;
    if (!text) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}/type`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text, pressEnter }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error ?? 'Type failed', 'error');
        return;
      }
      input.value = '';
      setTimeout(() => doPeek(name), 250);
    } catch {
      showToast('Network error', 'error');
    }
  };
  send.addEventListener('click', () => submit(false));
  sendEnter.addEventListener('click', () => submit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(true);
    }
  });
}

function keyBtn(label: string, keys: string, extra: string = ''): string {
  return `<button class="k ${extra}" data-keys="${escapeHtml(keys)}">${escapeHtml(label)}</button>`;
}

// Use toast from util.ts, aliased as showToast for backward compat
const showToast = toast;

async function lifecycleAction(agentName: string, action: string, gerund: string): Promise<void> {
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
    showToast(`${agentName} ${gerund}…`);
  } catch {
    showToast('Network error', 'error');
  }
}
