/**
 * What the top of a chat shows of its task's Threads (experiment top_thread, TopThread.tsx), kept
 * apart from the component so the strip and the tests read it without React. Pure.
 */
import type { ActionItem } from '@open-walnut/user-status';
import { orderedForHim, threadCountLabel } from '@open-walnut/thread-view';
import { HELD_BY_THREAD, groupThreads, threadsForHim } from '@open-walnut/thread-groups';
import type { OrgThread } from '@/api/org-threads';

/** Where the top's Hide is kept (utils/view-memory.ts): one choice for every chat, kept over a reload and across devices. */
export const TOP_HIDDEN_VIEW = { page: 'session', name: 'topThread.hidden' } as const;

/** The threads the top steps through, in its order: the ones that wait on him (threadsForHim, the
 *  header's count), the ones that need him first. Pure. */
export function topThreads(threads: readonly OrgThread[] | null, now: number): OrgThread[] {
  return threads ? orderedForHim(threadsForHim(threads, now), { needsFirst: true }) : [];
}

/**
 * Which Action needed items a thread can hold, so a decision is drawn once, as the thread: the
 * server's rule (src/core/org/thread-holds.ts). Every kind is named (tests/web/top-thread.test.ts).
 */
export { HELD_BY_THREAD };

/**
 * The task's Action needed items that are not one of the threads the top shows (`listed`,
 * topThreads): a live prompt, an approval, and a letter, an ask or a choice no listed thread holds.
 * One a listed thread holds is that thread now, so it shows once, as the thread (behind ‹ ›, the
 * bar points to it: decisionsElsewhere, and the hidden line names it: hiddenAsk); while that thread
 * is out of the list (the node's move, snoozed, closed), the item shows, so it never vanishes from
 * both. Pure.
 */
export function actionsNotThreads(items: readonly ActionItem[], listed: readonly OrgThread[]): ActionItem[] {
  return items.filter((it) => {
    const held = HELD_BY_THREAD[it.kind];
    return !held || !listed.some((t) => held(it, t));
  });
}

/**
 * Whether an item is out of its snooze at `now` (2026-11-23, the user, on a snoozed card that still
 * filled the top of his chat: that he had snoozed it and it still showed). Pure.
 */
export function awakeAt(item: Pick<ActionItem, 'snoozedUntil'>, now: number): boolean {
  const until = item.snoozedUntil ? Date.parse(item.snoozedUntil) : NaN;
  return !(until > now);
}

/**
 * The items the strip above a chat draws: the ones no listed thread holds (actionsNotThreads), and
 * none he snoozed, until its time comes (the top's clock ticks, so it comes back by itself). A
 * snoozed one stays greyed with its Unsnooze on the task's row, as a snoozed thread leaves the top
 * for the Threads view's Snoozed group. Pure.
 */
export function stripItems(items: readonly ActionItem[], listed: readonly OrgThread[], now: number): ActionItem[] {
  return actionsNotThreads(items, listed).filter((it) => awakeAt(it, now));
}

/**
 * The other listed threads that hold one of the task's decisions (`items`), by their place in `list`:
 * what the top's bar points to while the thread on show (`i`) is another one (review 2026-11-22:
 * "1 / 2" with the ask on the second). The bar names it and steps to it; the strip above never
 * redraws it, so stepping through the threads never moves the arrows under his pointer. Pure.
 */
export function decisionsElsewhere(list: readonly OrgThread[], i: number, items: readonly ActionItem[]): number[] {
  const out: number[] = [];
  list.forEach((t, k) => {
    if (k !== i && items.some((it) => HELD_BY_THREAD[it.kind]?.(it, t))) out.push(k);
  });
  return out;
}

/**
 * The thread the hidden line names: the first that holds one of the task's decisions (`items`; the
 * strip leaves those to it, so the line is where the question still shows), else the first waiting
 * on him (2026-11-23, the user, on a hidden top with the same question in the strip above it).
 * None when no thread holds a decision or waits on him. Pure.
 */
export function hiddenAsk<T extends OrgThread>(list: readonly T[], items: readonly ActionItem[]): T | undefined {
  return holdingThreads(list, items)[0] ?? list.find((t) => t.state === 'needs');
}

/** The listed threads that hold one of `items`, in the list's order, each once (the hidden line names the first). Pure. */
export function holdingThreads<T extends OrgThread>(list: readonly T[], items: readonly ActionItem[]): T[] {
  return list.filter((t) => items.some((it) => HELD_BY_THREAD[it.kind]?.(it, t)));
}

/**
 * The chat's threads in the Working group (threadGroupOf: the node's move, `new` or `working`), in
 * the Threads view's order: what the top counts after his own with threads_each_question on
 * (2026-11-25: a question still being worked on sat in the folded Working group, and the line read
 * "1 thread (1 needs you)", so he concluded his question had no thread). Never part of any count
 * of threads for him (threadsForHim). Pure.
 */
export function workingThreads(threads: readonly OrgThread[] | null, now: number): OrgThread[] {
  return threads ? groupThreads(threads, now).working : [];
}

/** The working part of the bar's words, after its pager ("1 / 2 › 1 more · 2 working"); empty with none. Pure. */
export function workingLabel(working: number): string {
  return working > 0 ? `${working} working` : '';
}

/**
 * The hidden line's parts, in order: the threads for him ("16 threads (1 needs you)", "3 threads
 * (2 need you)", "2 threads"; none with none), then how many are being worked on (`working`,
 * workingThreads; 0 while threads_each_question is off). After threads for him they are "2 more
 * working", so the count before them never reads as their total ("1 thread · 1 working" read as
 * one thread in all; a review, 2026-11-25); alone they are "2 threads working". Pure.
 */
export function hiddenParts(list: readonly Pick<OrgThread, 'state'>[], working = 0): string[] {
  const k = list.filter((t) => t.state === 'needs').length;
  const forHim = list.length ? `${threadCountLabel(list.length)}${k ? ` (${k} ${k === 1 ? 'needs' : 'need'} you)` : ''}` : '';
  const worked = working > 0 ? (forHim ? `${working} more working` : `${threadCountLabel(working)} working`) : '';
  return [forHim, worked].filter(Boolean);
}

/** The hidden line's words as one string (hiddenParts): "3 threads (1 needs you) · 2 more working". Pure. */
export function hiddenLine(list: readonly Pick<OrgThread, 'state'>[], working = 0): string {
  return hiddenParts(list, working).join(' · ');
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

