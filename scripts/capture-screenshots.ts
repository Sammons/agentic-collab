/**
 * Capture dashboard screenshots using:
 *   - Mock server (seeded data)
 *   - In-page probe (DOM interaction: click, type, read)
 *   - Chrome extension (browser-level: screenshot via captureVisibleTab, resize)
 *
 * One-time setup:
 *   chrome://extensions -> Developer mode -> Load unpacked -> src/test/chrome-extension/
 *
 * Usage: node scripts/capture-screenshots.ts
 *   or:  pnpm screenshot
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
await ctx.startExtensionServer();

// Seed data
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

// Open dashboard — probe.ts connects for DOM, extension connects for screenshots
const url = ctx.extensionUrl;
console.log(`Opening: ${url}\n`);
execSync(`xdg-open "${url}"`, { stdio: 'ignore' });

console.log('Waiting for in-page probe...');
await ctx.waitForProbe(30_000);
console.log('Probe connected!');

console.log('Waiting for extension...');
await ctx.waitForExtension(30_000);
console.log('Extension connected!\n');
await sleep(2000);

function save(name: string) {
  const src = join(SNAP, `${name}.png`);
  if (existsSync(src)) {
    copyFileSync(src, join(OUT, `${name}.png`));
    console.log(`  -> docs/screenshots/${name}.png`);
  }
}

try {
  console.log('Desktop screenshots...');

  await ctx.extScreenshot('desktop-agents');
  save('desktop-agents');

  await ctx.click('agent-card');
  await sleep(2000);
  await ctx.extScreenshot('desktop-messages');
  save('desktop-messages');

  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1000);
  await ctx.extScreenshot('desktop-persona');
  save('desktop-persona');

  await ctx.click('.filter-chip[data-filter="active"]');
  await sleep(500);
  await ctx.extScreenshot('desktop-filter');
  save('desktop-filter');

  console.log('\nMobile screenshots...');
  await ctx.extResize(375, 812);
  await sleep(2000);

  try { await ctx.click('.filter-chip.active'); } catch {}
  await sleep(500);
  try { await ctx.click('.mobile-back'); } catch {}
  await sleep(500);
  await ctx.extScreenshot('mobile-agents');
  save('mobile-agents');

  await ctx.click('agent-card');
  await sleep(2000);
  await ctx.extScreenshot('mobile-messages');
  save('mobile-messages');

  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1000);
  await ctx.extScreenshot('mobile-persona');
  save('mobile-persona');

  console.log('\nDone! 7 screenshots in docs/screenshots/');
} finally {
  await ctx.close();
}
