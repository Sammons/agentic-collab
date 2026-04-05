/**
 * <message-list> Web Component.
 * Progressive message loading with append-only new messages.
 * Renders last PAGE_SIZE messages on load, prepends older on scroll-up.
 *
 * Usage:
 *   const list = document.querySelector('message-list');
 *   list.loadThread(messages, agentName, { renderMarkdown, esc });
 *   list.appendMessage(msg, agentName);
 *   list.clear();
 */

import { icon } from '/dashboard/assets/icons.ts';

const PAGE_SIZE = 30;

function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function buildMessageEl(msg, agentName, renderMarkdown) {
  const div = document.createElement('div');
  const isSystem = msg.message && msg.message.startsWith('[system]');
  const isUpload = msg.topic === 'file-upload' && msg.direction === 'to_agent';
  if (isSystem) {
    div.className = 'msg system-msg';
  } else if (isUpload) {
    div.className = 'msg to-agent file-upload';
  } else {
    div.className = `msg ${msg.direction === 'to_agent' ? 'to-agent' : 'from-agent'}`;
  }
  if (msg.withdrawn) div.classList.add('withdrawn');
  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const displayMsg = isSystem ? msg.message.replace(/^\[system\]\s*/, '') : msg.message;
  // From → To routing header
  const fromLabel = isSystem ? 'system' : (msg.sourceAgent || (msg.direction === 'to_agent' ? 'dashboard' : agentName));
  const toLabel = msg.targetAgent || (msg.direction === 'to_agent' ? agentName : 'dashboard');
  const topicBadge = msg.topic ? `<span class="msg-topic">${esc(msg.topic)}</span>` : '';
  const routeStr = `<span class="msg-sender">${esc(fromLabel)} ${icon.arrowRightSmall(12)} ${esc(toLabel)} ${topicBadge}</span>`;
  const statusHtml = (msg.direction === 'to_agent' && msg.queueId)
    ? `<span class="msg-status ${msg.deliveryStatus || 'pending'}" data-queue-id="${msg.queueId}">${
        msg.deliveryStatus === 'delivered' ? icon.check(12) :
        msg.deliveryStatus === 'failed' ? icon.x(12) + ' failed' :
        icon.dots(12)
      }</span>`
    : '';
  const canWithdraw = msg.direction === 'to_agent' && !isSystem && !msg.withdrawn && (!msg.sourceAgent || msg.sourceAgent === 'dashboard');
  const withdrawHtml = canWithdraw ? `<span class="msg-withdraw" data-msg-id="${msg.id}" title="Withdraw message">unsend</span>` : '';
  const copyBtnHtml = `<button class="msg-copy" title="Copy message">${icon.clipboard(14)}</button>`;
  const headerHtml = `<div class="msg-header">${routeStr}<span class="msg-meta"><span class="msg-time">${time}</span>${statusHtml}${copyBtnHtml}${withdrawHtml}</span></div>`;
  if (isUpload) {
    div.innerHTML = `${headerHtml}<div class="file-info"><span class="file-icon">${icon.paperclip(14)}</span> ${esc(displayMsg)}</div>`;
  } else {
    div.innerHTML = `${headerHtml}<div class="msg-body">${renderMarkdown(esc(displayMsg))}</div>`;
  }
  const copyEl = div.querySelector('.msg-copy');
  // Prevent focus steal on desktop (keeps textarea focused)
  copyEl?.addEventListener('mousedown', (e) => e.preventDefault());
  function copyToClipboard(text) {
    // navigator.clipboard requires secure context + user activation.
    // iOS Safari sometimes rejects it in touchend — fall back to execCommand.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
    }
    return execCommandCopy(text);
  }
  function execCommandCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  }
  function doCopy(btn) {
    copyToClipboard(displayMsg).then(() => {
      btn.innerHTML = icon.check(14);
      setTimeout(() => { btn.innerHTML = icon.clipboard(14); }, 1500);
    }).catch(() => {
      btn.innerHTML = icon.x(14);
      setTimeout(() => { btn.innerHTML = icon.clipboard(14); }, 1500);
    });
  }
  // Touch: handle in touchend to avoid preventDefault on touchstart killing click
  copyEl?.addEventListener('touchend', (e) => {
    e.preventDefault();
    doCopy(e.currentTarget);
  });
  copyEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    doCopy(e.currentTarget);
  });
  return div;
}

export class MessageList extends HTMLElement {
  /** @type {Function} */
  _renderMarkdown = (s) => s;
  _thread = [];
  _agentName = '';
  _renderedFrom = 0;

  /**
   * Inject the renderMarkdown function (defined in index.html, shared with other components).
   * Must be called before loadThread/appendMessage.
   */
  setMarkdownRenderer(fn) {
    this._renderMarkdown = fn;
  }

  /**
   * Load a thread — renders last PAGE_SIZE messages, sets up scroll-to-load.
   * @param {Array} thread — full message array
   * @param {string} agentName
   */
  loadThread(thread, agentName) {
    this._thread = thread;
    this._agentName = agentName;

    if (!thread.length) {
      this.innerHTML = '<div class="thread-empty">No messages yet</div>';
      this._renderedFrom = 0;
      this.onscroll = null;
      return;
    }

    this.innerHTML = '';
    const startIdx = Math.max(0, thread.length - PAGE_SIZE);
    this._renderedFrom = startIdx;

    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < thread.length; i++) {
      frag.appendChild(buildMessageEl(thread[i], agentName, this._renderMarkdown));
    }
    this.appendChild(frag);
    this.scrollTop = this.scrollHeight;

    // Progressive loading on scroll-up
    this.onscroll = () => {
      if (this.scrollTop > 80 || this._renderedFrom <= 0) return;
      const from = this._renderedFrom;
      const loadFrom = Math.max(0, from - PAGE_SIZE);
      const olderFrag = document.createDocumentFragment();
      for (let i = loadFrom; i < from; i++) {
        olderFrag.appendChild(buildMessageEl(this._thread[i], this._agentName, this._renderMarkdown));
      }
      const prevHeight = this.scrollHeight;
      this.prepend(olderFrag);
      this.scrollTop += this.scrollHeight - prevHeight;
      this._renderedFrom = loadFrom;
    };
  }

  /**
   * Append a single message — no re-render. Auto-scrolls to bottom.
   * @param {Object} msg
   * @param {string} agentName
   */
  appendMessage(msg, agentName) {
    const emptyMsg = this.querySelector('.thread-empty');
    if (emptyMsg) emptyMsg.remove();
    const el = buildMessageEl(msg, agentName, this._renderMarkdown);
    this.appendChild(el);
    this.scrollTop = this.scrollHeight;
  }

  /** Clear all messages. */
  clear() {
    this.innerHTML = '';
    this._thread = [];
    this._renderedFrom = 0;
    this.onscroll = null;
  }

  /** Get the rendered-from index (for testing). */
  get renderedFrom() { return this._renderedFrom; }
}

customElements.define('message-list', MessageList);
