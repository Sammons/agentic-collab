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
  hookSubmit?: string | null;
  indicators?: string | null;
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
const LOGGED_OUT_INDICATOR = { id: 'logged-out', regex: 'Not logged in', badge: 'Logged Out', style: 'danger' };

export const DEFAULT_ENGINE_CONFIGS: DefaultEngineConfig[] = [
  {
    name: 'claude',
    engine: 'claude',
    model: 'opus',
    thinking: 'high',
    permissions: 'dangerously-skip',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'claude --dangerously-skip-permissions --model opus --effort max --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'claude --resume $SESSION_ID --append-system-prompt $PERSONA_PROMPT' },
      { type: 'wait', ms: 5000 },
      { type: 'shell', command: '/status' },
      { type: 'capture', lines: 30, regex: 'uuid', var: 'SESSION_ID' },
      { type: 'keystroke', key: 'Escape' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
      CLAUDE_APPROVAL_INDICATOR,
      CLAUDE_PLAN_INDICATOR,
      LOW_CONTEXT_INDICATOR,
      CONTEXT_LIMIT_INDICATOR,
      LOGGED_OUT_INDICATOR,
    ]),
  },
  {
    name: 'codex',
    engine: 'codex',
    model: 'gpt-4.1',
    hookStart: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME' },
    ]),
    hookResume: JSON.stringify([
      { type: 'shell', command: 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -p $AGENT_NAME resume $SESSION_ID' },
    ]),
    indicators: JSON.stringify([
      UNSAFE_INDICATOR,
    ]),
  },
  {
    name: 'opencode',
    engine: 'opencode',
    model: 'sonnet',
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
  },
];
