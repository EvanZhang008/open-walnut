/**
 * Who can join a topic, from the browser's own task list: the CEO and every VP (an org node, so the
 * topic follows the node when its task changes), then every open task that is not one of those
 * nodes. Pure apart from the hooks, so the picker and the @ list read the same rows.
 *
 * The hooks never read the whole task context (it changes on every task write,
 * tests/web/tasks-context-readers-ratchet.test.ts): they work their list out of the rows and keep
 * the same array while it reads the same, so an open topic draws again only when a name changes.
 */
import { useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { buildOrgTree, orgDisplayTitle, orgProjectNode } from '@open-walnut/org-tree';
import { useTaskListSelect } from '@/contexts/TasksContext';
import type { PickedMember } from './topic-dialogs';
import { orgRef, refKey, taskRef } from './topic-model';

export interface Candidate extends PickedMember {
  /** A short word beside the name: what an Org node leads ("Leads Acme"), or the task's project. */
  hint: string;
  /** The same member's other keys: a VP that leads several projects is one row, under one node. */
  aliases?: string[];
}

const isDone = (t: Pick<Task, 'phase' | 'status'>) => t.phase === 'COMPLETE' || t.status === 'done';

export function memberCandidates(tasks: readonly Task[]): Candidate[] {
  const tree = buildOrgTree(tasks);
  const out: Candidate[] = [];
  if (tree.main) out.push({ ref: orgRef('main'), name: orgDisplayTitle({ title: tree.main.title, org_role: 'main' }), hint: 'Leads every VP' });
  // One row per VP, never one per project it leads: its own project's node is the member (the
  // first one when it leads none of its own), the others are its aliases, and the hint names them all.
  const byLead = new Map<string, string[]>();
  for (const p of tree.projects) {
    if (!p.lead) continue;
    byLead.set(p.lead.id, [...(byLead.get(p.lead.id) ?? []), p.project]);
  }
  for (const [leadId, projects] of byLead) {
    const lead = tasks.find((t) => t.id === leadId);
    const home = projects.find((p) => p === lead?.project) ?? projects[0]!;
    const others = projects.filter((p) => p !== home);
    out.push({
      ref: orgRef(orgProjectNode(home)),
      name: lead ? orgDisplayTitle(lead) : `${home} VP`,
      hint: `Leads ${[home, ...others].join(', ')}`,
      ...(others.length ? { aliases: others.map((p) => refKey(orgRef(orgProjectNode(p)))) } : {}),
    });
  }
  for (const t of tasks) {
    if (isDone(t) || t.org_role === 'main' || t.org_role === 'lead') continue;
    out.push({ ref: taskRef(t.id), name: orgDisplayTitle(t), hint: t.project || 'Inbox' });
  }
  return out;
}

/** A list worked out from the task rows, the same array while `same` holds for each entry. */
function useKeptList<T>(derive: (tasks: readonly Task[]) => T[], same: (a: T, b: T) => boolean): T[] {
  const kept = useRef<T[]>([]);
  return useTaskListSelect(({ tasks }) => {
    const next = derive(tasks);
    const prev = kept.current;
    if (prev.length === next.length && prev.every((x, i) => same(x, next[i]!))) return prev;
    kept.current = next;
    return next;
  }) ?? kept.current;
}

const sameCandidate = (a: Candidate, b: Candidate) => a.name === b.name && a.hint === b.hint && refKey(a.ref) === refKey(b.ref) && (a.aliases ?? []).join() === (b.aliases ?? []).join();

export function useMemberCandidates(): Candidate[] {
  return useKeptList(memberCandidates, sameCandidate);
}

export interface OpenTaskName { id: string; name: string }

/**
 * The open tasks by their shown name, for the composer's @ list. The CEO and the VPs are left out:
 * they join as Org nodes (the picker's rows), never as a plain task, and one in the topic is listed
 * as its member already.
 */
export function openTaskNames(tasks: readonly Task[]): OpenTaskName[] {
  return tasks.filter((t) => !isDone(t) && t.org_role !== 'main' && t.org_role !== 'lead').map((t) => ({ id: t.id, name: orgDisplayTitle(t) }));
}

export interface OrgNodeName { node: string; name: string; aliases?: string[] }

/** The CEO and the VPs as Org nodes, for the composer's @ list (the picker's first rows, one per VP). */
export function orgNodeNames(tasks: readonly Task[]): OrgNodeName[] {
  return memberCandidates(tasks).flatMap((c) => (c.ref.kind === 'org' ? [{ node: c.ref.node, name: c.name, ...(c.aliases ? { aliases: c.aliases } : {}) }] : []));
}

export function useOrgNodeNames(): OrgNodeName[] {
  return useKeptList(orgNodeNames, (a, b) => a.node === b.node && a.name === b.name && (a.aliases ?? []).join() === (b.aliases ?? []).join());
}

export function useOpenTaskNames(): OpenTaskName[] {
  return useKeptList(openTaskNames, (a, b) => a.id === b.id && a.name === b.name);
}
