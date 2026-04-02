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
  { name: 'team-lead', engine: 'claude', state: 'active', lastActivity: new Date().toISOString(), persona: 'team-lead' },
  { name: 'frontend-dev', engine: 'claude', state: 'idle', lastActivity: new Date(Date.now() - 300000).toISOString(), persona: 'frontend-dev' },
  { name: 'backend-dev', engine: 'codex', state: 'active', lastActivity: new Date().toISOString(), persona: 'backend-dev' },
  { name: 'qa-agent', engine: 'opencode', state: 'idle', lastActivity: new Date(Date.now() - 600000).toISOString(), persona: 'qa-agent' },
  { name: 'docs-writer', engine: 'claude', state: 'suspended', lastActivity: new Date(Date.now() - 3600000).toISOString(), persona: 'docs-writer' },
]);

function makePersona(name: string, fm: Record<string, unknown>, body: string) {
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const content = `---\n${fmLines}\n---\n\n${body}`;
  return { name, content, frontmatter: fm, body, filePath: `/personas/${name}.md`, hostname: 'mock' };
}

await ctx.setPersonas({
  'team-lead': makePersona('team-lead', {
    engine: 'claude', model: 'opus', thinking: 'high', permissions: 'dangerously-skip',
    cwd: '/home/user/project',
    start: [{ shell: 'claude --model opus --append-system-prompt $PERSONA_PROMPT' }],
  }, 'You are the team lead. Coordinate sprint reviews, delegate tasks to specialist agents, and ensure quality across all deliverables.'),
  'frontend-dev': makePersona('frontend-dev', {
    engine: 'claude', model: 'sonnet',
    cwd: '/home/user/project/frontend',
    start: [{ shell: 'claude --model sonnet --append-system-prompt $PERSONA_PROMPT' }],
  }, 'You are a frontend developer. Build and maintain the dashboard UI using vanilla TypeScript, Web Components, and scoped CSS.'),
  'backend-dev': makePersona('backend-dev', {
    engine: 'codex', model: 'o3',
    cwd: '/home/user/project',
    start: [{ shell: 'codex --model o3 --approval-mode full-auto' }],
  }, 'You are a backend developer. Work on the orchestrator, database, lifecycle management, and API routes.'),
  'qa-agent': makePersona('qa-agent', {
    engine: 'opencode', model: 'sonnet',
    cwd: '/home/user/project',
  }, 'You are the QA agent. Run the full test suite, report failures, and verify fixes before they merge.'),
  'docs-writer': makePersona('docs-writer', {
    engine: 'claude', model: 'haiku',
    cwd: '/home/user/project/docs',
  }, 'You are the documentation writer. Keep README, CHANGELOG, and HANDOFF docs accurate and up to date.'),
});
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
  // Ensure desktop dimensions
  console.log('Desktop screenshots...');
  await ctx.extResize(1280, 900);
  await sleep(2000);

  await ctx.extScreenshot('desktop-agents');
  save('desktop-agents');

  // Click team-lead for messages (has seeded conversation)
  await ctx.click('agent-card[data-agent="team-lead"]');
  await sleep(2000);
  await ctx.extScreenshot('desktop-messages');
  save('desktop-messages');

  // Persona tab (team-lead has rich persona data)
  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1500);
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

  await ctx.click('agent-card[data-agent="team-lead"]');
  await sleep(2000);
  await ctx.extScreenshot('mobile-messages');
  save('mobile-messages');

  await ctx.click('.thread-tabs button:nth-child(2)');
  await sleep(1500);
  await ctx.extScreenshot('mobile-persona');
  save('mobile-persona');

  console.log('\nDone! 7 screenshots in docs/screenshots/');
} finally {
  await ctx.close();
}
