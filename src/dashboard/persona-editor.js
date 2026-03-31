/**
 * Persona editor module.
 * Persona view, edit, frontmatter display, and YAML serialisation.
 *
 * Exports:
 *   setup({ handleAuthError }) — wire deps
 *   renderPersona()            — render persona view for selected agent
 *   enterPersonaEdit()         — switch to edit mode for selected agent
 */

import { state, authHeaders, getToken } from '/dashboard/assets/state.js';
import { esc, renderMarkdown, showToast } from '/dashboard/assets/utils.js';

// ── Dependencies injected via setup() ──
let _handleAuthError = () => {};

export function setup({ handleAuthError }) {
  _handleAuthError = handleAuthError;
}

// ── Constants ──

const FM_CONFIG_LABELS = {
  engine: 'Engine', model: 'Model', thinking: 'Thinking',
  cwd: 'Working Dir', permissions: 'Permissions',
  group: 'Group',
};
const FM_HOOK_FIELDS = ['start', 'resume', 'exit', 'compact', 'interrupt', 'submit'];
const FM_ALL_KNOWN = new Set([...Object.keys(FM_CONFIG_LABELS), ...FM_HOOK_FIELDS]);

// ── Persona Fetch (30s cache via state.personaCache) ──

async function fetchPersona(name) {
  const cached = state.personaCache[name];
  if (cached && Date.now() - cached.fetched < 30000) return cached.data;
  try {
    const token = getToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`/api/personas/${encodeURIComponent(name)}`, { headers });
    if (res.status === 404) {
      state.personaCache[name] = { data: null, fetched: Date.now() };
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    state.personaCache[name] = { data, fetched: Date.now() };
    return data;
  } catch {
    return null;
  }
}

// ── Frontmatter Helpers ──

/** Format a frontmatter value for display. Handles structured hook objects. */
function fmtFmValue(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if ('preset' in val) {
      let s = 'preset: ' + val.preset;
      if (val.options) s += ' (' + Object.entries(val.options).map(([k,v]) => k + '=' + v).join(', ') + ')';
      return s;
    }
    if ('shell' in val) {
      let s = 'shell: ' + val.shell;
      if (val.env) s += ' [env: ' + Object.entries(val.env).map(([k,v]) => k + '=' + v).join(', ') + ']';
      return s;
    }
    if ('send' in val && Array.isArray(val.send)) {
      return 'send: ' + val.send.map(a => {
        const type = 'keystroke' in a ? 'keystroke' : 'text' in a ? 'text' : 'paste';
        const v = a[type];
        return type + ':' + v + (a.post_wait_ms ? ' (+' + a.post_wait_ms + 'ms)' : '');
      }).join(' → ');
    }
    if ('keystrokes' in val && Array.isArray(val.keystrokes)) {
      return 'keystrokes: ' + val.keystrokes.map(a => {
        const type = 'keystroke' in a ? 'keystroke' : 'text' in a ? 'text' : 'paste';
        return type + ':' + a[type];
      }).join(' → ');
    }
    // Pipeline steps array
    if (Array.isArray(val)) {
      return val.map(s => s.type === 'shell' ? s.command : s.type === 'keystrokes' ? 'keys' : s.type).join(' → ');
    }
    return JSON.stringify(val);
  }
  return String(val);
}

/** Render pipeline steps as YAML lines at a given indent. */
function renderPipelineSteps(lines, steps, indent) {
  const pad = ' '.repeat(indent);
  for (const step of steps) {
    if (step.type === 'shell') {
      lines.push(pad + '- shell: ' + step.command);
    } else if (step.type === 'keystroke') {
      lines.push(pad + '- keystroke: ' + step.key);
    } else if (step.type === 'keystrokes' && Array.isArray(step.actions)) {
      lines.push(pad + '- keystrokes:');
      for (const a of step.actions) {
        const type = 'keystroke' in a ? 'keystroke' : 'text' in a ? 'text' : 'paste';
        lines.push(pad + '  - ' + type + ': ' + a[type] + (a.post_wait_ms ? ' (+' + a.post_wait_ms + 'ms)' : ''));
      }
    } else if (step.type === 'capture') {
      lines.push(pad + '- capture:');
      lines.push(pad + '    lines: ' + step.lines);
      lines.push(pad + '    regex: ' + step.regex);
      lines.push(pad + '    var: ' + step.var);
    } else if (step.type === 'wait') {
      lines.push(pad + '- wait: ' + step.ms);
    }
  }
}

/** Render a frontmatter object as YAML text. Handles nested objects and arrays. */
function fmToYaml(fm) {
  const lines = [];
  for (const [key, val] of Object.entries(fm)) {
    if (val == null || val === '') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      lines.push(key + ': ' + val);
    } else if (Array.isArray(val)) {
      // Top-level array — pipeline steps (e.g. exit:, start: with pipeline format)
      lines.push(key + ':');
      renderPipelineSteps(lines, val, 2);
    } else if (typeof val === 'object') {
      lines.push(key + ':');
      for (const [sk, sv] of Object.entries(val)) {
        if (sv == null) continue;
        if (Array.isArray(sv)) {
          // Array inside object — could be custom_buttons entries or send actions
          lines.push('  ' + sk + ':');
          if (sv.length > 0 && sv[0] && typeof sv[0] === 'object' && 'type' in sv[0]) {
            // Pipeline steps (custom_buttons values)
            renderPipelineSteps(lines, sv, 4);
          } else {
            for (const item of sv) {
              if (typeof item === 'object') {
                const entries = Object.entries(item);
                if (entries.length > 0) {
                  lines.push('    - ' + entries[0][0] + ': ' + entries[0][1]);
                  for (let i = 1; i < entries.length; i++) {
                    lines.push('      ' + entries[i][0] + ': ' + entries[i][1]);
                  }
                }
              } else {
                lines.push('    - ' + item);
              }
            }
          }
        } else if (typeof sv === 'object' && !Array.isArray(sv)) {
          lines.push('  ' + sk + ':');
          for (const [ssk, ssv] of Object.entries(sv)) {
            lines.push('    ' + ssk + ': ' + ssv);
          }
        } else {
          lines.push('  ' + sk + ': ' + sv);
        }
      }
    }
  }
  return lines.join('\n');
}

// ── Render / Edit ──

export async function renderPersona() {
  const panel = document.getElementById('personaPanel');
  if (!state.selected) return;
  panel.innerHTML = '<div class="persona-empty">Loading\u2026</div>';
  const data = await fetchPersona(state.selected);
  if (state.threadView !== 'persona' || !state.selected) return;
  if (!data) {
    panel.innerHTML = '<div class="persona-empty">No persona defined for this agent.<br>Create <code>persistent-agents/' + esc(state.selected) + '.md</code> to add one.</div>';
    return;
  }
  let html = '<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="clear-chat-btn" id="editPersonaBtn">Edit</button></div>';
  if (data.hostname || data.filePath) {
    html += '<dl class="persona-meta">';
    if (data.hostname) html += '<dt>Host</dt><dd>' + esc(data.hostname) + '</dd>';
    if (data.filePath) html += '<dt>File</dt><dd>' + esc(data.filePath) + '</dd>';
    html += '</dl>';
  }
  const fm = data.frontmatter;
  if (fm && Object.keys(fm).length > 0) {
    html += '<details class="persona-fm-details"><summary>Frontmatter</summary><pre class="persona-yaml">' + esc(fmToYaml(fm)) + '</pre></details>';
  }
  if (data.body) {
    html += '<div class="persona-body">' + renderMarkdown(esc(data.body)) + '</div>';
  }
  panel.innerHTML = html || '<div class="persona-empty">Persona file is empty.</div>';
  const editBtn = document.getElementById('editPersonaBtn');
  if (editBtn) {
    editBtn.onclick = () => enterPersonaEdit(state.selected, data.content);
  }
}

export function enterPersonaEdit(agentName, rawContent) {
  state.editingPersona = true;
  const panel = document.getElementById('personaPanel');
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;padding:0">
      <div style="display:flex;gap:8px;padding:8px 0;align-items:center">
        <button class="clear-chat-btn" id="cancelEditBtn">Cancel</button>
        <button id="savePersonaBtn" style="padding:4px 12px;border:none;border-radius:4px;background:var(--green);color:#fff;font-size:12px;cursor:pointer">Save</button>
        <span id="personaSaveStatus" style="font-size:11px;color:var(--text-dim)"></span>
      </div>
      <textarea id="personaEditor" style="flex:1;width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:12px;font-family:monospace;font-size:12px;resize:none;outline:none;box-sizing:border-box">${esc(rawContent || '')}</textarea>
      <details class="persona-cheatsheet">
        <summary>Frontmatter &amp; env reference</summary>
        <div class="persona-cheatsheet-body">
          <div class="persona-cheatsheet-section">
            <strong>Frontmatter fields</strong> <span style="color:var(--text-dim)">(YAML between --- delimiters)</span>
            <dl>
              <dt>engine</dt><dd>claude | codex | opencode <em>(required)</em></dd>
              <dt>cwd</dt><dd>Working directory <em>(required)</em></dd>
              <dt>model</dt><dd>Model name (e.g. opus, sonnet, o3)</dd>
              <dt>thinking</dt><dd>low | medium | high</dd>
              <dt>permissions</dt><dd>skip (bypass permission prompts)</dd>
              <dt>group</dt><dd>Group label for sidebar organization</dd>
              <dt>start</dt><dd>Hook for spawning (flat string or nested preset/shell)</dd>
              <dt>resume</dt><dd>Hook for resuming (flat string or nested preset/shell)</dd>
              <dt>compact</dt><dd>Hook for compacting (flat string or nested preset/shell/send)</dd>
              <dt>exit</dt><dd>Hook for exiting/suspending (flat string or nested preset/shell/send)</dd>
              <dt>interrupt</dt><dd>Hook for interrupting (flat string or nested preset/shell/send)</dd>
              <dt>submit</dt><dd>Hook for message delivery (flat string or nested preset/shell/send)</dd>
            </dl>
          </div>
          <div class="persona-cheatsheet-section">
            <strong>Hook value modes</strong> <span style="color:var(--text-dim)">(flat strings — legacy, still supported)</span>
            <dl>
              <dt><em>bare string</em></dt><dd>Inline command pasted into tmux</dd>
              <dt>file:/path/to/script</dt><dd>Read file contents and paste (must be absolute path)</dd>
              <dt>preset:claude</dt><dd>Use the named engine's default behavior</dd>
              <dt><em>(omitted)</em></dt><dd>Uses agent's own engine preset</dd>
            </dl>
          </div>
          <div class="persona-cheatsheet-section">
            <strong>Structured hook modes</strong> <span style="color:var(--text-dim)">(nested YAML objects)</span>
            <dl>
              <dt>preset:</dt><dd>Engine default + optional options: (model, thinking, permissions)</dd>
              <dt>shell:</dt><dd>Paste command with auto-injected COLLAB_AGENT + custom env:</dd>
              <dt>send:</dt><dd>Ordered action sequence: keystroke:/text:/paste: with post_wait_ms</dd>
            </dl>
          </div>
          <div class="persona-cheatsheet-section">
            <strong>Environment variables</strong> <span style="color:var(--text-dim)">(available in agent sessions)</span>
            <dl>
              <dt>COLLAB_AGENT</dt><dd>Agent name (always set)</dd>
              <dt>COLLAB_PERSONA_FILE</dt><dd>Host path to this .md file (set when custom hooks are active)</dd>
            </dl>
          </div>
        </div>
      </details>
    </div>
  `;
  document.getElementById('cancelEditBtn').onclick = () => {
    state.editingPersona = false;
    delete state.personaCache[agentName];
    renderPersona();
  };
  document.getElementById('savePersonaBtn').onclick = async () => {
    const content = document.getElementById('personaEditor').value;
    const statusEl = document.getElementById('personaSaveStatus');
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(agentName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ content }),
      });
      if (res.status === 401) { _handleAuthError(); return; }
      if (res.ok) {
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = '\u2713 Saved \u2014 changes take effect when the agent restarts';
        delete state.personaCache[agentName];
      } else {
        const err = await res.json().catch(() => ({}));
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = '\u2717 ' + (err.error || 'Save failed');
      }
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '\u2717 Save failed';
    }
  };
}
