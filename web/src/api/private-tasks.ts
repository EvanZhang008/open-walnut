/** Private tasks: make a synced task local, send a local one to its project's service
 *  (src/web/routes/private-tasks-v1.ts). */
import { apiPost } from './client';

export type OutsideCopyAction = 'keep' | 'archive' | 'neutralize';

export interface MakeLocalResult {
  unlinked: boolean;
  from?: string;
  service?: string;
  children: string[];
  outside: { action: OutsideCopyAction; done: boolean; error?: string };
  outcome: string;
}

export function makeTaskLocal(id: string, outside: OutsideCopyAction = 'keep'): Promise<MakeLocalResult> {
  return apiPost<MakeLocalResult>(`/api/v1/tasks/${encodeURIComponent(id)}/make-local`, { outside }, { timeoutMs: 60_000 });
}

export function syncTaskToProject(id: string): Promise<{ released: boolean; service: string; sync_error?: string }> {
  return apiPost(`/api/v1/tasks/${encodeURIComponent(id)}/sync-to-project`, {}, { timeoutMs: 60_000 });
}

export function changeOutsideCopy(id: string, action: Exclude<OutsideCopyAction, 'keep'>): Promise<{ done: boolean }> {
  return apiPost(`/api/v1/tasks/${encodeURIComponent(id)}/outside-copy`, { action }, { timeoutMs: 60_000 });
}

export function testPrivateWords(text: string, words?: string[]): Promise<{ match: string | null; invalid: string[] }> {
  return apiPost('/api/v1/private-tasks/test', { text, ...(words ? { words } : {}) });
}
