import { apiGet } from './client';
import type { Task } from '@walnut/core';

export interface SearchResult {
  tasks: Task[];
  memories: Array<{ path: string; excerpt: string }>;
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchOptions {
  type?: 'tasks' | 'memory' | 'all';
  mode?: SearchMode;
}

interface ServerSearchResult {
  type: 'task' | 'memory';
  title: string;
  snippet: string;
  path?: string;
  taskId?: string;
  parentTaskId?: string;
  isAutoExpanded?: boolean;
  score: number;
  matchField: string;
}

export async function searchAll(q: string, options?: SearchOptions): Promise<SearchResult> {
  const params: Record<string, string> = { q };
  if (options?.type) params.type = options.type;
  if (options?.mode) params.mode = options.mode;
  const res = await apiGet<{ results: ServerSearchResult[] }>('/api/search', params);

  // Transform flat result array into grouped shape for the UI
  const tasks: Task[] = [];
  const memories: Array<{ path: string; excerpt: string }> = [];

  for (const item of res.results) {
    if (item.type === 'task') {
      // Create a minimal Task-like object from search result
      tasks.push({
        id: item.taskId ?? '',
        title: item.title,
        snippet: item.snippet,
        score: item.score,
        matchField: item.matchField,
        isAutoExpanded: item.isAutoExpanded,
        // Fill required Task fields with defaults for display
        status: 'todo',
        priority: 'none',
        category: '',
        project: item.matchField === 'project' ? item.snippet : '',
        source: 'ms-todo',
        session_ids: [],
        created_at: '',
        updated_at: '',
        description: '',
        summary: '',
        note: '',
        phase: 'TODO',
        ...(item.parentTaskId ? { parent_task_id: item.parentTaskId } : {}),
      } as Task & { snippet: string; score: number; matchField: string; isAutoExpanded?: boolean });
    } else {
      memories.push({
        path: item.path ?? item.title,
        excerpt: item.snippet,
      });
    }
  }

  return { tasks, memories };
}
