import type { SlashCommand } from './types.js';

export const taskCommand: SlashCommand = {
  name: 'task',
  description: 'Quick Task — type it, AI structures it',
  type: 'frontend',
  source: 'control',
  execute: () => {
    window.dispatchEvent(new CustomEvent('task-composer:open'));
  },
};
