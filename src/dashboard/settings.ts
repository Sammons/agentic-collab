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
            lines.push(`  - wait: ${step.wait || step.duration || 5000}`);
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
  const hookMap = { start: 'hookStart', resume: 'hookResume', compact: 'hookCompact', exit: 'hookExit', interrupt: 'hookInterrupt', submit: 'hookSubmit' };

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

      const key = kvMatch[1];
      const val = kvMatch[2].trim();
      if (hookMap[key]) {
        if (val) {
          fields[hookMap[key]] = val;
        } else {
          currentKey = hookMap[key];
          currentSteps = [];
        }
      } else if (key === 'env') {
        fields.launchEnv = {};
      } else {
        fields[key] = val || null;
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
          currentSteps.push({ type: 'wait', duration: parseInt(stepVal) || 5000 });
        } else if (stepType === 'keystroke') {
          currentSteps.push({ type: 'keystroke', keystroke: stepVal });
        } else if (stepType === 'capture') {
          currentSteps.push({ type: 'capture', capture: {} });
        }
      }
    } else if (trimmed.match(/^\s{6}\w+:/) && currentSteps && currentSteps.length > 0) {
      // Capture sub-field
      const last = currentSteps[currentSteps.length - 1];
      if (last.type === 'capture' || last.capture) {
        const subKv = trimmed.trim().match(/^(\w+):\s*(.*)$/);
        if (subKv) {
          if (!last.capture) last.capture = {};
          const v = subKv[2].trim();
          last.capture[subKv[1]] = isNaN(Number(v)) ? v : Number(v);
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
  return fields;
}

export class SettingsPanel extends HTMLElement {
  _editingConfig = null;

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
      if (!isEditing) {
        html += `<button class="config-action-btn" data-action="edit" data-name="${esc(cfg.name)}">${icon.edit(12)} Edit</button>`;
        html += `<button class="config-action-btn config-delete-btn" data-action="delete" data-name="${esc(cfg.name)}">${icon.trash(12)} Delete</button>`;
      }
      html += '</span></div>';
      if (isEditing) {
        html += `<textarea class="config-yaml-editor" data-config-name="${esc(cfg.name)}">${esc(configToYaml(cfg))}</textarea>`;
        html += '<div class="config-edit-actions"><button class="settings-btn settings-btn-save" data-action="save">Save</button><button class="settings-btn settings-btn-cancel" data-action="cancel">Cancel</button></div>';
      } else {
        html += `<pre class="config-yaml-display">${esc(configToYaml(cfg))}</pre>`;
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

    html += `<button class="settings-btn settings-btn-new" id="newConfigBtn">${icon.plus(12)} New Engine Config</button>`;
    html += '</div>';

    // ── Preferences ──
    html += '<div class="settings-section">';
    html += '<h3>Preferences</h3>';
    html += '<div class="pref-row">';
    html += '<label>Submit mode:</label>';
    html += `<label><input type="radio" name="submitMode" value="cmd-enter" ${submitMode === 'cmd-enter' ? 'checked' : ''} /> Cmd/Ctrl+Enter</label>`;
    html += `<label><input type="radio" name="submitMode" value="enter" ${submitMode === 'enter' ? 'checked' : ''} /> Enter</label>`;
    html += '</div>';
    html += '<div class="pref-row">';
    html += `<label><input type="checkbox" id="closeKbPref" ${closeKb ? 'checked' : ''} /> Close keyboard on send (iOS)</label>`;
    html += '</div>';
    html += '</div>';

    html += '</div>';
    this.innerHTML = html;
    this._bindEvents();
  }

  _bindEvents() {
    this.querySelector('#newConfigBtn')?.addEventListener('click', () => {
      this._editingConfig = '__new__';
      this.render();
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

    this.querySelectorAll('.config-edit-actions button').forEach((btn) => {
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
}

customElements.define('settings-panel', SettingsPanel);
