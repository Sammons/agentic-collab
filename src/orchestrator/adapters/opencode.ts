/**
 * OpenCode CLI adapter — persistent TUI mode.
 *
 * OpenCode v1.2.x behavior (validated 2026-03-08 via tmux TUI testing):
 *   - `opencode` — launches full-screen Bubble Tea TUI (persistent session)
 *   - `opencode -s <id>` — resumes specific session in TUI mode
 *   - `opencode -c` — resumes last session in TUI mode
 *   - `opencode -m <model>` — selects model at launch
 *   - thinking variant is NOT a launch flag for the TUI: `--variant` is defined
 *     only on the `opencode run` subcommand (cli/cmd/run.ts), not on the TUI
 *     command (cli/cmd/tui.ts, which exposes only model/session/continue/fork/
 *     agent/prompt/project). The TUI selects variants interactively via
 *     `ctrl+t variants`. See buildSpawnCommand for the drop and citation.
 *
 * System prompt injection (validated 2026-06-11 against the sst/opencode
 * v1.17.3 release binary via `opencode debug config`):
 *   - The proxy writes the composed prompt to
 *     ~/.config/opencode/collab/<agent-name>.md (write_opencode_instructions).
 *   - The spawn/resume command carries an env-var prefix:
 *     OPENCODE_CONFIG_CONTENT='{"instructions":["~/.config/opencode/collab/<name>.md"]}'
 *   - OpenCode merges OPENCODE_CONFIG_CONTENT LAST over global + project
 *     config, CONCATENATING `instructions` arrays (config.ts mergeConfigConcatArrays,
 *     https://github.com/sst/opencode/blob/v1.17.3/packages/opencode/src/config/config.ts#L467).
 *   - Instruction files are APPENDED to the system prompt after the provider
 *     default; `~/` expands to $HOME (session/instruction.ts#L138,
 *     session/llm/request.ts#L58 at the same tag).
 *   - Custom agents (`~/.config/opencode/agents/<name>.md` + `--agent`) were
 *     REJECTED for persona injection: an agent's `prompt` REPLACES the
 *     provider default system prompt (llm/request.ts:
 *     `input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(...)`),
 *     which is replace semantics, not the append semantics appendSystemPrompt
 *     promises. AGENTS.md / project opencode.json were rejected because they
 *     leak across every session in the cwd instead of binding to one agent.
 *
 * TUI interaction patterns (all via tmux send-keys):
 *   - Input: type message + Enter to submit
 *   - Compact: Ctrl-X then C (chord sequence)
 *   - Exit: Ctrl-C (prints session ID on exit: "Continue  opencode -s ses_xxx")
 *   - Rename: Ctrl-R then type name + Enter
 *   - Interrupt: Escape
 *   - Command palette: Ctrl-P
 *
 * Idle detection:
 *   - Active: "esc interrupt" visible in bottom-left of pane
 *   - Idle: "esc interrupt" absent, input box ready
 *
 * Context parsing:
 *   - Sidebar shows "NNN tokens" and "N% used"
 *
 * Session IDs:
 *   - On exit (Ctrl-C), OpenCode prints: "Continue  opencode -s ses_xxx"
 *   - Format: ses_[a-zA-Z0-9]{20,}
 */

import { SPINNER_REGEX, type EngineAdapter, type SpawnOptions, type ResumeOptions, type IdleState, type ContextResult } from './types.ts';
import { shellQuote, OPENCODE_COLLAB_INSTRUCTIONS_DIR } from '../../shared/utils.ts';
import type { ProxyCommand } from '../../shared/types.ts';

export class OpenCodeAdapter implements EngineAdapter {
  readonly engine = 'opencode';
  readonly supportsResumePrompt = false;

  /**
   * System prompt injection via per-agent instructions file + env-var prefix
   * (see header). The orchestrator dispatches buildProfileWriteCommand() to
   * the proxy BEFORE pasting the spawn/resume command.
   */
  readonly usesConfigProfile = true;

  buildProfileWriteCommand(profileName: string, systemPrompt: string) {
    return {
      action: 'write_opencode_instructions',
      agentName: profileName,
      content: systemPrompt,
    } as const satisfies ProxyCommand;
  }

  buildProfileRemoveCommand(profileName: string) {
    return {
      action: 'remove_opencode_instructions',
      agentName: profileName,
    } as const satisfies ProxyCommand;
  }

  /**
   * Env-var prefix pointing OpenCode at the per-agent instructions file the
   * proxy wrote. The JSON only embeds the agent name (validated [a-zA-Z0-9_-]
   * by the proxy writer), so shellQuote covers every quoting hazard; the
   * prompt body itself never passes through the shell.
   */
  #instructionsEnvPrefix(agentName: string): string {
    const configContent = JSON.stringify({
      instructions: [`~/${OPENCODE_COLLAB_INSTRUCTIONS_DIR}/${agentName}.md`],
    });
    return `OPENCODE_CONFIG_CONTENT=${shellQuote(configContent)}`;
  }

  buildSpawnCommand(opts: SpawnOptions): string {
    const parts = ['opencode'];

    if (opts.model) {
      parts.push('-m', opts.model);
    }

    // opts.thinking is intentionally NOT emitted. The `--variant` flag was
    // removed from the TUI launch command in sst/opencode: as of v1.17.3 it
    // lives only on the `opencode run` subcommand (cli/cmd/run.ts), while the
    // TUI command (cli/cmd/tui.ts) accepts only model/session/continue/fork/
    // agent/prompt/project. Passing `--variant` to the bare `opencode` TUI is
    // an unknown yargs flag and errors the launch. Thinking-variant selection
    // for the persistent TUI is interactive (ctrl+t cycles variants), so it is
    // not selectable at launch for OpenCode — opts.thinking is a no-op here.

    if (opts.appendSystemPrompt) {
      parts.unshift(this.#instructionsEnvPrefix(opts.name));
    }

    return parts.join(' ');
  }

  buildResumeCommand(opts: ResumeOptions): string {
    const parts = ['opencode'];

    if (opts.sessionId) {
      parts.push('-s', opts.sessionId);
    } else {
      // -c does not reliably resume in TUI mode (may create a new empty session).
      // Without a session ID, launch a fresh TUI. The orchestrator should always
      // have a session ID from extractSessionId() after exit.
      // Fall through to plain 'opencode' — better than a broken -c resume.
    }

    if (opts.appendSystemPrompt) {
      parts.unshift(this.#instructionsEnvPrefix(opts.name));
    }

    return parts.join(' ');
  }

  detectIdleState(paneOutput: string): IdleState {
    const lines = paneOutput.split('\n');

    // Scan bottom-up for TUI state indicators.
    // "esc interrupt" in the bottom-left means the engine is active/generating.
    // Its absence means the input box is ready for the next message.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      // Active: "esc interrupt" visible during generation
      if (/esc\s+interrupt/i.test(line)) return 'running_tool';
      // Spinner in output area
      if (SPINNER_REGEX.test(line)) return 'running_tool';
      // Status bar with "ctrl+t variants" indicates idle TUI with input ready
      if (/ctrl\+t\s+variants/i.test(line)) return 'waiting_for_input';
      // "Ask anything" placeholder in input box — idle
      if (/ask anything/i.test(line)) return 'waiting_for_input';

      break;
    }

    // Fallback: scan more broadly (not just last non-empty line)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i]!.trim();
      if (/esc\s+interrupt/i.test(line)) return 'running_tool';
      if (/ctrl\+t\s+variants/i.test(line)) return 'waiting_for_input';
      if (/ctrl\+p\s+commands/i.test(line)) return 'waiting_for_input';
    }

    return 'unknown';
  }

  parseContextPercent(paneOutput: string): ContextResult {
    // OpenCode TUI sidebar shows "N% used"
    const pctMatch = paneOutput.match(/(\d+)%\s+used/);
    if (pctMatch) {
      return { contextPct: parseInt(pctMatch[1]!, 10), confident: true };
    }

    // Also shows "NNN tokens" — estimate percentage from token count
    const tokenMatch = paneOutput.match(/([\d,]+)\s+tokens/);
    if (tokenMatch) {
      const tokens = parseInt(tokenMatch[1]!.replace(/,/g, ''), 10);
      const maxTokens = 200_000; // estimated context window
      const pct = Math.min(100, Math.round((tokens / maxTokens) * 100));
      return { contextPct: pct, confident: false }; // confident: false since we don't know exact max
    }

    return { contextPct: null, confident: false };
  }

  buildExitCommand(): string {
    // Fallback for paste-based delivery. In practice, exitKeys() is used instead.
    return '/exit';
  }

  exitKeys(): string[] {
    // Ctrl-C exits the TUI cleanly and prints session ID for resume
    return ['C-c'];
  }

  buildCompactCommand(): string {
    // Fallback for paste-based delivery. In practice, compactKeys() is used instead.
    return '/compact';
  }

  compactKeys(): string[] {
    // Ctrl-X then C triggers "Compact session" in the TUI command palette
    return ['C-x', 'c'];
  }

  buildRenameCommand(_name: string): string | null {
    // OpenCode supports rename via Ctrl-R, but it opens an interactive rename
    // dialog that requires typing the name and pressing Enter. The lifecycle
    // currently only supports paste-based rename (returns string to paste).
    // TODO: add renameKeys() support to lifecycle for keystroke-based rename
    return null;
  }

  interruptKeys(): string[] {
    return ['Escape'];
  }

  buildSubmitCommand(task: string): string {
    return task;
  }

  extractSessionId(paneOutput: string): string | null {
    // On Ctrl-C exit, OpenCode prints: "Continue  opencode -s ses_xxx"
    // Also visible in `opencode session list` output.
    const match = paneOutput.match(/\b(ses_[a-zA-Z0-9]{20,})\b/);
    return match ? match[1]! : null;
  }

  buildDetectSessionCommand(_cwd: string): string | null {
    // OpenCode session detection relies on pane output parsing (extractSessionId).
    // No host-side command needed — the session ID is visible in the tmux pane.
    return null;
  }
}
