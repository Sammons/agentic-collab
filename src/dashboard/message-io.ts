/**
 * Message I/O module.
 * Send messages, upload files, queue status updates, archive/unarchive.
 *
 * Exports:
 *   setup({ handleAuthError, getActiveTopic, renderThread, voiceState }) — wire deps
 *   sendMessage()                  — send message from input
 *   uploadFile(file, message)      — upload a single file
 *   handleFileUpload(files, msg)   — upload multiple files with UI
 *   updateSendability()            — enable/disable send based on agent state
 *   handleQueueUpdate(message)     — update delivery status badge
 *   archiveChat(agentName)         — archive messages
 *   unarchiveChat(agentName)       — restore archived messages
 *   renderArchive()                — render archived messages view
 */

import { state, authHeaders, getToken } from '/dashboard/assets/state.ts';
import { esc, renderMarkdown, formatFileSize, showToast, confirmAction } from '/dashboard/assets/utils.ts';

// ── Dependencies injected via setup() ──
let _handleAuthError = () => {};
let _getActiveTopic = () => 'general';
let _renderThread = () => {};
let _voiceState = { usedSinceSend: false };

const VOICE_TO_TEXT_PREFIX = 'sent via voice-to-text: ';
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB

export function setup({ handleAuthError, getActiveTopic, renderThread, voiceState }) {
  _handleAuthError = handleAuthError;
  _getActiveTopic = getActiveTopic;
  _renderThread = renderThread;
  _voiceState = voiceState;
}

// ── Send Enable/Disable ──

export function updateSendability() {
  if (!state.selected) return;
  const agent = state.agents.find(a => a.name === state.selected);
  const inputEl = document.getElementById('threadInput');
  if (inputEl && inputEl.updateAgent) inputEl.updateAgent(agent);
}

// ── Queue Updates ──

export function handleQueueUpdate(message) {
  const thread = state.threads[message.targetAgent];
  if (thread) {
    for (const msg of thread) {
      if (msg.queueId === message.id) {
        msg.deliveryStatus = message.status;
        break;
      }
    }
  }
  const badge = document.querySelector(`[data-queue-id="${message.id}"]`);
  if (badge) {
    badge.className = `msg-status ${message.status}`;
    badge.textContent = message.status === 'delivered' ? '\u2713 delivered' :
                        message.status === 'failed' ? '\u2717 failed' :
                        '\u2022\u2022\u2022 sending';
  }
}

// ── Archive / Restore ──

export async function archiveChat(agentName) {
  if (!agentName) return;
  try {
    const res = await fetch(`/api/dashboard/messages/${encodeURIComponent(agentName)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (res.status === 401) { _handleAuthError(); return; }
    if (res.ok) {
      state.threads[agentName] = [];
      _renderThread();
    }
  } catch (err) {
    console.error('Archive chat failed:', err);
  }
}

export async function unarchiveChat(agentName) {
  if (!agentName) return;
  try {
    const res = await fetch(`/api/dashboard/messages/${encodeURIComponent(agentName)}/unarchive`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (res.status === 401) { _handleAuthError(); return; }
    if (res.ok) {
      const threadsRes = await fetch(`/api/dashboard/threads?agent=${encodeURIComponent(agentName)}`, {
        headers: authHeaders(),
      });
      if (threadsRes.ok) {
        const threads = await threadsRes.json();
        state.threads[agentName] = threads[agentName] || [];
      }
      state.threadView = 'messages';
      _renderThread();
    }
  } catch (err) {
    console.error('Unarchive failed:', err);
  }
}

export async function renderArchive() {
  const messages = document.getElementById('threadMessages');
  if (!state.selected) return;
  messages.innerHTML = '<div class="thread-empty">Loading archive...</div>';
  try {
    const res = await fetch(`/api/dashboard/threads?agent=${encodeURIComponent(state.selected)}&archived=1`, {
      headers: authHeaders(),
    });
    if (!res.ok) { messages.innerHTML = '<div class="thread-empty">Failed to load archive</div>'; return; }
    const threads = await res.json();
    const thread = threads[state.selected] || [];
    if (thread.length === 0) {
      messages.innerHTML = '<div class="thread-empty">No archived messages</div>';
      return;
    }
    messages.innerHTML = '';
    const restoreBar = document.createElement('div');
    restoreBar.style.cssText = 'padding:8px 12px;text-align:center';
    restoreBar.innerHTML = `<button onclick="document.dispatchEvent(new CustomEvent('unarchive-chat'))" style="padding:6px 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;cursor:pointer">Restore to Messages</button>`;
    messages.appendChild(restoreBar);
    for (const msg of thread) {
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
      const fromLabel = isSystem ? 'system' : (msg.sourceAgent || (msg.direction === 'to_agent' ? 'dashboard' : state.selected));
      const toLabel = msg.targetAgent || (msg.direction === 'to_agent' ? state.selected : 'dashboard');
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
        div.innerHTML = `${headerHtml}<div class="msg-body">${renderMarkdown(esc(displayMsg))}</div>`;
      }
      messages.appendChild(div);
    }
    messages.scrollTop = messages.scrollHeight;
  } catch (err) {
    console.error('Archive load failed:', err);
    messages.innerHTML = '<div class="thread-empty">Failed to load archive</div>';
  }
}

// ── Send Message ──

function showSendError(input, sendBtn) {
  input.style.borderColor = 'var(--red)';
  const errEl = document.createElement('span');
  errEl.id = 'sendError';
  errEl.style.cssText = 'color:var(--red);font-size:11px;align-self:center;white-space:nowrap';
  errEl.textContent = 'Send failed';
  input.parentNode.insertBefore(errEl, sendBtn);
  setTimeout(() => { errEl.remove(); input.style.borderColor = ''; }, 3000);
}

export async function sendMessage() {
  if (!state.selected) return;
  const inputEl = document.getElementById('threadInput');
  const text = inputEl.getDraft().trim();
  const topic = _getActiveTopic();
  if (!text) return;

  const message = _voiceState.usedSinceSend ? VOICE_TO_TEXT_PREFIX + text : text;
  _voiceState.usedSinceSend = false;
  try {
    const res = await fetch('/api/dashboard/send', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent: state.selected, message, topic }),
    });
    if (res.status === 401) { _handleAuthError(); return; }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (body && body.msg) {
        inputEl.clear();
      } else {
        console.error('Send failed: HTTP', res.status);
        showToast('Send failed', 'error');
      }
    } else {
      inputEl.clear();
    }
  } catch (err) {
    console.error('Send failed:', err);
    showToast('Send failed — network error', 'error');
  } finally {
    updateSendability();
  }
}

// ── File Upload ──

export async function uploadFile(file, message) {
  let url = `/api/dashboard/upload?agent=${encodeURIComponent(state.selected)}&filename=${encodeURIComponent(file.name)}`;
  if (message) url += `&message=${encodeURIComponent(message)}`;
  const headers = { 'content-type': 'application/octet-stream' };
  const t = getToken();
  if (t) headers['authorization'] = `Bearer ${t}`;

  const res = await fetch(url, { method: 'POST', headers, body: file });
  if (res.status === 401) { _handleAuthError(); throw new Error('auth'); }
  const body = await res.json();
  return { file: file.name, ok: res.ok, ...body };
}

export async function handleFileUpload(files, attachedMessage) {
  if (!files.length || !state.selected) return;
  if (attachedMessage) {
    const inputEl = document.getElementById('threadInput');
    if (inputEl) inputEl.clear();
  }

  const largeFiles = files.filter(f => f.size >= LARGE_FILE_THRESHOLD);
  if (largeFiles.length > 0) {
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const confirmed = await confirmAction(
      `${largeFiles.length} file${largeFiles.length > 1 ? 's are' : ' is'} large (total ${formatFileSize(totalSize)}). Upload may take a while. Continue?`
    );
    if (!confirmed) return;
  }

  const uploadWrap = document.querySelector('#threadInput .upload-wrap');
  if (uploadWrap) uploadWrap.classList.add('uploading');

  const messagesEl = document.getElementById('threadMessages');
  const uploadIndicator = document.createElement('div');
  uploadIndicator.className = 'msg to-agent file-upload';
  const fileNames = files.map(f => `${f.name} (${formatFileSize(f.size)})`).join(', ');
  const indicatorMsg = attachedMessage ? esc(attachedMessage) + '<br>' : '';
  uploadIndicator.innerHTML = `<div class="msg-header"><span class="msg-sender">you</span><span class="msg-meta"><span class="msg-status pending">\u2022\u2022\u2022 uploading</span></span></div>${indicatorMsg}<div class="file-info"><span class="file-icon">&#128206;</span> ${esc(fileNames)}</div>`;
  messagesEl.appendChild(uploadIndicator);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const results = await Promise.allSettled(files.map((f, i) => uploadFile(f, i === 0 ? attachedMessage : '')));
    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const failed = results.length - succeeded;

    if (failed === 0) {
      showToast(`Uploaded ${succeeded} file${succeeded > 1 ? 's' : ''}`, 'success');
    } else {
      const firstError = results.find(r => r.status === 'fulfilled' && !r.value.ok)?.value?.error
        || results.find(r => r.status === 'rejected')?.reason?.message
        || 'unknown error';
      showToast(`${failed} upload${failed > 1 ? 's' : ''} failed: ${firstError}`, 'error');
    }
  } catch (err) {
    if (err.message !== 'auth') showToast('Upload failed', 'error');
  } finally {
    if (uploadWrap) uploadWrap.classList.remove('uploading');
    uploadIndicator.remove();
  }
}
