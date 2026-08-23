/**
 * Markdown command bridge: loads server-stored commands (user .md, plugin-registered,
 * shipped builtin) into the frontend command registry so they appear in CommandPalette
 * autocomplete and can be executed via /name in chat input.
 *
 * Everything here is registered under the 'markdown' owner, so the core commands
 * (/compact, /session, /task, /help …) outrank these on a name collision and a refresh
 * of this bridge can never remove them.
 */
import { registerOwned, removeOwner } from './registry.js';
import { fetchCommands } from '@/api/commands';
import type { SlashCommand } from './types.js';

/**
 * Load server commands and register them under the 'markdown' owner.
 * Called once at startup from index.ts.
 */
export async function loadMarkdownCommands(): Promise<void> {
  try {
    const serverCommands = await fetchCommands();

    for (const cmd of serverCommands) {
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

      registerOwned('markdown', slashCmd);
    }
  } catch {
    // Server may not be available yet at startup — fail silently
  }
}

/**
 * Refresh markdown commands: drop this owner's entries only, then re-fetch.
 * Called after CRUD mutations from the useCommands hook and after a plugin reload.
 */
export async function refreshMarkdownCommands(): Promise<void> {
  removeOwner('markdown');
  await loadMarkdownCommands();
}
