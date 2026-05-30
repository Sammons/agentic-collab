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
    // a hook field the M1 serializer doesn't emit yet
    assert.equal(structuredRenderable('---\nengine: claude\ncwd: /x\nstart: claude --resume\n---\nb\n'), false);
    // an unknown custom key the serializer will never emit
    assert.equal(structuredRenderable('---\nengine: claude\ncwd: /x\nweird_custom_key: foo\n---\nb\n'), false);
  });
});
