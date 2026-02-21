import type { SlashCommand } from './types.js';

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Ask the agent to create a plan (optionally for a topic)',
  type: 'agent',
  execute: (ctx) => {
    const topic = ctx.args?.trim();
    if (topic) {
      ctx.sendMessage(
        `[Command: plan]\nCreate a detailed plan for: ${topic}`,
      );
    } else {
      ctx.sendMessage(
        '[Command: plan]\nLook at my current tasks and create a plan for what I should work on next. Consider priorities, dependencies, and deadlines.',
      );
    }
  },
};
