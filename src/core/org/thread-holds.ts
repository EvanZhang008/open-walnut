/**
 * Which of a task's Action needed items one of its threads holds, so one decision is drawn once, as
 * that thread (2026-11-21, the user, on a chat whose top showed the same question twice). The rule
 * the web's top above a chat reads (@open-walnut/thread-groups). A task row draws its full card
 * whatever holds it (2026-11-23, the user, on a one-line row: "I want this style for all"). Every kind is named:
 * a new kind must say whether a thread can hold it (tests/web/top-thread.test.ts holds each).
 *   letter  a thread opened from a decision letter (opener letter, its id the ref) or holding it (letter)
 *   ask     the task's own ask on its thread (thread-report-ask.ts: heldAsk), or the decision id a
 *           thread stores while it asks it in needs (askId; once it left needs it holds nothing,
 *           review 2026-11-25 N3: an answered thread hid the same decision asked again)
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
  state?: string;
  closed?: unknown;
  choice?: { board: string; id: string; done?: boolean; off?: boolean };
}

type Held = Pick<ActionItem, 'id' | 'board'>;

export const HELD_BY_THREAD: Record<ActionKind, ((it: Held, t: HoldingThread) => boolean) | null> = {
  letter: (it, t) => (t.opener?.from === 'letter' && t.opener.ref === it.id) || (!!t.letter && !t.letter.done && !t.letter.off && t.letter.id === it.id),
  ask: (it, t) => t.heldAsk?.id === it.id || (t.askId === it.id && t.state === 'needs' && !t.closed),
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
