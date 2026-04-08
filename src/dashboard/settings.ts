/**
 * <settings-panel> Web Component.
 * Engine config CRUD (displayed as YAML frontmatter) and client-side preferences.
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, showToast, confirmAction } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

const PREFS_KEY = 'dashboardPrefs';

function getPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
  catch { return {}; }
}

function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

// Convert engine config record to YAML frontmatter string
function configToYaml(cfg) {
  const lines = [];
  lines.push(`engine: ${cfg.engine || ''}`);
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  if (cfg.thinking) lines.push(`thinking: ${cfg.thinking}`);
  if (cfg.permissions) lines.push(`permissions: ${cfg.permissions}`);
  // Hooks — stored as JSON strings, display as YAML pipeline
  for (const hookKey of ['hookStart', 'hookResume', 'hookCompact', 'hookExit', 'hookInterrupt', 'hookSubmit']) {
    const yamlKey = hookKey.replace('hook', '').toLowerCase();
    const val = cfg[hookKey];
    if (!val) continue;
    try {
      const steps = JSON.parse(val);
      if (Array.isArray(steps)) {
        lines.push(`${yamlKey}:`);
        for (const step of steps) {
          if (step.type === 'shell' || step.command) {
            lines.push(`  - shell: ${step.command || step.shell}`);
          } else if (step.type === 'wait' || step.wait != null) {
            lines.push(`  - wait: ${step.ms || step.wait || step.duration || 5000}`);
          } else if (step.type === 'capture' || step.capture) {
            lines.push(`  - capture:`);
            const c = step.capture || step;
            if (c.lines) lines.push(`      lines: ${c.lines}`);
            if (c.regex) lines.push(`      regex: ${c.regex}`);
            if (c.var) lines.push(`      var: ${c.var}`);
          } else if (step.type === 'keystroke' || step.key || step.keystroke) {
            lines.push(`  - keystroke: ${step.key || step.keystroke}`);
          } else {
            // Fallback: show as JSON
            lines.push(`  - ${JSON.stringify(step)}`);
          }
        }
      } else {
        lines.push(`${yamlKey}: ${val}`);
      }
    } catch {
      lines.push(`${yamlKey}: ${val}`);
    }
  }
  // Indicators — stored as JSON string, display as YAML
  if (cfg.indicators) {
    try {
      const defs = JSON.parse(cfg.indicators);
      if (Array.isArray(defs) && defs.length > 0) {
        lines.push('indicators:');
        for (const def of defs) {
          lines.push(`  ${def.id}:`);
          if (def.regex) lines.push(`    regex: '${def.regex}'`);
          if (def.badge) lines.push(`    badge: ${def.badge}`);
          if (def.style) lines.push(`    style: ${def.style}`);
          if (def.actions && typeof def.actions === 'object') {
            lines.push('    actions:');
            for (const [actionName, steps] of Object.entries(def.actions)) {
              lines.push(`      ${actionName}:`);
              for (const step of steps) {
                if (step.type === 'keystroke' || step.keystroke) {
                  lines.push(`        - keystroke: ${step.keystroke || step.key || ''}`);
                } else if (step.type === 'shell' || step.command) {
                  lines.push(`        - shell: ${step.command || step.shell || ''}`);
                } else {
                  lines.push(`        - ${JSON.stringify(step)}`);
                }
              }
            }
          }
        }
      }
    } catch { /* skip malformed indicators */ }
  }
  // Detection — stored as JSON, display as YAML
  if (cfg.detection) {
    try {
      const det = JSON.parse(cfg.detection);
      lines.push('detection:');
      const renderPatternList = (key, patterns) => {
        if (!patterns?.length) return;
        lines.push(`  ${key}:`);
        for (const p of patterns) {
          if (typeof p === 'string') {
            lines.push(`    - '${p}'`);
          } else {
            lines.push(`    - pattern: '${p.pattern}'`);
            if (p.lines != null) lines.push(`      lines: ${p.lines}`);
          }
        }
      };
      renderPatternList('idlePatterns', det.idlePatterns);
      renderPatternList('activePatterns', det.activePatterns);
      if (det.contextPattern) lines.push(`  contextPattern: '${det.contextPattern}'`);
      if (det.idleThreshold != null) lines.push(`  idleThreshold: ${det.idleThreshold}`);
      if (det.activeGraceMs != null) lines.push(`  activeGraceMs: ${det.activeGraceMs}`);
      if (det.snapshotLines != null) lines.push(`  snapshotLines: ${det.snapshotLines}`);
      if (det.autoRecover != null) lines.push(`  autoRecover: ${det.autoRecover}`);
    } catch { /* skip malformed detection */ }
  }
  if (cfg.launchEnv && typeof cfg.launchEnv === 'object' && Object.keys(cfg.launchEnv).length > 0) {
    lines.push('env:');
    for (const [k, v] of Object.entries(cfg.launchEnv)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

// Parse simple YAML frontmatter back to config fields for API
function yamlToConfig(yaml, name) {
  const fields = { name, engine: '' };
  const lines = yaml.split('\n');
  let currentKey = null;
  let currentSteps = null;
  let inIndicators = false;
  let indicatorDefs = [];
  let currentIndicator = null;
  let currentActionName = null;
  let currentActionSteps = null;
  let inDetection = false;
  let detectionObj = null;
  let detectionListKey = null;
  const hookMap = { start: 'hookStart', resume: 'hookResume', compact: 'hookCompact', exit: 'hookExit', interrupt: 'hookInterrupt', submit: 'hookSubmit' };

  function flushIndicatorAction() {
    if (currentActionName && currentActionSteps && currentIndicator) {
      if (!currentIndicator.actions) currentIndicator.actions = {};
      currentIndicator.actions[currentActionName] = currentActionSteps;
    }
    currentActionName = null;
    currentActionSteps = null;
  }

  function flushIndicator() {
    flushIndicatorAction();
    if (currentIndicator) indicatorDefs.push(currentIndicator);
    currentIndicator = null;
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();
    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch && !trimmed.startsWith('  ')) {
      // Save previous hook
      if (currentKey && currentSteps) {
        fields[currentKey] = JSON.stringify(currentSteps);
      }
      currentKey = null;
      currentSteps = null;
      // Flush indicators if leaving that section
      if (inIndicators) {
        flushIndicator();
        if (indicatorDefs.length > 0) fields.indicators = JSON.stringify(indicatorDefs);
        inIndicators = false;
        indicatorDefs = [];
      }
      // Flush detection if leaving that section
      if (inDetection) {
        if (detectionObj) fields.detection = JSON.stringify(detectionObj);
        inDetection = false;
        detectionObj = null;
        detectionListKey = null;
      }

      const key = kvMatch[1];
      const val = kvMatch[2].trim();
      if (hookMap[key]) {
        if (val) {
          fields[hookMap[key]] = val;
        } else {
          currentKey = hookMap[key];
          currentSteps = [];
        }
      } else if (key === 'indicators') {
        inIndicators = true;
      } else if (key === 'detection') {
        inDetection = true;
        detectionObj = {};
      } else if (key === 'env') {
        fields.launchEnv = {};
      } else {
        fields[key] = val || null;
      }
    } else if (inDetection) {
      // Detection parsing — 2 indent levels:
      //   2-space: field (idlePatterns, activePatterns, contextPattern, etc.)
      //   4-space: list item (- 'regex')
      const indent = line.search(/\S/);
      const content = trimmed.trim();
      if (indent === 2 && content.match(/^(\w+):\s*(.*)$/)) {
        const m = content.match(/^(\w+):\s*(.*)$/);
        const fieldKey = m[1];
        const fieldVal = m[2].trim().replace(/^'(.*)'$/, '$1');
        if (fieldKey === 'idlePatterns' || fieldKey === 'activePatterns') {
          detectionObj[fieldKey] = [];
          detectionListKey = fieldKey;
        } else if (fieldVal) {
          detectionListKey = null;
          // Numeric fields
          if (['idleThreshold', 'activeGraceMs', 'snapshotLines'].includes(fieldKey)) {
            detectionObj[fieldKey] = parseInt(fieldVal) || 0;
          } else if (fieldKey === 'autoRecover') {
            detectionObj[fieldKey] = fieldVal === 'true';
          } else {
            detectionObj[fieldKey] = fieldVal;
          }
        }
      } else if (indent === 4 && content.startsWith('- ') && detectionListKey && detectionObj[detectionListKey]) {
        const itemStr = content.replace(/^-\s*/, '');
        const patternKv = itemStr.match(/^pattern:\s*(.*)$/);
        if (patternKv) {
          // Object format: - pattern: '...'
          const patternObj = { pattern: patternKv[1].trim().replace(/^'(.*)'$/, '$1') };
          detectionObj[detectionListKey].push(patternObj);
        } else {
          // String format: - '...'
          detectionObj[detectionListKey].push(itemStr.replace(/^'(.*)'$/, '$1'));
        }
      } else if (indent === 6 && detectionListKey && detectionObj[detectionListKey]?.length > 0) {
        // Sub-field of object pattern (e.g. lines: 3)
        const last = detectionObj[detectionListKey][detectionObj[detectionListKey].length - 1];
        if (typeof last === 'object') {
          const subKv = content.match(/^(\w+):\s*(.*)$/);
          if (subKv) last[subKv[1]] = parseInt(subKv[2]) || subKv[2].trim();
        }
      }
    } else if (inIndicators) {
      // Indicator parsing — 4 indent levels:
      //   2-space: indicator id
      //   4-space: indicator field (regex, badge, style, actions)
      //   6-space: action name
      //   8-space: action step
      const indent = line.search(/\S/);
      const content = trimmed.trim();
      const subKv = content.match(/^([^\s:]+):\s*(.*)$/);

      if (indent === 2 && subKv && !content.startsWith('-')) {
        // New indicator definition
        flushIndicator();
        currentIndicator = { id: subKv[1] };
      } else if (indent === 4 && subKv && currentIndicator) {
        // Indicator field
        const fieldKey = subKv[1];
        const fieldVal = subKv[2].trim().replace(/^'(.*)'$/, '$1');
        if (fieldKey === 'actions') {
          // actions: (block start)
        } else {
          currentIndicator[fieldKey] = fieldVal;
        }
      } else if (indent === 6 && subKv && currentIndicator) {
        // Action name
        flushIndicatorAction();
        currentActionName = subKv[1];
        currentActionSteps = [];
      } else if (indent >= 8 && content.startsWith('- ') && currentActionSteps) {
        // Action step
        const stepStr = content.replace(/^-\s*/, '');
        const stepKv = stepStr.match(/^(\w+):\s*(.*)$/);
        if (stepKv) {
          const stepType = stepKv[1];
          const stepVal = stepKv[2].trim();
          if (stepType === 'keystroke') {
            currentActionSteps.push({ type: 'keystroke', keystroke: stepVal });
          } else if (stepType === 'shell') {
            currentActionSteps.push({ type: 'shell', command: stepVal });
          }
        }
      }
    } else if (trimmed.startsWith('  - ') && currentSteps) {
      // Pipeline step
      const stepStr = trimmed.replace(/^\s+-\s*/, '');
      const stepKv = stepStr.match(/^(\w+):\s*(.*)$/);
      if (stepKv) {
        const stepType = stepKv[1];
        const stepVal = stepKv[2].trim();
        if (stepType === 'shell') {
          currentSteps.push({ type: 'shell', command: stepVal });
        } else if (stepType === 'wait') {
          currentSteps.push({ type: 'wait', ms: parseInt(stepVal) || 5000 });
        } else if (stepType === 'keystroke') {
          currentSteps.push({ type: 'keystroke', key: stepVal });
        } else if (stepType === 'capture') {
          currentSteps.push({ type: 'capture', lines: 0, regex: '', var: '' });
        }
      }
    } else if (trimmed.match(/^\s{6}\w+:/) && currentSteps && currentSteps.length > 0) {
      // Capture sub-field (flat format: lines, regex, var directly on the step)
      const last = currentSteps[currentSteps.length - 1];
      if (last.type === 'capture') {
        const subKv = trimmed.trim().match(/^(\w+):\s*(.*)$/);
        if (subKv) {
          const v = subKv[2].trim();
          last[subKv[1]] = isNaN(Number(v)) ? v : Number(v);
        }
      }
    } else if (trimmed.match(/^\s{2}\w+:/) && fields.launchEnv) {
      // Env key
      const envKv = trimmed.trim().match(/^(\w+):\s*(.*)$/);
      if (envKv) fields.launchEnv[envKv[1]] = envKv[2].trim();
    }
  }
  // Save last hook
  if (currentKey && currentSteps) {
    fields[currentKey] = JSON.stringify(currentSteps);
  }
  // Save indicators if file ended while in indicators section
  if (inIndicators) {
    flushIndicator();
    if (indicatorDefs.length > 0) fields.indicators = JSON.stringify(indicatorDefs);
  }
  // Save detection if file ended while in detection section
  if (inDetection && detectionObj) {
    fields.detection = JSON.stringify(detectionObj);
  }
  // Explicitly null out hooks that were removed from the YAML so the API clears them
  for (const dbKey of Object.values(hookMap)) {
    if (!(dbKey in fields)) fields[dbKey] = null;
  }
  return fields;
}

export class SettingsPanel extends HTMLElement {
  _editingConfig = null;
  _addingDest = false;

  render() {
    const configs = state.engineConfigs || [];
    const prefs = getPrefs();
    const submitMode = prefs.submitMode || 'cmd-enter';
    const closeKb = !!prefs.closeKeyboardOnSend;

    let html = '<div class="settings-panel">';

    // ── Engine Configs ──
    html += '<div class="settings-section">';
    html += '<h3>Engine Configs</h3>';
    html += '<p class="settings-hint">Each engine config defines default frontmatter for agents using that engine. Agent-level frontmatter overrides these defaults.</p>';

    for (const cfg of configs) {
      const isEditing = this._editingConfig === cfg.name;
      html += `<div class="config-card" data-config="${esc(cfg.name)}">`;
      html += `<div class="config-header"><span class="config-name">${esc(cfg.name)}</span>`;
      html += '<span class="config-actions">';
      if (isEditing) {
        html += '<button class="settings-btn settings-btn-save" data-action="save">Save</button>';
        html += '<button class="settings-btn settings-btn-cancel" data-action="cancel">Cancel</button>';
      } else {
        html += `<button class="config-action-btn" data-action="edit" data-name="${esc(cfg.name)}">${icon.edit(12)} Edit</button>`;
        html += `<button class="config-action-btn config-delete-btn" data-action="delete" data-name="${esc(cfg.name)}">${icon.trash(12)} Delete</button>`;
      }
      html += '</span></div>';
      if (isEditing) {
        html += `<textarea class="config-yaml-editor" data-config-name="${esc(cfg.name)}">${esc(configToYaml(cfg))}</textarea>`;
      } else {
        html += `<details class="config-details"><summary>Show YAML</summary><pre class="config-yaml-display">${esc(configToYaml(cfg))}</pre></details>`;
      }
      html += '</div>';
    }

    if (this._editingConfig === '__new__') {
      html += '<div class="config-card" data-config="__new__">';
      html += '<div class="config-header"><span class="config-name">New Config</span></div>';
      html += '<div class="config-field"><label>Name</label><input type="text" class="config-name-input" placeholder="e.g. claude-fast" /></div>';
      html += '<textarea class="config-yaml-editor" data-config-name="__new__">engine: claude\nmodel: sonnet</textarea>';
      html += '<div class="config-edit-actions"><button class="settings-btn settings-btn-save" data-action="save">Create</button><button class="settings-btn settings-btn-cancel" data-action="cancel">Cancel</button></div>';
      html += '</div>';
    }

    html += '<div class="config-btn-row">';
    html += `<button class="settings-btn settings-btn-new" id="newConfigBtn">${icon.plus(12)} New Engine Config</button>`;
    html += `<button class="settings-btn" id="resetDefaultsBtn">Reset Defaults</button>`;
    html += '</div>';
    html += '</div>';

    // ── Preferences ──
    html += '<div class="settings-section">';
    html += '<h3>Preferences</h3>';
    html += '<div class="config-card">';
    html += '<div class="pref-row">';
    html += '<label class="pref-label">Submit mode</label>';
    html += `<label class="pref-option"><input type="radio" name="submitMode" value="cmd-enter" ${submitMode === 'cmd-enter' ? 'checked' : ''} /> Cmd/Ctrl+Enter</label>`;
    html += `<label class="pref-option"><input type="radio" name="submitMode" value="enter" ${submitMode === 'enter' ? 'checked' : ''} /> Enter</label>`;
    html += '</div>';
    html += '<div class="pref-row">';
    html += `<label class="pref-option"><input type="checkbox" id="closeKbPref" ${closeKb ? 'checked' : ''} /> Close keyboard on send (iOS)</label>`;
    html += '</div>';
    html += '</div>';
    html += '</div>';

    // ── Pages ──
    html += '<div class="settings-section">';
    html += '<h3>Published Pages</h3>';
    const pages = state.pages || [];
    if (pages.length === 0) {
      html += '<p class="settings-hint">No pages published. Agents can publish via <code>collab publish &lt;slug&gt; &lt;dir&gt;</code></p>';
    } else {
      for (const page of pages) {
        const size = page.totalBytes >= 1024 * 1024 ? (page.totalBytes / 1024 / 1024).toFixed(1) + ' MB' : (page.totalBytes / 1024).toFixed(0) + ' KB';
        html += '<div class="config-card">';
        html += `<div class="config-header">`;
        html += `<span class="config-name"><a href="/pages/${esc(page.slug)}" target="_blank" style="color:var(--accent);text-decoration:none">${esc(page.slug)}</a></span>`;
        html += `<span class="config-actions">`;
        html += `<span style="font-size:11px;color:var(--text-dim)">${esc(String(page.fileCount))} files · ${size}${page.agent ? ' · ' + esc(page.agent) : ''}</span>`;
        html += `<button class="config-action-btn config-delete-btn" data-page-delete="${esc(page.slug)}">${icon.trash(12)} Delete</button>`;
        html += `</span></div>`;
        html += '</div>';
      }
    }
    html += '</div>';

    // ── Data Stores ──
    html += '<div class="settings-section">';
    html += '<h3>Data Stores</h3>';
    const stores = state.stores || [];
    if (stores.length === 0) {
      html += '<p class="settings-hint">No data stores. Agents can create stores via <code>collab store create &lt;name&gt;</code></p>';
    } else {
      for (const store of stores) {
        const updated = store.updatedAt ? new Date(store.updatedAt).toLocaleDateString() : '';
        html += '<div class="config-card">';
        html += `<div class="config-header">`;
        html += `<span class="config-name">${esc(store.name)}</span>`;
        html += `<span class="config-actions">`;
        html += `<span style="font-size:11px;color:var(--text-dim)">${updated ? 'updated ' + esc(updated) : ''}${store.agent ? (updated ? ' · ' : '') + esc(store.agent) : ''}</span>`;
        html += `<button class="config-action-btn config-delete-btn" data-store-delete="${esc(store.name)}">${icon.trash(12)} Delete</button>`;
        html += `</span></div>`;
        html += '</div>';
      }
    }
    html += '</div>';

    // ── Destinations (Telegram, etc.) ──
    html += '<div class="settings-section">';
    html += '<h3>Destinations</h3>';
    const destinations = state.destinations || [];
    if (destinations.length === 0) {
      html += '<p class="settings-hint">No destinations configured. Add a Telegram destination to send and receive messages from agents.</p>';
    }
    for (const dest of destinations) {
      const updated = dest.updatedAt ? new Date(dest.updatedAt).toLocaleDateString() : '';
      html += '<div class="config-card">';
      html += '<div class="config-header">';
      html += `<span class="config-name">${esc(dest.name)} <span style="font-size:11px;color:var(--text-dim)">(${esc(dest.type)})</span></span>`;
      html += '<span class="config-actions">';
      html += `<span style="font-size:11px;color:var(--text-dim)">${dest.enabled ? 'enabled' : 'disabled'}${updated ? ' · ' + esc(updated) : ''}</span>`;
      html += `<button class="config-action-btn" data-dest-test="${esc(dest.name)}">Test</button>`;
      html += `<button class="config-action-btn config-delete-btn" data-dest-delete="${esc(dest.name)}">${icon.trash(12)} Delete</button>`;
      html += '</span></div>';
      html += '</div>';
    }
    if (this._addingDest) {
      html += '<div class="config-card">';
      html += '<div class="config-header"><span class="config-name">New Telegram Destination</span></div>';
      html += '<div class="config-field"><label>Name</label><input type="text" id="destNameInput" class="config-name-input" placeholder="e.g. my-telegram" /></div>';
      html += '<div class="config-field"><label>Bot Token</label><input type="text" id="destTokenInput" class="config-name-input" placeholder="123456:ABC-DEF..." style="flex:1" /></div>';
      html += '<div class="config-field"><label>Chat ID</label><input type="text" id="destChatInput" class="config-name-input" placeholder="-1001234567890" /></div>';
      html += '<p class="settings-hint" style="margin:4px 0 0">Get a bot token from <code>@BotFather</code> on Telegram. Send a message to the bot, then use the Telegram API to find your chat ID.</p>';
      html += '<div class="config-edit-actions"><button class="settings-btn settings-btn-save" id="destSaveBtn">Add</button><button class="settings-btn settings-btn-cancel" id="destCancelBtn">Cancel</button></div>';
      html += '</div>';
    }
    html += '<div class="config-btn-row">';
    html += `<button class="settings-btn settings-btn-new" id="addDestBtn">${icon.plus(12)} Add Telegram</button>`;
    html += '</div>';
    html += '</div>';

    html += '</div>';
    this.innerHTML = html;
    this._bindEvents();
    // Auto-size textareas to fit content
    this.querySelectorAll('.config-yaml-editor').forEach((ta) => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
    });
    // Scroll editing card into view
    if (this._editingConfig) {
      const card = this.querySelector(`[data-config="${this._editingConfig}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  _bindEvents() {
    this.querySelector('#newConfigBtn')?.addEventListener('click', () => {
      this._editingConfig = '__new__';
      this.render();
    });

    this.querySelector('#resetDefaultsBtn')?.addEventListener('click', async () => {
      if (await confirmAction('Reset default engine configs (claude, codex, opencode) to built-in defaults? Custom edits to these configs will be lost.')) {
        await this._resetDefaults();
      }
    });

    this.querySelectorAll('[data-page-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.pageDelete;
        if (await confirmAction(`Delete page "${slug}"? This removes all published files.`)) {
          try {
            const res = await fetch(`/api/pages/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: authHeaders() });
            if (res.ok) {
              state.pages = state.pages.filter(p => p.slug !== slug);
              showToast('Deleted', 'success');
              this.render();
            } else {
              const b = await res.json().catch(() => null);
              showToast(b?.error || 'Delete failed', 'error');
            }
          } catch { showToast('Network error', 'error'); }
        }
      });
    });

    this.querySelectorAll('[data-dest-test]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.destTest;
        try {
          const res = await fetch(`/api/destinations/${encodeURIComponent(name)}/test`, { method: 'POST', headers: authHeaders() });
          if (res.ok) {
            showToast('Test message sent', 'success');
          } else {
            const b = await res.json().catch(() => null);
            showToast(b?.error || 'Test failed', 'error');
          }
        } catch { showToast('Network error', 'error'); }
      });
    });

    this.querySelectorAll('[data-dest-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.destDelete;
        if (await confirmAction(`Delete destination "${name}"?`)) {
          try {
            const res = await fetch(`/api/destinations/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
            if (res.ok) {
              state.destinations = state.destinations.filter(d => d.name !== name);
              showToast('Deleted', 'success');
              this.render();
            } else {
              const b = await res.json().catch(() => null);
              showToast(b?.error || 'Delete failed', 'error');
            }
          } catch { showToast('Network error', 'error'); }
        }
      });
    });

    this.querySelector('#addDestBtn')?.addEventListener('click', () => {
      this._addingDest = true;
      this.render();
    });

    this.querySelector('#destCancelBtn')?.addEventListener('click', () => {
      this._addingDest = false;
      this.render();
    });

    this.querySelector('#destSaveBtn')?.addEventListener('click', async () => {
      const nameEl = this.querySelector('#destNameInput');
      const tokenEl = this.querySelector('#destTokenInput');
      const chatEl = this.querySelector('#destChatInput');
      const name = nameEl?.value?.trim();
      const botToken = tokenEl?.value?.trim();
      const chatId = chatEl?.value?.trim();
      if (!name || !botToken || !chatId) {
        showToast('All fields are required', 'error');
        return;
      }
      try {
        const res = await fetch('/api/destinations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ name, type: 'telegram', config: { botToken, chatId }, enabled: true }),
        });
        if (res.ok) {
          const dest = await res.json();
          state.destinations = [...(state.destinations || []), dest];
          this._addingDest = false;
          showToast('Telegram destination added', 'success');
          this.render();
        } else {
          const b = await res.json().catch(() => null);
          showToast(b?.error || 'Failed to add destination', 'error');
        }
      } catch { showToast('Network error', 'error'); }
    });

    this.querySelectorAll('[data-store-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.storeDelete;
        if (await confirmAction(`Delete data store "${name}"? This removes all stored data.`)) {
          try {
            const res = await fetch(`/api/stores/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
            if (res.ok) {
              state.stores = state.stores.filter(s => s.name !== name);
              showToast('Deleted', 'success');
              this.render();
            } else {
              const b = await res.json().catch(() => null);
              showToast(b?.error || 'Delete failed', 'error');
            }
          } catch { showToast('Network error', 'error'); }
        }
      });
    });

    this.querySelectorAll('.config-action-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.action === 'edit') {
          this._editingConfig = btn.dataset.name;
          this.render();
        } else if (btn.dataset.action === 'delete') {
          if (await confirmAction(`Delete engine config "${btn.dataset.name}"?`)) {
            await this._deleteConfig(btn.dataset.name);
          }
        }
      });
    });

    this.querySelectorAll('.config-actions button[data-action="save"], .config-actions button[data-action="cancel"], .config-edit-actions button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.action === 'cancel') {
          this._editingConfig = null;
          this.render();
          return;
        }
        if (btn.dataset.action === 'save') {
          const card = btn.closest('.config-card');
          const configName = card.dataset.config;
          const textarea = card.querySelector('.config-yaml-editor');
          const yaml = textarea.value;

          if (configName === '__new__') {
            const nameInput = card.querySelector('.config-name-input');
            const name = nameInput?.value?.trim();
            if (!name) { showToast('Name is required', 'error'); return; }
            const fields = yamlToConfig(yaml, name);
            if (!fields.engine) { showToast('engine is required in config', 'error'); return; }
            await this._createConfig(fields);
          } else {
            const fields = yamlToConfig(yaml, configName);
            await this._updateConfig(configName, fields);
          }
        }
      });
    });

    this.querySelectorAll('input[name="submitMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const prefs = getPrefs();
        prefs.submitMode = radio.value;
        savePrefs(prefs);
      });
    });

    this.querySelector('#closeKbPref')?.addEventListener('change', (e) => {
      const prefs = getPrefs();
      prefs.closeKeyboardOnSend = e.target.checked;
      savePrefs(prefs);
    });
  }

  async _createConfig(fields) {
    try {
      const res = await fetch('/api/engine-configs', { method: 'POST', headers: authHeaders(), body: JSON.stringify(fields) });
      if (!res.ok) { const b = await res.json().catch(() => null); showToast(b?.error || 'Create failed', 'error'); return; }
      const config = await res.json();
      const idx = state.engineConfigs.findIndex(c => c.name === config.name);
      if (idx >= 0) state.engineConfigs[idx] = config; else state.engineConfigs.push(config);
      this._editingConfig = null;
      showToast('Created', 'success');
      this.render();
    } catch { showToast('Network error', 'error'); }
  }

  async _updateConfig(name, fields) {
    try {
      const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(fields) });
      if (!res.ok) { const b = await res.json().catch(() => null); showToast(b?.error || 'Update failed', 'error'); return; }
      const config = await res.json();
      const idx = state.engineConfigs.findIndex(c => c.name === name);
      if (idx >= 0) state.engineConfigs[idx] = config;
      this._editingConfig = null;
      showToast('Saved', 'success');
      this.render();
    } catch { showToast('Network error', 'error'); }
  }

  async _deleteConfig(name) {
    try {
      const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) { const b = await res.json().catch(() => null); showToast(b?.error || 'Delete failed', 'error'); return; }
      state.engineConfigs = state.engineConfigs.filter(c => c.name !== name);
      showToast('Deleted', 'success');
      this.render();
    } catch { showToast('Network error', 'error'); }
  }

  async _resetDefaults() {
    try {
      const res = await fetch('/api/engine-configs/reset-defaults', { method: 'POST', headers: authHeaders() });
      if (!res.ok) { const b = await res.json().catch(() => null); showToast(b?.error || 'Reset failed', 'error'); return; }
      // Refresh full list from server
      const listRes = await fetch('/api/engine-configs', { headers: authHeaders() });
      if (listRes.ok) state.engineConfigs = await listRes.json();
      this._editingConfig = null;
      showToast('Defaults restored', 'success');
      this.render();
    } catch { showToast('Network error', 'error'); }
  }
}

customElements.define('settings-panel', SettingsPanel);
