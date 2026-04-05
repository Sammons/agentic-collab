/**
 * URL state module.
 * Manages browser History API integration for back/forward navigation.
 * Pushes state on agent selection, tab switch, and settings open/close.
 * Handles popstate to restore dashboard state from URL params.
 *
 * URL format:
 *   /dashboard?agent=NAME&tab=TAB   — agent selected with tab
 *   /dashboard?settings=1           — settings panel open
 *   /dashboard                      — no agent selected
 *
 * Exports:
 *   pushUrlState()                  — push current state to history (deduplicates)
 *   parseUrlState()                 — read URL params into { agent, tab, settings }
 *   setup({ selectAgent, renderThread, openSettings, closeSettings }) — wire deps + popstate
 */

import { state } from '/dashboard/assets/state.ts';

// ── Dependencies injected via setup() ──
let _selectAgent = (_name) => {};
let _openSettings = () => {};
let _closeSettings = () => {};

// Track last pushed state to avoid duplicate pushes
let _lastPushed = '';

/**
 * Build the URL search string for the current dashboard state.
 */
function buildSearch(opts) {
  const params = new URLSearchParams();
  const agent = opts?.agent ?? state.selected;
  const tab = opts?.tab ?? state.threadView;
  const settings = opts?.settings ?? false;

  if (settings) {
    params.set('settings', '1');
  } else if (agent) {
    params.set('agent', agent);
    if (tab && tab !== 'messages') params.set('tab', tab);
  }

  const qs = params.toString();
  return qs ? `?${qs}` : location.pathname;
}

/**
 * Push current dashboard state to browser history.
 * Skips if the URL would be identical to the last push (dedup).
 */
export function pushUrlState(opts) {
  const url = buildSearch(opts);
  if (url === _lastPushed) return;
  _lastPushed = url;
  history.pushState(null, '', url);
}

/**
 * Parse URL search params into a dashboard state descriptor.
 */
export function parseUrlState() {
  const params = new URLSearchParams(location.search);
  return {
    agent: params.get('agent') || null,
    tab: params.get('tab') || 'messages',
    settings: params.get('settings') === '1',
  };
}

/**
 * Restore dashboard state from current URL (used by popstate and initial load).
 */
function restoreFromUrl() {
  const { agent, tab, settings } = parseUrlState();
  _lastPushed = buildSearch({ agent, tab, settings });

  if (settings) {
    _openSettings();
    return;
  }

  _closeSettings();

  if (agent && state.agents.find(a => a.name === agent)) {
    // Only select if different to avoid unnecessary re-renders
    if (state.selected !== agent) {
      _selectAgent(agent);
    }
    if (state.threadView !== tab) {
      state.threadView = tab;
      // renderThread is called by selectAgent, but if agent didn't change we need it
      if (state.selected === agent) {
        const { renderThread } = _deps;
        renderThread();
      }
    }
  } else if (agent) {
    // Agent in URL but not loaded yet — store for deferred restore
    _pendingAgent = agent;
    _pendingTab = tab;
  } else {
    // No agent in URL — deselect
    if (state.selected) {
      state.selected = null;
      state.threadView = 'messages';
      const { renderThread, renderAgents } = _deps;
      renderAgents();
      renderThread();
    }
  }
}

let _pendingAgent = null;
let _pendingTab = 'messages';
let _deps = { renderThread: () => {}, renderAgents: () => {} };

/**
 * Call after agents are loaded to restore a pending URL agent selection.
 */
export function restorePendingAgent() {
  if (!_pendingAgent) return;
  const agent = _pendingAgent;
  const tab = _pendingTab;
  _pendingAgent = null;
  _pendingTab = 'messages';
  if (state.agents.find(a => a.name === agent)) {
    state.threadView = tab;
    _selectAgent(agent);
  }
}

/**
 * Wire dependencies and attach popstate listener.
 */
export function setup({ selectAgent, renderThread, renderAgents, openSettings, closeSettings }) {
  _selectAgent = selectAgent;
  _openSettings = openSettings;
  _closeSettings = closeSettings;
  _deps = { renderThread, renderAgents };

  window.addEventListener('popstate', () => restoreFromUrl());

  // Initial load: parse URL and restore state.
  // Defer slightly so all modules have finished init.
  queueMicrotask(() => restoreFromUrl());
}
