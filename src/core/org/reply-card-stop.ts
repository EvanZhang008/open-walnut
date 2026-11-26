/**
 * A reply's card lines, checked before its turn ends (experiment threads_reply_tag,
 * reply-card-switch.ts; 2026-11-25, the user: Walnut checks the format when the turn ends and sends
 * a wrong or missing line back in the same turn). The session's Stop hook hands Walnut the shape of
 * the reply's last lines with its card lines whole (providers/stop-unanswered-hook.ts
 * LAST_LINES_SCRIPT; never his words), and Walnut answers block, the way a request it has not
 * answered is named (sessions/unanswered-at-stop.ts), when:
 *  - a message of his that this turn read was filed under an open thread of the task, and the reply
 *    holds no card line for that thread;
 *  - a card line cannot be read, or names a thread that is not an open thread of the task;
 *  - a decision line (state needs) is refused by the store: it is written here, through the
 *    thread_update op's own write, so the refusal is the store's own text, and one that passes is
 *    not written a second time at the turn's end (reply-card.ts holdCards, reply-card-decision.ts
 *    upAlready). What the store would refuse because he wrote on the thread since it last waited, or
 *    it asked before, is named in the line's own attributes, all at once (`returned`): there is no
 *    second send-back to name the next one. A decision refused or not read here is also named by
 *    the next status question (status-thread-asked.ts), in case the session's corrected line fails
 *    too;
 *  - a merge the task's own Threads refuse.
 * Once per turn (the hook says nothing on a stop it caused: `stop_hook_active`), and each thing is
 * named at most MAX_CARD_NUDGES times, so a session that cannot fix a line is not held again for it.
 * A session with no Stop hook, or spawned before the hook sent the last lines, is never held: its
 * threads without a line are asked by the status question, as before. Never throws.
 *
 * What goes back is answered with card lines alone (2026-11-25: a session sent back about its
 * threads wrote him a closing chat message about them, "I've left those three threads as they
 * are ..."). Every text is in CARD_STOP_LINES and names the line to write, never a thread_update
 * for what a line can say, and the reason ends by asking for the lines and no other words
 * (cardStopEnd): whatever else the session adds after a hook is a chat message to him. A line that
 * names no open thread, or no thread at all (a placeholder where the id belongs), has nothing to
 * write in its place, so it never holds a turn by itself (CARD_STOP_NO_HOLD); it is named beside
 * another thing that does. This is the only check of the Stop hook that asks a session
 * that writes card lines about its threads (thread-summary-stop.ts is off for it);
 * tests/core/org/stop-checks-guard.test.ts lists every check and every text.
 */
import { cardTagLine, CARD_TAG_FORM, readCardTags, type CardTag } from '../../lib/card-tag.js';
import { asksThreads } from '../sessions/status-threads.js';
import { clause } from '../../utils/format.js';
import { endsDecision, holdCards, noteStopCheck, noteUnreadDecisions, queuedThreads, readBefore } from './reply-card.js';
import { applyNeedsCard, CardLineLacks, needsKey, notOpenReason, upAlready, type CardLack } from './reply-card-decision.js';
import { noteLineAsks } from '../sessions/status-thread-asked.js';
import { replyTagOn } from './reply-card-switch.js';
import { mergeThreads, type OrgThread, type ThreadMessage } from './threads-model.js';

export const MAX_CARD_NUDGES = 2;
/** A message of his older than this is not this turn's: its thread is the status question's to ask. */
const OWED_MS = 6 * 3600_000;
/** The hook waits five seconds for all its checks: this one gives up well before. */
const CHECK_MS = 3000;
const nudged = new Map<string, number>();

/** For tests. */
export function resetCardNudges(): void { nudged.clear(); }

export interface CardStop {
  /** What to send back, or null when every line is in order. */
  reason: string | null;
  /** The threads the reason names. */
  threads: string[];
}

/**
 * His newest message on `t` that this session read and has not answered yet (the turn that is ending
 * answers it). `readBefore`: one filed up to then was read by a turn that has ended (reply-card.ts
 * readBefore, which a restart does not empty), so it is not this turn's, with or without its answer
 * kept under it. Pure.
 */
export function owedMessage(t: OrgThread, sid: string, nowMs: number, readBefore?: string): ThreadMessage | null {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.answer || m.via === 'letter' || m.sid !== sid || nowMs - Date.parse(m.at) > OWED_MS) continue;
    if (readBefore && m.at <= readBefore) continue;
    // A reply from a card above that has not reached this session yet.
    if (m.delivery && m.delivery.state !== 'delivered') continue;
    return m;
  }
  return null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
const period = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The attributes a returned decision lacks, as the session writes them. */
const RETURN_ATTRIBUTES: Record<CardLack, string> = {
  since: 'since="what you did about his message"',
  decision: 'decision="same" (this decision again) or "new" (another: Walnut answers this thread and opens it as its own card)',
};

/**
 * Every text this check sends back, by what it names. `needs` passes the store's own refusal on
 * (threads-store.ts patchThread), which names thread_update only for what a line cannot carry
 * (supersedes, separate_reason, same_ask_reason), and says which attributes its fields are.
 */
export const CARD_STOP_LINES = {
  /** A line that could not be read (lib/card-tag.ts readCardTags names what is wrong). */
  unread: (error: string) => `a card line of your reply was not read: ${period(error)} Its form: ${CARD_TAG_FORM}`,
  /** A line that names no open thread of the task (reply-card.ts notOpenReason). */
  gone: (why: string) => `${clause(why)}. That line is not written; give no line for it.`,
  /** A state line with no thread id where one belongs (lib/card-tag.ts `unnamed`): a placeholder, "none", a made-up id. */
  unnamed: (value: string) => `a card line named no thread (thread=${JSON.stringify(value)}): a line is only for a thread whose id you were given, in the note on his message or here. That line is not written; give no line for it.`,
  merge: (thread: string, why: string) => `${thread} was not merged: ${period(why)} Give it a line with its own state, or merge it into a thread that takes it.`,
  needs: (thread: string, why: string) => `the decision on ${thread} was not put to him. ${period(why)}${/\buser_kind\b/.test(why) ? ' In a card line user_kind is kind="..." and user_kind_why is why="...".' : ''} Its card line again, with that fixed.`,
  /** A decision the store would refuse because he wrote on the thread since it last waited, or it asked before (reply-card-decision.ts CardLineLacks): every attribute it lacks. */
  returned: (thread: string, lacks: readonly CardLack[]) => `the decision on ${thread} was not put to him: ${lacks.includes('since') ? 'he wrote on it since it last waited on him' : 'it asked him a decision before'}. Its line again with ${lacks.map((l) => RETURN_ATTRIBUTES[l]).join(' and ')}.`,
  /** A state line for a thread that waits on his decision: a line never ends one (reply-card.ts cardLines leaves it out). */
  waits: (thread: string) => `${thread} waits on his decision, and a state line does not end that: it was not written. If he has decided it or it needs him no more, settle it with thread_update {"id":"${thread}","state":"answered","reply":"<what he decided, or why it needs him no more, and what came of it>"}; if it still waits on him, give it no line.`,
  /** His message went to a thread the reply gave no line. */
  missing: (t: Pick<OrgThread, 'id' | 'title'>) => `your reply holds no card line for thread ${t.id} ${JSON.stringify(t.title)}, where his message went: ${cardTagLine(t.id)}, with its state (working, waiting, answered or done).`,
} as const;
export type CardStopKind = keyof typeof CARD_STOP_LINES;

/** The kinds with nothing to write in their place: named beside another thing, never holding a turn by themselves. */
export const CARD_STOP_NO_HOLD: readonly CardStopKind[] = ['gone', 'unnamed'];

/** The kinds that ask for a call, not a line: what a line cannot carry (the end of a decision he was asked). */
export const CARD_STOP_CALLS: readonly CardStopKind[] = ['waits'];

/**
 * How every reason ends: the lines and nothing else, since anything else the session adds is a chat
 * message to him. `calls`: how many of the `count` things ask for a call instead of a line.
 */
export function cardStopEnd(count: number, calls = 0): string {
  if (calls >= count) return 'Do that now and write no words about it: anything you add is shown to him as chat.';
  if (calls) return 'Write only the lines asked for now, each on a line of its own, do what the rest name, and no other words about them: anything else you add is shown to him as chat.';
  return count === 1
    ? 'Write only this line now, and no other words about it: anything else you add is shown to him as chat.'
    : 'Write only these lines now, each on a line of its own, and no other words about them: anything else you add is shown to him as chat.';
}

/** The block reason for these things, one plain line each, ending with what to write. Pure. */
export function cardStopReason(lines: readonly string[], calls = 0): string {
  const end = cardStopEnd(lines.length, calls);
  return lines.length === 1 ? `Walnut: ${lines[0]} ${end}` : `Walnut, on the card lines of your reply:\n${lines.map((l) => `- ${l}`).join('\n')}\n${end}`;
}

async function check(sid: string, tail: string, nowMs: number, turn: { gaveUp: boolean }): Promise<CardStop | null> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower() || !(await replyTagOn())) return null;
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const taskId = (await getSessionByClaudeId(sid).catch(() => null))?.taskId;
  if (!taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const task = (await listTasksByIds([taskId]).catch(() => []))[0];
  if (!task || task.phase === 'COMPLETE' || !asksThreads(task)) return null;
  const read = readCardTags(tail);
  const { readThreads } = await import('./threads-store.js');
  const file = await readThreads(taskId);
  noteUnreadDecisions(taskId, file, read.unread);
  const things: Array<{ key: string; kind: CardStopKind; line: string; thread?: string }> = read.errors.map((e) => ({ key: `unread:${e}`, kind: 'unread', line: CARD_STOP_LINES.unread(e) }));
  for (const value of new Set(read.unnamed)) things.push({ key: `unnamed:${value}`, kind: 'unnamed', line: CARD_STOP_LINES.unnamed(value) });
  const good: CardTag[] = [];
  const asked: string[] = [];
  const named = new Set<string>();
  for (const c of read.cards) {
    named.add(c.thread);
    const gone = notOpenReason(file, c.thread);
    if (gone) { things.push({ key: `gone:${c.thread}`, kind: 'gone', thread: c.thread, line: CARD_STOP_LINES.gone(gone) }); continue; }
    // A line that says a decision still before him is over: never written, and never dropped unsaid.
    if (!c.merge && endsDecision(c.state) && file.threads.find((t) => t.id === c.thread)?.state === 'needs') {
      things.push({ key: `waits:${c.thread}`, kind: 'waits', thread: c.thread, line: CARD_STOP_LINES.waits(c.thread) });
      continue;
    }
    // A merge inside the task's own Threads is tried on a copy; one across its tree is judged where it is written.
    if (c.merge && file.threads.some((t) => t.id === c.merge)) {
      try { mergeThreads(file, c.thread, c.merge, `task:${taskId}`, new Date(nowMs).toISOString()); } catch (err) {
        things.push({ key: `merge:${c.thread}:${c.merge}`, kind: 'merge', thread: c.thread, line: CARD_STOP_LINES.merge(c.thread, errorText(err)) });
        continue;
      }
    }
    // A decision already up with these words and choices stands as it is (an earlier turn's line, repeated).
    if (c.state === 'needs' && !upAlready(file.threads, c)) {
      try {
        await applyNeedsCard(taskId, sid, c);
        asked.push(needsKey(c));
      } catch (err) {
        // Named by the next status question too, until a line for it is written.
        noteLineAsks(taskId, [c.thread], []);
        things.push(err instanceof CardLineLacks
          ? { key: `needs:${needsKey(c)}`, kind: 'returned', thread: c.thread, line: CARD_STOP_LINES.returned(c.thread, err.lacks) }
          : { key: `needs:${needsKey(c)}`, kind: 'needs', thread: c.thread, line: CARD_STOP_LINES.needs(c.thread, errorText(err)) });
        continue;
      }
    }
    good.push(c);
  }
  holdCards(sid, good, asked, nowMs, turn);
  const queued = await queuedThreads(sid);
  for (const t of file.threads) {
    // A line for it that was not read is named above already.
    if (t.closed || t.movedTo || named.has(t.id) || queued.has(t.id) || read.unread.some((u) => u.thread === t.id) || read.errors.some((e) => e.includes(t.id))) continue;
    const m = owedMessage(t, sid, nowMs, readBefore(sid, task.status_report));
    if (!m) continue;
    things.push({ key: `missing:${t.id}:${m.id}`, kind: 'missing', thread: t.id, line: CARD_STOP_LINES.missing(t) });
  }
  // Nobody waits for this answer any more, so nothing goes back: nothing counts as named.
  if (turn.gaveUp) return null;
  const open = things.filter((x) => (nudged.get(`${taskId}:${x.key}`) ?? 0) < MAX_CARD_NUDGES).slice(0, 8);
  // A line for no open thread, or for no thread at all, has nothing to write in its place: it holds no turn by itself.
  const due = open.some((x) => !CARD_STOP_NO_HOLD.includes(x.kind)) ? open : [];
  for (const x of due) nudged.set(`${taskId}:${x.key}`, (nudged.get(`${taskId}:${x.key}`) ?? 0) + 1);
  // A long-running server: forget the oldest names.
  while (nudged.size > 2000) nudged.delete(nudged.keys().next().value as string);
  return { reason: due.length ? cardStopReason(due.map((x) => x.line), due.filter((x) => CARD_STOP_CALLS.includes(x.kind)).length) : null, threads: [...new Set(due.flatMap((x) => (x.thread ? [x.thread] : [])))] };
}

/**
 * `tail`: the reply's last lines as the Stop hook sent them (absent: a hook that sends none, so
 * nothing is checked). Null when this session writes no card lines, or the check could not finish in time.
 */
export async function cardLinesAtStop(callerSid: string | undefined, tail: unknown, nowMs = Date.now()): Promise<CardStop | null> {
  const sid = (callerSid ?? '').trim();
  if (!sid || typeof tail !== 'string') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // It goes on after its time ran out (a decision line may be half written): the turn's end waits for it a moment.
  const turn = { gaveUp: false };
  const run = check(sid, tail, nowMs, turn);
  noteStopCheck(sid, turn, run);
  try {
    return await Promise.race([
      run,
      new Promise<null>((r) => { timer = setTimeout(() => { turn.gaveUp = true; r(null); }, CHECK_MS); timer.unref?.(); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
