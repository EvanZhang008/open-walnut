import type { SlashCommand } from './types.js';

export const checkTasksCommand: SlashCommand = {
  name: 'check-tasks',
  description: 'Ask the agent to review your tasks and suggest priorities',
  type: 'agent',
  execute: (ctx) => {
    ctx.sendMessage(
      '[Command: check-tasks]\nReview my current tasks and suggest what I should focus on next. Consider priorities, deadlines, and any tasks that might be blocked.',
    );
  },
};
