import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from './websocket-server.ts';

describe('WebSocketServer', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;

  before(async () => {
    wss = new WebSocketServer();
    httpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    httpServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    wss.close();
    httpServer.close();
  });

  it('accepts WebSocket connections', async () => {
    const connected = new Promise<void>((resolve) => {
      wss.onConnect(() => resolve());
    });

    const client = new WebSocket(`ws://localhost:${port}`);
    await connected;

    assert.equal(wss.clientCount, 1);
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('receives text messages from clients', async () => {
    const messageReceived = new Promise<string>((resolve) => {
      wss.onMessage((_client, data) => resolve(data));
    });

    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      client.onopen = () => {
        client.send('hello from client');
        resolve();
      };
    });

    const data = await messageReceived;
    assert.equal(data, 'hello from client');
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('sends messages to clients', async () => {
    const clientMessage = new Promise<string>((resolve) => {
      wss.onConnect((wsClient) => {
        wss.send(wsClient, JSON.stringify({ type: 'init', data: 42 }));
      });

      const client = new WebSocket(`ws://localhost:${port}`);
      client.onmessage = (evt) => {
        resolve(evt.data as string);
        client.close();
      };
    });

    const msg = JSON.parse(await clientMessage);
    assert.equal(msg.type, 'init');
    assert.equal(msg.data, 42);
    await new Promise((r) => setTimeout(r, 100));
  });

  it('broadcasts to all clients', async () => {
    // Clear any stale onConnect callback from previous test
    wss.onConnect(() => {});

    const broadcastMessages: string[] = [];
    const allReceived = new Promise<void>((resolve) => {
      let count = 0;
      function onMsg(data: string) {
        if (data === 'broadcast-test') {
          broadcastMessages.push(data);
          count++;
          if (count === 2) resolve();
        }
      }

      const c1 = new WebSocket(`ws://localhost:${port}`);
      const c2 = new WebSocket(`ws://localhost:${port}`);
      c1.onmessage = (evt) => onMsg(evt.data as string);
      c2.onmessage = (evt) => onMsg(evt.data as string);

      // Wait for both to connect then broadcast
      let connected = 0;
      function checkBoth() {
        connected++;
        if (connected === 2) {
          // Small delay to ensure both WS are fully set up
          setTimeout(() => wss.broadcast('broadcast-test'), 50);
        }
      }
      c1.onopen = checkBoth;
      c2.onopen = checkBoth;

      // Clean up after test
      setTimeout(() => { c1.close(); c2.close(); }, 2000);
    });

    await allReceived;
    assert.equal(broadcastMessages.length, 2);
    assert.equal(broadcastMessages[0], 'broadcast-test');
    assert.equal(broadcastMessages[1], 'broadcast-test');
    await new Promise((r) => setTimeout(r, 100));
  });

  it('handles client disconnect', async () => {
    const disconnected = new Promise<void>((resolve) => {
      wss.onDisconnect(() => resolve());
    });

    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      client.onopen = () => {
        client.close();
        resolve();
      };
    });

    await disconnected;
  });

  it('handles large messages', async () => {
    const largeMsg = 'x'.repeat(50_000);
    const received = new Promise<string>((resolve) => {
      wss.onMessage((_client, data) => resolve(data));
    });

    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      client.onopen = () => {
        client.send(largeMsg);
        resolve();
      };
    });

    const data = await received;
    assert.equal(data.length, 50_000);
    client.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});
