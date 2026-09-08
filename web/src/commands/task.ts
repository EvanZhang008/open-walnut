import type { SlashCommand } from './types.js';

export const taskCommand: SlashCommand = {
  name: 'task',
  description: 'New task — opens the draft column (start a session, or save it for later)',
  type: 'frontend',
  source: 'control',
  execute: () => {
    window.dispatchEvent(new CustomEvent('task-composer:open'));
  },
};
