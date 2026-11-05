/**
 * Client for /api/v1/triage/routing-rules (src/web/routes/triage-rules-v1.ts): Inbox Triage's
 * standing "mail about X goes to task Y" rules, which every triage batch reads.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface TriageRoutingRuleView {
  id: string;
  match: { from?: string; subject?: string };
  matchText: string;
  taskId: string;
  taskTitle?: string;
  /** The task as it is now; null when it is gone. */
  task: { id: string; title: string; phase: string } | null;
  note?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  author: { by: 'human' | 'task'; taskId?: string; name?: string };
  /** Who added it (absent on an older rule: `author`). */
  createdBy?: { by: 'human' | 'task'; taskId?: string; name?: string };
  recent?: Array<{ at: number; item: string; source?: 'mail' | 'slack' }>;
  routedCount?: number;
}

export interface TriageRuleFields {
  from?: string;
  subject?: string;
  task_id?: string;
  note?: string;
  enabled?: boolean;
  /** 0 = first; the first matching rule wins. */
  position?: number;
  /** Place it right above this rule, resolved on the server. */
  before?: string;
}

const BASE = '/api/v1/triage/routing-rules';

export async function listTriageRules(): Promise<TriageRoutingRuleView[]> {
  return (await apiGet<{ rules: TriageRoutingRuleView[] }>(BASE)).rules ?? [];
}

export async function createTriageRule(fields: TriageRuleFields): Promise<TriageRoutingRuleView> {
  return (await apiPost<{ rule: TriageRoutingRuleView }>(BASE, fields)).rule;
}

export async function updateTriageRule(id: string, fields: TriageRuleFields): Promise<TriageRoutingRuleView> {
  return (await apiPatch<{ rule: TriageRoutingRuleView }>(`${BASE}/${encodeURIComponent(id)}`, fields)).rule;
}

export async function deleteTriageRule(id: string): Promise<void> {
  await apiDelete(`${BASE}/${encodeURIComponent(id)}`);
}
