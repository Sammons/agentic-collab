/**
 * Persona — full-page structured persona editor (RFC-007 PR-B).
 *
 * Rehomes the former `openEditPersonaModal()` (overlays.ts) onto its own
 * route `#/persona/:name` with full-page real estate. The editing behavior is
 * a faithful port of the modal:
 *
 *   - GET  /api/personas/:name  → { core, passthroughRaw, body }
 *   - core widgets: engine/model/cwd/icon always; group/thinking/permissions/
 *     account/proxy/teams gated (shown when populated, else offered via "+ Add field")
 *   - "Advanced (raw frontmatter)" passthrough textarea (verbatim YAML)
 *   - markdown body textarea
 *   - PUT  /api/personas/:name  with { fields, passthroughRaw, body }
 *     (byte-identical payload shape to the old modal)
 *   - optional "Reload persona on save" → POST /api/agents/:name/reload
 *
 * RFC-005 field model: the editor owns single-line CORE fields as widgets;
 * every other frontmatter line (env, hooks, custom_buttons, indicators, unknown
 * keys, comments) is carried VERBATIM through the passthrough textarea. Field
 * visibility is COMPUTED, not a hardcoded deprecated-list: a field shows when it
 * is populated OR it is one of the always-on core fields.
 */
import type { ProxyRegistration } from '../shared/types.ts';
import { state, on, authHeaders, agentsByName } from './state.ts';
import { registerRoute, go, type Route } from './routing.ts';
import { openCwdPicker } from './overlays.ts';
import { escapeHtml, toast } from './util.ts';

/** Always-visible core fields (minimal default). */
const PERSONA_CORE_ALWAYS = ['engine', 'model', 'cwd', 'icon'] as const;
/** Core fields shown only when populated (still structured widgets when shown). */
const PERSONA_CORE_GATED = ['group', 'thinking', 'permissions', 'account', 'proxy', 'teams'] as const;

const ENGINES = ['claude', 'codex', 'opencode', 'claude-with-home'];

/**
 * The most recent non-persona route. Captured on every route change so that
 * Back/Cancel/Save can return the user to where they came from (the Agents
 * grid, or the Watch view for that agent). Defaults to Agents.
 */
let lastNonPersonaRoute: Route = { kind: 'agents' };

/** Where to return on Back/Cancel/Save for the current persona visit. */
let returnRoute: Route = { kind: 'agents' };

const detachers: Array<() => void> = [];

export function setupPersona(): void {
  registerRoute('persona', render);
  // Track the route the user is leaving so Back/Cancel can return there.
  on('route-changed', (r) => {
    const next = r as Route;
    if (next.kind !== 'persona') lastNonPersonaRoute = next;
  });
}

/* ── shared proxy helpers (mirror overlays.ts) ──────────────────────── */

async function loadProxies(): Promise<ProxyRegistration[]> {
  try {
    const res = await fetch('/api/proxies', { headers: authHeaders() });
    if (!res.ok) return [];
    return await res.json() as ProxyRegistration[];
  } catch {
    return [];
  }
}

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

/* ── render ─────────────────────────────────────────────────────────── */

function render(root: HTMLElement, route: Route): void {
  if (route.kind !== 'persona') return;
  const name = route.name;
  // Back/Cancel/Save return the user to wherever they came from (Agents grid
  // or the agent's Watch view). On a cold load straight to #/persona/:name
  // there is no prior route, so fall back to Agents.
  returnRoute = lastNonPersonaRoute.kind === 'persona' ? { kind: 'agents' } : lastNonPersonaRoute;

  teardown();

  root.innerHTML = `
    <div class="pe-page">
      <div class="pe-hdr">
        <button class="back" data-back>← Back</button>
        <div class="title-block">
          <div class="super"><span>Agents</span> <span class="crumb-arrow">/</span> <span>Persona</span></div>
          <h1 class="title">${escapeHtml(name)}</h1>
          <code class="api-hint">persistent-agents/${escapeHtml(name)}.md</code>
        </div>
        <div class="right">
          <label class="pe-reload" data-reload><span class="box"></span>Reload persona on save</label>
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-submit>Save changes</button>
        </div>
      </div>
      <div class="pe-body" data-body>
        <div class="pe-loading">Loading…</div>
      </div>
    </div>
  `;

  root.querySelector<HTMLElement>('[data-back]')?.addEventListener('click', () => go(returnRoute));
  root.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', () => go(returnRoute));

  // Tear down our listeners when we leave the persona route.
  detachers.push(on('route-changed', (r) => {
    if ((r as Route).kind !== 'persona') teardown();
  }));

  void hydrate(root, name);
}

function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
}

async function hydrate(root: HTMLElement, agentName: string): Promise<void> {
  const bodyHost = root.querySelector<HTMLElement>('[data-body]');
  if (!bodyHost) return;

  // RFC-005: server returns `core` (single-line widget values) + `passthroughRaw`
  // (every other frontmatter line, verbatim) + body.
  let core: Record<string, unknown> = {};
  let passthroughRaw = '';
  let body = '';
  try {
    const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json() as { core?: Record<string, unknown>; passthroughRaw?: string; body?: string; content?: string };
      core = data.core ?? {};
      passthroughRaw = data.passthroughRaw ?? '';
      body = data.body ?? data.content ?? '';
    } else {
      bodyHost.innerHTML = `<div class="pe-error">Could not load persona for <code>${escapeHtml(agentName)}</code> (${res.status}).</div>`;
      return;
    }
  } catch {
    bodyHost.innerHTML = `<div class="pe-error">Network error loading persona for <code>${escapeHtml(agentName)}</code>.</div>`;
    return;
  }

  const esc = escapeHtml;
  const sv = (k: string) => (typeof core[k] === 'string' ? core[k] as string : '');
  const curTeams: string[] = Array.isArray(core['teams']) ? (core['teams'] as string[]) : [];
  const curProxy = sv('proxy');
  const curEngine = sv('engine');
  const teamNames = [...new Set([...state.teams.map((t) => t.name), ...curTeams])];

  const isPopulated = (k: string): boolean => (k === 'teams' ? curTeams.length > 0 : sv(k) !== '');
  const showField = (k: string): boolean => (PERSONA_CORE_ALWAYS as readonly string[]).includes(k) || isPopulated(k);

  // ── per-field renderers (only emitted when shown) — reuse existing .ov-* CSS ──
  const fieldEngine = (): string => `<div class="ov-field" data-field="engine"><label>Engine</label>
    <div><input class="ov-input" data-f="engine" list="persona-engines" value="${esc(curEngine)}" placeholder="claude" autocomplete="off">
    <datalist id="persona-engines">${ENGINES.map((e) => `<option value="${esc(e)}"></option>`).join('')}</datalist></div></div>`;
  const fieldModel = (): string => `<div class="ov-field" data-field="model"><label>Model</label><div><input class="ov-input" data-f="model" value="${esc(sv('model'))}" placeholder="(engine default)"></div></div>`;
  const fieldThinking = (): string => {
    const opts = ['', 'low', 'medium', 'high'];
    const cur = sv('thinking');
    const all = opts.includes(cur) ? opts : [...opts, cur]; // preserve an out-of-set value
    return `<div class="ov-field" data-field="thinking"><label>Thinking</label>
      <select class="ov-select" data-f="thinking">${all.map((t) => `<option value="${esc(t)}" ${cur === t ? 'selected' : ''}>${t || '(none)'}</option>`).join('')}</select></div>`;
  };
  const fieldCwd = (): string => `<div class="ov-field" data-field="cwd"><label>cwd</label>
    <div class="ov-cwd-wrap"><input class="ov-input path" type="text" data-f="cwd" value="${esc(sv('cwd'))}" placeholder="Click Browse…" readonly><button class="btn" type="button" data-browse-cwd>Browse…</button></div></div>`;
  const fieldPermissions = (): string => `<div class="ov-field" data-field="permissions"><label>Permissions</label><div><input class="ov-input" data-f="permissions" value="${esc(sv('permissions'))}" placeholder="(default)"></div></div>`;
  const fieldAccount = (): string => `<div class="ov-field" data-field="account"><label>Account</label><div><input class="ov-input" data-f="account" value="${esc(sv('account'))}" placeholder="(none)"></div></div>`;
  const fieldIcon = (): string => `<div class="ov-field" data-field="icon"><label>Icon</label><div><input class="ov-input" data-f="icon" value="${esc(sv('icon'))}" placeholder="emoji"></div></div>`;
  const fieldGroup = (): string => `<div class="ov-field" data-field="group"><label>Group</label><div><input class="ov-input" data-f="group" value="${esc(sv('group'))}" placeholder="(none)"></div></div>`;
  const fieldProxy = (): string => `<div class="ov-field" data-field="proxy"><label>Proxy</label>
    <div><select class="ov-select" data-f="proxy">${curProxy ? `<option value="${esc(curProxy)}" selected>${esc(curProxy)}</option>` : '<option value="" selected>Auto (first available)</option>'}</select><div class="help" data-proxy-hint></div></div></div>`;
  const fieldTeams = (): string => `<div class="ov-field stack" data-field="teams"><label>Teams <span class="when">click to toggle</span></label>
    <div><div class="ov-chips" data-teams-chips>${teamNames.map((n) => `<span class="ov-chip ${curTeams.includes(n) ? 'on' : ''}" data-team="${esc(n)}">${esc(n)}</span>`).join('') || '<span style="font-size:12px;color:var(--ink-4);font-style:italic;">No teams yet.</span>'}</div>
    <div style="margin-top:6px;display:flex;gap:6px;"><input class="ov-input" data-new-team type="text" placeholder="new team…" style="max-width:200px;"><button class="btn" type="button" data-add-team>+ Add</button></div></div></div>`;

  const RENDERERS: Record<string, () => string> = { engine: fieldEngine, model: fieldModel, thinking: fieldThinking, cwd: fieldCwd, permissions: fieldPermissions, account: fieldAccount, icon: fieldIcon, group: fieldGroup, proxy: fieldProxy, teams: fieldTeams };
  const ALL_CORE = [...PERSONA_CORE_ALWAYS, ...PERSONA_CORE_GATED];
  const shownFields = ALL_CORE.filter(showField);
  const hiddenFields = PERSONA_CORE_GATED.filter((k) => !showField(k));
  const showPassthrough = passthroughRaw.trim() !== '';

  bodyHost.innerHTML = `
    <div class="pe-group">
      <div class="pe-group-hdr">Config</div>
      <div class="pe-core-grid" data-core-fields>${shownFields.map((k) => RENDERERS[k]!()).join('')}</div>
      <div class="pe-core-actions">
        ${hiddenFields.length ? `<select class="ov-select" data-add-field-pick style="max-width:180px;"><option value="">+ Add field…</option>${hiddenFields.map((k) => `<option value="${k}">${k}</option>`).join('')}</select>` : ''}
        <button class="btn" type="button" data-toggle-advanced style="${showPassthrough ? 'display:none;' : ''}">+ Advanced (raw frontmatter)</button>
      </div>
    </div>
    <div class="pe-group" data-advanced-group style="${showPassthrough ? '' : 'display:none;'}">
      <div class="pe-group-hdr">Other frontmatter <span class="when">advanced · raw YAML — hooks, indicators, env, custom keys</span></div>
      <textarea class="ov-textarea pe-passthrough" data-passthrough placeholder="key: value">${esc(passthroughRaw)}</textarea>
    </div>
    <div class="pe-group pe-body-group">
      <div class="pe-group-hdr">Body <span class="when">markdown · system prompt</span></div>
      <textarea class="ov-textarea pe-body-text" data-body-text>${esc(body)}</textarea>
    </div>
  `;

  let reloadOnSave = false;
  const coreHost = bodyHost.querySelector<HTMLElement>('[data-core-fields]');

  // cwd Browse picker — (re)bind for the current cwd input.
  const wireCwd = (): void => {
    const cwdInput = bodyHost.querySelector<HTMLInputElement>('[data-f="cwd"]');
    bodyHost.querySelector<HTMLElement>('[data-browse-cwd]')?.addEventListener('click', () => {
      openCwdPicker(cwdInput?.value || '', (picked) => { if (cwdInput) cwdInput.value = picked; });
    });
  };
  // Proxy dropdown: populate options + surface live-placement drift.
  const wireProxy = (): void => {
    const proxySelect = bodyHost.querySelector<HTMLSelectElement>('[data-f="proxy"]');
    if (!proxySelect) return;
    const proxyHint = bodyHost.querySelector<HTMLElement>('[data-proxy-hint]');
    const livePlacement = agentsByName.get(agentName)?.proxyId ?? null;
    if (proxyHint && livePlacement && livePlacement !== curProxy) proxyHint.textContent = `Currently running on: ${livePlacement}`;
    void loadProxies().then((proxies) => { proxySelect.innerHTML = proxyOptionsHtml(proxies, curProxy); });
  };
  // Teams chips: toggle membership; add new by name.
  const wireTeams = (): void => {
    const chipsHost = bodyHost.querySelector<HTMLElement>('[data-teams-chips]');
    chipsHost?.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-team]');
      if (chip) chip.classList.toggle('on');
    });
    bodyHost.querySelector<HTMLElement>('[data-add-team]')?.addEventListener('click', () => {
      const inp = bodyHost.querySelector<HTMLInputElement>('[data-new-team]');
      const nm = inp?.value.trim();
      const exists = !!chipsHost && [...chipsHost.querySelectorAll<HTMLElement>('[data-team]')].some((c) => c.dataset['team'] === nm);
      if (!nm || !chipsHost || exists) { if (inp) inp.value = ''; return; }
      const chip = document.createElement('span');
      chip.className = 'ov-chip on';
      chip.dataset['team'] = nm;
      chip.textContent = nm;
      chipsHost.appendChild(chip);
      inp!.value = '';
    });
  };
  wireCwd();
  wireProxy();
  wireTeams();

  // "+ Add field" — reveal a populated-gated widget on demand (defaulting, not hardcoding).
  bodyHost.querySelector<HTMLSelectElement>('[data-add-field-pick]')?.addEventListener('change', (e) => {
    const sel = e.currentTarget as HTMLSelectElement;
    const k = sel.value;
    const renderField = RENDERERS[k];
    if (!k || !coreHost || !renderField || bodyHost.querySelector(`[data-field="${k}"]`)) { sel.value = ''; return; }
    coreHost.insertAdjacentHTML('beforeend', renderField());
    sel.querySelector(`option[value="${k}"]`)?.remove();
    sel.value = '';
    if (k === 'cwd') wireCwd();
    if (k === 'proxy') wireProxy();
    if (k === 'teams') wireTeams();
  });

  // Advanced (passthrough) reveal.
  bodyHost.querySelector<HTMLElement>('[data-toggle-advanced]')?.addEventListener('click', (e) => {
    const grp = bodyHost.querySelector<HTMLElement>('[data-advanced-group]');
    if (grp) grp.style.display = '';
    (e.currentTarget as HTMLElement).style.display = 'none';
  });

  // Reload-on-save toggle (lives in the page header).
  root.querySelector<HTMLElement>('[data-reload]')?.addEventListener('click', (e) => {
    reloadOnSave = !reloadOnSave;
    const el = e.currentTarget as HTMLElement;
    el.classList.toggle('on', reloadOnSave);
    const box = el.querySelector<HTMLElement>('.box');
    if (box) box.innerHTML = reloadOnSave
      ? '<svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>'
      : '';
  });

  const submit = async (): Promise<void> => {
    // Core widgets → fields (empty value = omit/clear). teams handled separately.
    const fields: Record<string, unknown> = {};
    bodyHost.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((el) => {
      const val = el.value.trim();
      if (val) fields[el.getAttribute('data-f')!] = val;
    });
    const chipsHost = bodyHost.querySelector<HTMLElement>('[data-teams-chips]');
    if (chipsHost) {
      const teams = [...chipsHost.querySelectorAll<HTMLElement>('[data-team].on')].map((c) => c.dataset['team']!);
      if (teams.length || curTeams.length) fields['teams'] = teams; // [] clears existing memberships
    }
    const passthrough = bodyHost.querySelector<HTMLTextAreaElement>('[data-passthrough]')?.value ?? '';
    const bd = bodyHost.querySelector<HTMLTextAreaElement>('[data-body-text]')?.value ?? '';
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ fields, passthroughRaw: passthrough, body: bd }),
      });
      if (!res.ok) { const b = await res.json().catch(() => null); toast(b?.error ?? 'Save failed', 'error'); return; }
      if (reloadOnSave) {
        await fetch(`/api/agents/${encodeURIComponent(agentName)}/reload`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) });
      }
      toast(`Saved persona for ${agentName}`);
      go(returnRoute);
    } catch { toast('Network error', 'error'); }
  };
  root.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', () => void submit());

  // ⌘/Ctrl+↵ saves from anywhere on the page.
  bodyHost.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); }
  });
}
