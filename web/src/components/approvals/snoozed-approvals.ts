/**
 * The approvals the person snoozed on their task's row (Action needed, core/action-needed.ts): no
 * corner card, count or list raises them until the snooze runs out. Read from the tasks' own
 * statuses (user_status.actions[].snoozedUntil), the one record of an item's snooze.
 */
import { useMemo } from 'react';
import { useTaskListSelect } from '@/contexts/TasksContext';

/** The ids, as one sorted key, so a list change that snoozes nothing draws nothing. */
export function snoozedApprovalKey(tasks: ReadonlyArray<{ user_status?: { actions?: ReadonlyArray<{ kind: string; id: string; snoozedUntil?: string }> } }>, now = Date.now()): string {
  const ids: string[] = [];
  for (const t of tasks) {
    for (const a of t.user_status?.actions ?? []) {
      if (a.kind === 'approval' && a.snoozedUntil && Date.parse(a.snoozedUntil) > now) ids.push(a.id);
    }
  }
  return ids.sort().join(',');
}

export function useSnoozedApprovalIds(): ReadonlySet<string> {
  const key = useTaskListSelect(({ tasks }) => snoozedApprovalKey(tasks)) ?? '';
  return useMemo(() => new Set(key ? key.split(',') : []), [key]);
}
