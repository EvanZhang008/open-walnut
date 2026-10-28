import { apiGet } from './client';

/** A task's own MEMORY.md: the working memory Main, a lead or a leader keeps for itself. */
export interface AgentMemory {
  task_id: string;
  title: string;
  /** null: it has written none (and a task outside the org never has one). */
  memory: { text: string; at: string; refused?: { at: string; chars: number } } | null;
  chars: number;
  soft_limit: number;
  limit: number;
}

/** Read only: the agent writes its own MEMORY.md (PUT is its session's, or a person's). */
export async function fetchAgentMemory(taskId: string): Promise<AgentMemory> {
  return apiGet<AgentMemory>(`/api/v1/tasks/${encodeURIComponent(taskId)}/agent-memory`);
}
