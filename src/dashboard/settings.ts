/**
 * Settings — five sections in a single scrolling pane.
 *
 *   1. Engine configs   /api/engine-configs
 *   2. Preferences      localStorage (per-device)
 *   3. Published pages  /api/pages
 *   4. Data stores      /api/stores
 *   5. Destinations     /api/destinations
 *
 * Sticky horizontal sub-nav at top, anchor-scrolled. Engine configs render
 * with a meta summary + collapsed/expanded/edit states. Preferences use
 * radio + checkbox controls; saves on change to localStorage.
 */
import type {
  EngineConfigRecord,
  PageRecord,
  DataStoreRecord,
  DestinationRecord,
} from '../shared/types.ts';
import { on, authHeaders } from './state.ts';
import { registerRoute, go } from './routing.ts';
import type { Route } from './state.ts';
import { escapeHtml, toast } from './util.ts';

let configs: EngineConfigRecord[] = [];
let pages: PageRecord[] = [];
let stores: DataStoreRecord[] = [];
let destinations: DestinationRecord[] = [];
const detachers: Array<() => void> = [];

export function setupSettings(): void {
  registerRoute('settings', render);
  registerRoute('edit-engine', renderEditEngine);
}

function render(root: HTMLElement): void {
  root.innerHTML = `
    <div class="st-page" style="height:100vh;overflow:hidden;display:flex;flex-direction:column;background:var(--paper);">
      <div class="st-hdr">
        <div>
          <h1 class="pg-title">Settings</h1>
          <div class="pg-stats" data-stats>—</div>
          <span class="lede">
            Engine defaults applied to agents, client-side preferences for this device,
            published page surfaces, agent-writable data stores, and outbound destinations.
          </span>
        </div>
      </div>
      <div class="st-subnav" data-subnav>
        <span class="jump on" data-jump="engines">Engine configs <span class="ct" data-c-engines>0</span></span>
        <span class="jump" data-jump="prefs">Preferences</span>
        <span class="jump" data-jump="pages">Published pages <span class="ct" data-c-pages>0</span></span>
        <span class="jump" data-jump="stores">Data stores <span class="ct" data-c-stores>0</span></span>
        <span class="jump" data-jump="destinations">Destinations <span class="ct" data-c-destinations>0</span></span>
      </div>
      <div class="st-scroll" style="flex:1;overflow-y:auto;" data-scroll></div>
    </div>
  `;
  void loadAll();
  wireSubnav(root);

  detachers.push(on('ws:engine_config_update', () => void loadAll()));
  detachers.push(on('ws:engine_config_deleted', () => void loadAll()));
  detachers.push(on('ws:pages_update', () => void loadAll()));
  detachers.push(on('ws:stores_update', () => void loadAll()));
  detachers.push(on('ws:destinations_update', () => void loadAll()));
  detachers.push(on('route-changed', (r) => {
    if ((r as { kind?: string })?.kind !== 'settings') teardown();
  }));
}

function teardown(): void {
  while (detachers.length) {
    const fn = detachers.pop();
    try { fn?.(); } catch {}
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([
    loadConfigs(),
    loadPages(),
    loadStores(),
    loadDestinations(),
  ]);
  rerender();
}

async function loadConfigs(): Promise<void> {
  try {
    const res = await fetch('/api/engine-configs', { headers: authHeaders() });
    if (res.ok) configs = await res.json() as EngineConfigRecord[];
  } catch {}
}
async function loadPages(): Promise<void> {
  try {
    const res = await fetch('/api/pages', { headers: authHeaders() });
    if (res.ok) pages = await res.json() as PageRecord[];
  } catch {}
}
async function loadStores(): Promise<void> {
  try {
    const res = await fetch('/api/stores', { headers: authHeaders() });
    if (res.ok) stores = await res.json() as DataStoreRecord[];
  } catch {}
}
async function loadDestinations(): Promise<void> {
  try {
    const res = await fetch('/api/destinations', { headers: authHeaders() });
    if (res.ok) destinations = await res.json() as DestinationRecord[];
  } catch {}
}

function rerender(): void {
  const root = document.querySelector<HTMLElement>('.st-page');
  if (!root) return;

  // Counts in chips
  setText('[data-c-engines]', String(configs.length));
  setText('[data-c-pages]', String(pages.length));
  setText('[data-c-stores]', String(stores.length));
  setText('[data-c-destinations]', String(destinations.length));
  const stats = root.querySelector<HTMLElement>('[data-stats]');
  if (stats) stats.innerHTML = `
    <span class="num">${configs.length}</span> engine configs
    <span class="sep">·</span>
    <span class="num">${pages.length}</span> pages
    <span class="sep">·</span>
    <span class="num">${stores.length}</span> data stores
    <span class="sep">·</span>
    <span class="num">${destinations.length}</span> destinations
  `;

  const scroll = root.querySelector<HTMLElement>('[data-scroll]');
  if (!scroll) return;
  scroll.innerHTML = `
    ${enginesSectionHtml()}
    ${prefsSectionHtml()}
    ${pagesSectionHtml()}
    ${storesSectionHtml()}
    ${destinationsSectionHtml()}
  `;
  wireSections(scroll);
}

/* ── engine configs ────────────────────────────────────────────────── */

function enginesSectionHtml(): string {
  const items = configs.map((c) => engineItemHtml(c)).join('');
  return `
    <section class="st-section" id="sec-engines">
      <div class="st-section-hdr">
        <div class="title-block">
          <h3>Engine configs</h3>
          <span class="label">YAML frontmatter defaults</span>
        </div>
        <div class="right">
          <button class="btn" data-reset-defaults>↻ Reset defaults</button>
          <button class="btn primary" data-new-engine>+ New engine config</button>
        </div>
      </div>
      <p class="lede">Each engine config defines default frontmatter for agents using that engine. Agent-level frontmatter overrides these defaults.</p>
      ${items || `<div class="st-empty">No engine configs yet.</div>`}
    </section>
  `;
}

function engineItemHtml(c: EngineConfigRecord): string {
  const meta: string[] = [];
  if (c.model) meta.push(`<span class="lbl">model</span> <span class="val">${escapeHtml(c.model)}</span>`);
  if (c.thinking) meta.push(`<span class="lbl">thinking</span> <span class="val">${escapeHtml(c.thinking)}</span>`);
  if (c.permissions) meta.push(`<span class="lbl">permissions</span> <span class="val">${escapeHtml(c.permissions)}</span>`);
  const hookKeys = ['hookStart','hookResume','hookCompact','hookExit','hookInterrupt','hookReload','hookSubmit']
    .filter((k) => (c as Record<string, unknown>)[k]);
  if (hookKeys.length) meta.push(`<span class="lbl">hooks</span> <span class="val">${hookKeys.length}</span>`);

  return `
    <div class="st-item" data-engine="${escapeHtml(c.name)}">
      <div class="st-item-hdr">
        <span class="nm">${escapeHtml(c.name)}</span>
        <span class="kind ${escapeHtml(c.engine)}">engine: ${escapeHtml(c.engine)}</span>
        <div class="actions">
          <button data-act="edit-engine" data-name="${escapeHtml(c.name)}">Edit</button>
          <button data-act="delete-engine" data-name="${escapeHtml(c.name)}">Delete</button>
        </div>
      </div>
      <div class="meta">${meta.join('<span class="sep">·</span>')}</div>
    </div>
  `;
}

/* ── preferences ───────────────────────────────────────────────────── */

const PREFS_KEY = 'dashboardPrefs_v3';
type Prefs = { submitMode: 'cmd-enter' | 'enter'; closeKeyboardOnSend: boolean };
function getPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      submitMode: raw.submitMode === 'enter' ? 'enter' : 'cmd-enter',
      closeKeyboardOnSend: !!raw.closeKeyboardOnSend,
    };
  } catch {
    return { submitMode: 'cmd-enter', closeKeyboardOnSend: false };
  }
}
function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

function prefsSectionHtml(): string {
  const p = getPrefs();
  return `
    <section class="st-section" id="sec-prefs">
      <div class="st-section-hdr"><div class="title-block"><h3>Preferences</h3><span class="label">this device · localStorage</span></div></div>
      <p class="lede">Saved per-browser. Not synced to the orchestrator.</p>

      <div class="st-pref">
        <div class="lbl">Submit mode<span class="sub">How the composer Send button is bound to your keyboard.</span></div>
        <div class="ctrl">
          <label class="radio ${p.submitMode === 'cmd-enter' ? 'on' : ''}" data-pref-submit="cmd-enter">
            <span class="dot"></span>Cmd / Ctrl + Enter
          </label>
          <label class="radio ${p.submitMode === 'enter' ? 'on' : ''}" data-pref-submit="enter">
            <span class="dot"></span>Enter
          </label>
        </div>
      </div>

      <div class="st-pref">
        <div class="lbl">Close keyboard on send<span class="sub">iOS only — dismisses the on-screen keyboard after submitting.</span></div>
        <div class="ctrl">
          <label class="check ${p.closeKeyboardOnSend ? 'on' : ''}" data-pref-closekb>
            <span class="box">${p.closeKeyboardOnSend ? '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg>' : ''}</span>
            ${p.closeKeyboardOnSend ? 'Enabled' : 'Disabled'}
          </label>
        </div>
      </div>
    </section>
  `;
}

/* ── pages / stores / destinations ─────────────────────────────────── */

function pagesSectionHtml(): string {
  return `
    <section class="st-section" id="sec-pages">
      <div class="st-section-hdr"><div class="title-block"><h3>Published pages</h3><span class="label">static surfaces served at /pages/&lt;slug&gt;</span></div></div>
      <p class="lede">Agents publish directories via <code>collab publish &lt;slug&gt; &lt;dir&gt;</code>.</p>
      ${pages.length === 0
        ? `<div class="st-empty">No pages published yet.</div>`
        : pages.map((p) => `
        <div class="st-item">
          <div class="st-item-hdr">
            <span class="nm"><a href="/pages/${escapeHtml(p.slug)}" target="_blank">${escapeHtml(p.slug)}</a></span>
            <span class="kind">page</span>
            <div class="actions">
              <button data-act="delete-page" data-slug="${escapeHtml(p.slug)}">Delete</button>
            </div>
          </div>
          <div class="meta">
            <span class="num">${p.fileCount ?? 0}</span> files
            <span class="sep">·</span>
            <span class="num">${formatBytes(p.totalBytes ?? 0)}</span>
            ${p.agent ? `<span class="sep">·</span> by <span class="who">${escapeHtml(p.agent)}</span>` : ''}
          </div>
        </div>`).join('')}
    </section>
  `;
}

function storesSectionHtml(): string {
  return `
    <section class="st-section" id="sec-stores">
      <div class="st-section-hdr"><div class="title-block"><h3>Data stores</h3><span class="label">agent-writable key-value</span></div></div>
      <p class="lede">Agents create stores via <code>collab store create &lt;name&gt;</code>.</p>
      ${stores.length === 0
        ? `<div class="st-empty">No data stores yet.</div>`
        : stores.map((s) => `
        <div class="st-item">
          <div class="st-item-hdr">
            <span class="nm">${escapeHtml(s.name)}</span>
            <span class="kind">store</span>
            <div class="actions">
              <button data-act="delete-store" data-name="${escapeHtml(s.name)}">Delete</button>
            </div>
          </div>
          <div class="meta">
            ${s.updatedAt ? `updated ${ago(s.updatedAt)} ago` : 'never updated'}
            ${s.agent ? `<span class="sep">·</span> owner <span class="who">${escapeHtml(s.agent)}</span>` : ''}
          </div>
        </div>`).join('')}
    </section>
  `;
}

function destinationsSectionHtml(): string {
  return `
    <section class="st-section" id="sec-destinations">
      <div class="st-section-hdr">
        <div class="title-block"><h3>Destinations</h3><span class="label">outbound channels</span></div>
        <div class="right"><button class="btn primary" data-new-dest>+ Add Telegram</button></div>
      </div>
      <p class="lede">Agents can send messages to external destinations. Currently only Telegram is supported.</p>
      ${destinations.length === 0
        ? `<div class="st-empty">No destinations configured.</div>`
        : destinations.map((d) => `
        <div class="st-item">
          <div class="st-item-hdr">
            <span class="nm">${escapeHtml(d.name)}</span>
            <span class="kind telegram">${escapeHtml(d.type)}</span>
            <span class="state ${d.enabled ? 'enabled' : 'disabled'}"><span class="dot"></span>${d.enabled ? 'enabled' : 'disabled'}</span>
            <div class="actions">
              <button data-act="test-dest" data-name="${escapeHtml(d.name)}">Test</button>
              <button data-act="delete-dest" data-name="${escapeHtml(d.name)}">Delete</button>
            </div>
          </div>
        </div>`).join('')}
    </section>
  `;
}

/* ── wiring ────────────────────────────────────────────────────────── */

function wireSubnav(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-jump]').forEach((el) => {
    el.addEventListener('click', () => {
      root.querySelectorAll<HTMLElement>('.st-subnav .jump').forEach((j) => j.classList.remove('on'));
      el.classList.add('on');
      const target = `sec-${el.dataset['jump']}`;
      const tgt = root.querySelector<HTMLElement>(`#${target}`);
      tgt?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function wireSections(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLElement>('[data-pref-submit]').forEach((el) => {
    el.addEventListener('click', () => {
      const mode = el.dataset['prefSubmit'] as 'cmd-enter' | 'enter';
      const p = getPrefs();
      p.submitMode = mode;
      savePrefs(p);
      rerender();
    });
  });
  scope.querySelector<HTMLElement>('[data-pref-closekb]')?.addEventListener('click', () => {
    const p = getPrefs();
    p.closeKeyboardOnSend = !p.closeKeyboardOnSend;
    savePrefs(p);
    rerender();
  });

  scope.querySelectorAll<HTMLElement>('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset['act'];
      switch (act) {
        case 'edit-engine': {
          const name = btn.dataset['name']!;
          // Navigate to the dedicated editor page (more room than a modal).
          const { go } = await import('./routing.ts');
          go({ kind: 'edit-engine', name });
          return;
        }
        case 'delete-engine': {
          const name = btn.dataset['name']!;
          if (!window.confirm(`Delete engine config "${name}"?`)) return;
          await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
          void loadConfigs().then(rerender);
          return;
        }
        case 'delete-page': {
          const slug = btn.dataset['slug']!;
          if (!window.confirm(`Delete page "${slug}"?`)) return;
          await fetch(`/api/pages/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: authHeaders() });
          void loadPages().then(rerender);
          return;
        }
        case 'delete-store': {
          const name = btn.dataset['name']!;
          if (!window.confirm(`Delete store "${name}"?`)) return;
          await fetch(`/api/stores/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
          void loadStores().then(rerender);
          return;
        }
        case 'test-dest': {
          const name = btn.dataset['name']!;
          const res = await fetch(`/api/destinations/${encodeURIComponent(name)}/test`, { method: 'POST', headers: authHeaders() });
          if (res.ok) showToast('Test sent');
          else showToast('Test failed', 'error');
          return;
        }
        case 'delete-dest': {
          const name = btn.dataset['name']!;
          if (!window.confirm(`Delete destination "${name}"?`)) return;
          await fetch(`/api/destinations/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
          void loadDestinations().then(rerender);
          return;
        }
      }
    });
  });

  scope.querySelector<HTMLElement>('[data-reset-defaults]')?.addEventListener('click', async () => {
    if (!window.confirm('Reset built-in engine configs to defaults? Custom edits to claude/codex/opencode will be lost.')) return;
    await fetch('/api/engine-configs/reset-defaults', { method: 'POST', headers: authHeaders() });
    void loadConfigs().then(rerender);
  });

  scope.querySelector<HTMLElement>('[data-new-engine]')?.addEventListener('click', () => {
    showToast('New engine config flow ships in PR 9.');
  });

  scope.querySelector<HTMLElement>('[data-new-dest]')?.addEventListener('click', () => openTelegramForm());
}

function openTelegramForm(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,24,28,0.18);z-index:50;display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div class="st-addform" style="background:var(--paper-card);width:520px;max-width:95vw;border-radius:6px;border:1px solid var(--rule);padding:20px;">
      <div class="ttl" style="font-size:16px;font-weight:700;margin-bottom:14px;">+ New Telegram destination</div>
      <div class="field"><label>Name</label><input class="ov-input" type="text" data-in-name placeholder="e.g. ops-channel"></div>
      <div class="field"><label>Bot token</label><input class="ov-input" type="text" data-in-token placeholder="123456:ABC-DEF…"></div>
      <div class="field"><label>Chat ID</label><input class="ov-input" type="text" data-in-chat placeholder="-1001234567890"></div>
      <div class="help">Create a bot via <code>@BotFather</code>. Send the bot a message, then GET <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> to find the chat ID.</div>
      <div class="actions" style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px;">
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn primary" data-submit>Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', async () => {
    const name = overlay.querySelector<HTMLInputElement>('[data-in-name]')?.value.trim();
    const botToken = overlay.querySelector<HTMLInputElement>('[data-in-token]')?.value.trim();
    const chatId = overlay.querySelector<HTMLInputElement>('[data-in-chat]')?.value.trim();
    if (!name || !botToken || !chatId) {
      showToast('All fields required', 'error');
      return;
    }
    try {
      const res = await fetch('/api/destinations', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, type: 'telegram', config: { botToken, chatId }, enabled: true }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        showToast(b?.error ?? 'Add failed', 'error');
        return;
      }
      overlay.remove();
      void loadDestinations().then(rerender);
    } catch { showToast('Network error', 'error'); }
  });
}

/* ── helpers ───────────────────────────────────────────────────────── */

function formatBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function setText(sel: string, text: string): void {
  const el = document.querySelector<HTMLElement>(sel);
  if (el) el.textContent = text;
}


/* ── engine config editor ──────────────────────────────────────────── */

/**
 * Modal editor for a single engine config. The orchestrator stores most
 * shape (hooks, indicators, detection, customButtons) as JSON-encoded
 * strings; this editor surfaces simple fields as inputs and a single
 * "Advanced JSON" textarea for everything else so the operator can fine-
 * tune without having to remember the column names.
 */
/* ── Edit engine — full-page editor ─────────────────────────────────── */

const ADVANCED_KEYS = [
  'hookStart', 'hookResume', 'hookCompact', 'hookExit', 'hookInterrupt',
  'hookReload', 'hookSubmit', 'indicators', 'detection', 'customButtons',
  'launchEnv',
] as const;
const STRING_ADVANCED_KEYS = [
  'hookStart','hookResume','hookCompact','hookExit','hookInterrupt',
  'hookReload','hookSubmit','indicators','detection','customButtons',
];

function renderEditEngine(root: HTMLElement, route: Route): void {
  if (route.kind !== 'edit-engine') return;
  const name = route.name;

  root.innerHTML = `
    <div class="ee-page">
      <div class="ee-hdr">
        <button class="back" data-back>← Back to settings</button>
        <div class="title-block">
          <div class="super"><span>Settings</span> <span class="crumb-arrow">/</span> <span>Engine configs</span></div>
          <h1 class="title">${escapeHtml(name)}</h1>
          <code class="api-hint">PUT /api/engine-configs/${escapeHtml(name)}</code>
        </div>
        <div class="right">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-submit>Save changes</button>
        </div>
      </div>
      <div class="ee-body" data-body>
        <div class="ee-loading">Loading…</div>
      </div>
    </div>
  `;

  root.querySelector<HTMLElement>('[data-back]')?.addEventListener('click', () => go({ kind: 'settings' }));
  root.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', () => go({ kind: 'settings' }));

  void hydrateEditEngine(root, name);
}

async function hydrateEditEngine(root: HTMLElement, name: string): Promise<void> {
  const body = root.querySelector<HTMLElement>('[data-body]');
  if (!body) return;
  let cfg: EngineConfigRecord;
  try {
    const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, { headers: authHeaders() });
    if (!res.ok) {
      body.innerHTML = `<div class="ee-error">Could not load <code>${escapeHtml(name)}</code> (${res.status}).</div>`;
      return;
    }
    cfg = await res.json() as EngineConfigRecord;
  } catch {
    body.innerHTML = `<div class="ee-error">Network error loading <code>${escapeHtml(name)}</code>.</div>`;
    return;
  }

  // Split the persisted JSON-string fields back into a single editable blob.
  const advanced: Record<string, unknown> = {};
  for (const k of ADVANCED_KEYS) {
    const v = (cfg as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') {
      try { advanced[k] = JSON.parse(v); } catch { advanced[k] = v; }
    } else {
      advanced[k] = v;
    }
  }
  const advancedJson = JSON.stringify(advanced, null, 2);

  body.innerHTML = `
    <div class="ee-grid">
      <div class="ee-field">
        <label>Engine</label>
        <select class="ov-select" data-engine>
          <option value="claude" ${cfg.engine === 'claude' ? 'selected' : ''}>claude</option>
          <option value="codex"  ${cfg.engine === 'codex'  ? 'selected' : ''}>codex</option>
          <option value="opencode" ${cfg.engine === 'opencode' ? 'selected' : ''}>opencode</option>
        </select>
      </div>
      <div class="ee-field">
        <label>Model</label>
        <input class="ov-input" type="text" data-model value="${escapeHtml(cfg.model ?? '')}" placeholder="(engine default)">
      </div>
      <div class="ee-field">
        <label>Thinking</label>
        <input class="ov-input" type="text" data-thinking value="${escapeHtml(cfg.thinking ?? '')}" placeholder="(none)">
      </div>
      <div class="ee-field">
        <label>Permissions</label>
        <input class="ov-input" type="text" data-permissions value="${escapeHtml(cfg.permissions ?? '')}" placeholder="(default)">
      </div>
    </div>
    <div class="ee-advanced">
      <label>Advanced (JSON)</label>
      <div class="help">hooks · indicators · detection · customButtons · launchEnv. Edit as JSON; strictly parsed on save.</div>
      <textarea class="ov-textarea" data-advanced spellcheck="false">${escapeHtml(advancedJson)}</textarea>
      <div class="help" data-parse-err></div>
    </div>
    <div class="ee-foot">
      <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd> save</span>
    </div>
  `;

  const submit = async (): Promise<void> => {
    const engine = body.querySelector<HTMLSelectElement>('[data-engine]')!.value;
    const model = body.querySelector<HTMLInputElement>('[data-model]')!.value.trim();
    const thinking = body.querySelector<HTMLInputElement>('[data-thinking]')!.value.trim();
    const permissions = body.querySelector<HTMLInputElement>('[data-permissions]')!.value.trim();
    const advRaw = body.querySelector<HTMLTextAreaElement>('[data-advanced]')!.value;
    const errEl = body.querySelector<HTMLElement>('[data-parse-err]')!;
    errEl.textContent = '';
    errEl.classList.remove('shown');

    let adv: Record<string, unknown> = {};
    try { adv = advRaw.trim() ? JSON.parse(advRaw) : {}; }
    catch (err) {
      errEl.textContent = `JSON parse error: ${(err as Error).message}`;
      errEl.classList.add('shown');
      return;
    }

    const payload: Record<string, unknown> = {
      name,
      engine,
      model: model || null,
      thinking: thinking || null,
      permissions: permissions || null,
    };
    for (const k of STRING_ADVANCED_KEYS) {
      payload[k] = adv[k] !== undefined ? JSON.stringify(adv[k]) : null;
    }
    payload['launchEnv'] = adv['launchEnv'] ?? null;

    try {
      const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        errEl.textContent = b?.error ?? 'Save failed';
        errEl.classList.add('shown');
        return;
      }
      showToast('Saved');
      go({ kind: 'settings' });
    } catch {
      showToast('Network error', 'error');
    }
  };

  root.querySelector<HTMLElement>('[data-submit]')?.addEventListener('click', () => void submit());
  body.querySelector<HTMLTextAreaElement>('[data-advanced]')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); }
  });
}

// Use toast from util.ts, aliased as showToast for backward compat
const showToast = toast;
