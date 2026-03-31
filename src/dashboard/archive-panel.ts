/**
 * <archive-panel> Web Component.
 * Displays archived (deleted) messages with restore capability.
 *
 * Usage:
 *   const panel = document.querySelector('archive-panel');
 *   panel.setMarkdownRenderer(fn);
 *   panel.load(agentName);
 *
 * Events emitted:
 *   'archive-restored' — detail: { agent } — after successful restore
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';

export class ArchivePanel extends HTMLElement {
  _renderMarkdown = (s) => s;
  _agent = null;

  /** Inject the shared renderMarkdown function. */
  setMarkdownRenderer(fn) {
    this._renderMarkdown = fn;
  }

  /** Fetch and render archived messages. */
  async load(agentName) {
    this._agent = agentName;
    if (!agentName) return;
    this.innerHTML = '<div class="thread-empty">Loading archive...</div>';
    try {
      const res = await fetch(`/api/dashboard/threads?agent=${encodeURIComponent(agentName)}&archived=1`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        this.innerHTML = '<div class="thread-empty">Failed to load archive</div>';
        return;
      }
      const threads = await res.json();
      const thread = threads[agentName] || [];
      if (thread.length === 0) {
        this.innerHTML = '<div class="thread-empty">No archived messages</div>';
        return;
      }
      this.innerHTML = '';

      // Restore button
      const restoreBar = document.createElement('div');
      restoreBar.style.cssText = 'padding:8px 12px;text-align:center';
      const restoreBtn = document.createElement('button');
      restoreBtn.style.cssText = 'padding:6px 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;cursor:pointer';
      restoreBtn.textContent = 'Restore to Messages';
      restoreBtn.addEventListener('click', () => this._restore(agentName));
      restoreBar.appendChild(restoreBtn);
      this.appendChild(restoreBar);

      for (const msg of thread) {
        this.appendChild(this._buildMessageEl(msg, agentName));
      }
      this.scrollTop = this.scrollHeight;
    } catch (err) {
      console.error('Archive load failed:', err);
      this.innerHTML = '<div class="thread-empty">Failed to load archive</div>';
    }
  }

  async _restore(agentName) {
    try {
      const res = await fetch(`/api/dashboard/messages/${encodeURIComponent(agentName)}/unarchive`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (res.ok) {
        // Reload threads
        const threadsRes = await fetch(`/api/dashboard/threads?agent=${encodeURIComponent(agentName)}`, {
          headers: authHeaders(),
        });
        if (threadsRes.ok) {
          const threads = await threadsRes.json();
          state.threads[agentName] = threads[agentName] || [];
        }
        this.dispatchEvent(new CustomEvent('archive-restored', { detail: { agent: agentName } }));
      }
    } catch (err) {
      console.error('Unarchive failed:', err);
    }
  }

  _buildMessageEl(msg, agentName) {
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
    const fromLabel = isSystem ? 'system' : (msg.sourceAgent || (msg.direction === 'to_agent' ? 'dashboard' : agentName));
    const toLabel = msg.targetAgent || (msg.direction === 'to_agent' ? agentName : 'dashboard');
    const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const topicBadge = msg.topic ? `<span class="msg-topic">${esc(msg.topic)}</span>` : '';
    const routeStr = `${esc(fromLabel)} \u2192 ${esc(toLabel)}`;
    const displayMsg = isSystem ? msg.message.replace(/^\[system\]\s*/, '') : msg.message;
    const statusHtml = (msg.direction === 'to_agent' && msg.queueId)
      ? `<span class="msg-status ${msg.deliveryStatus || 'pending'}" data-queue-id="${msg.queueId}">${
          msg.deliveryStatus === 'delivered' ? '\u2713 delivered' :
          msg.deliveryStatus === 'failed' ? '\u2717 failed' :
          '\u2022\u2022\u2022 sending'
        }</span>`
      : '';
    const headerHtml = `<div class="msg-header"><span class="msg-sender">${routeStr}</span>${topicBadge}<span class="msg-meta"><span class="msg-time">${time}</span>${statusHtml}</span></div>`;
    if (isUpload) {
      div.innerHTML = `${headerHtml}<div class="file-info"><span class="file-icon">&#128206;</span> ${esc(displayMsg)}</div>`;
    } else {
      div.innerHTML = `${headerHtml}<div class="msg-body">${this._renderMarkdown(esc(displayMsg))}</div>`;
    }
    return div;
  }
}

customElements.define('archive-panel', ArchivePanel);
