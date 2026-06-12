/**
 * Per-engine system-prompt persistence on the proxy host.
 *
 * Codex: writes a [profiles.<agent-name>] section with developer_instructions
 * into ~/.codex/config.toml (TOML triple-quoted strings handle ALL special
 * characters — backticks, $, !, quotes — with no shell escaping).
 *
 * OpenCode: writes the composed prompt verbatim to
 * ~/.config/opencode/collab/<agent-name>.md. The adapter's spawn/resume
 * command points OPENCODE_CONFIG_CONTENT at that file via the `instructions`
 * config field, which OpenCode APPENDS to the system prompt (validated
 * against sst/opencode v1.17.3 — see the OpenCode adapter header).
 *
 * Both paths assume the engine reads config from the proxy host's real HOME.
 * Known shared gap: account-isolated agents (HOME=accountHome) read config
 * from the override HOME, which this store does not scaffold.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OPENCODE_COLLAB_INSTRUCTIONS_DIR } from '../shared/utils.ts';

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class EngineProfileStore {
  readonly #homeDir: string;

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  #codexConfigPath(): string {
    return join(this.#homeDir, '.codex', 'config.toml');
  }

  #opencodeInstructionsPath(agentName: string): string {
    return join(this.#homeDir, ...OPENCODE_COLLAB_INSTRUCTIONS_DIR.split('/'), `${agentName}.md`);
  }

  #validateName(name: string): void {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(`Invalid profile name: ${name}`);
    }
  }

  /**
   * Write or update a Codex profile in ~/.codex/config.toml.
   * The only character sequence needing escaping in TOML triple-quoted
   * strings is three consecutive double quotes in the content itself.
   */
  writeCodexProfile(profileName: string, developerInstructions: string): void {
    this.#validateName(profileName);

    // Escape the only problematic sequence in TOML triple-quoted strings: """
    const safeInstructions = developerInstructions.replace(/"""/g, '""\\u0022');

    const profileHeader = `[profiles.${profileName}]`;
    const profileBlock = `${profileHeader}\ndeveloper_instructions = """\n${safeInstructions}\n"""\n`;

    const configPath = this.#codexConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });

    let config = '';
    try {
      config = readFileSync(configPath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    // Remove any existing profile section for this agent.
    // Match from [profiles.<name>] to the next [section] header or end of file.
    const profileRegex = new RegExp(
      `\\[profiles\\.${profileName}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
    );
    config = config.replace(profileRegex, '').replace(/\n{3,}/g, '\n\n');

    // Append new profile
    config = config.trimEnd() + '\n\n' + profileBlock;

    writeFileSync(configPath, config, 'utf-8');
  }

  /**
   * Remove a Codex profile from ~/.codex/config.toml.
   * Called on agent destroy to prevent stale profiles accumulating.
   */
  removeCodexProfile(profileName: string): void {
    this.#validateName(profileName);

    const configPath = this.#codexConfigPath();
    let config = '';
    try {
      config = readFileSync(configPath, 'utf-8');
    } catch {
      return; // No config file — nothing to remove
    }

    const profileRegex = new RegExp(
      `\\[profiles\\.${profileName}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
    );
    const cleaned = config.replace(profileRegex, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

    writeFileSync(configPath, cleaned, 'utf-8');
  }

  /**
   * Write the composed system prompt for an OpenCode agent.
   * Raw file write — no escaping needed; OpenCode reads the file verbatim
   * and prefixes it with "Instructions from: <path>" itself.
   */
  writeOpencodeInstructions(agentName: string, content: string): void {
    this.#validateName(agentName);

    const filePath = this.#opencodeInstructionsPath(agentName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * Remove an OpenCode agent's instructions file.
   * Called on agent destroy to prevent stale prompts accumulating.
   */
  removeOpencodeInstructions(agentName: string): void {
    this.#validateName(agentName);

    try {
      unlinkSync(this.#opencodeInstructionsPath(agentName));
    } catch {
      // File doesn't exist — nothing to remove
    }
  }
}
