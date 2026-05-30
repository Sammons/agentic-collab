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
import type { AgentRecord, ProxyRegistration, Team } from '../shared/types.ts';
import { state, authHeaders, agentsByName } from './state.ts';
import { escapeHtml, toast } from './util.ts';

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

/* ── proxy pickers (shared by New agent + Edit persona) ──────────────── */

/** Fetch registered proxies; returns [] on any failure (dropdown still usable). */
async function loadProxies(): Promise<ProxyRegistration[]> {
  try {
    const res = await fetch('/api/proxies', { headers: authHeaders() });
    if (!res.ok) return [];
    return await res.json() as ProxyRegistration[];
  } catch {
    return [];
  }
}

/**
 * Build <option>s for a proxy <select>. `current` is the pinned proxyId
 * ('' = unpinned). Always offers "Auto"; if `current` names a proxy that is
 * not currently registered it is still shown + selected so a valid-but-offline
 * pin is never silently dropped.
 */
function proxyOptionsHtml(proxies: ProxyRegistration[], current: string): string {
  const opts = [`<option value="" ${current === '' ? 'selected' : ''}>Auto (first available)</option>`];
  for (const p of proxies) {
    const label = `${p.proxyId} · ${p.host}${p.versionMatch ? '' : ' ⚠ version mismatch'}`;
    opts.push(`<option value="${escapeHtml(p.proxyId)}" ${p.proxyId === current ? 'selected' : ''}>${escapeHtml(label)}</option>`);
  }
  if (current && !proxies.some((p) => p.proxyId === current)) {
    opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not registered)</option>`);
  }
  return opts.join('');
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
          <label>Proxy</label>
          <div>
            <select class="ov-select" data-proxy>
              <option value="">Auto (first available)</option>
            </select>
            <div class="help">Pins this agent to a proxy host. Auto uses the first available.</div>
          </div>
        </div>
        <div class="ov-field">
          <label>cwd</label>
          <div class="ov-cwd-wrap">
            <input class="ov-input path" type="text" data-cwd placeholder="Click Browse, or type a path…" readonly>
            <button class="btn" type="button" data-browse>Browse…</button>
          </div>
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

  // Populate the proxy dropdown from the registered proxies.
  const proxySelect = overlay.querySelector<HTMLSelectElement>('[data-proxy]');
  void loadProxies().then((proxies) => {
    if (proxySelect) proxySelect.innerHTML = proxyOptionsHtml(proxies, '');
  });

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

  // Browse button → CWD picker
  const cwdInput = overlay.querySelector<HTMLInputElement>('[data-cwd]');
  overlay.querySelector<HTMLElement>('[data-browse]')?.addEventListener('click', () => {
    openCwdPicker(cwdInput?.value || '', (picked) => {
      if (cwdInput) cwdInput.value = picked;
    });
  });

  // Submit — model field intentionally absent; model lives in the engine config.
  const submit = async () => {
    const name = overlay.querySelector<HTMLInputElement>('[data-name]')?.value.trim();
    const engine = overlay.querySelector<HTMLSelectElement>('[data-engine]')?.value as 'claude' | 'codex' | 'opencode';
    const cwd = overlay.querySelector<HTMLInputElement>('[data-cwd]')?.value.trim();
    const persona = overlay.querySelector<HTMLTextAreaElement>('[data-persona]')?.value;
    const proxy = overlay.querySelector<HTMLSelectElement>('[data-proxy]')?.value.trim();

    if (!name) { toast('Name is required', 'error'); return; }
    if (!cwd)  { toast('cwd is required — click Browse', 'error'); return; }

    try {
      const body: Record<string, unknown> = { name, engine, cwd };
      if (persona) body['persona'] = persona;
      if (proxy) body['proxy'] = proxy;
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
      toast(`Created ${name} · open the ⋯ menu to Spawn`);
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

/* ── CWD picker ────────────────────────────────────────────────────── */

type ListDirResponse = {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; kind: 'dir' | 'file' | 'link' }>;
};

/**
 * In-modal directory picker. Browses host paths via the proxy
 * (GET /api/proxy/list-dir). Closes with `onPick(absPath)` when the user
 * confirms; closes silently on Cancel/Esc/scrim.
 */
function openCwdPicker(startPath: string, onPick: (absPath: string) => void): void {
  const html = `
    <div class="hdr">
      <span class="ttl">Choose working directory</span>
      <span class="sub">browses paths on the proxy host · directories only</span>
      <button class="esc">esc</button>
    </div>
    <div class="body" style="padding:14px 18px;">
      <div class="ov-cwd-bar">
        <input class="ov-input cwd-input" type="text" data-cwd-input placeholder="/path/to/dir" autocomplete="off" spellcheck="false">
        <button class="btn" type="button" data-cwd-go>Go</button>
      </div>
      <div class="ov-cwd-list" data-cwd-list>Loading…</div>
      <label class="ov-cwd-hidden" data-cwd-hidden-label>
        <input type="checkbox" data-cwd-hidden>
        Show hidden (dot-files)
      </label>
    </div>
    <div class="foot">
      <span class="hint" data-cwd-hint>—</span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit disabled>Use this directory</button>
    </div>
  `;
  const { overlay, close } = openModal(html, 'sm');

  const input = overlay.querySelector<HTMLInputElement>('[data-cwd-input]')!;
  const list = overlay.querySelector<HTMLElement>('[data-cwd-list]')!;
  const hint = overlay.querySelector<HTMLElement>('[data-cwd-hint]')!;
  const submitBtn = overlay.querySelector<HTMLButtonElement>('[data-submit]')!;
  const hiddenChk = overlay.querySelector<HTMLInputElement>('[data-cwd-hidden]')!;

  let currentResolved = '';
  let showHidden = false;

  const fetchDir = async (path: string) => {
    list.innerHTML = '<div class="ov-cwd-loading">Loading…</div>';
    submitBtn.disabled = true;
    try {
      const url = `/api/proxy/list-dir?path=${encodeURIComponent(path)}${showHidden ? '&hidden=1' : ''}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        list.innerHTML = `<div class="ov-cwd-err">${escapeHtml(b?.error ?? 'Failed to load')}</div>`;
        hint.textContent = path || '—';
        return;
      }
      const data = await res.json() as ListDirResponse;
      currentResolved = data.path;
      input.value = data.path;
      hint.textContent = data.path;
      submitBtn.disabled = false;

      const dirs = data.entries.filter(e => e.kind === 'dir');
      const others = data.entries.filter(e => e.kind !== 'dir');

      const rows: string[] = [];
      if (data.parent) {
        rows.push(`
          <div class="ov-cwd-row up" data-go="${escapeHtml(data.parent)}">
            <span class="ico">↑</span>
            <span class="nm">..</span>
            <span class="kind">parent</span>
          </div>
        `);
      }
      for (const e of dirs) {
        rows.push(`
          <div class="ov-cwd-row" data-go="${escapeHtml(joinPath(data.path, e.name))}">
            <span class="ico">${folderIcon}</span>
            <span class="nm">${escapeHtml(e.name)}</span>
            <span class="kind">${e.kind === 'link' ? 'link →' : 'dir'}</span>
          </div>
        `);
      }
      if (others.length > 0) {
        rows.push(`<div class="ov-cwd-divider">files (not selectable)</div>`);
        for (const e of others) {
          rows.push(`
            <div class="ov-cwd-row file">
              <span class="ico">${fileIcon}</span>
              <span class="nm">${escapeHtml(e.name)}</span>
              <span class="kind">${escapeHtml(e.kind)}</span>
            </div>
          `);
        }
      }
      list.innerHTML = rows.join('') || '<div class="ov-cwd-empty">empty directory</div>';
      list.querySelectorAll<HTMLElement>('[data-go]').forEach((row) => {
        row.addEventListener('click', () => fetchDir(row.dataset['go']!));
      });
    } catch (err) {
      list.innerHTML = `<div class="ov-cwd-err">Network error.</div>`;
    }
  };

  overlay.querySelector<HTMLElement>('[data-cwd-go]')?.addEventListener('click', () => {
    fetchDir(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fetchDir(input.value.trim()); }
  });
  hiddenChk.addEventListener('change', () => {
    showHidden = hiddenChk.checked;
    fetchDir(currentResolved || input.value.trim());
  });

  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
  submitBtn.addEventListener('click', () => {
    if (!currentResolved) return;
    onPick(currentResolved);
    close();
  });

  // Kick off with the starting path (or HOME if empty).
  fetchDir(startPath);
}

function joinPath(base: string, name: string): string {
  if (base.endsWith('/')) return base + name;
  return base + '/' + name;
}

const folderIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/></svg>`;
const fileIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><polyline points="10 2 10 5 13 5"/></svg>`;

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

/* ── Edit team — rename + manage membership + delete ──────────────── */

export function openEditTeamModal(team: Team): void {
  const original = new Set(team.members);
  const selected = new Set(original);
  const check = '<svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>';

  const html = `
    <div class="hdr">
      <span class="ttl">Edit team</span>
      <span class="sub"><code style="font-family:var(--mono);font-size:11px;color:var(--ink-2);">${escapeHtml(team.name)}</code></span>
      <button class="esc">esc</button>
    </div>
    <div class="body">
      <div class="ov-field">
        <label>Name</label>
        <input class="ov-input" type="text" data-name value="${escapeHtml(team.name)}">
      </div>
      <div class="ov-field stack">
        <label>Members</label>
        <div class="help" style="margin-top:0;margin-bottom:4px;">Check agents to include in this team.</div>
        <div class="ov-member-grid" data-members></div>
      </div>
    </div>
    <div class="foot">
      <button class="btn" data-delete style="color:var(--brick);border-color:var(--brick);">Delete team</button>
      <span class="hint" data-count><span style="font-family:var(--mono);">${selected.size} selected</span></span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit>Save changes</button>
    </div>
  `;
  const { overlay, close } = openModal(html, 'sm');

  const grid = overlay.querySelector<HTMLElement>('[data-members]');
  if (grid) {
    if (state.agents.length === 0) {
      grid.innerHTML = '<div style="font-size:12px;color:var(--ink-4);font-style:italic;padding:8px 0;">No agents to add.</div>';
    } else {
      grid.innerHTML = state.agents.map((a) => {
        const on = selected.has(a.name);
        return `
          <div class="ov-member${on ? ' on' : ''}" data-name="${escapeHtml(a.name)}">
            <span class="box">${on ? check : ''}</span>
            <span>${escapeHtml(a.name)}</span>
            <span class="kind per">per</span>
          </div>
        `;
      }).join('');
      grid.querySelectorAll<HTMLElement>('[data-name]').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset['name']!;
          if (selected.has(name)) selected.delete(name);
          else selected.add(name);
          el.classList.toggle('on');
          const box = el.querySelector<HTMLElement>('.box');
          if (box) box.innerHTML = selected.has(name) ? check : '';
          const countEl = overlay.querySelector<HTMLElement>('[data-count]');
          if (countEl) countEl.innerHTML = `<span style="font-family:var(--mono);">${selected.size} selected</span>`;
        });
      });
    }
  }

  const submit = async () => {
    const newName = (overlay.querySelector<HTMLInputElement>('[data-name]')?.value ?? team.name).trim();
    if (!newName) { toast('Name is required', 'error'); return; }
    try {
      // Rename first if changed (small body via PATCH).
      if (newName !== team.name) {
        const res = await fetch(`/api/teams/${team.id}`, {
          method: 'PATCH', headers: authHeaders(),
          body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => null);
          toast(b?.error ?? 'Rename failed', 'error');
          return;
        }
      }
      // Membership diff. The orchestrator broadcasts teams_update on each
      // call so the sidebar re-renders even before the modal closes.
      const toAdd = [...selected].filter((n) => !original.has(n));
      const toRemove = [...original].filter((n) => !selected.has(n));
      for (const n of toAdd) {
        await fetch(`/api/teams/${team.id}/members`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ agentName: n }),
        });
      }
      for (const n of toRemove) {
        await fetch(`/api/teams/${team.id}/members/${encodeURIComponent(n)}`, {
          method: 'DELETE', headers: authHeaders(),
        });
      }
      toast(`Saved team ${newName}`);
      close();
    } catch { toast('Network error', 'error'); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete team "${team.name}"? Members remain — only the team grouping is removed.`)) return;
    try {
      const res = await fetch(`/api/teams/${team.id}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast(b?.error ?? 'Delete failed', 'error');
        return;
      }
      toast(`Deleted team ${team.name}`);
      close();
    } catch { toast('Network error', 'error'); }
  };

  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', submit);
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
  overlay.querySelector<HTMLElement>('[data-delete]')?.addEventListener('click', remove);
}

/* ── Edit persona ──────────────────────────────────────────────────── */

export async function openEditPersonaModal(agentName: string): Promise<void> {
  // Load persona: parsed frontmatter (→ structured fields), raw (→ advanced
  // fallback), body, and whether the bespoke editor can faithfully represent it.
  let fm: Record<string, unknown> = {};
  let frontmatterRaw = '';
  let body = '';
  let renderable = false;
  try {
    const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json() as { frontmatter?: Record<string, unknown>; frontmatterRaw?: string; body?: string; content?: string; structuredRenderable?: boolean };
      fm = data.frontmatter ?? {};
      frontmatterRaw = data.frontmatterRaw ?? '';
      body = data.body ?? data.content ?? '';
      renderable = data.structuredRenderable ?? false;
    }
  } catch {}

  const sv = (k: string) => (typeof fm[k] === 'string' ? fm[k] as string : '');
  const curProxy = sv('proxy');
  const curTeams: string[] = Array.isArray(fm['teams']) ? (fm['teams'] as string[]) : [];
  const curEnv: Record<string, string> = (fm['env'] && typeof fm['env'] === 'object' && !Array.isArray(fm['env'])) ? fm['env'] as Record<string, string> : {};
  const ENGINES = ['claude', 'codex', 'opencode'];
  const curEngine = sv('engine');
  const teamNames = [...new Set([...state.teams.map((t) => t.name), ...curTeams])];

  const esc = escapeHtml;
  const html = `
    <div class="hdr">
      <span class="ttl">Edit persona</span>
      <span class="sub">${esc(agentName)} · <code style="font-family:var(--mono);font-size:11px;color:var(--ink-2);">persistent-agents/${esc(agentName)}.md</code></span>
      <button class="esc">esc</button>
    </div>
    <div class="body">
      <div data-structured style="${renderable ? '' : 'display:none;'}">
        <div class="group">
          <div class="group-hdr">Config</div>
          <div class="ov-field"><label>Engine</label>
            <select class="ov-select" data-f="engine">
              ${ENGINES.map((e) => `<option value="${e}" ${curEngine === e ? 'selected' : ''}>${e}</option>`).join('')}
              ${curEngine && !ENGINES.includes(curEngine) ? `<option value="${esc(curEngine)}" selected>${esc(curEngine)}</option>` : ''}
            </select>
          </div>
          <div class="ov-field"><label>Model</label><div><input class="ov-input" data-f="model" value="${esc(sv('model'))}" placeholder="(engine default)"></div></div>
          <div class="ov-field"><label>Thinking</label>
            <select class="ov-select" data-f="thinking">
              ${['', 'low', 'medium', 'high'].map((t) => `<option value="${t}" ${sv('thinking') === t ? 'selected' : ''}>${t || '(none)'}</option>`).join('')}
            </select>
          </div>
          <div class="ov-field"><label>cwd</label>
            <div class="ov-cwd-wrap">
              <input class="ov-input path" type="text" data-f="cwd" value="${esc(sv('cwd'))}" placeholder="Click Browse…" readonly>
              <button class="btn" type="button" data-browse-cwd>Browse…</button>
            </div>
          </div>
          <div class="ov-field"><label>Permissions</label><div><input class="ov-input" data-f="permissions" value="${esc(sv('permissions'))}" placeholder="(default)"></div></div>
          <div class="ov-field"><label>Account</label><div><input class="ov-input" data-f="account" value="${esc(sv('account'))}" placeholder="(none)"></div></div>
          <div class="ov-field"><label>Icon</label><div><input class="ov-input" data-f="icon" value="${esc(sv('icon'))}" placeholder="emoji"></div></div>
          <div class="ov-field"><label>Proxy</label>
            <div>
              <select class="ov-select" data-f="proxy">
                ${curProxy ? `<option value="${esc(curProxy)}" selected>${esc(curProxy)}</option>` : '<option value="" selected>Auto (first available)</option>'}
              </select>
              <div class="help" data-proxy-hint></div>
            </div>
          </div>
        </div>
        <div class="group">
          <div class="group-hdr">Teams <span class="when">click to toggle membership</span></div>
          <div class="ov-chips" data-teams-chips>${teamNames.map((n) => `<span class="ov-chip ${curTeams.includes(n) ? 'on' : ''}" data-team="${esc(n)}">${esc(n)}</span>`).join('') || '<span style="font-size:12px;color:var(--ink-4);font-style:italic;">No teams yet.</span>'}</div>
          <div style="margin-top:6px;display:flex;gap:6px;"><input class="ov-input" data-new-team type="text" placeholder="new team name…" style="max-width:220px;"><button class="btn" type="button" data-add-team>+ Add</button></div>
        </div>
        <div class="group">
          <div class="group-hdr">Env <span class="when">launch-time vars</span></div>
          <div data-env-rows></div>
          <button class="btn" type="button" data-add-env>+ Add var</button>
        </div>
      </div>

      <div data-advanced style="${renderable ? 'display:none;' : ''}">
        ${renderable ? '' : '<div class="help" style="color:var(--danger,#c0392b);margin-bottom:6px;">Could not fully parse this persona into fields — edit the raw YAML below (advanced).</div>'}
        <div class="label">Frontmatter <span class="hint">YAML · raw</span></div>
        <textarea class="ov-textarea" data-fm style="min-height:220px;">${esc(frontmatterRaw)}</textarea>
      </div>

      <div class="group">
        <div class="group-hdr">Body <span class="when">markdown · system prompt</span></div>
        <textarea class="ov-textarea" data-body style="min-height:160px;">${esc(body)}</textarea>
      </div>
    </div>
    <div class="foot">
      <label class="secondary-check" data-reload><span class="box"></span>Reload persona on save</label>
      <span class="hint" style="color: var(--ink-4); font-style: italic;">Replaces the running tmux session.</span>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-submit>Save changes</button>
    </div>
  `;
  const { overlay, close } = openModal(html, 'lg');
  let reloadOnSave = false;

  // cwd folder picker (reuses the New-agent picker)
  const cwdInput = overlay.querySelector<HTMLInputElement>('[data-f="cwd"]');
  overlay.querySelector<HTMLElement>('[data-browse-cwd]')?.addEventListener('click', () => {
    openCwdPicker(cwdInput?.value || '', (picked) => { if (cwdInput) cwdInput.value = picked; });
  });
  // Proxy dropdown: populate + surface drift
  const proxySelect = overlay.querySelector<HTMLSelectElement>('[data-f="proxy"]');
  const proxyHint = overlay.querySelector<HTMLElement>('[data-proxy-hint]');
  const livePlacement = agentsByName.get(agentName)?.proxyId ?? null;
  if (proxyHint && livePlacement && livePlacement !== curProxy) proxyHint.textContent = `Currently running on: ${livePlacement}`;
  void loadProxies().then((proxies) => { if (proxySelect) proxySelect.innerHTML = proxyOptionsHtml(proxies, curProxy); });
  // Teams chips: toggle on click; add new by name
  const chipsHost = overlay.querySelector<HTMLElement>('[data-teams-chips]');
  chipsHost?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-team]');
    if (chip) chip.classList.toggle('on');
  });
  overlay.querySelector<HTMLElement>('[data-add-team]')?.addEventListener('click', () => {
    const inp = overlay.querySelector<HTMLInputElement>('[data-new-team]');
    const name = inp?.value.trim();
    const exists = !!chipsHost && [...chipsHost.querySelectorAll<HTMLElement>('[data-team]')].some((c) => c.dataset['team'] === name);
    if (!name || !chipsHost || exists) { if (inp) inp.value = ''; return; }
    const chip = document.createElement('span');
    chip.className = 'ov-chip on';
    chip.dataset['team'] = name;
    chip.textContent = name;
    chipsHost.appendChild(chip);
    inp!.value = '';
  });
  // Env key/value rows
  const envHost = overlay.querySelector<HTMLElement>('[data-env-rows]');
  const addEnvRow = (k = '', v = '') => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;';
    row.innerHTML = `<input class="ov-input" data-env-k placeholder="KEY" value="${esc(k)}" style="max-width:200px;"><input class="ov-input" data-env-v placeholder="value" value="${esc(v)}"><button class="btn" type="button" data-env-del>×</button>`;
    row.querySelector('[data-env-del]')?.addEventListener('click', () => row.remove());
    envHost?.appendChild(row);
  };
  for (const [k, v] of Object.entries(curEnv)) addEnvRow(k, String(v));
  overlay.querySelector<HTMLElement>('[data-add-env]')?.addEventListener('click', () => addEnvRow());

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
    const bd = overlay.querySelector<HTMLTextAreaElement>('[data-body]')?.value ?? '';
    let payload: Record<string, unknown>;
    if (renderable) {
      // Structured mode → typed fields; server serializes via serializeFrontmatter.
      const fields: Record<string, unknown> = {};
      overlay.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((el) => {
        const val = el.value.trim();
        if (val) fields[el.getAttribute('data-f')!] = val;
      });
      const teams = [...overlay.querySelectorAll<HTMLElement>('[data-team].on')].map((c) => c.dataset['team']!);
      if (teams.length || curTeams.length) fields['teams'] = teams; // [] clears existing memberships
      const env: Record<string, string> = {};
      overlay.querySelectorAll<HTMLElement>('[data-env-rows] > div').forEach((row) => {
        const k = row.querySelector<HTMLInputElement>('[data-env-k]')?.value.trim();
        if (k) env[k] = row.querySelector<HTMLInputElement>('[data-env-v]')?.value ?? '';
      });
      if (Object.keys(env).length) fields['env'] = env;
      payload = { fields, body: bd };
    } else {
      // Advanced fallback → raw frontmatter passthrough.
      payload = { frontmatter: overlay.querySelector<HTMLTextAreaElement>('[data-fm]')?.value ?? '', body: bd };
    }
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload),
      });
      if (!res.ok) { const b = await res.json().catch(() => null); toast(b?.error ?? 'Save failed', 'error'); return; }
      if (reloadOnSave) {
        await fetch(`/api/agents/${encodeURIComponent(agentName)}/reload`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) });
      }
      toast(`Saved persona for ${agentName}`);
      close();
    } catch { toast('Network error', 'error'); }
  };
  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', submit);
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', close);
}
