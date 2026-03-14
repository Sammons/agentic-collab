/**
 * Tmux proxy service. Runs on the host outside Docker.
 * Registers with the orchestrator, receives commands, executes tmux operations.
 * Heartbeats every 15s. Re-registers on missed heartbeat.
 *
 * Auto-discovery: finds the orchestrator via Docker labels or localhost fallback.
 * Secret: reads from env, file, or ~/.config/agentic-collab/secret (waits if missing).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream, existsSync, realpathSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { generateToken } from '../shared/sanitize.ts';
import { resolveSecret, waitForSecret, discoverOrchestrator, getSecretPath, hasDocker } from '../shared/config.ts';
import { getVersion } from '../shared/version.ts';
import * as tmux from './tmux.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

// Ensure the collab CLI (bin/collab) is on PATH for spawned tmux sessions.
// The proxy lives at src/proxy/main.ts, so bin/ is ../../bin relative to here.
const collabBinDir = join(import.meta.dirname, '..', '..', 'bin');
if (existsSync(join(collabBinDir, 'collab')) && !process.env['PATH']?.split(':').includes(collabBinDir)) {
  process.env['PATH'] = `${collabBinDir}:${process.env['PATH'] ?? ''}`;
}

const PROXY_PORT = parseInt(process.env['PROXY_PORT'] ?? '3100', 10);
const PROXY_HOST = process.env['PROXY_HOST'] ?? `host.docker.internal:${PROXY_PORT}`;
const PROXY_ID = process.env['PROXY_ID'] ?? hostname();

let orchestratorUrl = '';
let orchestratorSecret: string | null = null;
let token = generateToken();
const proxyVersion = getVersion();
let registered = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (orchestratorSecret) {
    headers['authorization'] = `Bearer ${orchestratorSecret}`;
  }
  return headers;
}

// ── Registration ──

async function register(): Promise<void> {
  try {
    const resp = await fetch(`${orchestratorUrl}/api/proxy/register`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ proxyId: PROXY_ID, token, host: PROXY_HOST, version: proxyVersion }),
    });

    if (resp.ok) {
      registered = true;
      const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const versionMatch = data['versionMatch'] as boolean | undefined;
      if (versionMatch === false) {
        console.warn(`[proxy] ⚠ Version mismatch: proxy is ${proxyVersion}, orchestrator is ${data['orchestratorVersion'] ?? 'unknown'}. Restart proxy to update.`);
      } else {
        console.log(`[proxy] Registered with orchestrator as "${PROXY_ID}" (version: ${proxyVersion})`);
      }
    } else {
      console.error(`[proxy] Registration failed: ${resp.status} ${await resp.text()}`);
      registered = false;
    }
  } catch (err) {
    console.error(`[proxy] Registration error: ${(err as Error).message}`);
    registered = false;
  }
}

async function heartbeat(): Promise<void> {
  try {
    const resp = await fetch(`${orchestratorUrl}/api/proxy/heartbeat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ proxyId: PROXY_ID }),
    });

    if (!resp.ok) {
      console.warn(`[proxy] Heartbeat rejected (${resp.status}), re-registering...`);
      token = generateToken();
      await register();
    }
  } catch {
    console.warn(`[proxy] Heartbeat failed, attempting re-register...`);
    try {
      token = generateToken();
      await register();
    } catch (err) {
      console.warn(`[proxy] Re-register failed:`, (err as Error).message);
    }
  }
}

async function deregister(): Promise<void> {
  try {
    await fetch(`${orchestratorUrl}/api/proxy/${PROXY_ID}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    console.log('[proxy] Deregistered from orchestrator');
  } catch {
    // Best effort
  }
}

// ── Codex Profile Management ──

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

/**
 * Write or update a Codex profile in ~/.codex/config.toml.
 *
 * Uses TOML triple-quoted strings ("""...""") for developer_instructions,
 * which handle ALL special characters (backticks, $, !, quotes) with no
 * shell escaping needed. The only character that needs handling is three
 * consecutive double quotes in the content itself.
 */
function writeCodexProfile(profileName: string, developerInstructions: string): void {
  // Validate profile name (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  // Escape the only problematic sequence in TOML triple-quoted strings: """
  const safeInstructions = developerInstructions.replace(/"""/g, '""\\u0022');

  const profileHeader = `[profiles.${profileName}]`;
  const profileBlock = `${profileHeader}\ndeveloper_instructions = """\n${safeInstructions}\n"""\n`;

  // Read existing config (or start with empty)
  const configDir = dirname(CODEX_CONFIG_PATH);
  mkdirSync(configDir, { recursive: true });

  let config = '';
  try {
    config = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  // Remove any existing profile section for this agent.
  // Match from [profiles.<name>] to the next [section] header or end of file.
  const profileRegex = new RegExp(
    `\\[profiles\\.${profileName}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
  );
  config = config.replace(profileRegex, '').replace(/\n{3,}/g, '\n\n');

  // Append new profile
  config = config.trimEnd() + '\n\n' + profileBlock;

  writeFileSync(CODEX_CONFIG_PATH, config, 'utf-8');
}

/**
 * Remove a Codex profile from ~/.codex/config.toml.
 * Called on agent destroy to prevent stale profiles accumulating.
 */
function removeCodexProfile(profileName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  let config = '';
  try {
    config = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  } catch {
    return; // No config file — nothing to remove
  }

  const profileRegex = new RegExp(
    `\\[profiles\\.${profileName}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
  );
  const cleaned = config.replace(profileRegex, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  writeFileSync(CODEX_CONFIG_PATH, cleaned, 'utf-8');
}

// ── Command Execution ──

async function executeCommand(command: ProxyCommand): Promise<ProxyResponse> {
  try {
    switch (command.action) {
      case 'create_session':
        tmux.createSession(command.sessionName, command.cwd);
        return { ok: true };

      case 'paste':
        await tmux.pasteText(command.sessionName, command.text, command.pressEnter);
        return { ok: true };

      case 'capture': {
        const output = tmux.capturePaneLines(command.sessionName, command.lines);
        return { ok: true, data: output };
      }

      case 'kill_session':
        tmux.killSession(command.sessionName);
        return { ok: true };

      case 'list_sessions': {
        const sessions = tmux.listSessions();
        return { ok: true, data: sessions };
      }

      case 'has_session': {
        const exists = tmux.hasSession(command.sessionName);
        return { ok: true, data: exists };
      }

      case 'pane_activity': {
        const activity = tmux.paneActivity(command.sessionName);
        return { ok: true, data: activity };
      }

      case 'send_keys':
        tmux.sendKeys(command.sessionName, command.keys);
        return { ok: true };

      case 'send_keys_raw':
        tmux.sendKeysRaw(command.sessionName, command.keys);
        return { ok: true };

      case 'display_message': {
        const output = tmux.displayMessage(command.sessionName, command.format);
        return { ok: true, data: output };
      }

      case 'write_codex_profile':
        writeCodexProfile(command.profileName, command.developerInstructions);
        return { ok: true };

      case 'remove_codex_profile':
        removeCodexProfile(command.profileName);
        return { ok: true };

      case 'exec': {
        const { execSync } = await import('node:child_process');
        const timeout = command.timeoutMs ?? 5_000;
        const stdout = execSync(command.command, {
          encoding: 'utf-8',
          timeout,
          cwd: command.cwd ?? undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        return { ok: true, data: stdout };
      }

      case 'resize_pane':
        tmux.resizePane(command.sessionName, command.width, command.height);
        return { ok: true };

      default:
        return { ok: false, error: `Unknown action: ${(command as Record<string, unknown>).action}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── HTTP Server ──

const MAX_BODY_BYTES = 1_048_576; // 1 MB
const MAX_UPLOAD_BYTES = parseInt(process.env['MAX_UPLOAD_BYTES'] ?? String(512 * 1024 * 1024), 10); // 512 MB default

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += (chunk as Buffer).length;
    if (totalLength > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, proxyId: PROXY_ID, registered });
    return;
  }

  // File upload endpoint — streams binary to disk
  if (req.method === 'POST' && req.url?.startsWith('/upload')) {
    const incomingToken = req.headers['x-proxy-token'];
    if (typeof incomingToken !== 'string' || incomingToken.length !== token.length ||
        !timingSafeEqual(Buffer.from(incomingToken), Buffer.from(token))) {
      json(res, 401, { ok: false, error: 'Invalid token' });
      return;
    }

    const url = new URL(req.url, `http://localhost`);
    const cwd = url.searchParams.get('cwd');
    const filename = url.searchParams.get('filename');

    // Validate filename — reject path separators, traversal, null bytes, reserved names, excessive length
    if (!filename || filename.includes('/') || filename.includes('\\') ||
        filename === '.' || filename === '..' ||
        filename.includes('\0') || filename.length > 255 ||
        /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i.test(filename)) {
      json(res, 400, { ok: false, error: 'Invalid filename' });
      return;
    }

    // Validate cwd
    if (!cwd || !cwd.startsWith('/') || !existsSync(cwd)) {
      json(res, 400, { ok: false, error: 'Invalid or missing cwd' });
      return;
    }

    // Path traversal protection — resolve symlinks, verify containment via relative path
    const resolvedCwd = realpathSync(cwd);
    const targetPath = join(resolvedCwd, filename);
    const rel = relative(resolvedCwd, targetPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      json(res, 400, { ok: false, error: 'Path traversal detected' });
      return;
    }

    // Stream to disk with size limit, backpressure, and error cleanup
    const ws = createWriteStream(targetPath);
    let size = 0;

    // Transform that enforces the upload size limit
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          cb(new Error(`Upload exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`));
        } else {
          cb(null, chunk);
        }
      },
    });

    try {
      await pipeline(req, meter, ws);
      json(res, 200, { ok: true, data: { path: targetPath, size } });
    } catch (err) {
      req.destroy();
      // Clean up partial file
      try { unlinkSync(targetPath); } catch { /* may not exist yet */ }
      json(res, 500, { ok: false, error: (err as Error).message });
    }
    return;
  }

  // Command endpoint — token-protected
  if (req.method === 'POST' && req.url === '/command') {
    const incomingToken = req.headers['x-proxy-token'];
    if (typeof incomingToken !== 'string' || incomingToken.length !== token.length ||
        !timingSafeEqual(Buffer.from(incomingToken), Buffer.from(token))) {
      json(res, 401, { ok: false, error: 'Invalid token' });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req)) as ProxyCommand;
      const result = await executeCommand(body);
      json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      json(res, 400, { ok: false, error: `Invalid request: ${(err as Error).message}` });
    }
    return;
  }

  json(res, 404, { ok: false, error: 'Not found' });
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Lifecycle ──

async function resolveConfig(): Promise<{ url: string; secret: string | null }> {
  // Phase 1: Resolve secret
  let secret = resolveSecret();
  if (!secret) {
    const secretPath = getSecretPath();
    console.log(`[proxy] No secret found.`);
    console.log(`[proxy]   Checked: ORCHESTRATOR_SECRET env var`);
    console.log(`[proxy]   Checked: ORCHESTRATOR_SECRET_FILE env var`);
    console.log(`[proxy]   Checked: ${secretPath}`);
    console.log(`[proxy] Watching for secret file at ${secretPath} ...`);
    console.log(`[proxy] To create one: echo "$(openssl rand -base64 32)" > ${secretPath}`);
    console.log(`[proxy] Or start orchestrator — it will create the secret file.`);
    console.log(`[proxy] To run without auth: set ORCHESTRATOR_SECRET="" (empty string)`);

    // If env var is explicitly empty string, skip waiting
    if (process.env['ORCHESTRATOR_SECRET'] === '') {
      console.log(`[proxy] ORCHESTRATOR_SECRET="" — running without auth`);
      secret = null;
    } else {
      secret = await waitForSecret();
      console.log(`[proxy] Secret file detected.`);
    }
  }

  // Phase 2: Discover orchestrator
  console.log(`[proxy] Discovering orchestrator...`);
  if (hasDocker()) {
    console.log(`[proxy]   Docker: available`);
  } else {
    console.log(`[proxy]   Docker: not found (skipping container discovery)`);
  }

  const discovered = await discoverOrchestrator();
  if (!discovered) {
    // Wait and retry with backoff
    console.log(`[proxy] No orchestrator found. Retrying every 5s...`);
    console.log(`[proxy]   Start one with: docker compose up -d`);
    console.log(`[proxy]   Or set ORCHESTRATOR_URL=http://host:port`);
    const url = await waitForOrchestrator();
    return { url, secret };
  }

  if (discovered.fromDocker) {
    console.log(`[proxy] Found orchestrator via Docker: ${discovered.url}`);
  } else if (process.env['ORCHESTRATOR_URL']) {
    console.log(`[proxy] Using orchestrator from ORCHESTRATOR_URL: ${discovered.url}`);
  } else {
    console.log(`[proxy] Found orchestrator at ${discovered.url}`);
  }

  return { url: discovered.url, secret };
}

async function waitForOrchestrator(): Promise<string> {
  const retryMs = 5000;
  while (true) {
    await new Promise<void>(r => setTimeout(r, retryMs));
    const discovered = await discoverOrchestrator();
    if (discovered) {
      console.log(`[proxy] Found orchestrator at ${discovered.url}`);
      return discovered.url;
    }
  }
}

async function start(): Promise<void> {
  console.log(`[proxy] Agentic Collab Proxy starting...`);
  console.log(`[proxy] Proxy ID: ${PROXY_ID}`);

  // Resolve config (may wait for secret file and/or orchestrator)
  const config = await resolveConfig();
  orchestratorUrl = config.url;
  orchestratorSecret = config.secret;

  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[proxy] Listening on port ${PROXY_PORT}`);
    console.log(`[proxy] Orchestrator: ${orchestratorUrl}`);
  });

  await register();

  heartbeatTimer = setInterval(heartbeat, 15_000);
}

async function shutdown(): Promise<void> {
  console.log('[proxy] Shutting down...');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (registered) await deregister();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('[proxy] Fatal:', err);
  process.exit(1);
});
