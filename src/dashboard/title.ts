/**
 * Browser tab title + favicon, reflecting the focused agent.
 *
 * Restores v2 behavior dropped in the v3 cutover: the tab shows the focused
 * agent's icon + name (v2's updatePageTitle). "Focused agent" = the watched
 * agent on #/watch/:name, or the single selected agent in the sidebar filter;
 * otherwise none (app default). v2 only put the emoji in the title TEXT — here
 * we also render a real emoji favicon from the agent's icon. Updates on
 * route/selection/agent changes.
 */
import { state, on, agentsByName } from './state.ts';

const BASE = 'Agentic Collab';
// App default favicon when no single agent is focused.
const DEFAULT_FAVICON_EMOJI = '🛰️';

/** The single agent the operator is "focused" on, or null. */
function focusedAgentName(): string | null {
  if (state.route.kind === 'watch') return state.route.agentName;
  if (state.selectedAgents.size === 1) return [...state.selectedAgents][0] ?? null;
  return null;
}

/** An emoji rendered as an SVG data-URI favicon. */
function emojiFavicon(emoji: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">${emoji}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function setFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

function update(): void {
  const name = focusedAgentName();
  const icon = name ? (agentsByName.get(name)?.icon || '') : '';
  if (name) {
    document.title = `${icon ? `${icon} ` : ''}${name} — ${BASE}`;
    setFavicon(emojiFavicon(icon || DEFAULT_FAVICON_EMOJI));
  } else {
    document.title = BASE;
    setFavicon(emojiFavicon(DEFAULT_FAVICON_EMOJI));
  }
}

/** Wire the tab title + favicon to focus/selection/agent changes. */
export function setupTitle(): void {
  update();
  on('route-changed', update);
  on('selection-changed', update);
  // Agent list arrives/refreshes after init — the focused agent's icon/name
  // may only be known then.
  on('agents-changed', update);
  on('init', update);
}
