/**
 * v3 dashboard entry point.
 *
 * Boot sequence:
 *   1. Load auth token from localStorage (so /api/* calls succeed)
 *   2. Set up the hash router (renders the initial route's placeholder)
 *   3. Mount the sidebar (subscribes to state changes)
 *   4. Open the WebSocket connection (init payload populates state)
 *
 * The sidebar re-renders automatically on init/agents-changed/teams-changed
 * /selection-changed/route-changed events via state.ts's pub/sub bus.
 */
import { loadToken, loadCachedThreads, state } from './state.ts';
import { setupRouter } from './routing.ts';
import { setupSidebar } from './sidebar.ts';
import { setupChat } from './chat.ts';
import { setupAgents } from './agents.ts';
import { setupWatch } from './watch.ts';
import { setupApprovals } from './approvals.ts';
import { setupReminders } from './reminders.ts';
import { setupSettings } from './settings.ts';
import { setupSearch } from './search.ts';
import { connect } from './connection.ts';

function boot(): void {
  loadToken();
  // Restore cached threads BEFORE wiring routes so the merged feed has
  // something to render against immediately on cold reload, even before
  // the WS delta init lands. The selection restore below intersects with
  // the *cached* agent names too so the user lands on their last view.
  const cached = loadCachedThreads();
  state.threads = cached.threads;
  // Register route renderers BEFORE setupRouter() so initial render uses them.
  setupChat();
  setupAgents();
  setupWatch();
  setupApprovals();
  setupReminders();
  setupSettings();
  setupSearch();
  setupRouter();
  setupSidebar();
  setupMobileNav();
  connect();
}

/**
 * Mobile drawer behavior — sidebar is a slide-in panel on narrow viewports.
 *  - Hamburger button (#mobileMenuBtn) opens the drawer
 *  - Scrim (#sidebarScrim) closes it on tap
 *  - Navigating (clicking a nav-action or member eye-icon) auto-closes
 *  - Escape key also closes
 * On desktop (>= 769px) the CSS makes the hamburger + scrim display:none
 * and the sidebar is always visible; this JS is harmless there.
 */
function setupMobileNav(): void {
  const btn = document.getElementById('mobileMenuBtn');
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('sidebarScrim');
  if (!btn || !sidebar || !scrim) return;

  const open = () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-visible');
    document.body.classList.add('drawer-open');
  };
  const close = () => {
    sidebar.classList.remove('is-open');
    scrim.classList.remove('is-visible');
    document.body.classList.remove('drawer-open');
  };

  btn.addEventListener('click', () => {
    if (sidebar.classList.contains('is-open')) close(); else open();
  });
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('is-open')) close();
  });
  // Close drawer when the user navigates via the sidebar so the new
  // surface gets full mobile width. Only on narrow viewports.
  sidebar.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-go], [data-eye]')) {
      if (window.matchMedia('(max-width: 768px)').matches) close();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
