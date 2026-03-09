/**
 * Engine adapter interface. Each AI harness (claude, codex, opencode)
 * gets a concrete implementation.
 */

export type IdleState = 'waiting_for_input' | 'running_tool' | 'streaming' | 'unknown';

/** Braille spinner characters used by CLI tools to indicate activity. */
export const SPINNER_REGEX = /^⠋|^⠙|^⠹|^⠸|^⠼|^⠴|^⠦|^⠧|^⠇|^⠏/;

export type ContextResult = {
  contextPct: number | null;
  confident: boolean;
};

export type SpawnOptions = {
  name: string;
  cwd: string;
  model?: string;
  thinking?: string;
  task?: string;
  appendSystemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  /** Pre-generated session ID for engines that support it (e.g. Claude --session-id). */
  sessionId?: string;
};

export type ResumeOptions = {
  name: string;
  sessionId?: string;
  cwd: string;
  task?: string;
  appendSystemPrompt?: string;
};

export interface EngineAdapter {
  /** Engine identifier */
  readonly engine: string;

  /**
   * Whether this engine buffers pasted input while active.
   * If true, messages can be delivered even when the agent is not idle —
   * the CLI will process them when the current task finishes.
   */
  readonly canDeliverWhileActive: boolean;

  /**
   * Whether the CLI accepts a prompt as a positional argument to the resume command.
   * If true, reload tasks are passed inline (e.g. `codex resume <id> "task"`)
   * instead of being pasted separately into the tmux pane.
   */
  readonly supportsResumePrompt: boolean;

  /**
   * Whether this engine uses a config profile for system prompt injection.
   * When true, the orchestrator must dispatch a write_codex_profile action
   * to the proxy BEFORE pasting the spawn/resume command.
   * Defaults to false when not implemented.
   */
  readonly usesConfigProfile?: boolean;

  /** Build the shell command to spawn a new agent session */
  buildSpawnCommand(opts: SpawnOptions): string;

  /** Build the shell command to resume an existing session */
  buildResumeCommand(opts: ResumeOptions): string;

  /** Detect whether the agent is idle from captured pane output */
  detectIdleState(paneOutput: string): IdleState;

  /** Parse context usage percentage from captured pane output */
  parseContextPercent(paneOutput: string): ContextResult;

  /** Build the engine-specific exit command */
  buildExitCommand(): string;

  /** Build the engine-specific compact command */
  buildCompactCommand(): string;

  /** Build the rename command (if supported) */
  buildRenameCommand(name: string): string | null;

  /** Keys to send to interrupt/cancel the current operation */
  interruptKeys(): string[];

  /**
   * Keys to send for exiting the session (alternative to buildExitCommand paste).
   * When defined, the lifecycle sends these keys instead of pasting buildExitCommand().
   * Used by TUI-based engines where exit is a keystroke (e.g. Ctrl-C) not a typed command.
   */
  exitKeys?(): string[];

  /**
   * Keys to send for compacting context (alternative to buildCompactCommand paste).
   * When defined, the lifecycle sends these keys instead of pasting buildCompactCommand().
   * Used by TUI-based engines where compact is a key chord (e.g. Ctrl-X C).
   */
  compactKeys?(): string[];

  /**
   * Extract session ID from pane output after spawn.
   * Used by engines that don't support pre-set session IDs (e.g. Codex).
   * Returns the session ID string, or null if not found/not applicable.
   */
  extractSessionId(paneOutput: string): string | null;
}
