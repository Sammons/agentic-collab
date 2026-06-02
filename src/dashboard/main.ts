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
import { loadToken, loadCachedThreads, restoreSelectionAtBoot, state } from './state.ts';
import { setupRouter } from './routing.ts';
import { setupSidebar } from './sidebar.ts';
import { setupChat } from './chat.ts';
import { setupAgents } from './agents.ts';
import { setupWatch } from './watch.ts';
import { setupApprovals } from './approvals.ts';
import { setupReminders } from './reminders.ts';
import { setupSettings } from './settings.ts';
import { setupSearch } from './search.ts';
import { setupPersona } from './persona.ts';
import { connect } from './connection.ts';

function boot(): void {
  loadToken();
  // Restore cached threads BEFORE wiring routes so the merged feed has
  // something to render against immediately on cold reload, even before
  // the WS delta init lands. The selection restore below intersects with
  // the *cached* agent names too so the user lands on their last view.
  const cached = loadCachedThreads();
  state.threads = cached.threads;
  // Restore the agent selection at boot too, so the initial chat feed loads
  // over REST immediately instead of waiting on the WS `init` to restore it —
  // a slow/failed socket was leaving the chat history blank on reload.
  restoreSelectionAtBoot();
  // Register route renderers BEFORE setupRouter() so initial render uses them.
  setupChat();
  setupAgents();
  setupWatch();
  setupApprovals();
  setupReminders();
  setupSettings();
  setupSearch();
  setupPersona();
  setupRouter();
  setupSidebar();
  setupMobileNav();
  connect();
}

/**
 * Mobile navigation:
 *  - Bottom tab bar (#mobileTabs) for primary navigation
 *  - Sidebar drawer for Teams filter (opened via "Teams" tab)
 *  - Scrim (#sidebarScrim) closes drawer on tap
 *  - Escape key also closes
 * On desktop (>= 769px) the CSS hides the tab bar and shows the sidebar;
 * this JS is harmless there.
 */
function setupMobileNav(): void {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('sidebarScrim');
  const tabs = document.getElementById('mobileTabs');
  if (!sidebar || !scrim) return;

  const openDrawer = () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-visible');
    document.body.classList.add('drawer-open');
  };
  const closeDrawer = () => {
    sidebar.classList.remove('is-open');
    scrim.classList.remove('is-visible');
    document.body.classList.remove('drawer-open');
  };

  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('is-open')) closeDrawer();
  });

  // Close drawer when the user navigates via the sidebar
  sidebar.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-go], [data-eye]')) {
      if (window.matchMedia('(max-width: 768px)').matches) closeDrawer();
    }
  });

  // Bottom tab bar — handle "Teams" button to toggle sidebar, update active states
  if (tabs) {
    const updateActiveTab = () => {
      const hash = location.hash || '#/';
      tabs.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
        const tabId = tab.dataset['tab'];
        let isActive = false;
        if (tabId === 'dashboard' && (hash === '#/' || hash === '#/dashboard' || hash.startsWith('#/watch/'))) {
          isActive = true;
        } else if (tabId === 'agents' && hash === '#/agents') {
          isActive = true;
        } else if (tabId === 'settings' && hash.startsWith('#/settings')) {
          isActive = true;
        }
        tab.classList.toggle('active', isActive);
      });
    };

    // Update on hash change
    window.addEventListener('hashchange', updateActiveTab);
    updateActiveTab();

    // Handle tab clicks
    tabs.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab');
      if (!tab) return;
      const tabId = tab.dataset['tab'];

      if (tabId === 'sidebar') {
        // Toggle sidebar drawer
        e.preventDefault();
        if (sidebar.classList.contains('is-open')) {
          closeDrawer();
        } else {
          openDrawer();
        }
      } else {
        // Close drawer when navigating to another tab
        closeDrawer();
      }
    });

    // Hide tab bar when virtual keyboard is open (mobile)
    // Uses Visual Viewport API which accurately detects keyboard on iOS/Android
    if (window.visualViewport) {
      const vv = window.visualViewport;
      let initialHeight = vv.height;

      const checkKeyboard = () => {
        // If viewport shrinks significantly, keyboard is likely open
        const keyboardOpen = vv.height < initialHeight * 0.75;
        tabs.classList.toggle('keyboard-open', keyboardOpen);
      };

      vv.addEventListener('resize', () => {
        // Update initial height on orientation change (wider viewport = taller initial)
        if (Math.abs(vv.height - initialHeight) > 200 && vv.height > initialHeight) {
          initialHeight = vv.height;
        }
        checkKeyboard();
      });
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
