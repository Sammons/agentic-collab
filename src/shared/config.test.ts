import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePortMapping } from './config.ts';

describe('config', () => {
  describe('parsePortMapping', () => {
    it('parses standard IPv4 mapping', () => {
      assert.equal(parsePortMapping('0.0.0.0:3000->3000/tcp'), 3000);
    });

    it('parses IPv6 mapping', () => {
      assert.equal(parsePortMapping(':::3000->3000/tcp'), 3000);
    });

    it('parses multi-mapping (takes first)', () => {
      assert.equal(parsePortMapping('0.0.0.0:3000->3000/tcp, :::3000->3000/tcp'), 3000);
    });

    it('parses non-standard host port', () => {
      assert.equal(parsePortMapping('0.0.0.0:8080->3000/tcp'), 8080);
    });

    it('returns null for empty string', () => {
      assert.equal(parsePortMapping(''), null);
    });

    it('returns null for garbage input', () => {
      assert.equal(parsePortMapping('not-a-port'), null);
    });
  });

  describe('resolveSecret', () => {
    let tmpDir: string;
    const origEnv: Record<string, string | undefined> = {};

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
      // Save and clear env vars
      for (const key of ['ORCHESTRATOR_SECRET', 'ORCHESTRATOR_SECRET_FILE', 'AGENTIC_COLLAB_CONFIG_DIR']) {
        origEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    after(() => {
      // Restore env vars
      for (const [key, val] of Object.entries(origEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('env var takes priority', async () => {
      // Dynamic import to avoid module-level caching of CONFIG_DIR
      process.env['ORCHESTRATOR_SECRET'] = 'env-secret';
      process.env['AGENTIC_COLLAB_CONFIG_DIR'] = join(tmpDir, 'config');
      const { resolveSecret } = await import('./config.ts?env' + Date.now());
      // resolveSecret reads process.env at call time
      // But CONFIG_DIR is set at import time, so we need the env var path
      // Since ORCHESTRATOR_SECRET is set, it wins
      assert.equal(resolveSecret(), 'env-secret');
      delete process.env['ORCHESTRATOR_SECRET'];
    });

    it('reads from ORCHESTRATOR_SECRET_FILE', async () => {
      const secretFile = join(tmpDir, 'custom-secret');
      writeFileSync(secretFile, 'file-secret\n');
      process.env['ORCHESTRATOR_SECRET_FILE'] = secretFile;
      const { resolveSecret } = await import('./config.ts?file' + Date.now());
      assert.equal(resolveSecret(), 'file-secret');
      delete process.env['ORCHESTRATOR_SECRET_FILE'];
    });
  });
});
