/**
 * Markdown command bridge: loads server-stored .md commands into the frontend
 * command registry so they appear in CommandPalette autocomplete and can be
 * executed via /name in chat input.
 */
import { register, unregister, listCommands } from './registry.js';
import { fetchCommands } from '@/api/commands';
import type { SlashCommand } from './types.js';

/** Names of hardcoded commands that must never be overridden. */
const HARDCODED_NAMES = new Set([
  'compact', 'help', 'plan', 'check-tasks', 'sessions', 'tasks',
]);

/**
 * Load markdown-based commands from the server and register them
 * in the frontend command registry. Hardcoded commands are never overridden.
 * Called once at startup from index.ts.
 */
export async function loadMarkdownCommands(): Promise<void> {
  try {
    const serverCommands = await fetchCommands();

    for (const cmd of serverCommands) {
      // Never override hardcoded commands
      if (HARDCODED_NAMES.has(cmd.name)) continue;

      const slashCmd: SlashCommand = {
        name: cmd.name,
        description: cmd.description || `Run /${cmd.name}`,
        type: 'agent',
        source: cmd.source,
        execute: (ctx) => {
          const instruction = cmd.content;
          const parts = [instruction];
          if (ctx.args) {
            parts.push(`\nAdditional context: ${ctx.args}`);
          }
          ctx.sendMessage(parts.join(''));
        },
      };

      register(slashCmd);
    }
  } catch {
    // Server may not be available yet at startup — fail silently
  }
}

/**
 * Refresh markdown commands: unregister all non-hardcoded commands,
 * then re-fetch and re-register from the server.
 * Called after CRUD mutations from the useCommands hook.
 */
export async function refreshMarkdownCommands(): Promise<void> {
  // Remove all non-hardcoded commands
  const current = listCommands();
  for (const cmd of current) {
    if (cmd.source !== 'hardcoded') {
      unregister(cmd.name);
    }
  }

  // Re-load from server
  await loadMarkdownCommands();
}
