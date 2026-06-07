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
 * The non-secret Telegram binding fields the persona editor surfaces as widgets.
 * Mirrors `AgentTelegramConfig` minus the token (the token lives in the encrypted
 * write-only store, never in frontmatter). `inbound` is kept as a string so it
 * round-trips through the YAML-subset nested parser the orchestrator uses.
 */
export type TelegramFrontmatter = {
  chatId: string;
  inbound: boolean;
  routing: 'self' | 'prefix' | 'passthrough';
};

const TELEGRAM_ROUTINGS = ['self', 'prefix', 'passthrough'] as const;

/**
 * Read the nested `telegram:` block out of a raw frontmatter passthrough string.
 *
 * Recognizes the block precedent set by `env` (a top-level `telegram:` line with
 * an empty inline value, followed by indented `key: value` children). Returns the
 * parsed binding config, or null when no block is present. `inbound` defaults to
 * true unless the child is the literal `false`. Quotes around values are stripped.
 * Pure string op — paired with `setFrontmatterTelegram` for a lossless round-trip
 * of the three editable fields.
 */
export function parseFrontmatterTelegram(raw: string): TelegramFrontmatter | null {
  const lines = raw.split('\n');
  const headerIdx = lines.findIndex((line) => /^telegram:\s*$/.test(line));
  if (headerIdx === -1) return null;

  const child: Record<string, string> = {};
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // back to top level — block ended
    const m = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) child[m[1]!] = stripQuotes(m[2]!.trim());
  }

  const routing = TELEGRAM_ROUTINGS.includes(child['routing'] as never)
    ? (child['routing'] as TelegramFrontmatter['routing'])
    : 'self';
  return {
    chatId: child['chatId'] ?? '',
    inbound: child['inbound'] !== 'false',
    routing,
  };
}

/**
 * Replace (or remove) the nested `telegram:` block in a raw frontmatter
 * passthrough string. Drops any existing `telegram:` block (header + its indented
 * children) in place, then appends a fresh block when `cfg` is non-null and
 * carries a chatId. `cfg === null` (or an empty chatId) clears the block.
 *
 * Pure string op so it round-trips losslessly through the raw-passthrough
 * `PUT /api/personas/:name` exactly like `setFrontmatterProxy`. The token is NOT
 * a frontmatter field and is never touched here.
 */
export function setFrontmatterTelegram(raw: string, cfg: TelegramFrontmatter | null): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      const indent = line.length - line.trimStart().length;
      // Stay in skip mode while the line is indented (a child) or blank-within.
      if (line.trim() === '' || indent > 0) continue;
      skipping = false; // a new top-level line — stop skipping, fall through
    }
    if (/^telegram:\s*$/.test(line) || /^telegram:\s+\S/.test(line)) {
      skipping = true; // drop the header and (above) its children
      continue;
    }
    kept.push(line);
  }

  if (cfg && cfg.chatId.trim() !== '') {
    while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
    kept.push('telegram:');
    kept.push(`  chatId: "${cfg.chatId.trim()}"`);
    kept.push(`  inbound: ${cfg.inbound ? 'true' : 'false'}`);
    kept.push(`  routing: ${cfg.routing}`);
  }
  return kept.join('\n');
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
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
