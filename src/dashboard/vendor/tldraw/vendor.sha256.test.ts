/**
 * RFC-010 §4.5 — the "frozen is VERIFIABLE" check.
 *
 * Recomputes sha256(tldraw.bundle.js) and (.css) and asserts each equals the
 * value recorded in VENDOR.md. A drifted bundle (hand-edited, or rebuilt without
 * updating VENDOR.md) fails CI. This does NOT run esbuild — it is the cheap proxy
 * for the full reproducible build (which runs manually on upgrade).
 *
 * Also asserts each output is a single non-empty file and that the recorded size
 * is within tolerance of the actual file size.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname!;
const vendorMd = readFileSync(join(here, 'VENDOR.md'), 'utf-8');

/** Pull the sha256 recorded for a file from the VENDOR.md table row. */
function recordedSha(file: string): string {
  // Row shape: | `tldraw.bundle.js` | `<64hex>` | ... |
  const escaped = file.replace(/[.]/g, '\\.');
  const re = new RegExp('\\|\\s*`' + escaped + '`\\s*\\|\\s*`([0-9a-f]{64})`');
  const match = vendorMd.match(re);
  assert.ok(match, `VENDOR.md must record a sha256 for ${file}`);
  return match![1]!;
}

/** Pull the recorded minified byte count for a file from VENDOR.md. */
function recordedSize(file: string): number {
  const escaped = file.replace(/[.]/g, '\\.');
  // | `file` | `sha` | <minified bytes> (..) | <gz> (..) |
  const re = new RegExp('\\|\\s*`' + escaped + '`\\s*\\|\\s*`[0-9a-f]{64}`\\s*\\|\\s*(\\d+)');
  const match = vendorMd.match(re);
  assert.ok(match, `VENDOR.md must record a minified size for ${file}`);
  return Number(match![1]);
}

for (const file of ['tldraw.bundle.js', 'tldraw.bundle.css']) {
  test(`vendored ${file} sha256 matches VENDOR.md (frozen)`, () => {
    const bytes = readFileSync(join(here, file));
    assert.ok(bytes.length > 0, `${file} must be a non-empty file`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, recordedSha(file), `${file} drifted from its recorded sha256 — rebuild + update VENDOR.md`);
  });

  test(`vendored ${file} recorded size is within tolerance of actual`, () => {
    const actual = statSync(join(here, file)).size;
    const recorded = recordedSize(file);
    // Recorded size IS the exact byte count from the build; allow a tiny tolerance.
    const tolerance = Math.max(64, Math.ceil(actual * 0.001));
    assert.ok(
      Math.abs(actual - recorded) <= tolerance,
      `${file}: VENDOR.md size ${recorded} vs actual ${actual} (tolerance ${tolerance})`,
    );
  });
}
