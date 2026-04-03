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

import { state } from '/dashboard/assets/state.ts';
import { esc, renderMarkdown } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';
import { renderPersona, setup as setupPersonaEditor } from '/dashboard/assets/persona-editor.ts';

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
  const tabs = `<div class="thread-tabs">
    <button class="${state.threadView === 'messages' ? 'active' : ''}" data-tab="messages">Messages</button>
    <button class="${state.threadView === 'watch' ? 'active' : ''}" data-tab="watch">Watch</button>
    <button class="${state.threadView === 'reminders' ? 'active' : ''}" data-tab="reminders">Reminders</button>
    <button class="${state.threadView === 'persona' ? 'active' : ''}" data-tab="persona">Persona</button>
  </div>`;
  header.innerHTML = `<button class="mobile-back" id="mobileBackBtn">${icon.arrowLeft(16)}</button><span>${esc(state.selected)}</span>${headerBadge}${tabs}`;
  document.getElementById('mobileBackBtn').onclick = mobileBack;
  header.querySelectorAll('.thread-tabs button').forEach(btn => {
    btn.onclick = () => { state.editingPersona = false; state.threadView = btn.dataset.tab; renderThread(); };
  });

  const view = state.threadView;
  messages.style.display = view === 'messages' ? 'flex' : 'none';
  personaPanel.style.display = view === 'persona' ? 'block' : 'none';
  reminderPanel.style.display = view === 'reminders' ? 'flex' : 'none';
  watchPanel.style.display = view === 'watch' ? 'flex' : 'none';
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

  const thread = state.threads[state.selected] || [];
  messages.setMarkdownRenderer(renderMarkdown);
  messages.loadThread(thread, state.selected);
}
