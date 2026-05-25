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
 * Show a toast notification that auto-dismisses after 3 seconds.
 */
export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `chat-toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
