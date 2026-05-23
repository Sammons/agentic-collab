/**
 * v3 hash-based router.
 *
 * The dashboard is a single-page app with seven top-level routes. We use
 * `location.hash` because it works without server config and is trivially
 * shareable. Hash format:
 *
 *   #/             -> dashboard (merged chat)
 *   #/agents       -> agents management
 *   #/watch/:name  -> watch a specific agent
 *   #/approvals    -> approvals master-detail
 *   #/reminders    -> reminders fan-out
 *   #/settings     -> settings (engine configs, prefs, etc.)
 *   #/search       -> global search
 *
 * Each route renders into #route-root. PR 1 wires up routing only — every
 * route renders a placeholder. PR 2–9 replace placeholders with actual UI.
 */
import { state, emit, type Route } from './state.ts';

type RouteRenderer = (root: HTMLElement, route: Route) => void;

const renderers: Record<Route['kind'], RouteRenderer> = {
  dashboard: (root) => placeholder(root, 'Dashboard', 'Merged chat stream. Implemented in PR 2.'),
  agents:    (root) => placeholder(root, 'Agents',    'Flat agent list. Implemented in PR 3.'),
  watch:     (root, r) => {
    const name = r.kind === 'watch' ? r.agentName : '(unknown)';
    placeholder(root, `Watching ${name}`, 'Live tmux peek. Implemented in PR 4.');
  },
  approvals: (root) => placeholder(root, 'Approvals', 'Master-detail review. Implemented in PR 5.'),
  reminders: (root) => placeholder(root, 'Reminders', 'Per-agent recurring nudges. Implemented in PR 6.'),
  settings:  (root) => placeholder(root, 'Settings',  'Engine configs, prefs, pages, stores, destinations. Implemented in PR 7.'),
  'edit-engine': (root, r) => {
    const name = r.kind === 'edit-engine' ? r.name : '(unknown)';
    placeholder(root, `Edit engine config — ${name}`, 'Loading…');
  },
  search:    (root) => placeholder(root, 'Search',    'Global multi-type search. Implemented in PR 8.'),
};

function placeholder(root: HTMLElement, title: string, lede: string): void {
  root.innerHTML = `
    <div class="route-placeholder">
      <div class="eyebrow">${title}</div>
      <h1 class="title">${title}</h1>
      <p class="lede">${lede}</p>
    </div>
  `;
}

/** Parse `location.hash` into a Route. Defaults to dashboard. */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').trim();
  if (h === '' || h === '/') return { kind: 'dashboard' };
  if (h === 'agents')     return { kind: 'agents' };
  if (h === 'approvals')  return { kind: 'approvals' };
  if (h === 'reminders')  return { kind: 'reminders' };
  if (h === 'settings')   return { kind: 'settings' };
  if (h === 'search')     return { kind: 'search' };
  if (h.startsWith('watch/')) {
    const name = h.slice('watch/'.length);
    if (name) return { kind: 'watch', agentName: name };
  }
  if (h.startsWith('edit-engine/')) {
    const name = decodeURIComponent(h.slice('edit-engine/'.length));
    if (name) return { kind: 'edit-engine', name };
  }
  // Unknown — fall back to dashboard.
  return { kind: 'dashboard' };
}

export function go(route: Route): void {
  let hash = '#/';
  switch (route.kind) {
    case 'dashboard': hash = '#/'; break;
    case 'agents':    hash = '#/agents'; break;
    case 'watch':     hash = `#/watch/${encodeURIComponent(route.agentName)}`; break;
    case 'approvals': hash = '#/approvals'; break;
    case 'reminders': hash = '#/reminders'; break;
    case 'settings':  hash = '#/settings'; break;
    case 'edit-engine': hash = `#/edit-engine/${encodeURIComponent(route.name)}`; break;
    case 'search':    hash = '#/search'; break;
  }
  if (location.hash !== hash) location.hash = hash;
  else applyRoute(); // same hash, force re-render
}

function applyRoute(): void {
  const root = document.getElementById('route-root');
  if (!root) return;
  state.route = parseHash(location.hash);
  const renderer = renderers[state.route.kind];
  renderer(root, state.route);
  emit('route-changed', state.route);
}

/** Allow surfaces (PR 2+) to override a placeholder. */
export function registerRoute<K extends Route['kind']>(kind: K, renderer: RouteRenderer): void {
  renderers[kind] = renderer;
  // If the active route is the one being registered, re-render.
  if (state.route.kind === kind) applyRoute();
}

export function setupRouter(): void {
  window.addEventListener('hashchange', applyRoute);
  applyRoute(); // initial
}
