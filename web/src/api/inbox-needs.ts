import { apiGet } from './client';
import type { OrgThread } from './org-threads';
import type { NeedsUrgency } from '@open-walnut/inbox-needs';

/** One thread that needs him, as GET /api/v1/inbox/needs lists it (src/web/routes/inbox-needs-v1.ts). */
export type InboxNeedsThread = OrgThread & {
  /** The node that holds it: its answer goes to that node. */
  node: { task_id: string; title: string; org_role?: string };
  urgency: NeedsUrgency;
};

export interface InboxNeedsResponse {
  enabled: boolean;
  /** The most urgent first (core/human-inbox/needs-model.ts byUrgency). */
  threads: InboxNeedsThread[];
  /** The letters those threads hold: listed once, as their threads. */
  held_letter_ids: string[];
  counts: { threads: number; letters: number; total: number };
}

export async function fetchInboxNeeds(): Promise<InboxNeedsResponse> {
  return apiGet<InboxNeedsResponse>('/api/v1/inbox/needs', undefined, { quietStatuses: [503] });
}
