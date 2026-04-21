/**
 * Agent list module.
 * Sidebar agent cards, grouping, drag-drop reorder, search/filter,
 * agent selection, message tracking, and unread badges.
 *
 * Exports:
 *   setup({ renderThread, updateSendability, updatePageTitle }) -- wire deps
 *   renderAgents()          -- full sidebar rebuild (groups, engine summary)
 *   selectAgent(name)       -- select agent, manage drafts/topics/unread
 *   patchAgentCard(card, a) -- in-place card update via component
 *   updateAgent(agent)      -- process agent_update from server
 *   addMessage(msg)         -- append to thread, flash card, update unread
 *   handleMessageWithdrawn(msg) -- mark withdrawn in thread
 *   applySearchFilter()     -- toggle card visibility by text/chip filter
 */

import { state, authHeaders, getToken } from '/dashboard/assets/state.ts';
import { fetchEngineUsage, pollEngineUsage } from '/dashboard/assets/connection.ts';
import { esc, renderMarkdown, timeAgo, showToast, promptInput } from '/dashboard/assets/utils.ts';
import { agentAction, openCreateAgentModal } from '/dashboard/assets/agent-lifecycle.ts';
import { icon } from '/dashboard/assets/icons.ts';
import { pushUrlState } from '/dashboard/assets/url-state.ts';

// ── Dependencies injected via setup() ──
let _renderThread = () => {};
let _updateSendability = () => {};
let _updatePageTitle = () => {};

export function setup({ renderThread, updateSendability, updatePageTitle }) {
  _renderThread = renderThread;
  _updateSendability = updateSendability;
  _updatePageTitle = updatePageTitle;
}

// ── Patch / Update ──

export function patchAgentCard(card, agent) {
  if (card.update) {
    card.update(agent, {
      unread: state.unread[agent.name] || 0,
      indicators: state.indicators[agent.name] || [],
      selected: state.selected === agent.name,
      proxies: state.proxies,
    });
  }
}

export function updateAgent(agent) {
  const idx = state.agents.findIndex(a => a.name === agent.name);
  const isNew = idx < 0;
  if (idx >= 0) state.agents[idx] = agent;
  else state.agents.push(agent);
  if (isNew) {
    // Structural change — need full rebuild
    renderAgents();
  } else {
    // Patch existing card in-place — no DOM teardown
    const card = document.querySelector(`[data-agent="${agent.name}"]`);
    if (card) patchAgentCard(card, agent);
    else renderAgents(); // card not found (collapsed group?), fallback
  }
  if (agent.name === state.selected) {
    _updateSendability();
    // Update state badge in thread header too
    const header = document.getElementById('threadHeader');
    const hBadge = header.querySelector('.state-badge');
    if (hBadge) {
      hBadge.className = `state-badge state-${agent.state}`;
      hBadge.textContent = agent.state;
    }
  }
}

export function addMessage(msg) {
  if (!state.threads[msg.agent]) state.threads[msg.agent] = [];
  const thread = state.threads[msg.agent];
  // Dedup: if this message ID already exists (from HTTP fallback), skip.
  // Also replace any optimistic message (negative ID) for the same content.
  if (thread.some(m => m.id === msg.id)) return;
  const optimisticIdx = thread.findIndex(m => m.id < 0 && m.message === msg.message && m.agent === msg.agent);
  if (optimisticIdx >= 0) {
    thread[optimisticIdx] = msg;
    return; // DOM already has the optimistic render — WS dedup, no re-render needed
  }
  thread.push(msg);
  if (state.selected === msg.agent && state.threadView === 'messages') {
    // Append single message via component — no full re-render
    const messages = document.getElementById('threadMessages');
    messages.appendMessage(msg, msg.agent);
  } else if (state.selected !== msg.agent) {
    // Track unread for non-selected agents
    state.unread[msg.agent] = (state.unread[msg.agent] || 0) + 1;
  }

  // Flash the agent card + patch unread badge in-place
  const card = document.querySelector(`[data-agent="${msg.agent}"]`);
  if (card) {
    const agent = state.agents.find(a => a.name === msg.agent);
    if (agent) patchAgentCard(card, agent);
    if (state.selected !== msg.agent) {
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 600);
    }
  }
  _updatePageTitle();
}

export function handleMessageWithdrawn(msg) {
  const thread = state.threads[msg.agent];
  if (!thread) return;
  const idx = thread.findIndex(m => m.id === msg.id);
  if (idx >= 0) {
    thread[idx] = msg;
    if (state.selected === msg.agent) _renderThread();
  }
}

// ── Render ──

// Full DOM rebuild — only called for structural changes (add/remove agent,
// group changes, init). Routine updates use patchAgentCard() in-place.
export function renderAgents() {
  const list = document.getElementById('agentList');

  // Preserve create form input values and focus before clearing
  // Clear agent list (search and create form are outside the scroll container)
  list.innerHTML = '';

  const filter = state.searchFilter.toLowerCase();
  let filtered = filter
    ? state.agents.filter(a => a.name.toLowerCase().includes(filter) || a.engine.toLowerCase().includes(filter) || a.state.toLowerCase().includes(filter) || (a.agentGroup || '').toLowerCase().includes(filter))
    : state.agents;

  // Apply quick filter chip
  if (state.quickFilter === 'active') {
    filtered = filtered.filter(a => a.state === 'active');
  } else if (state.quickFilter === 'idle') {
    filtered = filtered.filter(a => a.state === 'idle');
  } else if (state.quickFilter === 'unread') {
    filtered = filtered.filter(a => (state.unread[a.name] || 0) > 0);
  } else if (state.quickFilter === 'recent') {
    filtered = filtered.filter(a => a.lastActivity).sort((a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    ).slice(0, 7);
  } else if (state.quickFilter === 'starred') {
    const starred = JSON.parse(localStorage.getItem('starredAgents') || '{}');
    filtered = filtered.filter(a => starred[a.name]);
  }

  // Update chip active states
  document.querySelectorAll('.filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === state.quickFilter);
  });

  // Toggle filtered class on agent list — disables drag handles via CSS
  list.classList.toggle('filtered', isFiltered());

  // Group agents
  const groups = new Map();
  for (const agent of filtered) {
    const g = agent.agentGroup || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(agent);
  }
  // Include empty groups created via "+ New Group" (only when no filter active)
  if (state.emptyGroups && !state.quickFilter && !filter) {
    for (const g of state.emptyGroups) {
      if (!groups.has(g)) groups.set(g, []);
    }
  }
  // Sort: use saved order from localStorage, then General first, then alphabetical
  const savedOrder = JSON.parse(localStorage.getItem('sectionOrder') || '[]');
  const sortedGroups = [...groups.keys()].sort((a, b) => {
    const ai = savedOrder.indexOf(a);
    const bi = savedOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    if (a === 'General') return -1;
    if (b === 'General') return 1;
    return a.localeCompare(b);
  });

  // New Agent button — opens creation modal
  const formContainer = document.getElementById('createFormContainer');
  if (formContainer && !formContainer.hasChildNodes()) {
    const btn = document.createElement('button');
    btn.className = 'create-agent-btn';
    btn.innerHTML = icon.plus(14) + ' New Agent';
    btn.onclick = () => openCreateAgentModal();
    formContainer.appendChild(btn);
  }

  const collapsedGroups = JSON.parse(localStorage.getItem('collapsedGroups') || '[]');
  for (const groupName of sortedGroups) {
    const groupAgents = groups.get(groupName);
    // Hide empty groups when a filter is active
    if ((state.quickFilter || filter) && (!groupAgents || groupAgents.length === 0)) continue;
    const isCollapsed = collapsedGroups.includes(groupName);
    const showHeader = sortedGroups.length > 1 || groupName !== 'General';
    if (showHeader) {
      const groupHeader = document.createElement('div');
      groupHeader.className = `agent-group-header${isCollapsed ? ' collapsed' : ''}`;
      groupHeader.setAttribute('draggable', 'true');
      groupHeader.dataset.group = groupName;
      const label = document.createElement('span');
      label.innerHTML = `<span class="group-chevron">${icon.chevronDown(12)}</span>${esc(groupName)}`;
      label.style.cursor = 'pointer';
      label.onclick = (e) => {
        e.stopPropagation();
        const saved = JSON.parse(localStorage.getItem('collapsedGroups') || '[]');
        const idx = saved.indexOf(groupName);
        if (idx !== -1) saved.splice(idx, 1); else saved.push(groupName);
        localStorage.setItem('collapsedGroups', JSON.stringify(saved));
        renderAgents();
      };
      groupHeader.appendChild(label);
      if (groupName !== 'General') {
        const actions = document.createElement('span');
        actions.className = 'group-actions';
        actions.innerHTML = '<button class="group-rename" title="Rename group">' + icon.edit(12) + '</button><button class="group-delete" title="Delete group">' + icon.x(12) + '</button>';
        actions.querySelector('.group-rename').onclick = async (e) => {
          e.stopPropagation();
          const newName = await promptInput('Rename group:', groupName);
          if (!newName || newName === groupName) return;
          renameGroup(groupName, newName);
        };
        actions.querySelector('.group-delete').onclick = (e) => {
          e.stopPropagation();
          deleteGroup(groupName);
        };
        groupHeader.appendChild(actions);
      }
      list.appendChild(groupHeader);
    }

  if (showHeader && isCollapsed) continue;
  for (const agent of groups.get(groupName)) {
    const card = document.createElement('agent-card');
    card.render(agent, {
      unread: state.unread[agent.name] || 0,
      indicators: state.indicators[agent.name] || [],
      selected: state.selected === agent.name,
      proxies: state.proxies,
    });
    list.appendChild(card);
  }
  } // end group loop

  // Hide New Group button + Engine summary when filtering
  if (state.quickFilter || filter) return;

  // New Group button
  const newGroupBtn = document.createElement('button');
  newGroupBtn.className = 'secondary';
  newGroupBtn.style.cssText = 'margin-top:6px;padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-dim);font-size:11px;cursor:pointer;width:100%;text-align:left';
  newGroupBtn.innerHTML = icon.plus(12) + ' New Group';
  newGroupBtn.onmouseenter = () => { newGroupBtn.style.borderColor = 'var(--accent)'; newGroupBtn.style.color = 'var(--accent)'; };
  newGroupBtn.onmouseleave = () => { newGroupBtn.style.borderColor = 'var(--border)'; newGroupBtn.style.color = 'var(--text-dim)'; };
  newGroupBtn.onclick = async () => {
    const groupName = await promptInput('Group name:');
    if (!groupName) return;
    // Add to saved section order so it persists
    const savedOrder = JSON.parse(localStorage.getItem('sectionOrder') || '[]');
    if (!savedOrder.includes(groupName)) {
      savedOrder.push(groupName);
      localStorage.setItem('sectionOrder', JSON.stringify(savedOrder));
    }
    // Create a placeholder so the group header renders
    // The group will appear empty until agents are moved into it
    if (!state.emptyGroups) state.emptyGroups = [];
    if (!state.emptyGroups.includes(groupName)) state.emptyGroups.push(groupName);
    renderAgents();
  };
  list.appendChild(newGroupBtn);

  // Engine status summary
  const engineSummary = document.createElement('div');
  engineSummary.style.cssText = 'margin-top:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:12px';
  const engineCounts = {};
  for (const a of state.agents) {
    if (!engineCounts[a.engine]) engineCounts[a.engine] = { total: 0, active: 0, idle: 0, failed: 0 };
    engineCounts[a.engine].total++;
    if (a.state === 'active') engineCounts[a.engine].active++;
    else if (a.state === 'idle') engineCounts[a.engine].idle++;
    else if (a.state === 'failed') engineCounts[a.engine].failed++;
  }
  let engineHtml = '<div style="font-weight:600;margin-bottom:6px;color:var(--text);display:flex;align-items:center;justify-content:space-between">Engines <button id="refreshUsageBtn" style="background:none;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;padding:2px 6px;font-size:11px;color:var(--text-dim)" title="Refresh usage stats">↻</button></div>';
  for (const engine of ['claude', 'codex', 'opencode']) {
    const c = engineCounts[engine];
    if (!c) {
      engineHtml += `<div style="color:var(--text-dim);margin:2px 0">${engine}: <span style="color:var(--text-dim)">not configured</span></div>`;
    } else {
      const parts = [];
      if (c.active) parts.push(`<span style="color:var(--green)">${c.active} active</span>`);
      if (c.idle) parts.push(`<span style="color:var(--yellow)">${c.idle} idle</span>`);
      if (c.failed) parts.push(`<span style="color:var(--red)">${c.failed} failed</span>`);
      const rest = c.total - c.active - c.idle - c.failed;
      if (rest > 0) parts.push(`${rest} other`);
      engineHtml += `<div style="margin:2px 0">${engine}: ${parts.join(', ')}</div>`;

      // Usage buckets — find all usage entries for this engine (including per-account)
      const usageEntries = Object.entries(state.engineUsage)
        .filter(([key, u]) => u && u.engine === engine && u.buckets && u.buckets.length > 0);
      for (const [key, usage] of usageEntries) {
        const accountLabel = usage.account && usage.account !== 'default'
          ? `<span style="color:var(--accent)">${esc(usage.account)}</span> ` : '';
        for (const b of usage.buckets) {
          const barPct = Math.min(100, Math.max(0, b.pctUsed));
          const color = barPct >= 80 ? 'var(--red)' : barPct >= 50 ? 'var(--yellow)' : 'var(--green)';
          engineHtml += `<div style="margin:2px 0 2px 12px;font-size:11px;color:var(--text-dim)">`;
          engineHtml += `${accountLabel}${b.label}: `;
          engineHtml += `<span style="display:inline-block;width:60px;height:8px;background:var(--border);border-radius:4px;vertical-align:middle;overflow:hidden">`;
          engineHtml += `<span style="display:block;width:${barPct}%;height:100%;background:${color};border-radius:4px"></span></span>`;
          engineHtml += ` <span style="color:${color}">${b.pctUsed}%</span>`;
          if (b.resetsAt) engineHtml += ` <span style="font-size:10px">(resets ${b.resetsAt})</span>`;
          engineHtml += `</div>`;
        }
        const ago = timeAgo(usage.queriedAt);
        engineHtml += `<div style="margin:1px 0 4px 12px;font-size:10px;color:var(--text-dim)">queried ${ago}</div>`;
      }
    }
  }
  engineSummary.innerHTML = engineHtml;
  list.appendChild(engineSummary);

  engineSummary.querySelector('#refreshUsageBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const originalText = btn.textContent;
    btn.textContent = 'loading...';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'wait';
    state.engineUsage = {};
    renderAgents();
    try {
      await pollEngineUsage();
    } catch (err) {
      console.error('[usage] poll failed:', err);
      await fetchEngineUsage();
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
    }
  });

  // Re-apply search/quick filter after full rebuild
  if (state.searchFilter || state.quickFilter) applySearchFilter();
}

// ── Select Agent ──

export function selectAgent(name) {
  state.editingPersona = false;
  // Save draft for previous agent via component
  const prevInput = document.getElementById('threadInput');
  if (state.selected && prevInput && prevInput.getDraft) {
    const text = prevInput.getDraft();
    if (text) state.drafts[state.selected] = text;
    else delete state.drafts[state.selected];
  }
  state.selected = name;
  state.unread[name] = 0;
  _updatePageTitle();
  // Auto-select most recent topic for this agent if none saved
  if (!state.topicPerAgent[name]) {
    const thread = state.threads[name] || [];
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i].topic) { state.topicPerAgent[name] = thread[i].topic; break; }
    }
  }
  // Persist read cursor on server so unread counts survive refresh
  fetch('/api/dashboard/read-cursor', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ agent: name }),
  }).catch(err => console.warn('Read cursor update failed:', err));
  // Mobile: show thread panel BEFORE rendering so scrollHeight is accurate
  document.querySelector('.layout').classList.add('mobile-thread');
  // Preserve current tab (messages/persona/watch) when switching agents
  renderAgents();
  _renderThread();
  pushUrlState();
  // Restore draft and focus via component
  const freshInput = document.getElementById('threadInput');
  if (freshInput && freshInput.setDraft) {
    freshInput.setDraft(state.drafts[name] || '');
  }
  _updateSendability();
  // Focus input on desktop only — mobile shouldn't auto-open keyboard
  if (freshInput && freshInput.focus && window.innerWidth > 768) freshInput.focus();
}

// ── Group Management ──

async function renameGroup(oldName, newName) {
  // Update all agents in this group
  const agents = state.agents.filter(a => (a.agentGroup || 'General') === oldName);
  for (const agent of agents) {
    agent.agentGroup = newName;
    fetch(`/api/agents/${encodeURIComponent(agent.name)}/group`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ group: newName }),
    }).catch(err => console.error('[group] Rename failed for', agent.name, err));
  }
  // Update saved section order
  const savedOrder = JSON.parse(localStorage.getItem('sectionOrder') || '[]');
  const idx = savedOrder.indexOf(oldName);
  if (idx !== -1) savedOrder[idx] = newName;
  localStorage.setItem('sectionOrder', JSON.stringify(savedOrder));
  // Update empty groups
  if (state.emptyGroups) {
    const ei = state.emptyGroups.indexOf(oldName);
    if (ei !== -1) state.emptyGroups[ei] = newName;
  }
  renderAgents();
}

async function deleteGroup(groupName) {
  // Move all agents in this group back to General
  const agents = state.agents.filter(a => (a.agentGroup || 'General') === groupName);
  for (const agent of agents) {
    agent.agentGroup = null;
    fetch(`/api/agents/${encodeURIComponent(agent.name)}/group`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ group: '' }),
    }).catch(err => console.error('[group] Delete-move failed for', agent.name, err));
  }
  // Remove from saved section order
  const savedOrder = JSON.parse(localStorage.getItem('sectionOrder') || '[]');
  const idx = savedOrder.indexOf(groupName);
  if (idx !== -1) savedOrder.splice(idx, 1);
  localStorage.setItem('sectionOrder', JSON.stringify(savedOrder));
  // Remove from empty groups
  if (state.emptyGroups) {
    state.emptyGroups = state.emptyGroups.filter(g => g !== groupName);
  }
  renderAgents();
}

// ── Event Delegation ──

// Event delegation on agent list — handles both card selection and action buttons.
function handleAgentListEvent(e) {
  // Ignore taps on drag handle (mobile touch-drag)
  if (e.target.closest('.drag-handle')) return;

  // Star toggle
  const starBtn = e.target.closest('.agent-star');
  if (starBtn) {
    e.stopPropagation();
    e.preventDefault();
    const agentName = starBtn.dataset.starAgent;
    if (!agentName) return;
    const starred = JSON.parse(localStorage.getItem('starredAgents') || '{}');
    if (starred[agentName]) delete starred[agentName];
    else starred[agentName] = true;
    localStorage.setItem('starredAgents', JSON.stringify(starred));
    const isStarred = !!starred[agentName];
    starBtn.className = `agent-star${isStarred ? ' starred' : ''}`;
    starBtn.innerHTML = isStarred ? icon.starFilled(14) : icon.star(14);
    // Re-filter if starred filter is active (un-starring should hide the card)
    if (state.quickFilter === 'starred') renderAgents();
    return;
  }

  const copyBtn = e.target.closest('button[data-copy-tmux]');
  if (copyBtn) {
    e.stopPropagation();
    const orig = copyBtn.textContent;
    navigator.clipboard.writeText(copyBtn.dataset.copyTmux).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    }).catch(() => {
      copyBtn.textContent = 'Failed';
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    });
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    e.stopPropagation();
    if (btn.classList.contains('loading')) return;
    const card = btn.closest('[data-agent]');
    if (card) {
      btn.classList.add('loading');
      agentAction(card.dataset.agent, btn.dataset.action)
        .finally(() => btn.classList.remove('loading'));
    }
    return;
  }
  const card = e.target.closest('[data-agent]');
  if (card) selectAgent(card.dataset.agent);
}

// ── Drag-Drop ──

function isFiltered() { return !!(state.quickFilter || state.searchFilter); }

let draggedAgent = null;
let draggedGroup = null;

function clearDragIndicators() {
  const agentListEl = document.getElementById('agentList');
  agentListEl.querySelectorAll('.drag-over-above, .drag-over-below, .drag-over').forEach(el => {
    el.classList.remove('drag-over-above', 'drag-over-below', 'drag-over');
  });
}

// ── Touch Drag (mobile) ──
let touchDragState = null;

function finishTouchDrag(e) {
  const agentListEl = document.getElementById('agentList');
  if (!touchDragState) return;
  const { agentName, clone } = touchDragState;
  if (clone) clone.remove();
  // Restore original card opacity
  const origCard = agentListEl.querySelector(`[data-agent="${agentName}"]`);
  if (origCard) origCard.style.opacity = '';

  // Find drop target
  const touch = e.changedTouches[0];
  clearDragIndicators();
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (el) {
    const header = el.closest('.agent-group-header[data-group]');
    const targetCard = el.closest('.agent-card[data-agent]');

    if (header) {
      // Drop on group header → change group
      const newGroup = header.dataset.group;
      const agent = state.agents.find(a => a.name === agentName);
      if (agent && (agent.agentGroup || 'General') !== newGroup) {
        agent.agentGroup = newGroup === 'General' ? null : newGroup;
        renderAgents();
        fetch(`/api/agents/${encodeURIComponent(agentName)}/group`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ group: newGroup === 'General' ? '' : newGroup }),
        }).catch(err => console.error('[touch-drag] Group change failed:', err));
      }
    } else if (targetCard && targetCard.dataset.agent !== agentName) {
      // Drop on another agent → reorder
      const rect = targetCard.getBoundingClientRect();
      const insertBefore = touch.clientY < rect.top + rect.height / 2;
      const fromIdx = state.agents.findIndex(a => a.name === agentName);
      const targetName = targetCard.dataset.agent;
      if (fromIdx !== -1) {
        const [moved] = state.agents.splice(fromIdx, 1);
        let toIdx = state.agents.findIndex(a => a.name === targetName);
        if (!insertBefore) toIdx++;
        state.agents.splice(toIdx, 0, moved);
        const orders = state.agents.map((a, i) => ({ name: a.name, sortOrder: i }));
        state.agents.forEach((a, i) => { a.sortOrder = i; });
        renderAgents();
        fetch('/api/agents/reorder', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ orders }),
        }).catch(err => console.error('[touch-drag] Reorder save failed:', err));
      }
    }
  }
  touchDragState = null;
}

// ── Proxy Version Warning ──

function proxyVersionWarning(proxyId) {
  const proxy = (state.proxies || []).find(p => p.proxyId === proxyId);
  if (!proxy || proxy.versionMatch !== false) return '';
  const ver = proxy.version ? ` (${esc(proxy.version)})` : '';
  return ` <span class="version-mismatch" title="Proxy version${ver} does not match orchestrator. Restart the proxy.">${icon.alertTriangle(12)} stale proxy</span>`;
}

// ── Search Filter ──

// Lightweight filter: toggle visibility on existing DOM cards instead of
// tearing down and rebuilding the entire agent list on every keystroke.
export function applySearchFilter() {
  const filter = state.searchFilter.toLowerCase();
  const list = document.getElementById('agentList');
  const cards = list.querySelectorAll('.agent-card[data-agent]');
  const groupCounts = new Map(); // groupHeader element → visible count
  const starred = JSON.parse(localStorage.getItem('starredAgents') || '{}');
  // First pass: show/hide cards
  for (const card of cards) {
    const name = card.dataset.agent;
    const agent = state.agents.find(a => a.name === name);
    let visible = true;
    if (filter && agent) {
      visible = agent.name.toLowerCase().includes(filter)
        || agent.engine.toLowerCase().includes(filter)
        || agent.state.toLowerCase().includes(filter)
        || (agent.agentGroup || '').toLowerCase().includes(filter);
    }
    if (visible && state.quickFilter) {
      if (state.quickFilter === 'active') visible = agent && agent.state === 'active';
      else if (state.quickFilter === 'idle') visible = agent && agent.state === 'idle';
      else if (state.quickFilter === 'unread') visible = agent && (state.unread[agent.name] || 0) > 0;
      else if (state.quickFilter === 'recent') visible = agent && !!agent.lastActivity;
      else if (state.quickFilter === 'starred') visible = agent && !!starred[agent.name];
    }
    card.style.display = visible ? '' : 'none';
    // Track per-group visibility
    let prev = card.previousElementSibling;
    while (prev && !prev.classList.contains('agent-group-header')) prev = prev.previousElementSibling;
    if (prev) {
      groupCounts.set(prev, (groupCounts.get(prev) || 0) + (visible ? 1 : 0));
    }
  }
  // Second pass: hide group headers with zero visible cards
  for (const [header, count] of groupCounts) {
    header.style.display = count > 0 ? '' : 'none';
  }
}

// ── Init: wire DOM event listeners ──

export function initAgentListEvents() {
  const agentListEl = document.getElementById('agentList');

  agentListEl.addEventListener('click', handleAgentListEvent);
  agentListEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleAgentListEvent(e);
    }
  });

  // ── Desktop Drag-Drop ──

  agentListEl.addEventListener('dragstart', (e) => {
    if (isFiltered()) { e.preventDefault(); return; }
    const card = e.target.closest('.agent-card[data-agent]');
    const header = e.target.closest('.agent-group-header[data-group]');
    if (card) {
      draggedAgent = card.dataset.agent;
      draggedGroup = null;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedAgent);
    } else if (header) {
      draggedGroup = header.dataset.group;
      draggedAgent = null;
      header.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedGroup);
    }
  });

  agentListEl.addEventListener('dragend', (e) => {
    const el = e.target.closest('.agent-card, .agent-group-header');
    if (el) el.classList.remove('dragging');
    clearDragIndicators();
    draggedAgent = null;
    draggedGroup = null;
  });

  agentListEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDragIndicators();

    const header = e.target.closest('.agent-group-header[data-group]');
    const card = e.target.closest('.agent-card[data-agent]');

    if (draggedAgent && header) {
      // Agent dragged over a section header → highlight for group change
      header.classList.add('drag-over');
    } else if (draggedAgent && card && card.dataset.agent !== draggedAgent) {
      // Agent dragged over another agent → reorder indicator
      const rect = card.getBoundingClientRect();
      card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-above' : 'drag-over-below');
    } else if (draggedGroup && header && header.dataset.group !== draggedGroup) {
      // Section header dragged over another section header → reorder indicator
      const rect = header.getBoundingClientRect();
      header.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-above' : 'drag-over-below');
    }
  });

  agentListEl.addEventListener('dragleave', (e) => {
    const el = e.target.closest('.agent-card, .agent-group-header');
    if (el) el.classList.remove('drag-over-above', 'drag-over-below', 'drag-over');
  });

  agentListEl.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDragIndicators();

    const targetHeader = e.target.closest('.agent-group-header[data-group]');
    const targetCard = e.target.closest('.agent-card[data-agent]');

    // Case 1: Agent dropped on a section header → change group
    if (draggedAgent && targetHeader) {
      const newGroup = targetHeader.dataset.group;
      const agent = state.agents.find(a => a.name === draggedAgent);
      if (agent && (agent.agentGroup || 'General') !== newGroup) {
        agent.agentGroup = newGroup === 'General' ? null : newGroup;
        renderAgents();
        fetch(`/api/agents/${encodeURIComponent(draggedAgent)}/group`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ group: newGroup === 'General' ? '' : newGroup }),
        }).catch(err => console.error('[drag] Group change failed:', err));
      }
      return;
    }

    // Case 2: Agent dropped on another agent → reorder within list
    if (draggedAgent && targetCard && targetCard.dataset.agent !== draggedAgent) {
      const rect = targetCard.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;
      const fromIdx = state.agents.findIndex(a => a.name === draggedAgent);
      const targetName = targetCard.dataset.agent;
      if (fromIdx === -1) return;
      const [moved] = state.agents.splice(fromIdx, 1);
      let toIdx = state.agents.findIndex(a => a.name === targetName);
      if (!insertBefore) toIdx++;
      state.agents.splice(toIdx, 0, moved);

      const orders = state.agents.map((a, i) => ({ name: a.name, sortOrder: i }));
      state.agents.forEach((a, i) => { a.sortOrder = i; });
      renderAgents();

      fetch('/api/agents/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orders }),
      }).catch(err => console.error('[drag] Reorder save failed:', err));
      return;
    }

    // Case 3: Section header dropped on another section header → reorder sections
    if (draggedGroup && targetHeader && targetHeader.dataset.group !== draggedGroup) {
      const savedOrder = JSON.parse(localStorage.getItem('sectionOrder') || '[]');
      // Build current order from DOM
      const headers = agentListEl.querySelectorAll('.agent-group-header[data-group]');
      const currentOrder = [...headers].map(h => h.dataset.group);
      // Ensure all groups are in the order list
      for (const g of currentOrder) {
        if (!savedOrder.includes(g)) savedOrder.push(g);
      }
      // Move dragged group
      const fromIdx = savedOrder.indexOf(draggedGroup);
      if (fromIdx !== -1) savedOrder.splice(fromIdx, 1);
      const rect = targetHeader.getBoundingClientRect();
      let targetIdx = savedOrder.indexOf(targetHeader.dataset.group);
      if (e.clientY >= rect.top + rect.height / 2) targetIdx++;
      savedOrder.splice(targetIdx, 0, draggedGroup);
      localStorage.setItem('sectionOrder', JSON.stringify(savedOrder));
      renderAgents();
    }
  });

  // ── Touch Drag (mobile) ──

  agentListEl.addEventListener('touchstart', (e) => {
    if (isFiltered()) return;
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const card = handle.closest('.agent-card[data-agent]');
    if (!card) return;
    e.preventDefault();
    const touch = e.touches[0];
    const rect = card.getBoundingClientRect();
    touchDragState = {
      agentName: card.dataset.agent,
      offsetY: touch.clientY - rect.top,
      clone: null,
      startY: touch.clientY,
    };
    // Create floating clone
    const clone = card.cloneNode(true);
    clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.5);border-color:var(--accent)`;
    document.body.appendChild(clone);
    touchDragState.clone = clone;
    card.style.opacity = '0.3';
  }, { passive: false });

  agentListEl.addEventListener('touchmove', (e) => {
    if (!touchDragState) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (touchDragState.clone) {
      touchDragState.clone.style.top = (touch.clientY - touchDragState.offsetY) + 'px';
    }
    // Show drop indicators
    clearDragIndicators();
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!el) return;
    const header = el.closest('.agent-group-header[data-group]');
    const targetCard = el.closest('.agent-card[data-agent]');
    if (header) {
      header.classList.add('drag-over');
    } else if (targetCard && targetCard.dataset.agent !== touchDragState.agentName) {
      const rect = targetCard.getBoundingClientRect();
      targetCard.classList.add(touch.clientY < rect.top + rect.height / 2 ? 'drag-over-above' : 'drag-over-below');
    }
  }, { passive: false });

  agentListEl.addEventListener('touchend', finishTouchDrag, { passive: false });
  agentListEl.addEventListener('touchcancel', (e) => {
    if (!touchDragState) return;
    if (touchDragState.clone) touchDragState.clone.remove();
    const origCard = agentListEl.querySelector(`[data-agent="${touchDragState.agentName}"]`);
    if (origCard) origCard.style.opacity = '';
    clearDragIndicators();
    touchDragState = null;
  });

  // ── Search / Filter Listeners ──

  const searchInput = document.getElementById('agentSearch');
  const searchClear = document.getElementById('agentSearchClear');
  searchInput.addEventListener('input', (e) => {
    state.searchFilter = e.target.value;
    searchClear.style.display = e.target.value ? 'block' : 'none';
    applySearchFilter();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchFilter = '';
    state.quickFilter = null;
    searchClear.style.display = 'none';
    applySearchFilter();
    searchInput.focus();
  });

  // Filter chips — toggle on click, clear on re-click
  document.getElementById('filterChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    const f = chip.dataset.filter;
    const wasActive = state.quickFilter === f;
    state.quickFilter = wasActive ? null : f;
    document.querySelectorAll('.filter-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === state.quickFilter);
    });
    // Full rebuild when toggling filters (groups may need to appear/disappear)
    renderAgents();
  });
}
