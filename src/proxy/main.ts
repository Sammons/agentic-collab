/**
 * Tmux proxy service. Runs on the host outside Docker.
 * Registers with the orchestrator, receives commands, executes tmux operations.
 * Heartbeats every 15s. Re-registers on missed heartbeat.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { generateToken } from '../shared/sanitize.ts';
import * as tmux from './tmux.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

const PROXY_PORT = parseInt(process.env['PROXY_PORT'] ?? '3100', 10);
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3000';
const PROXY_HOST = process.env['PROXY_HOST'] ?? `host.docker.internal:${PROXY_PORT}`;
import { randomBytes, timingSafeEqual } from 'node:crypto';
const PROXY_ID = process.env['PROXY_ID'] ?? `proxy-${randomBytes(4).toString('hex')}`;
const ORCHESTRATOR_SECRET = process.env['ORCHESTRATOR_SECRET'] ?? null;

let token = generateToken();
let registered = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ORCHESTRATOR_SECRET) {
    headers['authorization'] = `Bearer ${ORCHESTRATOR_SECRET}`;
  }
  return headers;
}

// ── Registration ──

async function register(): Promise<void> {
  try {
    const resp = await fetch(`${ORCHESTRATOR_URL}/api/proxy/register`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ proxyId: PROXY_ID, token, host: PROXY_HOST }),
    });

    if (resp.ok) {
      registered = true;
      console.log(`[proxy] Registered with orchestrator as "${PROXY_ID}"`);
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
    const resp = await fetch(`${ORCHESTRATOR_URL}/api/proxy/heartbeat`, {
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
    await fetch(`${ORCHESTRATOR_URL}/api/proxy/${PROXY_ID}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    console.log('[proxy] Deregistered from orchestrator');
  } catch {
    // Best effort
  }
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

      case 'send_keys':
        tmux.sendKeys(command.sessionName, command.keys);
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

    // Stream to disk with proper backpressure and error cleanup
    const ws = createWriteStream(targetPath);
    let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; });

    try {
      await pipeline(req, ws);
      json(res, 200, { ok: true, data: { path: targetPath, size } });
    } catch (err) {
      req.destroy();
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

async function start(): Promise<void> {
  server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[proxy] Listening on port ${PROXY_PORT}`);
    console.log(`[proxy] Proxy ID: ${PROXY_ID}`);
    console.log(`[proxy] Orchestrator: ${ORCHESTRATOR_URL}`);
  });

  await register();

  heartbeatTimer = setInterval(heartbeat, 15_000);
}

async function shutdown(): Promise<void> {
  console.log('[proxy] Shutting down...');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await deregister();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('[proxy] Fatal:', err);
  process.exit(1);
});
