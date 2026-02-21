import type { SlashCommand } from './types.js';
import { listCommands } from './registry.js';

export const helpCommand: SlashCommand = {
  name: 'help',
  description: 'List all available slash commands',
  type: 'frontend',
  execute: (ctx) => {
    const cmds = listCommands();
    const lines = cmds.map((c) => `**/${c.name}** — ${c.description}`);
    ctx.addLocalMessage(`Available commands:\n\n${lines.join('\n')}`);
  },
};
