/**
 * The Org page's avatars in the browser (src/core/org/avatars/, behind the "Org avatars"
 * experiment): who wears which, worked out once per task list for every avatar on the page.
 * Read through the store's list select, never the whole task context
 * (tests/web/tasks-context-readers-ratchet.test.ts), and with no closure memoized in a render
 * (tests/web/lean-callback-ratchet.test.ts): the lookup is made at module level, once per list.
 */
import type { Task } from '@open-walnut/core';
import { orgAvatars, type AvatarPick, type AvatarTask } from '@open-walnut/org-avatars';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { useExperimental } from '@/hooks/useExperimental';

export interface OrgAvatarLookup {
  /** The experiment is on: avatars replace the letters. */
  on: boolean;
  /** The avatar of a task (by id), or of a name with no task yet. */
  of: (taskId: string | undefined, name: string) => AvatarPick;
}

const NO_TASKS: readonly Task[] = [];
const OFF_PICK: AvatarPick = { src: '', custom: false };
const OFF: OrgAvatarLookup = { on: false, of: () => OFF_PICK };

/** Module level on purpose: its closure holds the list, never a render. */
function makeLookup(tasks: readonly Task[]): OrgAvatarLookup {
  const a = orgAvatars(tasks as readonly AvatarTask[]);
  const index = new Map(tasks.map((t) => [t.id, t]));
  return {
    on: true,
    of: (taskId, name) => {
      const task = taskId ? index.get(taskId) : undefined;
      return a.of((task ?? { id: taskId ?? `name:${name}`, title: name }) as AvatarTask);
    },
  };
}

const byList = new WeakMap<readonly Task[], OrgAvatarLookup>();
function lookupOf(tasks: readonly Task[]): OrgAvatarLookup {
  let v = byList.get(tasks);
  if (!v) { v = makeLookup(tasks); byList.set(tasks, v); }
  return v;
}
const selectLookup = ({ tasks }: { tasks: readonly Task[] }) => lookupOf(tasks);

export function useOrgAvatars(): OrgAvatarLookup {
  const on = useExperimental('org_avatars');
  // Outside the task store (a test's static render) every node gets its default by name.
  const lookup = useTaskListSelect(selectLookup) ?? lookupOf(NO_TASKS);
  // Off, nothing is drawn: every place draws its letters.
  return on ? lookup : OFF;
}
