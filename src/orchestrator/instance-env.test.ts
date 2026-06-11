import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allocateIpcPaths,
  buildHostShellEnv,
  buildTmuxSessionEnv,
  TMUX_SAFE_ENV_KEYS,
  type BuildEnvOpts,
} from './instance-env.ts';

function makeOpts(overrides: Partial<BuildEnvOpts> = {}): BuildEnvOpts {
  return {
    messageId: 'msg-1',
    messagePath: '/ipc/inst-1/message',
    replyPath: '/ipc/inst-1/reply',
    statusPath: '/ipc/inst-1/status',
    worktreePath: '/work/inst-1',
    cwdBase: '/repos/base',
    repoRoot: '/repos/base',
    agentTemplate: 'builder',
    topicName: 'builds',
    instanceAddr: 'agent:builder/inst-1',
    replyToAddr: 'agent:lead/main',
    instanceId: 'inst-1',
    messageContent: '{"task":"build"}',
    ...overrides,
  };
}

describe('instance-env', () => {
  describe('allocateIpcPaths', () => {
    let tmpDir: string;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'instance-env-test-'));
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns message/reply/status paths under <ipcRoot>/<instanceId>', () => {
      const paths = allocateIpcPaths('inst-a', tmpDir);
      assert.deepEqual(paths, {
        messagePath: join(tmpDir, 'inst-a', 'message'),
        replyPath: join(tmpDir, 'inst-a', 'reply'),
        statusPath: join(tmpDir, 'inst-a', 'status'),
      });
    });

    it('creates empty reply and status sentinel files but not the message file', () => {
      const paths = allocateIpcPaths('inst-b', tmpDir);
      assert.equal(readFileSync(paths.replyPath, 'utf-8'), '');
      assert.equal(readFileSync(paths.statusPath, 'utf-8'), '');
      assert.equal(existsSync(paths.messagePath), false);
    });

    it('creates a missing ipcRoot recursively', () => {
      const nestedRoot = join(tmpDir, 'not', 'yet', 'created');
      const paths = allocateIpcPaths('inst-c', nestedRoot);
      assert.equal(existsSync(paths.replyPath), true);
      assert.equal(existsSync(paths.statusPath), true);
    });

    it('re-allocating the same instance re-writes the sentinel files empty', () => {
      const first = allocateIpcPaths('inst-d', tmpDir);
      writeFileSync(first.replyPath, '{"done":true}');
      writeFileSync(first.statusPath, 'ok');

      const second = allocateIpcPaths('inst-d', tmpDir);
      assert.deepEqual(second, first);
      assert.equal(readFileSync(second.replyPath, 'utf-8'), '');
      assert.equal(readFileSync(second.statusPath, 'utf-8'), '');
    });

    it('gives distinct instances distinct directories', () => {
      const one = allocateIpcPaths('inst-e', tmpDir);
      const two = allocateIpcPaths('inst-f', tmpDir);
      assert.notEqual(one.messagePath, two.messagePath);
      assert.notEqual(one.replyPath, two.replyPath);
      assert.notEqual(one.statusPath, two.statusPath);
    });
  });

  describe('buildHostShellEnv', () => {
    it('maps every opt onto the flat env contract', () => {
      const env = buildHostShellEnv(makeOpts());
      assert.deepEqual(env, {
        MESSAGE_ID: 'msg-1',
        MESSAGE_PATH: '/ipc/inst-1/message',
        REPLY_PATH: '/ipc/inst-1/reply',
        STATUS_PATH: '/ipc/inst-1/status',
        MESSAGE_CONTENT: '{"task":"build"}',
        WORKTREE_PATH: '/work/inst-1',
        CWD_BASE: '/repos/base',
        REPO_ROOT: '/repos/base',
        AGENT_TEMPLATE: 'builder',
        TOPIC_NAME: 'builds',
        INSTANCE_ADDR: 'agent:builder/inst-1',
        REPLY_TO_ADDR: 'agent:lead/main',
        INSTANCE_ID: 'inst-1',
      });
    });

    it('maps null replyToAddr to an empty string', () => {
      const env = buildHostShellEnv(makeOpts({ replyToAddr: null }));
      assert.equal(env['REPLY_TO_ADDR'], '');
    });

    it('preserves message content verbatim including newlines and control chars', () => {
      const content = '{"task":"multi\nline"}\n\ttab\x1b[0m';
      const env = buildHostShellEnv(makeOpts({ messageContent: content }));
      assert.equal(env['MESSAGE_CONTENT'], content);
    });
  });

  describe('TMUX_SAFE_ENV_KEYS', () => {
    it('excludes MESSAGE_CONTENT and TARGET_TMUX_SESSION', () => {
      const keys: readonly string[] = TMUX_SAFE_ENV_KEYS;
      assert.equal(keys.includes('MESSAGE_CONTENT'), false);
      assert.equal(keys.includes('TARGET_TMUX_SESSION'), false);
    });

    it('includes MESSAGE_PATH so agents can read the payload from disk', () => {
      const keys: readonly string[] = TMUX_SAFE_ENV_KEYS;
      assert.equal(keys.includes('MESSAGE_PATH'), true);
    });
  });

  describe('buildTmuxSessionEnv', () => {
    it('strips MESSAGE_CONTENT and keeps every tmux-safe key', () => {
      const hostEnv = buildHostShellEnv(makeOpts());
      const tmuxEnv = buildTmuxSessionEnv(hostEnv);
      assert.deepEqual(tmuxEnv, {
        MESSAGE_ID: 'msg-1',
        MESSAGE_PATH: '/ipc/inst-1/message',
        REPLY_PATH: '/ipc/inst-1/reply',
        STATUS_PATH: '/ipc/inst-1/status',
        WORKTREE_PATH: '/work/inst-1',
        CWD_BASE: '/repos/base',
        REPO_ROOT: '/repos/base',
        AGENT_TEMPLATE: 'builder',
        TOPIC_NAME: 'builds',
        INSTANCE_ADDR: 'agent:builder/inst-1',
        REPLY_TO_ADDR: 'agent:lead/main',
        INSTANCE_ID: 'inst-1',
      });
    });

    it('strips keys that are not in the safe list', () => {
      const tmuxEnv = buildTmuxSessionEnv({
        MESSAGE_ID: 'msg-2',
        SOME_RANDOM_KEY: 'nope',
        PATH: '/usr/bin',
      });
      assert.deepEqual(tmuxEnv, { MESSAGE_ID: 'msg-2' });
    });

    it('omits safe keys absent from the host env', () => {
      const tmuxEnv = buildTmuxSessionEnv({ INSTANCE_ID: 'inst-9' });
      assert.deepEqual(tmuxEnv, { INSTANCE_ID: 'inst-9' });
    });

    it('preserves empty-string values for keys present in the host env', () => {
      const hostEnv = buildHostShellEnv(makeOpts({ replyToAddr: null }));
      const tmuxEnv = buildTmuxSessionEnv(hostEnv);
      assert.equal(tmuxEnv['REPLY_TO_ADDR'], '');
      assert.equal('REPLY_TO_ADDR' in tmuxEnv, true);
    });

    it('appends TARGET_TMUX_SESSION when a target session is provided', () => {
      const tmuxEnv = buildTmuxSessionEnv(
        { MESSAGE_ID: 'msg-3' },
        { targetTmuxSession: 'collab-worker-1' },
      );
      assert.deepEqual(tmuxEnv, {
        MESSAGE_ID: 'msg-3',
        TARGET_TMUX_SESSION: 'collab-worker-1',
      });
    });

    it('omits TARGET_TMUX_SESSION when no opts are passed', () => {
      const tmuxEnv = buildTmuxSessionEnv({ MESSAGE_ID: 'msg-4' });
      assert.deepEqual(tmuxEnv, { MESSAGE_ID: 'msg-4' });
    });

    it('omits TARGET_TMUX_SESSION for an empty-string target session', () => {
      const tmuxEnv = buildTmuxSessionEnv(
        { MESSAGE_ID: 'msg-5' },
        { targetTmuxSession: '' },
      );
      assert.deepEqual(tmuxEnv, { MESSAGE_ID: 'msg-5' });
    });
  });
});
