import type { SessionHistoryMessage } from '@/types/session';

/** Only the agent's own assistant records can tell us its runtime effort. */
export function recordedAgentEffort(messages?: readonly SessionHistoryMessage[] | null): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i];
    if (message.role === 'assistant' && message.effort !== undefined) return message.effort;
  }
  return undefined;
}

/** Keep the call's settings, filling an omitted effort from its transcript, never a default. */
export function agentPromptInput(input: Record<string, unknown> | undefined, effort: string | undefined): Record<string, unknown> | undefined {
  if (input?.effort != null || effort === undefined) return input;
  return { ...input, effort };
}
