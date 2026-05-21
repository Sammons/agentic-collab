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
import { loadToken } from './state.ts';
import { setupRouter } from './routing.ts';
import { setupSidebar } from './sidebar.ts';
import { setupChat } from './chat.ts';
import { setupAgents } from './agents.ts';
import { setupWatch } from './watch.ts';
import { setupApprovals } from './approvals.ts';
import { setupReminders } from './reminders.ts';
import { setupSettings } from './settings.ts';
import { connect } from './connection.ts';

function boot(): void {
  loadToken();
  // Register route renderers BEFORE setupRouter() so initial render uses them.
  setupChat();
  setupAgents();
  setupWatch();
  setupApprovals();
  setupReminders();
  setupSettings();
  setupRouter();
  setupSidebar();
  connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
