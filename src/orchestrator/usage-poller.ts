/**
 * Engine usage poller.
 * Periodically queries idle agents for account-level usage data
 * by pasting slash commands (/usage for Claude, etc.) and parsing output.
 *
 * Results are stored in memory and exposed via getUsageData().
 */

import type { Database } from './database.ts';
import type { LockManager } from '../shared/lock.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import { sessionName } from '../shared/agent-entity.ts';
import { sleep } from '../shared/utils.ts';

export type UsageBucket = {
  label: string;       // e.g. "Current session", "Current week (all models)"
  pctUsed: number;     // 0-100
  resetsAt: string;    // e.g. "Mar 13, 12am (America/Chicago)"
};

export type EngineUsage = {
  engine: string;
  buckets: UsageBucket[];
  queriedAt: string;   // ISO timestamp
  queriedFrom: string; // agent name used for the query
};

export type UsagePollerOptions = {
  db: Database;
  locks: LockManager;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_MS = 10 * 60 * 1000; // 10 minutes
const CAPTURE_DELAY_MS = 3000; // wait for /usage output to render

export class UsagePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly locks: LockManager;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly pollIntervalMs: number;
  private readonly usageData = new Map<string, EngineUsage>();

  constructor(opts: UsagePollerOptions) {
    this.db = opts.db;
    this.locks = opts.locks;
    this.proxyDispatch = opts.proxyDispatch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    console.log(`[usage] Starting poller (every ${Math.round(this.pollIntervalMs / 60000)}min)`);
    // Delay initial poll by 60s to let agents reach idle state after restart
    setTimeout(() => {
      this.pollAll().catch(err => console.error('[usage] Initial poll error:', err));
    }, 60_000);
    this.timer = setInterval(() => {
      this.pollAll().catch(err => console.error('[usage] Poll error:', err));
    }, this.pollIntervalMs);
  }

  /** Manually trigger a poll (e.g. from API). */
  async pollNow(): Promise<void> {
    await this.pollAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getUsageData(): Record<string, EngineUsage> {
    return Object.fromEntries(this.usageData);
  }

  private async pollAll(): Promise<void> {
    await this.pollClaude();
    await this.pollCodex();
  }

  /**
   * Find an idle Claude agent, paste /usage, capture output, parse it, dismiss with Escape.
   * Acquires the agent lock to prevent conflicts with message delivery.
   */
  private async pollClaude(): Promise<void> {
    const agents = this.db.listAgents().filter(
      a => a.engine === 'claude' && a.state === 'idle' && a.proxyId
    );
    if (agents.length === 0) return;

    // Pick the agent with lowest context to minimize disruption
    const agent = agents.reduce((best, a) =>
      (a.lastContextPct ?? 100) < (best.lastContextPct ?? 100) ? a : best
    );

    const session = sessionName(agent);
    const proxyId = agent.proxyId!;

    try {
      await this.locks.withLock(agent.name, async () => {
        // Paste /usage
        await this.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: session,
          text: '/usage',
          pressEnter: true,
        });

        await sleep(CAPTURE_DELAY_MS);

        // Capture output
        const result = await this.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: session,
          lines: 40,
        });

        if (!result.ok) return;
        const output = (result.data as string) ?? '';

        // Dismiss the /usage dialog
        await this.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: session,
          keys: 'Escape',
        });

        // Parse
        const buckets = parseClaudeUsage(output);
        if (buckets.length > 0) {
          this.usageData.set('claude', {
            engine: 'claude',
            buckets,
            queriedAt: new Date().toISOString(),
            queriedFrom: agent.name,
          });
          console.log(`[usage] Claude: ${buckets.map(b => `${b.label}: ${b.pctUsed}%`).join(', ')}`);
        }
      }, 10_000, 5_000); // 10s lock duration, 5s timeout
    } catch (err) {
      console.error(`[usage] Claude poll error for ${agent.name}:`, (err as Error).message);
    }
  }

  /**
   * Find an idle Codex agent, paste /status, capture output, parse it, dismiss with Escape.
   */
  private async pollCodex(): Promise<void> {
    const agents = this.db.listAgents().filter(
      a => a.engine === 'codex' && a.state === 'idle' && a.proxyId
    );
    if (agents.length === 0) return;

    const agent = agents.reduce((best, a) =>
      (a.lastContextPct ?? 100) < (best.lastContextPct ?? 100) ? a : best
    );

    const session = sessionName(agent);
    const proxyId = agent.proxyId!;

    try {
      await this.locks.withLock(agent.name, async () => {
        await this.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: session,
          text: '/status',
          pressEnter: true,
        });

        await sleep(CAPTURE_DELAY_MS);

        const result = await this.proxyDispatch(proxyId, {
          action: 'capture',
          sessionName: session,
          lines: 40,
        });

        if (!result.ok) return;
        const output = (result.data as string) ?? '';

        // Dismiss the /status dialog
        await this.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: session,
          keys: 'Escape',
        });

        const buckets = parseCodexStatus(output);
        if (buckets.length > 0) {
          this.usageData.set('codex', {
            engine: 'codex',
            buckets,
            queriedAt: new Date().toISOString(),
            queriedFrom: agent.name,
          });
          console.log(`[usage] Codex: ${buckets.map(b => `${b.label}: ${b.pctUsed}%`).join(', ')}`);
        }
      }, 10_000, 5_000);
    } catch (err) {
      console.error(`[usage] Codex poll error for ${agent.name}:`, (err as Error).message);
    }
  }
}

/**
 * Parse Claude /usage output. Format:
 *
 *   Current session
 *   ████▌                                              9% used
 *   Resets 12pm (America/Chicago)
 *
 *   Current week (all models)
 *   ███████████                                        22% used
 *   Resets Mar 13, 12am (America/Chicago)
 */
const PROGRESS_BAR_RE = /[█▌▊▋▍▎▏░]/;

export function parseClaudeUsage(output: string): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Match lines where "NN% used" appears alongside a progress bar
    const line = lines[i]!;
    const pctMatch = line.match(/(\d+)%\s+used/);
    if (!pctMatch) continue;

    // Require a progress bar on the same line or the line immediately above
    const hasBarOnLine = PROGRESS_BAR_RE.test(line);
    const hasBarAbove = i > 0 && PROGRESS_BAR_RE.test(lines[i - 1]!);
    if (!hasBarOnLine && !hasBarAbove) continue;

    const pctUsed = parseInt(pctMatch[1]!, 10);

    // Look backwards for the label (skip bar lines and blank lines)
    let label = '';
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j]!.trim();
      if (!l) continue;
      // Skip progress bar lines (contain block characters)
      if (/^[█▌▊▋▍▎▏\s░]+$/.test(l)) continue;
      // Skip lines that are just the percentage
      if (/^\d+%/.test(l)) continue;
      label = l;
      break;
    }

    // Look forwards for reset info
    let resetsAt = '';
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const resetMatch = lines[j]!.match(/Resets\s+(.+)/);
      if (resetMatch) {
        resetsAt = resetMatch[1]!.trim();
        break;
      }
    }

    buckets.push({ label: label || 'Unknown', pctUsed, resetsAt });
  }

  return buckets;
}

/**
 * Parse Codex /status output. Looks for percentage patterns like:
 *   NN% used  or  NN% remaining / NN% left
 * Falls back to generic percentage extraction.
 */
export function parseCodexStatus(output: string): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Match "NN% used"
    const usedMatch = line.match(/(\d+)%\s+used/);
    if (usedMatch) {
      const pctUsed = parseInt(usedMatch[1]!, 10);
      const label = findLabelAbove(lines, i);
      const resetsAt = findResetBelow(lines, i);
      buckets.push({ label: label || 'Unknown', pctUsed, resetsAt });
      continue;
    }

    // Match "NN% remaining" or "NN% left" (convert to used)
    const remainMatch = line.match(/(\d+)%\s+(?:remaining|left)/);
    if (remainMatch) {
      const pctUsed = 100 - parseInt(remainMatch[1]!, 10);
      const label = findLabelAbove(lines, i);
      const resetsAt = findResetBelow(lines, i);
      buckets.push({ label: label || 'Unknown', pctUsed, resetsAt });
    }
  }

  return buckets;
}

function findLabelAbove(lines: string[], idx: number): string {
  for (let j = idx - 1; j >= 0; j--) {
    const line = lines[j]!.trim();
    if (!line) continue;
    if (/^[█▌▊▋▍▎▏\s░]+$/.test(line)) continue;
    if (/^\d+%/.test(line)) continue;
    return line;
  }
  return '';
}

function findResetBelow(lines: string[], idx: number): string {
  for (let j = idx + 1; j < Math.min(idx + 3, lines.length); j++) {
    const resetMatch = lines[j]!.match(/[Rr]esets?\s+(.+)/);
    if (resetMatch) return resetMatch[1]!.trim();
  }
  return '';
}
