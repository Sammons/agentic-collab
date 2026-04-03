/**
 * Connection module.
 * WebSocket lifecycle, auth prompts, engine usage polling.
 *
 * Exports:
 *   setup({ renderAgents, renderThread, updatePageTitle, updateAgent,
 *           addMessage, handleMessageWithdrawn, handleQueueUpdate,
 *           patchAgentCard })                           -- wire deps
 *   handleAuthError()                                   -- clear token + prompt
 *   connect()                                           -- open/reconnect WS
 *   fetchEngineUsage()                                  -- poll /api/engines/status
 */

import { state, getToken, setToken } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';

// ── Dependencies injected via setup() ──
let _renderAgents = () => {};
let _renderThread = () => {};
let _updatePageTitle = () => {};
let _updateAgent = () => {};
let _addMessage = () => {};
let _handleMessageWithdrawn = () => {};
let _handleQueueUpdate = () => {};
let _patchAgentCard = () => {};

let _onInit = () => {};

export function setup({ renderAgents, renderThread, updatePageTitle, updateAgent,
                         addMessage, handleMessageWithdrawn, handleQueueUpdate,
                         patchAgentCard, onInit }) {
  _renderAgents = renderAgents;
  _renderThread = renderThread;
  _updatePageTitle = updatePageTitle;
  _updateAgent = updateAgent;
  _addMessage = addMessage;
  _handleMessageWithdrawn = handleMessageWithdrawn;
  _handleQueueUpdate = handleQueueUpdate;
  _patchAgentCard = patchAgentCard;
  if (onInit) _onInit = onInit;
}

// ── Module-scoped connection state ──
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let hasEverConnected = false;

// ── Auth ──

export function handleAuthError() {
  setToken('');
  promptForToken('Authentication failed. Please re-enter your token.');
}

function promptForToken(message) {
  // Remove existing overlay if present
  const existing = document.querySelector('.auth-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-box">
      <h2>Agentic Collab</h2>
      <p>${esc(message || 'Enter your orchestrator token to connect, or skip for dev mode (no auth).')}</p>
      <input type="password" id="authTokenInput" placeholder="Orchestrator token" autocomplete="off" />
      <div class="auth-actions">
        <button class="secondary" id="authSkipBtn">Dev Mode</button>
        <button class="primary" id="authConnectBtn">Connect</button>
      </div>
    </div>
  `;

  function submit(token) {
    setToken(token);
    overlay.remove();
    // Reconnect with new token
    if (ws) { ws.onclose = null; ws.close(); }
    connect();
  }

  overlay.querySelector('#authConnectBtn').onclick = () => {
    const val = document.getElementById('authTokenInput').value.trim();
    if (!val) { document.getElementById('authTokenInput').style.borderColor = 'var(--red)'; return; }
    submit(val);
  };
  overlay.querySelector('#authSkipBtn').onclick = () => submit('');
  overlay.querySelector('#authTokenInput').onkeydown = (e) => {
    if (e.key === 'Enter') overlay.querySelector('#authConnectBtn').click();
  };

  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('authTokenInput')?.focus(), 50);
}

// ── WebSocket ──

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  let opened = false;
  ws = new WebSocket(`${proto}://${location.host}/ws${tokenParam}`);

  ws.onopen = () => {
    opened = true;
    hasEverConnected = true;
    state.connected = true;
    reconnectDelay = 1000;
    updateConnStatus();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onclose = () => {
    state.connected = false;
    updateConnStatus();
    if (!opened) {
      if (!hasEverConnected) {
        // First connect attempt failed -- likely auth failure (401 on upgrade)
        setToken('');
        promptForToken('Connection rejected -- enter your orchestrator token.');
        return;
      }
      // Previously connected but reconnect failed -- network issue, keep retrying
    }
    const jitter = Math.random() * 1000;
    reconnectTimer = setTimeout(connect, reconnectDelay + jitter);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch (err) {
      console.warn('Malformed WebSocket frame:', err);
      return;
    }
    switch (data.type) {
      case 'init':
        state.agents = data.agents;
        state.threads = data.threads;
        state.proxies = data.proxies || [];
        state.accounts = data.accounts || [];
        state.engineConfigs = data.engineConfigs || [];
        state.indicators = data.indicators || {};
        state.pages = data.pages || [];
        state.stores = data.stores || [];
        // Restore unread counts from server, preserving any live increments
        if (data.unreadCounts) {
          for (const [agent, count] of Object.entries(data.unreadCounts)) {
            // Only set if not already tracked (preserves counts from messages received this session)
            if (state.unread[agent] === undefined) {
              state.unread[agent] = count;
            }
          }
        }
        _renderAgents();
        _renderThread();
        _updatePageTitle();
        _onInit();
        break;
      case 'agent_update':
        _updateAgent(data.agent);
        break;
      case 'message':
        _addMessage(data.msg);
        break;
      case 'queue_update':
        _handleQueueUpdate(data.message);
        break;
      case 'message_withdrawn':
        _handleMessageWithdrawn(data.msg);
        break;
      case 'proxy_update':
        if (data.proxies) {
          state.proxies = data.proxies;
          // Patch only agents that have a proxyId -- no full rebuild
          for (const agent of state.agents) {
            if (!agent.proxyId) continue;
            const card = document.querySelector(`[data-agent="${agent.name}"]`);
            if (card) _patchAgentCard(card, agent);
          }
        }
        break;
      case 'agent_destroyed':
        state.agents = state.agents.filter(a => a.name !== data.name);
        delete state.threads[data.name];
        delete state.unread[data.name];
        if (state.selected === data.name) {
          state.selected = null;
          _renderThread();
        }
        _renderAgents();
        break;
      case 'indicator_update':
        state.indicators[data.agentName] = data.indicators;
        { const card = document.querySelector(`[data-agent="${data.agentName}"]`);
          const agent = state.agents.find(a => a.name === data.agentName);
          if (card && agent) _patchAgentCard(card, agent);
          else _renderAgents(); }
        break;
      case 'engine_config_update': {
        const idx = state.engineConfigs.findIndex(c => c.name === data.config.name);
        if (idx >= 0) state.engineConfigs[idx] = data.config;
        else state.engineConfigs.push(data.config);
        break;
      }
      case 'engine_config_deleted':
        state.engineConfigs = state.engineConfigs.filter(c => c.name !== data.name);
        break;
      case 'pages_update':
        state.pages = data.pages || [];
        { const sp = document.getElementById('settingsPanel');
          if (sp && sp.style.display !== 'none' && sp.render) sp.render(); }
        break;
      case 'stores_update':
        state.stores = data.stores || [];
        break;
      case 'reminder_update':
        if (state.threadView === 'reminders') {
          const rp = document.getElementById('reminderPanel');
          if (rp && rp.load && state.selected) rp.load(state.selected);
        }
        break;
    }
  };
}

// ── Connection Status ──

function updateConnStatus() {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  dot.classList.toggle('connected', state.connected);
  label.textContent = state.connected ? 'Connected' : 'Disconnected';
}

// ── Engine Usage ──

export async function fetchEngineUsage() {
  try {
    const resp = await fetch('/api/engines/status', {
      headers: getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {},
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.usage) {
      state.engineUsage = data.usage;
      _renderAgents();
    }
  } catch { /* ignore */ }
}
