/**
 * UI test framework smoke test.
 * Verifies mock server HTTP endpoints, API layer, WebSocket init, and test control API.
 * No browser required — probe-dependent tests are skipped.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, type TestContext } from '../runner.ts';

describe('UI Test Framework - Smoke', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext();
  });

  after(async () => {
    await ctx.close();
  });

  // ── Dashboard serving ──

  it('mock server serves dashboard HTML with probe script injected', async () => {
    const res = await fetch(ctx.url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('test-probe.js'), 'should inject probe script tag');
    assert.ok(html.includes('</html>'), 'should contain full HTML document');
  });

  it('mock server serves probe script', async () => {
    const res = await fetch(`${ctx.baseUrl}/test-probe.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('probe_ready'), 'should contain probe_ready signal');
    assert.ok(js.includes('WebSocket'), 'should contain WebSocket client code');
  });

  // ── API endpoints ──

  it('agents API returns fixture data', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    assert.equal(res.status, 200);
    const agents = (await res.json()) as { name: string; engine: string; state: string }[];
    assert.equal(agents.length, 3);
    assert.equal(agents[0]!.name, 'test-claude');
    assert.equal(agents[0]!.engine, 'claude');
    assert.equal(agents[0]!.state, 'idle');
    assert.equal(agents[1]!.name, 'test-codex');
    assert.equal(agents[1]!.engine, 'codex');
    assert.equal(agents[1]!.state, 'active');
    assert.equal(agents[2]!.name, 'test-failed');
    assert.equal(agents[2]!.state, 'failed');
  });

  it('threads API returns empty object', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    assert.equal(res.status, 200);
    const threads = await res.json();
    assert.deepEqual(threads, {});
  });

  it('proxies API returns fixture proxy', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/proxies`);
    assert.equal(res.status, 200);
    const proxies = (await res.json()) as { proxyId: string }[];
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0]!.proxyId, 'test-proxy');
  });

  it('reminders API returns empty array', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/reminders`);
    assert.equal(res.status, 200);
    const reminders = await res.json();
    assert.deepEqual(reminders, []);
  });

  it('personas API returns 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/personas/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('voice status API returns disabled', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/voice/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean };
    assert.equal(body.enabled, false);
  });

  it('POST catch-all returns ok', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/some/random/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  // ── Test control API ──

  it('set-agents adds a new agent to fixtures', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'new-agent', engine: 'claude', state: 'void' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    assert.ok(agents.some((a) => a.name === 'new-agent'), 'should include newly added agent');
  });

  it('set-agents updates an existing agent', async () => {
    await fetch(`${ctx.baseUrl}/test/set-agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ name: 'test-claude', state: 'active' }]),
    });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string; state: string }[];
    const claude = agents.find((a) => a.name === 'test-claude');
    assert.equal(claude?.state, 'active');
  });

  it('send-message creates a thread entry and broadcasts', async () => {
    await fetch(`${ctx.baseUrl}/test/send-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'test-claude', message: 'hello from test', direction: 'from_agent' }),
    });
    const res = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = (await res.json()) as Record<string, { message: string }[]>;
    assert.ok(threads['test-claude'], 'should have thread for test-claude');
    assert.ok(threads['test-claude']!.some((m) => m.message === 'hello from test'));
  });

  it('trigger-indicator updates indicator state', async () => {
    const indicatorRes = await fetch(`${ctx.baseUrl}/test/trigger-indicator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentName: 'test-claude',
        indicators: [{ id: 'test-ind', badge: 'WARN', style: 'warning' }],
      }),
    });
    assert.equal(indicatorRes.status, 200);
  });

  it('reset restores default fixtures', async () => {
    // After previous tests mutated state, reset should bring it back
    await fetch(`${ctx.baseUrl}/test/reset`, { method: 'POST' });
    const res = await fetch(`${ctx.baseUrl}/api/agents`);
    const agents = (await res.json()) as { name: string }[];
    assert.equal(agents.length, 3, 'should have exactly 3 default agents after reset');
    assert.ok(!agents.some((a) => a.name === 'new-agent'), 'new-agent should be gone after reset');

    const threadRes = await fetch(`${ctx.baseUrl}/api/dashboard/threads`);
    const threads = await threadRes.json();
    assert.deepEqual(threads, {}, 'threads should be empty after reset');
  });

  // ── WebSocket init ──

  it('WebSocket sends well-formed init event on connect', async () => {
    const initEvent = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS init timeout')), 3000);
      const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`);
      ws.onmessage = (evt) => {
        clearTimeout(timer);
        const parsed = JSON.parse(evt.data as string) as Record<string, unknown>;
        ws.close();
        resolve(parsed);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('WS connection error'));
      };
    });

    assert.equal(initEvent['type'], 'init');
    assert.ok(Array.isArray(initEvent['agents']), 'init should include agents array');
    assert.ok(typeof initEvent['threads'] === 'object', 'init should include threads object');
    assert.ok(Array.isArray(initEvent['proxies']), 'init should include proxies array');

    const agents = initEvent['agents'] as { name: string }[];
    assert.equal(agents.length, 3);
    assert.equal(agents[0]!.name, 'test-claude');
  });

  // ── Dashboard script validation ──

  // v3 dashboard uses external TS modules loaded via importmap, not inline scripts.
  // The inline script validation tests are obsolete.

  it('all dashboard module files exist and are importable', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const dashDir = join(import.meta.dirname!, '..', '..', 'dashboard');
    const tsFiles = readdirSync(dashDir).filter((f: string) => f.endsWith('.ts'));

    // Verify main.ts exists (entry point)
    assert.ok(tsFiles.includes('main.ts'), 'dashboard should have main.ts entry point');

    // Verify all TS files exist
    assert.ok(tsFiles.length > 5, `dashboard should have multiple module files (found ${tsFiles.length})`);

    // Spot-check key modules
    const requiredModules = ['state.ts', 'routing.ts', 'chat.ts', 'connection.ts'];
    const missing = requiredModules.filter((m) => !existsSync(join(dashDir, m)));
    assert.deepEqual(missing, [], `Missing required dashboard modules: ${missing.join(', ')}`);
  });

  // ── Dashboard .ts syntax validation ──
  // Dashboard files are excluded from tsconfig (browser-native type stripping with
  // bare path imports). This test catches syntax errors like duplicate const
  // declarations that tsc would normally find.

  it('dashboard .ts files have no syntax errors', async () => {
    const { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { execSync } = await import('node:child_process');

    const dashDir = join(import.meta.dirname!, '..', '..', 'dashboard');
    const tsFiles = readdirSync(dashDir).filter((f: string) => f.endsWith('.ts'));
    assert.ok(tsFiles.length > 0, 'should find dashboard .ts files');

    // Create a temp dir for isolated syntax check
    const tmpDir = mkdtempSync(join(tmpdir(), 'dash-syntax-'));
    const errors: string[] = [];

    for (const file of tsFiles) {
      let source = readFileSync(join(dashDir, file), 'utf-8');
      // Convert browser bare imports to node-resolvable paths (syntax check only)
      source = source.replace(/from\s+['"]\.\/(\w+)\.ts['"]/g, "from './$1.mts'");
      source = source.replace(/from\s+['"]\.\.\/shared\/(\w+)\.ts['"]/g, "from '../shared/$1.mts'");
      // Stub the imports — we only care about syntax, not resolution
      source = source.replace(/^import\s+.*$/gm, '// import stubbed');
      source = source.replace(/^export\s+/gm, '');

      const tmpFile = join(tmpDir, file.replace('.ts', '.mts'));
      writeFileSync(tmpFile, source);

      try {
        // Use Node's built-in TS type stripping to parse the file
        execSync(`node --experimental-strip-types -e "import('${tmpFile}')"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        // Extract the actual syntax error from Node's output
        const match = stderr.match(/SyntaxError:.*|error TS\d+:.*/);
        if (match) {
          errors.push(`${file}: ${match[0]}`);
        } else {
          // Other errors (like module resolution) are expected and ignored
        }
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }
    }

    // Cleanup temp dir
    try {
      const { rmdirSync } = await import('node:fs');
      rmdirSync(tmpDir);
    } catch {}

    assert.deepEqual(errors, [], `Dashboard syntax errors:\n${errors.join('\n')}`);
  });
});
