/**
 * Shared configuration helpers for secret management and auto-discovery.
 * Used by both orchestrator and proxy to resolve the shared secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const CONFIG_DIR = process.env['AGENTIC_COLLAB_CONFIG_DIR']
  ?? join(homedir(), '.config', 'agentic-collab');
const SECRET_FILENAME = 'secret';

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getSecretPath(): string {
  return join(CONFIG_DIR, SECRET_FILENAME);
}

/**
 * Resolve the orchestrator secret using the priority chain:
 * 1. ORCHESTRATOR_SECRET env var (explicit)
 * 2. ORCHESTRATOR_SECRET_FILE env var (file path override)
 * 3. ~/.config/agentic-collab/secret (default file)
 * 4. null (no auth)
 */
export function resolveSecret(opts?: { create?: boolean }): string | null {
  // 1. Explicit env var
  const envSecret = process.env['ORCHESTRATOR_SECRET'];
  if (envSecret) return envSecret;

  // 2. File path override
  const secretFile = process.env['ORCHESTRATOR_SECRET_FILE'];
  if (secretFile) {
    try {
      return readFileSync(secretFile, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  // 3. Default file
  const defaultPath = getSecretPath();
  try {
    const content = readFileSync(defaultPath, 'utf-8').trim();
    if (content) return content;
  } catch {
    // File doesn't exist
  }

  // 4. Create if requested
  if (opts?.create) {
    return createSecret();
  }

  return null;
}

/**
 * Generate and persist a new secret to the default path.
 */
export function createSecret(): string {
  const secret = randomBytes(32).toString('base64url');
  const secretPath = getSecretPath();
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  return secret;
}

/**
 * Check if the secret file exists.
 */
export function secretFileExists(): boolean {
  return existsSync(getSecretPath());
}

/**
 * Watch for the secret file to appear. Resolves when the file exists and contains a secret.
 * Times out after maxWaitMs (default: no timeout — waits indefinitely).
 */
export function waitForSecret(opts?: { maxWaitMs?: number; pollMs?: number }): Promise<string> {
  const pollMs = opts?.pollMs ?? 2000;

  return new Promise((resolve, reject) => {
    // Check immediately
    const existing = resolveSecret();
    if (existing) { resolve(existing); return; }

    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      if (resolved) return;
      const secret = resolveSecret();
      if (secret) {
        resolved = true;
        if (timer) clearTimeout(timer);
        clearInterval(interval);
        resolve(secret);
      }
    };

    const interval = setInterval(check, pollMs);

    // Also watch the config dir for file creation
    const secretPath = getSecretPath();
    mkdirSync(dirname(secretPath), { recursive: true });

    if (opts?.maxWaitMs) {
      timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(interval);
          reject(new Error(`Secret file did not appear within ${opts.maxWaitMs}ms`));
        }
      }, opts.maxWaitMs);
    }
  });
}

// ── Docker Discovery ──

export interface DiscoveredOrchestrator {
  url: string;
  fromDocker: boolean;
}

/**
 * Try to discover the orchestrator URL:
 * 1. ORCHESTRATOR_URL env var
 * 2. Docker container with agentic-collab label
 * 3. Localhost fallback (try common ports)
 */
export async function discoverOrchestrator(): Promise<DiscoveredOrchestrator | null> {
  // 1. Explicit env var
  const envUrl = process.env['ORCHESTRATOR_URL'];
  if (envUrl) return { url: envUrl, fromDocker: false };

  // 2. Docker discovery
  const dockerUrl = discoverViaDocker();
  if (dockerUrl) {
    const alive = await probeOrchestrator(dockerUrl);
    if (alive) return { url: dockerUrl, fromDocker: true };
  }

  // 3. Localhost fallback
  for (const port of [3000, 3001]) {
    const url = `http://localhost:${port}`;
    const alive = await probeOrchestrator(url);
    if (alive) return { url, fromDocker: false };
  }

  return null;
}

/**
 * Use `docker ps` to find the orchestrator container by label.
 */
function discoverViaDocker(): string | null {
  if (!hasDocker()) return null;
  try {
    const raw = execSync(
      'docker ps --filter "label=io.agentic-collab.role=orchestrator" --format "{{.Ports}}"',
      { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    if (!raw) return null;
    const port = parsePortMapping(raw);
    if (port) return `http://localhost:${port}`;
  } catch { /* Docker not available or failed */ }
  return null;
}

/**
 * Check if docker CLI is available.
 */
export function hasDocker(): boolean {
  try {
    execSync('docker --version', { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse Docker port mapping string like "0.0.0.0:3000->3000/tcp" to extract host port.
 */
export function parsePortMapping(ports: string): number | null {
  // Format: "0.0.0.0:3000->3000/tcp, :::3000->3000/tcp"
  // We want the first host port
  const match = ports.match(/(?:\d+\.\d+\.\d+\.\d+|::):(\d+)->/);
  if (match) return parseInt(match[1]!, 10);
  return null;
}

/**
 * Probe an orchestrator URL to see if it's alive.
 */
async function probeOrchestrator(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/orchestrator/status`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
