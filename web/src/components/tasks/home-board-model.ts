import type { Task } from '@open-walnut/core';
import { isHiddenFromTaskLists } from '@open-walnut/org-tree';
import { shownState } from '@open-walnut/user-status';
import { taskUserState } from '@/utils/session-status';
import type { CustomTierDef } from '@/api/focus';
import { resolveParentRef } from './task-tree-index';

export type HomeBoardMode = 'pin' | 'status';
/** The board's top switch: a column board, or the Sort cards (QuickSortView). */
export type HomeBoardView = HomeBoardMode | 'sort';
export interface BoardFamily { task: Task; children: BoardFamily[]; parent?: Task }
export interface BoardProject { key: string; label: string; count: number; families: BoardFamily[] }
export interface HomeBoardColumn { id: string; label: string; count: number; projects: BoardProject[] }

/** The column a task sits in on the pin board: Focus, a registered custom tier, Unpinned, else
 *  Satellite, which takes in a retired tier (Parked's `wait`, RETIRED_TIERS) as the list does. */
export function homeBoardTier(task: Task, custom: readonly CustomTierDef[]): string {
  if (!task.pinned) return 'unpinned';
  const tier = task.focus_tier;
  return tier === 'focus' || custom.some(t => t.id === tier) ? tier! : 'satellite';
}

/** The pin board's columns in order (the board, the Sort cards and the card labels read this). */
export function pinBoardColumns(custom: readonly CustomTierDef[]): { id: string; label: string }[] {
  return [{ id: 'focus', label: 'Focus' }, { id: 'satellite', label: 'Satellite' }, ...custom.map(t => ({ id: t.id, label: t.label })), { id: 'unpinned', label: 'Unpinned' }];
}

export function boardFamilyIds(family: BoardFamily): string[] {
  return [family.task.id, ...family.children.flatMap(boardFamilyIds)];
}

export function boardMoveIds(tasks: readonly Task[], root: Task, custom: readonly CustomTierDef[]): string[] {
  const visible = tasks.filter(t => !isHiddenFromTaskLists(t) && taskUserState(t) !== 'done');
  const tier = homeBoardTier(root, custom);
  const children = new Map<string, Task[]>();
  for (const task of visible) {
    const parent = task.parent_task_id ? resolveParentRef(visible, task.parent_task_id) : undefined;
    if (!parent) continue;
    const siblings = children.get(parent.id) ?? [];
    siblings.push(task);
    children.set(parent.id, siblings);
  }
  const ids = new Set<string>();
  const add = (task: Task) => {
    if (ids.has(task.id) || homeBoardTier(task, custom) !== tier) return;
    ids.add(task.id);
    children.get(task.id)?.forEach(add);
  };
  add(root);
  return [...ids];
}

export function buildHomeBoard(tasks: readonly Task[], custom: readonly CustomTierDef[], mode: HomeBoardMode, query = '', doneLimit = 30): HomeBoardColumn[] {
  const visible = tasks.filter(t => !isHiddenFromTaskLists(t));
  const bucket = (t: Task) => mode === 'pin' ? homeBoardTier(t, custom) : shownState(taskUserState(t));
  const definitions = mode === 'pin'
    ? pinBoardColumns(custom)
    : [{ id: 'needs', label: 'Needs you' }, { id: 'working', label: 'Working' }, { id: 'waiting', label: 'Waiting' }, { id: 'done', label: 'Done' }];
  const projectKey = (t: Task) => (t.project ?? '').trim().toLowerCase();
  const parentById = new Map<string, Task>();
  for (const t of visible) {
    const parent = t.parent_task_id ? resolveParentRef(visible, t.parent_task_id) : undefined;
    if (parent && parent.id !== t.id) parentById.set(t.id, parent);
  }
  const text = query.trim().toLocaleLowerCase();
  const eligible = visible.filter(t => mode !== 'pin' || taskUserState(t) !== 'done');
  const eligibleIds = new Set(eligible.map(t => t.id));
  const included = new Set(eligible.filter(t => !text || `${t.title} ${t.project ?? ''}`.toLocaleLowerCase().includes(text)).map(t => t.id));
  if (text) {
    for (const t of eligible) {
      if (!included.has(t.id)) continue;
      let current = t;
      const seen = new Set([t.id]);
      while (true) {
        const parent = parentById.get(current.id);
        if (!parent || !eligibleIds.has(parent.id) || seen.has(parent.id) || bucket(parent) !== bucket(t) || projectKey(parent) !== projectKey(t)) break;
        seen.add(parent.id);
        included.add(parent.id);
        current = parent;
      }
    }
  }
  return definitions.map(definition => {
    const matching = eligible.filter(t => included.has(t.id) && bucket(t) === definition.id);
    matching.sort((a, b) => definition.id === 'done'
      ? b.updated_at.localeCompare(a.updated_at)
      : (a.pin_order ?? Number.MAX_SAFE_INTEGER) - (b.pin_order ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
    const selected = definition.id === 'done' ? matching.slice(0, doneLimit) : matching;
    const projects = new Map<string, BoardProject>();
    const families = new Map<string, BoardFamily>();
    for (const task of selected) {
      const key = projectKey(task);
      if (!projects.has(key)) projects.set(key, { key, label: task.project?.trim() || 'Inbox', count: 0, families: [] });
      projects.get(key)!.count++;
      families.set(task.id, { task, children: [], parent: parentById.get(task.id) });
    }
    for (const family of families.values()) {
      const parent = family.parent;
      const holder = parent && projectKey(parent) === projectKey(family.task) ? families.get(parent.id) : undefined;
      let cycle = false;
      if (holder) {
        let current: Task | undefined = holder.task;
        const seen = new Set([family.task.id]);
        while (current && families.has(current.id)) {
          if (seen.has(current.id)) { cycle = true; break; }
          seen.add(current.id);
          current = parentById.get(current.id);
        }
      }
      if (holder && !cycle) holder.children.push(family);
      else projects.get(projectKey(family.task))!.families.push(family);
    }
    return { ...definition, count: matching.length, projects: [...projects.values()].sort((a, b) => a.label.localeCompare(b.label)) };
  });
}
