/**
 * Account store for per-agent credential isolation.
 *
 * Each named account has its own directory under ACCOUNTS_DIR containing
 * copies of Claude Code credential files. At spawn time, an agent with
 * an `account` field gets an isolated HOME directory where `.claude/`
 * contains that account's credentials, and everything else symlinks to
 * the real HOME.
 *
 * Storage layout:
 *   ACCOUNTS_DIR/
 *     {account-name}/
 *       credentials.json   — copy of .claude/.credentials.json
 *       config.json         — copy of .claude.json (oauthAccount section)
 *
 * Agent HOME layout (created per-spawn):
 *   AGENT_HOMES_DIR/
 *     {agent-name}/
 *       .claude/
 *         .credentials.json  — from account store
 *         settings.json      — symlink to real
 *         ...other dirs      — symlinks to real
 *       .claude.json          — from account store
 *       ...everything else    — symlinks to real HOME
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Use the same base directory as the DB (HOME/.agentic-collab/) so accounts
// live inside the Docker volume alongside the SQLite database.
const DATA_BASE = join(process.env['HOME'] ?? '/root', '.agentic-collab');

const DEFAULT_ACCOUNTS_DIR = join(DATA_BASE, 'accounts');
const DEFAULT_AGENT_HOMES_DIR = join(DATA_BASE, 'agent-homes');

export type AccountInfo = {
  name: string;
  email: string | null;
  hasCredentials: boolean;
  hasConfig: boolean;
};

export class AccountStore {
  readonly accountsDir: string;
  readonly agentHomesDir: string;

  constructor(opts?: { accountsDir?: string; agentHomesDir?: string; skipAutoRegister?: boolean }) {
    this.accountsDir = opts?.accountsDir ?? DEFAULT_ACCOUNTS_DIR;
    this.agentHomesDir = opts?.agentHomesDir ?? DEFAULT_AGENT_HOMES_DIR;
    mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.agentHomesDir, { recursive: true, mode: 0o700 });

    // Auto-register the host's current credentials as "default" if no accounts exist
    if (!opts?.skipAutoRegister && this.list().length === 0) {
      try {
        this.registerFromCurrent('default');
        console.log('[accounts] Auto-registered default account from host credentials');
      } catch {
        // No credentials on host — skip silently
      }
    }
  }

  /** List all registered accounts. */
  list(): AccountInfo[] {
    if (!existsSync(this.accountsDir)) return [];
    return readdirSync(this.accountsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => this.getAccountInfo(d.name))
      .filter((a): a is AccountInfo => a !== null);
  }

  /** Get info about a single account. */
  getAccountInfo(name: string): AccountInfo | null {
    const dir = join(this.accountsDir, name);
    if (!existsSync(dir)) return null;

    const credsPath = join(dir, 'credentials.json');
    const configPath = join(dir, 'config.json');
    const hasCredentials = existsSync(credsPath);
    const hasConfig = existsSync(configPath);

    let email: string | null = null;
    if (hasConfig) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        email = config.oauthAccount?.emailAddress ?? null;
      } catch { /* ignore parse errors */ }
    }

    return { name, email, hasCredentials, hasConfig };
  }

  /**
   * Register an account by capturing current Claude Code credentials.
   * Reads from the real HOME's .claude/.credentials.json and .claude.json.
   */
  registerFromCurrent(accountName: string): AccountInfo {
    const realHome = process.env['HOME'] ?? '/root';
    const credsSource = join(realHome, '.claude', '.credentials.json');
    const configSource = join(realHome, '.claude.json');

    if (!existsSync(credsSource)) {
      throw new Error(`No credentials found at ${credsSource}. Is Claude Code logged in?`);
    }

    const dir = join(this.accountsDir, accountName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Copy credentials
    const credsData = readFileSync(credsSource, 'utf-8');
    writeFileSync(join(dir, 'credentials.json'), credsData, { mode: 0o600 });

    // Copy config (extract just oauthAccount to keep it small)
    if (existsSync(configSource)) {
      try {
        const fullConfig = JSON.parse(readFileSync(configSource, 'utf-8'));
        const subset = { oauthAccount: fullConfig.oauthAccount };
        writeFileSync(join(dir, 'config.json'), JSON.stringify(subset, null, 2), { mode: 0o600 });
      } catch {
        // Config is optional — credentials alone are enough
      }
    }

    return this.getAccountInfo(accountName)!;
  }

  /** Remove a registered account. */
  remove(accountName: string): boolean {
    const dir = join(this.accountsDir, accountName);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Scaffold an isolated HOME directory for an agent using a named account.
   * Returns the path to the isolated HOME, or null if the account doesn't exist.
   *
   * The isolated HOME contains:
   * - .claude/ with account credentials + symlinks to real .claude/ subdirs
   * - .claude.json with account config (oauthAccount swapped in)
   * - Symlinks to everything else in real HOME
   */
  scaffoldAgentHome(agentName: string, accountName: string): string | null {
    const account = this.getAccountInfo(accountName);
    if (!account || !account.hasCredentials) return null;

    const realHome = process.env['HOME'] ?? '/root';
    const agentHome = join(this.agentHomesDir, agentName);
    const agentClaudeDir = join(agentHome, '.claude');

    // Clean up previous scaffold
    if (existsSync(agentHome)) {
      rmSync(agentHome, { recursive: true, force: true });
    }

    mkdirSync(agentHome, { recursive: true, mode: 0o700 });
    mkdirSync(agentClaudeDir, { recursive: true, mode: 0o700 });

    // 1. Copy account credentials into .claude/
    const accountDir = join(this.accountsDir, accountName);
    const credsSource = join(accountDir, 'credentials.json');
    writeFileSync(
      join(agentClaudeDir, '.credentials.json'),
      readFileSync(credsSource, 'utf-8'),
      { mode: 0o600 },
    );

    // 2. Build .claude.json with swapped oauthAccount
    const realConfigPath = join(realHome, '.claude.json');
    if (existsSync(realConfigPath)) {
      try {
        const realConfig = JSON.parse(readFileSync(realConfigPath, 'utf-8'));
        const accountConfigPath = join(accountDir, 'config.json');
        if (existsSync(accountConfigPath)) {
          const accountConfig = JSON.parse(readFileSync(accountConfigPath, 'utf-8'));
          realConfig.oauthAccount = accountConfig.oauthAccount;
        }
        writeFileSync(
          join(agentHome, '.claude.json'),
          JSON.stringify(realConfig, null, 2),
          { mode: 0o600 },
        );
      } catch {
        // Fallback: just copy real config
        symlinkSync(realConfigPath, join(agentHome, '.claude.json'));
      }
    }

    // 3. Symlink .claude/ subdirectories (settings, cache, sessions, etc.)
    const realClaudeDir = join(realHome, '.claude');
    if (existsSync(realClaudeDir)) {
      for (const entry of readdirSync(realClaudeDir, { withFileTypes: true })) {
        // Skip the credentials file — we provided our own
        if (entry.name === '.credentials.json') continue;
        const target = join(agentClaudeDir, entry.name);
        if (!existsSync(target)) {
          symlinkSync(join(realClaudeDir, entry.name), target);
        }
      }
    }

    // 4. Symlink everything else from real HOME (except .claude/ and .claude.json)
    const skipSet = new Set(['.claude', '.claude.json']);
    for (const entry of readdirSync(realHome, { withFileTypes: true })) {
      if (skipSet.has(entry.name)) continue;
      const target = join(agentHome, entry.name);
      if (!existsSync(target)) {
        try {
          symlinkSync(join(realHome, entry.name), target);
        } catch {
          // Skip entries that can't be symlinked (e.g., special files)
        }
      }
    }

    return agentHome;
  }

  /** Clean up an agent's isolated HOME directory. */
  cleanupAgentHome(agentName: string): void {
    const agentHome = join(this.agentHomesDir, agentName);
    if (existsSync(agentHome)) {
      rmSync(agentHome, { recursive: true, force: true });
    }
  }
}
