/**
 * Build version for proxy/orchestrator version handshake.
 * Uses git short SHA when available, falls back to COMMIT_SHA env var,
 * then to package.json version.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  // 1. Env var (set by Docker build arg or docker-compose)
  if (process.env['COMMIT_SHA']) {
    cachedVersion = process.env['COMMIT_SHA'];
    return cachedVersion;
  }

  // 2. Git short SHA (works on host where git is available)
  try {
    cachedVersion = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (cachedVersion) return cachedVersion;
  } catch {
    // Git not available (e.g. inside Docker without .git)
  }

  // 3. Fallback: package.json version
  try {
    const pkgPath = join(import.meta.dirname!, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }

  return cachedVersion!;
}
