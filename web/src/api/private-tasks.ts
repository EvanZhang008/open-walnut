/** Private tasks: make a synced task local, send a local one to its project's service
 *  (src/web/routes/private-tasks-v1.ts). */
import { apiGet, apiPost } from './client';

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

/** A task provider (a plugin that syncs tasks) and the rules a task must pass before it syncs
 *  there (src/core/private-tasks/provider-rules.ts), defaults filled in. */
export interface ProviderRules {
  id: string;
  name: string;
  check: boolean;
  check_set: boolean;
  /** The plugin's own default: off for a service only the user reads. */
  check_default: boolean;
  words: string[];
  ai: boolean;
  ai_rule: string;
  ai_rule_default: string;
}

export function listTaskProviders(): Promise<{ providers: ProviderRules[] }> {
  return apiGet('/api/v1/private-tasks/providers');
}

export interface RulesTest {
  match: string | null;
  invalid: string[];
  ai?: { pass: boolean; reason: string } | { error: string };
}

/** Which hard rule a title fails, and with `ai` the AI rule's verdict (one model call). */
export function testProviderRules(input: { text: string; provider: string; words?: string[]; ai?: boolean; ai_rule?: string }): Promise<RulesTest> {
  return apiPost('/api/v1/private-tasks/test', input, { timeoutMs: input.ai ? 90_000 : 15_000 });
}
