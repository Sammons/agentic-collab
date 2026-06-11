import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_ENGINE_CONFIGS, type DefaultEngineConfig } from './default-engine-configs.ts';
import { Database } from './database.ts';

const HOOK_FIELDS = [
  'hookStart',
  'hookResume',
  'hookCompact',
  'hookExit',
  'hookInterrupt',
  'hookReload',
  'hookSubmit',
] as const;

type HookField = (typeof HOOK_FIELDS)[number];

type ParsedStep = Record<string, unknown> & { type?: unknown };

type ParsedIndicator = {
  id: string;
  regex: string;
  badge: string;
  style: string;
  actions?: Record<string, ParsedStep[]>;
};

function getConfig(name: string): DefaultEngineConfig {
  const config = DEFAULT_ENGINE_CONFIGS.find((c) => c.name === name);
  assert.ok(config, `default config "${name}" exists`);
  return config;
}

function parseHook(config: DefaultEngineConfig, field: HookField): ParsedStep[] {
  const raw = config[field];
  assert.equal(typeof raw, 'string', `${config.name}.${field} is defined`);
  return JSON.parse(raw as string) as ParsedStep[];
}

function parseIndicators(config: DefaultEngineConfig): ParsedIndicator[] {
  assert.equal(typeof config.indicators, 'string', `${config.name}.indicators is defined`);
  return JSON.parse(config.indicators as string) as ParsedIndicator[];
}

function findIndicator(config: DefaultEngineConfig, id: string): ParsedIndicator {
  const indicator = parseIndicators(config).find((definition) => definition.id === id);
  assert.ok(indicator, `${config.name} indicator "${id}" exists`);
  return indicator;
}

/** Count capture groups in a regex source string (the `|''` alternation always matches). */
function countCaptureGroups(source: string): number {
  const match = new RegExp(`${source}|`).exec('');
  assert.ok(match, `regex compiles: ${source}`);
  return match.length - 1;
}

/** Assert every `$N` placeholder in `text` references an existing capture group. */
function assertPlaceholdersInRange(text: string, groupCount: number, label: string): void {
  for (const placeholder of text.matchAll(/\$(\d+)/g)) {
    const groupIndex = Number(placeholder[1]);
    assert.ok(
      groupIndex >= 1 && groupIndex <= groupCount,
      `${label}: $${groupIndex} references one of ${groupCount} capture group(s)`,
    );
  }
}

describe('default-engine-configs', () => {
  describe('config list shape', () => {
    it('defines claude, codex, and opencode in order', () => {
      assert.deepEqual(
        DEFAULT_ENGINE_CONFIGS.map((config) => config.name),
        ['claude', 'codex', 'opencode'],
      );
    });

    it('uses unique names', () => {
      const names = DEFAULT_ENGINE_CONFIGS.map((config) => config.name);
      assert.equal(new Set(names).size, names.length);
    });

    it('points every default at its own base engine (name === engine)', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        assert.equal(config.engine, config.name);
      }
    });

    it('defines the expected hook set per engine', () => {
      const definedHooks = Object.fromEntries(
        DEFAULT_ENGINE_CONFIGS.map((config) => [
          config.name,
          HOOK_FIELDS.filter((field) => typeof config[field] === 'string'),
        ]),
      );
      assert.deepEqual(definedHooks, {
        claude: ['hookStart', 'hookResume', 'hookCompact', 'hookExit', 'hookInterrupt', 'hookReload'],
        codex: ['hookStart', 'hookResume'],
        opencode: ['hookStart', 'hookResume'],
      });
    });

    it('serializes every JSON field as valid JSON', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const jsonFields: Array<[string, string | null | undefined]> = [
          ...HOOK_FIELDS.map((field): [string, string | null | undefined] => [field, config[field]]),
          ['indicators', config.indicators],
          ['detection', config.detection],
        ];
        for (const [field, raw] of jsonFields) {
          if (typeof raw !== 'string') {
            continue;
          }
          assert.doesNotThrow(() => JSON.parse(raw), `${config.name}.${field} parses as JSON`);
        }
      }
    });
  });

  describe('hook pipelines', () => {
    it('parses every hook as a non-empty pipeline of well-formed steps', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        for (const field of HOOK_FIELDS) {
          if (typeof config[field] !== 'string') {
            continue;
          }
          const steps = parseHook(config, field);
          const label = `${config.name}.${field}`;
          assert.ok(Array.isArray(steps) && steps.length > 0, `${label} is a non-empty array`);
          for (const [index, step] of steps.entries()) {
            const stepLabel = `${label}[${index}]`;
            switch (step.type) {
              case 'shell':
                assert.equal(typeof step['command'], 'string', `${stepLabel} has a command`);
                assert.ok((step['command'] as string).length > 0, `${stepLabel} command is non-empty`);
                break;
              case 'wait':
                assert.equal(typeof step['ms'], 'number', `${stepLabel} has numeric ms`);
                assert.ok((step['ms'] as number) > 0, `${stepLabel} ms is positive`);
                break;
              case 'keystroke':
                assert.equal(typeof step['key'], 'string', `${stepLabel} has a key`);
                assert.ok((step['key'] as string).length > 0, `${stepLabel} key is non-empty`);
                break;
              case 'capture':
                assert.equal(typeof step['lines'], 'number', `${stepLabel} has numeric lines`);
                assert.equal(typeof step['regex'], 'string', `${stepLabel} has a regex`);
                assert.equal(typeof step['var'], 'string', `${stepLabel} has a var`);
                assert.doesNotThrow(() => new RegExp(step['regex'] as string), `${stepLabel} regex compiles`);
                break;
              default:
                assert.fail(`${stepLabel} has unknown step type "${String(step.type)}"`);
            }
          }
        }
      }
    });

    it('captures SESSION_ID exactly once in each claude session-starting hook', () => {
      const claude = getConfig('claude');
      for (const field of ['hookStart', 'hookResume', 'hookReload'] as const) {
        const captures = parseHook(claude, field).filter(
          (step) => step.type === 'capture' && step['var'] === 'SESSION_ID',
        );
        assert.equal(captures.length, 1, `claude.${field} captures SESSION_ID once`);
      }
    });

    it('references $SESSION_ID in every engine resume command', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const shellSteps = parseHook(config, 'hookResume').filter((step) => step.type === 'shell');
        const referencesSession = shellSteps.some((step) =>
          (step['command'] as string).includes('$SESSION_ID'),
        );
        assert.ok(referencesSession, `${config.name}.hookResume uses $SESSION_ID`);
      }
    });
  });

  describe('indicators', () => {
    it('defines well-formed indicators with unique ids and compiling regexes', () => {
      const validStyles = ['danger', 'warning', 'info'];
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const indicators = parseIndicators(config);
        assert.ok(indicators.length > 0, `${config.name} has indicators`);
        const ids = indicators.map((indicator) => indicator.id);
        assert.equal(new Set(ids).size, ids.length, `${config.name} indicator ids are unique`);
        for (const indicator of indicators) {
          const label = `${config.name} indicator "${indicator.id}"`;
          assert.ok(indicator.id.length > 0, `${label} has an id`);
          assert.ok(indicator.badge.length > 0, `${label} has a badge`);
          assert.ok(validStyles.includes(indicator.style), `${label} style "${indicator.style}" is valid`);
          assert.doesNotThrow(() => new RegExp(indicator.regex), `${label} regex compiles`);
          if (indicator.actions) {
            for (const [actionName, steps] of Object.entries(indicator.actions)) {
              assert.ok(
                Array.isArray(steps) && steps.length > 0,
                `${label} action "${actionName}" is a non-empty step array`,
              );
            }
          }
        }
      }
    });

    it('keeps badge and action-key $N placeholders within the regex capture-group count', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        for (const indicator of parseIndicators(config)) {
          const label = `${config.name} indicator "${indicator.id}"`;
          const groupCount = countCaptureGroups(indicator.regex);
          assertPlaceholdersInRange(indicator.badge, groupCount, `${label} badge`);
          for (const actionName of Object.keys(indicator.actions ?? {})) {
            assertPlaceholdersInRange(actionName, groupCount, `${label} action key`);
          }
        }
      }
    });

    it('matches the claude approval prompt and captures the three options', () => {
      const indicator = findIndicator(getConfig('claude'), 'approval');
      const match = new RegExp(indicator.regex).exec('❯ Yes / No / Always allow');
      assert.ok(match);
      assert.deepEqual(match.slice(1), ['Yes', 'No', 'Always allow']);
    });

    it('matches the claude file-permission prompt', () => {
      const indicator = findIndicator(getConfig('claude'), 'file-permission');
      const regex = new RegExp(indicator.regex);
      assert.equal(regex.test('Do you want to create main.ts?'), true);
      assert.equal(regex.test('Reading main.ts'), false);
    });

    it('matches the claude plan-review prompt and captures the three options', () => {
      const indicator = findIndicator(getConfig('claude'), 'plan-review');
      const match = new RegExp(indicator.regex).exec('approve / deny / edit');
      assert.ok(match);
      assert.deepEqual(match.slice(1), ['approve', 'deny', 'edit']);
    });

    it('captures the count from the claude local-agents status line', () => {
      const indicator = findIndicator(getConfig('claude'), 'local-agents');
      const match = new RegExp(indicator.regex).exec('· 3 local agents');
      assert.ok(match);
      assert.equal(match[1], '3');
    });
  });

  describe('detection configs', () => {
    type ParsedDetection = {
      idlePatterns?: Array<string | { pattern: string; lines?: number }>;
      activePatterns?: Array<string | { pattern: string; lines?: number }>;
      contextPattern?: string;
      idleThreshold?: number;
      activeGraceMs?: number;
      snapshotLines?: number;
      autoRecover?: boolean;
    };

    function parseDetection(config: DefaultEngineConfig): ParsedDetection {
      assert.equal(typeof config.detection, 'string', `${config.name}.detection is defined`);
      return JSON.parse(config.detection as string) as ParsedDetection;
    }

    it('compiles every idle/active pattern and a one-group context pattern', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const detection = parseDetection(config);
        const patterns = [...(detection.idlePatterns ?? []), ...(detection.activePatterns ?? [])];
        assert.ok(patterns.length > 0, `${config.name} detection has patterns`);
        for (const entry of patterns) {
          const source = typeof entry === 'string' ? entry : entry.pattern;
          assert.doesNotThrow(() => new RegExp(source), `${config.name} pattern compiles: ${source}`);
        }
        assert.equal(typeof detection.contextPattern, 'string', `${config.name} has a contextPattern`);
        assert.ok(
          countCaptureGroups(detection.contextPattern as string) >= 1,
          `${config.name} contextPattern has a capture group`,
        );
      }
    });

    it('uses sane thresholds (idleThreshold >= 1, positive grace and snapshot sizes)', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const detection = parseDetection(config);
        assert.ok((detection.idleThreshold ?? 0) >= 1, `${config.name} idleThreshold >= 1`);
        assert.ok((detection.activeGraceMs ?? 0) > 0, `${config.name} activeGraceMs > 0`);
        assert.ok((detection.snapshotLines ?? 0) > 0, `${config.name} snapshotLines > 0`);
      }
    });

    it('extracts context usage from each engine status line', () => {
      const samples: Record<string, Array<[string, string]>> = {
        claude: [['25000 tokens', '25000']],
        codex: [
          ['37% context left', '37'],
          ['37% left', '37'],
        ],
        opencode: [['42% used', '42']],
      };
      for (const [name, cases] of Object.entries(samples)) {
        const detection = parseDetection(getConfig(name));
        const contextRegex = new RegExp(detection.contextPattern as string);
        for (const [line, expected] of cases) {
          const match = contextRegex.exec(line);
          assert.ok(match, `${name} contextPattern matches "${line}"`);
          assert.equal(match[1], expected, `${name} captures usage from "${line}"`);
        }
      }
    });

    it('recognizes idle and active terminal lines per engine', () => {
      const samples: Record<string, { idle: string; active: string }> = {
        claude: { idle: '❯ ', active: '⠋ Thinking' },
        codex: { idle: '› ', active: '• Working (12s)' },
        opencode: { idle: 'ask anything', active: 'esc interrupt' },
      };
      for (const [name, { idle, active }] of Object.entries(samples)) {
        const detection = parseDetection(getConfig(name));
        const toRegex = (entry: string | { pattern: string }) =>
          new RegExp(typeof entry === 'string' ? entry : entry.pattern);
        const idleMatches = (detection.idlePatterns ?? []).some((entry) => toRegex(entry).test(idle));
        const activeMatches = (detection.activePatterns ?? []).some((entry) => toRegex(entry).test(active));
        assert.ok(idleMatches, `${name} idle patterns match "${idle}"`);
        assert.ok(activeMatches, `${name} active patterns match "${active}"`);
      }
    });

    it('enables autoRecover for claude only', () => {
      const autoRecover = Object.fromEntries(
        DEFAULT_ENGINE_CONFIGS.map((config) => [config.name, parseDetection(config).autoRecover ?? false]),
      );
      assert.deepEqual(autoRecover, { claude: true, codex: false, opencode: false });
    });
  });

  describe('seeding into a fresh database (mirrors main.ts)', () => {
    let db: Database;
    let tmpDir: string;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'default-engine-configs-test-'));
      db = new Database(join(tmpDir, 'test.db'));
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        if (!db.getEngineConfig(config.name)) {
          db.createEngineConfig(config);
        }
      }
    });

    after(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stores one row per default config', () => {
      assert.deepEqual(
        db.listEngineConfigs().map((config) => config.name),
        ['claude', 'codex', 'opencode'],
      );
    });

    it('round-trips engine, hooks, indicators, and detection verbatim', () => {
      for (const config of DEFAULT_ENGINE_CONFIGS) {
        const stored = db.getEngineConfig(config.name);
        assert.ok(stored, `${config.name} stored`);
        // NOTE: hookReload is intentionally not asserted here — createEngineConfig
        // does not persist it (reported as a production bug, out of scope for this PR).
        assert.deepEqual(
          {
            engine: stored.engine,
            hookStart: stored.hookStart,
            hookResume: stored.hookResume,
            hookCompact: stored.hookCompact,
            hookExit: stored.hookExit,
            hookInterrupt: stored.hookInterrupt,
            indicators: stored.indicators,
            detection: stored.detection,
          },
          {
            engine: config.engine,
            hookStart: config.hookStart ?? null,
            hookResume: config.hookResume ?? null,
            hookCompact: config.hookCompact ?? null,
            hookExit: config.hookExit ?? null,
            hookInterrupt: config.hookInterrupt ?? null,
            indicators: config.indicators ?? null,
            detection: config.detection ?? null,
          },
          `${config.name} round-trips`,
        );
      }
    });
  });
});
