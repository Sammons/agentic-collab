/**
 * RFC-010 §4.2 — VENDOR.md must carry every REQUIRED provenance field. This makes
 * the manifest a leaf-bound deliverable, not prose: a missing field fails CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const md = readFileSync(join(import.meta.dirname!, 'VENDOR.md'), 'utf-8');

test('VENDOR.md is non-empty and parses as text', () => {
  assert.ok(md.trim().length > 200, 'VENDOR.md has content');
});

test('VENDOR.md records exact tldraw / react / react-dom / esbuild versions', () => {
  assert.match(md, /tldraw[^\n]*\b5\.\d+\.\d+\b/, 'tldraw version');
  assert.match(md, /\breact\b[^\n]*\b\d+\.\d+\.\d+\b/, 'react version');
  assert.match(md, /react-dom[^\n]*\b\d+\.\d+\.\d+\b/, 'react-dom version');
  assert.match(md, /esbuild[^\n]*\b\d+\.\d+\.\d+\b/, 'esbuild version');
});

test('VENDOR.md records the exact build command', () => {
  assert.match(md, /pnpm --dir tools\/tldraw-bundle build/, 'build command');
});

test('VENDOR.md records both output sha256s', () => {
  const shas = md.match(/`[0-9a-f]{64}`/g) ?? [];
  assert.ok(shas.length >= 2, `expected >=2 sha256 values, found ${shas.length}`);
});

test('VENDOR.md records both sizes (minified + gzipped)', () => {
  assert.match(md, /minified bytes|minified/, 'minified size label');
  assert.match(md, /gzipped/, 'gzipped size label');
  // The table carries numeric byte counts for each file.
  assert.match(md, /tldraw\.bundle\.js[\s\S]*?\b\d{6,}\b/, 'js byte count present');
});

test('VENDOR.md records the style-src measurement result', () => {
  assert.match(md, /style-src/i, 'style-src measurement section');
  assert.match(md, /unsafe-inline/, 'records the measured style-src token');
});

test('VENDOR.md records the licenseKey-injection note + deploy prerequisite', () => {
  assert.match(md, /licenseKey|license key/i, 'license key note');
  assert.match(md, /deploy prerequisite/i, 'deploy prerequisite (register free hobby key)');
});

test('VENDOR.md records the CVE-rot owner + cadence', () => {
  assert.match(md, /agentic-collab-lead/, 'named CVE-rot owner');
  assert.match(md, /quarterly/i, 'review cadence');
  assert.match(md, /on-disclosure/i, 'on-disclosure trigger');
});

test('VENDOR.md records the srcdoc / opaque-origin measurement (§5.1)', () => {
  assert.match(md, /opaque-origin|srcdoc/i, 'sandbox measurement section');
  assert.match(md, /Access-Control-Allow-Origin/i, 'the CORS finding for the vendor route');
});
