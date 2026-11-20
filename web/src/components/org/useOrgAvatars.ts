/**
 * The Org page's avatars in the browser (src/core/org/avatars/, behind the "Org avatars"
 * experiment): who wears which, worked out once per task list for every avatar on the page.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import { orgAvatars, type AvatarPick, type AvatarTask } from '@open-walnut/org-avatars';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useExperimental } from '@/hooks/useExperimental';

const NO_TASKS: readonly Task[] = [];
const OFF = { src: '', custom: false } as const;

interface ListAvatars { a: ReturnType<typeof orgAvatars>; index: Map<string, Task> }
/** Worked out once per task list, for every avatar on the page. */
const byList = new WeakMap<readonly Task[], ListAvatars>();

function avatarsOf(tasks: readonly Task[]): ListAvatars {
  let v = byList.get(tasks);
  if (!v) { v = { a: orgAvatars(tasks as readonly AvatarTask[]), index: new Map(tasks.map((t) => [t.id, t])) }; byList.set(tasks, v); }
  return v;
}

export interface OrgAvatarLookup {
  /** The experiment is on: avatars replace the letters. */
  on: boolean;
  /** The avatar of a task (by id), or of a name with no task yet. */
  of: (taskId: string | undefined, name: string) => AvatarPick;
}

export function useOrgAvatars(): OrgAvatarLookup {
  const on = useExperimental('org_avatars');
  // Outside the task store (a test's static render) every node gets its default by name.
  const tasks = useTasksContextSafe()?.tasks ?? NO_TASKS;
  return useMemo(() => {
    // Off, nothing is worked out: every place draws its letters.
    if (!on) return { on, of: () => OFF };
    const { a, index } = avatarsOf(tasks);
    return {
      on,
      of: (taskId, name) => {
        const task = taskId ? index.get(taskId) : undefined;
        return a.of((task ?? { id: taskId ?? `name:${name}`, title: name }) as AvatarTask);
      },
    };
  }, [on, tasks]);
}
