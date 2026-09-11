import { apiGet } from './client';

export interface ContextSection<T = string> {
  content: T;
  tokens: number;
  count?: number;
}

export interface ModelConfig {
  model: string;
  /** Host + cwd of the session, one line ("local · cwd /Users/…"). */
  region: string;
}

export interface ContextInspectorResponse {
  /**
   * Which engine this context belongs to.
   *
   * Open-ended string, not a two-value union: a named session reports the engine
   * off its OWN record, so any registered coding-agent engine ('codex', …) can
   * appear here. Only 'claude-code' unlocks the Claude Code readings.
   */
  engine?: string;
  /**
   * Only what the session was really given. Tools, the message transcript and
   * compaction all live inside the session CLI, so they have no section here — a
   * zeroed one would read as "the model got none of that".
   */
  sections: {
    modelConfig: ContextSection<ModelConfig>;
    roleAndRules: ContextSection;
    skills: ContextSection;
    globalMemory: ContextSection;
  };
  totalTokens: number;
}

/**
 * Read the launch context of one conversation.
 *
 * `sessionId` names a session directly — what an Ask Walnut conversation IS.
 * `agentId`/`conversationId` is the console-agent lane form; with neither, the
 * server answers for the agent's active conversation.
 */
export async function fetchAgentContext(
  agentId?: string, conversationId?: string, sessionId?: string,
): Promise<ContextInspectorResponse> {
  const params: Record<string, string> = {};
  if (agentId) params.agentId = agentId;
  if (conversationId) params.conversationId = conversationId;
  if (sessionId) params.sessionId = sessionId;
  return apiGet<ContextInspectorResponse>('/api/context', params);
}
