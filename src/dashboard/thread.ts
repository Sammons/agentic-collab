/**
 * Thread module.
 * Thread rendering, tab switching, topic breadcrumbs, page title updates.
 *
 * Exports:
 *   setup({ handleAuthError, updateSendability }) -- wire deps
 *   renderThread()          -- main thread renderer (tabs, panel switching)
 *   getActiveTopic()        -- current topic for selected agent
 *   setActiveTopic(topic)   -- set topic for selected agent
 *   updatePageTitle()       -- update document.title with unread count
 *   mobileBack()            -- hide thread panel on mobile
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, renderMarkdown } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';
import { renderPersona, setup as setupPersonaEditor } from '/dashboard/assets/persona-editor.ts';
import { buildActionsHtml } from '/dashboard/assets/agent-card.ts';
import { agentAction } from '/dashboard/assets/agent-lifecycle.ts';
import { pushUrlState } from '/dashboard/assets/url-state.ts';

// ── Dependencies injected via setup() ──
let _handleAuthError = () => {};
let _updateSendability = () => {};

export function setup({ handleAuthError, updateSendability }) {
  _handleAuthError = handleAuthError;
  _updateSendability = updateSendability;
  setupPersonaEditor({ handleAuthError });
}

// ── Topic State ──

export function getActiveTopic() {
  if (!state.selected) return 'general';
  return state.topicPerAgent[state.selected] || 'general';
}

export function setActiveTopic(topic) {
  if (state.selected) state.topicPerAgent[state.selected] = topic;
}

// ── Topic Breadcrumbs ──

function renderTopicBreadcrumbs() {
  const container = document.getElementById('topicBreadcrumbs');
  if (!state.selected) { container.innerHTML = ''; return; }
  const thread = state.threads[state.selected] || [];
  // Always start with "general", then unique topics from thread (most recent first), capped at 15
  const seen = new Set(['general']);
  const topics = ['general'];
  for (let i = thread.length - 1; i >= 0 && topics.length < 15; i--) {
    const t = thread[i].topic;
    if (t && !seen.has(t)) { seen.add(t); topics.push(t); }
  }
  const current = getActiveTopic();
  container.innerHTML = topics.map(t =>
    `<span class="topic-chip${t === current ? ' active' : ''}" data-topic="${esc(t)}">${esc(t)}</span>`
  ).join('');
}

// Breadcrumb event listeners — attached once when module loads
document.getElementById('topicBreadcrumbs').addEventListener('mousedown', (e) => {
  e.preventDefault();
});
document.getElementById('topicBreadcrumbs').addEventListener('click', (e) => {
  const chip = e.target.closest('.topic-chip');
  if (!chip) return;
  setActiveTopic(chip.dataset.topic);
  renderTopicBreadcrumbs();
  document.getElementById('threadInput')?.focus();
});

// ── Page Title ──

export function updatePageTitle() {
  // Show unread count for the selected agent only (not global total across all agents)
  const unread = state.selected ? (state.unread[state.selected] || 0) : 0;
  const prefix = unread > 0 ? `(${unread}) ` : '';
  if (state.selected) {
    const agent = state.agents.find(a => a.name === state.selected);
    const iconPrefix = agent?.icon ? `${agent.icon} ` : '';
    document.title = `${prefix}${iconPrefix}${state.selected} — Agentic Collab`;
  } else {
    document.title = `${prefix}Dashboard — Agentic Collab`;
  }
}

// ── Mobile ──

export function mobileBack() {
  document.querySelector('.layout').classList.remove('mobile-thread');
}

// ── Search State ──
let _searchOpen = false;
let _searchQuery = '';
let _searchResults = [];
let _searchDebounce = null;

function highlightMatch(text, query) {
  if (!query) return esc(text);
  const escaped = esc(text);
  const escapedQuery = esc(query);
  const re = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<mark class="search-highlight">$1</mark>');
}

function snippetAround(text, query, radius = 80) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

function renderSearchResults(container) {
  if (_searchResults.length === 0 && _searchQuery.length > 0) {
    container.innerHTML = '<div class="search-empty">No messages found</div>';
    return;
  }
  if (_searchResults.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = _searchResults.map(r => {
    const snippet = snippetAround(r.message, _searchQuery);
    const time = new Date(r.createdAt).toLocaleString();
    return `<div class="search-result" data-msg-id="${r.id}">
      <div class="search-result-meta"><span class="search-result-agent">${esc(r.agent)}</span><span class="search-result-time">${esc(time)}</span></div>
      <div class="search-result-snippet">${highlightMatch(snippet, _searchQuery)}</div>
      <div class="search-result-full" style="display:none"><pre class="search-result-text">${esc(r.message)}</pre><button class="search-copy-btn">Copy</button></div>
    </div>`;
  }).join('');

  // Click to expand, copy button
  container.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.search-copy-btn')) return;
      const full = el.querySelector('.search-result-full');
      const isOpen = full.style.display !== 'none';
      // Close all others
      container.querySelectorAll('.search-result-full').forEach(f => f.style.display = 'none');
      if (!isOpen) full.style.display = 'block';
    });
    el.querySelector('.search-copy-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = el.querySelector('.search-result-text').textContent;
      const btn = e.target;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
  });
}

function doLocalSearch(query) {
  const thread = state.threads[state.selected] || [];
  const lower = query.toLowerCase();
  _searchResults = thread
    .filter(m => m.message.toLowerCase().includes(lower))
    .slice(-200)
    .reverse()
    .map(m => ({ id: m.id, agent: m.agent, message: m.message, createdAt: m.createdAt }));
}

async function doGlobalSearch(query) {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`/api/dashboard/messages/search?${params}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return;
  const data = await res.json();
  _searchResults = data.map(m => ({ id: m.id, agent: m.agent, message: m.message, createdAt: m.createdAt }));
}

// ── Thread Renderer ──

export function renderThread() {
  // Don't re-render if user is editing a persona — would destroy their work
  if (state.editingPersona && state.threadView === 'persona') return;

  const header = document.getElementById('threadHeader');
  const messages = document.getElementById('threadMessages');
  const personaPanel = document.getElementById('personaPanel');
  const reminderPanel = document.getElementById('reminderPanel');
  const watchPanel = document.getElementById('watchPanel');
  const input = document.getElementById('threadInput');

  // Stop watch polling when leaving the tab
  const watchEl = document.getElementById('watchPanel');
  watchEl.stop();

  if (!state.selected) {
    header.textContent = 'Select an agent';
    messages.innerHTML = '<div class="thread-empty">Select an agent to view messages</div>';
    personaPanel.style.display = 'none';
    reminderPanel.style.display = 'none';
    watchPanel.style.display = 'none';
    input.style.display = 'none';
    document.getElementById('topicBreadcrumbs').style.display = 'none';
    return;
  }

  const selectedAgent = state.agents.find(a => a.name === state.selected);
  const headerBadge = selectedAgent ? `<span class="state-badge state-${selectedAgent.state}">${selectedAgent.state}</span>` : '';
  const indicators = (state.indicators[state.selected] || []).map(ind => {
    const cls = ind.style || 'info';
    return `<span class="indicator-badge ${cls}">${esc(ind.badge)}</span>`;
  }).join('');
  const tabs = `<div class="thread-tabs">
    <button class="${state.threadView === 'messages' ? 'active' : ''}" data-tab="messages">Messages</button>
    <button class="${state.threadView === 'watch' ? 'active' : ''}" data-tab="watch">Watch</button>
    <button class="${state.threadView === 'reminders' ? 'active' : ''}" data-tab="reminders">Reminders</button>
    <button class="${state.threadView === 'files' ? 'active' : ''}" data-tab="files">Files</button>
    <button class="${state.threadView === 'persona' ? 'active' : ''}" data-tab="persona">Persona</button>
  </div>`;
  const actionsHtml = selectedAgent ? `<div class="thread-actions">${buildActionsHtml(selectedAgent)}</div>` : '';
  const searchBtn = `<button class="thread-search-btn${_searchOpen ? ' active' : ''}" id="threadSearchBtn" title="Search messages">${icon.search(16)}</button>`;
  const searchPanel = `<div class="thread-search-panel" id="threadSearchPanel" style="display:${_searchOpen ? 'flex' : 'none'}">
    <div class="thread-search-row">
      <input type="text" class="thread-search-input" id="threadSearchInput" placeholder="Search messages..." value="${esc(_searchQuery)}" />
      <button class="thread-search-all-btn" id="threadSearchAllBtn" title="Search all agents">Search all</button>
    </div>
    <div class="thread-search-results" id="threadSearchResults"></div>
  </div>`;
  header.innerHTML = `<div class="thread-header-top"><button class="mobile-back" id="mobileBackBtn">${icon.arrowLeft(16)}</button><span>${esc(state.selected)}</span>${headerBadge}${indicators}${searchBtn}</div>${tabs}${actionsHtml}${searchPanel}`;
  document.getElementById('mobileBackBtn').onclick = mobileBack;

  // ── Search wiring ──
  const searchBtnEl = document.getElementById('threadSearchBtn');
  const searchPanelEl = document.getElementById('threadSearchPanel');
  const searchInputEl = document.getElementById('threadSearchInput');
  const searchResultsEl = document.getElementById('threadSearchResults');
  const searchAllBtnEl = document.getElementById('threadSearchAllBtn');

  searchBtnEl.addEventListener('click', () => {
    _searchOpen = !_searchOpen;
    searchPanelEl.style.display = _searchOpen ? 'flex' : 'none';
    searchBtnEl.classList.toggle('active', _searchOpen);
    if (_searchOpen) searchInputEl.focus();
    if (!_searchOpen) { _searchQuery = ''; _searchResults = []; searchResultsEl.innerHTML = ''; }
  });

  searchInputEl.addEventListener('input', () => {
    _searchQuery = searchInputEl.value;
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      if (_searchQuery.length >= 2) {
        doLocalSearch(_searchQuery);
        renderSearchResults(searchResultsEl);
      } else {
        _searchResults = [];
        searchResultsEl.innerHTML = '';
      }
    }, 200);
  });

  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      _searchOpen = false;
      _searchQuery = '';
      _searchResults = [];
      searchPanelEl.style.display = 'none';
      searchBtnEl.classList.remove('active');
      searchResultsEl.innerHTML = '';
    }
  });

  searchAllBtnEl.addEventListener('click', async () => {
    if (_searchQuery.length < 2) return;
    searchAllBtnEl.textContent = 'Searching...';
    searchAllBtnEl.classList.add('loading');
    await doGlobalSearch(_searchQuery);
    renderSearchResults(searchResultsEl);
    searchAllBtnEl.textContent = 'Search all';
    searchAllBtnEl.classList.remove('loading');
  });

  // Re-render search results if panel is open
  if (_searchOpen && _searchQuery.length >= 2) {
    doLocalSearch(_searchQuery);
    renderSearchResults(searchResultsEl);
  }

  header.querySelectorAll('.thread-tabs button').forEach(btn => {
    btn.onclick = () => { state.editingPersona = false; state.threadView = btn.dataset.tab; renderThread(); pushUrlState(); };
  });
  // Action button delegation
  header.querySelectorAll('.thread-actions button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('loading') || !state.selected) return;
      btn.classList.add('loading');
      agentAction(state.selected, btn.dataset.action).finally(() => btn.classList.remove('loading'));
    });
  });
  header.querySelectorAll('.thread-actions button[data-copy-tmux]').forEach(btn => {
    btn.addEventListener('click', () => {
      const orig = btn.textContent;
      navigator.clipboard.writeText(btn.dataset.copyTmux).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    });
  });

  const view = state.threadView;
  const filesPanel = document.getElementById('filesPanel');
  messages.style.display = view === 'messages' ? 'flex' : 'none';
  personaPanel.style.display = view === 'persona' ? 'block' : 'none';
  reminderPanel.style.display = view === 'reminders' ? 'flex' : 'none';
  watchPanel.style.display = view === 'watch' ? 'flex' : 'none';
  filesPanel.style.display = view === 'files' ? 'flex' : 'none';
  input.style.display = view === 'messages' ? 'flex' : 'none';
  const breadcrumbs = document.getElementById('topicBreadcrumbs');
  breadcrumbs.style.display = view === 'messages' ? 'flex' : 'none';
  renderTopicBreadcrumbs();

  if (view === 'persona') {
    renderPersona();
    return;
  }

  if (view === 'reminders') {
    document.getElementById('reminderPanel').load(state.selected);
    return;
  }

  if (view === 'watch') {
    document.getElementById('watchPanel').start(state.selected);
    return;
  }

  if (view === 'files') {
    document.getElementById('filesPanel').load(state.selected);
    return;
  }

  const thread = state.threads[state.selected] || [];
  messages.setMarkdownRenderer(renderMarkdown);
  messages.loadThread(thread, state.selected);
}
