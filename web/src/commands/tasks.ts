import type { SlashCommand } from './types.js';

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  description: 'Navigate to the Tasks dashboard',
  type: 'frontend',
  execute: (ctx) => {
    ctx.navigate('/tasks');
  },
};
