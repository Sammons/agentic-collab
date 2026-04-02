/**
 * Capture dashboard screenshots using mock server + chrome extension probe.
 *
 * Prerequisites:
 *   1. Load the extension: chrome://extensions → Developer mode → Load unpacked
 *      → select src/test/chrome-extension/
 *   2. Run this script: node scripts/capture-screenshots.ts
 *   3. Script opens Chrome tab, extension connects probe, screenshots via captureVisibleTab
 *
 * Usage: node scripts/capture-screenshots.ts
 */
import { createTestContext } from '../src/test/runner.ts';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname!, '..', 'docs', 'screenshots');
const SNAP = join(import.meta.dirname!, '..', 'src', 'test', 'ui', 'snapshots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const ctx = await createTestContext();

// Seed realistic data
await ctx.setAgents([
  { name: 'team-lead', engine: 'claude', state: 'active', lastActivity: new Date().toISOString() },
  { name: 'frontend-dev', engine: 'claude', state: 'idle', lastActivity: new Date(Date.now() - 300000).toISOString() },
  { name: 'backend-dev', engine: 'codex', state: 'active', lastActivity: new Date().toISOString() },
  { name: 'qa-agent', engine: 'opencode', state: 'idle', lastActivity: new Date(Date.now() - 600000).toISOString() },
  { name: 'docs-writer', engine: 'claude', state: 'suspended', lastActivity: new Date(Date.now() - 3600000).toISOString() },
]);
for (const msg of [
  { m: 'Starting sprint review. Frontend-dev, report on dashboard progress.', d: 'from_agent' },
  { m: 'Dashboard modularized — 16 TS modules, 6 Web Components, 8 CSS files. No build step.', d: 'to_agent' },
  { m: 'Test coverage?', d: 'from_agent' },
  { m: '773 tests across 5 suites. UI framework has 105 regression tests.', d: 'to_agent' },
  { m: 'Backend-dev, field registry status?', d: 'from_agent' },
  { m: 'Registry wired in. Config field changes: ~16 edits to 3.', d: 'to_agent' },
  { m: 'QA-agent, run full regression and report back.', d: 'from_agent' },
]) {
  await ctx.sendMessage('team-lead', msg.m, { direction: msg.d });
}

// Open dashboard in Chrome (extension must be pre-loaded)
const url = ctx.extensionUrl;
console.log(`Opening: ${url}`);
console.log('(Extension must be loaded at chrome://extensions)\n');
execSync(`xdg-open "${url}"`, { stdio: 'ignore' });

console.log('Waiting for probe to connect...');
await ctx.waitForProbe(30_000);
console.log('Probe connected!\n');
await sleep(2000);

function copySnap(name: string) {
  const src = join(SNAP, `${name}.png`);
  if (existsSync(src)) {
    copyFileSync(src, join(OUT, `${name}.png`));
    console.log(`  → docs/screenshots/${name}.png`);
  }
}

try {
  // ── Desktop ──
  console.log('Desktop screenshots (1280x800)...');

  await ctx.screenshot('desktop-agents');
  copySnap('desktop-agents');

  await ctx.click('agent-card');
  await sleep(2000);
  await ctx.screenshot('desktop-messages');
  copySnap('desktop-messages');

  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1000);
  await ctx.screenshot('desktop-persona');
  copySnap('desktop-persona');

  await ctx.click('.filter-chip[data-filter="active"]');
  await sleep(500);
  await ctx.screenshot('desktop-filter');
  copySnap('desktop-filter');

  // ── Mobile ──
  // Resize window to mobile dimensions via extension
  console.log('\nMobile screenshots (375x812)...');
  console.log('  Resizing window...');
  await ctx.resize(375, 812);
  await sleep(2000);

  // Clear filter
  await ctx.click('.filter-chip.active');
  await sleep(500);
  await ctx.screenshot('mobile-agents');
  copySnap('mobile-agents');

  await ctx.click('agent-card');
  await sleep(2000);
  await ctx.screenshot('mobile-messages');
  copySnap('mobile-messages');

  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1000);
  await ctx.screenshot('mobile-persona');
  copySnap('mobile-persona');

  console.log('\nDone! 7 screenshots in docs/screenshots/');
} finally {
  await ctx.close();
}
