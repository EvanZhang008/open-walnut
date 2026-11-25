/**
 * A decision line (`state="needs"`) as the thread writes it stands for (experiment threads_reply_tag;
 * reply-card.ts reads the lines at the turn's end, reply-card-stop.ts before it). Every write goes
 * through the code that owns it, never a second copy of its rules:
 *  - the decision itself is the thread_update op's own write (threads-store.ts patchThread), so
 *    every refusal of that op holds;
 *  - a decision he must hear as new (`decision="new"` on a thread he wrote on since it last waited,
 *    or whose choices it replaces) is never a rewrite of that thread's card (thread-return.ts): Walnut
 *    carries out what the store asks of a thread_update for it, answering his message on that thread
 *    (state answered, the line's `since` words) and opening the new decision as its own thread
 *    through thread_create's own path (threads-store.ts openNodeThread, `supersedes` naming the old
 *    one), so no tool call is asked of a session whose one send-back a turn is a card line.
 * What the store would refuse because he wrote on the thread or it asked before is found here first,
 * with the store's own rule (thread-return.ts returnLacks), and named all at once (CardLineLacks), so
 * the one send-back says everything the line needs.
 */
import { cutEnd } from '../text-cut.js';
import type { CardTag } from '../../lib/card-tag.js';
import { noteLineAsks } from '../sessions/status-thread-asked.js';
import { staleAskTitle } from '../sessions/status-threads.js';
import { returnLacks, wroteSinceNeeds, type ReturnLack } from './thread-return.js';
import { patchHandsToUser, THREAD_ASK_MAX, THREAD_TITLE_MAX, type OrgThread, type ThreadPatch, type ThreadsFile } from './threads-model.js';

const cut = (s: string, max: number) => s.slice(0, cutEnd(s, max));

/** Why a line names no thread a line can write here, or null. Pure. */
export function notOpenReason(file: ThreadsFile, id: string): string | null {
  const t = file.threads.find((x) => x.id === id);
  if (!t) return `${id} is no thread of this task: a card line names one of your own open threads`;
  if (t.movedTo) return `${id} moved to ${t.movedTo.title} (${t.movedTo.task}) with its work: it is not yours to write`;
  if (t.closed) return `${id} is closed: a new ask about it is a new thread, which Walnut files and names to you`;
  return null;
}

/**
 * A decision line as the thread_update it stands for: its question is the card's summary unless it
 * wrote one. Every field the store's refusal of a return reads is carried here or named in
 * tests/core/org/reply-card-carries-guard.test.ts. Pure.
 */
export function needsPatch(t: Pick<OrgThread, 'title' | 'titled' | 'state' | 'closed'>, c: CardTag): ThreadPatch {
  const ask = cut(c.ask ?? '', THREAD_ASK_MAX);
  return {
    state: 'needs', ask, reply: c.summary ?? ask,
    ...(c.options?.length ? { options: c.options.map((label, i) => ({ label, ...(i === 0 ? { recommended: true } : {}) })) } : {}),
    ...(c.kind ? { user_kind: c.kind } : {}), ...(c.why ? { user_kind_why: c.why } : {}),
    ...(c.since ? { since_you_wrote: c.since } : {}), ...(c.decision ? { decision: c.decision } : {}),
    ...(c.title && (!t.titled || staleAskTitle(t)) ? { title: cut(c.title, THREAD_TITLE_MAX) } : {}),
  };
}

/** One decision line as its own words: the same line again is the same write. */
export const needsKey = (c: CardTag): string => JSON.stringify([c.thread, c.ask, c.options ?? [], c.kind ?? '', c.why ?? '', c.summary ?? '', c.title ?? '', c.since ?? '', c.decision ?? '']);

/**
 * The decision this line asks is already up on its thread (the same question and choices): the
 * check at the turn's end wrote it and its hold was lost (a check that outlived its time, a restart
 * between the two), or an earlier turn's line is repeated. Written again it is refused as an ask
 * already up, or rewrites a card he has seen. Pure.
 */
export function askedAlready(t: Pick<OrgThread, 'state' | 'closed' | 'ask' | 'options'>, c: CardTag): boolean {
  if (t.closed || t.state !== 'needs' || (t.ask ?? '').trim() !== cut(c.ask ?? '', THREAD_ASK_MAX).trim()) return false;
  return JSON.stringify((t.options ?? []).map((o) => o.label)) === JSON.stringify(c.options ?? []);
}

/** The line's decision is up already: on its thread, or (a new decision) on the thread Walnut opened for it. Pure. */
export function upAlready(threads: readonly OrgThread[], c: CardTag): boolean {
  const own = threads.find((t) => t.id === c.thread);
  if (own && askedAlready(own, c)) return true;
  return c.decision === 'new' && threads.some((t) => askedAlready(t, c));
}

/** What a decision line lacks to pass the store's rules for a thread he wrote on or that asked before, in the line's own attributes. */
export type CardLack = Exclude<ReturnLack, 'new'>;

/** A decision line the store would refuse as a return: everything it lacks, named at once. */
export class CardLineLacks extends Error {
  constructor(readonly thread: string, readonly lacks: readonly CardLack[]) {
    super(`the decision on ${thread} lacks ${lacks.map((l) => (l === 'since' ? 'since="..."' : 'decision="same" or "new"')).join(' and ')}`);
    this.name = 'CardLineLacks';
  }
}

/**
 * Write one decision line the way thread_update does; a new decision opens its own thread. Throws
 * CardLineLacks for what the line lacks, else the store's own refusal (ThreadError). Answers the
 * thread Walnut opened, if any.
 */
export async function applyNeedsCard(taskId: string, sessionId: string, card: CardTag): Promise<{ opened?: string }> {
  const store = await import('./threads-store.js');
  const file = await store.readThreads(taskId);
  const why = notOpenReason(file, card.thread);
  if (why) throw new Error(why);
  const { resolveThreadCaller } = await import('./thread-caller.js');
  const { source } = await resolveThreadCaller(sessionId).catch(() => ({ source: undefined }));
  const before = file.threads.find((t) => t.id === card.thread)!;
  const report = (await (await import('../task-manager.js')).getTask(taskId).catch(() => null))?.status_report;
  const by = `task:${taskId}` as const;
  const patch = needsPatch(before, card);
  const lacks = returnLacks(before, patch, by, patchHandsToUser(before, patch));
  const missing = lacks.filter((l): l is CardLack => l !== 'new');
  if (missing.length) throw new CardLineLacks(card.thread, missing);
  const asks = await import('./thread-report-ask.js');
  let target = card.thread;
  let opened: string | undefined;
  if (lacks.includes('new')) {
    opened = await openNewDecision(taskId, before, card, patch, source);
    target = opened;
  } else {
    await store.patchThread(taskId, card.thread, patch, by, source);
  }
  // Written: a mark left by an earlier refusal of this thread's decision goes (status-thread-asked.ts).
  noteLineAsks(taskId, [], [card.thread, ...(opened ? [opened] : [])]);
  // The decision it carries, by id: the task's own when the line asks it, so the folds under it follow it (thread-held-decision.ts).
  await asks.markThreadDecision(taskId, target, asks.cardDecisionId(opened ? undefined : before, { ask: patch.ask, options: card.options }, report));
  // The task's own ask, when it is this decision, is the thread's from now on: shown once (thread-report-ask.ts).
  await asks.askNowOnThread(taskId);
  return opened ? { opened } : {};
}

/**
 * What thread_update asks for a new decision on this thread (thread-return.ts), done for the line:
 * his message is answered here (state answered, with the line's `since` words), then the new
 * decision opens as its own thread that supersedes this one, with thread_create's door and checks
 * (threads-store.ts openNodeThread). A thread still waiting on him with nothing of his since is not
 * answered: `supersedes` steps it aside (thread-supersede.ts). Answers the new thread's id.
 */
async function openNewDecision(taskId: string, before: OrgThread, card: CardTag, patch: ThreadPatch, source: Parameters<typeof import('./threads-store.js').patchThread>[4]): Promise<string> {
  const store = await import('./threads-store.js');
  const by = `task:${taskId}` as const;
  const input = {
    title: card.title ? cut(card.title, THREAD_TITLE_MAX) : before.title, text: patch.ask ?? '', reply: patch.reply, from: 'node' as const, state: 'needs' as const, ask: patch.ask,
    ...(patch.options ? { options: patch.options } : {}),
    ...(patch.user_kind ? { user_kind: patch.user_kind } : {}), ...(patch.user_kind_why ? { user_kind_why: patch.user_kind_why } : {}),
    supersedes: [before.id],
  };
  // Every refusal of the new thread first: a refused decision leaves his message unanswered here,
  // never an answered card with no decision behind it (review 2026-11-25).
  await store.openNodeThreadChecks(taskId, input, by, source, { sameSubject: true });
  if (wroteSinceNeeds(before)) await store.patchThread(taskId, before.id, { state: 'answered', reply: card.since ?? '' }, by, source);
  const opened = await store.openNodeThread(taskId, input, by, source, { sameSubject: true });
  return opened.id;
}
