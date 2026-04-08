/**
 * Default engine config definitions.
 * Used for initial seeding and the "Reset Defaults" action.
 */

export type DefaultEngineConfig = {
  name: string;
  engine: string;
  model?: string | null;
  thinking?: string | null;
  permissions?: string | null;
  hookStart?: string | null;
  hookResume?: string | null;
  hookCompact?: string | null;
  hookExit?: string | null;
  hookInterrupt?: string | null;
  hookReload?: string | null;
  hookSubmit?: string | null;
  indicators?: string | null;
  detection?: string | null;
  launchEnv?: Record<string, string> | null;
};

// Shared indicator definitions
const UNSAFE_INDICATOR = { id: 'unsafe', regex: '.', badge: 'Unsafe', style: 'danger' };
const LOW_CONTEXT_INDICATOR = { id: 'low-context', regex: 'Context left until', badge: 'Low Context', style: 'danger' };
const CONTEXT_LIMIT_INDICATOR = { id: 'context-limit', regex: 'Context limit reached', badge: 'Context Limit', style: 'danger' };
const CLAUDE_APPROVAL_INDICATOR = {
  id: 'approval',
  regex: '(Yes)\\s*/\\s*(No)\\s*/\\s*(Always allow)',
  badge: 'Needs Approval',
  style: 'warning',
  actions: {
    '$1': [{ type: 'keystroke', keystroke: '$1' }],
    '$2': [{ type: 'keystroke', keystroke: '$2' }],
    '$3': [{ type: 'keystroke', keystroke: '$3' }],
  },
};
const CLAUDE_PLAN_INDICATOR = {
  id: 'plan-review',
  regex: '(approve)\\s*/\\s*(deny)\\s*/\\s*(edit)',
  badge: 'Plan Review',
  style: 'warning',
  actions: {
    '$1': [{ type: 'keystroke', keystroke: '$1' }],
    '$2': [{ type: 'keystroke', keystroke: '$2' }],
    '$3': [{ type: 'keystroke', keystroke: '$3' }],
  },
};
const CLAUDE_RESUME_PROMPT_INDICATOR = {
  id: 'resume-prompt',
  regex: 'Resume from summary',
  badge: 'Resume Prompt',
  style: 'warning',
  actions: {
    'Summary': [{ type: 'keystroke', keystroke: 'Enter' }],
    'Full': [{ type: 'keystroke', keystroke: 'Down' }, { type: 'keystroke', keystroke: 'Enter' }],
  },
};
const LOGGED_OUT_INDICATOR = { id: 'logged-out', regex: 'Not logged in', badge: 'Logged Out', style: 'danger' };
const LOCAL_AGENTS_INDICATOR = { id: 'local-agents', regex: '\\u00b7\\s*(\\d+) local agents?', badge: '$1 Local Agents', style: 'info' };

// Detection configs per engine — regex patterns for idle/active state detection
const CLAUDE_DETECTION = {
  idlePatterns: [
    { pattern: '^[\\u276f>]\\s*$', lines: 5 },            // prompt waiting for input (❯ or >)
  ],
  activePatterns: [
    '^\\s*(Read|Write|Edit|Bash|Glob|Grep|Agent|WebFetch|WebSearch)\\s',  // tool execution
    '^[\\u280b\\u2819\\u2839\\u2838\\u283c\\u2834\\u2826\\u2827\\u2807\\u280f]',  // braille spinner
    { pattern: '\\u00b7\\s*\\d+ local agents?', lines: 3 },  // sub-agents (status bar only)
  ],
  contextPattern: '(\\d+)\\s*tokens',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
  autoRecover: true,
};

const CODEX_DETECTION = {
  idlePatterns: [
    { pattern: '^[\\u203a\\u276f>]\\s', lines: 5 },       // prompt chars (›, ❯, >)
    { pattern: '^[\\u203a\\u276f>]\\s*$', lines: 5 },     // prompt at end of line
  ],
  activePatterns: [
    '^[\\u25e6\\u2022]\\s*Working', // working indicator (◦/• Working)
  ],
  contextPattern: '(\\d+)%\\s+(?:context\\s+)?left',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
};

const OPENCODE_DETECTION = {
  idlePatterns: [
    { pattern: 'ctrl\\+t\\s+variants', lines: 3 },        // idle TUI hint
    { pattern: 'ask anything', lines: 3 },                 // input placeholder
  ],
  activePatterns: [
    { pattern: 'esc\\s+interrupt', lines: 3 },             // processing indicator
  ],
  contextPattern: '(\\d+)%\\s+used',
  idleThreshold: 2,
  activeGraceMs: 10000,
  snapshotLines: 30,
};

export const DEFAULT_ENGINE_CONFIGS: DefaultEngineConfig[] = [
  {
    name: 'claude',
    engine: 'claude',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'claude --resume $SESSION_ID --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookCompact: JSON.stringify([
      { type: 'shell', command: '/compact' },
    ]),
    hookExit: JSON.stringify([
      { type: 'shell', command: '/exit' },
    ]),
    hookInterrupt: JSON.stringify([
      { type: 'keystroke', key: 'Escape' },
      { type: 'keystroke', key: 'Escape' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookReload: JSON.stringify([
      { type: 'shell', command: '/exit' },
      { type: 'wait', ms: 10000 },
      { type: 'shell', command: 'claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 500 },
      { type: 'keystroke', key: 'Enter' },
      { type: 'wait', ms: 1000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
      CLAUDE_APPROVAL_INDICATOR,
      CLAUDE_PLAN_INDICATOR,
      CLAUDE_RESUME_PROMPT_INDICATOR,
      LOW_CONTEXT_INDICATOR,
      CONTEXT_LIMIT_INDICATOR,
      LOGGED_OUT_INDICATOR,
      LOCAL_AGENTS_INDICATOR,
    ]),
    detection: JSON.stringify(CLAUDE_DETECTION),
  },
  {
    name: 'codex',
    engine: 'codex',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME resume $SESSION_ID' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
    ]),
    detection: JSON.stringify(CODEX_DETECTION),
  },
  {
    name: 'opencode',
    engine: 'opencode',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'opencode' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'opencode -s $SESSION_ID' },
    ]),
    indicators: JSON.stringify([
      LOW_CONTEXT_INDICATOR,
      CONTEXT_LIMIT_INDICATOR,
    ]),
    detection: JSON.stringify(OPENCODE_DETECTION),
  },
];
