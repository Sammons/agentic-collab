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
        <span class="upload-btn" id="uploadBtn">+</span>
      </div>
      <button id="interruptBtn" style="display:none">Interrupt</button>
      <button id="sendBtn" disabled>Send</button>
    `;

    const textarea = this.querySelector('#msgInput');
    const sendBtn = this.querySelector('#sendBtn');
    const interruptBtn = this.querySelector('#interruptBtn');
    const fileInput = this.querySelector('#fileInput');

    // Enter to send (Shift+Enter for newline)
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
        e.preventDefault();
        this._emitSend();
      }
    };

    sendBtn.onclick = () => this._emitSend();
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
    if (textarea) textarea.value = text || '';
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
