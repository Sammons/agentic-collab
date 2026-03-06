/**
 * Tmux proxy service. Runs on the host outside Docker.
 * Registers with the orchestrator, receives commands, executes tmux operations.
 * Heartbeats every 15s. Re-registers on missed heartbeat.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateToken } from '../shared/sanitize.ts';
import * as tmux from './tmux.ts';
import type { ProxyCommand, ProxyResponse } from '../shared/types.ts';

const PROXY_PORT = parseInt(process.env['PROXY_PORT'] ?? '3100', 10);
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3000';
const PROXY_HOST = process.env['PROXY_HOST'] ?? `host.docker.internal:${PROXY_PORT}`;
const PROXY_ID = process.env['PROXY_ID'] ?? `proxy-${Math.random().toString(36).slice(2, 8)}`;

let token = generateToken();
let registered = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── Registration ──

async function register(): Promise<void> {
  try {
    const resp = await fetch(`${ORCHESTRATOR_URL}/api/proxy/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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
    } catch {
      // Will retry on next heartbeat
    }
  }
}

async function deregister(): Promise<void> {
  try {
    await fetch(`${ORCHESTRATOR_URL}/api/proxy/${PROXY_ID}`, {
      method: 'DELETE',
    });
    console.log('[proxy] Deregistered from orchestrator');
  } catch {
    // Best effort
  }
}

// ── Command Execution ──

function executeCommand(command: ProxyCommand): ProxyResponse {
  try {
    switch (command.action) {
      case 'create_session':
        tmux.createSession(command.sessionName, command.cwd);
        return { ok: true };

      case 'paste':
        tmux.pasteText(command.sessionName, command.text, command.pressEnter);
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
        return { ok: false, error: `Unknown action: ${(command as ProxyCommand).action}` };
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

  // Command endpoint — token-protected
  if (req.method === 'POST' && req.url === '/command') {
    const incomingToken = req.headers['x-proxy-token'];
    if (incomingToken !== token) {
      json(res, 401, { ok: false, error: 'Invalid token' });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req)) as ProxyCommand;
      const result = executeCommand(body);
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
