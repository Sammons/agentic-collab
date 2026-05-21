/**
 * Overlays — New agent, New team, Edit persona.
 *
 * Shared modal pattern (.ov-*). Each function opens a modal, wires it up,
 * and resolves when the user submits or cancels. Backdrop + esc closes.
 *
 * These are exported and called from other modules:
 *   - agents.ts: New agent + Edit persona
 *   - sidebar.ts: New team (replaces the window.prompt fallback)
 */
import type { AgentRecord, Team } from '../shared/types.ts';
import { state, authHeaders } from './state.ts';

/* ── shared modal helpers ──────────────────────────────────────────── */

type ModalCloseFn = () => void;

function openModal(html: string, size: 'sm' | '' | 'lg' = ''): { overlay: HTMLElement; close: ModalCloseFn } {
  const overlay = document.createElement('div');
  overlay.className = 'ov-backdrop center';
  overlay.innerHTML = `<div class="ov-modal ${size}">${html}</div>`;
  document.body.appendChild(overlay);

  const close: ModalCloseFn = () => {
    overlay.remove();
    document.removeEventListener('keydown', escListener);
  };
  function escListener(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', escListener);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector<HTMLElement>('.esc')?.addEventListener('click', close);

  return { overlay, close };
}

function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `chat-toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── + New agent ───────────────────────────────────────────────────── */

export function openNewAgentModal(): void {
  const html = `
    <div class="hdr">
      <span class="ttl">+ New agent</span>
      <span class="sub">creates a persistent agent</span>
      <button class="esc">esc</button>
    </div>
    <div class="body">
      <div class="group">
        <div class="group-hdr">Identity</div>
        <div class="ov-field">
          <label>Name</label>
          <div>
            <input class="ov-input" type="text" data-name placeholder="kebab-case-name">
            <div class="help">Lowercase, kebab-case. Will be the agent&rsquo;s address: <code>agent:name</code>.</div>
          </div>
        </div>
        <div class="ov-field">
          <label>Engine</label>
          <select class="ov-select" data-engine>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="opencode">opencode</option>
          </select>
        </div>
        <div class="ov-field">
          <label>Model</label>
          <input class="ov-input" type="text" data-model placeholder="(use engine default)">
        </div>
        <div class="ov-field">
          <label>cwd</label>
          <input class="ov-input path" type="text" data-cwd placeholder="/path/to/working/dir">
        </div>
      </div>
      <div class="group">
        <div class="group-hdr">Teams <span class="when">optional · UI-only grouping</span></div>
        <div class="ov-chips" data-teams></div>
      </div>
      <div class="group">
        <div class="group-hdr">Persona body <span class="when">markdown · system prompt</span></div>
        <textarea class="ov-textarea body" data-persona placeholder="You are <name>…"></textarea>
      </div>
    </div>
    <div class="foot">
      <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> create · <kbd>esc</kbd> cancel</span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit>Create agent</button>
    </div>
  `;
  const { overlay, close } = openModal(html);

  // Teams chips
  const teamsHost = overlay.querySelector<HTMLElement>('[data-teams]');
  const selectedTeamIds = new Set<number>();
  if (teamsHost) {
    teamsHost.innerHTML = state.teams.map((t) =>
      `<span class="ov-chip" data-team-id="${t.id}">${escapeHtml(t.name)} <span class="ct">${t.members.length}</span></span>`
    ).join('') || '<span style="font-size:12px;color:var(--ink-4);font-style:italic;">No teams yet — create one from the sidebar first.</span>';
    teamsHost.querySelectorAll<HTMLElement>('[data-team-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = Number(el.dataset['teamId']);
        if (selectedTeamIds.has(id)) selectedTeamIds.delete(id);
        else selectedTeamIds.add(id);
        el.classList.toggle('on');
      });
    });
  }

  // Submit
  const submit = async () => {
    const name = overlay.querySelector<HTMLInputElement>('[data-name]')?.value.trim();
    const engine = overlay.querySelector<HTMLSelectElement>('[data-engine]')?.value as 'claude' | 'codex' | 'opencode';
    const model = overlay.querySelector<HTMLInputElement>('[data-model]')?.value.trim();
    const cwd = overlay.querySelector<HTMLInputElement>('[data-cwd]')?.value.trim();
    const persona = overlay.querySelector<HTMLTextAreaElement>('[data-persona]')?.value;

    if (!name) { toast('Name is required', 'error'); return; }
    if (!cwd)  { toast('cwd is required', 'error'); return; }

    try {
      const body: Record<string, unknown> = { name, engine, cwd };
      if (model) body['model'] = model;
      if (persona) body['persona'] = persona;
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast(b?.error ?? 'Create failed', 'error');
        return;
      }

      // Add to selected teams
      for (const teamId of selectedTeamIds) {
        await fetch(`/api/teams/${teamId}/members`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ agentName: name }),
        });
      }
      toast(`Created agent ${name}`);
      close();
    } catch {
      toast('Network error', 'error');
    }
  };
  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', submit);
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
  });
}

/* ── + New team ────────────────────────────────────────────────────── */

export function openNewTeamModal(): void {
  const html = `
    <div class="hdr">
      <span class="ttl">+ New team</span>
      <span class="sub">UI-only grouping · no kernel behavior</span>
      <button class="esc">esc</button>
    </div>
    <div class="body">
      <div class="ov-field">
        <label>Name</label>
        <input class="ov-input" type="text" data-name placeholder="e.g. reliability">
      </div>
      <div class="ov-field stack">
        <label>Members</label>
        <div class="help" style="margin-top:0;margin-bottom:4px;">Pick agents to include. Members can belong to more than one team.</div>
        <div class="ov-member-grid" data-members></div>
      </div>
    </div>
    <div class="foot">
      <span class="hint" data-count><span style="font-family:var(--mono);">0 selected</span></span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit>Create team</button>
    </div>
  `;
  const { overlay, close } = openModal(html, 'sm');
  const selected = new Set<string>();

  const grid = overlay.querySelector<HTMLElement>('[data-members]');
  if (grid) {
    if (state.agents.length === 0) {
      grid.innerHTML = '<div style="font-size:12px;color:var(--ink-4);font-style:italic;padding:8px 0;">No agents to add.</div>';
    } else {
      grid.innerHTML = state.agents.map((a) => `
        <div class="ov-member" data-name="${escapeHtml(a.name)}">
          <span class="box"></span>
          <span>${escapeHtml(a.name)}</span>
          <span class="kind per">per</span>
        </div>
      `).join('');
      grid.querySelectorAll<HTMLElement>('[data-name]').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset['name']!;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          el.classList.toggle('on');
          const box = el.querySelector<HTMLElement>('.box');
          if (box) box.innerHTML = selected.has(name)
            ? '<svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>'
            : '';
          const countEl = overlay.querySelector<HTMLElement>('[data-count]');
          if (countEl) countEl.innerHTML = `<span style="font-family:var(--mono);">${selected.size} selected</span>`;
        });
      });
    }
  }

  const submit = async () => {
    const name = overlay.querySelector<HTMLInputElement>('[data-name]')?.value.trim();
    if (!name) { toast('Name is required', 'error'); return; }
    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, members: Array.from(selected) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast(b?.error ?? 'Create failed', 'error');
        return;
      }
      toast(`Created team ${name}`);
      close();
    } catch { toast('Network error', 'error'); }
  };
  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', submit);
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
}

/* ── Edit persona ──────────────────────────────────────────────────── */

export async function openEditPersonaModal(agentName: string): Promise<void> {
  // Load current persona text
  let frontmatter = '';
  let body = '';
  try {
    const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json() as { frontmatter?: string; body?: string; content?: string };
      frontmatter = data.frontmatter ?? '';
      body = data.body ?? data.content ?? '';
    }
  } catch {}

  const html = `
    <div class="hdr">
      <span class="ttl">Edit persona</span>
      <span class="sub">${escapeHtml(agentName)} · <code style="font-family:var(--mono);font-size:11px;color:var(--ink-2);">persistent-agents/${escapeHtml(agentName)}.md</code></span>
      <button class="esc">esc</button>
    </div>
    <div class="body">
      <div class="ov-persona-grid">
        <div class="ov-persona-col">
          <div class="label">Frontmatter <span class="hint">YAML · saved on submit</span></div>
          <textarea class="ov-textarea" data-fm>${escapeHtml(frontmatter)}</textarea>
        </div>
        <div class="ov-persona-col">
          <div class="label">Body <span class="hint">Markdown · system prompt</span></div>
          <textarea class="ov-textarea" data-body>${escapeHtml(body)}</textarea>
        </div>
      </div>
    </div>
    <div class="foot">
      <label class="secondary-check" data-reload>
        <span class="box"></span>
        Reload persona on save
      </label>
      <span class="hint" style="color: var(--ink-4); font-style: italic;">Replaces the running tmux session.</span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit>Save changes</button>
    </div>
  `;
  const { overlay, close } = openModal(html, 'lg');
  let reloadOnSave = false;

  overlay.querySelector<HTMLElement>('[data-reload]')?.addEventListener('click', (e) => {
    reloadOnSave = !reloadOnSave;
    const el = e.currentTarget as HTMLElement;
    el.classList.toggle('on', reloadOnSave);
    const box = el.querySelector<HTMLElement>('.box');
    if (box) box.innerHTML = reloadOnSave
      ? '<svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>'
      : '';
  });

  const submit = async () => {
    const fm = overlay.querySelector<HTMLTextAreaElement>('[data-fm]')?.value ?? '';
    const bd = overlay.querySelector<HTMLTextAreaElement>('[data-body]')?.value ?? '';
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ frontmatter: fm, body: bd }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast(b?.error ?? 'Save failed', 'error');
        return;
      }
      if (reloadOnSave) {
        await fetch(`/api/agents/${encodeURIComponent(agentName)}/reload`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({}),
        });
      }
      toast(`Saved persona for ${agentName}`);
      close();
    } catch { toast('Network error', 'error'); }
  };
  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', submit);
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
}
