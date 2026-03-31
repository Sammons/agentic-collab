/**
 * Agent lifecycle module.
 * Create agent modal, agent actions (spawn/kill/exit/etc).
 *
 * Exports:
 *   setup({ handleAuthError, selectAgent }) — wire dependencies
 *   agentAction(name, act)                 — execute agent action with confirmation
 *   openCreateAgentModal()                 — show create agent dialog
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, showToast, confirmAction } from '/dashboard/assets/utils.ts';

// ── Dependencies injected via setup() ──
let _handleAuthError = () => {};
let _selectAgent = () => {};

export function setup({ handleAuthError, selectAgent }) {
  _handleAuthError = handleAuthError;
  _selectAgent = selectAgent;
}

// ── Constants ──

const DESTRUCTIVE_ACTIONS = new Set(['kill', 'destroy']);
const ACTION_LABELS = { kill: 'Kill', destroy: 'Destroy', exit: 'Exit', resume: 'Resume', interrupt: 'Interrupt', compact: 'Compact', spawn: 'Spawn' };

const ENGINE_TEMPLATES = {
  claude: `---
engine: claude
cwd: /home/user/project
group: general
start:
  - shell: claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT
  - wait: 5000
  - shell: /status
  - capture:
      lines: 30
      regex: uuid
      var: SESSION_ID
  - keystroke: Escape
resume:
  - shell: claude --resume $SESSION_ID --append-system-prompt $PERSONA_PROMPT
  - wait: 5000
  - shell: /status
  - capture:
      lines: 30
      regex: uuid
      var: SESSION_ID
  - keystroke: Escape
exit:
  - keystroke: Escape
  - shell: /exit
interrupt:
  - keystroke: Escape
  - keystroke: Escape
  - keystroke: Escape
compact:
  shell: /compact
indicators:
  approval:
    regex: '(Yes)\\s*/\\s*(No)\\s*/\\s*(Always allow)'
    badge: Needs Approval
    style: warning
    actions:
      $1:
        - keystroke: $1
      $2:
        - keystroke: $2
      $3:
        - keystroke: $3
  low-context:
    regex: 'Context left until'
    badge: Low Context
    style: danger
---
# Agent Name

You are a specialist agent. Describe your role and responsibilities here.
`,
  codex: `---
engine: codex
cwd: /home/user/project
group: general
start:
  - shell: codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME
resume:
  - shell: codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME resume $SESSION_ID
exit:
  - shell: /exit
  - wait: 3000
  - capture:
      lines: 50
      regex: 'codex resume ([0-9a-f-]+)'
      var: SESSION_ID
interrupt:
  - keystroke: Escape
  - keystroke: Escape
---
# Agent Name

You are a specialist agent. Describe your role and responsibilities here.
`,
  opencode: `---
engine: opencode
cwd: /home/user/project
group: general
start:
  - shell: opencode
resume:
  - shell: opencode -s $SESSION_ID
exit:
  - keystroke: C-c
  - wait: 2000
  - capture:
      lines: 50
      regex: '(ses_[a-zA-Z0-9]{20,})'
      var: SESSION_ID
interrupt:
  - keystroke: Escape
compact:
  - keystroke: C-x
  - keystroke: c
---
# Agent Name

You are a specialist agent. Describe your role and responsibilities here.
`,
};

// ── Agent Actions ──

export async function agentAction(name, act) {
  if (DESTRUCTIVE_ACTIONS.has(act)) {
    const confirmed = await confirmAction(`${ACTION_LABELS[act] || act} agent "${name}"? This cannot be undone.`);
    if (!confirmed) return;
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}/${act}`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (res.status === 401) { _handleAuthError(); return; }
    if (!res.ok) {
      let msg = `Action "${act}" failed (HTTP ${res.status})`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      showToast(msg, 'error');
    } else {
      showToast(`${ACTION_LABELS[act] || act}: ${name}`, 'success');
    }
  } catch (err) {
    console.error(`Action ${act} failed:`, err);
    showToast(`Action "${act}" failed — network error`, 'error');
  }
}

// ── Create Agent Modal ──

export function openCreateAgentModal() {
  const overlay = document.createElement('div');
  overlay.className = 'create-modal-overlay';
  const hasProxies = state.proxies && state.proxies.length > 0;
  const proxyOptions = (state.proxies || []).map(p =>
    `<option value="${esc(p.proxyId)}">${esc(p.proxyId)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="create-modal">
      <div class="create-modal-header">
        <select id="createEngineSelect" style="padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;outline:none">
          <option value="claude" selected>Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <select id="createProxySelect" style="padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;outline:none" ${hasProxies ? '' : 'disabled'}>
          ${hasProxies ? proxyOptions : '<option>No proxies</option>'}
        </select>
        <input type="text" id="createAgentName" placeholder="agent-name (kebab-case)" autocomplete="off" />
      </div>
      <div class="create-modal-body">
        <textarea id="createAgentContent">${esc(ENGINE_TEMPLATES.claude)}</textarea>
      </div>
      <div class="create-modal-actions">
        <button class="primary" id="createSpawnBtn" ${hasProxies ? '' : 'disabled title="No proxy registered"'}>Create &amp; Spawn</button>
        <button class="secondary" id="createOnlyBtn">Create Only</button>
        <button class="cancel" id="createCancelBtn">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#createAgentName');
  setTimeout(() => nameInput.focus(), 50);

  const modal = overlay.querySelector('.create-modal');
  modal.addEventListener('pointerdown', (e) => e.stopPropagation());
  modal.addEventListener('pointerup', (e) => e.stopPropagation());
  let pointerDownOnOverlay = false;
  overlay.addEventListener('pointerdown', (e) => { pointerDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('pointerup', (e) => {
    if (pointerDownOnOverlay && e.target === overlay) overlay.remove();
    pointerDownOnOverlay = false;
  });

  const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);

  overlay.querySelector('#createCancelBtn').onclick = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };

  overlay.querySelector('#createEngineSelect').onchange = (e) => {
    const textarea = overlay.querySelector('#createAgentContent');
    const template = ENGINE_TEMPLATES[e.target.value] || ENGINE_TEMPLATES.claude;
    textarea.value = template;
  };

  async function createAgent(spawn) {
    const name = nameInput.value.trim();
    const content = overlay.querySelector('#createAgentContent').value;
    if (!name) { showToast('Agent name is required', 'error'); return; }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name)) {
      showToast('Name: 1-63 chars, start alphanumeric, [a-zA-Z0-9_-]', 'error');
      return;
    }

    try {
      const createRes = await fetch('/api/personas', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, content }),
      });
      if (createRes.status === 401) { _handleAuthError(); return; }
      const createBody = await createRes.json();
      if (!createRes.ok) {
        showToast(createBody.error || 'Create failed', 'error');
        return;
      }

      const selectedProxy = overlay.querySelector('#createProxySelect')?.value || '';
      overlay.remove();

      if (spawn) {
        const spawnRes = await fetch(`/api/agents/${encodeURIComponent(name)}/spawn`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(selectedProxy ? { proxyId: selectedProxy } : {}),
        });
        if (spawnRes.ok) {
          showToast(`Agent "${name}" created and spawning`, 'success');
        } else {
          showToast('Agent created but spawn failed', 'warning');
        }
      } else {
        showToast(`Agent "${name}" created`, 'success');
      }
      _selectAgent(name);
    } catch (err) {
      showToast('Create failed — network error', 'error');
    }
  }

  overlay.querySelector('#createSpawnBtn').onclick = () => createAgent(true);
  overlay.querySelector('#createOnlyBtn').onclick = () => createAgent(false);
}
