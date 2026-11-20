/**
 * Who can join a topic, from the browser's own task list: the CEO and every VP (an org node, so the
 * topic follows the node when its task changes), then every open task that is not one of those
 * nodes. Pure apart from the hook, so the picker and the @ list read the same rows.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { buildOrgTree, orgDisplayTitle, orgProjectNode } from '@open-walnut/org-tree';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import type { PickedMember } from './topic-dialogs';
import { orgRef, taskRef } from './topic-model';

export interface Candidate extends PickedMember {
  /** A short word under the name: "Org node", the task's project. */
  hint: string;
}

const isDone = (t: Pick<Task, 'phase' | 'status'>) => t.phase === 'COMPLETE' || t.status === 'done';

export function memberCandidates(tasks: readonly Task[]): Candidate[] {
  const tree = buildOrgTree(tasks);
  const out: Candidate[] = [];
  if (tree.main) out.push({ ref: orgRef('main'), name: orgDisplayTitle({ title: tree.main.title, org_role: 'main' }), hint: 'Org node' });
  for (const p of tree.projects) {
    if (!p.lead) continue;
    const lead = tasks.find((t) => t.id === p.lead!.id);
    out.push({ ref: orgRef(orgProjectNode(p.project)), name: lead ? orgDisplayTitle(lead) : `${p.project} VP`, hint: 'Org node' });
  }
  for (const t of tasks) {
    if (isDone(t) || t.org_role === 'main' || t.org_role === 'lead') continue;
    out.push({ ref: taskRef(t.id), name: orgDisplayTitle(t), hint: t.project || 'Inbox' });
  }
  return out;
}

export function useMemberCandidates(): Candidate[] {
  const tasks = useTasksContextSafe()?.tasks;
  return useMemo(() => memberCandidates(tasks ?? []), [tasks]);
}
