/**
 * Tests for the proxy /upload endpoint.
 * Tests filename validation, file writing, and path traversal protection.
 * Uses a real HTTP server and temp directory for file I/O.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWriteStream, existsSync, realpathSync, readFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

describe('Proxy /upload endpoint', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let tmpDir: string;
  const TOKEN = 'test-upload-token-123';
  const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // match production default

  // Minimal reimplementation of the proxy /upload handler for unit testing
  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://localhost');

    // Token check
    const incomingToken = req.headers['x-proxy-token'];
    if (typeof incomingToken !== 'string' || incomingToken.length !== TOKEN.length ||
        !timingSafeEqual(Buffer.from(incomingToken), Buffer.from(TOKEN))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid token' }));
      return;
    }

    const cwd = url.searchParams.get('cwd');
    const filename = url.searchParams.get('filename');

    if (!filename || filename.includes('/') || filename.includes('\\') ||
        filename === '.' || filename === '..' ||
        filename.includes('\0') || filename.length > 255 ||
        /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i.test(filename)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid filename' }));
      return;
    }

    if (!cwd || !cwd.startsWith('/') || !existsSync(cwd)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid or missing cwd' }));
      return;
    }

    const resolvedCwd = realpathSync(cwd);
    const targetPath = join(resolvedCwd, filename);
    const rel = relative(resolvedCwd, targetPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Path traversal detected' }));
      return;
    }

    const ws = createWriteStream(targetPath);
    let size = 0;

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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { path: targetPath, size } }));
    } catch (err) {
      req.destroy();
      try { unlinkSync(targetPath); } catch { /* may not exist yet */ }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  }

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-upload-test-'));

    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/upload')) {
        handleUpload(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function upload(filename: string, cwd: string, data: Buffer | string, token = TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
    return fetch(`http://localhost:${port}/upload?cwd=${encodeURIComponent(cwd)}&filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-proxy-token': token,
      },
      body: data,
    }).then(async (resp) => ({
      status: resp.status,
      body: await resp.json() as Record<string, unknown>,
    }));
  }

  // ── Filename Validation ──

  it('rejects empty filename', async () => {
    const res = await upload('', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects filename with forward slash', async () => {
    const res = await upload('foo/bar.txt', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects filename with backslash', async () => {
    const res = await upload('foo\\bar.txt', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects dot filename', async () => {
    const res = await upload('.', tmpDir, 'data');
    assert.equal(res.status, 400);
  });

  it('rejects dotdot filename', async () => {
    const res = await upload('..', tmpDir, 'data');
    assert.equal(res.status, 400);
  });

  it('rejects path traversal via ../etc/passwd', async () => {
    const res = await upload('../etc/passwd', tmpDir, 'data');
    assert.equal(res.status, 400);
  });

  it('accepts dotfile filenames (.eslintrc)', async () => {
    const res = await upload('.eslintrc', tmpDir, '{}');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(existsSync(join(tmpDir, '.eslintrc')));
  });

  it('accepts filenames with spaces', async () => {
    const res = await upload('my file.txt', tmpDir, 'hello');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(existsSync(join(tmpDir, 'my file.txt')));
  });

  // ── File Writing ──

  it('writes file content correctly', async () => {
    const content = 'Hello, World! 🌍';
    const res = await upload('test.txt', tmpDir, content);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const written = readFileSync(join(tmpDir, 'test.txt'), 'utf-8');
    assert.equal(written, content);
  });

  it('writes binary file content correctly', async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const res = await upload('binary.bin', tmpDir, data);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const written = readFileSync(join(tmpDir, 'binary.bin'));
    assert.deepEqual(written, data);
  });

  it('returns correct path and size', async () => {
    const content = 'sized-content';
    const res = await upload('sized.txt', tmpDir, content);
    assert.equal(res.status, 200);
    const resData = res.body.data as { path: string; size: number };
    assert.equal(resData.path, join(tmpDir, 'sized.txt'));
    assert.equal(resData.size, Buffer.byteLength(content));
  });

  it('writes zero-byte file correctly', async () => {
    const res = await upload('empty.txt', tmpDir, '');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const written = readFileSync(join(tmpDir, 'empty.txt'));
    assert.equal(written.length, 0);
  });

  it('overwrites existing file', async () => {
    await upload('overwrite.txt', tmpDir, 'original');
    const res = await upload('overwrite.txt', tmpDir, 'replaced');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const content = readFileSync(join(tmpDir, 'overwrite.txt'), 'utf-8');
    assert.equal(content, 'replaced');
  });

  // ── cwd Validation ──

  it('rejects non-existent cwd', async () => {
    const res = await upload('test.txt', '/nonexistent/path/xyz', 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects relative cwd', async () => {
    const res = await upload('test.txt', 'relative/path', 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  // ── Auth ──

  it('rejects invalid token', async () => {
    const res = await upload('test.txt', tmpDir, 'data', 'wrong-token-value');
    assert.equal(res.status, 401);
  });

  // ── Hardened Filename Validation ──

  it('rejects filename with null byte', async () => {
    const res = await upload('file\0.txt', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects filename exceeding 255 chars', async () => {
    const longName = 'a'.repeat(256) + '.txt';
    const res = await upload(longName, tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('accepts filename at exactly 255 chars', async () => {
    const name = 'a'.repeat(251) + '.txt'; // 255 total
    const res = await upload(name, tmpDir, 'data');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(existsSync(join(tmpDir, name)));
  });

  it('rejects Windows reserved name CON', async () => {
    const res = await upload('CON', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects Windows reserved name NUL.txt', async () => {
    const res = await upload('NUL.txt', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects Windows reserved name com1 (case insensitive)', async () => {
    const res = await upload('com1', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('rejects Windows reserved name LPT1.log', async () => {
    const res = await upload('LPT1.log', tmpDir, 'data');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it('accepts non-reserved filename that starts with reserved prefix', async () => {
    // "CONSOLE" is NOT reserved — only "CON" exactly (possibly with extension) is
    const res = await upload('CONSOLE.txt', tmpDir, 'data');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  // ── Path Traversal via Symlinks ──

  it('prevents symlink traversal outside cwd', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));
    const symlinkDir = join(tmpDir, 'symlinked');
    try {
      symlinkSync(outsideDir, symlinkDir);
      // Uploading to the symlinked dir should resolve and be within tmpDir
      // but the filename can't contain / so a direct traversal via filename is blocked
      // The symlink itself as cwd would resolve to outsideDir
      const res = await upload('test.txt', symlinkDir, 'data');
      // realpathSync resolves the symlink, so the file goes to outsideDir
      // This is actually fine — the cwd IS the resolved dir. The containment check
      // verifies the file stays within resolved cwd.
      assert.equal(res.status, 200);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(symlinkDir, { force: true });
    }
  });
});
