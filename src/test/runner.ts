/**
 * Test runner: starts mock server + probe WebSocket, provides TestContext.
 */

import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMockServer, type MockServer, type RequestLogEntry } from './mock-server.ts';
import { WebSocketServer, type WsClient } from '../shared/websocket-server.ts';
import type { AgentRecord, ActiveIndicator } from '../shared/types.ts';

export class TestContext {
  private mock: MockServer;
  private probeServer: Server;
  private probeWss: WebSocketServer;
  private probeClient: WsClient | null = null;
  private probeReady: Promise<void>;
  private resolveProbeReady!: () => void;
  private pendingCommands = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private mockPort: number;

  // Extension channel (screenshot/resize via chrome extension polling HTTP)
  private extServer: Server | null = null;
  private extReady: Promise<void> | null = null;
  private resolveExtReady: (() => void) | null = null;
  private extCommandQueue: { id: string; cmd: string; [k: string]: unknown }[] = [];
  private extPollWaiters: ((cmd: unknown) => void)[] = [];
  private pendingExtCommands = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(mock: MockServer, probeServer: Server, probeWss: WebSocketServer, mockPort: number) {
    this.mock = mock;
    this.probeServer = probeServer;
    this.probeWss = probeWss;
    this.mockPort = mockPort;
    this.probeReady = new Promise<void>((resolve) => {
      this.resolveProbeReady = resolve;
    });

    probeWss.onConnect((client) => {
      this.probeClient = client;
    });

    probeWss.onMessage((client, data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }

      // Probe ready signal
      if (msg['type'] === 'probe_ready') {
        this.probeClient = client;
        this.resolveProbeReady();
        return;
      }

      // Command response
      const id = msg['id'] as string | undefined;
      if (id && this.pendingCommands.has(id)) {
        const pending = this.pendingCommands.get(id)!;
        this.pendingCommands.delete(id);
        if (msg['ok']) {
          pending.resolve(msg['data'] ?? null);
        } else {
          pending.reject(new Error(String(msg['error'] ?? 'probe command failed')));
        }
      }
    });

    probeWss.onDisconnect(() => {
      this.probeClient = null;
      // Reset the ready promise for potential reconnection
      this.probeReady = new Promise<void>((resolve) => {
        this.resolveProbeReady = resolve;
      });
    });
  }

  /** Start the extension HTTP server on mockPort + 2. Call before opening the extensionUrl. */
  async startExtensionServer(): Promise<void> {
    const extPort = this.mockPort + 2;
    this.extReady = new Promise<void>((resolve) => { this.resolveExtReady = resolve; });

    this.extServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${extPort}`);
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // Extension signals ready
      if (url.pathname === '/ext/ready') {
        this.resolveExtReady?.();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      // Extension polls for next command (long-poll: wait up to 10s)
      if (url.pathname === '/ext/poll') {
        if (this.extCommandQueue.length > 0) {
          const cmd = this.extCommandQueue.shift()!;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(cmd));
        } else {
          // Long-poll: wait for a command or timeout
          const timer = setTimeout(() => {
            const idx = this.extPollWaiters.indexOf(resolve);
            if (idx >= 0) this.extPollWaiters.splice(idx, 1);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
          }, 10000);
          const resolve = (cmd: unknown) => {
            clearTimeout(timer);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(cmd));
          };
          this.extPollWaiters.push(resolve);
        }
        return;
      }

      // Extension posts result
      if (url.pathname === '/ext/result') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const msg = JSON.parse(body) as Record<string, unknown>;
            const id = msg['id'] as string;
            if (id && this.pendingExtCommands.has(id)) {
              const pending = this.pendingExtCommands.get(id)!;
              this.pendingExtCommands.delete(id);
              if (msg['ok']) pending.resolve(msg['data'] ?? null);
              else pending.reject(new Error(String(msg['error'] ?? 'ext command failed')));
            }
          } catch { /* ignore */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }

      res.writeHead(404); res.end();
    });

    await new Promise<void>((resolve) => { this.extServer!.listen(extPort, () => resolve()); });
  }

  async waitForExtension(timeout = 30_000): Promise<void> {
    if (!this.extReady) throw new Error('Extension server not started — call startExtensionServer() first');
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Extension did not connect within timeout')), timeout);
    });
    await Promise.race([this.extReady, timer]);
  }

  private sendExtCommand(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = randomUUID();
    const command = { id, cmd, ...params };

    // Push to queue — if a poller is waiting, deliver immediately
    if (this.extPollWaiters.length > 0) {
      this.extPollWaiters.shift()!(command);
    } else {
      this.extCommandQueue.push(command);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtCommands.delete(id);
        reject(new Error(`Extension command "${cmd}" timed out`));
      }, 15_000);
      this.pendingExtCommands.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Take screenshot via chrome extension (captureVisibleTab). */
  async extScreenshot(name: string): Promise<string> {
    const result = await this.sendExtCommand('screenshot') as { base64: string };
    const snapshotDir = join(import.meta.dirname, 'ui', 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    const pngPath = join(snapshotDir, `${name}.png`);
    writeFileSync(pngPath, Buffer.from(result.base64, 'base64'));
    console.log(`[ext-screenshot] ${name}.png saved`);
    return pngPath;
  }

  /** Resize window via chrome extension. */
  async extResize(width: number, height: number): Promise<void> {
    await this.sendExtCommand('resize', { width, height });
  }

  // ── Dashboard URL ──

  get url(): string {
    return `${this.mock.url}/dashboard?test=true`;
  }

  /** URL with extPort param for chrome extension service worker. */
  get extensionUrl(): string {
    return `${this.mock.url}/dashboard?test=true&extPort=${this.mockPort + 2}`;
  }

  get probePort(): number {
    return this.mockPort + 1;
  }

  get baseUrl(): string {
    return this.mock.url;
  }

  // ── Mock Backend Control ──

  async setAgents(agents: Partial<AgentRecord>[]): Promise<void> {
    const res = await fetch(`${this.mock.url}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agents),
    });
    if (!res.ok) throw new Error(`setAgents failed: ${res.status}`);
  }

  async setPersonas(personas: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.mock.url}/test/set-personas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(personas),
    });
    if (!res.ok) throw new Error(`setPersonas failed: ${res.status}`);
  }

  async sendMessage(agent: string, message: string, opts?: { direction?: string; topic?: string }): Promise<void> {
    const res = await fetch(`${this.mock.url}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, message, direction: opts?.direction, topic: opts?.topic }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  }

  async triggerIndicator(agentName: string, indicators: ActiveIndicator[]): Promise<void> {
    const res = await fetch(`${this.mock.url}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentName, indicators }),
    });
    if (!res.ok) throw new Error(`triggerIndicator failed: ${res.status}`);
  }

  async reset(): Promise<void> {
    const res = await fetch(`${this.mock.url}/test/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`reset failed: ${res.status}`);
  }

  // ── Probe Commands ──

  async waitForProbe(timeout = 10_000): Promise<void> {
    const timer = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Probe did not connect within timeout')), timeout);
    });
    await Promise.race([this.probeReady, timer]);
  }

  private sendProbeCommand(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.probeClient) {
      return Promise.reject(new Error('No probe connected'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Probe command "${cmd}" timed out`));
      }, 10_000);

      this.pendingCommands.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.probeWss.send(this.probeClient!, JSON.stringify({ id, cmd, ...params }));
    });
  }

  async click(selector: string): Promise<void> {
    await this.sendProbeCommand('click', { selector });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.sendProbeCommand('type', { selector, text });
  }

  async readText(selector: string): Promise<string> {
    return (await this.sendProbeCommand('read-text', { selector })) as string;
  }

  async readState(): Promise<unknown> {
    return await this.sendProbeCommand('read-state');
  }

  async waitFor(selector: string, timeout = 5000): Promise<void> {
    await this.sendProbeCommand('wait-for', { selector, timeout });
  }

  async count(selector: string): Promise<number> {
    return (await this.sendProbeCommand('count', { selector })) as number;
  }

  /** Resize window (requires chrome extension probe). */
  async resize(width: number, height: number): Promise<void> {
    await this.sendProbeCommand('resize', { width, height });
  }

  // ── Snapshots ──

  async snapshot(name: string): Promise<{ descriptor: Record<string, unknown>; htmlPath: string; jsonPath: string }> {
    const result = await this.sendProbeCommand('snapshot', {});
    const { descriptor, html } = result as { descriptor: Record<string, unknown>; html: string };

    const snapshotDir = join(import.meta.dirname, 'ui', 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });

    const htmlPath = join(snapshotDir, `${name}.html`);
    const jsonPath = join(snapshotDir, `${name}.json`);

    writeFileSync(htmlPath, html, 'utf-8');
    writeFileSync(jsonPath, JSON.stringify(descriptor, null, 2), 'utf-8');

    return { descriptor, htmlPath, jsonPath };
  }

  async screenshot(name: string): Promise<string> {
    const result = await this.sendProbeCommand('screenshot', {});
    const { base64, width, height } = result as { base64: string; width: number; height: number };

    const snapshotDir = join(import.meta.dirname, 'ui', 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });

    const pngPath = join(snapshotDir, `${name}.png`);
    writeFileSync(pngPath, Buffer.from(base64, 'base64'));

    console.log(`[screenshot] ${name}.png saved (${width}x${height})`);
    return pngPath;
  }

  // ── Request Log ──

  async getRequestLog(): Promise<RequestLogEntry[]> {
    const res = await fetch(`${this.mock.url}/test/request-log`);
    if (!res.ok) throw new Error(`getRequestLog failed: ${res.status}`);
    return (await res.json()) as RequestLogEntry[];
  }

  async saveRequestLog(name: string): Promise<string> {
    const log = await this.getRequestLog();
    const snapshotDir = join(import.meta.dirname, 'ui', 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    const filePath = join(snapshotDir, `${name}.requests.json`);
    writeFileSync(filePath, JSON.stringify(log, null, 2), 'utf-8');
    return filePath;
  }

  // ── Lifecycle ──

  async close(): Promise<void> {
    this.probeWss.close();
    this.mock.close();
    await new Promise<void>((resolve) => this.probeServer.close(() => resolve()));
    if (this.extServer) await new Promise<void>((resolve) => this.extServer!.close(() => resolve()));
  }
}

/**
 * Create a fully wired TestContext on random available ports.
 * Mock server listens on `port`, probe WebSocket on `port + 1`.
 */
export async function createTestContext(): Promise<TestContext> {
  // Find an available port by binding to 0
  const portFinder = createServer();
  const mockPort = await new Promise<number>((resolve) => {
    portFinder.listen(0, () => {
      const addr = portFinder.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      portFinder.close(() => resolve(p));
    });
  });

  const probePort = mockPort + 1;

  // Start mock server
  const mock = await startMockServer(mockPort);

  // Start probe WebSocket server
  const probeWss = new WebSocketServer();
  const probeServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  probeServer.on('upgrade', (req, socket, head) => {
    probeWss.handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve) => {
    probeServer.listen(probePort, () => resolve());
  });

  return new TestContext(mock, probeServer, probeWss, mockPort);
}
