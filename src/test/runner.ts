/**
 * Test runner: starts mock server + probe WebSocket, provides TestContext.
 */

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startMockServer, type MockServer } from './mock-server.ts';
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

  // ── Dashboard URL ──

  get url(): string {
    return `${this.mock.url}/dashboard?test=true`;
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

  // ── Lifecycle ──

  async close(): Promise<void> {
    this.probeWss.close();
    this.mock.close();
    await new Promise<void>((resolve) => this.probeServer.close(() => resolve()));
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
