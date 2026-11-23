/**
 * Where a thread on a Threads card came from, said in one quiet line of its head (2026-11-23, the
 * user, on a leader's Threads gathering the threads of the tasks below it: every thread must say
 * whether it is this task's own or which task below it came from, "those are two different things").
 *
 *   this task's own, from his message    "You asked this task"
 *   this task's own, opened by its agent "Opened by this task"
 *   moved here from another node         "Moved here from <that node>" (its first words were not his to this task)
 *   a task's below it (any depth)        "From <that task>": the task holding the thread
 *                                        (core/org/thread-popup.ts `owner`), a grandchild named as itself
 *
 * "This task" is the Threads view's own word for the node it belongs to ("Your requests to this
 * task"); the node's name is in the hover. Every card that draws a thread head reads its line here
 * (guard: tests/web/thread-origin.test.ts).
 *
 * The same origin filters the view (ThreadOriginFilter.tsx; 2026-11-23, the user: a leader "able to
 * see different threads ... there can be a filter by ... by default, at least all"): All, This task,
 * then each task below with a thread in the list. Pure.
 */
import type { OrgThread } from '@/api/org-threads';

/** The filter's picks besides a task below (its id): every thread, or this task's own. */
export const ORIGIN_ALL = 'all';
export const ORIGIN_OWN = 'own';

/** One pick of the filter: its words, how many of its threads the view lists for him, its hover. */
export interface OriginChoice { id: string; label: string; count: number; hover: string }

export type ThreadOrigin =
  | { from: 'own'; opened: 'you' | 'task'; words: string; hover: string }
  | { from: 'below'; taskId: string; title: string; words: string; hover: string };

/** The word before the name of the task below a thread came from. */
export const FROM_BELOW = 'From';

/** Where `t` came from, as the Threads of `name` read it. */
export function threadOrigin(t: Pick<OrgThread, 'owner' | 'opener'> & Partial<Pick<OrgThread, 'movedFrom'>>, name: string): ThreadOrigin {
  if (t.owner) {
    const title = t.owner.title.trim() || 'a task below';
    return { from: 'below', taskId: t.owner.task_id, title, words: `${FROM_BELOW} ${title}`, hover: `${FROM_BELOW} ${title}, a task below ${name}` };
  }
  // Moved here with its work or handed on: he did not ask this task (review 2026-11-23).
  const came = t.movedFrom?.title.trim();
  if (came) return { from: 'own', opened: 'task', words: `Moved here from ${came}`, hover: `Moved to this task (${name}) from ${came}` };
  // A first post the node wrote (thread_create): its agent opened it. With none, his message filed it.
  if (t.opener && t.opener.by !== 'human') return { from: 'own', opened: 'task', words: 'Opened by this task', hover: `Opened by this task (${name})` };
  return { from: 'own', opened: 'you', words: 'You asked this task', hover: `You asked this task (${name})` };
}

/** Whether `t` shows under `pick`: every thread, this task's own, or the threads of one task below. */
export function fromOrigin(t: Pick<OrgThread, 'owner'>, pick: string): boolean {
  if (pick === ORIGIN_ALL) return true;
  if (pick === ORIGIN_OWN) return !t.owner;
  return t.owner?.task_id === pick;
}

/**
 * The filter over a node's Threads: All, This task, then each task below that has a thread in the
 * list, in the list's order (newest change first). Each counts its threads the view lists for him
 * (`listed`, the Threads tab's own count), so All reads the tab's number. Null when every thread is
 * the node's own: there is nothing to filter by.
 */
export function originChoices(threads: readonly Pick<OrgThread, 'id' | 'owner' | 'opener'>[], listed: ReadonlySet<string>): OriginChoice[] | null {
  const below = new Map<string, OriginChoice>();
  let own = 0;
  for (const t of threads) {
    const n = listed.has(t.id) ? 1 : 0;
    const o = threadOrigin(t, '');
    if (o.from === 'own') { own += n; continue; }
    const c = below.get(o.taskId);
    if (c) c.count += n;
    else below.set(o.taskId, { id: o.taskId, label: o.title, count: n, hover: `Only the threads from ${o.title}` });
  }
  if (!below.size) return null;
  const total = own + [...below.values()].reduce((sum, c) => sum + c.count, 0);
  return [
    { id: ORIGIN_ALL, label: 'All', count: total, hover: "Every thread: this task's own and the ones from the tasks below it" },
    { id: ORIGIN_OWN, label: 'This task', count: own, hover: "Only this task's own threads" },
    ...below.values(),
  ];
}

/** The pick the view shows: one no longer offered (its task's threads left, or none is below now) reads All. */
export function shownOrigin(pick: string, choices: readonly OriginChoice[] | null): string {
  return choices?.some((c) => c.id === pick) ? pick : ORIGIN_ALL;
}
