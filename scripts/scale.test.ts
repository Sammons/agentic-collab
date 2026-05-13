/**
 * Tests for scripts/scale-up.sh and scripts/scale-down.sh.
 *
 * Both scripts are pure bash + git; we exercise them via child_process and assert
 * on filesystem state, persona file contents, and exit codes.
 *
 * Each test creates an isolated tmp directory containing:
 *   - a fake "source repo" (real git repo, two commits on develop)
 *   - a fake "personas dir" with a base persona file referencing the source repo
 *
 * The scripts respect PERSONAS_DIR_OVERRIDE (so we point them at the tmp personas
 * dir) and read git via the source repo's path (from the persona's cwd: field).
 *
 * scale-down's destroy step normally POSTs to the orchestrator. We point it at a
 * non-listening port and assert it logs a warning + continues with worktree
 * cleanup rather than failing — this matches the script's documented behavior.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCALE_UP = join(import.meta.dirname, 'scale-up.sh');
const SCALE_DOWN = join(import.meta.dirname, 'scale-down.sh');

type Fixture = {
  rootDir: string;
  sourceRepo: string;
  personasDir: string;
  baseName: string;
};

/** Create a tmp source repo (real git, with develop branch + one commit) and a base persona pointing at it. */
function makeFixture(baseName = 'dev'): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'scale-test-'));
  const sourceRepo = join(rootDir, 'project');
  const personasDir = join(rootDir, 'persistent-agents');

  mkdirSync(sourceRepo, { recursive: true });
  mkdirSync(personasDir, { recursive: true });

  // Init source repo with a default branch named 'develop' so worktree branching works.
  runGit(sourceRepo, ['init', '-q', '-b', 'develop']);
  runGit(sourceRepo, ['config', 'user.email', 'test@example.com']);
  runGit(sourceRepo, ['config', 'user.name', 'Test']);
  writeFileSync(join(sourceRepo, 'README.md'), '# project\n');
  runGit(sourceRepo, ['add', '.']);
  runGit(sourceRepo, ['commit', '-q', '-m', 'init']);

  // Base persona file pointing cwd: at the source repo.
  const personaContent = [
    '---',
    'engine: claude',
    `cwd: ${sourceRepo}`,
    '---',
    `# ${baseName}`,
    '',
    'A test persona.',
    '',
  ].join('\n');
  writeFileSync(join(personasDir, `${baseName}.md`), personaContent);

  return { rootDir, sourceRepo, personasDir, baseName };
}

function cleanupFixture(f: Fixture): void {
  rmSync(f.rootDir, { recursive: true, force: true });
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

function runScaleUp(f: Fixture, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCALE_UP, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PERSONAS_DIR_OVERRIDE: f.personasDir },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function runScaleDown(f: Fixture, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCALE_DOWN, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PERSONAS_DIR_OVERRIDE: f.personasDir,
      // Point destroy at a guaranteed-closed port so the API call fails fast.
      // The script should log a warning and proceed with worktree cleanup.
      ORCHESTRATOR_URL: 'http://127.0.0.1:1',
      // Don't accidentally use the user's real secret in tests.
      SECRET_FILE_OVERRIDE: join(f.rootDir, 'no-such-secret-file'),
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// ─────────────────────────────────────────────────────────────────────────────
// scale-up.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('scale-up.sh — ticket-first mode', () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  afterEach(() => cleanupFixture(f));

  it('creates a worktree on the requested branch and a new persona file', () => {
    const result = runScaleUp(f, ['dev', 'dev-101', 'feature/issue-101']);
    assert.equal(result.status, 0, `scale-up failed:\n${result.stdout}\n${result.stderr}`);

    const worktreePath = join(`${f.sourceRepo}-worktrees`, 'dev-101');
    assert.ok(existsSync(worktreePath), `worktree should exist at ${worktreePath}`);
    assert.ok(existsSync(join(worktreePath, '.git')), 'worktree should be a valid git directory');

    const newPersonaPath = join(f.personasDir, 'dev-101.md');
    assert.ok(existsSync(newPersonaPath), 'new persona file should exist');
    const personaContent = readFileSync(newPersonaPath, 'utf-8');
    assert.match(personaContent, new RegExp(`^cwd: ${worktreePath}$`, 'm'), 'persona cwd should point to the worktree');
  });

  it('respects an explicit base-branch argument', () => {
    // Create another branch in the source repo to fork from.
    runGit(f.sourceRepo, ['checkout', '-b', 'integration']);
    runGit(f.sourceRepo, ['checkout', 'develop']);

    const result = runScaleUp(f, ['dev', 'dev-int', 'feature/from-integration', 'integration']);
    assert.equal(result.status, 0, `scale-up failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /forked from integration/);
  });

  it('reuses an existing branch when it already exists', () => {
    runGit(f.sourceRepo, ['branch', 'feature/preexisting']);

    const result = runScaleUp(f, ['dev', 'dev-pre', 'feature/preexisting']);
    assert.equal(result.status, 0, `scale-up failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Branch 'feature\/preexisting' exists — attaching worktree/);
  });
});

describe('scale-up.sh — pool-first mode', () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  afterEach(() => cleanupFixture(f));

  it('creates a worktree on a `pool/<name>` placeholder branch when no branch arg is given', () => {
    const result = runScaleUp(f, ['dev', 'dev-pool-a']);
    assert.equal(result.status, 0, `scale-up failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /branch 'pool\/dev-pool-a'/);
    assert.match(result.stdout, /Mode:\s+POOL/);

    const worktreePath = join(`${f.sourceRepo}-worktrees`, 'dev-pool-a');
    assert.ok(existsSync(worktreePath), 'pool-mode worktree should exist');

    // Verify the worktree is actually on the pool placeholder branch.
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).stdout.trim();
    assert.equal(branch, 'pool/dev-pool-a');
  });
});

describe('scale-up.sh — input validation', () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  afterEach(() => cleanupFixture(f));

  it('exits non-zero with usage when too few args', () => {
    const result = runScaleUp(f, ['dev']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('errors when base persona does not exist', () => {
    const result = runScaleUp(f, ['nonexistent', 'dev-a', 'feature/x']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Base persona not found/);
  });

  it('refuses to create a duplicate persona', () => {
    const first = runScaleUp(f, ['dev', 'dev-a', 'feature/first']);
    assert.equal(first.status, 0, `first scale-up failed:\n${first.stdout}\n${first.stderr}`);

    const second = runScaleUp(f, ['dev', 'dev-a', 'feature/second']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);
  });

  it('rejects invalid agent names', () => {
    const result = runScaleUp(f, ['dev', 'bad name with spaces', 'feature/x']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be alphanumeric/);
  });

  it('errors when the base persona cwd is not a git repo', () => {
    // Overwrite the base persona to point at a non-git directory.
    const nonGitDir = join(f.rootDir, 'not-a-git-repo');
    mkdirSync(nonGitDir);
    writeFileSync(
      join(f.personasDir, 'dev.md'),
      `---\nengine: claude\ncwd: ${nonGitDir}\n---\n# dev\n`,
    );

    const result = runScaleUp(f, ['dev', 'dev-bad', 'feature/x']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a git repo/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scale-down.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('scale-down.sh — happy path', () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  afterEach(() => cleanupFixture(f));

  it('removes worktree, deletes branch, and removes persona file', () => {
    const up = runScaleUp(f, ['dev', 'dev-teardown', 'feature/teardown']);
    assert.equal(up.status, 0, `scale-up failed:\n${up.stdout}\n${up.stderr}`);

    const worktreePath = join(`${f.sourceRepo}-worktrees`, 'dev-teardown');
    const personaPath = join(f.personasDir, 'dev-teardown.md');
    assert.ok(existsSync(worktreePath));
    assert.ok(existsSync(personaPath));

    const down = runScaleDown(f, ['dev-teardown']);
    assert.equal(down.status, 0, `scale-down failed:\n${down.stdout}\n${down.stderr}`);

    assert.ok(!existsSync(worktreePath), 'worktree should be removed');
    assert.ok(!existsSync(personaPath), 'persona file should be removed');

    // Branch should be gone too (default behavior — no --keep-branch).
    const branchCheck = spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature/teardown'], {
      cwd: f.sourceRepo,
      encoding: 'utf-8',
    });
    assert.notEqual(branchCheck.status, 0, 'branch should be deleted');
  });

  it('preserves the branch when --keep-branch is passed', () => {
    runScaleUp(f, ['dev', 'dev-keep', 'feature/keep-branch']);
    const down = runScaleDown(f, ['dev-keep', '--keep-branch']);
    assert.equal(down.status, 0, `scale-down failed:\n${down.stdout}\n${down.stderr}`);

    const branchCheck = spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature/keep-branch'], {
      cwd: f.sourceRepo,
      encoding: 'utf-8',
    });
    assert.equal(branchCheck.status, 0, 'branch should still exist');
  });
});

describe('scale-down.sh — safety guards', () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  afterEach(() => cleanupFixture(f));

  it('exits non-zero when persona file does not exist', () => {
    const result = runScaleDown(f, ['nonexistent']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Persona file not found/);
  });

  it('refuses to tear down a persona whose cwd is not a scale-up worktree', () => {
    // Manually create a persona whose cwd points OUTSIDE the -worktrees/ pattern.
    writeFileSync(
      join(f.personasDir, 'dummy.md'),
      `---\nengine: claude\ncwd: ${f.sourceRepo}\n---\n# dummy\n`,
    );

    const result = runScaleDown(f, ['dummy']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not look like a scale-up worktree/);
  });

  it('refuses to tear down when the worktree has uncommitted changes (without --force)', () => {
    const up = runScaleUp(f, ['dev', 'dev-dirty', 'feature/dirty']);
    assert.equal(up.status, 0);

    const worktreePath = join(`${f.sourceRepo}-worktrees`, 'dev-dirty');
    writeFileSync(join(worktreePath, 'dirty-change.txt'), 'unstaged content\n');

    const down = runScaleDown(f, ['dev-dirty']);
    assert.notEqual(down.status, 0);
    assert.match(down.stderr, /uncommitted changes/);

    // Worktree should still be intact.
    assert.ok(existsSync(worktreePath));
    assert.ok(existsSync(join(f.personasDir, 'dev-dirty.md')));
  });

  it('discards uncommitted changes when --force is passed', () => {
    runScaleUp(f, ['dev', 'dev-force', 'feature/force']);
    const worktreePath = join(`${f.sourceRepo}-worktrees`, 'dev-force');
    writeFileSync(join(worktreePath, 'dirty-change.txt'), 'unstaged content\n');

    const down = runScaleDown(f, ['dev-force', '--force']);
    assert.equal(down.status, 0, `scale-down --force failed:\n${down.stdout}\n${down.stderr}`);
    assert.ok(!existsSync(worktreePath), 'worktree should be removed with --force');
  });
});
