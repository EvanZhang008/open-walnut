/**
 * The node's answer to each of the user's thread messages, read from its own chat, so a thread
 * reads as its conversation without the node writing anything (2026-11-01, the user: "make it
 * clear what is the conversation in this thread"). The answer to a message is the reply that
 * answered it: the node's last words of the reply run that follows it (its turn's final text).
 * Two messages he sent before the node spoke share that one answer.
 *
 * Read when a node's turn ends (session:result) and when its Threads are read; an answer found is
 * kept on the message (threads-store setThreadAnswers), so a transcript compacted or a session
 * switched later loses nothing. A reply still being written is never kept.
 *
 * The primary also sweeps the closed threads past their week (threads-model sweepClosed).
 */
import { log } from '../../logging/index.js';
import { readAboutTag, stripAboutTag } from './message-about.js';
import { userWordsOf } from './thread-capture.js';
import { letterAnswerMissing, type OrgThread, type ThreadAnswer, type ThreadMessage } from './threads-model.js';
import { isQuietTurn } from '../sessions/quiet-turn.js';

/** A transcript row as the projection gives it (session-projection.ts). */
export interface AnswerRow {
  role: string;
  text: string;
  timestamp: string;
  kind?: string;
  sentBy?: string;
  textWithoutContext?: string;
  about?: string[];
}

/** How far before its filing time a message's chat row may sit (clock and queue slack). */
const ROW_BEFORE_MS = 2 * 60_000;
/** A queued message reaches the chat late, never this late. */
const ROW_AFTER_MS = 12 * 3600_000;
/** Messages older than this are not looked for again. */
const LOOK_BACK_MS = 14 * 24 * 3600_000;
const COMPARE_CHARS = 160;
const TURN_MARKER_RE = /<walnut-turn\b[^>]*\/>/g;
/** A Walnut notice batched in front of his words in one chat row (its body escapes every tag). */
const LEADING_ENVELOPE_RE = /^<walnut-message\b[^>]*>[\s\S]*?<\/walnut-message>\s*/;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, COMPARE_CHARS);
}

/** The reply as words: without the turn marker and the tasks line, is anything said? */
function said(text: string): boolean {
  return stripAboutTag(text).replace(TURN_MARKER_RE, '').trim() !== '';
}

/** His words in a chat row: Walnut's notices batched in front of them taken off. */
function rowWords(row: AnswerRow, inChat: boolean): ReturnType<typeof userWordsOf> {
  let text = row.textWithoutContext ?? row.text;
  for (let i = 0; i < 8 && LEADING_ENVELOPE_RE.test(text); i++) {
    const rest = text.replace(LEADING_ENVELOPE_RE, '');
    if (!rest.trim()) break;
    text = rest;
  }
  return userWordsOf(text, { inChat });
}

function rowMatches(row: AnswerRow, m: ThreadMessage): boolean {
  if (row.role !== 'user') return false;
  const words = rowWords(row, m.via !== 'letter');
  if (!words) return false;
  const a = norm(words.text);
  const b = norm(m.text);
  // Exactly his words: "this" is not the start of "this has subagent ...".
  if (!a && !b) return !!m.images?.length && words.images[0] === m.images[0];
  return a === b;
}

/**
 * Pure: the answers these transcript rows hold for the messages that have none yet. Messages
 * already answered are matched too, only to hold their rows ("yes" again is not the earlier yes).
 * `wholeUntil`: the time up to which the chat is finished (its turn ended, or it runs none); a
 * reply run that reaches past it, or past the end of what was read without a turn's end, may still
 * be talking and is not kept. Null: only runs a later message closed are whole.
 */
export function answersFromRows(
  messages: readonly ThreadMessage[],
  rows: readonly AnswerRow[],
  opts: { wholeUntil: string | null },
): Map<string, ThreadAnswer> {
  const out = new Map<string, ThreadAnswer>();
  const used = new Set<number>();
  const sorted = [...messages].sort((a, b) => a.at.localeCompare(b.at));
  for (const m of sorted) {
    const at = Date.parse(m.at);
    let i = -1;
    for (let k = 0; k < rows.length; k++) {
      const ts = Date.parse(rows[k].timestamp);
      if (ts < at - ROW_BEFORE_MS || used.has(k)) continue;
      if (ts > at + ROW_AFTER_MS) break;
      if (rowMatches(rows[k], m)) { i = k; break; }
    }
    if (i < 0) continue;
    // One row is one message: "yes" twice is two rows, each answered on its own.
    used.add(i);
    // A letter answer is answered in the letter's own thread (letterAnswerOf), never by the chat:
    // the node's next chat words may be about anything else (2026-11-03: both of his letter notes
    // in one thread wore a reply about a task menu).
    if (m.answer || m.via === 'letter') continue;
    const answer = answerAfter(rows, i, opts.wholeUntil);
    if (answer) out.set(m.id, answer);
  }
  return out;
}

/**
 * The node's words that answered the row at `i`: the last thing it said in the turn that first
 * spoke after it. A turn ends on its words: a message that arrives after a tool call came in
 * while the turn was still working (Walnut delivers it into the running turn), so the turn goes on.
 * (A turn cut off after a tool call reads on into the next one: rare, and the next is its sequel.)
 */
function answerAfter(rows: readonly AnswerRow[], i: number, wholeUntil: string | null): ThreadAnswer | null {
  let j = i + 1;
  while (j < rows.length && !(rows[j].role === 'assistant' && !rows[j].kind && said(rows[j].text))) j++;
  if (j >= rows.length) return null;
  let last = j;
  let k = j + 1;
  let closed = false;
  for (; k < rows.length; k++) {
    const row = rows[k];
    if (row.role !== 'assistant') {
      const before = rows[k - 1];
      if (before.role === 'assistant' && before.kind !== 'tool') { closed = true; break; }
      continue;
    }
    if (!row.kind && said(row.text)) last = k;
  }
  // Not closed by a turn's end: whole only when every row of it is older than the chat's finish,
  // and it ends on words (a turn ends on its words; a tool call last means more is coming).
  if (!closed) {
    let end = k - 1;
    while (end > j && rows[end].role !== 'assistant') end--;
    if (!wholeUntil || rows[k - 1].timestamp > wholeUntil || rows[end].kind === 'tool') return null;
  }
  const row = rows[last];
  const about = row.about?.length ? row.about : readAboutTag(row.text).ids;
  return { text: row.text, at: row.timestamp, ...(about.length ? { about: [...about] } : {}) };
}

/** A letter's thread as the inbox keeps it (human-inbox/types.ts ThreadEntry, `at` in ms). */
export interface LetterTurn { from: 'agent' | 'human'; text: string; at: number }

/** How far a letter turn of his may sit from the message's filing time. */
const LETTER_TURN_SLACK_MS = 2 * 60_000;

/**
 * Pure: the node's answer to his letter note `m` in that letter's thread: the first turn of the
 * node after his turn closest to the message's time. Null while it has not answered there.
 */
export function letterAnswerOf(m: Pick<ThreadMessage, 'at' | 'text'>, turns: readonly LetterTurn[]): ThreadAnswer | null {
  const at = Date.parse(m.at);
  let his = -1;
  let best = Infinity;
  for (const [i, t] of turns.entries()) {
    if (t.from !== 'human') continue;
    const d = Math.abs(t.at - at);
    if (d <= LETTER_TURN_SLACK_MS && d < best) { best = d; his = i; }
  }
  if (his < 0) return null;
  const reply = turns.slice(his + 1).find((t) => t.from === 'agent' && t.text.trim());
  return reply ? { text: reply.text, at: new Date(reply.at).toISOString(), from: 'letter' } : null;
}

/**
 * The letter a note answered: its id when filed with one, else (filed before Walnut kept the id)
 * the node's letter whose thread holds a turn of his with these words at that time.
 */
async function letterAnswers(taskId: string, messages: readonly ThreadMessage[]): Promise<Map<string, ThreadAnswer>> {
  const out = new Map<string, ThreadAnswer>();
  const want = messages.filter((m) => letterAnswerMissing(m) && !gaveUp(m.id));
  if (!want.length) return out;
  const { getLetter, listLetters } = await import('../human-inbox/store.js');
  let mine: Array<{ id: string; thread: LetterTurn[] }> | null = null;
  for (const m of want) {
    let turns: LetterTurn[] | undefined;
    // Only its thread is read: no letter body.
    if (m.letter) turns = (await getLetter(m.letter, { deferBodies: true }).catch(() => null))?.thread as LetterTurn[] | undefined;
    if (!turns) {
      if (!mine) {
        const lists = await Promise.all([listLetters(), listLetters({ archived: true })].map((p) => p.catch(() => ({ letters: [] }))));
        mine = lists.flatMap((l) => l.letters).filter((l) => l.sender?.taskId === taskId)
          .map((l) => ({ id: l.id, thread: (l.thread ?? []) as LetterTurn[] }));
      }
      const words = norm(m.text);
      turns = mine.find((l) => l.thread.some((t) => t.from === 'human' && Math.abs(t.at - Date.parse(m.at)) <= LETTER_TURN_SLACK_MS
        && (!words || norm(t.text) === words)))?.thread;
    }
    const answer = turns ? letterAnswerOf(m, turns) : null;
    if (answer) out.set(m.id, answer);
  }
  return out;
}

/**
 * The messages to read answers for, by the session they went to (else the node's own): every
 * recent one of a session that still has one waiting (the answered ones hold their rows).
 */
export function pendingBySession(threads: readonly OrgThread[], fallbackSid: string | undefined, nowMs: number): Map<string, ThreadMessage[]> {
  const out = new Map<string, ThreadMessage[]>();
  for (const t of threads) {
    for (const m of t.messages) {
      if (nowMs - Date.parse(m.at) > LOOK_BACK_MS) continue;
      const sid = m.sid ?? fallbackSid;
      if (!sid) continue;
      out.set(sid, [...(out.get(sid) ?? []), m]);
    }
  }
  for (const [sid, ms] of out) if (!ms.some((m) => (!m.answer || letterAnswerMissing(m)) && !gaveUp(m.id))) out.delete(sid);
  return out;
}

/** A message read for this many times without its row found is not looked for again (this process). */
const TRIES_MAX = 6;
const tries = new Map<string, number>();
function gaveUp(id: string): boolean { return (tries.get(id) ?? 0) >= TRIES_MAX; }

const PAGES_MAX = 8;

/** The session's transcript rows from `since` on (full text), paging back as far as it needs. */
async function rowsSince(sid: string, since: string): Promise<AnswerRow[]> {
  const { buildSessionTranscript } = await import('../session-projection.js');
  const pages: AnswerRow[][] = [];
  let before: string | undefined;
  for (let p = 0; p < PAGES_MAX; p++) {
    // `live` keeps each row whole up to the live budget (16K, the answer's own cap) and pages by time.
    const page = await buildSessionTranscript(sid, { live: true, visible: 200, since, ...(before ? { before } : {}) });
    const rows = page.messages as AnswerRow[];
    if (!rows.length) break;
    pages.unshift(rows);
    const first = rows[0].timestamp;
    if (first <= since || !page.truncated || first === before) break;
    before = first;
  }
  return pages.flat();
}

const running = new Map<string, Promise<number>>();
/** A turn ended while a read ran: read again after it, finished up to that turn's end. */
const again = new Map<string, string>();
const lastRun = new Map<string, number>();
/** A read of the Threads page looks again at most this often (a turn's end always looks). */
const READ_GAP_MS = 15_000;

/**
 * Read and keep the answers still missing on node `taskId`'s threads. `endedAt`: a turn of the
 * node ended then, so its chat is finished up to that time (a next turn already running is not).
 * Never throws; resolves to how many answers were kept.
 */
export function resolveThreadAnswers(taskId: string, opts: { endedAt?: string } = {}): Promise<number> {
  const cur = running.get(taskId);
  if (cur) {
    if (opts.endedAt) again.set(taskId, opts.endedAt);
    return cur;
  }
  if (!opts.endedAt && Date.now() - (lastRun.get(taskId) ?? 0) < READ_GAP_MS) return Promise.resolve(0);
  lastRun.set(taskId, Date.now());
  const run = resolveOnce(taskId, opts.endedAt ?? null)
    .catch((err) => {
      log.task.warn('org threads: answers not read', { taskId, error: err instanceof Error ? err.message : String(err) });
      return 0;
    })
    .finally(() => {
      running.delete(taskId);
      const endedAt = again.get(taskId);
      if (endedAt) { again.delete(taskId); void resolveThreadAnswers(taskId, { endedAt }); }
    });
  running.set(taskId, run);
  return run;
}

async function resolveOnce(taskId: string, endedAt: string | null): Promise<number> {
  const store = await import('./threads-store.js');
  const file = await store.readThreads(taskId);
  if (!file.threads.length) return 0;
  const nodeSid = await nodeSessionId(taskId);
  const pending = pendingBySession(file.threads, nodeSid, Date.now());
  if (!pending.size) return 0;
  const found = new Map<string, ThreadAnswer>();
  for (const [sid, messages] of pending) {
    for (const [id, a] of await answersIn(sid, messages, endedAt)) found.set(id, a);
    // A session renamed on a resume, or a message sent before a switch: look in the node's own chat too.
    const left = messages.filter((m) => !m.answer && !found.has(m.id));
    if (left.length && nodeSid && nodeSid !== sid) {
      for (const [id, a] of await answersIn(nodeSid, messages.filter((m) => m.answer || left.includes(m)), endedAt)) found.set(id, a);
    }
    for (const [id, a] of await letterAnswers(taskId, messages)) found.set(id, a);
    for (const m of messages) if ((!m.answer || letterAnswerMissing(m)) && !found.has(m.id)) tries.set(m.id, (tries.get(m.id) ?? 0) + 1);
  }
  if (!found.size) return 0;
  const kept = await store.setThreadAnswers(taskId, found);
  if (kept) log.task.info('org threads: answers kept', { taskId, kept });
  return kept;
}

/**
 * The node's own chat now: its session slot, else its newest session not archived. The slot of a
 * long-lived Main or lead can be empty while its chat runs (a link that failed; the tasks route
 * heals it the same way when it serves the task), and every message filed before Walnut kept each
 * message's session reads its answer here (2026-11-01: none of a lead's 60 older messages got one).
 */
export async function nodeSessionId(taskId: string): Promise<string | undefined> {
  const { listTasksByIds } = await import('../task-manager.js');
  const task = (await listTasksByIds([taskId]))[0];
  const { getSessionsForTask } = await import('../session-tracker.js');
  const records = await getSessionsForTask(taskId).catch(() => []);
  const archived = new Set(records.filter((r) => r.archived).map((r) => r.claudeSessionId));
  if (task?.session_id && !archived.has(task.session_id)) return task.session_id;
  const live = records.filter((r) => !r.archived).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return live[live.length - 1]?.claudeSessionId;
}

/** The answers one session's chat holds for these messages. */
async function answersIn(sid: string, messages: readonly ThreadMessage[], endedAt: string | null): Promise<Map<string, ThreadAnswer>> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const runs = async () => (await getSessionByClaudeId(sid).catch(() => null))?.process_status === 'running';
  // Finished up to its turn's end, or up to now when it runs no turn before and after the read.
  const startedAt = new Date().toISOString();
  const idleBefore = !(await runs());
  const earliest = messages.reduce((a, m) => (m.at < a ? m.at : a), messages[0].at);
  const rows = await rowsSince(sid, new Date(Date.parse(earliest) - ROW_BEFORE_MS).toISOString());
  if (!rows.length) return new Map();
  const idle = idleBefore && !(await runs());
  const wholeUntil = idle ? startedAt : endedAt;
  return answersFromRows(messages, rows, { wholeUntil });
}

/** How long after a turn's result its transcript is read. */
const RESULT_SETTLE_MS = 1500;

/** The primary keeps answers current: a node's turn ending reads them, and closed threads expire. */
export function startThreadAnswers(): { stop: () => void } {
  let stopped = false;
  void (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    bus.subscribe('org-thread-answers', (event) => {
      if (event.name !== EventNames.SESSION_RESULT) return;
      const d = event.data as { sessionId?: string; taskId?: string; teamActive?: boolean; backgroundActive?: boolean; turnGen?: number };
      // An intermediate result (a team or a background job still running) is not the turn's end.
      if (!d.sessionId || d.teamActive || d.backgroundActive || isQuietTurn(d.sessionId, d.turnGen)) return;
      // A moment later: the turn's last words reach its transcript just after its result.
      const endedAt = new Date().toISOString();
      const timer = setTimeout(() => { void answersForSession(d.sessionId!, d.taskId, endedAt); }, RESULT_SETTLE_MS);
      timer.unref?.();
    }, { global: true, interest: ['session:result'] });
  })();
  const sweep = setInterval(() => { void sweepAll(); }, 6 * 3600_000);
  sweep.unref?.();
  const first = setTimeout(() => { void sweepAll(); }, 60_000);
  first.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(sweep);
      clearTimeout(first);
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe('org-thread-answers'));
    },
  };
}

async function answersForSession(sessionId: string, taskId: string | undefined, endedAt: string): Promise<void> {
  try {
    let id = taskId;
    if (!id) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      id = (await getSessionByClaudeId(sessionId))?.taskId;
    }
    if (!id) return;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([id]))[0];
    if (task?.org_role !== 'main' && task?.org_role !== 'lead') return;
    await resolveThreadAnswers(id, { endedAt });
  } catch (err) {
    log.task.warn('org threads: turn end not read', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function sweepAll(): Promise<void> {
  try {
    const store = await import('./threads-store.js');
    const dropped = await store.sweepClosedThreads();
    if (dropped) log.task.info('org threads: closed threads past their week deleted', { dropped });
  } catch (err) {
    log.task.warn('org threads: sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
