/**
 * Message I/O module.
 * Send messages, upload files, queue status updates.
 *
 * Exports:
 *   setup({ handleAuthError, getActiveTopic, renderThread, voiceState }) — wire deps
 *   sendMessage()                  — send message from input
 *   uploadFile(file, message)      — upload a single file
 *   handleFileUpload(files, msg)   — upload multiple files with UI
 *   updateSendability()            — enable/disable send based on agent state
 *   handleQueueUpdate(message)     — update delivery status badge
 */

import { state, authHeaders, getToken } from '/dashboard/assets/state.ts';
import { esc, renderMarkdown, formatFileSize, showToast, confirmAction } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

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
    badge.innerHTML = message.status === 'delivered' ? icon.check(12) + ' delivered' :
                      message.status === 'failed' ? icon.x(12) + ' failed' :
                      icon.dots(12) + ' sending';
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
  // Optimistic: clear input and show message immediately
  const agent = state.selected;
  inputEl.clear();
  const optimisticId = -Date.now(); // negative ID = not yet confirmed
  const optimisticMsg = {
    id: optimisticId, agent, direction: 'to_agent', sourceAgent: 'dashboard',
    targetAgent: agent, topic, message, queueId: null, deliveryStatus: 'pending',
    withdrawn: false, createdAt: new Date().toISOString(),
  };
  if (!state.threads[agent]) state.threads[agent] = [];
  state.threads[agent].push(optimisticMsg);
  if (state.selected === agent && state.threadView === 'messages') {
    const messagesEl = document.getElementById('threadMessages');
    if (messagesEl?.appendMessage) messagesEl.appendMessage(optimisticMsg, agent);
  }

  try {
    const res = await fetch('/api/dashboard/send', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent, message, topic }),
    });
    if (res.status === 401) { _handleAuthError(); return; }
    if (!res.ok) {
      // Remove optimistic message on failure
      const thread = state.threads[agent];
      if (thread) {
        const idx = thread.findIndex(m => m.id === optimisticId);
        if (idx >= 0) thread.splice(idx, 1);
      }
      inputEl.setDraft(text);
      showToast('Send failed', 'error');
      _renderThread();
    } else {
      // Replace optimistic message with real one from server
      const body = await res.json().catch(() => null);
      if (body?.msg) {
        const thread = state.threads[agent];
        if (thread) {
          const idx = thread.findIndex(m => m.id === optimisticId);
          if (idx >= 0) {
            thread[idx] = { ...body.msg, queueId: body.queueId ?? null, deliveryStatus: body.status ?? 'pending' };
          }
        }
      }
    }
  } catch (err) {
    // Remove optimistic message on network error
    const thread = state.threads[agent];
    if (thread) {
      const idx = thread.findIndex(m => m.id === optimisticId);
      if (idx >= 0) thread.splice(idx, 1);
    }
    inputEl.setDraft(text);
    showToast('Send failed — network error', 'error');
    _renderThread();
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
  uploadIndicator.innerHTML = `<div class="msg-header"><span class="msg-meta"><span class="msg-status pending">${icon.dots(12)} uploading</span></span></div>${indicatorMsg}<div class="file-info"><span class="file-icon">${icon.paperclip(14)}</span> ${esc(fileNames)}</div>`;
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
