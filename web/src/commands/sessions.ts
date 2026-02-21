import type { SlashCommand } from './types.js';

export const sessionsCommand: SlashCommand = {
  name: 'sessions',
  description: 'Navigate to the Sessions page',
  type: 'frontend',
  execute: (ctx) => {
    ctx.navigate('/sessions');
  },
};
