/**
 * What the top of a chat shows of its task's Threads (experiment top_thread, TopThread.tsx), kept
 * apart from the component so the strip and the tests read it without React. Pure.
 */
import type { ActionItem } from '@open-walnut/user-status';
import { listedForHim, orderedForHim, threadCountLabel } from '@open-walnut/thread-view';
import type { OrgThread } from '@/api/org-threads';

/** Where the top's Hide is kept (utils/view-memory.ts): one choice for every chat, kept over a reload and across devices. */
export const TOP_HIDDEN_VIEW = { page: 'session', name: 'topThread.hidden' } as const;

/** The threads the top steps through, in its order: the Threads view's list, the ones that need him first. Pure. */
export function topThreads(threads: readonly OrgThread[] | null, now: number): OrgThread[] {
  return threads ? orderedForHim(listedForHim(threads, now), { needsFirst: true }) : [];
}

/**
 * The task's Action needed items that are not one of the threads the top shows (`listed`,
 * topThreads): a live prompt, an approval, a choice, an ask, a letter. A letter a listed thread was
 * opened from (opener `letter`, its id as the ref) is that thread now, so it shows once, as the
 * thread; while that thread is out of the list (the node's move, snoozed) the letter shows. Pure.
 */
export function actionsNotThreads(items: readonly ActionItem[], listed: readonly OrgThread[]): ActionItem[] {
  const letters = new Set(listed.filter((t) => t.opener?.from === 'letter' && t.opener.ref).map((t) => t.opener!.ref!));
  return items.filter((it) => !(it.kind === 'letter' && letters.has(it.id)));
}

/** The hidden line's words: "16 threads (1 needs you)", "3 threads (2 need you)", "2 threads". */
export function hiddenLine(list: readonly Pick<OrgThread, 'state'>[]): string {
  const k = list.filter((t) => t.state === 'needs').length;
  return `${threadCountLabel(list.length)}${k ? ` (${k} ${k === 1 ? 'needs' : 'need'} you)` : ''}`;
}

/**
 * Where the top stands: the thread it showed, while it is still listed; else the same place in the
 * list (the next one moved up into it), the last one when the list got shorter. Pure.
 */
export function topIndex(list: readonly Pick<OrgThread, 'id'>[], atId: string | null, lastIndex: number): number {
  if (!list.length) return -1;
  const i = atId ? list.findIndex((t) => t.id === atId) : -1;
  return i >= 0 ? i : Math.max(0, Math.min(lastIndex, list.length - 1));
}

