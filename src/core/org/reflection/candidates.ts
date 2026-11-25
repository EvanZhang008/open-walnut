/**
 * The candidate stage of one node's reflection (pipeline.ts judges what it finds): every moment of
 * its team worth a look, read-only, so a replay (scripts/reflection-replay.mjs) runs the same code
 * over a copy of real data and sends nothing. Its inputs:
 *
 *  - his messages to the ordinary tasks of the team (user-asks/<task>.json);
 *  - his messages in the Threads of the node itself and of every Main or lead task in its team
 *    (threads-store.ts readThreads): Main and the leads file his words there, never in user-asks
 *    (2026-11-20: 308 of his 442 messages that day were thread messages, and none was read);
 *  - every ask of the team in Needs you (user_status.state 'needs'), judged once per decision, with
 *    his messages of the last 48 hours in that task and the threads that went to it as the evidence
 *    of what he already said yes to or answered;
 *  - every answer to him in another language than his reply-language setting asks for (language.ts):
 *    one finding a session (or thread) a day, no model call.
 *
 * A task whose own lead reflects is left to that lead, so one moment is judged by one node.
 *
 * A card answer (`Answer to "<ask>": <words>`) is read as his words only: the quoted ask is the
 * agent's, and it is what his words answer.
 */
import crypto from 'node:crypto';
import { dutyOn } from '../duties/node-duties.js';
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { lastAssistantBefore, threadLater, threadTurns, turnsAround, type ReadTranscript, type TurnText } from './context.js';
import { manyRoundWindows, messageSignals, parseCardAnswer, type ReflectionSignal, type RoundsWindow, type SpokenMessage } from './signals.js';
import { asksForEnglish, readsNotChinese, wantsChinese } from './language.js';
import { managedTasks, managerOf } from './team.js';
import { localDate } from './state.js';

/**
 * A moment older than this is not judged: its correction would come too late. Three days, so a day
 * whose judge budget ran out early has its leftovers judged on the next days (2026-11-23 audit: a
 * node spent its 40 calls by 11:09 UTC and the rest of that day was never judged).
 */
export const MOMENT_MAX_AGE_MS = 72 * 3600_000;
/** A message is judged once the session had this long to answer it. */
export const ANSWER_GRACE_MS = 3 * 60_000;
/** A needs ask's evidence: his messages this far back, at most EVIDENCE_MAX (the newest), each cut to EVIDENCE_TEXT_MAX. */
export const EVIDENCE_MS = 48 * 3600_000;
export const EVIDENCE_MAX = 30;
export const EVIDENCE_TEXT_MAX = 600;

/** A thread message as the reflection reads it (threads-model.ts ThreadMessage, the fields it needs). */
export interface ReflectionThreadMessage { id: string; at: string; text: string; sid?: string; images?: string[]; answer?: { text: string; at: string; sid?: string } }
/** One choice on a card (user-status.ts AskOption, the fields the reflection reads). */
export interface CardOption { label: string; recommended?: boolean }
/**
 * `tasks`: the tasks the thread went to (OrgThread.tasks). In needs (`state`), the card he reads:
 * its summary (`reply`, written by `replySid`) and its buttons (`options`).
 */
export interface ReflectionThread {
  id: string; title: string; messages: ReflectionThreadMessage[]; tasks?: string[];
  state?: string; closed?: boolean; reply?: string; replyAt?: string; replySid?: string; updatedAt?: string; options?: CardOption[];
  /** The decision the card asks (minted once per ask), and whether its card shows another's words (a task's ask, a letter, a choice). */
  askId?: string; cardOfOther?: boolean;
}

export interface Candidate {
  key: string;
  signal: ReflectionSignal;
  /** Other signals the same message carries. */
  also?: ReflectionSignal[];
  /** The task the moment belongs to: the thread's owner for a thread message. Its correction goes here. */
  task: Task;
  /** The session judged and corrected; '' when none is known. */
  sessionId: string;
  /** Why its correction is recorded but never sent (an ask whose asking session is unknown). */
  hold?: 'no_asking_session' | 'no_session';
  /** needs_ask: which card or decision it is (a thread card's ask id, an ask's decision id or words): one correction a while per card. */
  cardId?: string;
  /** His messages it is about (oldest first); none for an ask he has not answered. */
  messages: SpokenMessage[];
  from: string;
  to: string;
  /** Why it was picked, in a few words (logs, the replay). */
  why: string;
  thread?: { id: string; title: string };
  /** The conversation already known (a thread's messages and answers): no transcript is read. */
  context?: TurnText[];
  /** A thread's answers after the moment (context.ts threadLater): what the node did since, for the judge's LATER. */
  later?: TurnText[];
  /** needs_ask: the ask Needs you showed him, and its decision. */
  ask?: { text: string; decisionId?: string };
  /** needs_ask: his messages of the last EVIDENCE_MS in the task and the threads that went to it. */
  evidence?: SpokenMessage[];
  /** wrong_language: the answer measured. */
  answer?: { text: string; at: string };
}

export interface CandidateDeps {
  readTranscript: ReadTranscript;
  /** His messages per task (user-asks.ts). */
  readMessages: (taskId: string) => Promise<Array<SpokenMessage & { sid?: string }>>;
  /** The Threads of a Main or lead task (threads-store.ts). */
  readThreads: (taskId: string) => Promise<ReflectionThread[]>;
  replyLanguage: () => Promise<string | null>;
  nowMs: () => number;
  /** The session a send to this task reaches now (session-send-core.ts currentSessionOfTask): an org node's slot fields are empty. */
  currentSession?: (task: Task) => Promise<string>;
  /** The task's session running when a message was written (session-send-core.ts sessionOfTaskAt), for one that names none. */
  sessionAt?: (task: Task, at: string) => Promise<string>;
}

/**
 * A task's session now: the send's own pick ('' when no session of it is live: never an archived slot),
 * or, without that lookup, its slot fields. A failed lookup throws: it is no answer, not "no session".
 */
export async function sessionNowOf(task: Task, deps: { currentSession?: (task: Task) => Promise<string> }): Promise<string> {
  if (deps.currentSession) return deps.currentSession(task);
  return task.session_id || task.exec_session_id || '';
}

/** The session a message of his went to: its own, else the task's session running then, else (no such lookup) the session now. */
async function sessionOfMessage(task: Task, m: { sid?: string; at: string }, deps: CandidateDeps, now: () => Promise<string>): Promise<string> {
  if (m.sid) return m.sid;
  if (deps.sessionAt) return deps.sessionAt(task, m.at).catch(() => '');
  return now().catch(() => '');
}

interface Pass { now: number; floor: string; seen: ReadonlySet<string>; lang: boolean; deps: CandidateDeps; out: Candidate[]; quiet: string[]; threadsOf: (taskId: string) => Promise<ReflectionThread[]> }
/** What every candidate of one place shares: its task, session, thread. */
type Place = Pick<Candidate, 'task' | 'sessionId' | 'thread' | 'hold'>;

const withAlso = (signals: ReflectionSignal[]) => ({ signal: signals[0], ...(signals.length > 1 ? { also: signals.slice(1) } : {}) });
const has = (p: Pass, key: string) => p.seen.has(key) || p.out.some((c) => c.key === key);
const sha12 = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);

/**
 * One of his messages with a signal. `before` is what the agent said just before (read only when the
 * words carry a signal; a card answer's own ask stands for it). True when it became a candidate.
 */
async function signalStep(
  p: Pass, key: string, m: SpokenMessage, place: Place, before: () => Promise<string | undefined>, extra: Partial<Candidate> = {},
): Promise<boolean> {
  if (p.seen.has(key) || p.now - Date.parse(m.at) < ANSWER_GRACE_MS) return false;
  const card = parseCardAnswer(m.text);
  const words = card?.words ?? m.text;
  if (!messageSignals(words).length) return false;
  // Unknown turn before (no transcript): no overrule can be told, only the other signals.
  const signals = messageSignals(words, (card ? card.ask : await before()) ?? '');
  if (!signals.length) { p.quiet.push(key); return false; }
  p.out.push({
    key, ...withAlso(signals), ...place, messages: [m], from: m.at, to: m.at, ...extra,
    why: `${signals.join(', ')}${card ? ' (in a card answer)' : ''}${place.thread ? ' in a thread' : ''}`,
  });
  return true;
}

/** The closed many-round windows of one place's messages. */
function roundsStep(p: Pass, msgs: readonly SpokenMessage[], keyOf: (w: RoundsWindow) => string, place: (w: RoundsWindow) => Place & Partial<Candidate>): void {
  for (const w of manyRoundWindows(msgs, p.now)) {
    const key = keyOf(w);
    if (has(p, key)) continue;
    const mine = msgs.filter((m) => w.ids.includes(m.id));
    p.out.push({ key, signal: 'many_rounds', ...place(w), messages: mine, from: w.from, to: w.to, why: `many_rounds (${mine.length} messages, ${w.followUps} follow-ups)` });
  }
}

/** An answer to one of his messages, as the language check reads it. */
interface Answered { his?: SpokenMessage; answer: { text: string; at: string }; sid: string; place: Place & Partial<Candidate> }

/**
 * Every answer to him in another language than his setting: one candidate a session a day (or a
 * task's thread when no session is known). An answer to a message that asks for English text is exempt.
 */
function languageStep(p: Pass, answers: readonly Answered[], fallback: (a: Answered) => string): void {
  if (!p.lang) return;
  for (const a of answers) {
    if (a.answer.at <= p.floor || !readsNotChinese(a.answer.text)) continue;
    if (a.his && asksForEnglish(parseCardAnswer(a.his.text)?.words ?? a.his.text)) continue;
    const key = `lang:${a.sid || fallback(a)}:${localDate(Date.parse(a.answer.at))}`;
    if (has(p, key)) continue;
    p.out.push({
      key, signal: 'wrong_language', ...a.place, sessionId: a.sid, messages: a.his ? [a.his] : [], from: a.answer.at, to: a.answer.at,
      answer: a.answer, why: `wrong_language (${a.place.thread ? 'a thread answer' : 'a session answer'})`,
    });
  }
}

/** The session's text turns that answer one of his messages: after his turn, before any other sender's. */
function answersToHim(turns: readonly TurnText[], since: string): Array<{ his: TurnText; answer: TurnText }> {
  const out: Array<{ his: TurnText; answer: TurnText }> = [];
  let his: TurnText | undefined;
  for (const t of turns) {
    if (t.role === 'user') his = t;
    else if (t.role === 'agent') his = undefined;
    else if (his && his.at >= since) out.push({ his, answer: t });
  }
  return out;
}

/** His messages to one ordinary task: a signal, a closed many-round window, an answer in the wrong language. */
async function taskCandidates(task: Task, p: Pass): Promise<void> {
  const all = (await p.deps.readMessages(task.id)).filter((m) => m.at > p.floor).sort((a, b) => a.at.localeCompare(b.at));
  const cache = new Map<string, Promise<TurnText[]>>();
  const turns = (sid: string, from: string, to: string) => {
    if (!sid) return Promise.resolve([]);
    const k = `${sid}|${from}|${to}`;
    if (!cache.has(k)) cache.set(k, turnsAround(sid, from, to, p.deps.readTranscript, { turnsBefore: 4 }).catch(() => []));
    return cache.get(k)!;
  };
  let nowSid: Promise<string> | undefined;
  const now = () => (nowSid ??= sessionNowOf(task, p.deps));
  const sidOf = new Map<string, string>();
  for (const m of all) sidOf.set(m.id, await sessionOfMessage(task, m, p.deps, now));
  for (const m of all) {
    const sid = sidOf.get(m.id) ?? '';
    await signalStep(p, `msg:${task.id}:${m.id}`, m, { task, sessionId: sid }, async () => lastAssistantBefore(await turns(sid, m.at, m.at), m.at));
  }
  roundsStep(p, all, (w) => `rounds:${task.id}:${w.ids[0]}`, (w) => ({ task, sessionId: sidOf.get(w.ids[w.ids.length - 1]) ?? '' }));
  if (!p.lang || !all.length) return;
  // The session's answers to him since his first new message, read once until he writes again.
  const last = all[all.length - 1];
  const checked = `langchk:${task.id}:${last.id}`;
  if (p.seen.has(checked)) return;
  const sid = sidOf.get(last.id) ?? '';
  const t = await turns(sid, all[0].at, last.at);
  if (t.some((x) => x.role === 'assistant' && x.at > last.at)) p.quiet.push(checked);
  languageStep(p, answersToHim(t, all[0].at).map(({ his, answer }) => ({
    his: { id: '', at: his.at, text: his.text }, answer: { text: answer.text, at: answer.at }, sid, place: { task, sessionId: sid },
  })), () => task.id);
}

/** His messages in one Main or lead task's Threads: a signal, a closed many-round window, an answer in the wrong language. */
async function threadCandidates(owner: Task, p: Pass): Promise<void> {
  for (const th of await p.threadsOf(owner.id)) {
    const msgs = [...th.messages].sort((a, b) => a.at.localeCompare(b.at));
    const thread = { id: th.id, title: th.title };
    // A thread message's own session, never the owner's current one: with none known, recorded only.
    const place = (sid: string | undefined): Place => ({ task: owner, sessionId: sid ?? '', thread, ...(sid ? {} : { hold: 'no_session' as const }) });
    // One message, one candidate: a message judged for its words is not checked for its answer's language too.
    const judged = new Set<string>();
    for (const [i, m] of msgs.entries()) {
      if (m.at <= p.floor) continue;
      // Keyed by the message alone (tm- ids are unique): a thread moved to another node (thread-follow.ts)
      // is not judged again. What the agent said just before: the thread's answer to his message before.
      const hit = await signalStep(p, `tmsg:${m.id}`, m, place(m.sid),
        async () => msgs[i - 1]?.answer?.text, { context: threadTurns(msgs, i), later: threadLater(msgs, i) });
      if (hit) judged.add(m.id);
    }
    const fresh = msgs.filter((m) => m.at > p.floor);
    roundsStep(p, fresh, (w) => `trounds:${th.id}:${w.ids[0]}`, (w) => {
      const lastIdx = msgs.findIndex((m) => m.id === w.ids[w.ids.length - 1]);
      return { ...place(msgs[lastIdx]?.sid), context: threadTurns(msgs, lastIdx, w.ids.length), later: threadLater(msgs, lastIdx) };
    });
    // One chat reply is filed under every thread it answers: keyed by its session, it is found once a day.
    languageStep(p, msgs.flatMap((m, i) => (m.answer && !judged.has(m.id) ? [{
      his: m, answer: { text: m.answer.text, at: m.answer.at }, sid: m.answer.sid ?? m.sid ?? '',
      place: { ...place(m.answer.sid ?? m.sid), context: threadTurns(msgs, i, 0) },
    }] : [])), () => th.id);
  }
}

/** A card as he reads it: its words, then its buttons or that it has none. Pure. */
export function cardText(head: string, words: string, options: readonly CardOption[] | undefined, kind?: string): string {
  const buttons = options?.length
    ? `Buttons: ${options.map((o) => `[${o.label}${o.recommended ? ' (recommended)' : ''}]`).join(' ')}`
    : kind === 'yes_no' ? 'Buttons: [Yes] [No]' : 'Buttons: none (he answers in his own words)';
  return [head, words.trim() || '(no summary written: the card shows only a line Walnut took from the latest answer)', buttons].filter(Boolean).join('\n');
}

/**
 * A thread card of the node or a lead in its team waiting on his decision (state needs): judged once
 * per decision (its ask id; with none, its summary and buttons), for whether a reader who never saw the work
 * knows from it what he decides, what is recommended, where the plan is, and can answer with one
 * click (2026-11-21, the user: "what the fucking is the plan"; the card showed one line and no buttons).
 */
/** A thread card as it is judged now, or null when it is not (closed, not waiting, too old, too new). */
function cardJudgedNow(th: ReflectionThread, p: Pass): { key: string; at: string; evidence: Array<{ id: string; at: string; text: string }> } | null {
  if (th.state !== 'needs' || th.closed) return null;
  const at = th.replyAt ?? th.updatedAt ?? th.messages[th.messages.length - 1]?.at;
  if (!at || at <= p.floor || p.now - Date.parse(at) < ANSWER_GRACE_MS) return null;
  // From before the card: a card judged days later still shows what he had said by then.
  const since = new Date(Math.min(p.now, Date.parse(at)) - EVIDENCE_MS).toISOString();
  const evidence = th.messages.filter((m) => m.at > since).slice(-EVIDENCE_MAX)
    .map((m) => ({ id: m.id, at: m.at, text: m.text.length > EVIDENCE_TEXT_MAX ? `${m.text.slice(0, EVIDENCE_TEXT_MAX)} [...]` : m.text }));
  // Once per decision: a summary rewritten for the same ask is not judged again (each rewrite would spend a call).
  // With no ask id, once per message of his it follows: a card rewritten five times after one complaint of his
  // was judged five times on the same words (2026-11-24 audit); with none of his, once per wording.
  const newest = evidence[evidence.length - 1]?.id;
  const key = `card:${th.id}:${th.askId ?? (newest ? `after:${newest}` : sha12(cardText('', th.reply ?? '', th.options)))}`;
  return { key, at, evidence };
}

async function threadCardCandidates(owner: Task, p: Pass): Promise<void> {
  for (const th of await p.threadsOf(owner.id)) {
    // A task's own ask is judged as that ask (needsAskCandidate); a letter or a choice is not the thread's words.
    if (th.cardOfOther) continue;
    const j = cardJudgedNow(th, p);
    if (!j || has(p, j.key)) continue;
    const sessionId = th.replySid ?? '';
    p.out.push({
      key: j.key, signal: 'needs_ask', task: owner, sessionId, ...(sessionId ? {} : { hold: 'no_asking_session' as const }), messages: [], from: j.at, to: j.at, cardId: th.askId ?? 'card',
      thread: { id: th.id, title: th.title }, context: threadTurns([...th.messages].sort((a, b) => a.at.localeCompare(b.at)), th.messages.length - 1, 4),
      ask: { text: cardText(`Thread card: ${th.title}`, th.reply ?? '', th.options) }, evidence: j.evidence, why: 'needs_ask (a thread card waiting on him)',
    });
  }
}

/**
 * An ask of the team in Needs you, once per decision (its id, or, with none, the ask's source and
 * words: never its time, which every report moves). Its evidence is his recent messages in the
 * task and in the threads that went to it; its correction goes only to the session that asked.
 */
async function needsAskCandidate(task: Task, node: Task, all: readonly Task[], p: Pass): Promise<Candidate | null> {
  const r = task.user_status;
  // Only the session's own ask: an error, a prompt, an approval, a letter or a choice is Walnut's
  // record of something else, never a question the session chose to put to him.
  if (r?.state !== 'needs' || r.source !== 'session') return null;
  const words = (r.ask ?? '').trim();
  const decisionId = r.decision?.id;
  if (!words && !decisionId) return null;
  // The card as he reads it, buttons included; keyed by its words alone, so a key never moves.
  const form = r.askForm;
  const askAt = r.at ?? r.checkedAt;
  if (askAt && askAt <= p.floor) return null;
  const key = decisionId ? `ask:${task.id}:${decisionId}` : `ask:${task.id}:${r.source}:${sha12(words)}`;
  if (p.seen.has(key)) return null;
  const since = new Date(Math.min(p.now, askAt ? Date.parse(askAt) : p.now) - EVIDENCE_MS).toISOString();
  const own = (await p.deps.readMessages(task.id)).filter((m) => m.at > since);
  const holders = [...new Set([(managerOf(task, all) ?? node).id, node.id])];
  // A thread card waiting on him about this task alone is where he reads the ask, buttons and links
  // included (2026-11-24 audit: six findings said "no buttons, no draft" of an ask whose card had both):
  // the ask is judged as that card shows it. A card about several tasks is not this ask's.
  const card = (await Promise.all(holders.map((id) => p.threadsOf(id)))).flat()
    .find((th) => th.state === 'needs' && !th.closed && th.tasks?.length === 1 && th.tasks[0] === task.id);
  // A card of its own is the one judgment of this ask, judged on its own (threadCardCandidates) whenever it
  // changes: the task's status line is not what he reads then (2026-11-25 audit: 6 of 15 wrong "not done"
  // findings judged a stale status line as his card, one card 7 times in 7 hours).
  if (card && !card.cardOfOther) return null;
  const inThreads = (await Promise.all(holders.map(async (id) => (await p.threadsOf(id))
    .filter((th) => th.tasks?.includes(task.id))
    .flatMap((th) => th.messages.filter((m) => m.at > since).map((m) => ({ id: m.id, at: m.at, text: `[in the thread "${th.title}"] ${m.text}` })))))).flat();
  const evidence = [...own.map((m) => ({ id: m.id, at: m.at, text: m.text })), ...inThreads]
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-EVIDENCE_MAX)
    .map((m) => ({ ...m, text: m.text.length > EVIDENCE_TEXT_MAX ? `${m.text.slice(0, EVIDENCE_TEXT_MAX)} [...]` : m.text }));
  const text = form ? cardText('', [form.summary, form.more ?? ''].filter(Boolean).join('\n\n'), form.options, form.kind)
    : card ? cardText(`Thread card: ${card.title}`, card.reply || words, card.options) : cardText('', words, undefined);
  const sessionId = r.askSessionId ?? '';
  const at = askAt ?? new Date(p.now).toISOString();
  return {
    key, signal: 'needs_ask', task, sessionId, ...(sessionId ? {} : { hold: 'no_asking_session' }), messages: [], from: at, to: at, cardId: decisionId ?? sha12(words),
    ask: { text, ...(decisionId ? { decisionId } : {}) }, evidence, why: `needs_ask${decisionId ? ` (decision ${decisionId})` : ''}`,
  };
}

/**
 * Every candidate of one node's team since `since` (and at most MOMENT_MAX_AGE_MS old), less the
 * keys `seen`. `quiet` are keys a second look dropped, for the caller to mark seen. Reads only.
 */
export async function collectCandidates(
  node: Task, all: readonly Task[], since: string, seen: ReadonlySet<string>, deps: CandidateDeps,
): Promise<{ candidates: Candidate[]; quiet: string[] }> {
  const now = deps.nowMs();
  const threadsCache = new Map<string, Promise<ReflectionThread[]>>();
  const p: Pass = {
    now, seen, deps, out: [], quiet: [],
    floor: new Date(Math.max(Date.parse(since), now - MOMENT_MAX_AGE_MS)).toISOString(),
    lang: wantsChinese(await deps.replyLanguage().catch(() => null)),
    threadsOf: (id) => {
      if (!threadsCache.has(id)) threadsCache.set(id, deps.readThreads(id).catch(() => []));
      return threadsCache.get(id)!;
    },
  };
  const guarded = async (taskId: string, step: () => Promise<unknown>) => {
    await step().catch((err) => log.task.warn('reflection: candidates not read', { nodeId: node.id, taskId, error: err instanceof Error ? err.message : String(err) }));
  };
  // A task another reflecting node below this one manages (by project or by parent, user-status.ts
  // briefTeam) is that node's to judge: one moment is judged once (11-20 replay: Main and the VP each
  // found the VP's team's messages). A completed lead runs no pass (nodesWithDuty), so its team stays here.
  const reflects = (t: Task) => (t.org_role === 'main' || t.org_role === 'lead') && t.id !== node.id && t.phase !== 'COMPLETE' && dutyOn(t, 'reflection');
  const managed = managedTasks(node, all, now);
  const covered = new Set(managed.filter(reflects).flatMap((r) => managedTasks(r, all, now).map((t) => t.id)));
  const mine = managed.filter((t) => !covered.has(t.id));
  for (const t of mine) await guarded(t.id, () => taskCandidates(t, p));
  // The same for Threads: a lead whose own reflection is on reads its Threads itself.
  const owners = [node, ...mine.filter((t) => (t.org_role === 'main' || t.org_role === 'lead') && !reflects(t))];
  for (const o of owners.filter((t, i) => owners.findIndex((x) => x.id === t.id) === i)) {
    await guarded(o.id, () => threadCandidates(o, p));
    await guarded(o.id, () => threadCardCandidates(o, p));
  }
  for (const t of mine) await guarded(t.id, async () => { const c = await needsAskCandidate(t, node, all, p); if (c) p.out.push(c); });
  return { candidates: p.out, quiet: p.quiet };
}
