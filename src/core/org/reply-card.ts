/**
 * A reply's card lines, written to the threads they name (experiment threads_reply_tag,
 * reply-card-switch.ts; lib/card-tag.ts reads the lines; 2026-11-25, the user, translated: "in what
 * it returns, it adds this tag. Then it is both its reply to me and its reply to the thread").
 *
 * When a node's turn ends, Walnut reads the lines off the turn's own last words (reply-card-turn.ts
 * starts the write in the step that arms the status question, which waits for it) and applies each
 * line through the code that already owns the write, never a second copy of its rules:
 *  - working, waiting, answered, done: exactly a line of the status question (sessions/
 *    status-threads.ts applyThreadLines: planThreadWrites, patchForLine, lineMay and the rest), with
 *    its title and its "he reacted" mark under the same conditions the question's lines have;
 *  - needs: the thread_update op's own write (threads-store.ts patchThread), so every refusal of
 *    that op holds (user_kind, needs_options, same_ask, same_subject, other_open_asks, returned_ask);
 *  - merge: thread_update merge_into (thread-tree-merge.ts, threads-store.ts mergeThread).
 * A thread a line spoke for is not asked about by the status question of that turn
 * (sessions/status-thread-carded.ts); every other open thread still is, so a line left out loses
 * nothing. The leader only: a replica keeps no Threads.
 *
 * A line is written from what the reply saw: a message of his the session has not answered when
 * the turn ends (its line is still in the session's queue, or it was filed after the turn's end)
 * fences the line out of its thread, as a message newer than the question does for a status line
 * (status-threads.ts movedSince). Unsure counts as unseen: a thread fenced out is asked about by
 * the status question, as with the switch off. The session's "running" mark is not read: it still
 * says running for a moment after every turn's end, which fenced every line out.
 */
import { log } from '../../logging/index.js';
import { readCardTags, type CardTag } from '../../lib/card-tag.js';
import { cutEnd } from '../text-cut.js';
import type { Task } from '../types.js';
import type { StatusReport } from '../user-status.js';
import {
  applyThreadLines, asksThreads, PROGRESS_MAX, staleAskTitle, wroteSinceAnswer,
  type StatusThreadLine, type ThreadLineState, type ThreadMark,
} from '../sessions/status-threads.js';
import { linesThatAsked, noteLineAsks } from '../sessions/status-thread-asked.js';
import { noteCarded, queueCardWrite } from '../sessions/status-thread-carded.js';
import { replyTagNow } from './reply-card-switch.js';
import { openNotWaiting } from './thread-view.js';
import { THREAD_ASK_MAX, THREAD_TITLE_MAX, type OrgThread, type ThreadMessage, type ThreadPatch, type ThreadsFile } from './threads-model.js';

/** Whether this task's session says where its threads stand with card lines: the switch, and a task the status question asks about its threads. */
export function tagsReplies(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined): boolean {
  return replyTagNow() && asksThreads(task);
}

/** A line that was not written, and why (one line, for the session or the log). */
export interface CardRefusal { thread: string; reason: string }

const cut = (s: string, max: number) => s.slice(0, cutEnd(s, max));

/**
 * Which threads of his the session has not answered yet: named by the lines still in its queue (one
 * its CLI holds and has not answered included: the turn's own lines left the queue when the CLI
 * answered them, before its result). Never throws.
 */
export async function queuedThreads(sessionId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const [{ getQueue }, { parseHinted }, { threadOfHintText }] = await Promise.all([
      import('../session-message-queue.js'), import('../hints/hint-format.js'), import('./reply-thread.js'),
    ]);
    for (const row of await getQueue(sessionId)) {
      const hint = parseHinted(row.message).hints.find((h) => h.kind === 'threads');
      const id = hint ? threadOfHintText(hint.text)?.id : undefined;
      if (id) out.add(id);
    }
  } catch { /* unread: nothing is known to wait */ }
  return out;
}

/**
 * What the reply saw: an answered message always; any other unless its thread still has a line in
 * the session's queue (`queued`), or it was filed after the turn ended (`endedAt`).
 */
export interface ReplySaw { queued: ReadonlySet<string>; endedAt?: string }

const sawMessage = (t: OrgThread, m: ThreadMessage, saw: ReplySaw): boolean => !!m.answer || (!saw.queued.has(t.id) && !(saw.endedAt && m.at > saw.endedAt));

/** The thread's newest message the reply saw ('' for none): a newer one fences the line out. Pure. */
export function seenUpTo(t: OrgThread, saw: ReplySaw): string {
  for (let i = t.messages.length - 1; i >= 0; i--) if (sawMessage(t, t.messages[i], saw)) return t.messages[i].id;
  return '';
}

/**
 * Per session, when his newest message that a turn's end already saw was filed (in memory). The
 * check before the next turn's end owes no line for a message that old (reply-card-stop.ts
 * owedMessage), whether or not its answer is kept under it yet: an isolated server keeps none and a
 * busy one keeps it late, and the check then asked a line for every thread the session had ever
 * answered in (2026-11-25, a live session was sent back for a thread its turn never touched).
 */
const readUpTo = new Map<string, string>();
const READ_MAX = 500;

/**
 * His messages to this session filed up to then were read by a turn that has ended. Kept in memory;
 * after a restart (nothing kept yet) the task's stored report says when this session's last turn
 * ended (`turn_ended_at`, written by its status answer), and what was filed before that was that
 * turn's (review 2026-11-25: after a restart every message of the last six hours with no answer
 * kept counted as owed, and the check sent a turn back for threads it never touched). One filed
 * before then that this turn read from its queue is owed no line here: the status question asks
 * its thread, as with the switch off. Undefined: nothing known, for a session with no report of its own.
 */
export function readBefore(sessionId: string, report?: Pick<StatusReport, 'session_id' | 'turn_ended_at'> | null): string | undefined {
  return readUpTo.get(sessionId) ?? (report?.session_id === sessionId ? report.turn_ended_at : undefined);
}

function noteRead(sessionId: string, file: ThreadsFile, saw: ReplySaw): void {
  let at = readUpTo.get(sessionId) ?? '';
  for (const t of file.threads) for (const m of t.messages) if (m.sid === sessionId && m.at > at && sawMessage(t, m, saw)) at = m.at;
  if (!at) return;
  readUpTo.delete(sessionId);
  readUpTo.set(sessionId, at);
  if (readUpTo.size > READ_MAX) readUpTo.delete(readUpTo.keys().next().value!);
}

/** Why a line names no thread a line can write here, or null. Pure. */
export function notOpenReason(file: ThreadsFile, id: string): string | null {
  const t = file.threads.find((x) => x.id === id);
  if (!t) return `${id} is no thread of this task: a card line names one of your own open threads`;
  if (t.movedTo) return `${id} moved to ${t.movedTo.title} (${t.movedTo.task}) with its work: it is not yours to write`;
  if (t.closed) return `${id} is closed: a new ask about it is a new thread, which Walnut files and names to you`;
  return null;
}

type LineFields = Pick<StatusReport, 'threads' | 'thread_titles' | 'threads_seen'>;

/**
 * The state lines as the status question's own fields, each with what the reply saw of its thread.
 * A title goes on only where a line of the question may give one (an untitled thread, or a title
 * that still asks him what waits on him no more), a reaction only where he wrote since an answer:
 * planThreadWrites holds both. A thread that waits on him, like one the question lists with "no line
 * for it", gets none. Pure.
 */
export function cardLines(file: ThreadsFile, cards: readonly CardTag[], saw: ReplySaw): { fields: LineFields; spoke: Array<{ id: string; upTo: string }>; refused: CardRefusal[] } {
  const threads: StatusThreadLine[] = [];
  const titles: ThreadMark[] = [];
  const seen: ThreadMark[] = [];
  const spoke: Array<{ id: string; upTo: string }> = [];
  const refused: CardRefusal[] = [];
  let hisAt = '';
  for (const t of file.threads) for (const m of t.messages) if (sawMessage(t, m, saw) && m.at > hisAt) hisAt = m.at;
  for (const c of cards) {
    if (!c.state || c.state === 'needs' || c.merge) continue;
    const why = notOpenReason(file, c.thread);
    if (why) { refused.push({ thread: c.thread, reason: why }); continue; }
    const t = file.threads.find((x) => x.id === c.thread)!;
    if (!openNotWaiting(t)) continue;
    const upTo = seenUpTo(t, saw);
    const mark = { id: t.id, upTo, hisAt };
    const progress = c.summary ? cut(c.summary, PROGRESS_MAX) : '';
    threads.push({ ...mark, title: t.title, state: c.state as ThreadLineState, ...(progress ? { progress } : {}) });
    if (c.title && (!t.titled || staleAskTitle(t))) titles.push({ ...mark, title: cut(c.title, THREAD_TITLE_MAX), ...(t.titled ? { retitle: true } : {}) });
    if (c.seen && wroteSinceAnswer(file, t)) seen.push(mark);
    spoke.push({ id: t.id, upTo });
  }
  return { fields: { ...(threads.length ? { threads } : {}), ...(titles.length ? { thread_titles: titles } : {}), ...(seen.length ? { threads_seen: seen } : {}) }, spoke, refused };
}

/** A decision line as the thread_update it stands for: its question is the card's summary unless it wrote one. Pure. */
export function needsPatch(t: Pick<OrgThread, 'title' | 'titled' | 'state' | 'closed'>, c: CardTag): ThreadPatch {
  const ask = cut(c.ask ?? '', THREAD_ASK_MAX);
  return {
    state: 'needs', ask, reply: c.summary ?? ask,
    ...(c.options?.length ? { options: c.options.map((label, i) => ({ label, ...(i === 0 ? { recommended: true } : {}) })) } : {}),
    ...(c.kind ? { user_kind: c.kind } : {}), ...(c.why ? { user_kind_why: c.why } : {}),
    ...(c.title && (!t.titled || staleAskTitle(t)) ? { title: cut(c.title, THREAD_TITLE_MAX) } : {}),
  };
}

/** One decision line as its own words: the same line again is the same write. */
export const needsKey = (c: CardTag): string => JSON.stringify([c.thread, c.ask, c.options ?? [], c.kind ?? '', c.why ?? '', c.summary ?? '', c.title ?? '']);

/** Write one decision line the way thread_update does. Throws the store's own refusal (ThreadError). */
export async function applyNeedsCard(taskId: string, sessionId: string, card: CardTag): Promise<void> {
  const store = await import('./threads-store.js');
  const file = await store.readThreads(taskId);
  const why = notOpenReason(file, card.thread);
  if (why) throw new Error(why);
  const { resolveThreadCaller } = await import('./thread-caller.js');
  const { source } = await resolveThreadCaller(sessionId).catch(() => ({ source: undefined }));
  await store.patchThread(taskId, card.thread, needsPatch(file.threads.find((t) => t.id === card.thread)!, card), `task:${taskId}`, source);
  // Written: a mark left by an earlier refusal of this thread's decision goes (status-thread-asked.ts).
  noteLineAsks(taskId, [], [card.thread]);
  // The task's own ask, when it is this decision, is the thread's from now on: shown once (thread-report-ask.ts).
  await (await import('./thread-report-ask.js')).askNowOnThread(taskId);
}

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

/**
 * The lines a session's reply held when its turn end was checked (the Stop hook, reply-card-stop.ts),
 * kept until the turn ends: the words it adds after being sent back are the turn's last message, and
 * the lines of the reply before them still count. `asked`: the decision lines already written then.
 */
const held = new Map<string, { at: number; cards: CardTag[]; asked: Set<string> }>();
const HELD_MS = 60 * 60_000;
const HELD_MAX = 500;

/**
 * The check still running for a session (reply-card-stop.ts): it goes on after its three seconds ran
 * out, and may still be writing a decision line. The turn's end waits a moment for it, then forgets
 * it, so what it holds later is dropped rather than read as the next turn's.
 */
const checking = new Map<string, { turn: object; run: Promise<unknown> }>();
const CHECK_WAIT_MS = 800;

export function noteStopCheck(sessionId: string, turn: object, run: Promise<unknown>): void {
  checking.set(sessionId, { turn, run });
  void run.then(() => {}, () => {}).then(() => { if (checking.get(sessionId)?.turn === turn) checking.delete(sessionId); });
}

async function stopCheckDone(sessionId: string): Promise<void> {
  const cur = checking.get(sessionId);
  if (!cur) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([cur.run.then(() => {}, () => {}), new Promise<void>((r) => { timer = setTimeout(r, CHECK_WAIT_MS); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  if (checking.get(sessionId)?.turn === cur.turn) checking.delete(sessionId);
}

/** `turn`: the check that holds them (reply-card-stop.ts); one the turn's end no longer waits for holds nothing. */
export function holdCards(sessionId: string, cards: readonly CardTag[], asked: Iterable<string> = [], now = Date.now(), turn?: object): void {
  if (turn && checking.get(sessionId)?.turn !== turn) return;
  held.delete(sessionId);
  held.set(sessionId, { at: now, cards: [...cards], asked: new Set(asked) });
  if (held.size > HELD_MAX) held.delete(held.keys().next().value!);
}

/** Whether a check before the turn's end left lines for this session, or is still reading them. */
function holdsCards(sessionId: string): boolean {
  return held.has(sessionId) || checking.has(sessionId);
}

function takeHeld(sessionId: string, now: number): { cards: CardTag[]; asked: Set<string> } {
  const h = held.get(sessionId);
  held.delete(sessionId);
  return h && now - h.at <= HELD_MS ? h : { cards: [], asked: new Set() };
}

/** Tests only. */
export function resetHeldCards(): void {
  held.clear();
  checking.clear();
  readUpTo.clear();
}

/**
 * Apply the card lines of the reply that ended `task`'s turn. Merges first (the thread is gone after
 * one), then decisions, then the state lines in one write. `endedAt`: when the turn ended (a message
 * of his filed later was never seen). `wordless`: a turn end announced with no words, so with no
 * line held for it nothing is known and what the last turn spoke for stands. Never throws; answers
 * what was written and what was not, with why.
 */
export async function applyReplyCards(input: { task: Task; sessionId: string; reply: string | undefined; now?: number; endedAt?: string; wordless?: boolean }): Promise<{ applied: string[]; refused: CardRefusal[] }> {
  const { task, sessionId } = input;
  const none = { applied: [], refused: [] };
  try {
    const { isFollower } = await import('../server-role.js');
    const { replyTagOn } = await import('./reply-card-switch.js');
    if (isFollower() || !(await replyTagOn()) || !asksThreads(task)) return none;
    await stopCheckDone(sessionId);
    const mine = takeHeld(sessionId, input.now ?? Date.now());
    const read = readCardTags(input.reply);
    // The turn's last message wins for a thread both name.
    const last = new Set(read.cards.map((c) => c.thread));
    const cards = [...mine.cards.filter((c) => !last.has(c.thread)), ...read.cards];
    const store = await import('./threads-store.js');
    // What this turn's end saw of his messages: its lines are written from it, and the next
    // turn's check owes none for them.
    const saw: ReplySaw = { queued: await queuedThreads(sessionId), ...(input.endedAt ? { endedAt: input.endedAt } : {}) };
    if (!input.wordless) noteRead(sessionId, await store.readThreads(task.id), saw);
    if (!cards.length) {
      if (!input.wordless) noteCarded(task.id, []);
      if (read.errors.length) log.task.info('reply card lines: not read', { taskId: task.id, sessionId, errors: read.errors });
      return none;
    }
    const by = `task:${task.id}` as const;
    const applied: string[] = [];
    const refused: CardRefusal[] = [];
    const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
    for (const c of cards.filter((x) => x.merge)) {
      try {
        const { mergeAcrossTree } = await import('./thread-tree-merge.js');
        if (!(await mergeAcrossTree({ from: task, threadId: c.thread, intoId: c.merge!, by }))) await store.mergeThread(task.id, c.thread, c.merge!, by);
        applied.push(c.thread);
      } catch (err) { refused.push({ thread: c.thread, reason: why(err) }); }
    }
    const needs = cards.filter((x) => x.state === 'needs');
    const current = needs.length ? (await store.readThreads(task.id)).threads : [];
    for (const c of needs) {
      const t = current.find((x) => x.id === c.thread);
      if (mine.asked.has(needsKey(c)) || (t && askedAlready(t, c))) {
        // Up already (the check before the turn's end wrote it): no mark of a refusal stays.
        noteLineAsks(task.id, [], [c.thread]);
        applied.push(c.thread);
        continue;
      }
      try {
        await applyNeedsCard(task.id, sessionId, c);
        applied.push(c.thread);
      } catch (err) {
        refused.push({ thread: c.thread, reason: why(err) });
        // A decision that was not written is named by the next status question (status-thread-asked.ts).
        noteLineAsks(task.id, [c.thread], []);
      }
    }
    const lines = cardLines(await store.readThreads(task.id), cards, saw);
    refused.push(...lines.refused);
    const changed = Object.keys(lines.fields).length ? await applyThreadLines(task.id, lines.fields, undefined, 'reply card lines') : [];
    applied.push(...changed);
    // A line whose words asked him to decide was not written: the status question names it. So is
    // a thread that still has no title of its own after its line (none given, or one held): the
    // question asks for one.
    const asked = linesThatAsked(task.id);
    const after = lines.spoke.length ? (await store.readThreads(task.id)).threads : [];
    const named = (id: string) => { const t = after.find((x) => x.id === id); return !!t && !!t.titled && !staleAskTitle(t); };
    noteCarded(task.id, lines.spoke.filter((s) => !asked.has(s.id) && named(s.id)));
    log.task.info('reply card lines applied', { taskId: task.id, sessionId, lines: cards.length, applied, refused, errors: read.errors });
    return { applied, refused };
  } catch (err) {
    log.task.warn('reply card lines: not applied', { taskId: task.id, sessionId, error: err instanceof Error ? err.message : String(err) });
    return none;
  }
}

/**
 * A turn of `task`'s session ended with these words: start writing its card lines now. Called in
 * the step that arms the turn's status question (session-hooks/builtins.ts), which waits for this
 * write before it lists the threads (status-thread-carded.ts cardsWritten), so the order holds by
 * the code's own sequence. Nothing slower is waited for: the lines are in the words themselves.
 *
 * `settledOnly`: the turn end was announced with no words (a snapshot saw it end, or the sweep
 * after a restart announces again a turn whose report is not in: session-hooks/derive/session.ts,
 * sessions/report-phase.ts). Nothing is known of that turn's lines, and it is often the turn just
 * written, so what its lines spoke for stands; only lines the check before its end held are
 * written (a result that came while background work still ran fires no hook of its own).
 * `endedAt`: when the turn ended, for one heard late. Returns at once.
 */
export function turnEndedWith(input: { task: Task | null | undefined; sessionId: string; reply: string | undefined; settledOnly?: boolean; endedAt?: string }): void {
  const { task, sessionId } = input;
  if (!task || !sessionId || !asksThreads(task)) return;
  if (input.settledOnly && !holdsCards(sessionId)) return;
  const endedAt = input.endedAt ?? new Date().toISOString();
  void queueCardWrite(sessionId, () => applyReplyCards({ task, sessionId, reply: input.settledOnly ? undefined : input.reply, endedAt, ...(input.settledOnly ? { wordless: true } : {}) }));
}
