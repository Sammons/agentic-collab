import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { parseFrontmatter, serializeFrontmatter, structuredRenderable } from './persona.ts';

/** Assert parse(serialize(parse(raw))) === parse(raw) — the round-trip invariant. */
function roundTrips(raw: string): boolean {
  const fm = parseFrontmatter(raw).frontmatter;
  const re = parseFrontmatter(`---\n${serializeFrontmatter(fm)}\n---\n`).frontmatter;
  return isDeepStrictEqual(fm, re);
}

describe('serializeFrontmatter round-trip (M1: scalars, teams, env)', () => {
  it('round-trips scalars', () => {
    const raw = '---\nicon: 🎛️\nengine: claude-with-home\nmodel: claude-opus-4-8\nthinking: high\ncwd: /home/x/proj\npermissions: skip\ngroup: infra\naccount: ben\nproxy: bladerunner\n---\nbody\n';
    assert.ok(roundTrips(raw));
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips teams (incl. empty)', () => {
    assert.ok(roundTrips('---\nengine: claude\ncwd: /x\nteams: [advisors, infra]\n---\nb\n'));
    assert.ok(roundTrips('---\nengine: claude\ncwd: /x\nteams: []\n---\nb\n'));
  });

  it('round-trips env (nested key/value)', () => {
    const raw = '---\nengine: claude\ncwd: /x\nenv:\n  GIT_AUTHOR_NAME: Ben\n  FOO: bar\n---\nb\n';
    assert.ok(roundTrips(raw), 'env round-trips');
    assert.ok(structuredRenderable(raw));
  });

  it('structuredRenderable = false for unsupported shapes (→ advanced mode)', () => {
    // an unknown custom key the serializer will never emit
    assert.equal(structuredRenderable('---\nengine: claude\ncwd: /x\nweird_custom_key: foo\n---\nb\n'), false);
    // a structured-hook object (preset/shell/send/keystrokes) — not handled by the editor
    assert.equal(structuredRenderable('---\nengine: claude\ncwd: /x\nstart:\n  shell: /compact\n---\nb\n'), false);
    // topics is template-only — stays advanced
    assert.equal(structuredRenderable('---\nengine: claude\ncwd: /x\ntopics:\n  - name: foo\n    concurrency: 3\n---\nb\n'), false);
  });
});

describe('serializeFrontmatter round-trip (M2: hooks + custom_buttons)', () => {
  it('round-trips a flat-string hook', () => {
    const raw = '---\nengine: claude\ncwd: /x\nstart: claude --resume\n---\nb\n';
    assert.ok(roundTrips(raw));
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips a multi-line (block-scalar) hook', () => {
    const raw = '---\nengine: claude\ncwd: /x\nstart: |\n  if [ -n "$MESSAGE_PATH" ]; then\n    claude --print "$MESSAGE_PATH"\n  fi\n---\nb\n';
    assert.ok(roundTrips(raw), 'block scalar hook round-trips');
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips a pipeline hook (shell + keystrokes + keystroke + wait)', () => {
    const raw = [
      '---', 'engine: claude', 'cwd: /x', 'compact:',
      '  - shell: /compact',
      '  - keystrokes:',
      '    - keystroke: Enter',
      '  - keystroke: Escape',
      '  - wait: 200',
      '---', 'b', '',
    ].join('\n');
    assert.ok(roundTrips(raw), 'pipeline hook round-trips');
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips a keystrokes action with post_wait_ms + a capture step', () => {
    const raw = [
      '---', 'engine: claude', 'cwd: /x', 'resume:',
      '  - keystrokes:',
      '    - text: codex resume',
      '      post_wait_ms: 150',
      '  - capture:',
      '    lines: 50',
      '    regex: codex resume ([0-9a-f-]+)',
      '    var: SESSION_ID',
      '---', 'b', '',
    ].join('\n');
    assert.ok(roundTrips(raw), 'post_wait_ms + capture round-trips');
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips custom_buttons (named pipelines)', () => {
    const raw = [
      '---', 'engine: claude', 'cwd: /x', 'custom_buttons:',
      '  compact-now:',
      '    - shell: /compact',
      '    - keystrokes:',
      '      - keystroke: Enter',
      '  clear:',
      '    - keystroke: Escape',
      '    - shell: /clear',
      '---', 'b', '',
    ].join('\n');
    assert.ok(roundTrips(raw), 'custom_buttons round-trips');
    assert.ok(structuredRenderable(raw));
  });

  it('round-trips scalars + teams + env + hook + custom_buttons together', () => {
    const raw = [
      '---', 'icon: 🎛️', 'engine: claude-with-home', 'cwd: /x', 'group: infra',
      'env:', '  FOO: bar',
      'start: claude --resume',
      'custom_buttons:', '  go:', '    - shell: /go',
      'teams: [infra, general]',
      '---', 'b', '',
    ].join('\n');
    assert.ok(roundTrips(raw), 'combined round-trips');
    assert.ok(structuredRenderable(raw));
  });
});
