/**
 * Which of a task's Action needed items one of its threads holds, so one decision is drawn once, as
 * that thread (2026-11-21, the user, on a chat whose top showed the same question twice; 2026-11-23,
 * on the same question as a thread card and again as a card under its task's row: "两处都改"). One
 * rule for the server, which marks each item its listed thread holds (`ActionItem.thread`, read by
 * the task rows), and the web's top above a chat (@open-walnut/thread-groups). Every kind is named:
 * a new kind must say whether a thread can hold it (tests/web/top-thread.test.ts holds each).
 *   letter  a thread opened from a decision letter (opener letter, its id the ref) or holding it (letter)
 *   ask     the task's own ask on its thread (thread-report-ask.ts: heldAsk, askId = the decision id)
 *   choice  a Board choice a leader's thread holds (choice: its Board and id)
 *   question, permission, approval  live prompts and approvals: no thread holds them
 * Pure.
 */
import type { ActionItem, ActionKind } from '../action-needed.js';

/** What a thread carries that can hold an item; the stored thread and the web's both have it. */
export interface HoldingThread {
  id: string;
  title: string;
  opener?: { from?: string; ref?: string };
  letter?: { id: string; done?: boolean; off?: boolean };
  heldAsk?: { id: string };
  askId?: string;
  choice?: { board: string; id: string; done?: boolean; off?: boolean };
}

type Held = Pick<ActionItem, 'id' | 'board'>;

export const HELD_BY_THREAD: Record<ActionKind, ((it: Held, t: HoldingThread) => boolean) | null> = {
  letter: (it, t) => (t.opener?.from === 'letter' && t.opener.ref === it.id) || (!!t.letter && !t.letter.done && !t.letter.off && t.letter.id === it.id),
  ask: (it, t) => t.heldAsk?.id === it.id || t.askId === it.id,
  choice: (it, t) => !!t.choice && !t.choice.done && !t.choice.off && t.choice.id === it.id && (!it.board || t.choice.board === it.board),
  question: null,
  permission: null,
  approval: null,
};

/** The first of `listed` that holds the item, or undefined. */
export function holderOf<T extends HoldingThread>(it: Pick<ActionItem, 'kind' | 'id' | 'board'>, listed: readonly T[]): T | undefined {
  const held = HELD_BY_THREAD[it.kind];
  return held ? listed.find((t) => held(it, t)) : undefined;
}

/**
 * The items with each awake one a listed thread holds marked with that thread (`thread`); a snoozed
 * one keeps its card with its time, so it is never marked, and a mark no thread backs any more goes.
 * `listed`: the task's own threads that wait on him, in his view's order (threadsForHim,
 * orderedForHim). Returns the same array when nothing changes.
 */
export function markHeldItems(items: readonly ActionItem[], listed: readonly HoldingThread[]): readonly ActionItem[] {
  let changed = false;
  const out = items.map((it) => {
    const t = it.snoozedUntil ? undefined : holderOf(it, listed);
    const mark = t ? { id: t.id, title: t.title } : undefined;
    if (mark?.id === it.thread?.id && mark?.title === it.thread?.title) return it;
    changed = true;
    const { thread: _old, ...rest } = it;
    return mark ? { ...rest, thread: mark } : rest;
  });
  return changed ? out : items;
}
