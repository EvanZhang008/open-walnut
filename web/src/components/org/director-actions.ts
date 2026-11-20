/**
 * What the user does with a Director on the Org page (2026-11-20, the user: "we can also de-promote or
 * promote any task to director ... we can also create director"): its right-click menu (open its chat,
 * open it, take it off the Directors), and "New Director", asked for from a VP's own right-click menu
 * (org-row-menu.ts, the chart's card menu) and answered by that VP's fold or the DIRECTORS section,
 * which opens and shows its name input. Every write goes through the task store, so the row moves at
 * once (useTasks applies `director` before the server answers).
 */
import { directorWrite } from '@open-walnut/org-tree';
import { useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import type { ContextMenuItem } from '@/utils/context-menu';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { useOpenTask } from '@/hooks/useOpenTask';
import { log } from '@/utils/log';
import { taskMember, topicMenuItems } from '@/components/topics/topic-entry';

/** A Director's right-click menu. Pure, so tests reach it. */
export function directorMenuItems({ id, title, openChat, openTask, remove }: {
  /** The Director's task: with it, "Add to topic…" (experiment `topics`, nothing while it is off). */
  id?: string;
  title: string;
  openChat: () => void;
  openTask: () => void;
  remove: () => void;
}): ContextMenuItem[] {
  return [
    { key: 'head', section: true, label: title },
    { key: 'chat', label: 'Open chat', onSelect: openChat },
    { key: 'task', label: 'Open task', onSelect: openTask },
    ...(id ? topicMenuItems([taskMember({ id, title })]) : []),
    { key: 'sep', divider: true },
    { key: 'remove', label: 'Remove from Directors', title: 'It stays where it is, with its subtasks and its chat; it is only no longer listed here', onSelect: remove },
  ];
}

/** Where "New Director" was asked for: the VP's key, on the list or the chart. */
export interface NewDirectorAsk { vpKey: string; surface: 'list' | 'chart'; n: number }

let ask: NewDirectorAsk | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Open that VP's New Director input (its fold opens, and stays open). */
export function askNewDirector(vpKey: string, surface: 'list' | 'chart'): void {
  ask = { vpKey, surface, n: ++seq };
  emit();
}

/** The input was used or closed: the ask is answered. */
export function endNewDirector(n: number): void {
  if (ask?.n !== n) return;
  ask = null;
  emit();
}

/** The open ask on this surface, if any. */
export function useNewDirectorAsk(surface: 'list' | 'chart'): NewDirectorAsk | null {
  const now = useSyncExternalStore(subscribe, () => ask, () => null);
  return now?.surface === surface ? now : null;
}

/** A project a New Director may go to: the VP's projects, in the chart's order. */
export interface DirectorProject { project: string; name: string; vpName?: string }

/** The store's Director writes and the task opens. */
export function useDirectorActions() {
  const store = useTaskStoreActions();
  const openTask = useOpenTask();
  return {
    /** Its own chat beside the page (its session), else the task. */
    openChat: (t: Pick<Task, 'id'> & { sessionId?: string | undefined }) => openTask(t.id, t.sessionId ? { sessionId: t.sessionId } : undefined),
    openTask: (id: string) => openTask(id),
    /** `leads`: its open workers now (directorWrite: a leader is set to 'no', any other back to auto). */
    remove: (id: string, leads: number) => {
      log.info('org-page', 'director removed', { taskId: id });
      void store?.update(id, { director: directorWrite(false, leads) });
    },
    /** Made, NOT started: the user's first message in its chat starts it. Opens it beside the page. */
    create: async (title: string, project: string, onLeave?: () => void): Promise<Task | null> => {
      if (!store) return null;
      const task = await store.create({ title, project, director: 'yes' });
      log.info('org-page', 'director created', { taskId: task.id, project });
      // A sheet over the page (the Org chart) closes first, or the task opens behind it.
      onLeave?.();
      openTask(task.id);
      return task;
    },
  };
}
