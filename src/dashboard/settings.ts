/**
 * <settings-panel> Web Component.
 * Engine config CRUD and client-side dashboard preferences.
 *
 * Engine configs are persisted server-side via /api/engine-configs.
 * Preferences are stored in localStorage under 'dashboardPrefs'.
 *
 * Usage:
 *   const panel = document.querySelector('settings-panel');
 *   panel.render();  // rebuild content
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

export class SettingsPanel extends HTMLElement {
  _editingConfig = null; // name of config being edited, or '__new__' for create

  render() {
    const configs = state.engineConfigs || [];
    const prefs = getPrefs();
    const submitMode = prefs.submitMode || 'cmd-enter';
    const closeKb = !!prefs.closeKeyboardOnSend;

    let html = '<div class="settings-panel">';

    // ── Section 1: Engine Configs ──
    html += '<div class="settings-section">';
    html += '<h3>Engine Configs</h3>';

    for (const cfg of configs) {
      const isEditing = this._editingConfig === cfg.name;
      html += `<div class="config-card" data-config="${esc(cfg.name)}">`;
      if (isEditing) {
        html += this._renderEditForm(cfg);
      } else {
        html += this._renderConfigDisplay(cfg);
      }
      html += '</div>';
    }

    // New config form
    if (this._editingConfig === '__new__') {
      html += '<div class="config-card" data-config="__new__">';
      html += this._renderEditForm({ name: '', engine: '', model: '', thinking: '', permissions: '' });
      html += '</div>';
    }

    html += `<button class="settings-btn settings-btn-new" id="newConfigBtn">${icon.plus(12)} New Engine Config</button>`;
    html += '</div>';

    // ── Section 2: Preferences ──
    html += '<div class="settings-section">';
    html += '<h3>Preferences</h3>';

    html += '<div class="pref-row">';
    html += '<label>Submit mode:</label>';
    html += `<label><input type="radio" name="submitMode" value="cmd-enter" ${submitMode === 'cmd-enter' ? 'checked' : ''} /> Cmd/Ctrl+Enter to send</label>`;
    html += `<label><input type="radio" name="submitMode" value="enter" ${submitMode === 'enter' ? 'checked' : ''} /> Enter to send</label>`;
    html += '</div>';

    html += '<div class="pref-row">';
    html += `<label><input type="checkbox" id="closeKbPref" ${closeKb ? 'checked' : ''} /> Close keyboard on send (iOS)</label>`;
    html += '</div>';

    html += '</div>'; // settings-section
    html += '</div>'; // settings-panel

    this.innerHTML = html;
    this._bindEvents();
  }

  _renderConfigDisplay(cfg) {
    let html = '<div class="config-header">';
    html += `<span class="config-name">${esc(cfg.name)}</span>`;
    html += '<span class="config-actions">';
    html += `<button class="config-action-btn config-edit-btn" data-action="edit" data-name="${esc(cfg.name)}" title="Edit">${icon.edit(12)} Edit</button>`;
    html += `<button class="config-action-btn config-delete-btn" data-action="delete" data-name="${esc(cfg.name)}" title="Delete">${icon.trash(12)} Delete</button>`;
    html += '</span>';
    html += '</div>';
    html += '<div class="config-fields">';
    html += this._fieldRow('Engine', cfg.engine);
    if (cfg.model) html += this._fieldRow('Model', cfg.model);
    if (cfg.thinking) html += this._fieldRow('Thinking', cfg.thinking);
    if (cfg.permissions) html += this._fieldRow('Permissions', cfg.permissions);
    html += '</div>';
    return html;
  }

  _fieldRow(label, value) {
    return `<div class="config-field"><label>${esc(label)}</label><span>${esc(value || '')}</span></div>`;
  }

  _renderEditForm(cfg) {
    const isNew = !cfg.name || this._editingConfig === '__new__';
    let html = '<div class="config-edit-form">';
    html += `<div class="config-field"><label>Name</label><input type="text" data-field="name" value="${esc(cfg.name || '')}" ${!isNew ? 'disabled' : ''} /></div>`;
    html += `<div class="config-field"><label>Engine</label><input type="text" data-field="engine" value="${esc(cfg.engine || '')}" placeholder="claude, codex, opencode..." /></div>`;
    html += `<div class="config-field"><label>Model</label><input type="text" data-field="model" value="${esc(cfg.model || '')}" placeholder="optional" /></div>`;
    html += `<div class="config-field"><label>Thinking</label><input type="text" data-field="thinking" value="${esc(cfg.thinking || '')}" placeholder="low, medium, high" /></div>`;
    html += `<div class="config-field"><label>Permissions</label><input type="text" data-field="permissions" value="${esc(cfg.permissions || '')}" placeholder="skip or empty" /></div>`;
    html += '<div class="config-edit-actions">';
    html += `<button class="settings-btn settings-btn-save" data-action="save">${isNew ? 'Create' : 'Save'}</button>`;
    html += '<button class="settings-btn settings-btn-cancel" data-action="cancel">Cancel</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  _bindEvents() {
    // New config button
    const newBtn = this.querySelector('#newConfigBtn');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        this._editingConfig = '__new__';
        this.render();
      });
    }

    // Edit / Delete buttons
    this.querySelectorAll('.config-action-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const action = btn.dataset.action;
        const name = btn.dataset.name;
        if (action === 'edit') {
          this._editingConfig = name;
          this.render();
        } else if (action === 'delete') {
          const confirmed = await confirmAction(`Delete engine config "${name}"? This cannot be undone.`);
          if (!confirmed) return;
          await this._deleteConfig(name);
        }
      });
    });

    // Save / Cancel in edit forms
    this.querySelectorAll('.config-edit-actions button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'cancel') {
          this._editingConfig = null;
          this.render();
          return;
        }
        if (action === 'save') {
          const card = btn.closest('.config-card');
          const configName = card.dataset.config;
          const fields = {};
          card.querySelectorAll('input[data-field]').forEach((input) => {
            const val = input.value.trim();
            fields[input.dataset.field] = val || null;
          });
          if (!fields.name || !fields.engine) {
            showToast('Name and engine are required', 'error');
            return;
          }
          if (configName === '__new__') {
            await this._createConfig(fields);
          } else {
            await this._updateConfig(configName, fields);
          }
        }
      });
    });

    // Preference: submit mode
    this.querySelectorAll('input[name="submitMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const prefs = getPrefs();
        prefs.submitMode = radio.value;
        savePrefs(prefs);
      });
    });

    // Preference: close keyboard
    const closeKbEl = this.querySelector('#closeKbPref');
    if (closeKbEl) {
      closeKbEl.addEventListener('change', () => {
        const prefs = getPrefs();
        prefs.closeKeyboardOnSend = closeKbEl.checked;
        savePrefs(prefs);
      });
    }
  }

  async _createConfig(fields) {
    try {
      const res = await fetch('/api/engine-configs', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error || `Create failed (${res.status})`, 'error');
        return;
      }
      const config = await res.json();
      // Update local state
      const idx = state.engineConfigs.findIndex((c) => c.name === config.name);
      if (idx >= 0) state.engineConfigs[idx] = config;
      else state.engineConfigs.push(config);
      this._editingConfig = null;
      showToast('Engine config created', 'success');
      this.render();
    } catch (err) {
      showToast('Network error creating config', 'error');
    }
  }

  async _updateConfig(name, fields) {
    try {
      const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error || `Update failed (${res.status})`, 'error');
        return;
      }
      const config = await res.json();
      const idx = state.engineConfigs.findIndex((c) => c.name === name);
      if (idx >= 0) state.engineConfigs[idx] = config;
      this._editingConfig = null;
      showToast('Engine config updated', 'success');
      this.render();
    } catch (err) {
      showToast('Network error updating config', 'error');
    }
  }

  async _deleteConfig(name) {
    try {
      const res = await fetch(`/api/engine-configs/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast(body?.error || `Delete failed (${res.status})`, 'error');
        return;
      }
      state.engineConfigs = state.engineConfigs.filter((c) => c.name !== name);
      showToast('Engine config deleted', 'success');
      this.render();
    } catch (err) {
      showToast('Network error deleting config', 'error');
    }
  }
}

customElements.define('settings-panel', SettingsPanel);
