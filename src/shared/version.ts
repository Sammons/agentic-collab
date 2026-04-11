/**
 * Semver-based version for proxy/orchestrator handshake.
 * Reads from .build-version (written by start.sh) or falls back to package.json.
 * Version mismatch ignores patch — only major.minor differences trigger a warning.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedVersion: string | null = null;

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  const root = join(import.meta.dirname!, '..', '..');

  // 1. .build-version (written by start.sh at launch time)
  try {
    const ver = readFileSync(join(root, '.build-version'), 'utf-8').trim();
    if (ver) {
      cachedVersion = ver;
      return cachedVersion;
    }
  } catch {
    // Not present yet — first run or manual launch
  }

  // 2. package.json version (always available)
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    cachedVersion = pkg.version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }

  return cachedVersion!;
}

/**
 * Compare two semver strings, ignoring patch version.
 * Returns true if major.minor match. Non-semver strings use strict equality.
 */
export function versionsMatch(a: string, b: string): boolean {
  const semverRe = /^(\d+)\.(\d+)\.\d+/;
  const ma = semverRe.exec(a);
  const mb = semverRe.exec(b);
  if (ma && mb) {
    return ma[1] === mb[1] && ma[2] === mb[2];
  }
  // Non-semver: strict equality
  return a === b;
}
