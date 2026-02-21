import type { SlashCommand } from './types.js';
import { compactChatHistory } from '@/api/chat';

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Compact conversation — summarize old messages into memory',
  type: 'frontend',
  execute: async (ctx) => {
    try {
      await compactChatHistory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.addLocalMessage(`Compaction failed: ${msg}`);
    }
  },
};
