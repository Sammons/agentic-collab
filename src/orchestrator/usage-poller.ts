/**
 * Engine usage poller.
 * Spawns dedicated tmux sessions per engine (usage-claude, usage-codex)
 * to query account-level usage data without disrupting real agents.
 *
 * Sessions are hidden from the dashboard — they don't appear in the agents table.
 * Results are stored in memory and exposed via getUsageData().
 */

import type { Database } from './database.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';
import type { AccountStore } from './accounts.ts';
import { getAdapter } from './adapters/index.ts';
import { sleep } from '../shared/utils.ts';

export type UsageBucket = {
  label: string;       // e.g. "Current session", "Current week (all models)"
  pctUsed: number;     // 0-100
  resetsAt: string;    // e.g. "Mar 13, 12am (America/Chicago)"
};

export type EngineUsage = {
  engine: string;
  account?: string;    // account name (undefined = default/host credentials)
  buckets: UsageBucket[];
  queriedAt: string;   // ISO timestamp
  queriedFrom: string; // session name used for the query
};

export type UsagePollerOptions = {
  db: Database;
  proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  accountStore?: AccountStore;
  pollIntervalMs?: number;
  cwd?: string;
};

const DEFAULT_POLL_MS = 10 * 60 * 1000; // 10 minutes
const CAPTURE_POLL_MS = 2000; // interval between capture attempts
const CAPTURE_TIMEOUT_MS = 30_000; // max time to wait for usage data to load
const SESSION_BOOT_MS = 5_000; // time to wait for CLI to boot after spawn
const SESSION_PREFIX = 'usage-';
const RECYCLE_MS = 8 * 60 * 60 * 1000; // 8 hours — kill and recreate stale sessions

type EngineConfig = {
  engine: 'claude' | 'codex';
  account?: string;        // account name if per-account usage
  accountHome?: string;    // scaffolded HOME path for account isolation
  sessionName: string;
  spawnCommand: string;
  usageCommand: string;
  parser: (output: string) => UsageBucket[];
};

export class UsagePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Database;
  private readonly proxyDispatch: (proxyId: string, command: ProxyCommand) => Promise<ProxyResponse>;
  private readonly accountStore: AccountStore | undefined;
  private readonly pollIntervalMs: number;
  private readonly cwd: string;
  private readonly usageData = new Map<string, EngineUsage>();
  // Track which sessions are booted to avoid re-spawning every cycle
  private readonly activeSessions = new Set<string>();
  // Track when each session was created for recycling
  private readonly sessionCreatedAt = new Map<string, number>();

  constructor(opts: UsagePollerOptions) {
    this.db = opts.db;
    this.proxyDispatch = opts.proxyDispatch;
    this.accountStore = opts.accountStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.cwd = opts.cwd ?? '/tmp';
  }

  start(): void {
    if (this.timer) return;
    console.log(`[usage] Starting poller (every ${Math.round(this.pollIntervalMs / 60000)}min, dedicated sessions)`);
    // Delay initial poll to let proxies register after restart
    setTimeout(() => {
      this.pollAll().catch(err => console.error('[usage] Initial poll error:', err));
    }, 30_000);
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

  /** Tear down dedicated sessions on shutdown. */
  async cleanup(): Promise<void> {
    const proxyId = this.findProxy();
    if (!proxyId) return;
    for (const session of this.activeSessions) {
      try {
        await this.proxyDispatch(proxyId, { action: 'kill_session', sessionName: session });
        console.log(`[usage] Killed session ${session}`);
      } catch { /* best effort */ }
    }
    this.activeSessions.clear();
    this.sessionCreatedAt.clear();
  }

  getUsageData(): Record<string, EngineUsage> {
    return Object.fromEntries(this.usageData);
  }

  private findProxy(): string | null {
    const proxies = this.db.listProxies();
    return proxies.length > 0 ? proxies[0]!.proxyId : null;
  }

  private getEngineConfigs(): EngineConfig[] {
    const agents = this.db.listAgents();
    const configs: EngineConfig[] = [];
    const claudeAdapter = getAdapter('claude');

    // Collect unique accounts used by Claude agents
    const claudeAccounts = new Set<string>();
    for (const a of agents) {
      if (a.engine === 'claude') {
        claudeAccounts.add(a.account ?? 'default');
      }
    }

    // Create one usage session per Claude account
    for (const accountName of claudeAccounts) {
      const suffix = accountName === 'default' ? 'claude' : `claude-${accountName}`;
      let accountHome: string | undefined;
      if (accountName !== 'default' && this.accountStore) {
        accountHome = this.accountStore.scaffoldAgentHome(`usage-${suffix}`, accountName) ?? undefined;
      }
      configs.push({
        engine: 'claude',
        account: accountName,
        accountHome,
        sessionName: `${SESSION_PREFIX}${suffix}`,
        spawnCommand: claudeAdapter.buildSpawnCommand({
          name: `usage-${suffix}`,
          cwd: this.cwd,
          dangerouslySkipPermissions: true,
        }),
        usageCommand: '/usage',
        parser: parseClaudeUsage,
      });
    }

    const hasCodex = agents.some(a => a.engine === 'codex');
    if (hasCodex) {
      const adapter = getAdapter('codex');
      configs.push({
        engine: 'codex',
        sessionName: `${SESSION_PREFIX}codex`,
        spawnCommand: adapter.buildSpawnCommand({
          name: 'usage-codex',
          cwd: this.cwd,
          dangerouslySkipPermissions: true,
        }),
        usageCommand: '/status',
        parser: parseCodexStatus,
      });
    }

    return configs;
  }

  private async pollAll(): Promise<void> {
    const proxyId = this.findProxy();
    if (!proxyId) {
      console.warn('[usage] No proxy available, skipping poll');
      return;
    }

    const configs = this.getEngineConfigs();
    for (const config of configs) {
      try {
        await this.pollEngine(proxyId, config);
      } catch (err) {
        console.error(`[usage] ${config.engine} poll error:`, (err as Error).message);
      }
    }
  }

  /**
   * Ensure the dedicated session exists and is responsive, then query usage.
   */
  private async pollEngine(proxyId: string, config: EngineConfig): Promise<void> {
    // Recycle session if older than 8 hours
    await this.recycleIfStale(proxyId, config);

    // Ensure session exists
    await this.ensureSession(proxyId, config);

    // Check if the CLI is at a prompt (idle)
    const ready = await this.waitForIdle(proxyId, config);
    if (!ready) {
      console.warn(`[usage] ${config.engine} session not ready, skipping`);
      return;
    }

    // Send usage command
    await this.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: config.sessionName,
      text: config.usageCommand,
      pressEnter: true,
    });

    // Poll capture until we see usage data or timeout
    let buckets: UsageBucket[] = [];
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(CAPTURE_POLL_MS);

      const result = await this.proxyDispatch(proxyId, {
        action: 'capture',
        sessionName: config.sessionName,
        lines: 40,
      });
      if (!result.ok) break;
      const output = (result.data as string) ?? '';

      buckets = config.parser(output);
      if (buckets.length > 0) break;

      // Claude-specific: stop if dialog was dismissed without data
      if (config.engine === 'claude') {
        if (/Status dialog dismissed|Error loading/i.test(output) && !/Loading usage/i.test(output)) break;
      }
    }

    // Dismiss dialog
    await this.proxyDispatch(proxyId, {
      action: 'send_keys',
      sessionName: config.sessionName,
      keys: 'Escape',
    });

    if (buckets.length > 0) {
      // Key by engine:account for per-account usage, or just engine for non-account
      const key = config.account && config.account !== 'default'
        ? `${config.engine}:${config.account}` : config.engine;
      const label = config.account ? `${config.engine}:${config.account}` : config.engine;
      this.usageData.set(key, {
        engine: config.engine,
        account: config.account,
        buckets,
        queriedAt: new Date().toISOString(),
        queriedFrom: config.sessionName,
      });
      console.log(`[usage] ${label}: ${buckets.map(b => `${b.label}: ${b.pctUsed}%`).join(', ')}`);
    } else {
      const label = config.account ? `${config.engine}:${config.account}` : config.engine;
      console.warn(`[usage] ${label}: no usage data found within ${CAPTURE_TIMEOUT_MS / 1000}s`);
    }
  }

  /**
   * Ensure the dedicated tmux session exists with the CLI running.
   * Creates and spawns if needed.
   */
  private async ensureSession(proxyId: string, config: EngineConfig): Promise<void> {
    // Check if session exists
    const hasResult = await this.proxyDispatch(proxyId, {
      action: 'has_session',
      sessionName: config.sessionName,
    });

    if (hasResult.ok && hasResult.data === true) {
      return; // Session already running
    }

    // Create session and spawn CLI
    const label = config.account ? `${config.engine}:${config.account}` : config.engine;
    console.log(`[usage] Spawning dedicated ${label} session: ${config.sessionName}`);
    await this.proxyDispatch(proxyId, {
      action: 'create_session',
      sessionName: config.sessionName,
      cwd: this.cwd,
    });

    // Inject HOME override for account-isolated credential usage
    const cmd = config.accountHome
      ? `export HOME=${config.accountHome} && ${config.spawnCommand}`
      : config.spawnCommand;

    await this.proxyDispatch(proxyId, {
      action: 'paste',
      sessionName: config.sessionName,
      text: cmd,
      pressEnter: true,
    });

    this.activeSessions.add(config.sessionName);
    this.sessionCreatedAt.set(config.sessionName, Date.now());

    // Wait for CLI to boot
    await sleep(SESSION_BOOT_MS);
  }

  /**
   * Kill and forget a session if it was created more than RECYCLE_MS ago.
   * The next ensureSession() call will recreate it fresh.
   */
  private async recycleIfStale(proxyId: string, config: EngineConfig): Promise<void> {
    const createdAt = this.sessionCreatedAt.get(config.sessionName);
    // If we have no timestamp but the session exists in tmux, it predates this
    // process (e.g. survived an orchestrator restart). Kill it unconditionally.
    const isOrphan = !createdAt && this.activeSessions.has(config.sessionName);
    const isStale = createdAt != null && (Date.now() - createdAt) >= RECYCLE_MS;

    if (!isOrphan && !isStale) {
      // Also check for sessions that exist in tmux but aren't tracked by us
      if (createdAt == null && !this.activeSessions.has(config.sessionName)) {
        const hasResult = await this.proxyDispatch(proxyId, {
          action: 'has_session',
          sessionName: config.sessionName,
        });
        if (hasResult.ok && hasResult.data === true) {
          // Untracked session from a previous process — kill it
          console.log(`[usage] Recycling untracked session ${config.sessionName}`);
          try {
            await this.proxyDispatch(proxyId, { action: 'kill_session', sessionName: config.sessionName });
          } catch { /* best effort */ }
          return;
        }
      }
      return;
    }

    console.log(`[usage] Recycling ${isOrphan ? 'orphaned' : 'stale'} session ${config.sessionName} (age: ${createdAt ? Math.round((Date.now() - createdAt) / 3600000) + 'h' : 'unknown'})`);
    try {
      await this.proxyDispatch(proxyId, { action: 'kill_session', sessionName: config.sessionName });
    } catch { /* best effort */ }
    this.activeSessions.delete(config.sessionName);
    this.sessionCreatedAt.delete(config.sessionName);
  }

  /**
   * Wait for the CLI in the session to be idle (showing a prompt).
   * Handles startup dialogs (e.g. folder trust confirmation) automatically.
   * Returns true if idle, false if timed out.
   */
  private async waitForIdle(proxyId: string, config: EngineConfig): Promise<boolean> {
    const adapter = getAdapter(config.engine);
    const deadline = Date.now() + 20_000; // 20s max wait for idle

    while (Date.now() < deadline) {
      const result = await this.proxyDispatch(proxyId, {
        action: 'capture',
        sessionName: config.sessionName,
        lines: 20,
      });
      if (!result.ok) return false;
      const output = (result.data as string) ?? '';

      // Handle Claude's folder trust dialog ("Yes, I trust this folder")
      if (/I trust this folder|Enter to confirm/i.test(output)) {
        await this.proxyDispatch(proxyId, {
          action: 'send_keys',
          sessionName: config.sessionName,
          keys: 'Enter',
        });
        await sleep(3000);
        continue;
      }

      // Handle Codex update prompt ("Update available! ... Press enter to continue")
      if (/Update available.*Skip/s.test(output)) {
        console.log(`[usage] Dismissing Codex update dialog for ${config.sessionName}`);
        // Select "2. Skip"
        await this.proxyDispatch(proxyId, {
          action: 'paste',
          sessionName: config.sessionName,
          text: '2',
          pressEnter: true,
        });
        await sleep(3000);
        continue;
      }

      const state = adapter.detectIdleState(output);
      if (state === 'waiting_for_input') return true;

      await sleep(2000);
    }

    return false;
  }
}

/**
 * Parse Claude /usage output.
 *
 * Old format (v2.0.x):
 *   Current session
 *   ████▌                                              9% used
 *   Resets 12pm (America/Chicago)
 *
 * New format (v2.1.x):
 *   Current week (all models)
 *   Resets Apr 21, 8pm (America/Chicago)               26% used
 *
 * Extra usage format:
 *   Extra usage
 *   $189.67 / $200.00 spent · Resets May 1 (America/Chicago)
 */
const PROGRESS_BAR_RE = /[█▌▊▋▍▎▏░]/;

export function parseClaudeUsage(output: string): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  const seen = new Set<string>();
  const lines = output.split('\n');

  // Valid usage category labels (whitelist approach - more robust than blacklisting UI chrome)
  // Must start with "Current" to avoid matching logo lines like "Opus 4.6 (1M context)"
  const isValidLabel = (s: string) =>
    /^Current\s+(session|week|day)/i.test(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Match "NN% used" lines (both old and new format)
    const pctMatch = line.match(/(\d+)%\s+used/);
    if (pctMatch) {
      const pctUsed = parseInt(pctMatch[1]!, 10);

      // New format: "Resets ... NN% used" on same line
      const resetOnLine = line.match(/Resets\s+([^%]+?)\s+\d+%/);
      if (resetOnLine) {
        // Look backwards for valid usage label
        let label = '';
        for (let j = i - 1; j >= 0; j--) {
          const l = lines[j]!.trim();
          if (!l) continue;
          if (isValidLabel(l)) {
            label = l;
            break;
          }
        }
        if (label && !seen.has(label)) {
          seen.add(label);
          buckets.push({ label, pctUsed, resetsAt: resetOnLine[1]!.trim() });
        }
        continue;
      }

      // Old format: progress bar on same line or line above, reset info below
      const hasBarOnLine = PROGRESS_BAR_RE.test(line);
      const hasBarAbove = i > 0 && PROGRESS_BAR_RE.test(lines[i - 1]!);
      if (hasBarOnLine || hasBarAbove) {
        let label = '';
        for (let j = i - 1; j >= 0; j--) {
          const l = lines[j]!.trim();
          if (!l) continue;
          if (/^[█▌▊▋▍▎▏\s░]+$/.test(l)) continue;
          if (/^\d+%/.test(l)) continue;
          if (isValidLabel(l)) {
            label = l;
            break;
          }
        }
        let resetsAt = '';
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const resetMatch = lines[j]!.match(/Resets\s+(.+)/);
          if (resetMatch) {
            resetsAt = resetMatch[1]!.trim();
            break;
          }
        }
        if (label && !seen.has(label)) {
          seen.add(label);
          buckets.push({ label, pctUsed, resetsAt });
        }
      }
      continue;
    }

    // Extra usage format: "$X / $Y spent · Resets ..."
    const extraMatch = line.match(/\$[\d.]+\s*\/\s*\$([\d.]+)\s+spent.*Resets\s+(.+)/);
    if (extraMatch && !seen.has('Extra usage')) {
      seen.add('Extra usage');
      const limit = parseFloat(extraMatch[1]!);
      const spentMatch = line.match(/\$([\d.]+)\s*\//);
      const spent = spentMatch ? parseFloat(spentMatch[1]!) : 0;
      const pctUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      buckets.push({ label: 'Extra usage', pctUsed, resetsAt: extraMatch[2]!.trim() });
    }
  }

  return buckets;
}

/**
 * Parse Codex /status output.
 * Real format (after stripping │ borders):
 *   5h limit:             [████████████████░░░░] 80% left (resets 12:19)
 *   Weekly limit:         [█████░░░░░░░░░░░░░░░] 26% left (resets 01:44 on 13 Mar)
 */
export function parseCodexStatus(output: string): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  // Match lines with: <label>: ... NN% left/used (resets ...)
  // The label must contain a colon, followed by optional progress bar, then percentage
  const lineRe = /^\s*([A-Za-z0-9][A-Za-z0-9 ]*?\s*\w+)\s*:\s+.*?(\d+)%\s+(left|used)(?:\s*\(resets?\s+(.+?)\))?\s*$/;

  for (const rawLine of output.split('\n')) {
    // Strip box-drawing borders (│ ╭ ╰ ─ etc.)
    const line = rawLine.replace(/[│┃╭╮╰╯─]/g, '').trim();
    if (!line) continue;

    const m = line.match(lineRe);
    if (!m) continue;

    const label = m[1]!.trim();
    const pct = parseInt(m[2]!, 10);
    const direction = m[3]!;
    const resetsAt = m[4]?.trim() ?? '';
    const pctUsed = direction === 'left' ? 100 - pct : pct;

    buckets.push({ label, pctUsed, resetsAt });
  }

  return buckets;
}
