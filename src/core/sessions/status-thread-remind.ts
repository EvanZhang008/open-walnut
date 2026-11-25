/**
 * Experiment threads_reminder: a reminder of the open threads now and then, in place of a line for
 * every thread after every turn (2026-11-25, the user, translated: "like that To Do": remind the
 * agent of the threads it still has open and of the ones nobody touched for long, the way Claude
 * Code reminds a session of its to-do list; the plan: "once it is in, the per-turn thread status
 * question goes away").
 *
 * With it on, the status question at a turn's end (status-thread-question.ts threadQuestionOf)
 * lists the threads that need a line now (lineNeed):
 *  - every turn: a thread in the node's hands (new, working), since any turn may have finished it
 *    (a subtask's report, a background job's end; thread-recheck.ts leaves a quiet working thread
 *    to that line while the node's work carries on), and a line its last answer dropped for asking him;
 *  - once, until the thread changes again: a need status-thread-pick.ts ranks first (ASKED_BETWEEN
 *    places each by name), a reaction of his to check on an answer in his sight, and a thread
 *    Walnut's overdue note named since the question last listed it.
 * Nothing needs one: no thread block (a task keeps its one new-subject line). Every REMIND_EVERY-th
 * question, the first after a restart, a new session or a compaction, and sooner when a thread went
 * overdue since the last reminder (thread-view.ts threadOverdue, at most once per REMIND_SOON_MS),
 * is the reminder: every need in full, every other open thread as a short item grouped by state,
 * with one rule: a line only for a thread that moved. What the reply's card lines spoke for
 * (threads_reply_tag) is left out of both.
 *
 * Kept per task in memory, as the neighbours keep theirs (status-thread-pick.ts lastListed): after
 * a restart the first question is a reminder, which only brings it early.
 */
import { experimentCache } from '../experimental-cache.js';
import { REPLY_DUE_MS, summaryAt, threadOverdue } from '../org/thread-view.js';
import type { OrgThread } from '../org/threads-model.js';
import { needName, type NeedName } from './status-thread-pick.js';
import { cutEnd } from '../text-cut.js';

const flag = experimentCache('threads_reminder');
/** The experiment, read from the config now (the status question reads it once per ask). */
export const reminderOn = flag.on;
/** Tests only: the value as last read. */
export const setReminder = flag.set;

/**
 * One status question in this many is the reminder: the hints registry's own "every few turns"
 * (hints/hint-schedule.ts DEFAULT_EVERY_TURNS). Measured 2026-11-25 on saved copies of the eight
 * nodes with the most open threads (docs/reference/threads.md): one in five keeps every node under
 * today's bytes per turn.
 */
export const REMIND_EVERY = 5;
/** A thread gone overdue brings the reminder early at most this often: the overdue clock itself. */
export const REMIND_SOON_MS = REPLY_DUE_MS;
/** Short items a reminder lists at most (about 60 bytes each): the largest node measured asks about 63; the rest go round. */
export const REMIND_LIST_MAX = 60;
/** A short item's title is cut to this. */
export const REMIND_TITLE_MAX = 40;
const TASKS_MAX = 500;
/** Sessions of one task remembered as reminded (a task has one active session; an engine switch adds one). */
const SESSIONS_MAX = 4;

/**
 * How each need needRank names is asked between reminders: 'once' until the thread changes again,
 * 'in-sight' once while its answer is in his sight (answered), 'reminder' never between (it brings
 * the reminder), 'short' only as a short item of the reminder. Typed over every name, so a new rank
 * fails the type check until it is placed here.
 */
export const ASKED_BETWEEN: Readonly<Record<NeedName, 'once' | 'in-sight' | 'reminder' | 'short'>> = {
  asks: 'once', joined: 'once', behind: 'once', overdue: 'reminder', owed: 'once', title: 'once', wrote: 'in-sight', rest: 'short',
};
/** States of a thread in the node's hands: listed at every turn end. */
export const IN_HAND: ReadonlySet<string> = new Set(['new', 'working']);

/** Why this question is the reminder. */
export type RemindWhy = 'first' | 'session' | 'compacted' | 'turns' | 'overdue';

/** The last reminder of a task: the sessions reminded so far (newest first), when, and the questions since. */
export interface Reminded { sids: string[]; at: number; asks: number }

const reminded = new Map<string, Reminded>();

/** What a short item says beyond its state: how long since it was written, and whether he acknowledged it. */
export interface ReminderMark { ago: string; acked?: boolean }

/**
 * Whether this question is the reminder, and why; null between reminders. `overdueAt`: when each
 * open thread went overdue (threadOverdue dueAt). Pure.
 */
export function reminderDue(rec: Reminded | undefined, ctx: { sid?: string; now: number; compactedAt?: string; overdueAt: readonly number[] }): RemindWhy | null {
  if (!rec) return 'first';
  if (!rec.sids.includes(ctx.sid ?? '')) return 'session';
  const compacted = Date.parse(ctx.compactedAt ?? '');
  if (Number.isFinite(compacted) && compacted > rec.at) return 'compacted';
  if (rec.asks + 1 >= REMIND_EVERY) return 'turns';
  if (ctx.now - rec.at >= REMIND_SOON_MS && ctx.overdueAt.some((at) => at > rec.at)) return 'overdue';
  return null;
}

/** When each of these threads went overdue on the reply clock (threadOverdue), for reminderDue. Pure. */
export function overdueTimes(threads: readonly OrgThread[], now: number): number[] {
  return threads.flatMap((t) => {
    const o = threadOverdue(t, now);
    return o?.why === 'reply' ? [Date.parse(o.dueAt)] : [];
  });
}

type Pickable = Parameters<typeof needName>[0] & { hisAt?: string; acked?: boolean };

const ms = (iso: string | undefined): number => { const v = Date.parse(iso ?? ''); return Number.isFinite(v) ? v : -Infinity; };

/** The last thing that happened on the thread: a write, a message of his, an answer. Pure. */
export function lastChangeMs(t: Pick<OrgThread, 'updatedAt' | 'messages'>): number {
  return Math.max(ms(t.updatedAt), ...t.messages.flatMap((m) => [ms(m.at), ms(m.answer?.at)]));
}

/**
 * What the thread needs of the question (`listedAt`: when a question last listed it): 'now' to be
 * listed in full, 'again' a need already asked with nothing moved since (in full at the reminder
 * only: a line that changes nothing writes nothing, status-threads.ts patchForLine, so a need its
 * line cannot move would be asked every turn), null none (a short item at the reminder). Pure.
 */
export function lineNeed(t: Pickable, now: number, listedAt: number | undefined): 'now' | 'again' | null {
  const r = t.recheck;
  if (t.asked || IN_HAND.has(t.state) || (r && !r.pending && ms(r.at) > (listedAt ?? -Infinity))) return 'now';
  const how = ASKED_BETWEEN[needName(t, now, { overdue: false })];
  if (how === 'short' || how === 'reminder' || (how === 'in-sight' && t.state !== 'answered')) return null;
  // A reaction is his word anywhere, not on this thread: asked again after each new message of his,
  // also on a thread whose first need was asked already (a summary it still owes): with
  // threads_reply_tag on this question is the only place his reaction is asked (thread-summary-stop.ts).
  const reaction = how === 'in-sight' || (!!t.wrote && t.state === 'answered');
  const since = Math.max(lastChangeMs(t), reaction ? ms(t.hisAt) : -Infinity);
  return listedAt !== undefined && listedAt >= since ? 'again' : 'now';
}

/**
 * The threads the question lists (`listed`, as listForQuestion gives them): the ones that need a
 * line now with what is asked beside them (a held title's thread, an untitled one's possible
 * subjects); at a reminder every need in full and every other thread as a short item. `skipSince`
 * (a reminder that comes by count or by an overdue thread): a short item written since then is left
 * out, the node wrote it lately; `omitted` counts them. Full items get `overdue` (switch on only). Pure.
 */
export function pickForReminder<T extends Pickable & { besideOnly?: boolean }>(listed: readonly T[], remind: boolean, now: number, last: ReadonlyMap<string, number>, skipSince?: number): { picked: Array<T & { reminder?: ReminderMark; overdue?: boolean }>; omitted: number } {
  const keep = new Set<string>();
  for (const t of listed) {
    const need = t.besideOnly ? null : lineNeed(t, now, last.get(t.id));
    if (!need || (need === 'again' && !remind)) continue;
    keep.add(t.id);
    for (const id of [...(t.held ? [t.held.like] : []), ...(t.untitled ? t.near ?? [] : [])]) keep.add(id);
  }
  const full = (t: T) => (threadOverdue(t, now)?.why === 'reply' ? { ...t, overdue: true } : t);
  if (!remind) return { picked: listed.filter((t) => keep.has(t.id)).map(full), omitted: 0 };
  let omitted = 0;
  const picked = listed.flatMap((t) => {
    if (keep.has(t.id)) return [full(t)];
    const at = ms(summaryAt(t) ?? t.updatedAt);
    if (skipSince !== undefined && at > skipSince) { omitted += 1; return []; }
    return [{ ...t, reminder: { ago: Number.isFinite(at) ? shortAgo(now - at) : 'never', ...(t.acked ? { acked: true } : {}) } }];
  });
  return { picked, omitted };
}

/** `40m`, `3h`, `2d`. Pure. */
export function shortAgo(gap: number): string {
  const m = Math.max(1, Math.round(gap / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The mark of a full item overdue (switch on only). */
export const OVERDUE_WORDS = 'overdue: nothing new on it past its reminder clock, say where it stands';
/** The order the short items are grouped in. */
const STATE_ORDER = ['answered', 'pending', 'working', 'new', 'needs'];

/** Short items grouped by state, in a stable order, so their refs run on within a group. Pure. */
export function inStateOrder<T extends { state: string }>(items: readonly T[]): T[] {
  const rank = (s: string) => { const i = STATE_ORDER.indexOf(s); return i < 0 ? STATE_ORDER.length : i; };
  return items.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.state) - rank(b.t.state) || a.i - b.i).map((x) => x.t);
}

/** One short item: `t13 "Title" 2h`, ` acknowledged` when he acknowledged its result. Pure. */
export function reminderItem(ref: string, title: string, mark: ReminderMark): string {
  return `${ref} "${title.slice(0, cutEnd(title, REMIND_TITLE_MAX))}" ${mark.ago}${mark.acked ? ' acknowledged' : ''}`;
}

/** The reminder's sentence: the short items by state, and the rule. '' for none. Pure. */
export function reminderPart(items: ReadonlyArray<{ state: string; text: string; acked?: boolean }>, omitted: number): string {
  if (!items.length && !omitted) return '';
  const groups: string[] = [];
  for (const it of items) {
    const last = groups.length ? groups[groups.length - 1] : '';
    if (last.startsWith(`${it.state}: `)) groups[groups.length - 1] = `${last}, ${it.text}`;
    else groups.push(`${it.state}: ${it.text}`);
  }
  if (!items.length) return `Reminder: your other ${omitted} open threads you all wrote since the last reminder; give one a line only when it moved since then.`;
  const left = omitted ? ` Not shown: ${omitted} you wrote since the last reminder.` : '';
  const acked = items.some((i) => i.acked) ? ' An acknowledged one closes only with done.' : '';
  return `Reminder of your other open threads, with the time since each was written (give one a line only when it moved since then; leave the rest out): ${groups.join('; ')}.${left}${acked}`;
}

/** The task's last reminder, if any since this server started. */
export function lastReminder(taskId: string): Reminded | undefined {
  return reminded.get(taskId);
}

/** Record a question: the reminder starts the count again and remembers its session, any other counts one more. */
export function noteQuestion(taskId: string, sid: string | undefined, wasReminder: boolean, now: number = Date.now()): void {
  const cur = reminded.get(taskId);
  const id = sid ?? '';
  if (wasReminder || !cur) reminded.set(taskId, { sids: [id, ...(cur?.sids ?? []).filter((s) => s !== id)].slice(0, SESSIONS_MAX), at: now, asks: 0 });
  else cur.asks += 1;
  if (reminded.size > TASKS_MAX) reminded.delete(reminded.keys().next().value!);
}

/** Tests only. */
export function resetReminders(): void {
  reminded.clear();
}
