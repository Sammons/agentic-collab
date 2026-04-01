/**
 * <watch-panel> Web Component.
 * Real-time tmux pane monitoring with interactive key/text controls.
 *
 * Usage:
 *   const panel = document.querySelector('watch-panel');
 *   panel.start(agentName);   // begin polling
 *   panel.stop();             // stop polling
 *
 * Requires: state.js for auth, esc() for display.
 */

import { state, getToken, authHeaders } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

const KEY_BUTTONS = [
  { label: icon.arrowUp(12), key: 'Up' },
  { label: icon.arrowDown(12), key: 'Down' },
  { label: icon.arrowLeft(12), key: 'Left' },
  { label: icon.arrowRight(12), key: 'Right' },
  { label: icon.backspace(12), key: 'BSpace' },
  { label: 'Enter', key: 'Enter' },
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: 'S-Tab', key: 'S-Tab' },
  { label: 'Space', key: 'Space' },
  { label: 'C-c', key: 'C-c' },
  { label: 'C-x', key: 'C-x' },
  { label: 'C-z', key: 'C-z' },
  { label: 'y', key: 'y' },
  { label: 'n', key: 'n' },
  { label: 'q', key: 'q' },
];

async function fetchPaneOutput(agentName) {
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(agentName)}/peek`, {
      headers: getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {},
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.output ?? null;
  } catch { return null; }
}

export class WatchPanel extends HTMLElement {
  _timer = null;
  _agent = null;

  /** Start polling for the given agent. */
  start(agentName) {
    this.stop();
    this._agent = agentName;
    if (!agentName) return;

    const keysHtml = KEY_BUTTONS.map(b =>
      `<button data-key="${b.key}" title="Send ${b.key}">${b.label}</button>`
    ).join('');

    this.innerHTML = `
      <div class="watch-output"><div class="watch-status">Connecting...</div></div>
      <div class="watch-keys">${keysHtml}<button class="watch-resize-btn" title="Resize tmux pane to match viewport">${icon.maximize(12)} Resize</button></div>
      <div class="watch-type">
        <input type="text" class="watch-type-input" placeholder="Type literal text..." />
        <button class="watch-type-send" title="Send text (no Enter)">Send</button>
        <button class="watch-type-enter" title="Send text + Enter">Send+${icon.cornerDownLeft(12)}</button>
      </div>
    `;

    const outputEl = this.querySelector('.watch-output');

    // Key button handlers
    this.querySelector('.watch-keys').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-key]');
      if (!btn || !this._agent) return;
      try {
        await fetch(`/api/agents/${encodeURIComponent(this._agent)}/keys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ keys: btn.dataset.key }),
        });
      } catch (err) {
        console.error('[watch] Key send failed:', err);
      }
    });

    // Resize button
    this.querySelector('.watch-resize-btn').addEventListener('click', async () => {
      if (!this._agent) return;
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      probe.textContent = 'M';
      outputEl.appendChild(probe);
      const probeRect = probe.getBoundingClientRect();
      const charW = probeRect.width || 7.2;
      const charH = probeRect.height || 16;
      outputEl.removeChild(probe);
      const style = getComputedStyle(outputEl);
      const lineH = parseFloat(style.lineHeight) || charH;
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const statusEl = outputEl.querySelector('.watch-status');
      const statusH = statusEl ? statusEl.offsetHeight + parseFloat(getComputedStyle(statusEl).marginBottom || '0') : 0;
      const cols = Math.floor((outputEl.clientWidth - padX) / charW);
      const rows = Math.floor((outputEl.clientHeight - padY - statusH) / lineH);
      if (cols < 1 || rows < 1) return;
      try {
        await fetch(`/api/agents/${encodeURIComponent(this._agent)}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ width: cols, height: rows }),
        });
      } catch (err) {
        console.error('[watch] Resize failed:', err);
      }
    });

    // Text input
    const typeInput = this.querySelector('.watch-type-input');
    const sendLiteral = async (pressEnter) => {
      const text = typeInput.value;
      if (!text || !this._agent) return;
      try {
        await fetch(`/api/agents/${encodeURIComponent(this._agent)}/type`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ text, pressEnter }),
        });
        typeInput.value = '';
      } catch (err) {
        console.error('[watch] Type send failed:', err);
      }
    };

    this.querySelector('.watch-type-send').addEventListener('click', () => sendLiteral(false));
    this.querySelector('.watch-type-enter').addEventListener('click', () => sendLiteral(true));
    typeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendLiteral(e.shiftKey ? false : true);
      }
    });

    // Polling
    const poll = async () => {
      if (!this._agent) return;
      const output = await fetchPaneOutput(this._agent);
      if (!this._agent) return;
      if (output === null) {
        outputEl.innerHTML = '<div class="watch-status">Agent has no active session</div>';
      } else {
        const now = new Date().toLocaleTimeString();
        const wasAtBottom = outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 20;
        outputEl.innerHTML = `<div class="watch-status">Last capture: ${now}</div>${esc(output)}`;
        if (wasAtBottom) outputEl.scrollTop = outputEl.scrollHeight;
      }
    };

    poll().then(() => { outputEl.scrollTop = outputEl.scrollHeight; });
    this._timer = setInterval(poll, 3000);
  }

  /** Stop polling and clear content. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._agent = null;
  }
}

customElements.define('watch-panel', WatchPanel);
