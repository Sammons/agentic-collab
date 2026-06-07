/**
 * Dashboard utilities — shared helpers for escaping, formatting, and toasts.
 *
 * Extracted from 9 duplicated implementations across dashboard modules.
 * RFC: Code Quality Sweep, PR-1.
 */

/**
 * Escape HTML special characters for safe interpolation into innerHTML.
 * Handles null/undefined gracefully by returning empty string.
 */
export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an ISO timestamp to a short time string (HH:MM).
 */
export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Set (or clear) the top-level `proxy:` key in a raw YAML frontmatter block.
 *
 * Pure string op (no parsing) so it round-trips losslessly through the
 * raw-passthrough `PUT /api/personas/:name`: drops any existing top-level
 * `proxy:` line — indented/nested keys and lookalikes such as `proxyId:` are
 * left untouched — then appends `proxy: <value>` when `value` is non-empty.
 * Used by the Edit-persona modal so the proxy dropdown stays in sync with the
 * frontmatter textarea that is actually submitted.
 */
export function setFrontmatterProxy(raw: string, value: string): string {
  const lines = raw.split('\n').filter((line) => !/^proxy:(\s|$)/.test(line));
  if (value) {
    while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push(`proxy: ${value}`);
  }
  return lines.join('\n');
}

/**
 * Whether a proxy counts as online given its last heartbeat.
 *
 * Mirrors the orchestrator's stale-proxy reaper, which drops a proxy after
 * 3 missed 15s heartbeats (`listStaleProxies(45)` in orchestrator/main.ts).
 * Computing the same client-side keeps the dot honest when the reaper lags
 * between its poll cycles. An unparseable timestamp counts as offline.
 */
export function proxyOnline(lastHeartbeat: string, nowMs: number, staleSeconds = 45): boolean {
  const ts = new Date(lastHeartbeat).getTime();
  if (Number.isNaN(ts)) return false;
  return nowMs - ts <= staleSeconds * 1000;
}

/**
 * Show a toast notification that auto-dismisses after 3 seconds.
 */
export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `chat-toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
