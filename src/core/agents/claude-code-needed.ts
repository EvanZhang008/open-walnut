/**
 * Does this setup run anything on Claude Code? Sessions run on the default engine
 * (Main, asks, routines, task_start) and Walnut's own model calls on the main
 * provider; when neither is Claude, nothing needs the `claude` CLI.
 *
 * The one rule every "Claude Code is missing" message asks first: the home page's
 * setup banner (`claudeCodeNeeded` in /api/system/health), the server's boot
 * warning, and the local daemon's spawn preflight. 2026-10-30: a user on Ollama +
 * OpenCode (GETTING_STARTED Path D) read "Claude Code CLI not found, sessions will
 * not work" and "sessions will fail with exit 127" while every session ran fine.
 * Ratchet: tests/core/agents/claude-code-needed.test.ts.
 */
import type { Config } from '../types.js';
import { resolveDefaultEngine } from './default-engine.js';
import { CLAUDE_CLI_PROVIDER, resolveMainProviderName } from '../../model/providers/default-provider.js';

export function claudeCodeNeeded(config: Config, claudeInstalled?: boolean): boolean {
  return resolveMainProviderName(config, claudeInstalled) === CLAUDE_CLI_PROVIDER
    || resolveDefaultEngine(config) === 'claude';
}
