/**
 * <message-input> Web Component.
 * Textarea with Send/Interrupt buttons, file upload trigger, draft management.
 * Emits events for parent to handle API calls.
 *
 * Events emitted:
 *   'msg-send'      — detail: { text, topic }
 *   'msg-interrupt'  — detail: { agent }
 *   'msg-upload'     — detail: { files, message }
 *
 * Methods:
 *   updateAgent(agent)  — update button states for agent
 *   setDraft(text)      — restore draft text
 *   getDraft()          — get current text for saving
 *   clear()             — clear input after send
 *   focus()             — focus the textarea
 */

import { state } from '/dashboard/assets/state.ts';

const CANT_RECEIVE = new Set(['void', 'failed', 'spawning']);

export class MessageInput extends HTMLElement {
  _agent = null;

  connectedCallback() {
    // Only set up once
    if (this._initialized) return;
    this._initialized = true;

    this.innerHTML = `
      <textarea id="msgInput" placeholder="Type a message..." rows="1" autocomplete="off" autocorrect="on" autocapitalize="sentences" spellcheck="false" name="msg-no-autofill"></textarea>
      <div class="upload-wrap" id="uploadWrap">
        <input type="file" id="fileInput" multiple disabled />
        <span class="upload-btn" id="uploadBtn"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
      </div>
      <div class="voice-controls" id="voiceControls" style="display:none">
        <div class="voice-toggle" id="voiceToggle">
          <button data-mode="off" class="active">Off</button>
          <button data-mode="ptt">PTT</button>
        </div>
        <button class="voice-btn inactive" id="voiceBtn" title="Hold to talk (or hold Spacebar)"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
      </div>
      <button id="interruptBtn" style="display:none">Interrupt</button>
      <button id="sendBtn" disabled>Send</button>
    `;

    const textarea = this.querySelector('#msgInput');
    const sendBtn = this.querySelector('#sendBtn');
    const interruptBtn = this.querySelector('#interruptBtn');
    const fileInput = this.querySelector('#fileInput');

    // Auto-resize textarea to fit content (capped at 5 lines)
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });

    // Submit mode from preferences: 'enter' or 'cmd-enter' (default)
    textarea.onkeydown = (e) => {
      const prefs = JSON.parse(localStorage.getItem('dashboardPrefs') || '{}');
      const mode = prefs.submitMode || 'cmd-enter';
      if (mode === 'enter') {
        // Enter sends, Shift+Enter inserts newline
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          this._emitSend();
        }
      } else {
        // Cmd/Ctrl+Enter sends, plain Enter inserts newline
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this._emitSend();
        }
      }
    };

    sendBtn.onclick = () => this._emitSend();
    // iOS: tap while keyboard is open blurs textarea first, absorbing the click.
    // touchend fires before the blur, so we handle send there too.
    sendBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      this._emitSend();
    });
    interruptBtn.onclick = () => {
      if (this._agent) {
        this.dispatchEvent(new CustomEvent('msg-interrupt', { detail: { agent: this._agent.name } }));
      }
    };

    fileInput.onchange = (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const message = textarea.value.trim();
      this.dispatchEvent(new CustomEvent('msg-upload', { detail: { files, message } }));
      fileInput.value = '';
    };
  }

  _emitSend() {
    const textarea = this.querySelector('#msgInput');
    const text = textarea.value.trim();
    if (!text || !this._agent) return;
    this.dispatchEvent(new CustomEvent('msg-send', { detail: { text } }));
    // Close keyboard on send if preference is enabled (iOS)
    const prefs = JSON.parse(localStorage.getItem('dashboardPrefs') || '{}');
    if (prefs.closeKeyboardOnSend) {
      textarea.blur();
    }
  }

  /** Update button/input states based on agent. */
  updateAgent(agent) {
    this._agent = agent;
    const textarea = this.querySelector('#msgInput');
    const sendBtn = this.querySelector('#sendBtn');
    const interruptBtn = this.querySelector('#interruptBtn');
    const fileInput = this.querySelector('#fileInput');
    const uploadBtn = this.querySelector('.upload-btn');
    if (!textarea) return;

    const blocked = agent && CANT_RECEIVE.has(agent.state);
    sendBtn.disabled = !!blocked;
    fileInput.disabled = !!blocked;
    if (uploadBtn) uploadBtn.classList.toggle('disabled', !!blocked);
    textarea.disabled = !!blocked;
    textarea.placeholder = blocked
      ? `Agent is ${agent ? agent.state : 'unavailable'} \u2014 cannot receive messages`
      : 'Type a message...';
    const canInterrupt = agent && (agent.state === 'active' || agent.state === 'idle');
    interruptBtn.style.display = canInterrupt ? '' : 'none';
  }

  setDraft(text) {
    const textarea = this.querySelector('#msgInput');
    if (textarea) {
      textarea.value = text || '';
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  }

  getDraft() {
    const textarea = this.querySelector('#msgInput');
    return textarea ? textarea.value : '';
  }

  clear() {
    const textarea = this.querySelector('#msgInput');
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
    delete state.drafts[state.selected];
  }

  focus() {
    const textarea = this.querySelector('#msgInput');
    if (textarea) textarea.focus();
  }
}

customElements.define('message-input', MessageInput);
