import type { SlashCommand } from './types.js';

export const sessionCommand: SlashCommand = {
  name: 'session',
  description: 'Quick Start — pick a path and start a session',
  type: 'frontend',
  execute: () => {
    window.dispatchEvent(new CustomEvent('session-launcher:open'));
  },
};
