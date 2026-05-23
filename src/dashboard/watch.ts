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

const POLL_INTERVAL_MS = 3000;
const PEEK_LINES = 200;

let pollTimer: number | null = null;
let lastPeekAt: number = 0;
let paused = false;
let currentAgent: string | null = null;
let agoTimer: number | null = null;

export function setupWatch(): void {
  registerRoute('watch', render);
}

function render(root: HTMLElement, route: Route): void {
  if (route.kind !== 'watch') return;
  const name = route.agentName;
  currentAgent = name;
  const agent = state.agents.find((a) => a.name === name);

  root.innerHTML = `
    <div class="watch-page">
      <div class="watch-hdr">
        <button class="back" data-back>← Back to chat</button>
        <div class="title-block">
          <div class="super"><span>Watching</span> <span class="crumb-arrow">/</span> <span class="name">${escapeHtml(name)}</span></div>
          <h1 class="title">
            ${escapeHtml(name)}
            ${agent ? `<span class="state-pill ${agent.state}">${agent.state}</span>` : `<span class="state-pill failed">unknown</span>`}
          </h1>
        </div>
        <div class="right">
          <button class="btn ghost" data-open-tmux>↗ Open in tmux</button>
          <button class="btn" data-stop>Stop watching</button>
        </div>
      </div>

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

  detachers.push(on('agents-changed', () => {
    if (currentAgent !== name) return;
    const a = state.agents.find((x) => x.name === name);
    const pill = document.querySelector<HTMLElement>('.watch-hdr .title .state-pill');
    if (pill && a) {
      pill.className = `state-pill ${a.state}`;
      pill.textContent = a.state;
    }
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

function wire(root: HTMLElement, name: string): void {
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
