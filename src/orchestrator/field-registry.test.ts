import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_FIELDS,
  configColumnMap,
  nestedPersonaKeys,
  mapConfigFromRow,
  configInsertColumns,
  serializeConfigParams,
  configUpsertColumns,
  configUpdateSetClause,
  serializeUpsertParams,
  configFieldsChanged,
  buildUpsertOptsFromFrontmatter,
  buildMigrationStatements,
} from './field-registry.ts';

describe('field-registry', () => {
  describe('CONFIG_FIELDS', () => {
    it('has 20 entries covering all config fields', () => {
      assert.equal(CONFIG_FIELDS.length, 21);
    });

    it('has unique field names', () => {
      const names = CONFIG_FIELDS.map(f => f.name);
      assert.equal(new Set(names).size, names.length);
    });

    it('has unique column names', () => {
      const cols = CONFIG_FIELDS.map(f => f.column);
      assert.equal(new Set(cols).size, cols.length);
    });
  });

  describe('configColumnMap', () => {
    it('produces entries matching current COLUMN_MAP config subset', () => {
      const map = configColumnMap();

      // These are the config fields that appear in the current COLUMN_MAP
      assert.equal(map['agentGroup'], 'agent_group');
      assert.equal(map['account'], 'account');
      assert.equal(map['launchEnv'], 'launch_env');
      assert.equal(map['hookStart'], 'hook_start');
      assert.equal(map['hookResume'], 'hook_resume');
      assert.equal(map['hookCompact'], 'hook_compact');
      assert.equal(map['hookExit'], 'hook_exit');
      assert.equal(map['hookInterrupt'], 'hook_interrupt');
      assert.equal(map['hookSubmit'], 'hook_submit');
      assert.equal(map['hookDetectSession'], 'hook_detect_session');
      assert.equal(map['detectSessionRegex'], 'detect_session_regex');
      assert.equal(map['customButtons'], 'custom_buttons');
      assert.equal(map['indicators'], 'indicators');
    });

    it('includes fields NOT in current COLUMN_MAP that are identity-mapped', () => {
      const map = configColumnMap();
      // These exist in DB but aren't in COLUMN_MAP because column = name
      assert.equal(map['engine'], 'engine');
      assert.equal(map['model'], 'model');
      assert.equal(map['cwd'], 'cwd');
      assert.equal(map['persona'], 'persona');
    });
  });

  describe('nestedPersonaKeys', () => {
    it('produces the same set as current NESTED_FIELDS (minus spawn)', () => {
      const keys = nestedPersonaKeys();
      // Current NESTED_FIELDS: env, start, resume, compact, exit, interrupt, submit, detect_session, spawn
      // Registry produces all except 'env' (json kind, not hook) and 'spawn' (legacy alias, not in registry)
      const expected = new Set(['start', 'resume', 'compact', 'exit', 'interrupt', 'submit', 'detect_session']);
      assert.deepEqual(keys, expected);
    });

    it('does not include env (it is json kind, not nested)', () => {
      const keys = nestedPersonaKeys();
      assert.ok(!keys.has('env'));
    });
  });

  describe('mapConfigFromRow', () => {
    it('deserializes config fields matching mapAgentRow behavior', () => {
      const row: Record<string, unknown> = {
        engine: 'claude',
        model: 'opus',
        thinking: 'high',
        cwd: '/tmp/test',
        persona: 'test-agent.md',
        permissions: null,
        proxy_host: 'proxy1.local',
        agent_group: 'dev',
        launch_env: JSON.stringify({ FOO: 'bar' }),
        hook_start: '{"shell":"/start"}',
        hook_resume: null,
        hook_compact: '/compact',
        hook_exit: null,
        hook_interrupt: null,
        hook_submit: null,
        hook_detect_session: null,
        detect_session_regex: null,
        custom_buttons: '{"compact":[{"type":"shell","command":"/compact"}]}',
        indicators: '[{"id":"test","regex":"foo","badge":"Test","style":"info"}]',
      };

      const result = mapConfigFromRow(row);

      assert.equal(result['engine'], 'claude');
      assert.equal(result['model'], 'opus');
      assert.equal(result['thinking'], 'high');
      assert.equal(result['cwd'], '/tmp/test');
      assert.equal(result['persona'], 'test-agent.md');
      assert.equal(result['permissions'], null);
      assert.equal(result['proxyHost'], 'proxy1.local');
      assert.equal(result['agentGroup'], 'dev');
      assert.deepEqual(result['launchEnv'], { FOO: 'bar' });
      assert.equal(result['hookStart'], '{"shell":"/start"}');
      assert.equal(result['hookResume'], null);
      assert.equal(result['hookCompact'], '/compact');
      // customButtons and indicators pass through as-is (no deserialize)
      assert.equal(result['customButtons'], '{"compact":[{"type":"shell","command":"/compact"}]}');
      assert.equal(result['indicators'], '[{"id":"test","regex":"foo","badge":"Test","style":"info"}]');
    });

    it('skips createOnly fields (proxyId)', () => {
      const row: Record<string, unknown> = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxy_host: null, proxy_id: 'p1',
        agent_group: null, launch_env: null,
        hook_start: null, hook_resume: null, hook_compact: null,
        hook_exit: null, hook_interrupt: null, hook_submit: null,
        hook_detect_session: null, detect_session_regex: null,
        custom_buttons: null, indicators: null,
      };

      const result = mapConfigFromRow(row);
      assert.ok(!('proxyId' in result));
    });

    it('handles null launch_env', () => {
      const row: Record<string, unknown> = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxy_host: null,
        agent_group: null, launch_env: null,
        hook_start: null, hook_resume: null, hook_compact: null,
        hook_exit: null, hook_interrupt: null, hook_submit: null,
        hook_detect_session: null, detect_session_regex: null,
        custom_buttons: null, indicators: null,
      };

      const result = mapConfigFromRow(row);
      assert.equal(result['launchEnv'], null);
    });

    it('handles invalid launch_env JSON', () => {
      const row: Record<string, unknown> = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxy_host: null,
        agent_group: null, launch_env: 'not-json',
        hook_start: null, hook_resume: null, hook_compact: null,
        hook_exit: null, hook_interrupt: null, hook_submit: null,
        hook_detect_session: null, detect_session_regex: null,
        custom_buttons: null, indicators: null,
      };

      const result = mapConfigFromRow(row);
      assert.equal(result['launchEnv'], null);
    });
  });

  describe('configInsertColumns', () => {
    it('matches createAgent INSERT column order', () => {
      const cols = configInsertColumns();
      // Exact order from current createAgent INSERT SQL:
      // name, engine, model, thinking, cwd, persona, permissions, proxy_host, proxy_id, agent_group,
      // launch_env, hook_start, hook_resume, hook_compact, hook_exit, hook_interrupt, hook_submit,
      // hook_detect_session, detect_session_regex, custom_buttons, indicators, state
      // Registry provides everything except 'name' and 'state' (prepended/appended manually)
      const expected = [
        'engine', 'model', 'thinking', 'cwd', 'persona', 'permissions',
        'proxy_host', 'proxy_id', 'agent_group', 'account', 'launch_env',
        'hook_start', 'hook_resume', 'hook_compact', 'hook_exit',
        'hook_interrupt', 'hook_submit', 'hook_detect_session',
        'detect_session_regex', 'custom_buttons', 'indicators',
      ];
      assert.deepEqual(cols, expected);
    });
  });

  describe('configUpsertColumns', () => {
    it('excludes createOnly fields (proxy_id)', () => {
      const cols = configUpsertColumns();
      assert.ok(!cols.includes('proxy_id'));
    });

    it('matches upsertAgentFromPersona UPDATE column order', () => {
      const cols = configUpsertColumns();
      const expected = [
        'engine', 'model', 'thinking', 'cwd', 'persona', 'permissions',
        'proxy_host', 'agent_group', 'account', 'launch_env',
        'hook_start', 'hook_resume', 'hook_compact', 'hook_exit',
        'hook_interrupt', 'hook_submit', 'hook_detect_session',
        'detect_session_regex', 'custom_buttons', 'indicators',
      ];
      assert.deepEqual(cols, expected);
    });
  });

  describe('serializeConfigParams', () => {
    it('produces params matching createAgent for minimal opts', () => {
      const opts = {
        engine: 'claude',
        model: undefined,
        thinking: undefined,
        cwd: '/tmp',
        persona: undefined,
        permissions: undefined,
        proxyHost: undefined,
        proxyId: undefined,
        agentGroup: undefined,
        launchEnv: undefined,
        hookStart: undefined,
        hookResume: undefined,
        hookCompact: undefined,
        hookExit: undefined,
        hookInterrupt: undefined,
        hookSubmit: undefined,
        hookDetectSession: undefined,
        detectSessionRegex: undefined,
        customButtons: undefined,
        indicators: undefined,
      };

      const params = serializeConfigParams(opts);
      assert.equal(params.length, 21); // 21 config fields
      assert.equal(params[0], 'claude'); // engine
      assert.equal(params[1], null);    // model
      assert.equal(params[2], null);    // thinking
      assert.equal(params[3], '/tmp');  // cwd
      assert.equal(params[4], null);    // persona
      // All remaining should be null
      for (let i = 5; i < params.length; i++) {
        assert.equal(params[i], null, `param ${i} should be null`);
      }
    });

    it('serializes launchEnv to JSON', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: null,
        agentGroup: null, account: null, launchEnv: { FOO: 'bar', BAZ: 'qux' },
        hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      const params = serializeConfigParams(opts);
      assert.equal(params[10], JSON.stringify({ FOO: 'bar', BAZ: 'qux' })); // launch_env index
    });

    it('serializes hook values (string passthrough)', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: null,
        agentGroup: null, account: null, launchEnv: null,
        hookStart: '/start', hookResume: null, hookCompact: '/compact',
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      const params = serializeConfigParams(opts);
      assert.equal(params[11], '/start');   // hook_start
      assert.equal(params[13], '/compact'); // hook_compact
      // indices: 0=engine..8=agentGroup, 9=account, 10=launchEnv, 11=hookStart, 13=hookCompact
    });

    it('serializes hook values (object to JSON)', () => {
      const hookObj = { shell: '/exit', env: { A: '1' } };
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: null,
        agentGroup: null, account: null, launchEnv: null,
        hookStart: hookObj, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      const params = serializeConfigParams(opts);
      assert.equal(params[11], JSON.stringify(hookObj)); // hook_start at index 11
    });

    it('serializes customButtons (empty object to null)', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: null,
        agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: {},
        indicators: null,
      };

      const params = serializeConfigParams(opts);
      assert.equal(params[19], null); // custom_buttons at index 19
    });

    it('serializes indicators (empty array to null)', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: null,
        agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null,
        indicators: [],
      };

      const params = serializeConfigParams(opts);
      assert.equal(params[20], null); // indicators at index 20
    });
  });

  describe('serializeUpsertParams', () => {
    it('excludes proxyId (createOnly field)', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null, proxyId: 'p1',
        agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      const params = serializeUpsertParams(opts);
      assert.equal(params.length, 20); // 21 - 1 (proxyId)
      // proxyId value 'p1' should NOT appear
      assert.ok(!params.includes('p1'));
    });

    it('param count matches column count', () => {
      const opts = {
        engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: null, permissions: null, proxyHost: null,
        agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      const cols = configUpsertColumns();
      const params = serializeUpsertParams(opts);
      assert.equal(params.length, cols.length);
    });
  });

  describe('configUpdateSetClause', () => {
    it('generates valid SQL SET clause', () => {
      const clause = configUpdateSetClause();
      const cols = configUpsertColumns();
      const expected = cols.map(c => `${c} = ?`).join(', ');
      assert.equal(clause, expected);
    });

    it('does not contain proxy_id', () => {
      const clause = configUpdateSetClause();
      assert.ok(!clause.includes('proxy_id'));
    });
  });

  describe('configFieldsChanged', () => {
    it('returns false for identical records', () => {
      const record = {
        engine: 'claude', model: 'opus', thinking: 'high', cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: 'dev',
        launchEnv: { FOO: 'bar' },
        hookStart: '/start', hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null,
        hookDetectSession: null, detectSessionRegex: null,
        customButtons: null, indicators: null,
      };

      assert.equal(configFieldsChanged(record, { ...record }), false);
    });

    it('detects engine change', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, engine: 'codex' };

      assert.equal(configFieldsChanged(existing, updated), true);
    });

    it('detects model change (null → value)', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, model: 'opus' };

      assert.equal(configFieldsChanged(existing, updated), true);
    });

    it('detects launchEnv change (deep equality)', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null,
        launchEnv: { FOO: 'bar' },
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, launchEnv: { FOO: 'baz' } };

      assert.equal(configFieldsChanged(existing, updated), true);
    });

    it('returns false for equivalent launchEnv (same keys/values)', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null,
        launchEnv: { FOO: 'bar' },
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, launchEnv: { FOO: 'bar' } };

      assert.equal(configFieldsChanged(existing, updated), false);
    });

    it('treats null and undefined as equivalent', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, model: undefined };

      assert.equal(configFieldsChanged(existing, updated), false);
    });

    it('detects hook value change', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null, launchEnv: null,
        hookStart: '/start', hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, hookStart: '/new-start' };

      assert.equal(configFieldsChanged(existing, updated), true);
    });

    it('detects customButtons change', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        permissions: null, proxyHost: null, agentGroup: null, account: null, launchEnv: null,
        hookStart: null, hookResume: null, hookCompact: null, hookExit: null,
        hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, customButtons: '{"compact":[]}' };

      assert.equal(configFieldsChanged(existing, updated), true);
    });

    it('skips persona field in comparison', () => {
      const existing = { engine: 'claude', model: null, thinking: null, cwd: '/tmp',
        persona: 'old-name', permissions: null, proxyHost: null, agentGroup: null, account: null,
        launchEnv: null, hookStart: null, hookResume: null, hookCompact: null,
        hookExit: null, hookInterrupt: null, hookSubmit: null, hookDetectSession: null,
        detectSessionRegex: null, customButtons: null, indicators: null };
      const updated = { ...existing, persona: 'new-name' };

      assert.equal(configFieldsChanged(existing, updated), false);
    });
  });

  describe('buildUpsertOptsFromFrontmatter', () => {
    it('maps frontmatter keys to AgentRecord keys', () => {
      const fm = {
        engine: 'claude',
        model: 'opus',
        thinking: 'high',
        cwd: '/tmp/agent',
        proxy_host: 'proxy1.local',
        permissions: 'skip',
        group: 'dev-team',
      };

      const opts = buildUpsertOptsFromFrontmatter('my-agent', fm);

      assert.equal(opts['name'], 'my-agent');
      assert.equal(opts['engine'], 'claude');
      assert.equal(opts['model'], 'opus');
      assert.equal(opts['thinking'], 'high');
      assert.equal(opts['cwd'], '/tmp/agent');
      assert.equal(opts['persona'], 'my-agent');
      assert.equal(opts['proxyHost'], 'proxy1.local');
      assert.equal(opts['permissions'], 'skip');
      assert.equal(opts['agentGroup'], 'dev-team');
    });

    it('serializes hook values', () => {
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        start: '/start-command',
        compact: { shell: '/compact' },
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);

      assert.equal(opts['hookStart'], '/start-command');
      assert.equal(opts['hookCompact'], JSON.stringify({ shell: '/compact' }));
    });

    it('handles legacy spawn alias', () => {
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        spawn: '/spawn-command',
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.equal(opts['hookStart'], '/spawn-command');
    });

    it('prefers start over spawn', () => {
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        start: '/start-command',
        spawn: '/spawn-command',
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.equal(opts['hookStart'], '/start-command');
    });

    it('normalizes launchEnv from persona env', () => {
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        env: { GIT_AUTHOR: 'bot', API_KEY: 'secret' },
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.deepEqual(opts['launchEnv'], { GIT_AUTHOR: 'bot', API_KEY: 'secret' });
    });

    it('serializes customButtons', () => {
      const buttons = {
        compact: [{ type: 'shell' as const, command: '/compact' }],
      };
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        custom_buttons: buttons,
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.equal(opts['customButtons'], JSON.stringify(buttons));
    });

    it('serializes indicators', () => {
      const indicators = [
        { id: 'approval', regex: 'approve', badge: 'Needs Approval', style: 'warning' as const },
      ];
      const fm = {
        engine: 'claude',
        cwd: '/tmp',
        indicators,
      };

      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.equal(opts['indicators'], JSON.stringify(indicators));
    });

    it('does not include proxyId (createOnly)', () => {
      const fm = { engine: 'claude', cwd: '/tmp' };
      const opts = buildUpsertOptsFromFrontmatter('test', fm);
      assert.ok(!('proxyId' in opts));
    });
  });

  describe('buildMigrationStatements', () => {
    it('returns ALTER TABLE for all missing columns', () => {
      const existing = new Set<string>(['name', 'state', 'version']);
      const stmts = buildMigrationStatements(existing);

      // Should have one statement per config field
      assert.equal(stmts.length, CONFIG_FIELDS.length);
      assert.ok(stmts.every(s => s.startsWith('ALTER TABLE agents ADD COLUMN')));
    });

    it('returns empty array when all columns exist', () => {
      const existing = new Set(CONFIG_FIELDS.map(f => f.column));
      const stmts = buildMigrationStatements(existing);
      assert.equal(stmts.length, 0);
    });

    it('returns only missing columns', () => {
      const existing = new Set(CONFIG_FIELDS.map(f => f.column));
      existing.delete('indicators');
      existing.delete('custom_buttons');

      const stmts = buildMigrationStatements(existing);
      assert.equal(stmts.length, 2);
      assert.ok(stmts.some(s => s.includes('indicators')));
      assert.ok(stmts.some(s => s.includes('custom_buttons')));
    });
  });
});
